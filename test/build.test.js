import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build, serve, dev, check } from '../src/build.js';
import { main, args } from '../src/cli.js';
import { TMP, fakePostcss } from './helpers.js';
import { scopeName } from '../src/style.js';

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
      'GET /examples',
      'GET /api/notes',
      'GET /users/{name}',
      'GET /about',
      'server function listNotes  POST /_m/components/Board/listNotes',
      'server function addNote  POST /_m/components/Board/addNote',
      'server function removeNote  POST /_m/components/Board/removeNote',
      'server function search  POST /_m/components/Search/search',
    ]);
    const urls = r.chunks.map((c) => c.url).sort();
    expect(urls.filter((u) => !u.startsWith('/c/_/chunk-'))).toEqual([
      '/c/_/keyed.js',
      '/c/components/Board.Board.js',
      '/c/components/Counter.Counter.js',
      '/c/components/Escaping.Escaping.js',
      '/c/components/Feedback.Feedback.js',
      '/c/components/Feedback.Rating.js',
      '/c/components/Groceries.Groceries.js',
      '/c/components/Search.Search.js',
      '/c/components/Temperature.Temperature.js',
      '/c/components/Todo.Todo.js',
      '/c/components/Toggle.Toggle.js',
    ]);
    expect(urls.filter((u) => u.startsWith('/c/_/chunk-'))).toHaveLength(2); // the helpers they share, and call.js (Board and Search)
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
      `import { _$routes as r0 } from './app.js?v=${r.version}';\nimport { _$routes as r1 } from './components/Board.js?v=${r.version}';\nimport { _$routes as r2 } from './components/Search.js?v=${r.version}';\nexport default [...r0, ...r1, ...r2];\nexport const styles = "${r.styles.url}";\n`,
    );
    expect(existsSync(join(dir, 'dist/public/style.css'))).toBe(true);
    expect(existsSync(join(dir, 'dist/server/notes.txt'))).toBe(false);
  });

  it('builds the virtual list example (bench/virtual.mjs): 24 keyed rows of 100,000 between two spacers', async () => {
    const dir = join(TMP, `virtual${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    cpSync(join(import.meta.dirname, '../examples/virtual'), dir, { recursive: true, filter: (s) => !s.includes('dist') });
    const r = await build(dir);
    expect(r.chunks.map((c) => c.url.replace(/chunk-\w+/, 'chunk')).sort()).toEqual(['/c/_/chunk.js', '/c/_/keyed.js', '/c/components/VirtualList.VirtualList.js']); // the helpers it and keyed.js share
    const html = await (await fetch(`${listen(await serve(dir, { port: 0 }))}/`)).text();
    expect(html.match(/ m-r="/g)).toHaveLength(24);
    expect(html).toMatch(/style="height:0px"/);
    expect(html).toMatch(new RegExp(`style="height:${(100000 - 24) * 32}px"`));
  });

  it('bundles the render modules a chunk renders components from, across files', async () => {
    const dir = app({
      'ui/Counter.goal': 'export function Counter({ start }) { var n = start; return <b onclick={() => n++}>{n}</b>; }',
      'ui/Panel.goal': "import { Counter } from './Counter.goal';\nexport function Panel() { var open = true; return <div onclick={() => (open = !open)}>{if (open) <Counter start={2} />}</div>; }",
      'app.goal': "import { Panel } from './ui/Panel.goal';\nroute GET / { return <main><Panel /></main>; }",
    });
    await build(dir);
    const panel = readFileSync(join(dir, 'dist/client/c/ui/Panel.Panel.js'), 'utf8');
    expect(panel).toContain('m-c="/c/ui/Counter.Counter.js'); // Counter's template, rendered in the browser
    expect(panel).not.toContain('goal-render:');
  });

  it('copies server .js and .json files and goal.config.js, all ES modules whatever package.json says', async () => {
    const dir = app({
      'app.goal': "import { hi } from './lib/hi.js';\nimport data from './data.json' with { type: 'json' };\nroute GET / { return <p>{hi()}{data.n}</p>; }",
      'lib/hi.js': "export const hi = () => 'hi';",
      'data.json': '{"n":1}',
      'goal.config.js': 'export default {};',
      'package.json': '{ "type": "commonjs" }', // npm init -y writes this
    });
    const r = await build(dir);
    const hi = () => readFileSync(join(dir, 'dist/server/app.js'), 'utf8').match(/from '\.\/lib\/hi\.js\?v=(\w+)'/)[1];
    const v = hi();
    expect(v).toMatch(/^[0-9a-f]{10}$/);
    expect(v).not.toBe(r.version);
    // Named by the .js files' content, so goal dev keeps them loaded, and what they hold, through a .goal edit
    writeFileSync(join(dir, 'app.goal'), readFileSync(join(dir, 'app.goal'), 'utf8') + '\n// edited');
    await build(dir);
    expect(hi()).toBe(v);
    writeFileSync(join(dir, 'data.json'), '{"n":2}');
    await build(dir);
    expect(hi()).not.toBe(v);
    expect(existsSync(join(dir, 'dist/server/lib/hi.js'))).toBe(true);
    expect(existsSync(join(dir, 'dist/server/data.json'))).toBe(true);
    expect(existsSync(join(dir, 'dist/server/goal.config.js'))).toBe(true);
    expect(readFileSync(join(dir, 'dist/server/package.json'), 'utf8')).toBe('{ "type": "module" }\n');
    expect(existsSync(join(dir, 'dist/public'))).toBe(false);
    expect(r.css).toBe(false);
  });

  it("runs the stylesheets in public/ through the app's PostCSS", async () => {
    const dir = app({
      'app.goal': 'route GET / { return <p/>; }',
      'postcss.config.js': 'export default { plugins: { mark: {} } };',
      'public/style.css': 'p {}',
      'public/sub/more.css': 'b {}',
      'public/a.txt': 'p {}',
    });
    fakePostcss(dir);
    expect((await build(dir)).css).toBe(true);
    expect(readFileSync(join(dir, 'dist/public/style.css'), 'utf8')).toBe('p {}/* {} style.css */');
    expect(readFileSync(join(dir, 'dist/public/sub/more.css'), 'utf8')).toBe('b {}/* {} more.css */');
    expect(readFileSync(join(dir, 'dist/public/a.txt'), 'utf8')).toBe('p {}');
    await build(dir, { dev: true });
    expect(readFileSync(join(dir, 'dist/public/style.css'), 'utf8')).toBe('p {}/* {} map style.css */'); // source maps in goal dev
    rmSync(join(dir, 'public'), { recursive: true });
    expect((await build(dir)).css).toBe(true);
  });

  it("puts the files' style blocks in one stylesheet, which each page links, named by its content", async () => {
    const dir = app({
      'app.goal': "import { C } from './ui/C.goal';\nstyle {\n  main { margin: 0 }\n}\nroute GET / { return <html><head><title>t</title></head><body><main><C /></main></body></html>; }",
      'ui/C.goal': `style {\n  b { color: red; }\n  b:hover { color: blue; }\n}\n${COUNTER}`,
      'ui/Plain.goal': 'export function P() { return <i/>; }',
    });
    const [a, c] = [scopeName('app.goal'), scopeName('ui/C.goal')];
    const log = [];
    expect(await main(['build', dir], (m) => log.push(m))).toBe(0);
    const css = readFileSync(join(dir, 'dist/client/c/_/style.css'), 'utf8');
    expect(css).toBe(`main:where([${a}]){margin:0}b:where([${c}]){color:red}b:hover:where([${c}]){color:#00f}\n`); // minified
    expect(log).toContain(`/c/_/style.css  ${Buffer.byteLength(css)} B, ${gzipSync(css).length} B gzipped (the style blocks)`);
    const r = await build(dir);
    expect(r.styles).toEqual({ url: expect.stringMatching(/^\/c\/_\/style\.css\?v=[0-9a-f]{10}$/), bytes: Buffer.byteLength(css), gzip: gzipSync(css).length });
    expect(readFileSync(join(dir, 'dist/server/_routes.js'), 'utf8')).toContain(`export const styles = "${r.styles.url}";\n`);
    const url = listen(await serve(dir, { port: 0 }));
    expect(await (await fetch(url + '/')).text()).toContain(`<html ${a}><head><title>t</title><link rel="stylesheet" href="${r.styles.url}"></head><body ${a}><main ${a}><b ${c} m-on="click:0" m-c=`);
    expect(await (await fetch(url + r.styles.url)).text()).toBe(css);
    await build(dir, { dev: true }); // readable in goal dev, with each file named
    expect(readFileSync(join(dir, 'dist/client/c/_/style.css'), 'utf8')).toBe(
      `/* app.goal */\nmain:where([${a}]) { margin: 0 }\n/* ui/C.goal */\nb:where([${c}]) { color: red; }\n  b:hover:where([${c}]) { color: blue; }\n`,
    );
    expect((await build(app({ 'app.goal': 'route GET / { return <p/>; }' }))).styles).toBe(null);
  });

  it("runs the stylesheet of the style blocks through the app's PostCSS too", async () => {
    const dir = app({ 'app.goal': 'style {\n  p { margin: 0 }\n}\nroute GET / { return <p/>; }', 'postcss.config.js': 'export default { plugins: { mark: {} } };' });
    fakePostcss(dir);
    await build(dir, { dev: true });
    expect(readFileSync(join(dir, 'dist/client/c/_/style.css'), 'utf8')).toBe(`/* app.goal */\np:where([${scopeName('app.goal')}]) { margin: 0 }\n/* {} map style.css */`);
  });

  it('keeps dev chunks readable with source maps, under a public path', async () => {
    const dir = app({ 'ui/C.goal': COUNTER });
    const r = await build(dir, { dev: true, publicPath: '/app/' });
    expect(r.chunks[0]).toEqual({ url: '/app/c/ui/C.C.js', bytes: expect.any(Number) }); // dev reports no gzipped sizes
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

  it('in dev, compiles again only the files that changed or import one that did, each build under its own name', async () => {
    const dir = app({
      'lib/a.goal': 'export const A = 1;',
      'lib/b.goal': "import { A } from './a.goal';\nexport const B = A;",
      'ui/C.goal': `import { B } from '../lib/b.goal';\nimport { C as Self } from './C.goal';\nimport { x } from './none.goal';\n${COUNTER}`,
      'ui/D.goal': COUNTER.replaceAll('C', 'D'),
    });
    const cache = { compiled: new Map(), exports: new Map() };
    const first = await build(dir, { dev: true, cache });
    const kept = new Map([...cache.compiled].map(([f, x]) => [f, x.r]));
    const again = await build(dir, { dev: true, cache });
    expect([...cache.compiled].every(([f, x]) => x.r === kept.get(f))).toBe(true);
    // What was kept takes the new build's name
    expect(readFileSync(join(dir, 'dist/server/ui/C.js'), 'utf8')).toContain(`m-c="/c/ui/C.C.js?v=${again.version}"`);
    expect(readFileSync(join(dir, 'dist/client/c/ui/C.C.js'), 'utf8')).not.toContain(first.version);
    writeFileSync(join(dir, 'lib/a.goal'), 'export const A = 2;');
    await build(dir, { dev: true, cache });
    const changed = [...cache.compiled].filter(([f, x]) => x.r !== kept.get(f)).map(([f]) => f);
    expect(changed.sort()).toEqual(['lib/a.goal', 'lib/b.goal', 'ui/C.goal']);
  });

  it('counts the loader with the code for onmount and callbacks only in an app that uses them', async () => {
    const plain = await build(app({ 'C.goal': COUNTER }));
    const live = await build(app({ 'A.goal': 'export function A() { var n = 0; return <b onmount={() => setTimeout(() => n++, 1)}>{n}</b>; }', 'B.goal': 'export function B() { return <i onmount={() => {}}>b</i>; }', 'C.goal': COUNTER }));
    expect(live.loader - plain.loader).toBeGreaterThan(150);
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

  it("reads the app's .env, without changing what the environment has, and goal.config.js from dist", async () => {
    process.env.GOAL_TEST_SET = 'from the environment';
    const dir = app({
      'app.goal': 'route GET / { return json([process.env.GOAL_TEST_NEW, process.env.GOAL_TEST_SET]); }\nroute GET /boom { throw new Error("boom"); }',
      '.env': 'GOAL_TEST_NEW=from .env\nGOAL_TEST_SET=from .env\n',
      'goal.config.js': "import { onError } from './lib/hook.js';\nexport default { onError };",
      'lib/hook.js': 'export const seen = [];\nexport const onError = (e) => seen.push(e.message);',
    });
    await build(dir);
    const url = listen(await serve(dir, { port: 0, log: () => {} }));
    expect(await (await fetch(url)).json()).toEqual(['from .env', 'from the environment']);
    await fetch(url + '/boom');
    const { seen } = await import(join(dir, 'dist/server/lib/hook.js')); // the copy goal.config.js imports
    await expect.poll(() => seen).toEqual(['boom']);
    delete process.env.GOAL_TEST_NEW;
    delete process.env.GOAL_TEST_SET;
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

  it('builds once at a time, and the changes made during a build go in the next', async () => {
    // A file slow enough to compile that the next change comes in while it builds
    const big = (text) => Array.from({ length: 60 }, (_, i) => `export function C${i}() { var n = ${i}; return <b onclick={() => n++}>{n}</b>; }`).join('\n') + `\nroute GET / { return <p>${text}</p>; }`;
    const dir = app({ 'app.goal': big('start') });
    const log = [];
    const url = listen(await dev(dir, { port: 0, log: (m) => log.push(m) }));
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(dir, 'app.goal'), big(`edit ${i}`));
      await new Promise((ok) => setTimeout(ok, 30));
    }
    await expect.poll(async () => (await fetch(url)).text(), { timeout: 15000 }).toContain('<p>edit 3</p>');
    expect(log.every((m) => m.startsWith('built:'))).toBe(true);
  }, 20000);

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
  }, 20000); // three builds, each after the file watcher sees a change: slower when the other tests run too

  it('with PostCSS, tells the pages the stylesheet changed after code did: Tailwind makes CSS from it', async () => {
    const dir = app({ 'app.goal': 'route GET / { return <p>one</p>; }', 'public/style.css': 'p {}', 'postcss.config.js': 'export default { plugins: { mark: {} } };' });
    fakePostcss(dir);
    const url = listen(await dev(dir, { port: 0, log: () => {} }));
    expect(await (await fetch(url + '/style.css')).text()).toBe('p {}/* {} map style.css */');
    const res = await fetch(`${url}/_goal/hmr`);
    const reader = res.body.getReader();
    let text = '';
    while ((text.match(/data: /g) ?? []).length < 2) {
      if (!text) writeFileSync(join(dir, 'app.goal'), 'route GET / { return <p>two</p>; }');
      text += new TextDecoder().decode((await reader.read()).value);
    }
    expect(text.match(/"type":"\w+"/g)).toEqual(['"type":"update"', '"type":"css"']);
    reader.cancel();
  }, 20000);
});

describe('style blocks in goal dev', () => {
  it('tell the pages the stylesheet changed after code did', async () => {
    const dir = app({ 'app.goal': 'style {\n  p { margin: 0 }\n}\nroute GET / { return <p>one</p>; }' });
    const url = listen(await dev(dir, { port: 0, log: () => {} }));
    expect(await (await fetch(url + '/')).text()).toMatch(/<link rel="stylesheet" href="\/c\/_\/style\.css\?v=\w+"><\/head>/);
    const res = await fetch(`${url}/_goal/hmr`);
    const reader = res.body.getReader();
    let text = '';
    while ((text.match(/data: /g) ?? []).length < 2) {
      if (!text) writeFileSync(join(dir, 'app.goal'), 'style {\n  p { margin: 1px }\n}\nroute GET / { return <p>two</p>; }');
      text += new TextDecoder().decode((await reader.read()).value);
    }
    expect(text.match(/"type":"\w+"/g)).toEqual(['"type":"update"', '"type":"css"']);
    reader.cancel();
    expect(await (await fetch(url + '/c/_/style.css?v=2')).text()).toContain('margin: 1px');
  }, 20000);
});

describe('goal check', () => {
  const B = '#strict\nexport type Note = { text: string };\nexport function Card({ note }: { note: Note }) { return <p>{note.text}</p>; }';
  it('checks every file, #strict ones against what they import, and builds them', async () => {
    const dir = app({
      'B.goal': B,
      'A.goal': '#strict\nimport { Card, Note } from "./B.goal";\nexport function A({ n }: { n: Note }) { return <div><Card note={n} /></div>; }\nroute GET / { return <main><A n={{ text: "hi" }} /></main>; }',
      'C.goal': '#strict\nimport { Card } from "./missing.goal";\nexport function C() { return <div />; }',
      'D.goal': 'export function D() { return <p>{undefinedThing}</p>; }',
      'H.goal': '#strict\nimport { Note } from "./B.goal";\nexport function H({ n }: { n: Note }) { return <p>{n.text}</p>; }', // B.goal again: read once
    });
    expect(check(dir)).toEqual(["C.goal:2:1: ./missing.goal isn't #strict: a #strict file can import only #strict .goal files"]);
    rmSync(join(dir, 'C.goal'));
    expect(check(dir)).toEqual([]);
    await build(dir);
    const url = listen(await serve(dir, { port: 0 }));
    expect(await (await fetch(url)).text()).toContain('<p>hi</p>');
  });

  it('prints the errors from the cli, and fails on them', async () => {
    const dir = app({ 'B.goal': B, 'A.goal': '#strict\nimport { Card } from "./B.goal";\nexport function A() { return <div><Card note="x" /></div>; }' });
    const log = [];
    expect(await main(['check', dir], (m) => log.push(m))).toBe(1);
    expect(log).toEqual(["A.goal:3:41: Card's note is { text: string }, not string", '1 file with errors']);
    writeFileSync(join(dir, 'A.goal'), '#strict\nexport function A() { return <div />; }\nexport function E() { return <div />; }');
    writeFileSync(join(dir, 'E.goal'), '#strict\nexport function E() { var x = []; return <b>{x.length}</b>; }');
    writeFileSync(join(dir, 'F.goal'), '#strict\nexport function F({ n }) { return <b>{n}</b>; }');
    log.length = 0;
    expect(await main(['check', dir], (m) => log.push(m))).toBe(1);
    expect(log.at(-1)).toBe('2 files with errors');
    rmSync(join(dir, 'E.goal'));
    rmSync(join(dir, 'F.goal'));
    log.length = 0;
    expect(await main(['check', dir], (m) => log.push(m))).toBe(0);
    expect(log).toEqual(['no errors']);
    writeFileSync(join(dir, 'G.goal'), 'route GET / {');
    log.length = 0;
    expect(await main(['check', dir], (m) => log.push(m))).toBe(1);
    expect(log[0]).toMatch(/^G\.goal:1:\d+: /);
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
    expect(out).toMatch(/^\/c\/_\/style\.css {2}\d+ B, \d+ B gzipped \(the style blocks\)$/m);
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

  it('uses the current folder and port 5648 by default, and prints usage', async () => {
    expect(args(['start'])).toEqual({ cmd: 'start', app: '.', port: 5648 });
    expect(args(['dev', 'site', '--port', '8080'])).toEqual({ cmd: 'dev', app: 'site', port: 8080 });
    const log = [];
    const cwd = process.cwd();
    const dir = app({ 'app.goal': 'route GET / { return <p>here</p>; }' });
    process.chdir(dir);
    try {
      expect(await main(['build'], (m) => log.push(m))).toBe(0);
      const url = listen(await main(['start', '--port', '0'], (m) => log.push(m))); // any free port: 5648 may be taken
      expect(log.at(-1)).toBe(url);
      expect(await (await fetch(url)).text()).toContain('<p>here</p>');
    } finally {
      process.chdir(cwd);
    }
    expect(await main([], (m) => log.push(m))).toBe(1);
    expect(log.at(-1)).toBe('usage: goal build|start|dev|check [app folder] [--port 5648]\n       goal add [tool] [app folder]');
  });
});
