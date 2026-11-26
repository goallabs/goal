// call(): `var notes = call(listNotes(filter))` at the top of a component. The var is state:
// { value, loading, error }, with reload() and cancel() in the browser. A file of its own, so only the
// components that use call() load it: the bundler splits the browser code by file.
//
// On the server the call runs while the page renders: a component whose call hasn't answered yet
// renders as a placeholder, and once the route has its page, each one renders again with the answer
// (_$lr), so the page arrives with the data. In the browser the page keeps that answer, and a request
// goes out again only when the call's arguments change, or on reload(). Its answer reaches the
// component as a goal:set event on its root, which the loader handles like an event's handler.

import { _$sf } from './call.js';

/**
 * A call() on the server: its answer, or one on its way ({ p: true }). Calls with the same server
 * function and arguments share one answer per page. `kept` is the state a live update kept (goal dev),
 * used as it is when its arguments are the same. The answer goes through JSON, as it would to the
 * browser; a failure is reported (_$lr) and the page shows what the browser would have.
 */
export const _$lc = (c, fn, args, url, kept) => {
  const a = JSON.stringify(args);
  if (kept?.a === a && !kept.loading) return kept;
  const m = (c.lm ||= new Map());
  const id = url + a;
  if (!m.has(id)) {
    m.set(id, { p: true });
    (c.lp ||= []).push(
      (async () => fn(...args))()
        .then((v) => JSON.parse(JSON.stringify(v ?? null)))
        .then(
          (value) => ({ value, loading: false, error: null, a }),
          (e) => {
            (c.lx ||= []).push(e);
            return { loading: false, error: `server function ${url} failed: 500`, a };
          },
        )
        .then((x) => m.set(id, x)),
    );
  }
  return m.get(id);
};

/** Is any of these calls still on its way? */
export const _$lw = (...calls) => calls.some((x) => x.p);

/** A component to render once its calls answer: a placeholder in the page's HTML until then (_$lr). */
export const _$ll = (c, f, props) => `\u0000${(c.lt ||= Math.random().toString(36).slice(2))}:${(c.ll ||= []).push(() => f(props, c)) - 1}\u0000`;

/**
 * The page's HTML with each component that waited for a call rendered with its answer. One that
 * starts another call waits again, up to ten times: arguments that change on every render never settle.
 */
export async function _$lr(c, html) {
  for (let round = 0; c.ll?.length; round++) {
    if (round === 10) throw new Error('call() never settled: its arguments change each time the component renders');
    const todo = c.ll;
    c.ll = [];
    await Promise.all(c.lp.splice(0));
    const out = todo.map((f) => f());
    html = html.replace(new RegExp(`\u0000${c.lt}:(\\d+)\u0000`, 'g'), (_, i) => out[i]);
  }
  return html;
}

// In the browser: the requests this page made, by number: one on its way knows the instance (m-i)
// to answer to, which changes when a parent renders the component again; one that ended is null.
const live = {};
let n = 0;

/** New state for call() var `k` of instance `i`: the loader runs the component with it. */
const set = (i, k, v) => document.querySelector(`[m-i="${i}"]`)?.dispatchEvent(new CustomEvent('goal:set', { bubbles: true, detail: { [k]: v } }));

/** Stops the request of state `s`; its answer, if one comes, goes nowhere. */
const stop = (s) => {
  live[s.q]?.c.abort();
  live[s.q] = null;
};

/** Sends the request, and gives the state while it's on its way: the value so far stays. */
const go = (s, url, args, a, i, k) => {
  if (s?.loading) stop(s);
  const value = s?.value;
  const q = ++n;
  const me = (live[q] = { c: new AbortController(), i });
  const done = (x) => {
    if (live[q] !== me) return;
    live[q] = null;
    set(me.i, k, { value, loading: false, error: null, a, ...x });
  };
  _$sf(url, args, me.c.signal).then((value) => done({ value }), (e) => done({ error: e.message }));
  return { value, loading: true, error: null, a, q };
};

/**
 * A call() in the browser, each time the component runs: the state it has (`s`), unless its arguments
 * changed, it has none, or it was loading when the page came (a live update), and then a new request.
 * reload() sends the request again, and cancel() stops one on its way, keeping the value it had: both
 * change the state in place, so the run after the handler shows it, and tell the loader too.
 */
export const _$lb = (s, url, args, i, k) => {
  const a = JSON.stringify(args);
  if (!s || s.a !== a || (s.loading && !(s.q in live))) s = go(s, url, args, a, i, k);
  else if (live[s.q]) live[s.q].i = i;
  return Object.defineProperties(s, {
    reload: { value: () => set(i, k, Object.assign(s, go(s, url, args, a, i, k))), configurable: true },
    cancel: {
      value: () => {
        if (!live[s.q]) return;
        stop(s);
        set(i, k, Object.assign(s, { loading: false, q: undefined }));
      },
      configurable: true,
    },
  });
};
