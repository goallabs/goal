// The goal.js loader: the only script a page runs at start, and it only adds listeners.
//
// When an event reaches an element with `m-on="click:0"`, the loader finds the component root
// around it (`m-c` = the URL of its client module), loads that module once, reads the state the
// server wrote (`m-s`) and the props (`m-p`), runs the handlers, saves the state they changed, runs
// the component again and patches the bindings whose value changed. The last run stays on the root
// element, so the next event starts from it: one run of the component per event.

/**
 * @param {Document} d
 * @param {string[]} events the event types the page's components handle
 * @param {(url: string) => Promise<any>} [load] how to load a client module
 */
export function boot(d, events, load = (u) => import(u)) {
  const mods = {};
  const get = (r, u = r.getAttribute('m-c')) => (mods[u] ||= load(u));
  const json = (r, a) => JSON.parse(r.getAttribute(a) || '{}');
  // Start loading on intent (pointer over, focus), so the code is there by the first click or key.
  const warm = (e) => {
    const r = e.target.closest?.('[m-c]');
    if (r) get(r);
  };
  for (const t of ['pointerover', 'focusin']) d.addEventListener(t, warm, true);
  // A run of the component from its state: [values, handlers, read the state, the state read].
  const run = (m, r) => {
    const x = m.default(r.$s, r.$p);
    x[3] = x[2]();
    return x;
  };
  const go = async (e) => {
    // The handlers on the way up, found before any runs (a handler may re-render the rest away).
    const todo = [];
    for (let el = e.target; el.getAttribute; el = el.parentNode)
      for (const pair of (el.getAttribute('m-on') || '').split(' ')) {
        const [type, h] = pair.split(':');
        if (type !== e.type) continue;
        if (type === 'submit') e.preventDefault(); // must happen now, before the module loads
        todo.push([el.closest('[m-c]'), h, el]);
      }
    for (const r of new Set(todo.map((x) => x[0]))) {
      const m = await get(r);
      r.$s ||= json(r, 'm-s');
      r.$p ||= json(r, 'm-p');
      const x = (r.$x ||= run(m, r));
      const save = () => {
        const now = x[2]();
        for (const k in now) if (now[k] !== x[3][k]) r.$s[k] = now[k]; // only what these handlers changed
        x[3] = now;
      };
      const update = () => {
        const y = run(m, r);
        patch(d, r, m, r.$x[0], y[0]);
        r.$x = y;
      };
      const outs = todo
        .filter((t) => t[0] === r)
        .map(([, h, el]) => (h[0] === 'r' ? m._$lh(el, r, x, h, e) : x[1][h](e))); // r: a keyed list row's handler (keyed.js)
      save();
      update();
      if (outs.some((o) => o?.then))
        try {
          await Promise.all(outs); // calls to server functions
        } finally {
          save();
          update();
        }
    }
  };
  for (const ev of events) d.addEventListener(ev, go, true);
}

/** Updates the bindings whose value changed between `a` and `b`. */
function patch(d, r, m, a, b) {
  const i = r.getAttribute('m-i');
  m._$k.forEach(([kind, n, name, parts], j) => {
    const v = b[j];
    if (v === a[j]) return;
    if (kind === 1) {
      const q = `[m-x="${i}.${n}"]`;
      const el = r.matches(q) ? r : r.querySelector(q);
      const off = v == null || v === false;
      if (name === 'value') el.value = off ? '' : v;
      else if (name === 'checked') el.checked = !off;
      else if (off) el.removeAttribute(name);
      else el.setAttribute(name, v === true ? '' : v);
      return;
    }
    // The hole's start marker, found once and kept on the root.
    let c = (r.$m ||= {})[n];
    if (!c) {
      const w = d.createTreeWalker(r, 128);
      while ((c = w.nextNode()) && c.data !== `${i}.${n}`);
      r.$m[n] = c;
    }
    if (kind) m._$lp(d, c, a[j], v, name, parts); // a keyed list (keyed.js)
    else m._$hm(d, c, v); // a hole's markup, into the nodes there (rt.js)
  });
}
