// Helpers that compiled goal.js code calls, on the server and in client chunks.
// Names start with _$ so they can't clash with names in user code.
//
// The bundler splits the browser code by file, so this one holds only what nearly every component
// needs: escaping, templates, attributes and patching a hole. The rest are in files of their own,
// loaded only by the components that use them: render.js (components rendered in the browser),
// call.js (server function calls) and keyed.js (keyed lists).

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes a value for HTML text or a quoted attribute. */
export const _$e = (v) => {
  const s = String(v);
  return /[&<>"']/.test(s) ? s.replace(/[&<>"']/g, (c) => ESC[c]) : s;
};

/** Compiled markup: HTML that is already safe, so `_$h` doesn't escape it again. */
const MARKUP = Symbol.for('goal.markup'); // the same in every copy of this module (Vite loads its own)

export class Html {
  constructor(s) {
    this.s = s;
    this[MARKUP] = true;
  }
  toString() {
    return this.s;
  }
}

/** Is it markup a compiled template made, whichever copy of this module made it? */
export const isHtml = (v) => v?.[MARKUP] === true;

/** Marks a compiled template as markup. Only compiled code makes these. */
export const _$m = (s) => new Html(s);

/** Renders any `{value}` child: markup as HTML, lists joined, null/booleans as nothing, the rest escaped. */
export const _$h = (v) =>
  typeof v === 'number' ? '' + v
  : v instanceof Html ? v.s
  : Array.isArray(v) ? v.map(_$h).join('')
  : v == null || typeof v === 'boolean' ? ''
  : _$e(v);

/** Attributes that hold a URL a browser may navigate to or load. */
export const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'cite', 'data', 'manifest', 'background']);

/** The URL itself when it is relative or http(s)/mailto/tel; a harmless placeholder for javascript:, data: and the rest. */
export const _$u = (v) => {
  if (v == null || typeof v === 'boolean') return v;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(String(v).replace(/[\u0000- ]/g, ''));
  return !m || /^(https?|mailto|tel)$/i.test(m[1]) ? v : 'about:invalid#blocked';
};

/** Renders an attribute: false/null leave it out, true writes it bare; URLs are checked. */
export const _$a = (name, v) => {
  if (URL_ATTRS.has(name)) v = _$u(v);
  return v == null || v === false ? '' : v === true ? ' ' + name : ` ${name}="${_$e(v)}"`;
};

/** Runs a server function for a request from the browser: the arguments are a JSON array. */
export const _$call = async (fn, r, x, types) => {
  if (!Array.isArray(r.json)) return x.json({ error: 'send the arguments as a JSON array' }, 400);
  // A server function in a #strict file: arguments that aren't of its types never reach it.
  if (types && (r.json.length > types.length || !types.every((p, i) => (r.json[i] === undefined || r.json[i] === null ? p.optional || _$ok(r.json[i], p.type) : _$ok(r.json[i], p.type)))))
    return x.json({ error: "the arguments aren't of the types the function takes" }, 400);
  return x.json({ v: (await fn(...r.json)) ?? null });
};

/** Is this JSON value of type x (see types.js)? What JSON can't carry, like a function, isn't checked here. */
export function _$ok(v, x) {
  switch (x.k) {
    case 'string':
    case 'number':
    case 'boolean':
      return typeof v === x.k;
    case 'null':
      return v === null;
    case 'undefined':
    case 'void':
      return v == null; // JSON has no undefined: null stands for it
    case 'lit':
      return v === x.v;
    case 'array':
      return Array.isArray(v) && v.every((y) => _$ok(y, x.of));
    case 'object':
      return !!v && typeof v === 'object' && !Array.isArray(v) && Object.entries(x.fields).every(([n, f]) => (v[n] == null ? f.optional || _$ok(v[n], f.type) : _$ok(v[n], f.type)));
    case 'union':
      return x.of.some((y) => _$ok(v, y));
    default:
      return true;
  }
}

/** A component's HTML as a list row: its element carries the row's key, as a row element does (m-k). */
export const _$mk = (html, key) => html.replace(/^<[\w-]+/, (tag) => `${tag} m-k="${_$e(String(key))}"`);

/** The server's rendering of a keyed list (see keyed.js): each row through its template. */
export const _$hl = (rows, tpl) => rows.map(tpl).join('');

/**
 * A `{...}` hole's new markup, put into the nodes after its start marker `c` (see into).
 */
export function _$hm(d, c, html) {
  let end = c.nextSibling;
  while (end.nodeType !== 8 || end.data !== '/') end = end.nextSibling;
  into(d, c.parentNode, c.nextSibling, end, html);
}

/**
 * New markup, put into the nodes of `parent` from `at` up to `end` (null: its last). A node of the
 * same kind as the new one in its place is kept and updated, so a focused input stays focused and
 * keeps what was typed; a row with a key (`m-k`) is found by its key, and moved there. The others
 * are added or removed.
 */
export function into(d, parent, at, end, html) {
  const t = d.createElement('template');
  t.innerHTML = html;
  kids(parent, at, end, t.content);
}

const key = (n) => (n.nodeType === 1 ? n.getAttribute('m-k') : null);

function kids(parent, at, end, to) {
  for (let n = to.firstChild, next; n; n = next) {
    next = n.nextSibling;
    const k = key(n);
    let old = at;
    if (k !== null) while (old !== end && key(old) !== k) old = old.nextSibling;
    if (old !== end && old.nodeName === n.nodeName && key(old) === k) {
      if (old === at) at = at.nextSibling;
      else parent.insertBefore(old, at);
      same(old, n);
    } else parent.insertBefore(n, at);
  }
  while (at !== end) {
    const x = at.nextSibling;
    at.remove();
    at = x;
  }
}

function same(a, b) {
  if (a.nodeType !== 1) {
    if (a.data !== b.data) a.data = b.data;
    return;
  }
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) attr(a, name, null);
  for (const { name, value } of b.attributes) if (a.getAttribute(name) !== value) attr(a, name, value);
  kids(a, a.firstChild, null, b);
  // A component rendered again in the browser, with its state now (see _$B.k): its attributes say
  // all, so the loader reads it afresh on its next event.
  if (a.hasAttribute('m-c')) a.$s = a.$p = a.$x = a.$m = undefined;
}

/** An attribute that changed. As when the page is rendered, a form control's value and checked follow it. */
function attr(a, name, v) {
  if (v === null) a.removeAttribute(name);
  else a.setAttribute(name, v);
  if (name === 'value') a.value = v ?? '';
  if (name === 'checked') a.checked = v !== null;
}

/**
 * A callback a handler made that changes state, like setInterval's, as the component's code holds
 * it: callback `i` of the component at root `r`, with `c`, what it uses of the functions around it.
 * The loader runs it as a handler of the run the page shows (see goal:w in loader.js), so it sees
 * the state as it is now, and the page updates.
 */
export const _$w = (r, i, c = []) => (...a) => {
  const e = new CustomEvent('goal:w', { bubbles: true, detail: [i, a, c] });
  r.dispatchEvent(e);
  return e.o;
};
