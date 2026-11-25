// Compiles a component source into real files, so tests import exactly what the build makes.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from '../src/compiler.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RT = pathToFileURL(join(HERE, '../src/rt.js')).href;
export const TMP = join(HERE, '.tmp');

let n = 0;

/** compile() with the helpers imported from src/rt.js and chunks at /c/<Name>.js, and other options. */
export const build = (src, file = 'App.goal', opts = {}) => compile(src, { file, rt: RT, chunk: (name) => `/c/${name}.js`, ...opts });

/** Compiles, writes the server module and client chunks, and imports the server module. */
export async function load(src, opts) {
  const r = build(src, undefined, opts);
  const dir = join(TMP, `m${process.pid}-${n++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'server.mjs'), r.server);
  writeFileSync(join(dir, 'render.mjs'), r.render); // the file's components, as the browser renders them
  const render = JSON.stringify(pathToFileURL(join(dir, 'render.mjs')).href);
  const chunks = {};
  for (const c of r.clients) {
    writeFileSync(join(dir, `${c.name}.mjs`), c.code.replace(/"goal-render:[^"]+"/g, render));
    chunks[`/c/${c.name}.js`] = pathToFileURL(join(dir, `${c.name}.mjs`)).href;
  }
  const server = await import(pathToFileURL(join(dir, 'server.mjs')).href);
  return { r, server, chunks, loadChunk: (url) => import(chunks[url]) };
}
