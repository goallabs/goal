// Helpers that compiled goal.js code calls, on the server and in client chunks.
// Names start with _$ so they can't clash with names in user code.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes a value for HTML text or a quoted attribute. */
export const _$e = (v) => {
  const s = String(v);
  return /[&<>"']/.test(s) ? s.replace(/[&<>"']/g, (c) => ESC[c]) : s;
};

/** Compiled markup: HTML that is already safe, so `_$h` doesn't escape it again. */
export class Html {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}

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

/** Writes only the props a component's browser code reads, so the rest never reaches the page. */
export const _$pa = (props, keys) => {
  if (!keys.length) return '';
  const o = {};
  for (const k of keys) if (Object.hasOwn(props, k)) o[k] = props[k];
  return ` m-p="${_$e(JSON.stringify(o))}"`;
};

/**
 * Calls a server function from the browser: what a call in an event handler compiles to. The
 * request carries the page's CSRF token and comes from this site, so the server lets it through.
 */
export const _$sf = async (url, args) => {
  const token = document.querySelector('meta[name="goal-csrf"]')?.content ?? '';
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token }, body: JSON.stringify(args) });
  if (!res.ok) throw new Error(`server function ${url} failed: ${res.status}`);
  return (await res.json()).v;
};

/** Runs a server function for a request from the browser: the arguments are a JSON array. */
export const _$call = async (fn, r, x) =>
  Array.isArray(r.json) ? x.json({ v: (await fn(...r.json)) ?? null }) : x.json({ error: 'send the arguments as a JSON array' }, 400);

/** A render: numbers component instances, collects the page's events, and holds the CSRF token. */
export const _$ctx = (t = '') => ({
  i: 0,
  t,
  ev: new Set(),
  e(list) {
    for (const x of list) this.ev.add(x);
  },
});

/** The server's rendering of a keyed list (see keyed.js): each row through its template. */
export const _$hl = (rows, tpl) => rows.map(tpl).join('');

/** Runs a list row's handler `h` ("r0"): which row is it, counting from the list's start marker? */
export function _$lh(el, root, x, h, e) {
  const row = el.closest('[m-r]');
  const n = row.getAttribute('m-r');
  let i = 0;
  for (let s = row.previousSibling; s.data !== `${root.getAttribute('m-i')}.${n}`; s = s.previousSibling) i++; // rows are all elements
  const list = x[0][n];
  return list.h(list[i][1], i)[h.slice(1)](e); // its index now: a kept row may have moved
}

/** A keyed list in the browser: its rows, and `h(item, index)`, the handlers of one row. */
export const _$L = (rows, h) => ((rows.h = h), rows);

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
}

/** An attribute that changed. As when the page is rendered, a form control's value and checked follow it. */
function attr(a, name, v) {
  if (v === null) a.removeAttribute(name);
  else a.setAttribute(name, v);
  if (name === 'value') a.value = v ?? '';
  if (name === 'checked') a.checked = v !== null;
}
