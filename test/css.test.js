import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { postcss, postcssConfig } from '../src/css.js';
import { TMP, fakePostcss } from './helpers.js';

let n = 0;
function app(config, file = 'postcss.config.js') {
  const dir = join(TMP, `css${process.pid}-${n++}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  fakePostcss(dir);
  if (config) writeFileSync(join(dir, file), config);
  return dir;
}

describe('stylesheets through PostCSS', () => {
  it('is nothing without a PostCSS config', async () => {
    expect(await postcss(app())).toBe(null);
  });

  it("runs the plugins the config names, the app's own packages, and skips one turned off", async () => {
    const dir = app("export default { plugins: { mark: { n: 1 }, missing: false } };");
    const css = await postcss(relative(process.cwd(), dir)); // a relative folder, like goal build .
    expect(await css('p {}', join(dir, 'public/style.css'), 'out.css')).toBe('p {}/* {"n":1} style.css */');
    expect(await (await postcss(dir, true))('p {}', join(dir, 'a.css'))).toBe('p {}/* {"n":1} map a.css */'); // goal dev: source maps
  });

  it('takes plugins as a list, a config made by a function, and a .cjs config without plugins', async () => {
    const list = app('export default { plugins: [(css) => css + "!"] };', 'postcss.config.mjs');
    expect(await (await postcss(list))('p {}', join(list, 'a.css'))).toBe('p {}!');
    const fn = app("export default ({ env }) => ({ plugins: { mark: { env } } });");
    expect(await (await postcss(fn, true))('', join(fn, 'a.css'))).toBe('/* {"env":"development"} map a.css */');
    expect(await (await postcss(fn))('', join(fn, 'a.css'))).toBe('/* {"env":"production"} a.css */');
    const cjs = app('module.exports = {};', 'postcss.config.cjs');
    expect(postcssConfig(cjs)).toBe(join(cjs, 'postcss.config.cjs'));
    expect(await (await postcss(cjs))('p {}', join(cjs, 'a.css'))).toBe('p {}');
  });
});
