// Keyed lists: `{items.map((x) => <tr key={x.id}>...</tr>)}` in a component. Each row is
// [key, item, index, ...values], and a row template turns a row into HTML. When the list changes,
// rows are matched by key: a kept row gets only its changed values written, new rows are made in
// one batch, rows that are gone are removed, and of the kept rows only those out of order are moved
// (the rest are the longest run already in order).

import { into } from './rt.js';

/**
 * A keyed list in the browser: its rows, and `h(item, index)`, the handlers of one row. The rows are
 * kept on the state `s`, under `k`, for the next run (_$lf): as a function, which JSON leaves out.
 * What's kept is a copy without the handlers: they hold this run's variables, the finder among them,
 * which holds the last run's rows, so keeping them would keep every run before.
 */
export const _$L = (rows, h, s, k) => {
  if (s) {
    const kept = rows.slice();
    s[k] = () => kept;
  }
  rows.h = h;
  return rows;
};

/**
 * Finds the last run's row for each row of this run, by its key: where it was, give or take the rows
 * added or taken out before it; else by looking through them, for the first few rows that moved (a
 * swap), and in a map of the keys after that.
 */
export const _$lf = (last) => {
  const rows = last ? last() : [];
  let off = 0;
  let miss = 0;
  let at;
  return (key, i) => {
    const o = rows[i + off];
    if (o && o[0] === key) return o;
    if (!at && miss++ > 3) {
      at = new Map();
      rows.forEach((r, j) => at.set(r[0], j));
    }
    const j = at ? at.get(key) : rows.findIndex((r) => r[0] === key);
    if (!(j >= 0)) return; // not there: undefined, or -1
    off = j - i;
    return rows[j];
  };
};

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

/**
 * A function prop of a component in a row: handler `h` ("r0") of the row with key `key` in list `n`,
 * found by its key when the child calls it (its place may have changed since it rendered).
 */
export const _$lk = (x, [n, key], h, a) => {
  const list = x[0][n];
  const i = list.findIndex((r) => r[0] === key);
  return list.h(list[i][1], i)[h.slice(1)](...a);
};

/**
 * Writes value `v` where `part` says, in `row`: a text (in place when it can be), an attribute, or a
 * component's HTML, into its element. A component's prop has no place of its own (kind 3).
 */
const put = (row, [kind, path, name], v) => {
  if (kind > 2) return;
  let el = row;
  for (let p of path) for (el = el.firstElementChild; p--; ) el = el.nextElementSibling; // no live children list for each element
  const x = el.firstChild;
  if (kind > 1) into(el.ownerDocument, el.parentNode, el, el.nextSibling, v);
  else if (kind) set(el, name, v);
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
  if (!parts || parts.some((p) => p[0] === 2)) {
    // a component's HTML is markup to parse anyway
    t.innerHTML = rows.map(tpl).join('');
    return t.content;
  }
  // The blank row: a space in each text part, so the value goes in a text node already there.
  tpl.$b ||= ((t.innerHTML = tpl([, , , ...parts.map((p) => (p[0] ? null : ' '))])), d.importNode(t.content.firstChild, true)); // a node of the page
  const f = d.createDocumentFragment();
  for (const r of rows) {
    const n = tpl.$b.cloneNode(true);
    parts.forEach((part, k) => (part[0] && (r[k + 3] == null || r[k + 3] === false)) || put(n, part, r[k + 3])); // the blank row has no attributes
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
  const a0 = a;
  const parent = c.parentNode;
  // Row i's node, by its place among the parent's elements: rows are all elements, one each, so the
  // browser finds it without our walking the nodes before it.
  let base = 0;
  for (let n = c.previousSibling; n; n = n.previousSibling) if (n.nodeType === 1) base++;
  const kids = parent.children;
  const node = (i) => kids[base + i];
  // Writes a kept row's changed values in place. A row whose values have no fixed place gets its new
  // markup put into its nodes (rt.js), so what stays the same, an input's focus too, is kept.
  const keep = (r, o, i) => {
    if (r !== o)
      for (let k = 3; k < r.length; k++)
        if (r[k] !== o[k]) {
          const n = node(i);
          if (!parts) {
            into(d, parent, n, n.nextSibling, tpl(r));
            return 1;
          }
          put(n, parts[k - 3], r[k]);
        }
    return 1;
  };
  // Rows that stay where they were, at the start and at the end, are patched where they are. Two
  // rows that changed places, the first and the last of the rest, change places in the page too.
  let s = 0;
  let ea = a.length;
  let eb = b.length;
  for (;;) {
    while (s < ea && s < eb && a[s][0] === b[s][0] && keep(b[s], a[s], s)) s++;
    while (ea > s && eb > s && a[ea - 1][0] === b[eb - 1][0] && keep(b[eb - 1], a[ea - 1], ea - 1)) (ea--, eb--);
    if (!(ea - s > 1 && eb - s > 1 && a[s][0] === b[eb - 1][0] && a[ea - 1][0] === b[s][0])) break;
    const [x, y] = [node(s), node(ea - 1)];
    const after = y.nextSibling;
    parent.insertBefore(y, x);
    parent.insertBefore(x, after);
    if (a === a0) a = a.slice(); // the last run's list stays as it was
    [a[s], a[ea - 1]] = [a[ea - 1], a[s]];
  }
  if (s === ea && s === eb) return; // all the rows kept where they were
  const end = a.length ? node(a.length - 1).nextSibling : c.nextSibling;
  const stop = ea < a.length ? node(ea) : end;
  // Out with the rows between the ends (from the last, so the places of the others hold): all at
  // once when nothing at the ends was kept and the list is all its parent holds
  const drop = () => {
    if (!s && stop === end && !c.previousSibling && !end.nextSibling) {
      parent.textContent = '';
      parent.append(c, end);
    } else for (let i = ea; i-- > s; ) node(i).remove();
  };
  if (s === eb) return drop(); // rows taken out, and none added
  a = a.slice(s, ea);
  b = b.slice(s, eb);
  const at = new Map();
  for (let i = 0; i < a.length; i++) at.set(a[i][0], i);
  const nodes = [];
  const from = []; // each row's old position, or -1 for a new one
  const fresh = [];
  const kept = [];
  for (let i = 0; i < b.length; i++) {
    const j = at.get(b[i][0]);
    from[i] = -1;
    if (j === undefined || kept[j] || !keep(b[i], a[j], j + s)) fresh.push(i); // kept[j]: a key used twice
    else (nodes[i] = node(j + s)), (from[i] = j), (kept[j] = 1);
  }
  if (fresh.length === b.length) {
    // Nothing in the middle kept: out with the old rows, in with the new, in one go each
    drop();
    parent.insertBefore(make(d, b, tpl, parts), stop);
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
  for (let j = a.length; j--; ) kept[j] || node(j + s).remove(); // from the last, so the places of the others hold
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
