// goal dev's live updates, in the page. After each build the dev server says what changed (see dev()
// in build.js). A stylesheet is swapped in place. For code, the page asks the server for itself again,
// sending the state each component has now, and puts the new body in place of the old one: the
// components keep their state, the focused element its focus and caret, and the loader runs the new
// code on the next event. A compile error
// shows over the page until a build works again. Only goal dev pages have this.

/** Listens for the dev server's updates. `connect` opens the stream; tests pass their own. */
export function hmr(d, w, connect = (url) => new w.EventSource(url)) {
  let box; // the compile error, over the page
  const show = (text) => {
    box?.remove();
    box = null;
    if (!text) return;
    box = d.createElement('pre');
    box.id = 'goal-dev-error';
    box.textContent = text;
    Object.assign(box.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      margin: '0',
      padding: '24px',
      overflow: 'auto',
      whiteSpace: 'pre-wrap',
      background: '#1b1b1f',
      color: '#ffb4ab',
      font: '14px/1.5 ui-monospace, Menlo, monospace',
    });
    d.body.append(box);
  };
  const events = (doc) => JSON.parse(doc.querySelector('meta[name="goal-events"]')?.content || '[]');
  const roots = () => [...d.querySelectorAll('[m-c]')];

  // Where the focused element is, to find it again in the new body: by its id, or by the way down to
  // it from its component's root (the nth in the page) or from the body, and its tag. Its caret too.
  function spot() {
    const el = d.activeElement;
    if (el === d.body) return null;
    const root = el.closest('[m-c]');
    const path = [];
    for (let n = el; n !== root && n !== d.body; n = n.parentElement) path.unshift([...n.parentElement.children].indexOf(n));
    return { el, root: roots().indexOf(root), path, caret: [el.selectionStart, el.selectionEnd, el.selectionDirection] };
  }
  function refocus(s) {
    let t = s.el.id ? d.getElementById(s.el.id) : s.root < 0 ? d.body : roots()[s.root];
    if (!s.el.id) for (const i of s.path) t = t?.children[i];
    if (t?.tagName !== s.el.tagName) return; // the code changed what's there
    t.focus({ preventScroll: true });
    if (s.caret[0] != null && t.selectionStart != null) t.setSelectionRange(...s.caret);
  }

  async function update() {
    const kept = []; // in the page's order: which component, and its state now
    for (const el of roots()) kept.push({ c: el.getAttribute('m-c').split('?')[0], s: el.$s ?? JSON.parse(el.getAttribute('m-s') || '{}') });
    const header = JSON.stringify(kept);
    if (header.length > 8000) return w.location.reload(); // more than a request header should carry
    const res = await w.fetch(w.location.href, { headers: { 'x-goal-hmr': header } });
    if (res.redirected) return w.location.reload(); // the page sends elsewhere now (signed out): go there, rather than show that page here
    const text = await res.text();
    if (!res.ok) return show(text); // the route failed: goal dev answers with the stack
    const next = new w.DOMParser().parseFromString(text, 'text/html');
    const now = events(d);
    if (events(next).some((e) => !now.includes(e))) return w.location.reload(); // the loader listens only for the events it started with
    for (const s of next.querySelectorAll('script')) s.remove(); // this page's loader and updates keep running
    const { scrollX: x, scrollY: y } = w;
    const focused = spot();
    d.title = next.title;
    // The stylesheets the new page links and this one doesn't, as when a first style block appears,
    // and the other way round. The rest stay, and load again when told (see below).
    const sheets = (doc) => new Map([...doc.querySelectorAll('link[rel="stylesheet"]')].map((l) => [l.getAttribute('href').split('?')[0], l]));
    const [had, has] = [sheets(d), sheets(next)];
    for (const [href, l] of had) if (!has.has(href)) l.remove();
    for (const [href, l] of has) if (!had.has(href)) d.head.append(d.adoptNode(l));
    d.body.replaceWith(d.adoptNode(next.body));
    d.dispatchEvent(new CustomEvent('goal:listen', { detail: [] })); // the loader runs the new body's onmounts, and the old one's cleanups
    w.scrollTo(x, y);
    if (focused) refocus(focused);
  }

  connect('/_goal/hmr').onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'error') return show(m.message);
    show(null);
    if (m.type === 'update') return update();
    for (const link of d.querySelectorAll('link[rel="stylesheet"]')) {
      const u = new URL(link.href);
      u.searchParams.set('v', m.version);
      link.href = u.href;
    }
  };
}
