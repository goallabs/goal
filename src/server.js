// Server rendering: HTML first, and the loader only when the page has something to handle.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { _$e } from './rt.js';
import { _$ctx } from './render.js';

/** Renders a compiled component to HTML, with the events its page needs to listen to. */
export function render(Component, props = {}, ctx = _$ctx()) {
  const html = Component(props, ctx);
  return { html, events: [...ctx.ev] };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const EVENTS = '"__GOAL_EVENTS__"';
const loaderCode = {};
/**
 * The loader, minified, starting itself; the page puts its events where EVENTS is. The code for
 * onmount (`mount`) and for callbacks that change state (`w`) goes in only when asked for.
 */
export function loaderScript({ mount = false, w = false } = {}) {
  let src = readFileSync(join(HERE, 'loader.js'), 'utf8').replace('export function boot', 'function boot');
  for (const [part, on] of Object.entries({ mount, w })) if (!on) src = src.replace(new RegExp(`/\\*\\+${part}\\*/[^]*?/\\*-${part}\\*/`, 'g'), '');
  return (loaderCode[[mount, w]] ??= transformSync(`${src}\nboot(document, ${EVENTS});`, { format: 'iife', minify: true }).code.trim());
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
 * live updates, and the events it listens for, which an update compares. `styles`, the app's
 * stylesheet, is linked at the end of the head, so its rules come after the page's own stylesheets.
 */
export function page(html, events, nonce, token = '', dev = false, styles = null, base = '') {
  const link = styles ? `<link rel="stylesheet" href="${_$e(styles)}">` : '';
  // An app with onmount or callbacks anywhere: a component may first appear in the browser (_$ctx.m
  // and _$ctx.w, see compiler.js)
  if (events.length && _$ctx.m && !events.includes('mount')) events = [...events, 'mount'];
  let script = events.length
    ? `<meta name="goal-csrf" content="${_$e(token)}">${base ? `<meta name="goal-base" content="${_$e(base)}">` : ''}<script type="module" nonce="${nonce}">${loaderScript({ mount: events.includes('mount'), w: !!_$ctx.w }).replace(EVENTS, JSON.stringify(events))}</script>`
    : '';
  if (dev) script += `<meta name="goal-events" content="${_$e(JSON.stringify(events))}"><script type="module" nonce="${nonce}">${hmrScript()}</script>`;
  if (/^<html[\s>]/.test(html)) {
    const h = html.indexOf('</head>');
    if (link) html = h < 0 ? html.replace(/^<html[^>]*>/, (m) => m + link) : html.slice(0, h) + link + html.slice(h);
    const i = html.lastIndexOf('</body>');
    return '<!doctype html>' + (i < 0 ? html + script : html.slice(0, i) + script + html.slice(i));
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>goal.js</title>${link}</head><body>${html}${script}</body></html>`;
}
