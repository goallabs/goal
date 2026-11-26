// Helpers for rendering components: on the server for every page, and in the browser only where a
// component renders another inside a {...} hole or with props that change (a file's render module,
// see renderModule in compiler.js). A file of their own, so a page whose components don't do that
// doesn't load them: the bundler splits the browser code by file.

import { _$e } from './rt.js';

/** Writes only the props a component's browser code reads, so the rest never reaches the page. */
export const _$pa = (props, keys) => {
  if (!keys.length) return '';
  const o = {};
  for (const k of keys) if (Object.hasOwn(props, k)) o[k] = props[k];
  return ` m-p="${_$e(JSON.stringify(o))}"`;
};

/** A render: numbers component instances, collects the page's events, and holds the CSRF token. */
export const _$ctx = (t = '') => ({
  i: 0,
  t,
  ev: new Set(),
  e(list) {
    for (const x of list) this.ev.add(x);
  },
});

/**
 * The context of components rendered in the browser: inside a {...} hole, or with props that change.
 * Their instance numbers start where no server render reaches, their forms get the page's CSRF
 * token, and the loader starts listening for their events.
 */
export const _$B = {
  i: 1e6,
  s: null,
  c: {}, // this run's contexts, by hole and row: the components there share one, and take its states in turn
  /** The component running now: the loader sets it before each run, which starts with fresh contexts. */
  get r() {
    return this.s;
  },
  set r(v) {
    this.s = v;
    this.c = {};
  },
  /**
   * The context for the components rendered in hole `n` of the component running now, or in the
   * keyed row with the key path `keys` inside it. Each one keeps the state of the component in its
   * place, if it is the same (see keptState in compiler.js): the components there now, in order. A
   * keyed row is found by its key (m-k), so the components of a row that moved keep their own state.
   * One where there was none starts as written.
   */
  h(n, keys = []) {
    const id = JSON.stringify([n, ...keys]);
    if (this.c[id]) return this.c[id];
    const r = this.s;
    const d = r.ownerDocument;
    const w = d.createTreeWalker(r, 128);
    let c;
    while ((c = w.nextNode()) && c.data !== `${r.getAttribute('m-i')}.${n}`);
    const top = []; // the hole's elements
    for (let x = c.nextSibling; x.nodeType !== 8 || x.data !== '/'; x = x.nextSibling) if (x.nodeType === 1) top.push(x);
    // What matches `q` straight in `at`, the keyed row found so far (the hole itself when null): the
    // nearest keyed row `near` gives for it is `at` (none inside the hole)
    let at = null;
    const find = (q, near) =>
      (at ? [...at.querySelectorAll(q)] : top.flatMap((t) => [t, ...t.querySelectorAll(q)]).filter((y) => y.matches(q))).filter((y) => {
        const p = near(y);
        return at ? p === at : !p || !top.some((t) => t.contains(p));
      });
    for (const k of keys) if (!(at = find('[m-k]', (y) => y.parentElement.closest('[m-k]')).find((y) => y.getAttribute('m-k') === String(k)))) break; // a new row: its components start as written
    const q = keys.length && !at ? [] : find('[m-c]', (y) => y.closest('[m-k]'));
    const b = this;
    return (this.c[id] = {
      get i() {
        return b.i;
      },
      set i(v) {
        b.i = v;
      },
      t: d.querySelector('meta[name="goal-csrf"]').content, // a page with components that run has it
      e: (list) => d.dispatchEvent(new CustomEvent('goal:listen', { detail: list })),
      k: (chunk) => {
        const j = q.findIndex((x) => x.getAttribute('m-c').split('?')[0] === chunk);
        if (j < 0) return null;
        const [x] = q.splice(j, 1); // only that one: a component's children render before it, but come after it in the page
        return x.$s ?? JSON.parse(x.getAttribute('m-s')); // only a component with state asks
      },
    });
  },
};

/**
 * A function prop: handler `h` of the component instance `i` that gives it. It runs nothing where it
 * is made; the page gets {$h, $i}, and the loader turns that into a function that runs the handler
 * in that component, as an event would.
 */
export const _$f = (h, i) => Object.assign(() => {}, { toJSON: () => ({ $h: h, $i: i }) });
