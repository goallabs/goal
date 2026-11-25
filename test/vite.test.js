import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import { goal } from '../src/vite.js';
import { TMP } from './helpers.js';

const dir = join(TMP, `vite${process.pid}`);
const files = {
  'app.goal': "import { Panel } from './ui/Panel.goal';\nroute GET / { return <html><body><Panel /></body></html>; }",
  'ui/Panel.goal':
    "import { Counter } from './Counter.goal';\nimport { save } from './store.goal';\nexport function Panel() { var open = true; var n = 0; return <div onclick={() => (open = !open)}>{if (open) <Counter start={1} />}<button onclick={() => (n = save(n + 1))}>{n}</button></div>; }",
  'ui/Counter.goal': 'export function Counter({ start }) { var n = start; return <b onclick={() => n++}>{n}</b>; }',
  'ui/store.goal': 'export server function save(v) { return v * 10; }',
  'node_modules/x/skip.goal': 'not goal',
  'notes.txt': 'not a source',
  'public/style.css': 'p {}',
};
rmSync(dir, { recursive: true, force: true });
for (const [f, text] of Object.entries(files)) {
  mkdirSync(join(dir, f, '..'), { recursive: true });
  writeFileSync(join(dir, f), text);
}

const plugin = goal();
const errors = [];
const server = await createServer({
  root: dir,
  configFile: false,
  logLevel: 'silent',
  plugins: [plugin],
  server: { port: 0, hmr: false, watch: null },
  customLogger: { info() {}, warn() {}, warnOnce() {}, error: (m) => errors.push(m), clearScreen() {}, hasErrorLogged: () => false, hasWarned: false },
});
await server.listen();
const url = `http://localhost:${server.httpServer.address().port}`;
afterAll(() => server.close());

describe('the Vite plugin', () => {
  it("answers pages from the app's routes, and serves each component's code as a module", async () => {
    const res = await fetch(url + '/');
    const html = await res.text();
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self' 'nonce-");
    expect(html).toContain('m-c="/ui/Panel.goal.Panel.client.js?v=1"');
    expect(html).toContain('<meta name="goal-events"'); // live updates, as in goal dev
    const panel = await (await fetch(url + '/ui/Panel.goal.Panel.client.js?v=1')).text();
    expect(panel).toContain('/ui/Counter.goal.render.js?v=1'); // renders Counter from its render module
    expect(panel).toContain('_$sf("/_m/ui/store/save"');
    expect(panel).not.toContain('<div'); // compiled, not the source
    const render = await (await fetch(url + '/ui/Counter.goal.render.js?v=1')).text();
    expect(render).toContain('export function Counter(_$p = {}, _$c = _$ctx())');
    for (const source of ['/ui/Panel.goal', '/ui/store.goal?raw', '/app.goal?import']) expect((await fetch(url + source)).status).toBe(404); // the sources stay on the server
    expect(await (await fetch(url + '/style.css')).text()).toBe('p {}'); // Vite serves the public folder
  });

  it('answers server functions behind the CSRF check', async () => {
    const page = await fetch(url + '/');
    const cookie = page.headers.get('set-cookie').split(';')[0];
    const call = (headers) => fetch(url + '/_m/ui/store/save', { method: 'POST', headers: { 'content-type': 'application/json', cookie, ...headers }, body: '[4]' });
    expect(await (await call({ 'x-csrf-token': cookie.split('=')[1] })).json()).toEqual({ v: 40 });
    expect((await call({})).status).toBe(403);
  });

  it('tells the open pages what changed, and leaves other files to Vite', async () => {
    const res = await fetch(url + '/_goal/hmr');
    const reader = res.body.getReader();
    let text = '';
    const message = async () => {
      for (;;) {
        const m = /data: (.*)\n\n/.exec(text);
        if (m) {
          text = text.slice(m.index + m[0].length);
          return JSON.parse(m[1]);
        }
        text += new TextDecoder().decode((await reader.read()).value);
      }
    };
    expect(plugin.handleHotUpdate({ file: join(dir, 'ui/Counter.goal'), server })).toEqual([]);
    expect(await message()).toEqual({ type: 'update', version: 2 });
    plugin.handleHotUpdate({ file: join(dir, 'public/style.css'), server });
    expect(await message()).toEqual({ type: 'css', version: 3 });
    expect(plugin.handleHotUpdate({ file: join(dir, 'notes.txt'), server })).toBe(undefined);
    expect(plugin.handleHotUpdate({ file: join(dir, 'node_modules/x/a.js'), server })).toBe(undefined);
    reader.cancel();
  });

  it('shows a compile error, and refuses browser code that imports a .goal file', async () => {
    writeFileSync(join(dir, 'ui/Counter.goal'), 'export function Counter() { var n = 1; n = 2; return <b>{n}</b>; }');
    plugin.handleHotUpdate({ file: join(dir, 'ui/Counter.goal'), server });
    const res = await fetch(url + '/');
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('`n` is state: change it in an event handler');
    writeFileSync(join(dir, 'ui/Counter.goal'), files['ui/Counter.goal']);
    plugin.handleHotUpdate({ file: join(dir, 'ui/Counter.goal'), server });
    expect((await fetch(url + '/')).status).toBe(200);
    expect(() => plugin.transform('export function A() { return <p/>; }', join(dir, 'ui/A.goal'), {})).toThrow("browser code can't import the .goal file ui/A.goal");
    expect(plugin.transform('const x = 1;', join(dir, 'a.js'))).toBe(undefined);
    expect(plugin.load(join(dir, 'a.js'))).toBe(undefined);
    expect(plugin.resolveId(join(dir, 'ui/Panel.goal.Panel.client.js'))).toBe(join(dir, 'ui/Panel.goal.Panel.client.js')); // already a path
    expect(plugin.resolveId('./x.js')).toBe(undefined);
  });

  it('logs what fails in a route', async () => {
    writeFileSync(join(dir, 'boom.goal'), 'route GET /boom { throw new Error("boom"); }');
    plugin.handleHotUpdate({ file: join(dir, 'boom.goal'), server });
    expect((await fetch(url + '/boom')).status).toBe(500);
    expect(errors.join('\n')).toContain('Error: boom');
  });
});
