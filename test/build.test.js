import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build, serve, dev } from '../src/build.js';
import { main } from '../src/cli.js';
import { TMP } from './helpers.js';

let n = 0;
/** A fresh copy of an app: the demo, or the files given. */
function app(files) {
  const dir = join(TMP, `app${process.pid}-${n++}`);
  rmSync(dir, { recursive: true, force: true });
  if (!files) cpSync(join(import.meta.dirname, '../examples/demo'), dir, { recursive: true, filter: (s) => !s.includes('dist') });
  for (const [f, text] of Object.entries(files ?? {})) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
}

const servers = [];
const listen = (s) => {
  servers.push(s);
  return `http://localhost:${s.address().port}`;
};
afterAll(() => Promise.all(servers.map((s) => new Promise((ok) => s.close(ok)))));

const COUNTER = 'export function C() { var n = 0; return <b onclick={() => n++}>{n}</b>; }';

describe('build', () => {
  it('builds the demo: routes, chunks and their sizes, public files', async () => {
    const dir = app();
    mkdirSync(join(dir, 'node_modules/x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/x/Bad.goal'), 'not goal at all <');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    const r = await build(dir);
    expect(r.routes).toEqual([
      'GET /',
      'GET /notes',
      'POST /notes',
      'DELETE /notes',
      'GET /board',
      'GET /api/notes',
      'GET /users/{name}',
      'GET /about',
      'server function listNotes  POST /_m/components/Board/listNotes',
      'server function addNote  POST /_m/components/Board/addNote',
      'server function removeNote  POST /_m/components/Board/removeNote',
    ]);
    const urls = r.chunks.map((c) => c.url).sort();
    expect(urls.filter((u) => !u.startsWith('/c/_/chunk-'))).toEqual([
      '/c/_/keyed.js',
      '/c/components/Board.Board.js',
      '/c/components/Counter.Counter.js',
      '/c/components/Todo.Todo.js',
      '/c/components/Toggle.Toggle.js',
    ]);
    expect(urls.filter((u) => u.startsWith('/c/_/chunk-'))).toHaveLength(1); // the helpers they share
    // A chunk with a keyed list imports the patcher next to it; one whose list has no keys doesn't.
    expect(readFileSync(join(dir, 'dist/client/c/components/Board.Board.js'), 'utf8')).toContain('"../_/keyed.js"');
    expect(readFileSync(join(dir, 'dist/client/c/components/Todo.Todo.js'), 'utf8')).not.toContain('keyed.js');
    for (const c of r.chunks) {
      const code = readFileSync(join(dir, 'dist/client', c.url), 'utf8');
      expect(c.gzip).toBe(gzipSync(code).length);
      expect(c.bytes).toBe(Buffer.byteLength(code));
    }
    expect(r.loader).toBeGreaterThan(0);
    expect(readFileSync(join(dir, 'dist/server/app.js'), 'utf8')).toContain(`from './components/Counter.js?v=${r.version}'`);
    expect(readFileSync(join(dir, 'dist/server/_routes.js'), 'utf8')).toBe(
      `import { _$routes as r0 } from './app.js?v=${r.version}';\nimport { _$routes as r1 } from './components/Board.js?v=${r.version}';\nexport default [...r0, ...r1];\n`,
    );
    expect(existsSync(join(dir, 'dist/public/style.css'))).toBe(true);
    expect(existsSync(join(dir, 'dist/server/notes.txt'))).toBe(false);
  });

  it('builds the virtual list example (bench/virtual.mjs): 24 keyed rows of 100,000 between two spacers', async () => {
    const dir = join(TMP, `virtual${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    cpSync(join(import.meta.dirname, '../examples/virtual'), dir, { recursive: true, filter: (s) => !s.includes('dist') });
    const r = await build(dir);
    expect(r.chunks.map((c) => c.url).sort()).toEqual(['/c/_/keyed.js', '/c/components/VirtualList.VirtualList.js']);
    const html = await (await fetch(`${listen(await serve(dir, { port: 0 }))}/`)).text();
    expect(html.match(/ m-r="/g)).toHaveLength(24);
    expect(html).toMatch(/style="height:0px"/);
    expect(html).toMatch(new RegExp(`style="height:${(100000 - 24) * 32}px"`));
  });

  it('copies server .js and .json files, and leaves out goal.config.js', async () => {
    const dir = app({
      'app.goal': "import { hi } from './lib/hi.js';\nimport data from './data.json' with { type: 'json' };\nroute GET / { return <p>{hi()}{data.n}</p>; }",
      'lib/hi.js': "export const hi = () => 'hi';",
      'data.json': '{"n":1}',
      'goal.config.js': 'export default {};',
    });
    const r = await build(dir);
    expect(readFileSync(join(dir, 'dist/server/app.js'), 'utf8')).toContain(`from './lib/hi.js?v=${r.version}'`);
    expect(existsSync(join(dir, 'dist/server/lib/hi.js'))).toBe(true);
    expect(existsSync(join(dir, 'dist/server/data.json'))).toBe(true);
    expect(existsSync(join(dir, 'dist/server/goal.config.js'))).toBe(false);
    expect(existsSync(join(dir, 'dist/public'))).toBe(false);
  });

  it('keeps dev chunks readable with source maps, under a public path', async () => {
    const dir = app({ 'ui/C.goal': COUNTER });
    const r = await build(dir, { dev: true, publicPath: '/app/' });
    expect(r.chunks[0].url).toBe('/app/c/ui/C.C.js');
    const code = readFileSync(join(dir, 'dist/client/c/ui/C.C.js'), 'utf8');
    expect(code).toContain('function C(_$s) {\n  var n = _$s.n;');
    const map = JSON.parse(Buffer.from(code.split('base64,')[1], 'base64').toString());
    expect(map.sources.at(-1)).toBe('../../../../ui/C.goal'); // from the chunk's place in dist/client/c/ui
    expect(map.sourcesContent.at(-1)).toBe(COUNTER);
    expect(readFileSync(join(dir, 'dist/server/ui/C.js'), 'utf8')).toContain(`m-c="/app/c/ui/C.C.js?v=${r.version}"`); // a live update loads the new build
  });

  it("lets .goal files import each other's server functions", async () => {
    const dir = app({
      'lib/store.goal': 'export server function save(v) { return v; }\nserver function hidden() {}',
      'ui/B.goal': "import { nothing } from './none.goal';\nroute GET /b { return json(1); }",
      'ui/A.goal': "import { save } from '../lib/store.goal';\nexport function A() { var n = 0; return <b onclick={() => (n = save(n + 1))}>{n}</b>; }",
    });
    const r = await build(dir);
    expect(readFileSync(join(dir, 'dist/client/c/ui/A.A.js'), 'utf8')).toContain('"/_m/lib/store/save"');
    expect(r.routes).toEqual(['server function save  POST /_m/lib/store/save', 'server function hidden  POST /_m/lib/store/hidden', 'GET /b']);
  });

  it('refuses the same route twice', async () => {
    const dir = app({ 'a.goal': 'route GET /u/{id} { return 1; }', 'b.goal': 'route GET /u/{name} { return 1; }' });
    await expect(build(dir)).rejects.toThrow('b.goal: route GET /u/{name} is already in a.goal');
  });

  it('refuses browser code that imports a .goal file', async () => {
    const dir = app({
      'A.goal': 'export const fmt = (n) => n;',
      'B.goal': "import { fmt } from './A.goal';\nexport function B() { var n = 0; return <b onclick={() => n++}>{fmt(n)}</b>; }",
    });
    await expect(build(dir)).rejects.toThrow("browser code can't import the .goal file ./A.goal");
  });
});

describe('serve', () => {
  it('answers routes, serves chunks and public files, and uses goal.config.js', async () => {
    const dir = app({
      'app.goal': "import { C } from './C.goal';\nroute GET / { return <main><C /></main>; }\nroute POST /x { return json(request.form); }",
      'C.goal': COUNTER,
      'public/a.txt': 'hello',
      'goal.config.js': 'export default { csrf: false };',
    });
    await build(dir);
    const url = listen(await serve(dir, { port: 0 }));
    const html = await (await fetch(url)).text();
    expect(html).toContain('m-c="/c/C.C.js"');
    expect(html).toContain('(document,["click"]);})();</script>');
    expect(await (await fetch(url + '/c/C.C.js')).text()).toContain('_$k');
    expect(await (await fetch(url + '/a.txt')).text()).toBe('hello');
    const res = await fetch(url + '/x', { method: 'POST', body: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(await res.json()).toEqual({ a: '1' });
  });

  it('hides errors in production', async () => {
    const dir = app({ 'app.goal': 'route GET / { throw new Error("boom"); }' });
    await build(dir);
    const log = [];
    const url = listen(await serve(dir, { port: 0, log: (e) => log.push(e.message) }));
    expect(await (await fetch(url)).text()).not.toContain('boom');
    expect(log).toEqual(['boom']);
  });
});

describe('dev', () => {
  it('rebuilds when a source changes, shows error details, and reports build errors', async () => {
    const dir = app({ 'app.goal': 'route GET / { return <p>one</p>; }' });
    const log = [];
    const url = listen(await dev(dir, { port: 0, log: (m) => log.push(m) }));
    expect(await (await fetch(url)).text()).toContain('<p>one</p>');
    expect(log[0]).toBe('built: 1 route(s), 0 chunk(s)');

    writeFileSync(join(dir, 'notes.txt'), 'not a source');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist/x.goal'), 'built output');
    writeFileSync(join(dir, 'app.goal'), 'route GET / { return <p>two</p>; }\nroute GET /e { throw new Error("shown"); }');
    await expect.poll(async () => (await fetch(url)).text(), { timeout: 5000 }).toContain('<p>two</p>');
    expect(await (await fetch(url + '/e')).text()).toContain('Error: shown');

    writeFileSync(join(dir, 'app.goal'), 'route GET / { var a = 1; return <p/>; }');
    await expect.poll(() => log.at(-1), { timeout: 5000 }).toContain('state (var) belongs in a component');
  });

  it('logs to the console by default', async () => {
    const dir = app({ 'app.goal': 'route GET / { return <p/>; }' });
    listen(await dev(dir, { port: 0 }));
  });

  it('tells the open pages what each build changed: a stylesheet, code, or the compile error', async () => {
    const dir = app({ 'app.goal': 'route GET / { return <p>one</p>; }', 'public/style.css': 'p {}' });
    const url = listen(await dev(dir, { port: 0, log: () => {} }));
    expect(await (await fetch(url)).text()).toContain('<meta name="goal-events" content="[]"><script type="module" nonce=');
    const res = await fetch(`${url}/_goal/hmr`);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
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
    writeFileSync(join(dir, 'public/style.css'), 'p { color: red }');
    expect(await message()).toMatchObject({ type: 'css' });
    writeFileSync(join(dir, 'app.goal'), 'route GET / { return <p>two</p>; }');
    expect(await message()).toMatchObject({ type: 'update' });
    writeFileSync(join(dir, 'app.goal'), 'route GET / { var a = 1; return <p/>; }');
    expect(await message()).toMatchObject({ type: 'error', message: expect.stringContaining('state (var) belongs in a component') });
  });
});

describe('cli', () => {
  it('builds and prints routes and sizes', async () => {
    const log = [];
    expect(await main(['build', app()], (m) => log.push(m))).toBe(0);
    const out = log.join('\n');
    expect(out).toContain('GET /users/{name}\n');
    expect(out).toContain('server function addNote  POST /_m/components/Board/addNote');
    expect(out).toMatch(/\/c\/components\/Counter\.Counter\.js {2}\d+ B, \d+ B gzipped$/m);
    expect(out).toMatch(/loader {2}\d+ B gzipped, inline/);
  });

  it('prints build errors', async () => {
    const log = [];
    const dir = app({ 'A.goal': 'function A() { return <>x</>; }' });
    expect(await main(['build', dir], (m) => log.push(m))).toBe(1);
    expect(log[0]).toContain('A.goal:1:16: a component ends with');
  });

  it('starts, and runs dev mode, on a port', async () => {
    const dir = app({ 'app.goal': 'route GET / { return <p>hi</p>; }' });
    await build(dir);
    const log = [];
    const url = listen(await main(['start', dir, '--port', '0'], (m) => log.push(m)));
    expect(log).toEqual([url]);
    listen(await main(['dev', dir, '--port', '0'], (m) => log.push(m)));
    expect(await (await fetch(url)).text()).toContain('<p>hi</p>');
  });

  it('uses the current folder and port 3000 by default, and prints usage', async () => {
    const log = [];
    const cwd = process.cwd();
    const dir = app({ 'app.goal': 'route GET / { return <p/>; }' });
    process.chdir(dir);
    try {
      expect(await main(['build'], (m) => log.push(m))).toBe(0);
      listen(await main(['start'], (m) => log.push(m)));
      expect(log.at(-1)).toBe('http://localhost:3000');
    } finally {
      process.chdir(cwd);
    }
    expect(await main([], (m) => log.push(m))).toBe(1);
    expect(log.at(-1)).toBe('usage: goal build|start|dev [app folder] [--port 3000]');
  });
});
