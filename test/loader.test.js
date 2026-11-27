// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { boot } from '../src/loader.js';
import { render } from '../src/server.js';
import { load } from './helpers.js';

/** Server-renders a component into a fresh document and boots the loader on it. */
async function mount(src, name, props, { defaultLoad = false, more = [] } = {}) {
  const t = await load(src);
  const { html, events: own } = render(t.server[name], props);
  const events = [...own, ...more]; // more: as a page whose app has onmount somewhere (server.js)
  const d = document.implementation.createHTMLDocument('t');
  d.head.innerHTML = '<meta name="goal-csrf" content="tok">';
  d.body.innerHTML = html;
  const loads = [];
  if (defaultLoad) {
    for (const el of d.querySelectorAll('[m-c]')) el.setAttribute('m-c', t.chunks[el.getAttribute('m-c')]);
    boot(d, events);
  } else
    boot(d, events, (u) => {
      loads.push(u);
      return t.loadChunk(u);
    });
  const $ = (q) => d.querySelector(q);
  const fire = (q, type, init = {}) => {
    const el = typeof q === 'string' ? $(q) : q;
    const e = new (d.defaultView?.Event ?? Event)(type, { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(e);
    return e;
  };
  return { d, $, fire, loads, html };
}

const COUNTER = `
export function Counter({ start = 0 }) {
  var count = start;
  const double = count * 2;
  let label;
  if (count >= 3) label = 'big';
  else label = 'small';
  return (
    <div class={count % 2 ? 'odd' : 'even'}>
      <button id="dec" onclick={() => count--}>-</button>
      <strong>{count}</strong>
      <button id="inc" onclick={() => count++}>+</button>
      <p>{double} {label}</p>
    </div>
  );
}
export function Two() {
  return <section><Counter /><Counter start={5} /></section>;
}`;

describe('resuming', () => {
  it('runs nothing until an event, then loads the chunk once and patches what changed', async () => {
    const { $, fire, loads } = await mount(COUNTER, 'Counter', {});
    expect(loads).toEqual([]);
    fire('#inc', 'click');
    await vi.waitFor(() => expect($('strong').textContent).toBe('1'));
    expect($('p').textContent).toBe('2 small');
    expect($('div').getAttribute('class')).toBe('odd');
    fire('#inc', 'click');
    fire('#inc', 'click');
    await vi.waitFor(() => expect($('strong').textContent).toBe('3'));
    expect($('p').textContent).toBe('6 big');
    fire('#dec', 'click');
    await vi.waitFor(() => expect($('strong').textContent).toBe('2'));
    expect(loads).toEqual(['/c/Counter.js']);
  });

  it('keeps each instance separate', async () => {
    const { d, fire } = await mount(COUNTER, 'Two', {});
    const [, second] = d.querySelectorAll('div');
    fire(second.querySelector('#inc'), 'click');
    await vi.waitFor(() => expect(second.querySelector('strong').textContent).toBe('6'));
    expect(d.querySelector('strong').textContent).toBe('0');
  });

  it('loads with import() by default', async () => {
    const { $, fire } = await mount(COUNTER, 'Counter', { start: 1 }, { defaultLoad: true });
    fire('#inc', 'click');
    await vi.waitFor(() => expect($('strong').textContent).toBe('2'));
  });

  it('starts loading on intent, and ignores intent outside components', async () => {
    const { d, $, fire, loads } = await mount(COUNTER, 'Counter', {});
    const outside = d.createElement('span');
    d.body.append(outside);
    fire(outside, 'pointerover');
    d.dispatchEvent(new Event('focusin'));
    expect(loads).toEqual([]);
    fire('#inc', 'pointerover');
    expect(loads).toEqual(['/c/Counter.js']);
    fire('#inc', 'focusin');
    expect(loads).toEqual(['/c/Counter.js']);
    fire('#inc', 'click');
    await vi.waitFor(() => expect($('strong').textContent).toBe('1'));
    expect(loads).toEqual(['/c/Counter.js']);
  });

  it('ignores events with no handler on the way up', async () => {
    const { $, fire, loads } = await mount(COUNTER, 'Counter', {});
    fire('strong', 'click');
    await new Promise((r) => setTimeout(r, 10));
    expect(loads).toEqual([]);
    expect($('strong').textContent).toBe('0');
  });
});

describe('patching', () => {
  const FORM = `
  export function Todo() {
    var items = [];
    var text = '';
    var on = false;
    const left = items.length;
    return (
      <form onsubmit={() => { items = [...items, text]; text = ''; }}>
        <input id="t" value={text} oninput={(e) => (text = e.target.value)} onchange={() => (on = true)} />
        <input id="c" type="checkbox" checked={on} onclick={() => (on = !on)} />
        <input id="o" value={on && 'yes'} title={on ? 'on' : null} />
        <button id="clear" type="button" onclick={() => (items = [])} disabled={left === 0}>Clear</button>
        <p>{left} {on ? <b>on</b> : 'off'}</p>
        <ul>{items.map((t) => <li>{t}</li>)}</ul>
      </form>
    );
  }`;

  it('updates values, checkboxes, attributes and lists', async () => {
    const { $, fire } = await mount(FORM, 'Todo');
    expect($('#clear').hasAttribute('disabled')).toBe(true);
    $('#t').value = 'milk <b>';
    fire('#t', 'input');
    await vi.waitFor(() => expect($('#t').value).toBe('milk <b>'));
    const submit = fire('form', 'submit');
    expect(submit.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect($('ul').innerHTML).toBe('<!--0.7--><li>milk &lt;b&gt;</li><!--/-->')); // no keys: the list is made again as a whole
    expect($('#t').value).toBe('');
    expect($('#clear').getAttribute('disabled')).toBe(null);
    expect($('p').textContent).toBe('1 off');

    fire('#c', 'click');
    await vi.waitFor(() => expect($('#c').checked).toBe(true));
    expect($('#o').value).toBe('yes');
    expect($('#o').getAttribute('title')).toBe('on');
    expect($('p').innerHTML).toContain('<b>on</b>');

    fire('#c', 'click');
    await vi.waitFor(() => expect($('#c').checked).toBe(false));
    expect($('#o').value).toBe('');
    expect($('#o').hasAttribute('title')).toBe(false);

    fire('#t', 'change');
    await vi.waitFor(() => expect($('#c').checked).toBe(true));

    fire('#clear', 'click');
    await vi.waitFor(() => expect($('ul').innerHTML).toBe('<!--0.7--><!--/-->'));
    expect($('#clear').getAttribute('disabled')).toBe('');
  });

  it('blocks unsafe URLs when patching too', async () => {
    const { $, fire } = await mount(
      `export function A() { var to = '/a'; return <div><a href={to}>x</a><button onclick={() => (to = 'javascript:alert(1)')}>b</button></div>; }`,
      'A',
    );
    expect($('a').getAttribute('href')).toBe('/a');
    fire('button', 'click');
    await vi.waitFor(() => expect($('a').getAttribute('href')).toBe('about:invalid#blocked'));
  });

  it('handles a value that becomes null', async () => {
    const { $, fire } = await mount(
      `export function A() { var v = 'x'; return <div><input value={v} /><button onclick={() => (v = null)}>x</button></div>; }`,
      'A',
    );
    expect($('input').getAttribute('value')).toBe('x');
    fire('button', 'click');
    await vi.waitFor(() => expect($('input').value).toBe(''));
  });

  it('survives a handler whose element is re-rendered away', async () => {
    const { $, fire } = await mount(
      `export function A() {
        var open = true;
        return <div onclick={() => {}}>{open && <button onclick={() => (open = false)}>close</button>}</div>;
      }`,
      'A',
    );
    fire('button', 'click');
    await vi.waitFor(() => expect($('button')).toBe(null));
  });

  it('calls server functions, shows the state before they answer, and works without state or props', async () => {
    let answer;
    const fetch = vi.fn(() => new Promise((ok) => (answer = ok)));
    vi.stubGlobal('fetch', fetch);
    const { $, fire } = await mount(
      `server function save(v) { return v; }
      export function A() {
        var msg = 'idle';
        var count = 0;
        return <p onclick={() => { msg = 'saving'; msg = save('done'); }} ondblclick={() => count++}>{msg}{count}</p>;
      }
      export function B() {
        return <p onclick={() => {}}>static</p>;
      }
      export function Both() { return <div><A /><B /></div>; }`,
      'Both',
    );
    fire('p', 'click');
    await vi.waitFor(() => expect($('p').textContent).toBe('saving0'));
    fire('p', 'dblclick'); // another handler runs while the server works
    await vi.waitFor(() => expect($('p').textContent).toBe('saving1'));
    expect(fetch).toHaveBeenCalledWith('/_m/App/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': '' },
      body: '["done"]',
    });
    answer({ ok: true, json: async () => ({ v: 'done' }) });
    await vi.waitFor(() => expect($('p').textContent).toBe('done1')); // the server's answer, and the other handler's change kept
    const b = $('p + p');
    fire(b, 'click');
    await new Promise((r) => setTimeout(r, 10));
    expect(b.textContent).toBe('static');
    vi.unstubAllGlobals();
  });

  it('runs the handlers of list items', async () => {
    const { d, $, fire } = await mount(
      `export function L() {
        var items = ['a', 'b', 'c'];
        var picked = '-';
        return <div><ul>{items.map((x) => <li key={x} onclick={() => (picked = x)}><button onclick={() => (items = items.filter((y) => y !== x))}>x</button>{x}</li>)}</ul><p>{picked}</p></div>;
      }`,
      'L',
    );
    fire(d.querySelectorAll('li')[1], 'click');
    await vi.waitFor(() => expect($('p').textContent).toBe('b'));
    fire(d.querySelectorAll('li button')[0], 'click');
    await vi.waitFor(() => expect([...d.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['xb', 'xc']));
    expect($('p').textContent).toBe('a'); // the click bubbled to the li of a too, which ran with the same render
    fire(d.querySelectorAll('li')[1], 'click');
    await vi.waitFor(() => expect($('p').textContent).toBe('c'));
  });

  it('patches a keyed list in an {if} by key, and shows the else branch while it is off', async () => {
    const { d, $, fire } = await mount(
      `export function F() {
        var items = [{ id: 1, t: 'a' }];
        var on = true;
        return (
          <div>
            <button id="on" onclick={() => (on = !on)}>on</button>
            <button id="add" onclick={() => (items = [...items, { id: items.length + 1, t: 'n' }])}>add</button>
            <ul>{if (on) items.map((x) => <li key={x.id} onclick={() => (items = items.filter((y) => y !== x))}>{x.t}</li>) else <li id="none">none</li>}</ul>
          </div>
        );
      }`,
      'F',
    );
    const texts = () => [...d.querySelectorAll('li')].map((l) => l.textContent);
    const first = $('li');
    fire('#add', 'click');
    await vi.waitFor(() => expect(texts()).toEqual(['a', 'n']));
    expect($('li')).toBe(first); // the row that stayed was kept, not made again
    fire('#on', 'click');
    await vi.waitFor(() => expect(texts()).toEqual(['none']));
    fire('#add', 'click'); // while off, the rows don't show
    await vi.waitFor(() => expect($('#none')).not.toBe(null));
    expect(texts()).toEqual(['none']);
    fire('#on', 'click');
    await vi.waitFor(() => expect(texts()).toEqual(['a', 'n', 'n']));
    fire(d.querySelectorAll('li')[1], 'click'); // a row's own handler, after the list came back
    await vi.waitFor(() => expect(texts()).toEqual(['a', 'n']));
  });
});

describe('server function calls', () => {
  it('send the arguments and the page token, and return the value', async () => {
    const { _$sf } = await import('../src/call.js');
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ v: 42 }) }));
    vi.stubGlobal('fetch', fetch);
    document.head.innerHTML = '<meta name="goal-csrf" content="tok">';
    expect(await _$sf('/_m/a/b', [1, 'x'])).toBe(42);
    expect(fetch.mock.calls[0][1].headers['x-csrf-token']).toBe('tok');
    fetch.mockImplementation(async () => ({ ok: false, status: 403 }));
    await expect(_$sf('/_m/a/b', [])).rejects.toThrow('server function /_m/a/b failed: 403');
    expect(fetch.mock.calls[0][0]).toBe('/_m/a/b');
    // With tenants by path, the page names its tenant's path, which goes in front
    document.head.innerHTML = '<meta name="goal-csrf" content="tok"><meta name="goal-base" content="/acme">';
    await expect(_$sf('/_m/a/b', [])).rejects.toThrow();
    expect(fetch.mock.calls.at(-1)[0]).toBe('/acme/_m/a/b');
    document.head.innerHTML = '';
    vi.unstubAllGlobals();
  });
});

describe('components rendered in the browser', () => {
  const PANEL = `
    export function Panel() {
      var open = true;
      var n = 1;
      return (
        <div>
          <button id="toggle" onclick={() => (open = !open)}>t</button>
          <button id="more" onclick={() => n++}>m</button>
          {if (open) <div class="wrap"><Counter start={n} id="a" /></div> else ['closed ', <Field />]}
          <Counter start={n} id="b" />
          <Show value={n} />
        </div>
      );
    }
    export function Counter({ start, id }) {
      var count = start;
      return <p id={id}>{start}/<b>{count}</b><button onclick={() => count++}>+</button></p>;
    }
    function Show({ value }) { return <span id="show">{value}</span>; }
    export function Field() {
      var text = '';
      return <form method="post" id="f"><input oninput={(e) => (text = e.target.value)} /><output>{text}</output></form>;
    }`;

  it('keep their state when their parent renders them again, take new props, and start fresh where new', async () => {
    const { d, $, fire } = await mount(PANEL, 'Panel');
    const counter = (id) => $(`#${id}`).textContent.replace('+', '');
    fire('#a button', 'click');
    await vi.waitFor(() => expect(counter('a')).toBe('1/2'));
    fire('#more', 'click');
    await vi.waitFor(() => expect($('#show').textContent).toBe('2'));
    expect([counter('a'), counter('b')]).toEqual(['2/2', '2/1']); // new props, the state they had
    fire('#b button', 'click');
    await vi.waitFor(() => expect(counter('b')).toBe('2/2'));

    fire('#toggle', 'click'); // a component the page didn't have, with an event the page didn't listen for
    await vi.waitFor(() => expect($('#f')).not.toBe(null));
    expect($('#a')).toBe(null);
    expect($('#f input[name="_csrf"]').value).toBe('tok');
    const input = $('#f input:not([name])');
    input.value = 'hi';
    fire(input, 'input');
    await vi.waitFor(() => expect($('#f output').textContent).toBe('hi'));

    fire('#toggle', 'click');
    await vi.waitFor(() => expect($('#a')).not.toBe(null));
    expect(counter('a')).toBe('2/2'); // a new one, from its props
    expect(d.querySelectorAll('[m-c]').length).toBe(3);
  });
});

describe('components rendered in the browser, keeping state by place and by key', () => {
  const COUNT = `export function Counter({ id }) {
      var count = 0;
      return <p id={id}><b>{count}</b><button onclick={() => count++}>+</button></p>;
    }`;
  const counts = (d) => [...d.querySelectorAll('p[id]')].map((p) => `${p.id}=${p.querySelector('b').textContent}`).join(' ');

  it('each of two of the same kind in one hole keeps its own', async () => {
    const { d, fire } = await mount(
      `export function Page() {
        var n = 0;
        return <main><button id="more" onclick={() => n++}>{n}</button>{if (n >= 0) <div><Counter id="a" /><Counter id="b" /></div>}</main>;
      }
      ${COUNT}`,
      'Page',
    );
    fire('#b button', 'click');
    await vi.waitFor(() => expect(counts(d)).toBe('a=0 b=1'));
    fire('#more', 'click');
    await vi.waitFor(() => expect(d.querySelector('#more').textContent).toBe('1'));
    expect(counts(d)).toBe('a=0 b=1');
  });

  it("each in a keyed list's row keeps its own when the rows move, and a new row's starts as written", async () => {
    const { d, fire } = await mount(
      `export function Page() {
        var items = [{ id: 1 }, { id: 2 }, { id: 3 }];
        return (
          <main>
            <button id="rev" onclick={() => (items = [...items].reverse())}>r</button>
            <button id="add" onclick={() => (items = [{ id: 9 }, ...items.slice(1)])}>a</button>
            {if (items.length) <ul>{items.map((x) => <li key={x.id}><Counter id={'c' + x.id} /></li>)}</ul>}
            {if (items.length) <Counter id="after" />}
          </main>
        );
      }
      ${COUNT}`,
      'Page',
    );
    fire('#c1 button', 'click');
    fire('#c3 button', 'click');
    fire('#c3 button', 'click');
    fire('#after button', 'click');
    await vi.waitFor(() => expect(counts(d)).toBe('c1=1 c2=0 c3=2 after=1'));
    fire('#rev', 'click');
    await vi.waitFor(() => expect(counts(d)).toBe('c3=2 c2=0 c1=1 after=1'));
    fire('#add', 'click'); // c3's row goes, 9's is new
    await vi.waitFor(() => expect(counts(d)).toBe('c9=0 c2=0 c1=1 after=1'));
  });

  it("inside a component that is itself in a keyed row, by place in that component's hole", async () => {
    const { d, fire } = await mount(
      `export function Page() {
        var items = ['m', 'n'];
        return <main>{if (items.length) <ul>{items.map((x) => <li key={x}><Box id={x} /></li>)}</ul>}</main>;
      }
      export function Box({ id }) {
        var open = 0;
        return <div><button id={id + 'open'} onclick={() => open++}>{open}</button>{if (open >= 0) <span><Counter id={id + 'x'} /><Counter id={id + 'y'} /></span>}</div>;
      }
      ${COUNT}`,
      'Page',
    );
    fire('#ny button', 'click');
    await vi.waitFor(() => expect(counts(d)).toBe('mx=0 my=0 nx=0 ny=1'));
    fire('#nopen', 'click');
    await vi.waitFor(() => expect(d.querySelector('#nopen').textContent).toBe('1'));
    expect(counts(d)).toBe('mx=0 my=0 nx=0 ny=1');
  });

  it('in nested keyed lists, by the key of each row on the way', async () => {
    const { d, fire } = await mount(
      `export function Page() {
        var groups = [{ id: 'a', items: [1, 2] }, { id: 'b', items: [1, 2] }];
        return (
          <main>
            <button id="rev" onclick={() => (groups = [...groups].reverse())}>r</button>
            <button id="flip" onclick={() => (groups = groups.map((g) => ({ ...g, items: [...g.items].reverse() })))}>f</button>
            {if (groups.length) <div>{groups.map((g) => <section key={g.id}>{g.items.map((i) => <div key={i}><Counter id={g.id + i} /></div>)}</section>)}</div>}
          </main>
        );
      }
      ${COUNT}`,
      'Page',
    );
    fire('#b2 button', 'click');
    await vi.waitFor(() => expect(counts(d)).toBe('a1=0 a2=0 b1=0 b2=1'));
    fire('#rev', 'click');
    await vi.waitFor(() => expect(counts(d)).toBe('b1=0 b2=1 a1=0 a2=0'));
    fire('#flip', 'click'); // the rows inside each row move too
    await vi.waitFor(() => expect(counts(d)).toBe('b2=1 b1=0 a2=0 a1=0'));
  });

  it('in the children of a component whose props read state, and that component keeps its own too', async () => {
    const { d, $, fire } = await mount(
      `export function Page() {
        var open = false;
        var other = 0;
        return (
          <main>
            <button id="other" onclick={() => other++}>{other}</button>
            <button id="open" onclick={() => (open = !open)}>o</button>
            <Modal open={open}><Counter id="a" /></Modal>
          </main>
        );
      }
      export function Modal({ open, children }) {
        var z = 0;
        return <section class={open ? 'open' : ''}><i onclick={() => z++}>{z}</i>{children}</section>;
      }
      ${COUNT}`,
      'Page',
    );
    fire('#a button', 'click');
    fire('#a button', 'click');
    fire('section i', 'click');
    await vi.waitFor(() => expect([counts(d), $('section i').textContent]).toEqual(['a=2', '1']));
    fire('#other', 'click'); // the modal renders again in the page's hole
    await vi.waitFor(() => expect($('#other').textContent).toBe('1'));
    fire('#open', 'click');
    await vi.waitFor(() => expect($('section').className).toBe('open'));
    expect([counts(d), $('section i').textContent]).toEqual(['a=2', '1']);
  });
});

describe('components in a keyed list\'s rows', () => {
  const SRC = `export function Cal() {
      var days = [{ d: 1 }, { d: 2 }, { d: 3 }];
      var picked = 1;
      return (
        <div>
          <button id="rev" onclick={() => (days = [...days].reverse())}>r</button>
          <button id="add" onclick={() => (days = [{ d: 9 }, ...days.slice(1)])}>a</button>
          <button id="bump" onclick={() => (days = days.map((x) => (x.d === 2 ? { d: 2, big: 1 } : x)))}>b</button>
          <ul>{days.map((x) => <li key={x.d}><Day d={x.d} big={!!x.big} sel={x.d === picked} kind="day" open fmt={(n) => '#' + n} onpick={(n) => (picked = n)} /></li>)}</ul>
          <b id="p">{picked}</b>
        </div>
      );
    }
    export function Day({ d, big, sel, kind, open, fmt, onpick }) {
      var hits = 0;
      return <span class={(sel ? 'sel ' : '') + (big ? 'big' : '')} id={'d' + d} title={kind + open}><i onclick={() => hits++}>{hits}</i><a onclick={() => onpick(fmt ? d : 0)}>{d}</a></span>;
    }`;
  const cells = (d) => [...d.querySelectorAll('span')].map((x) => `${x.id}:${x.className.trim()}:${x.querySelector('i').textContent}`).join(' ');

  it('keep their state through updates and moves, and call the function props the row gave them', async () => {
    const { d, $, fire } = await mount(SRC, 'Cal');
    expect($('#d1').title).toBe('daytrue');
    fire('#d2 i', 'click');
    fire('#d2 i', 'click');
    await vi.waitFor(() => expect(cells(d)).toBe('d1:sel:0 d2::2 d3::0'));
    const [d2, d3] = [$('#d2'), $('#d3')];
    fire('#d3 a', 'click'); // onpick, in the row's component
    await vi.waitFor(() => expect($('#p').textContent).toBe('3'));
    expect(cells(d)).toBe('d1::0 d2::2 d3:sel:0');
    expect([$('#d2'), $('#d3')]).toEqual([d2, d3]); // patched where they are
    fire('#rev', 'click');
    await vi.waitFor(() => expect(cells(d)).toBe('d3:sel:0 d2::2 d1::0'));
    fire('#d1 a', 'click'); // its row moved since it rendered: found by its key
    await vi.waitFor(() => expect($('#p').textContent).toBe('1'));
    fire('#bump', 'click'); // a new item for d2: rendered again, and its state kept
    await vi.waitFor(() => expect(cells(d)).toBe('d3::0 d2:big:2 d1:sel:0'));
    expect($('#d2')).toBe(d2);
    fire('#add', 'click'); // d3's row goes, 9's is new
    await vi.waitFor(() => expect(cells(d)).toBe('d9::0 d2:big:2 d1:sel:0'));
    expect($('#d9 a').textContent).toBe('9');
  });

  it('can be the row itself, with its key: state kept by it, in the server render and when the rows move', async () => {
    const { d, $, fire, html } = await mount(
      `export function Grid() {
        var days = [{ d: 1 }, { d: 2 }, { d: 3 }];
        var picked = 0;
        return <div><button id="rev" onclick={() => (days = [...days].reverse())}>r</button><p>{days.map((x) => <Day key={x.d} d={x.d} sel={x.d === picked} onpick={(n) => (picked = n)} />)}</p></div>;
      }
      export function Day({ d, sel, onpick }) {
        var hits = 0;
        return <span class={sel ? 'sel' : ''} id={'d' + d}><i onclick={() => hits++}>{hits}</i><a onclick={() => onpick(d)}>{d}</a></span>;
      }`,
      'Grid',
    );
    expect(html).toContain('<span m-k="1" class="" id="d1"');
    fire('#d2 i', 'click');
    await vi.waitFor(() => expect(cells(d)).toBe('d1::0 d2::1 d3::0'));
    fire('#d3 a', 'click');
    await vi.waitFor(() => expect(cells(d)).toBe('d1::0 d2::1 d3:sel:0'));
    fire('#rev', 'click');
    await vi.waitFor(() => expect(cells(d)).toBe('d3:sel:0 d2::1 d1::0'));
    fire('#d2 a', 'click');
    await vi.waitFor(() => expect(cells(d)).toBe('d3::0 d2:sel:1 d1::0'));
    expect($('p').children.length).toBe(3);
  });

  it('render again only those whose props changed', async () => {
    const { d, $, fire } = await mount(SRC, 'Cal');
    fire('#d1 i', 'click'); // the list's first run
    await vi.waitFor(() => expect(cells(d)).toBe('d1:sel:1 d2::0 d3::0'));
    const seen = [];
    new MutationObserver((ms) => seen.push(...ms.map((m) => (m.target.closest ? m.target : m.target.parentNode).closest('span, ul').id))).observe($('ul'), { subtree: true, attributes: true, childList: true, characterData: true });
    fire('#d2 a', 'click');
    await vi.waitFor(() => expect($('#p').textContent).toBe('2'));
    await Promise.resolve();
    expect([...new Set(seen)].sort()).toEqual(['d1', 'd2']); // d3 untouched
  });
});

describe('children', () => {
  it("run the parent's handlers and show its state, inside the child, rendered there or in the browser", async () => {
    const { $, fire } = await mount(
      `export function Page() {
        var n = 0;
        var show = false;
        return (
          <main>
            <Card><p id="n">{n}</p><button id="inc" onclick={() => n++}>+</button></Card>
            <button id="show" onclick={() => (show = !show)}>show</button>
            {if (show) <Card><button id="dec" onclick={() => n--}>-</button></Card>}
          </main>
        );
      }
      export function Card({ children }) {
        var open = 0;
        return <section onclick={() => open++}>{children}<i>{open}</i></section>;
      }`,
      'Page',
    );
    fire('#inc', 'click');
    await vi.waitFor(() => expect($('#n').textContent).toBe('1'));
    await vi.waitFor(() => expect($('section i').textContent).toBe('1')); // the click reached the Card too
    fire('#show', 'click');
    await vi.waitFor(() => expect($('#dec')).not.toBe(null));
    fire('#dec', 'click');
    await vi.waitFor(() => expect($('#n').textContent).toBe('0'));
  });
});

describe('function props', () => {
  it('run the handler in the component that gave it, fixed or rendered in the browser', async () => {
    const { $, fire } = await mount(
      `export function Page() {
        var picked = 'none';
        var open = false;
        return (
          <main>
            <Picker onpick={(x) => (picked = 'fixed ' + x)} id="fixed" />
            <button id="open" onclick={() => (open = !open)}>open</button>
            {if (open) <Picker onpick={(x) => (picked = 'later ' + x)} id="later" />}
            <p id="picked">{picked}</p>
          </main>
        );
      }
      export function Picker({ onpick, id }) {
        var n = 0;
        return <button id={id} onclick={() => onpick(++n)}>pick</button>;
      }`,
      'Page',
    );
    fire('#fixed', 'click');
    await vi.waitFor(() => expect($('#picked').textContent).toBe('fixed 1'));
    fire('#open', 'click');
    await vi.waitFor(() => expect($('#later')).not.toBe(null));
    fire('#later', 'click');
    await vi.waitFor(() => expect($('#picked').textContent).toBe('later 1'));
  });
});

describe('onmount', () => {
  const log = (globalThis.log = []);
  globalThis.later = []; // callbacks the components give away, called as a timer would
  const LIFE = `export function Page() {
      var open = true;
      var n = 0;
      var items = [1, 2, 3];
      function bump() { n = n + 10; }
      return (
        <main onmount={() => { later.push(() => (n = n + 1), bump); log.push('page'); }}>
          <button id="open" onclick={() => (open = !open)}>o</button>
          <button id="inc" onclick={() => n++}>+</button>
          <button id="rev" onclick={() => (items = [...items].reverse())}>r</button>
          <button id="drop" onclick={() => (items = items.slice(1))}>d</button>
          <b id="n">{n}</b>
          {if (open) <input id="field" onmount={(e) => { e.target.value = 'focused'; log.push('in'); return () => log.push('out'); }} />}
          <ul>{items.map((x) => <li key={x} onmount={() => { log.push('row' + x); return () => log.push('gone' + x); }}>{x}</li>)}</ul>
        </main>
      );
    }`;

  it('runs when the page starts, and its callbacks change state as it is when they run', async () => {
    log.length = later.length = 0;
    const { $, fire, loads } = await mount(LIFE, 'Page');
    await vi.waitFor(() => expect(log).toEqual(['page', 'in', 'row1', 'row2', 'row3']));
    expect(loads).toEqual(['/c/Page.js']); // loaded at once: it has onmount
    expect($('#field').value).toBe('focused');
    fire('#inc', 'click');
    await vi.waitFor(() => expect($('#n').textContent).toBe('1'));
    later[0](); // a timer's callback, made at the start: it sees the click's change
    await vi.waitFor(() => expect($('#n').textContent).toBe('2'));
    later[1](); // the component's own function, given as a callback
    await vi.waitFor(() => expect($('#n').textContent).toBe('12'));
  });

  it("runs the cleanup when the element leaves, again when it's back, and not for a row that moved", async () => {
    log.length = later.length = 0;
    const { $, fire } = await mount(LIFE, 'Page');
    await vi.waitFor(() => expect(log.length).toBe(5));
    log.length = 0;
    fire('#open', 'click');
    await vi.waitFor(() => expect(log).toEqual(['out']));
    fire('#open', 'click');
    await vi.waitFor(() => expect(log).toEqual(['out', 'in']));
    fire('#rev', 'click');
    await vi.waitFor(() => expect($('li').textContent).toBe('3'));
    fire('#drop', 'click'); // 3 goes
    await vi.waitFor(() => expect(log).toEqual(['out', 'in', 'gone3']));
  });

  it('runs in a component that first appears in the browser, and goal dev runs the new body', async () => {
    log.length = 0;
    const { d, $, fire } = await mount(
      `export function Page() {
        var open = false;
        return <div><button id="open" onclick={() => (open = !open)}>o</button>{if (open) <Modal onclose={() => (open = false)} />}</div>;
      }
      export function Modal({ onclose }) {
        var shown = 0;
        return <p id="modal" onmount={() => {
          shown++;
          const esc = (e) => { if (e.key === 'Escape') onclose(); };
          addEventListener('keydown', esc);
          log.push('on');
          return () => { removeEventListener('keydown', esc); log.push('off'); };
        }}>{shown}</p>;
      }`,
      'Page',
      {},
      { more: ['mount'] },
    );
    fire('#open', 'click');
    await vi.waitFor(() => expect($('#modal')?.textContent).toBe('1'));
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await vi.waitFor(() => expect($('#modal')).toBe(null));
    expect(log).toEqual(['on', 'off']);
    fire('#open', 'click');
    await vi.waitFor(() => expect(log).toEqual(['on', 'off', 'on']));
    const body = d.createElement('body');
    body.innerHTML = '<p>new</p>';
    d.body.replaceWith(body);
    d.dispatchEvent(new CustomEvent('goal:listen', { detail: [] }));
    expect(log).toEqual(['on', 'off', 'on', 'off']);
  });
});

describe('callbacks that change state', () => {
  it('run at once when called in the handler that made them, which waits for their server functions', async () => {
    let answer;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((ok) => (answer = ok))));
    const { $, fire } = await mount(
      `server function save(v) { return v; }
      export function A() {
        var n = 0;
        var msg = '';
        return <p onclick={() => { const add = () => n++; add(); add(); ['x'].forEach((v) => (msg = save(v))); }}>{n}{msg}</p>;
      }`,
      'A',
    );
    fire('p', 'click');
    await vi.waitFor(() => expect($('p').textContent).toBe('2'));
    answer({ ok: true, json: async () => ({ v: 'x' }) });
    await vi.waitFor(() => expect($('p').textContent).toBe('2x'));
    vi.unstubAllGlobals();
  });
});
