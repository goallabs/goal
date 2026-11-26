import { describe, it, expect, afterAll } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { _$req } from '../src/request.js';
import { build, load, TMP } from './helpers.js';

describe('request in server functions', () => {
  it('starts each server function on the server by taking the request, unless it has its own', () => {
    const r = build(`
      export server function a() { return request.tenant; }
      server function b(request) { return request; }
      server function c() { const request = 1; return request; }
      export function A() { var n = 0; return <b onclick={() => (n = a())}>{n}</b>; }`);
    expect(r.server).toContain('import { _$req } from');
    expect(r.server).toMatch(/async function a\(\) \{\n\s+const request = _\$req\(\);/);
    expect(r.server).toMatch(/async function b\(request\) \{\n\s+return request;/);
    expect(r.server).toMatch(/async function c\(\) \{\n\s+const request = 1;/);
    expect(r.clients[0].code).not.toContain('_$req');
    expect(r.render).not.toContain('_$req');
  });

  it('is undefined outside a request', () => {
    expect(_$req()).toBe(undefined);
  });
});

const app = `
export server function whose() { return request.tenant.name; }
export server function where() { return [request.base, request.path]; }
export function Who() { var w = call(whose()); return <p>{w.value}</p>; }
export function Go() { var n = 0; return <b onclick={() => n++}>{n}</b>; }
route GET / { return <main><Who /></main>; }
route GET /notes { return json({ tenant: request.tenant, base: request.base, path: request.path }); }
route GET /go { return redirect('/notes'); }
route GET /away { return redirect('https://example.com/', { external: true }); }
route GET /live { return <main><Go /></main>; }
route POST /x { return json(1); }
`;

const servers = [];
afterAll(() => Promise.all(servers.map((s) => new Promise((ok) => s.close(ok)))));
const tenants = { 'acme.test': { name: 'Acme' }, 'globex.test': { name: 'Globex' }, acme: { name: 'Acme' } };
async function start(config) {
  const { server } = await load(app);
  fns = server._$routes;
  const dir = join(TMP, `tenant-static${process.pid}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'style.css'), 'p {}');
  const seen = [];
  const s = createServer(createApp(server._$routes, { log: () => {}, staticDirs: [dir], config: { ...config, tenant: async (r) => (seen.push(r), config.tenant(r)) } }));
  servers.push(s);
  await new Promise((ok) => s.listen(0, ok));
  return { url: `http://localhost:${s.address().port}`, seen };
}
// fetch won't send a Host header of ours, so these go through node:http
const send = (url, path, { host, method = 'GET', headers = {}, body } = {}) =>
  new Promise((ok, no) => {
    const r = httpRequest(url + path, { method, headers: { ...(host && { host }), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    r.on('error', no);
    r.end(body);
  });
let fns;
const fn = (name) => fns.find((r) => r.path.endsWith('/' + name)).path;

describe('tenants by host', () => {
  it('tells tenants apart by host, in routes, server functions and pages that call them, and 404s an unknown one', async () => {
    const { url, seen } = await start({ tenant: (r) => tenants[r.hostname] ?? null });
    expect((await send(url, '/notes', { host: 'acme.test:8080' })).json()).toEqual({ tenant: { name: 'Acme' }, base: '', path: '/notes' });
    expect(seen[0]).toMatchObject({ host: 'acme.test:8080', hostname: 'acme.test', prefix: undefined, path: '/notes' });
    expect((await send(url, '/', { host: 'globex.test' })).text).toContain('Globex<!--/--></p>');
    const called = await send(url, fn('whose'), { host: 'acme.test', method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '[]' });
    expect(called.json()).toEqual({ v: 'Acme' });
    expect((await send(url, '/notes', { host: 'evil.test' })).status).toBe(404);
    // An HTTP/1.0 request may have no Host header at all
    const bare = await new Promise((ok) => {
      const c = connect(new URL(url).port, 'localhost', () => c.end('GET /notes HTTP/1.0\r\n\r\n'));
      let text = '';
      c.on('data', (d) => (text += d)).on('end', () => ok(text));
    });
    expect(bare).toMatch(/^HTTP\/1\.1 404/);
    // Static files are the same for every tenant: no tenant is looked up for them
    const n = seen.length;
    expect((await send(url, '/style.css', { host: 'evil.test' })).status).toBe(200);
    expect(seen.length).toBe(n);
  });

  it('reads the host the proxy forwarded only when it is trusted', async () => {
    const { url } = await start({ tenant: (r) => tenants[r.hostname] ?? null, trustProxy: true });
    expect((await send(url, '/notes', { host: 'evil.test', headers: { 'x-forwarded-host': 'x, acme.test' } })).status).toBe(200);
    expect((await send(url, '/notes', { host: 'acme.test' })).status).toBe(200); // nothing forwarded: the Host header
    const plain = await start({ tenant: (r) => tenants[r.hostname] ?? null });
    expect((await send(plain.url, '/notes', { host: 'evil.test', headers: { 'x-forwarded-host': 'acme.test' } })).status).toBe(404);
  });

  it('counts each tenant apart in the rate limit', async () => {
    const { url } = await start({ tenant: (r) => tenants[r.hostname] ?? null, rateLimit: { max: 1 }, csrf: false });
    const post = (host) => send(url, '/x', { host, method: 'POST' }).then((r) => r.status);
    expect([await post('acme.test'), await post('globex.test'), await post('acme.test')]).toEqual([200, 200, 429]);
  });
});

describe('tenants by path', () => {
  const config = { tenantPrefix: true, tenant: (r) => (r.prefix ? (tenants[r.prefix] ?? null) : { name: 'Main' }) };

  it("takes the path's first part off for the routes, and gives it to the tenant resolver", async () => {
    const { url, seen } = await start(config);
    expect(await (await fetch(url + '/acme/notes')).json()).toEqual({ tenant: { name: 'Acme' }, base: '/acme', path: '/notes' });
    expect(seen.at(-1)).toMatchObject({ prefix: 'acme', path: '/notes' });
    expect(await (await fetch(url + '/acme')).text()).toContain('Acme<!--/--></p>');
    expect((await fetch(url + '/nobody/notes')).status).toBe(404);
    expect(await (await fetch(url + '/')).text()).toContain('Main<!--/--></p>'); // no first part: the resolver decides
  });

  it("keeps redirects and the page's server function calls in the tenant's path", async () => {
    const { url } = await start(config);
    const go = await fetch(url + '/acme/go', { redirect: 'manual' });
    expect(go.headers.get('location')).toBe('/acme/notes');
    expect((await fetch(url + '/acme/away', { redirect: 'manual' })).headers.get('location')).toBe('https://example.com/');
    expect(await (await fetch(url + '/acme/live')).text()).toContain('<meta name="goal-base" content="/acme">');
    const called = await fetch(url + '/acme' + fn('where'), { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '[]' });
    expect(await called.json()).toEqual({ v: ['/acme', fn('where')] });
  });
});
