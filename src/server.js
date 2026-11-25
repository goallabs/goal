// Server rendering: HTML first, and the loader only when the page has something to handle.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { _$ctx, _$e } from './rt.js';

/** Renders a compiled component to HTML, with the events its page needs to listen to. */
export function render(Component, props = {}, ctx = _$ctx()) {
  const html = Component(props, ctx);
  return { html, events: [...ctx.ev] };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const EVENTS = '"__GOAL_EVENTS__"';
let loaderCode;
/** The loader, minified, starting itself; the page puts its events where EVENTS is. */
export function loaderScript() {
  const src = readFileSync(join(HERE, 'loader.js'), 'utf8');
  loaderCode ??= transformSync(`${src.replace('export function boot', 'function boot')}\nboot(document, ${EVENTS});`, { format: 'iife', minify: true }).code.trim();
  return loaderCode;
}

let hmrCode;
/** goal dev's live updates in the page (hmr.js), minified, starting itself. */
export function hmrScript() {
  hmrCode ??= transformSync(`${readFileSync(join(HERE, 'hmr.js'), 'utf8').replace('export function hmr', 'function hmr')}\nhmr(document, window);`, { format: 'iife', minify: true }).code.trim();
  return hmrCode;
}

/**
 * A whole HTML document. Markup that starts with <html> is the document itself; anything else goes
 * in a plain one. The loader goes in only when there are events, with the request's CSP nonce, and
 * the CSRF token that server function calls send. In goal dev (`dev`), every page also gets the
 * live updates, and the events it listens for, which an update compares.
 */
export function page(html, events, nonce, token = '', dev = false) {
  let script = events.length
    ? `<meta name="goal-csrf" content="${_$e(token)}"><script type="module" nonce="${nonce}">${loaderScript().replace(EVENTS, JSON.stringify(events))}</script>`
    : '';
  if (dev) script += `<meta name="goal-events" content="${_$e(JSON.stringify(events))}"><script type="module" nonce="${nonce}">${hmrScript()}</script>`;
  if (/^<html[\s>]/.test(html)) {
    const i = html.lastIndexOf('</body>');
    return '<!doctype html>' + (i < 0 ? html + script : html.slice(0, i) + script + html.slice(i));
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>goal.js</title></head><body>${html}${script}</body></html>`;
}
