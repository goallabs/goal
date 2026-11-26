// Stylesheets through PostCSS. When the app has a postcss.config.js (or .mjs, .cjs), each .css file in
// public/ goes through the plugins it names before it's served: Tailwind CSS, autoprefixer and the
// like. goal build writes the result to dist/public/; the Vite plugin answers it on request. PostCSS
// and its plugins are the app's own packages, found from the app's folder.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The app's PostCSS config file, if it has one. */
export const postcssConfig = (app) => ['postcss.config.js', 'postcss.config.mjs', 'postcss.config.cjs'].map((f) => resolve(app, f)).find((f) => existsSync(f));

/**
 * The app's PostCSS, as `(css, from, to) => Promise<string>`, or null when the app has no PostCSS
 * config. The config is read anew each time, so goal dev sees it change. `dev` adds source maps.
 */
export async function postcss(app, dev = false) {
  const file = postcssConfig(app);
  if (!file) return null;
  const require = createRequire(file);
  const load = async (name) => (await import(pathToFileURL(require.resolve(name)).href)).default;
  let config = (await import(`${pathToFileURL(file).href}?v=${Date.now()}`)).default;
  if (typeof config === 'function') config = await config({ env: dev ? 'development' : 'production' });
  // { plugins: { name: options } }, each plugin a package of the app's, or { plugins: [plugin(), ...] }
  const { plugins = [] } = config;
  const list = Array.isArray(plugins) ? plugins : await Promise.all(Object.entries(plugins).filter(([, o]) => o !== false).map(async ([name, o]) => (await load(name))(o)));
  const run = await load('postcss');
  return async (css, from, to) => (await run(list).process(css, { from, to, map: dev && { inline: true } })).css;
}
