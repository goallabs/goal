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
// Between /*+mount*/ and /*-mount*/ is the code for onmount, and between /*+w*/ and /*-w*/ the code
// for callbacks that change state: server.js leaves each out of the pages of an app that has none.
export function boot(d, events, load = (u) => import(u)) {
  const mods = {};
  /*+w*/ const got = {}; // the modules loaded: a callback's handler runs in the same task, so it can preventDefault
  /*-w*/
  const get = (r, u = r.getAttribute('m-c')) => (mods[u] ||= load(u)/*+w*/.then((m) => (got[u] = m))/*-w*/);
  const json = (r, a) => JSON.parse(r.getAttribute(a) || '{}');
  // Start loading on intent (pointer over, focus), so the code is there by the first click or key.
  const warm = (e) => {
    const r = e.target.closest?.('[m-c]');
    if (r) get(r);
  };
  for (const t of ['pointerover', 'focusin']) d.addEventListener(t, warm, true);
  // A run of the component from its state: [values, handlers, read the state, the state read].
  // When it renders components in the browser (m._$B, render.js), they look for theirs inside it.
  const run = (m, r) => {
    if (m._$B) m._$B.r = r;
    const x = m.default(r.$s, r.$p, r);
    x[3] = x[2]();
    return x;
  };
  const go = async (e) => {
    // The handlers on the way up, found before any runs (a handler may re-render the rest away).
    // A mount is the element's own: it doesn't go up.
    const todo = [];
    for (let el = e.target; el.getAttribute; el = /*+mount*/ e.type === 'mount' ? d : /*-mount*/ el.parentNode)
      for (const pair of (el.getAttribute('m-on') || '').split(' ')) {
        const [type, at] = pair.split(':');
        if (type !== e.type) continue;
        if (type === 'submit') e.preventDefault(); // must happen now, before the module loads
        const [h, owner] = at.split('@'); // a handler in children's markup names the component it belongs to
        todo.push([owner ? el.closest(`[m-i="${owner}"]`) : el.closest('[m-c]'), h, el]);
      }
    for (const r of new Set(todo.map((x) => x[0])))
      await act(
        r,
        todo
          .filter((t) => t[0] === r)
          .map(([, h, el]) => (m, x) => {
            const o = h[0] === 'r' ? m._$lh(el, r, x, h, e) : x[1][h](e); // r: a keyed list row's handler (keyed.js)
            /*+mount*/ if (e.type === 'mount' && o?.call) el.$u = o; // what to do when the element leaves the page
            /*-mount*/ return o;
          }),
      );
  };
  // Runs handlers of the component at root r (each call gets its module and run), saves the state
  // they changed and patches it, and again when the calls to server functions they made answer.
  // `set` is new state from a call() (load.js), put in after the run the page shows.
  const act = async (r, calls, set) => {
    const m = /*+w*/ got[r.getAttribute('m-c')] || /*-w*/ (await get(r));
    r.$s ||= json(r, 'm-s');
    r.$p ||= props(r);
    const x = (r.$x ||= run(m, r));
    Object.assign(r.$s, set);
    const save = () => {
      const now = x[2]();
      if (!r.$x) {
        // Its parent rendered it again while it waited (rt.js): start from what the page shows now.
        r.$s = json(r, 'm-s');
        r.$p = props(r);
        r.$x = run(m, r);
      }
      for (const k in now) if (now[k] !== x[3][k]) r.$s[k] = now[k]; // only what these handlers changed
      x[3] = now;
    };
    const update = () => {
      const y = run(m, r);
      patch(d, r, m, r.$x[0], y[0]);
      r.$x = y;
      /*+mount*/ scan(r); /*-mount*/
    };
    // While its handlers run, a callback they made that changes state (_$w in rt.js) runs at once,
    // and if it waits for a server function, so do they (x.w).
    /*+w*/ r.$a = x;
    try {
      /*-w*/ var outs = calls.map((f) => f(m, x)) /*+w*/.concat(x.w || []);
    } finally {
      r.$a = x.w = 0;
    } /*-w*/
    save();
    update();
    if (outs.some((o) => o?.then))
      try {
        await Promise.all(outs); // calls to server functions
      } finally {
        save();
        update();
      }
  };
  // A component's props. A function prop is written {$h, $i}: calling it runs handler $h of the
  // component that gave it, instance $i (see _$f in render.js).
  const props = (r) =>
    JSON.parse(r.getAttribute('m-p') || '{}', (k, v) => (v?.$h === undefined ? v : (...a) => act(d.querySelector(`[m-i="${v.$i}"]`), [(m, x) => (v.$r ? m._$lk(x, v.$r, v.$h, a) : x[1][v.$h](...a))])));
  // The page's events, and those of components rendered in the browser later (render.js).
  const on = new Set();
  const listen = (list) => {
    for (const ev of list)
      if (!on.has(ev)) {
        on.add(ev);
        d.addEventListener(ev, go, true);
      }
  };
  /*+mount*/
  // onmount: its handler runs once the element is in the page, at the start or when a patch puts it
  // there, and what it returns runs when the element leaves. A row that only moved is still in the
  // page after the patch.
  const live = new Set();
  const scan = (r) => {
    for (const el of live)
      if (!el.isConnected) {
        live.delete(el);
        el.$u?.();
      }
    for (const el of r.querySelectorAll('[m-on*="mount:"]'))
      if (!live.has(el)) {
        live.add(el);
        go({ type: 'mount', target: el });
      }
  };
  scan(d);
  d.addEventListener('goal:listen', () => scan(d)); // goal dev put a new body in
  /*-mount*/
  listen(events);
  d.addEventListener('goal:listen', (e) => listen(e.detail));
  d.addEventListener('goal:set', (e) => act(e.target, [], e.detail));
  /*+w*/
  // A callback that changes state, made by a handler, runs later (a timer, a listener on window): as
  // a handler of the component's run now, from its callbacks (x[4]), so it sees the state as it is.
  d.addEventListener('goal:w', (e) => {
    const [i, a, c] = e.detail;
    const r = e.target;
    const x = r.$a;
    if (!x) return (e.o = act(r, [(m, x) => x[4][i](...c)(...a)]));
    e.o = x[4][i](...c)(...a);
    if (e.o?.then) (x.w ||= []).push(e.o);
  });
  /*-w*/
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
