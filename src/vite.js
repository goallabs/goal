// goal.js in Vite's dev server:
//
//   // vite.config.js
//   import { goal } from 'goaljs/vite';
//   export default { plugins: [goal()] };
//
// Vite serves the app: its modules and the public folder. Any other request goes to the app's routes
// and server functions, read from the .goal files with Vite's SSR loader and answered the way goal dev
// answers them: error details, the security defaults, live updates. Each component's browser code is a
// module of its own (/ui/Panel.goal.Panel.client.js), and so is each file's render module
// (/ui/Panel.goal.render.js), which the browser renders components from. The .goal files themselves
// are never served. When a file changes, the open pages are told as goal dev tells them (see hmr.js):
// a stylesheet is swapped in place, and code renders the page again with each component's state.
// With a postcss.config.js, the stylesheets in public/ go through PostCSS as goal build's do (see
// css.js), and the app's .env is read into process.env as goal dev reads it.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from './compiler.js';
import { desugar } from './syntax.js';
import { exportsOf } from './types.js';
import { createApp } from './app.js';
import { postcss, postcssConfig } from './css.js';

const SRC = dirname(fileURLToPath(import.meta.url)); // compiled code imports the helpers from here
const SKIP = new Set(['node_modules', 'dist', 'public']);
const MODULE = /^(.*\.goal)\.(?:([A-Za-z_$][\w$]*)\.client|render)\.js$/; // see resolveId
const slash = (p) => p.split(sep).join('/');

/** The .goal files under `dir`, as paths from `root`. */
function goals(dir, root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.isDirectory()) return SKIP.has(d.name) ? [] : goals(join(dir, d.name), root);
    return d.name.endsWith('.goal') ? [slash(relative(root, join(dir, d.name)))] : [];
  });
}

/**
 * @param {{ config?: { csp?: string | false, csrf?: boolean, bodyLimit?: number } }} [options]
 *   config: what goal.config.js would hold (see app.js)
 */
export function goal({ config = {} } = {}) {
  let root;
  let version = 1; // in the URL of each component's module: a page updated live loads the new code
  const pages = new Set(); // the pages listening for live updates
  const tell = (m) => {
    for (const res of pages) res.write(`data: ${JSON.stringify(m)}\n\n`);
  };
  const build = (file, source = readFileSync(file, 'utf8')) => {
    const rel = slash(relative(root, file));
    return compile(source, {
      file: rel,
      base: rel.slice(0, -5),
      rt: join(SRC, 'rt.js'),
      keyed: join(SRC, 'keyed.js'),
      dev: true,
      chunk: (n) => `/${rel}.${n}.client.js?v=${version}`,
      serverFunctions: (spec) => {
        const target = resolve(dirname(file), spec);
        const names = desugar(readFileSync(target, 'utf8'), spec).serverFns.filter((f) => f.exported).map((f) => f.name);
        return { base: slash(relative(root, target)).slice(0, -5), names };
      },
      typesOf: (spec) => {
        const target = resolve(dirname(file), spec);
        return exportsOf(readFileSync(target, 'utf8'), slash(relative(root, target)));
      },
    });
  };

  return {
    name: 'goal',
    config: () => ({ appType: 'custom' }), // the app's routes answer pages, not an index.html
    configResolved(c) {
      root = c.root;
      if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
    },
    // A component's browser code: /ui/Panel.goal.Panel.client.js; a file's render module, imported as
    // goal-render:./Panel.goal: /ui/Panel.goal.render.js. Both are made from the .goal file.
    resolveId(id, importer) {
      if (id.startsWith('goal-render:')) return `${resolve(dirname(importer), id.slice(12))}.render.js?v=${version}`;
      const [path, query] = id.split('?');
      if (MODULE.test(path)) return (path.startsWith(root) ? path : join(root, path)) + (query ? `?${query}` : '');
    },
    load(id) {
      const m = MODULE.exec(id.split('?')[0]);
      if (!m) return;
      const r = build(m[1]);
      return m[2] ? r.clients.find((c) => c.name === m[2]).code : r.render;
    },
    // The server's code, for Vite's SSR loader.
    transform(source, id, opts) {
      if (!id.endsWith('.goal')) return;
      if (!opts?.ssr) throw new Error(`browser code can't import the .goal file ${slash(relative(root, id))}; move shared helpers into a .js file`);
      return build(id, source).server;
    },
    configureServer(server) {
      // Before Vite's own middleware: the .goal files stay on the server, as with goal build.
      server.middlewares.use(async (req, res, next) => {
        if (/\.goal(\?|$)/.test(req.url)) return res.writeHead(404).end();
        // A stylesheet in public/, through the app's PostCSS
        const path = req.url.split('?')[0];
        const file = join(server.config.publicDir, path);
        const css = path.endsWith('.css') && file.startsWith(join(server.config.publicDir, sep)) && existsSync(file) && (await postcss(root, true));
        if (!css) return next();
        let out;
        try {
          out = await css(readFileSync(file, 'utf8'), file, file);
        } catch (e) {
          return next(e);
        }
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' }).end(out);
      });
      // After it: what Vite doesn't serve, the app answers.
      return () =>
        server.middlewares.use(async (req, res) => {
          if (req.url === '/_goal/hmr') {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
            res.write(': goal dev\n\n');
            pages.add(res);
            req.on('close', () => pages.delete(res));
            return;
          }
          let routes;
          try {
            routes = (await Promise.all(goals(root, root).map((f) => server.ssrLoadModule(`/${f}`)))).flatMap((m) => m._$routes ?? []);
          } catch (e) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
            return res.end(e.message); // a compile error: the page shows it over itself (hmr.js)
          }
          createApp(routes, { dev: true, config, log: (e) => server.config.logger.error(e.stack) })(req, res);
        });
    },
    handleHotUpdate({ file, server }) {
      if (!/\.(goal|m?js|json|css)$/.test(file) || file.includes('/node_modules/')) return;
      version++;
      server.moduleGraph.invalidateAll(); // the server code reads the new files
      tell({ type: file.endsWith('.css') ? 'css' : 'update', version });
      if (!file.endsWith('.css') && postcssConfig(root)) tell({ type: 'css', version }); // the CSS may follow the code, as Tailwind's does
      return []; // the pages update themselves
    },
  };
}
