// Keyed lists: `{items.map((x) => <tr key={x.id}>...</tr>)}` in a component. Each row is
// [key, item, index, ...values], and a row template turns a row into HTML. When the list changes,
// rows are matched by key: a kept row gets only its changed values written, new rows are made in
// one batch, rows that are gone are removed, and of the kept rows only those out of order are moved
// (the rest are the longest run already in order).

import { into } from './rt.js';

/** A keyed list in the browser: its rows, and `h(item, index)`, the handlers of one row. */
export const _$L = (rows, h) => ((rows.h = h), rows);

/** Runs a list row's handler `h` ("r0"): which row is it, counting from the list's start marker? */
export function _$lh(el, root, x, h, e) {
  const row = el.closest('[m-r]');
  const n = row.getAttribute('m-r');
  let i = 0;
  for (let s = row.previousSibling; s.data !== `${root.getAttribute('m-i')}.${n}`; s = s.previousSibling) i++; // rows are all elements
  const list = x[0][n];
  return list.h(list[i][1], i)[h.slice(1)](e); // its index now: a kept row may have moved
}

const set = (el, name, v, off = v == null || v === false) =>
  name === 'value' ? (el.value = off ? '' : v)
  : name === 'checked' ? (el.checked = !off)
  : off ? el.removeAttribute(name)
  : el.setAttribute(name, v === true ? '' : v);

/** Writes value `v` where `part` says, in `row`: a text (in place when it can be) or an attribute. */
const put = (row, [kind, path, name], v) => {
  let el = row;
  for (const p of path) el = el.children[p];
  const x = el.firstChild;
  if (kind) set(el, name, v);
  else if (/[<&]/.test(v)) into(el.ownerDocument, el, el.firstChild, null, v); // markup: into the nodes there, keyed rows by key
  else if (x?.nodeType === 3 && !x.nextSibling) x.data = v;
  else el.textContent = v;
};

/**
 * New rows, in a fragment. With `parts`, each is a copy of a blank row with its values written in
 * (no HTML to parse); without, they are parsed from the template.
 */
const make = (d, rows, tpl, parts) => {
  const t = d.createElement('template');
  if (!parts) {
    t.innerHTML = rows.map(tpl).join('');
    return t.content;
  }
  // The blank row: a space in each text part, so the value goes in a text node already there.
  tpl.$b ||= ((t.innerHTML = tpl([, , , ...parts.map((p) => (p[0] ? null : ' '))])), d.importNode(t.content.firstChild, true)); // a node of the page
  const f = d.createDocumentFragment();
  for (const r of rows) {
    const n = tpl.$b.cloneNode(true);
    parts.forEach((part, k) => put(n, part, r[k + 3]));
    f.appendChild(n);
  }
  return f;
};

/**
 * Patches the keyed list after the comment `c`, from rows `a` to rows `b`. `parts` says where each
 * value goes in a row: [0, path] the text of an element, [1, path, name] an attribute; null means a
 * row whose values changed is made again from the template.
 */
export function _$lp(d, c, a, b, tpl, parts) {
  let old = [];
  let end = c.nextSibling;
  for (; end.data !== '/'; end = end.nextSibling) old.push(end); // rows are all elements, up to the end marker
  const parent = end.parentNode;
  // Writes a kept row's changed values in place; says no when the row has to be made again.
  // Writes a kept row's changed values in place. A row whose values have no fixed place gets its new
  // markup put into its nodes (rt.js), so what stays the same, an input's focus too, is kept.
  const keep = (r, o, n) => {
    if (r !== o)
      for (let k = 3; k < r.length; k++)
        if (r[k] !== o[k]) {
          if (!parts) {
            into(d, n.parentNode, n, n.nextSibling, tpl(r));
            return 1;
          }
          put(n, parts[k - 3], r[k]);
        }
    return 1;
  };
  // Rows that stay where they were, at the start and at the end, are patched where they are.
  let s = 0;
  let ea = a.length;
  let eb = b.length;
  while (s < ea && s < eb && a[s][0] === b[s][0] && keep(b[s], a[s], old[s])) s++;
  while (ea > s && eb > s && a[ea - 1][0] === b[eb - 1][0] && keep(b[eb - 1], a[ea - 1], old[ea - 1])) (ea--, eb--);
  const stop = old[ea] || end;
  a = a.slice(s, ea);
  b = b.slice(s, eb);
  old = old.slice(s, ea);
  const at = new Map();
  for (let i = 0; i < a.length; i++) at.set(a[i][0], i);
  const nodes = [];
  const from = []; // each row's old position, or -1 for a new one
  const fresh = [];
  const kept = [];
  for (let i = 0; i < b.length; i++) {
    const j = at.get(b[i][0]);
    from[i] = -1;
    if (j === undefined || kept[j] || !keep(b[i], a[j], old[j])) fresh.push(i); // kept[j]: a key used twice
    else (nodes[i] = old[j]), (from[i] = j), (kept[j] = 1);
  }
  if (fresh.length === b.length) {
    // Nothing in the middle kept: out with the old rows, in with the new, in one go each. When
    // nothing at the ends was kept either, and the list is all its parent holds, clear it at once.
    if (!s && stop === end && !c.previousSibling && !end.nextSibling) {
      parent.textContent = '';
      parent.append(c, end);
    } else for (const n of old) n.remove();
    if (b.length) parent.insertBefore(make(d, b, tpl, parts), stop);
    return;
  }
  if (fresh.length)
    [
      ...make(
        d,
        fresh.map((i) => b[i]),
        tpl,
        parts,
      ).children,
    ].forEach((n, x) => (nodes[fresh[x]] = n));
  old.forEach((n, j) => kept[j] || n.remove());
  // The longest run of kept rows already in order stays; everything else is put in place.
  const tails = [];
  const prev = [];
  from.forEach((j, i) => {
    if (j < 0) return;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (from[tails[mid]] < j) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = tails[lo - 1];
    tails[lo] = i;
  });
  const stay = [];
  for (let i = tails.at(-1); i !== undefined; i = prev[i]) stay[i] = 1;
  for (let i = nodes.length, next = stop; i--; next = nodes[i]) if (!stay[i]) parent.insertBefore(nodes[i], next);
}
