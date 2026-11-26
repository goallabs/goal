// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { boot } from '../src/loader.js';
import { _$ctx } from '../src/render.js';
import { _$lr, _$lc, _$lw, _$ll, _$lb } from '../src/load.js';
import { build, load } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

/** Renders on the server, calls answered, into a fresh document (the page's), and boots the loader. */
async function mount(src, name, props = {}) {
  const t = await load(src);
  const ctx = _$ctx('tok');
  const html = await _$lr(ctx, t.server[name](props, ctx));
  const d = document.implementation.createHTMLDocument('t');
  vi.stubGlobal('document', d);
  d.head.innerHTML = '<meta name="goal-csrf" content="tok">';
  d.body.innerHTML = html;
  boot(d, [...ctx.ev], (u) => t.loadChunk(u));
  const $ = (q) => d.querySelector(q);
  const fire = (q, type, props = {}) => {
    const el = $(q);
    Object.assign(el, props);
    el.dispatchEvent(new Event(type, { bubbles: true }));
  };
  return { d, $, fire, html, ctx };
}

/** fetch, answered by hand: each request waits until answer(i, value) or fail(i, status). */
function server() {
  const reqs = [];
  const fetch = vi.fn((url, o) => new Promise((ok, no) => {
    reqs.push({ url, args: JSON.parse(o.body), ok, no });
    o.signal?.addEventListener('abort', () => no(new DOMException('aborted', 'AbortError')));
  }));
  vi.stubGlobal('fetch', fetch);
  return {
    fetch,
    reqs,
    answer: (i, v) => reqs[i].ok({ ok: true, json: async () => ({ v }) }),
    fail: (i, status) => reqs[i].ok({ ok: false, status }),
  };
}

const NOTES = `
let calls = 0;
server function listNotes(q) { calls++; return ['note ' + q]; }
export server function count() { return calls; }
export function Notes({ start }) {
  var q = start;
  var notes = call(listNotes(q));
  return <div>
    <input value={q} oninput={(e) => q = e.target.value} />
    <p class={notes.loading ? 'loading' : 'done'}>{notes.error ?? (notes.value ?? []).join(',')}</p>
    <button id="reload" onclick={notes.reload}>reload</button>
    <button id="cancel" onclick={notes.cancel}>cancel</button>
    <button id="set" onclick={() => (notes.value = ['set by hand'])}>set</button>
  </div>;
}`;

describe('call() on the server', () => {
  it('renders with the answer, written into the state the browser resumes from', async () => {
    const { $, html } = await mount(NOTES, 'Notes', { start: 'a' });
    expect($('p').textContent).toBe('note a');
    expect($('p').className).toBe('done');
    expect(JSON.parse($('div').getAttribute('m-s')).notes).toEqual({ value: ['note a'], loading: false, error: null, a: '["a"]' });
    expect(html).not.toContain('\u0000');
  });

  it('runs a call once for each page, however many components make it', async () => {
    const t = await load(`${NOTES}
      export function Two() { return <section><Notes start="a" /><Notes start="a" /><Notes start="b" /></section>; }`);
    const ctx = _$ctx();
    const html = await _$lr(ctx, t.server.Two({}, ctx));
    expect(html.match(/>note a</g)).toHaveLength(2);
    expect(html).toContain('note b');
    expect(await t.server.count()).toBe(2);
  });

  it('starts calls together, and one that reads another waits for it', async () => {
    const order = [];
    globalThis.__order = order;
    const t = await load(`
      server function user(id) { globalThis.__order.push('user ' + id); return { id, team: 't' + id }; }
      server function other() { globalThis.__order.push('other'); return 1; }
      server function team(name) { globalThis.__order.push('team ' + name); return name.toUpperCase(); }
      export function P({ id }) {
        var u = call(user(id));
        var o = call(other());
        var tm = call(team(u.value.team));
        return <p onclick={() => {}}>{u.value.id} {o.value} {tm.value}</p>;
      }`);
    const ctx = _$ctx();
    expect((await _$lr(ctx, t.server.P({ id: 7 }, ctx))).replace(/<!--.*?-->/g, '')).toContain('>7 1 T7<');
    expect(order).toEqual(['user 7', 'other', 'team t7']);
    delete globalThis.__order;
  });

  it('shows a failed call as the browser would, and reports it', async () => {
    const t = await load(`
      server function boom() { throw new Error('secret detail'); }
      export function P() { var x = call(boom()); return <p onclick={() => {}}>{x.error}</p>; }`);
    const ctx = _$ctx();
    const html = await _$lr(ctx, t.server.P({}, ctx));
    expect(html).toContain('server function /_m/App/boom failed: 500');
    expect(html).not.toContain('secret');
    expect(ctx.lx[0].message).toBe('secret detail');
  });

  it('gives up on a call whose arguments change on every render', async () => {
    const t = await load(`
      server function f(x) { return x; }
      export function P() { var x = call(f(Math.random())); return <p onclick={() => {}}>{x.value}</p>; }`);
    const ctx = _$ctx();
    await expect(_$lr(ctx, t.server.P({}, ctx))).rejects.toThrow('call() never settled');
  });

  it('leaves a page without calls alone, and a call answered in a value JSON keeps', async () => {
    expect(await _$lr(_$ctx(), '<p>x</p>')).toBe('<p>x</p>');
    const c = _$ctx();
    const x = _$lc(c, () => new Date(0), [], '/u');
    _$lc(c, () => {}, [], '/nothing');
    expect(_$lw(x)).toBe(true);
    expect(_$ll(c, () => 'later', {})).toMatch(/^\u0000\w+:0\u0000$/);
    await _$lr(c, '');
    expect(_$lc(c, null, [], '/u').value).toBe('1970-01-01T00:00:00.000Z');
    expect(_$lc(c, null, [], '/nothing').value).toBe(null); // as the browser gets it
  });

  it('keeps the answer a live update kept (goal dev), while its arguments are the same', async () => {
    const r = build(NOTES, 'App.goal', { dev: true });
    expect(r.server).toContain('_$lc(_$c, listNotes, [q], "/_m/App/listNotes", _$o && _$o.notes)');
    const kept = { value: ['kept'], loading: false, error: null, a: '["a"]' };
    expect(_$lc(_$ctx(), null, ['a'], '/u', kept)).toBe(kept);
    expect(_$lc(_$ctx(), () => 1, ['b'], '/u', kept).p).toBe(true);
    expect(_$lc(_$ctx(), () => 1, ['a'], '/u', { ...kept, loading: true }).p).toBe(true);
  });
});

describe('call() in the browser', () => {
  it("doesn't call again on resume, and calls when the arguments change", async () => {
    const { $, fire } = await mount(NOTES, 'Notes', { start: 'a' });
    const s = server();
    fire('#reload', 'pointerover'); // nothing runs until an event
    fire('input', 'input', { value: 'b' });
    await vi.waitFor(() => expect($('p').className).toBe('loading'));
    expect($('p').textContent).toBe('note a'); // the value so far stays while it loads
    expect(s.reqs.map((r) => [r.url, r.args])).toEqual([['/_m/App/listNotes', ['b']]]);
    expect(s.fetch.mock.calls[0][1].headers['x-csrf-token']).toBe('tok');
    s.answer(0, ['note b']);
    await vi.waitFor(() => expect($('p').className).toBe('done'));
    expect($('p').textContent).toBe('note b');
    fire('input', 'input', { value: 'b' }); // the same arguments: no request
    await new Promise((r) => setTimeout(r, 10));
    expect(s.reqs).toHaveLength(1);
  });

  it('takes a value a handler sets, without a request', async () => {
    const { $, fire } = await mount(NOTES, 'Notes', { start: 'a' });
    const s = server();
    fire('#set', 'click');
    await vi.waitFor(() => expect($('p').textContent).toBe('set by hand'));
    fire('#set', 'click');
    await new Promise((r) => setTimeout(r, 10));
    expect(s.reqs).toHaveLength(0);
  });

  it('drops an answer that a newer request replaced', async () => {
    const { $, fire } = await mount(NOTES, 'Notes', { start: 'a' });
    const s = server();
    fire('input', 'input', { value: 'b' });
    await vi.waitFor(() => expect(s.reqs).toHaveLength(1));
    fire('input', 'input', { value: 'bc' });
    await vi.waitFor(() => expect(s.reqs).toHaveLength(2));
    s.answer(1, ['note bc']);
    await vi.waitFor(() => expect($('p').textContent).toBe('note bc'));
    s.answer(0, ['note b']); // too late: it was stopped
    await new Promise((r) => setTimeout(r, 10));
    expect($('p').textContent).toBe('note bc');
  });

  it('calls again on reload(), and cancel() stops a call, keeping the value', async () => {
    const { $, fire } = await mount(NOTES, 'Notes', { start: 'a' });
    const s = server();
    fire('#cancel', 'click'); // nothing on its way
    fire('#reload', 'click');
    await vi.waitFor(() => expect($('p').className).toBe('loading'));
    expect(s.reqs[0].args).toEqual(['a']);
    s.answer(0, ['fresh a']);
    await vi.waitFor(() => expect($('p').textContent).toBe('fresh a'));
    fire('#reload', 'click');
    await vi.waitFor(() => expect($('p').className).toBe('loading'));
    fire('#reload', 'click'); // again while one is on its way: the first is stopped
    await vi.waitFor(() => expect(s.reqs).toHaveLength(3));
    fire('#cancel', 'click');
    await vi.waitFor(() => expect($('p').className).toBe('done'));
    expect($('p').textContent).toBe('fresh a');
    s.answer(2, ['late']);
    await new Promise((r) => setTimeout(r, 10));
    expect($('p').textContent).toBe('fresh a');
    fire('input', 'input', { value: 'a' }); // cancelled with the same arguments: it doesn't start again
    await new Promise((r) => setTimeout(r, 10));
    expect(s.reqs).toHaveLength(3);
  });

  it('shows a failed call, keeping the value it had', async () => {
    const { $, fire } = await mount(NOTES, 'Notes', { start: 'a' });
    const s = server();
    fire('#reload', 'click');
    await vi.waitFor(() => expect(s.reqs).toHaveLength(1));
    s.fail(0, 500);
    await vi.waitFor(() => expect($('p').textContent).toBe('server function /_m/App/listNotes failed: 500'));
    expect(JSON.parse(JSON.stringify(document.querySelector('div').$s.notes)).value).toEqual(['note a']);
  });

  it('calls for a component rendered in the browser, and answers it after its parent renders it again', async () => {
    const { $, fire, d } = await mount(
      `${NOTES}
      export function Page() {
        var open = false;
        var n = 0;
        return <main><button id="open" onclick={() => open = true}>open</button><button id="n" onclick={() => n++}>{n}</button>
          {if (open) <section><Notes start={'x' + n} /></section>}</main>;
      }`,
      'Page',
    );
    const s = server();
    fire('#open', 'click');
    await vi.waitFor(() => expect($('p')?.className).toBe('loading'));
    expect(s.reqs[0].args).toEqual(['x0']);
    fire('#open', 'click'); // its parent renders it again, as a new instance: the request goes on
    await vi.waitFor(() => expect(d.querySelectorAll('[m-i]').length).toBe(2));
    s.answer(0, ['note x0']);
    await vi.waitFor(() => expect($('p').textContent).toBe('note x0'));
    expect(s.reqs).toHaveLength(1);
  });

  it('starts again a call left loading with nothing on its way', () => {
    server();
    const s = _$lb({ value: 1, loading: true, error: null, a: '[]', q: 999 }, '/u', [], '1', 'x');
    expect(s.q).not.toBe(999);
    expect(s.value).toBe(1);
    expect(Object.keys(s)).toEqual(['value', 'loading', 'error', 'a', 'q']); // reload and cancel aren't state
  });
});

describe('call() rules', () => {
  const err = (src) => {
    try {
      build(src);
    } catch (e) {
      return e.message;
    }
    return 'compiled';
  };
  const SF = 'server function f(x) { return x; }\n';

  it('goes at the top of a component, as a var', () => {
    expect(err(`${SF}export function A() { const x = call(f(1)); return <p>{x.value}</p>; }`)).toMatch('call() goes at the top of a component, as state');
    expect(err(`${SF}export function A() { return <p onclick={() => call(f(1))}>a</p>; }`)).toMatch('call() goes at the top of a component');
    expect(err(`${SF}route GET / { var x = call(f(1)); return <p>a</p>; }`)).toMatch('call() goes at the top of a component');
    expect(err(`${SF}export function A() { if (1) { var x = call(f(1)); } return <p>a</p>; }`)).toMatch('call() goes at the top of a component');
  });

  it('takes a call to a server function', () => {
    expect(err(`${SF}export function A() { var x = call(Math.max(1)); return <p>{x}</p>; }`)).toMatch('call() takes a call to a server function');
    expect(err(`${SF}export function A() { var x = call(f); return <p>{x}</p>; }`)).toMatch('call() takes a call to a server function');
    expect(err(`${SF}export function A() { var x = call(f(1), 2); return <p>{x}</p>; }`)).toMatch('call() takes a call to a server function');
    expect(err(`${SF}export function A() { var x = call(); return <p>{x}</p>; }`)).toMatch('call() takes a call to a server function');
    expect(err(`${SF}export function A() { const f = (x) => x; var x = call(f(1)); return <p>{x}</p>; }`)).toMatch('call() takes a call to a server function');
  });

  it("isn't changed by assignment", () => {
    expect(err(`${SF}export function A() { var x = call(f(1)); return <p onclick={() => (x = 2)}>{x.value}</p>; }`)).toMatch('`x` holds a call(): run it again with x.reload(), or set x.value');
  });

  it('is a plain function where the file names one call', () => {
    expect(err(`import { call } from './x.js';\nexport function A() { var x = call(1); return <p onclick={() => x++}>{x}</p>; }`)).toBe('compiled');
  });

  it('is typed in a #strict file: the answer, or undefined before it', () => {
    const strict = (body) => err(`#strict\nserver function f(x: string): string[] { return [x]; }\nexport function A() { var n = call(f('a')); ${body} }`);
    expect(strict(`return <p onclick={n.reload}>{n.loading ? 'l' : ''}{n.error ?? ''}{(n.value ?? []).join(',')}</p>;`)).toBe('compiled');
    expect(strict(`const k: number = n.loading; return <p onclick={n.cancel}>{k}</p>;`)).toMatch('k is number, not boolean');
    expect(strict(`const k: string[] = n.value; return <p onclick={n.cancel}>{k}</p>;`)).toMatch('not string[] | undefined');
  });

  it('calls server functions another .goal file exports', () => {
    const r = build(`import { list } from './data.goal';\nexport function A() { var x = call(list(1)); return <p onclick={x.reload}>{x.value}</p>; }`, 'App.goal', {
      serverFunctions: () => ({ base: 'data', names: ['list'] }),
    });
    expect(r.server).toContain('_$lc(_$c, list, [1], "/_m/data/list")');
    expect(r.clients[0].code).toContain('_$lb(_$s.x, "/_m/data/list", [1], _$r.getAttribute("m-i"), "x")');
    expect(r.clients[0].code).not.toContain('data.goal');
  });
});
