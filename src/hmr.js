// goal dev's live updates, in the page. After each build the dev server says what changed (see dev()
// in build.js). A stylesheet is swapped in place. For code, the page asks the server for itself again,
// sending the state each component has now, and puts the new body in place of the old one: the
// components keep their state, and the loader runs the new code on the next event. A compile error
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

  async function update() {
    const kept = {}; // by instance number: which component, and its state now
    for (const el of d.querySelectorAll('[m-c]'))
      kept[el.getAttribute('m-i')] = { c: el.getAttribute('m-c').split('?')[0], s: el.$s ?? JSON.parse(el.getAttribute('m-s') || '{}') };
    const header = JSON.stringify(kept);
    if (header.length > 8000) return w.location.reload(); // more than a request header should carry
    const res = await w.fetch(w.location.href, { headers: { 'x-goal-hmr': header } });
    const text = await res.text();
    if (!res.ok) return show(text); // the route failed: goal dev answers with the stack
    const next = new w.DOMParser().parseFromString(text, 'text/html');
    const now = events(d);
    if (events(next).some((e) => !now.includes(e))) return w.location.reload(); // the loader listens only for the events it started with
    for (const s of next.querySelectorAll('script')) s.remove(); // this page's loader and updates keep running
    const { scrollX: x, scrollY: y } = w;
    const focused = d.activeElement?.id;
    d.title = next.title;
    d.body.replaceWith(d.adoptNode(next.body));
    w.scrollTo(x, y);
    if (focused) d.getElementById(focused)?.focus();
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
