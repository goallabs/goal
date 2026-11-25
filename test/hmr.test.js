// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { hmr } from '../src/hmr.js';

/** A page with the live updates running, a fake dev server stream, and the page the server answers next. */
function setup(body, { head = '' } = {}) {
  document.head.innerHTML = head;
  document.body.innerHTML = body;
  let stream;
  const next = { ok: true, html: '' };
  const sent = [];
  const w = {
    location: { href: 'http://localhost/page', reload: vi.fn() },
    scrollX: 3,
    scrollY: 40,
    scrollTo: vi.fn(),
    DOMParser: window.DOMParser,
    fetch: vi.fn(async (url, opts) => {
      sent.push({ url, kept: JSON.parse(opts.headers['x-goal-hmr']) });
      return { ok: next.ok, text: async () => next.html };
    }),
  };
  hmr(document, w, (url) => (stream = { url }));
  const send = (m) => stream.onmessage({ data: JSON.stringify(m) });
  return { w, send, next, sent, stream: () => stream };
}

const EVENTS = (list) => `<meta name="goal-events" content='${JSON.stringify(list)}'>`;

describe('live updates in goal dev', () => {
  it('listen at /_goal/hmr, with EventSource unless told otherwise', () => {
    expect(setup('').stream().url).toBe('/_goal/hmr');
    const opened = [];
    hmr(document, { EventSource: class { constructor(url) { opened.push(url); } } });
    expect(opened).toEqual(['/_goal/hmr']);
  });

  it('show a compile error over the page, and take it away when a build works', () => {
    const { send } = setup('<p>page</p>');
    send({ type: 'error', message: 'A.goal:1:16: a component ends with `return <element>`' });
    expect(document.getElementById('goal-dev-error').textContent).toBe('A.goal:1:16: a component ends with `return <element>`');
    send({ type: 'error', message: 'B.goal:2:1: second' });
    expect([...document.querySelectorAll('#goal-dev-error')].map((e) => e.textContent)).toEqual(['B.goal:2:1: second']);
    send({ type: 'css', version: 'v2' });
    expect(document.getElementById('goal-dev-error')).toBe(null);
  });

  it('swap the stylesheets in place when only CSS changed', () => {
    const { send, w } = setup('<p>page</p>', { head: '<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/x.css?a=1">' });
    send({ type: 'css', version: 'v2' });
    expect([...document.querySelectorAll('link')].map((l) => new URL(l.href).search)).toEqual(['?v=v2', '?a=1&v=v2']);
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it("render the page again with each component's state, keeping the scroll and the focus", async () => {
    const { send, next, sent, w } = setup(
      `<div m-c="/c/A.A.js?v=1" m-i="0" m-s='{"n":1}'><input id="t"></div><p m-c="/c/B.B.js?v=1" m-i="1">b</p>${EVENTS(['click'])}`,
    );
    document.querySelector('[m-i="0"]').$s = { n: 5 }; // a resumed component: its state now
    document.getElementById('t').focus();
    next.html = `<!doctype html><html><head><title>New</title></head><body><div m-c="/c/A.A.js?v=2" m-i="0"><input id="t" value="x"></div>${EVENTS(['click'])}<script>window.ran = 1</script></body></html>`;
    send({ type: 'update', version: 'v2' });
    await vi.waitFor(() => expect(document.getElementById('t').value).toBe('x'));
    expect(sent).toEqual([{ url: 'http://localhost/page', kept: [{ c: '/c/A.A.js', s: { n: 5 } }, { c: '/c/B.B.js', s: {} }] }]);
    expect(document.querySelector('[m-c]').getAttribute('m-c')).toBe('/c/A.A.js?v=2');
    expect(document.querySelector('script')).toBe(null); // the new page's scripts don't run again
    expect(document.title).toBe('New');
    expect(w.scrollTo).toHaveBeenCalledWith(3, 40);
    expect(document.activeElement.id).toBe('t');
  });

  it('swap a page with no focus, or whose focused element is gone, and one with no event list', async () => {
    const { send, next } = setup('<button id="b">b</button>');
    next.html = '<body><p id="one">one</p></body>';
    send({ type: 'update', version: 'v2' });
    await vi.waitFor(() => expect(document.getElementById('one')).not.toBe(null));
    document.body.innerHTML = '<button id="b">b</button>';
    document.getElementById('b').focus();
    next.html = '<body><p id="two">two</p></body>';
    send({ type: 'update', version: 'v3' });
    await vi.waitFor(() => expect(document.getElementById('two')).not.toBe(null));
  });

  it('reload when the new page listens for more events, or the state is too big to send', async () => {
    const one = setup(`<b m-c="/c/A.A.js" m-i="0" m-s='{}'>a</b>${EVENTS(['click'])}`);
    one.next.html = `<body>${EVENTS(['click', 'input'])}</body>`;
    one.send({ type: 'update', version: 'v2' });
    await vi.waitFor(() => expect(one.w.location.reload).toHaveBeenCalled());
    expect(document.querySelector('b').textContent).toBe('a');

    const two = setup(`<b m-c="/c/A.A.js" m-i="0" m-s='${JSON.stringify({ big: 'x'.repeat(9000) })}'>a</b>`);
    two.send({ type: 'update', version: 'v2' });
    await vi.waitFor(() => expect(two.w.location.reload).toHaveBeenCalled());
    expect(two.w.fetch).not.toHaveBeenCalled();
  });

  it("show the route's error when rendering the page again fails", async () => {
    const { send, next } = setup('<p>page</p>');
    Object.assign(next, { ok: false, html: 'Error: boom\n    at route' });
    send({ type: 'update', version: 'v2' });
    await vi.waitFor(() => expect(document.getElementById('goal-dev-error').textContent).toBe('Error: boom\n    at route'));
    expect(document.querySelector('p').textContent).toBe('page');
  });
});
