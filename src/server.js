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

const EVENTS = '"__GOAL_EVENTS__"';
let loaderCode;
/** The loader, minified, starting itself; the page puts its events where EVENTS is. */
export function loaderScript() {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'loader.js'), 'utf8');
  loaderCode ??= transformSync(`${src.replace('export function boot', 'function boot')}\nboot(document, ${EVENTS});`, { format: 'iife', minify: true }).code.trim();
  return loaderCode;
}

/**
 * A whole HTML document. Markup that starts with <html> is the document itself; anything else goes
 * in a plain one. The loader goes in only when there are events, with the request's CSP nonce, and
 * the CSRF token that server function calls send.
 */
export function page(html, events, nonce, token = '') {
  const script = events.length
    ? `<meta name="goal-csrf" content="${_$e(token)}"><script type="module" nonce="${nonce}">${loaderScript().replace(EVENTS, JSON.stringify(events))}</script>`
    : '';
  if (/^<html[\s>]/.test(html)) {
    const i = html.lastIndexOf('</body>');
    return '<!doctype html>' + (i < 0 ? html + script : html.slice(0, i) + script + html.slice(i));
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>goal.js</title></head><body>${html}${script}</body></html>`;
}
