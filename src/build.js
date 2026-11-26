// Building and serving a goal.js app.
//
//   app/**/*.goal    ->  dist/server/**.js (components and routes) and one client chunk per
//                        interactive component in dist/client/c/
//   app/**/*.js      ->  dist/server/**.js as they are, for server code the .goal files import
//   app/public/      ->  dist/public/, served as files; stylesheets through PostCSS when the app
//                        has a postcss.config.js (see css.js)
//   app/goal.config.js   opt-outs of the security defaults and the error hook (see src/app.js),
//                        copied with the server code
//   app/.env         ->  process.env, for goal start and goal dev

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, cpSync, rmSync, watch } from 'node:fs';
import { join, relative, dirname, resolve, sep, posix } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import * as esbuild from 'esbuild';
import { compile } from './compiler.js';
import { exportsOf } from './types.js';
import { desugar } from './syntax.js';
import { loaderScript } from './server.js';
import { createApp } from './app.js';
import { postcss } from './css.js';


const SRC = dirname(fileURLToPath(import.meta.url));
const RT = pathToFileURL(join(SRC, 'rt.js')).href;
const KEYED = 'goal:keyed'; // the keyed list patcher, its own file: c/_/keyed.js
const SKIP = new Set(['dist', 'node_modules', 'public']);

function files(dir, root = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return SKIP.has(d.name) ? [] : files(p, root);
    return [relative(root, p).split(sep).join('/')];
  });
}

const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const noGoal = {
  name: 'goal',
  setup(b) {
    b.onResolve({ filter: /^file:/ }, (a) => ({ path: fileURLToPath(a.path) }));
    b.onResolve({ filter: /\.goal$/ }, (a) => ({
      errors: [{ text: `browser code can't import the .goal file ${a.path}; move shared helpers into a .js file` }],
    }));
  },
};

/** Client modules as esbuild entry points, each resolved from its .goal file's folder. */
/**
 * Client modules as esbuild entry points, each resolved from its .goal file's folder, and the render
 * modules they import (`goal-render:./Panel.goal`, see renderModule in compiler.js), by .goal file.
 */
const entriesPlugin = (entries, renders) => {
  // Each entry sits, in name, next to its .goal file, so source maps name that file from the app folder.
  const byPath = new Map([...entries.values()].map((e) => [join(e.dir, `${e.name}.goal.js`), e]));
  return {
    name: 'goal-entries',
    setup(b) {
      b.onResolve({ filter: /^goal-entry:/ }, (a) => ({ path: join(entries.get(a.path.slice(11)).dir, `${entries.get(a.path.slice(11)).name}.goal.js`) }));
      b.onLoad({ filter: /\.goal\.js$/ }, (a) => ({ contents: byPath.get(a.path).code, resolveDir: byPath.get(a.path).dir, loader: 'js' }));
      b.onResolve({ filter: /^goal-render:/ }, (a) => ({ path: `${resolve(a.resolveDir, a.path.slice(12))}.render.js` }));
      b.onLoad({ filter: /\.goal\.render\.js$/ }, (a) => ({ contents: renders.get(a.path.slice(0, -10)), resolveDir: dirname(a.path), loader: 'js' }));
    },
  };
};

/**
 * What the .goal files tell each other: the server functions each exports, so files can import them,
 * and what a #strict file that imports one gets from it (see types.js), each read once.
 */
function linker(app, all) {
  const exported = new Map();
  for (const rel of all.filter((f) => f.endsWith('.goal')))
    exported.set(rel, desugar(readFileSync(join(app, rel), 'utf8'), rel).serverFns.filter((f) => f.exported).map((f) => f.name));
  const typed = new Map();
  const to = (rel, spec) => posix.join(posix.dirname(rel), spec);
  return {
    serverFunctions: (rel) => (spec) => (exported.has(to(rel, spec)) ? { base: to(rel, spec).slice(0, -5), names: exported.get(to(rel, spec)) } : null),
    typesOf: (rel) => (spec) => {
      const target = to(rel, spec);
      if (!exported.has(target)) return null;
      if (!typed.has(target)) typed.set(target, exportsOf(readFileSync(join(app, target), 'utf8'), target));
      return typed.get(target);
    },
  };
}

/** goal check: compiles every .goal file as goal build does, types too, and gives each file's first error. */
export function check(app) {
  const all = files(app);
  const link = linker(app, all);
  const errors = [];
  for (const rel of all.filter((f) => f.endsWith('.goal')))
    try {
      compile(readFileSync(join(app, rel), 'utf8'), { file: rel, base: rel.slice(0, -5), rt: RT, keyed: KEYED, serverFunctions: link.serverFunctions(rel), typesOf: link.typesOf(rel) });
    } catch (e) {
      errors.push(e.message);
    }
  return errors;
}

/**
 * Compiles an app into dist/. Throws on a compile error or a duplicate route.
 * `dev` keeps chunks readable with source maps back to the .goal files; otherwise they are minified
 * and the source stays on the server. `publicPath` is where the site is served from.
 * @returns {Promise<{ version: string, chunks: { url: string, bytes: number, gzip: number }[], loader: number, routes: string[], css: boolean,
 *   styles: { url: string, bytes: number, gzip: number } | null }>}
 *   css: whether the stylesheets went through PostCSS; styles: the app's stylesheet, the files' style blocks
 */
export async function build(app, { out = join(app, 'dist'), dev = false, publicPath = '/' } = {}) {
  const version = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const chunks = [];
  const routes = [];
  const routeFiles = [];
  const entries = new Map(); // client modules, by output name
  const renders = new Map(); // render modules, by .goal file
  const sheets = new Map(); // the style blocks, scoped, by .goal file
  rmSync(out, { recursive: true, force: true });
  const all = files(app);
  const link = linker(app, all);
  for (const rel of all) {
    if (!rel.endsWith('.goal')) {
      if (/\.(m?js|json)$/.test(rel)) write(join(out, 'server', rel), readFileSync(join(app, rel)));
      continue;
    }
    const base = rel.slice(0, -5);
    // In dev a chunk's URL names the build, so a page updated live loads the new code.
    const chunk = (n) => `${publicPath}c/${base}.${n}.js${dev ? `?v=${version}` : ''}`;
    const r = compile(readFileSync(join(app, rel), 'utf8'), { file: rel, base, rt: RT, keyed: KEYED, chunk, dev, serverFunctions: link.serverFunctions(rel), typesOf: link.typesOf(rel) });
    const server = r.server.replace(/((?:from|import)\s*["'])(\.{1,2}\/[^"']+?)(\.goal|\.m?js)(["'])/g, (_, a, p, ext, b) => `${a}${p}${ext === '.goal' ? '.js' : ext}?v=${version}${b}`);
    write(join(out, 'server', base + '.js'), server);
    if (r.routes.length || r.serverFunctions.length) routeFiles.push(base);
    for (const f of r.serverFunctions) routes.push({ key: f.path, file: rel, label: `server function ${f.name}  POST ${f.path}` });
    for (const route of r.routes) {
      const key = `${route.method} ${route.path.replace(/\{\w+\}/g, '{}')}`;
      const other = routes.find((x) => x.key === key);
      if (other) throw new Error(`${rel}: route ${route.method} ${route.path} is already in ${other.file}`);
      routes.push({ key, file: rel, label: `${route.method} ${route.path}` });
    }
    renders.set(resolve(app, rel), r.render);
    if (r.css) sheets.set(rel, r.css);
    for (const c of r.clients) entries.set(`${base}.${c.name}`, { code: c.code, dir: resolve(app, dirname(rel)), name: `${posix.basename(base)}.${c.name}` });
  }
  // All browser code in one bundle with code splitting: each component is its own file, and code
  // that several share (the runtime helpers, the list patcher) goes in shared files under c/_/.
  if (entries.size) {
    const bundle = async (minify) =>
      (
        await esbuild.build({
          entryPoints: { ...Object.fromEntries([...entries.keys()].map((k) => [k, `goal-entry:${k}`])), '_/keyed': join(SRC, 'keyed.js') },
          external: [KEYED],
          absWorkingDir: resolve(app), // source maps name the .goal files from the app folder
          outdir: resolve(out, 'client', 'c'),
          chunkNames: '_/[name]-[hash]',
          bundle: true,
          splitting: true,
          minify,
          sourcemap: minify ? false : 'inline',
          format: 'esm',
          write: false,
          logLevel: 'silent',
          plugins: [entriesPlugin(entries, renders), noGoal],
        })
      ).outputFiles;
    // A chunk with a keyed list imports the patcher from its own file, next to the chunks.
    const link = (f) => {
      const from = posix.dirname(relative(resolve(out, 'client', 'c'), f.path).split(sep).join('/'));
      const to = posix.relative(from, '_/keyed.js');
      return f.text.replaceAll(`"${KEYED}"`, JSON.stringify(to.startsWith('.') ? to : './' + to));
    };
    const files = (await bundle(true)).map((f) => ({ path: f.path, text: link(f) })); // the sizes reported are what production ships
    for (const f of dev ? (await bundle(false)).map((f) => ({ path: f.path, text: link(f) })) : files) write(f.path, f.text);
    for (const f of files) {
      const rel = relative(resolve(out, 'client'), f.path).split(sep).join('/');
      chunks.push({ url: publicPath + rel, bytes: Buffer.byteLength(f.text), gzip: gzipSync(f.text).length });
    }
  }
  // The files' style blocks, in one stylesheet for the whole app: through PostCSS when the app has a
  // config, minified for production. Its URL names its content, so a browser caches it until it changes.
  const css = await postcss(app, dev);
  let styles = null;
  if (sheets.size) {
    const file = join(out, 'client', 'c', '_', 'style.css');
    let text = [...sheets.keys()]
      .sort() // the same order, and so the same URL, on any machine
      .map((rel) => `/* ${rel} */\n${sheets.get(rel).trim()}\n`)
      .join('');
    if (css) text = await css(text, join(app, 'style.css'), file);
    if (!dev) text = (await esbuild.transform(text, { loader: 'css', minify: true })).code;
    write(file, text);
    styles = { url: `${publicPath}c/_/style.css?v=${createHash('sha256').update(text).digest('hex').slice(0, 10)}`, bytes: Buffer.byteLength(text), gzip: gzipSync(text).length };
  }
  write(
    join(out, 'server', '_routes.js'),
    routeFiles.map((f, i) => `import { _$routes as r${i} } from './${f}.js?v=${version}';\n`).join('') +
      `export default [${routeFiles.map((_, i) => `...r${i}`).join(', ')}];\n` +
      (styles ? `export const styles = ${JSON.stringify(styles.url)};\n` : ''),
  );
  // The server code is ES modules, whatever the app's package.json says.
  write(join(out, 'server', 'package.json'), '{ "type": "module" }\n');
  if (existsSync(join(app, 'public'))) {
    cpSync(join(app, 'public'), join(out, 'public'), { recursive: true });
    for (const f of css ? readdirSync(join(app, 'public'), { recursive: true }).filter((f) => f.endsWith('.css')) : [])
      writeFileSync(join(out, 'public', f), await css(readFileSync(join(app, 'public', f), 'utf8'), join(app, 'public', f), join(out, 'public', f)));
  }
  return { version, chunks, loader: gzipSync(loaderScript()).length, routes: routes.map((r) => r.label), css: !!css, styles };
}

/**
 * Serves a built app. `dev` shows error details; `version` names the build to load; `hmr`, the set
 * of pages listening at /_goal/hmr for live updates (goal dev).
 */
export async function serve(app, { out = join(app, 'dist'), port = 3000, dev = false, version = () => '', log = console.error, hmr } = {}) {
  if (existsSync(join(app, '.env'))) process.loadEnvFile(join(app, '.env')); // what the environment has already wins
  const configFile = join(out, 'server', 'goal.config.js');
  const config = existsSync(configFile) ? (await import(pathToFileURL(configFile).href)).default : {};
  const routesFile = pathToFileURL(join(out, 'server', '_routes.js')).href;
  const server = createServer(async (req, res) => {
    if (hmr && req.url === '/_goal/hmr') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(': goal dev\n\n');
      hmr.add(res);
      req.on('close', () => hmr.delete(res));
      return;
    }
    const { default: routes, styles } = await import(`${routesFile}?v=${version()}`);
    return createApp(routes, { dev, config, log, styles, staticDirs: [join(out, 'client'), join(out, 'public')] })(req, res);
  });
  return new Promise((ok) => server.listen(port, () => ok(server)));
}

/**
 * Builds, serves with error details, and builds again when a source file changes. Open pages update
 * live (see hmr.js): after a build they're told that a stylesheet changed, that code did, or what the
 * compile error is.
 */
export async function dev(app, { port = 3000, log = console.log } = {}) {
  let version = '';
  const pages = new Set();
  const tell = (m) => {
    for (const res of pages) res.write(`data: ${JSON.stringify(m)}\n\n`);
  };
  const rebuild = async (changed = []) => {
    try {
      const r = await build(app, { dev: true });
      version = r.version;
      log(`built: ${r.routes.length} route(s), ${r.chunks.length} chunk(s)`);
      const type = changed.length && changed.every((f) => f.endsWith('.css')) ? 'css' : 'update';
      tell({ type, version });
      if (type === 'update' && (r.css || r.styles)) tell({ type: 'css', version }); // the style blocks changed, or PostCSS made new CSS from the code, as Tailwind does
    } catch (e) {
      log(e.message);
      tell({ type: 'error', message: e.message });
    }
  };
  await rebuild();
  process.setSourceMapsEnabled(true); // stack traces point at the .goal files
  const server = await serve(app, { port, dev: true, version: () => version, log, hmr: pages });
  let timer;
  let changed = [];
  const watcher = watch(app, { recursive: true }, (_, f) => {
    if (!/\.(goal|m?js|json|css)$/.test(String(f)) || String(f).startsWith('dist')) return;
    changed.push(String(f));
    clearTimeout(timer);
    timer = setTimeout(() => rebuild(changed.splice(0)), 30);
  });
  // The pages' streams stay open, so close them for the server to close.
  const close = server.close.bind(server);
  server.close = (done) => {
    watcher.close();
    for (const res of pages) res.end();
    return close(done);
  };
  return server;
}
