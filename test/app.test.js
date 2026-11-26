import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, serializeCookie, parseCookies, securityHeaders, redirect, reply } from '../src/app.js';
import { _$m } from '../src/rt.js';
import { _$lc, _$lw, _$ll } from '../src/load.js';
import { TMP } from './helpers.js';

const TOKEN = 'a'.repeat(43);
const COOKIE = `goal_csrf=${TOKEN}`;

const routes = [
  { method: 'GET', path: '/', handler: () => _$m('<p>home</p>') },
  {
    method: 'GET',
    path: '/doc',
    handler: (r, x) => {
      x.ctx.e(['click']);
      return _$m(`<html><body><p>${x.ctx.t}</p></body></html>`);
    },
  },
  { method: 'GET', path: '/users/{id}', handler: (r, x) => x.json({ id: r.params.id, q: r.query, path: r.path }) },
  { method: 'GET', path: '/users/me', handler: (r, x) => x.json('me') },
  { method: 'POST', path: '/items', handler: (r, x) => x.json({ method: r.method, form: r.form, json: r.json ?? null }) },
  { method: 'PUT', path: '/items', handler: (r, x) => x.json({ method: r.method, form: r.form }) },
  { method: 'GET', path: '/go', handler: (r, x) => x.redirect('/') },
  { method: 'GET', path: '/away', handler: (r, x) => x.redirect('https://example.com/', { external: true, status: 302 }) },
  { method: 'GET', path: '/evil', handler: (r, x) => x.redirect('//evil.example') },
  { method: 'GET', path: '/none', handler: () => undefined },
  { method: 'GET', path: '/missing', handler: (r, x) => x.notFound() },
  { method: 'GET', path: '/bad', handler: () => 42 },
  {
    method: 'GET',
    path: '/boom',
    handler: () => {
      throw new Error('boom');
    },
  },
  {
    // A component with a call() that fails, as compiled code renders it: later, with the answer
    method: 'GET',
    path: '/later',
    handler: (r, x) => {
      const Later = (p, c) => {
        const v = _$lc(c, async () => {
          throw new Error('slow fail');
        }, [], '/_m/x/y');
        if (_$lw(v)) return _$ll(c, Later, p);
        return `<p>${v.error}</p>`;
      };
      return _$m(`<main>${Later({}, x.ctx)}</main>`);
    },
  },
  { method: 'GET', path: '/kept', handler: (r, x) => x.json(x.ctx.hmr ?? null) },
  { method: 'GET', path: '/num/{id}', types: { id: 'number' }, handler: (r, x) => x.json(r.params) },
  { method: 'GET', path: '/kept-k', handler: (r, x) => x.json([x.ctx.k('/c/A.js', 0), x.ctx.k('/c/B.js', 0), x.ctx.k('/c/A.js', 1)]) },
  {
    method: 'POST',
    path: '/upload',
    handler: (r, x) =>
      x.json({ form: r.form, files: Object.fromEntries(Object.entries(r.files).map(([k, fs]) => [k, fs.map((f) => ({ name: f.name, type: f.type, size: f.size, text: f.data.toString() }))])) }),
  },
  {
    method: 'GET',
    path: '/cookie',
    handler: (r, x) => {
      x.cookie('theme', 'dark mode', { maxAge: 60.5 });
      x.cookie('js', '1', { httpOnly: false, secure: false, sameSite: 'Strict' });
      return x.json(r.cookies);
    },
  },
];

// What the streaming routes saw: whether a stream ran to its end, and whether the client had gone
const streamed = {};
const big = Buffer.alloc(1 << 16, 'x');
routes.push(
  { method: 'GET', path: '/text', handler: (r, x) => x.reply('hi', { status: 418, headers: { 'x-one': '1' } }) },
  { method: 'GET', path: '/bytes', handler: (r, x) => x.reply(new Uint8Array([1, 2, 3])) },
  { method: 'GET', path: '/csv', handler: (r, x) => x.reply('a,b', { type: 'text/csv' }) },
  { method: 'GET', path: '/gone', handler: (r, x) => x.reply(_$m('<main>gone</main>'), { status: 410, headers: { 'x-two': '2' } }) },
  { method: 'GET', path: '/page', handler: (r, x) => x.reply(_$m('<p>ok</p>')) },
  { method: 'GET', path: '/wrong', handler: (r, x) => x.reply({ a: 1 }) },
  { method: 'GET', path: '/made', handler: (r, x) => x.json({ id: 1 }, 201, { location: '/made/1' }) },
  {
    method: 'GET',
    path: '/stream',
    handler: (r, x) =>
      x.stream(
        (async function* () {
          streamed.started = true;
          yield 'a';
          yield Buffer.from('b');
          yield 'c';
        })(),
        { type: 'text/x-letters', headers: { 'x-three': '3' } },
      ),
  },
  {
    method: 'GET',
    path: '/huge',
    handler: (r, x) =>
      x.stream(
        (async function* () {
          for (let i = 0; i < 320; i++) yield big; // 20 MB, more than the socket takes at once
        })(),
        { type: 'application/octet-stream' },
      ),
  },
  {
    method: 'GET',
    path: '/forever',
    handler: (r, x) =>
      x.stream(
        (async function* () {
          try {
            for (;;) yield big;
          } finally {
            streamed.stopped = r.signal.aborted;
          }
        })(),
      ),
  },
  {
    method: 'GET',
    path: '/broken',
    handler: (r, x) =>
      x.stream(
        (async function* () {
          yield 'part';
          await new Promise((ok) => setTimeout(ok, 10));
          throw new Error('stream broke');
        })(),
      ),
  },
  {
    method: 'GET',
    path: '/events',
    handler: (r, x) =>
      x.events(
        (async function* () {
          yield { n: 1 };
          yield 'two';
          yield undefined;
          await new Promise((ok) => setTimeout(ok, 60));
          yield 3;
        })(),
        { ping: 20 },
      ),
  },
  { method: 'GET', path: '/events-plain', handler: (r, x) => x.events([1], { headers: { 'x-four': '4' } }) },
);

const dir = join(TMP, `static${process.pid}`);
const servers = [];
async function start(opts) {
  const s = createServer(createApp(routes, { staticDirs: [join(dir, 'client'), join(dir, 'public')], log: () => {}, ...opts }));
  servers.push(s);
  await new Promise((ok) => s.listen(0, ok));
  return `http://localhost:${s.address().port}`;
}
let url;
beforeAll(async () => {
  mkdirSync(join(dir, 'client/c'), { recursive: true });
  mkdirSync(join(dir, 'public/sub'), { recursive: true });
  writeFileSync(join(dir, 'client/c/x.js'), 'export {}');
  writeFileSync(join(dir, 'public/style.css'), 'p{}');
  writeFileSync(join(dir, 'public/file.bin'), 'bin');
  writeFileSync(join(dir, 'secret.txt'), 'secret');
  url = await start();
});
afterAll(() => Promise.all(servers.map((s) => new Promise((ok) => s.close(ok)))));

const post = (path, body, headers = {}, base = url) =>
  fetch(base + path, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: COOKIE, ...headers } });

describe('headers', () => {
  it('sends strict security headers, a CSP nonce that matches the loader, and a CSRF cookie', async () => {
    const res = await fetch(url + '/doc');
    const h = res.headers;
    const nonce = /'nonce-([^']+)'/.exec(h.get('content-security-policy'))[1];
    expect(h.get('content-security-policy')).toBe(
      `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    );
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('x-frame-options')).toBe('DENY');
    expect(h.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(h.get('strict-transport-security')).toBe(null);
    const cookie = h.get('set-cookie');
    expect(cookie).toMatch(/^goal_csrf=[\w-]{43}; Path=\/; SameSite=Lax; HttpOnly; Secure$/);
    const html = await res.text();
    expect(html).toContain(`<script type="module" nonce="${nonce}">`);
    expect(html).toContain(`<p>${cookie.slice(10, 53)}</p>`);
  });

  it('keeps a valid CSRF cookie, and replaces a malformed one', async () => {
    expect((await fetch(url, { headers: { cookie: COOKIE } })).headers.get('set-cookie')).toBe(null);
    expect((await fetch(url, { headers: { cookie: 'goal_csrf=short' } })).headers.get('set-cookie')).toMatch(/^goal_csrf=/);
  });

  it('can change or drop the CSP from config, and adds HSTS over TLS', async () => {
    const custom = await start({ config: { csp: "script-src 'nonce-{nonce}'" } });
    expect((await fetch(custom)).headers.get('content-security-policy')).toMatch(/^script-src 'nonce-[^']+'$/);
    const none = await start({ config: { csp: false } });
    expect((await fetch(none)).headers.get('content-security-policy')).toBe(null);
    expect(securityHeaders('n', { tls: true })['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
    expect(securityHeaders('n')['content-security-policy']).toContain("'nonce-n'");
  });

  it('answers HEAD without a body', async () => {
    const res = await fetch(url, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

describe('files', () => {
  it('serves files from the static folders, with their types', async () => {
    const js = await fetch(url + '/c/x.js');
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await fetch(url + '/style.css')).headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect((await fetch(url + '/file.bin')).headers.get('content-type')).toBe('application/octet-stream');
  });

  it('never serves folders or anything outside them', async () => {
    expect((await fetch(url + '/sub')).status).toBe(404);
    expect((await fetch(url + '/..%2f..%2f..%2fpackage.json')).status).toBe(404);
    expect((await fetch(url + '/..%2fsecret.txt')).status).toBe(404);
    expect((await fetch(url + '/c/..%2f..%2fsecret.txt')).status).toBe(404);
    expect((await fetch(url + '/%E0%A4%A')).status).toBe(400);
  });

  it('serves nothing when there are no static folders', async () => {
    const s = createServer(createApp(routes));
    servers.push(s);
    await new Promise((ok) => s.listen(0, ok));
    expect((await fetch(`http://localhost:${s.address().port}/style.css`)).status).toBe(404);
  });
});

describe('routes', () => {
  it('match a path parameter typed as a number only to a number, which the route gets', async () => {
    expect(await (await fetch(url + '/num/12')).json()).toEqual({ id: 12 });
    expect(await (await fetch(url + '/num/-1.5')).json()).toEqual({ id: -1.5 });
    expect((await fetch(url + '/num/12a')).status).toBe(404);
  });

  it('match fixed paths before parameters, and decode parameters', async () => {
    expect(await (await fetch(url + '/users/me')).json()).toBe('me');
    expect(await (await fetch(url + '/users/a%20b/?x=1')).json()).toEqual({ id: 'a b', q: { x: '1' }, path: '/users/a%20b/' });
  });

  it('answer 404, and 405 with Allow', async () => {
    const missing = await fetch(url + '/nope');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('<h1>Not found</h1>');
    const wrong = await fetch(url + '/items');
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST, PUT');
  });

  it('redirect on this site, and elsewhere only when asked', async () => {
    const go = await fetch(url + '/go', { redirect: 'manual' });
    expect([go.status, go.headers.get('location')]).toEqual([303, '/']);
    const away = await fetch(url + '/away', { redirect: 'manual' });
    expect([away.status, away.headers.get('location')]).toEqual([302, 'https://example.com/']);
    expect((await fetch(url + '/evil', { redirect: 'manual' })).status).toBe(500);
    expect(() => redirect('https://x.org')).toThrow('redirect() goes to a path on this site');
    expect(() => redirect('/\\evil')).toThrow();
  });

  it('answer 204 for nothing, 404 for notFound(), and 500 for anything else', async () => {
    expect((await fetch(url + '/none')).status).toBe(204);
    expect((await fetch(url + '/missing')).status).toBe(404);
    const bad = await fetch(url + '/bad');
    expect(bad.status).toBe(500);
    expect(await bad.text()).toContain('<h1>Something went wrong</h1>');
  });

  it('hide error details unless in dev, and always log them', async () => {
    const boom = await fetch(url + '/boom');
    expect(await boom.text()).not.toContain('boom');
    const log = [];
    const dev = await start({ dev: true, log: (e) => log.push(e.message) });
    const res = await fetch(dev + '/boom');
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toMatch(/^Error: boom\n {4}at /);
    expect(log).toEqual(['boom']);
  });

  it("tells goal.config.js's onError of each error, with the request, and logs an error of its own", async () => {
    const seen = [];
    const u = await start({ config: { onError: (e, r) => seen.push([e.message, r.method, r.path]) } });
    expect((await fetch(u + '/boom')).status).toBe(500);
    await expect.poll(() => seen).toEqual([['boom', 'GET', '/boom']]);
    // a call() that failed: the page shows it, and onError hears of it
    const later = await fetch(u + '/later');
    expect(later.status).toBe(200);
    expect(await later.text()).toContain('<main><p>server function /_m/x/y failed: 500</p></main>');
    await expect.poll(() => seen.at(-1)).toEqual(['slow fail', 'GET', '/later']);
    const log = [];
    const fails = await start({
      config: {
        onError: () => {
          throw new Error('hook');
        },
      },
      log: (e) => log.push(e.message),
    });
    expect((await fetch(fails + '/boom')).status).toBe(500); // the answer doesn't wait for it
    await expect.poll(() => log).toEqual(['boom', 'hook']);
  });

  it('pass the state a page kept to the render, and add the live updates to pages, in dev only', async () => {
    const dev = await start({ dev: true });
    const kept = (base, header) => fetch(base + '/kept', { headers: header === undefined ? {} : { 'x-goal-hmr': header } }).then((r) => r.json());
    expect(await kept(dev, '[{"c":"/c/A.js","s":{"n":2}}]')).toEqual([{ c: '/c/A.js', s: { n: 2 } }]);
    expect(await kept(dev, 'not json')).toEqual([]);
    expect(await kept(dev, '{"0":{}}')).toEqual([]);
    expect(await kept(dev)).toBe(null);
    expect(await kept(url, '{"0":{}}')).toBe(null); // not in dev
    const k = await fetch(dev + '/kept-k', { headers: { 'x-goal-hmr': '[null,{"c":"/c/A.js","s":{"n":2}}]' } });
    expect(await k.json()).toEqual([{ n: 2 }, null, null]); // in order, by component: each state once
    expect(await (await fetch(dev + '/doc')).text()).toContain('<meta name="goal-events" content="[&quot;click&quot;]"><script type="module" nonce="');
    expect(await (await fetch(url + '/doc')).text()).not.toContain('goal-events');
  });

  it('logs to the console by default', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = createServer(createApp(routes));
    servers.push(s);
    await new Promise((ok) => s.listen(0, ok));
    await fetch(`http://localhost:${s.address().port}/boom`);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('set cookies with safe defaults, and read them', async () => {
    const res = await fetch(url + '/cookie', { headers: { cookie: `${COOKIE}; a=%E0%A4%A; b=x%20y; junk; =v` } });
    expect(res.headers.getSetCookie()).toEqual([
      'theme=dark%20mode; Path=/; SameSite=Lax; Max-Age=60; HttpOnly; Secure',
      'js=1; Path=/; SameSite=Strict',
    ]);
    expect(await res.json()).toEqual({ goal_csrf: TOKEN, a: '%E0%A4%A', b: 'x y' });
    expect(() => serializeCookie('a b', 'x')).toThrow('has characters a cookie name can');
    expect(parseCookies()).toEqual({});
  });
});

describe('answers of any kind', () => {
  it('reply() sends text or bytes, with a status, a type and headers', async () => {
    const text = await fetch(url + '/text');
    expect([text.status, text.headers.get('content-type'), text.headers.get('x-one'), await text.text()]).toEqual([418, 'text/plain; charset=utf-8', '1', 'hi']);
    expect(text.headers.get('x-frame-options')).toBe('DENY'); // the security headers stay
    const bytes = await fetch(url + '/bytes');
    expect([bytes.headers.get('content-type'), [...new Uint8Array(await bytes.arrayBuffer())]]).toEqual(['application/octet-stream', [1, 2, 3]]);
    expect((await fetch(url + '/csv')).headers.get('content-type')).toBe('text/csv');
  });

  it('reply() sends markup as a page, with its status and headers', async () => {
    const gone = await fetch(url + '/gone');
    expect([gone.status, gone.headers.get('x-two'), gone.headers.get('content-type')]).toEqual([410, '2', 'text/html; charset=utf-8']);
    expect(await gone.text()).toContain('<main>gone</main>');
    expect((await fetch(url + '/page')).status).toBe(200);
  });

  it('reply() refuses anything else, and json() takes headers', async () => {
    expect(() => reply({ a: 1 })).toThrow('reply() takes markup, text or bytes: send data with json()');
    expect((await fetch(url + '/wrong')).status).toBe(500);
    const made = await fetch(url + '/made');
    expect([made.status, made.headers.get('location'), await made.json()]).toEqual([201, '/made/1', { id: 1 }]);
  });

  it('stream() sends each piece as it comes, and nothing for HEAD', async () => {
    const res = await fetch(url + '/stream');
    expect([res.headers.get('content-type'), res.headers.get('x-three'), await res.text()]).toEqual(['text/x-letters', '3', 'abc']);
    streamed.started = false;
    const head = await fetch(url + '/stream', { method: 'HEAD' });
    expect([head.status, await head.text(), streamed.started]).toEqual([200, '', false]);
  });

  it('stream() waits while the client catches up', async () => {
    const res = await fetch(url + '/huge');
    expect((await res.arrayBuffer()).byteLength).toBe(320 << 16);
  });

  it('stream() stops when the client goes, and request.signal says so', async () => {
    const stop = new AbortController();
    const res = await fetch(url + '/forever', { signal: stop.signal });
    const reader = res.body.getReader();
    await reader.read();
    stop.abort();
    await vi.waitFor(() => expect(streamed.stopped).toBe(true));
  });

  it('stream() logs an error it meets, and cuts the answer short', async () => {
    const log = [];
    const base = await start({ log: (e) => log.push(e.message) });
    const res = await fetch(base + '/broken');
    await expect(res.text()).rejects.toThrow();
    expect(log).toEqual(['stream broke']);
  });

  it('events() sends server-sent events as JSON, with pings while quiet', async () => {
    const res = await fetch(url + '/events');
    expect([res.headers.get('content-type'), res.headers.get('cache-control')]).toEqual(['text/event-stream; charset=utf-8', 'no-store']);
    const body = await res.text();
    expect(body.startsWith('data: {"n":1}\n\ndata: "two"\n\ndata: null\n\n')).toBe(true);
    expect(body).toContain(':\n\n');
    expect(body.endsWith('data: 3\n\n')).toBe(true);
    const plain = await fetch(url + '/events-plain');
    expect([plain.headers.get('x-four'), await plain.text()]).toEqual(['4', 'data: 1\n\n']);
  });
});

describe('requests that change things', () => {
  it('need the CSRF token, from the form or a header', async () => {
    expect((await post('/items', 'a=1')).status).toBe(403);
    const ok = await post('/items', `a=1&_csrf=${TOKEN}`);
    expect(await ok.json()).toEqual({ method: 'POST', form: { a: '1' }, json: null });
    expect((await post('/items', 'a=1', { 'x-csrf-token': TOKEN })).status).toBe(200);
    expect((await post('/items', 'a=1', { 'x-csrf-token': 'b'.repeat(43) })).status).toBe(403);
    expect((await post('/items', 'a=1', { 'x-csrf-token': 'short' })).status).toBe(403);
    expect((await post('/items', `_csrf=${TOKEN}`, { cookie: '' })).status).toBe(403);
  });

  it('pass from the same origin without a token, and never from another site', async () => {
    expect((await post('/items', 'a=1', { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await post('/items', `_csrf=${TOKEN}`, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post('/items', `_csrf=${TOKEN}`, { 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await post('/items', `_csrf=${TOKEN}`, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post('/items', `_csrf=${TOKEN}`, { origin: 'null' })).status).toBe(403);
    expect((await post('/items', `_csrf=${TOKEN}`, { origin: url })).status).toBe(200);
  });

  it('can turn the CSRF check off from config', async () => {
    const open = await start({ config: { csrf: false } });
    expect((await post('/items', 'a=1', {}, open)).status).toBe(200);
  });

  it('take PUT, PATCH and DELETE from a form, but no other method', async () => {
    expect(await (await post('/items', `_method=put&_csrf=${TOKEN}&x=2`)).json()).toEqual({ method: 'PUT', form: { x: '2' } });
    expect((await (await post('/items', `_method=get&_csrf=${TOKEN}`)).json()).method).toBe('POST');
  });

  it('read multipart forms: the fields in form, the files in files, and refuse a broken one', async () => {
    const fd = new FormData();
    fd.append('_csrf', TOKEN);
    fd.append('title', 'Trip');
    fd.append('photo', new File(['abc'], 'a.txt', { type: 'text/plain' }));
    fd.append('photo', new File(['de'], 'b.png', { type: 'image/png' }));
    fd.append('empty', new File([], '')); // a file input with nothing chosen: an empty field
    const res = await fetch(url + '/upload', { method: 'POST', body: fd, headers: { cookie: COOKIE } });
    expect(await res.json()).toEqual({
      form: { title: 'Trip', empty: '' },
      files: {
        photo: [
          { name: 'a.txt', type: 'text/plain', size: 3, text: 'abc' },
          { name: 'b.png', type: 'image/png', size: 2, text: 'de' },
        ],
      },
    });
    const broken = await fetch(url + '/upload', { method: 'POST', body: 'x', headers: { cookie: COOKIE, 'x-csrf-token': TOKEN, 'content-type': 'multipart/form-data; boundary=zz' } });
    expect(broken.status).toBe(400);
  });

  it('read JSON, refuse other bodies, and limit their size', async () => {
    const h = { 'content-type': 'application/json', 'x-csrf-token': TOKEN };
    expect((await (await post('/items', '{"a":[1]}', h)).json()).json).toEqual({ a: [1] });
    expect((await post('/items', '{bad', h)).status).toBe(400);
    expect((await post('/items', 'x', { 'content-type': 'text/plain', 'x-csrf-token': TOKEN })).status).toBe(415);
    expect((await fetch(url + '/items', { method: 'POST', headers: { cookie: COOKIE, 'x-csrf-token': TOKEN } })).status).toBe(200);
    const small = await start({ config: { bodyLimit: 10 } });
    expect((await post('/items', `_csrf=${TOKEN}&a=${'x'.repeat(50)}`, {}, small)).status).toBe(413);
  });
});

describe('without a network', () => {
  const call = (req, opts) =>
    new Promise((ok) => {
      const res = {
        writeHead(status, headers) {
          Object.assign(res, { status, headers });
        },
        end: (body) => ok({ ...res, body }),
        on() {},
      };
      createApp(routes, { log: () => {}, ...opts })(req, res);
    });
  const fake = (method, encrypted, headers = {}) => Object.assign(new EventEmitter(), { method, url: '/', headers, socket: { encrypted }, resume() {} });

  it('adds HSTS when the connection is TLS', async () => {
    const r = await call(fake('GET', true));
    expect(r.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
  });

  it('answers 500 when the request body fails', async () => {
    const req = fake('POST', false);
    const done = call(req);
    req.emit('error', new Error('reset'));
    expect((await done).status).toBe(500);
  });
});
