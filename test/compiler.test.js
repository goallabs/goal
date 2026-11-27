import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, GoalError } from '../src/compiler.js';
import { build, load } from './helpers.js';
import { render } from '../src/server.js';
import { _$ctx } from '../src/render.js';
import { scopeName } from '../src/style.js';

const errorOf = (src) => {
  try {
    build(src);
  } catch (e) {
    expect(e).toBeInstanceOf(GoalError);
    return e.message;
  }
  throw new Error('expected a compile error');
};

const COUNTER = `
export function Counter({ start = 0 }) {
  var count = start;
  const double = count * 2;
  let label;
  if (count > 5) label = 'big';
  else label = 'small';
  const tone = count % 2 ? 'odd' : 'even';
  return (
    <div class={tone}>
      <button onclick={() => count++}>+</button>
      <p>{double} {label} {if (count > 9) <b>ten</b> else if (count < 0) 'minus'}</p>
    </div>
  );
}`;

describe('state and computeds', () => {
  it('turns var into state and let/const, if and ternary into computeds', () => {
    const r = build(COUNTER);
    expect(r.components).toEqual([{ name: 'Counter', interactive: true, events: ['click'] }]);
    expect(r.routes).toEqual([]);
    const [c] = r.clients;
    expect(c.name).toBe('Counter');
    expect(c.code).toContain('export default function Counter(_$s, {\n  start = 0\n}) {\n  var count = _$s.count;\n  const double = count * 2;');
    expect(c.code).toContain("if (count > 5) label = 'big';else label = 'small';");
    expect(c.code).toContain("const tone = count % 2 ? 'odd' : 'even';");
    expect(c.code).toContain("_$h(count > 9 ? _$m(`<b>ten</b>`) : count < 0 ? 'minus' : null)");
    expect(c.code).toContain('export const _$k = [[1, 0, "class"], [0, 1], [0, 2], [0, 3]];');
    expect(c.code).toContain('[() => count++], () => ({\n    count\n  })]');
  });

  it('renders on the server with markers and state, and no props the browser does not read', async () => {
    const { server } = await load(COUNTER);
    const { html, events } = render(server.Counter, { start: 7 });
    expect(events).toEqual(['click']);
    expect(html).toBe(
      '<div class="odd" m-x="0.0" m-c="/c/Counter.js" m-i="0" m-s="{&quot;count&quot;:7}">' +
        '<button m-on="click:0">+</button><p><!--0.1-->14<!--/--> <!--0.2-->big<!--/--> <!--0.3--><!--/--></p></div>',
    );
  });

  it('runs the client body again from state', async () => {
    const { loadChunk } = await load(COUNTER);
    const m = await loadChunk('/c/Counter.js');
    const s = { count: 1 };
    const [before, hs, read] = m.default(s, {});
    expect(before).toEqual(['odd', '2', 'small', '']);
    hs[0]();
    expect(s.count).toBe(1);
    expect(read()).toEqual({ count: 2 });
    Object.assign(s, read());
    expect(m.default(s, {})[0]).toEqual(['even', '4', 'small', '']);
    s.count = -1;
    expect(m.default(s, {})[0][3]).toBe('minus');
  });

  it('keeps names that only read props or constants static', () => {
    const r = build(`
      const MAX = 3;
      export function Label({ text }) {
        const upper = text.toUpperCase();
        return <p title={MAX}>{upper}</p>;
      }`);
    expect(r.components[0].interactive).toBe(false);
    expect(r.clients).toEqual([]);
  });

  it('follows computeds through other computeds and functions', () => {
    const r = build(`
      export function A() {
        var n = 1;
        const a = n + 1;
        const b = a * 2;
        function c() { return b + 1; }
        let d = 0;
        if (b > 2) d = 1;
        return <p onclick={() => n++}>{c()}{d}</p>;
      }`);
    expect(r.clients[0].code).toContain('export const _$k = [[0, 0], [0, 1]];');
  });

  it('keeps the component as written, names and all', () => {
    const r = build(`
      const count = 'module';
      export function A() {
        var count = 0;
        var other = 0, more = 1;
        const o = { count, other: count };
        return <p onclick={() => { const count = 5; o.count = count; other = count; }} oninput={() => { count += 1; }}>{o.count}{other}{more}</p>;
      }`);
    const code = r.clients[0].code;
    expect(code).toContain('var count = _$s.count;');
    expect(code).toContain('var other = _$s.other,\n    more = _$s.more;');
    expect(code).toContain('const o = {\n    count,\n    other: count\n  };');
    expect(code).toContain('other = count;');
    expect(code).toContain('count += 1;');
    expect(code).toContain('() => ({\n    count,\n    other,\n    more\n  })');
  });

  it('works with no props, and with props that have a default', async () => {
    const { server } = await load(`
      export function B() {
        return <p onclick={() => alert(1)}>b</p>;
      }
      export function C({ n = 1 } = {}) {
        var m = 0;
        return <p onclick={() => (m += n)}>{m}</p>;
      }`);
    expect(render(server.B).html).toBe('<p m-on="click:0" m-c="/c/B.js" m-i="0">b</p>');
    expect(render(server.C, { n: 4 }).html).toContain('m-p="{&quot;n&quot;:4}"');
  });

  it('uses a default file name and chunk URL', () => {
    const r = compile('export function A() { var n = 0; return <p onclick={() => n++}>{n}</p>; }');
    expect(r.server).toContain('m-c="/A.js"');
    expect(r.server).toContain('from "goaljs/rt"');
    expect(() => compile('function A() { return <>x</>; }')).toThrow('input.goal:1:');
  });
});

describe('props the browser needs', () => {
  it('ships only the destructured props the client code reads', async () => {
    const { server, r } = await load(`
      const sideEffect = (x) => x;
      export function A({ label, secret, unused, 'data-id': id, nested: { deep } }) {
        var n = 0;
        const shown = label + n;
        const hidden = secret;
        const alsoHidden = \`\${secret}!\`;
        const viaMember = secret.length;
        const both = secret && secret;
        const pick = secret ? secret : secret;
        const fn = () => secret;
        const lit = 1;
        function helper() { return secret; }
        const ran = sideEffect(n);
        let changed = 1;
        changed = 2;
        return <p data-x={secret} onclick={() => n++}>{shown}{id + n}{deep + n}</p>;
      }`);
    const html = render(server.A, { label: 'L', secret: 'S', unused: 'U', 'data-id': 7, nested: { deep: 1 } }).html;
    expect(html).toContain('m-p="{&quot;label&quot;:&quot;L&quot;,&quot;data-id&quot;:7,&quot;nested&quot;:{&quot;deep&quot;:1}}"');
    const code = r.clients[0].code;
    for (const gone of ['const hidden', 'alsoHidden', 'viaMember', 'const both', 'const pick', 'const fn', 'const lit', 'function helper'])
      expect(code).not.toContain(gone);
    expect(code).toContain('sideEffect(n)');
    expect(code).toContain('let changed = 1;');
  });

  it('keeps props read through props.name', async () => {
    const { server } = await load(`
      export function A(props) {
        var n = 0;
        return <p onclick={() => n++}>{n + props.step}{props.title}</p>;
      }`);
    expect(render(server.A, { step: 2, title: 't', secret: 's' }).html).toContain('m-p="{&quot;step&quot;:2}"');
  });

  it('drops computeds nothing reads, but keeps ones with side effects', () => {
    const r = build(`
      export function A({ x }) {
        var n = 0;
        const k = x[n];
        const unusedComputed = x[n];
        const a = 1, b = 2;
        return <p onclick={() => n++}>{k}</p>;
      }`);
    expect(r.clients[0].code).not.toContain('unusedComputed');
    expect(r.clients[0].code).toContain('const a = 1,');
  });

  it.each([
    ['export function A(props) { var n = 0; return <p onclick={() => n++}>{n + JSON.stringify(props)}</p>; }', 'read props as props.name'],
    ["export function A(props) { var n = 0; return <p onclick={() => n++}>{n + props['x']}</p>; }", 'read props as props.name'],
    ['export function A([a]) { var n = 0; return <p onclick={() => n++}>{n}{a}</p>; }', 'props are an object'],
    ['export function A({ a, ...rest }) { var n = 0; return <p onclick={() => n++}>{n}{a}</p>; }', "can't take ...rest props"],
    ['export function A({ [k]: a }) { var n = 0; return <p onclick={() => n++}>{n}{a}</p>; }', 'name each prop'],
  ])('%s', (src, message) => {
    expect(errorOf(src)).toContain(message);
  });
});

describe('templates', () => {
  it('writes attributes, void elements, fragments and text', async () => {
    const { server } = await load(`
      export default function Page() {
        return (
          <main class="a" data-x="say &quot;hi&quot;" hidden>
            <label for="n">Name {'<b>'}</label>
            <input id="n" />
            <>
              two   words
              {/* a comment */}
            </>
            {['a', <b>b</b>]}
            {<i>{1}</i>}
            {<>f<s /></>}
            {\`tick \\\` and \\\${x} \\\\\`}
          </main>
        );
      }`);
    expect(render(server.default).html).toBe(
      '<main class="a" data-x="say &quot;hi&quot;" hidden><label for="n">Name &lt;b&gt;</label><input id="n">' +
        'two   wordsa<b>b</b><i>1</i>f<s></s>tick ` and ${x} \\</main>',
    );
  });

  it('keeps backticks, ${ and backslashes in static markup', async () => {
    const { server } = await load('export function A() { return <p data-t="a`b${c}\\d">x \\ y</p>; }');
    expect(render(server.A).html).toBe('<p data-t="a`b${c}\\d">x \\ y</p>');
  });

  it('cleans text the way React does', async () => {
    const { server } = await load('export function A() { return <p>\t a\n\n   b  \n  </p>; }');
    expect(render(server.A).html).toBe('<p>  a b</p>');
  });

  it('turns markup in helpers into templates, inside and outside components', async () => {
    const { server, loadChunk } = await load(`
      const item = (t) => <li>{t}</li>;
      export function List() {
        var items = ['x'];
        const row = (t) => <li class="row">{t}</li>;
        const extra = <li onclick={() => (items = [])}>clear</li>;
        return <ul>{items.map(item)}{items.map(row)}{extra}</ul>;
      }`);
    expect(render(server.List).html).toContain(
      '<!--0.0--><li>x</li><!--/--><!--0.1--><li class="row">x</li><!--/--><!--0.2--><li m-on="click:0">clear</li><!--/-->',
    );
    const m = await loadChunk('/c/List.js');
    expect(m.default({ items: ['y'] })[0][0]).toBe('<li>y</li>');
  });

  it('places components in the fixed part and passes props', async () => {
    const { server } = await load(`
      function Hello({ name, loud, big, icon }) {
        return <b>{name}{if (loud) '!'}{big}{icon}</b>;
      }
      export default function Page() {
        const who = 'Ann';
        return <div><Hello name={who} loud big="yes" icon={<i>*</i>}>
        </Hello></div>;
      }`);
    expect(render(server.default).html).toBe('<div><b>Ann!yes<i>*</i></b></div>');
  });

  it('numbers instances so nested markers never clash', async () => {
    const { server } = await load(`
      function C() { var n = 0; return <i onclick={() => n++}>{n}</i>; }
      export default function P() { var m = 0; return <div onclick={() => m++}>{m}<C /><C /></div>; }`);
    const { html, events } = render(server.default);
    expect(html).toContain('m-i="0" m-s="{&quot;m&quot;:0}"><!--0.0-->0<!--/--><i m-on="click:0" m-c="/c/C.js" m-i="1"');
    expect(html).toContain('m-i="2" m-s="{&quot;n&quot;:0}"><!--2.0-->');
    expect(events).toEqual(['click']);
  });

  it('handlers may be names, and may use their own locals and module names', () => {
    const r = build(`
      const step = 2;
      export function A() {
        var n = 0;
        function inc(e) { n += step + e.detail; }
        return <p onclick={inc} oninput={(e) => { const v = e.target.value; n = Number(v); }}>{n}</p>;
      }`);
    expect(r.clients[0].code).toContain('[inc, e =>');
  });
});

describe('handlers inside lists', () => {
  const LIST = `
    export function L() {
      var items = ['a', 'b'];
      var picked = '';
      return (
        <ul onclick={() => (picked = '')}>
          {items.map((x, i) => <><li onclick={() => (picked = x)} ondblclick={() => (items = items.filter((y) => y !== x))}>{x}{i}</li></>)}
          <li>{picked}</li>
        </ul>
      );
    }`;

  it('number the handlers made while rendering after the fixed ones, the same on server and client', async () => {
    const { server, loadChunk } = await load(LIST);
    const html = render(server.L).html;
    expect(html).toContain('<li m-on="click:1 dblclick:2">a0</li><li m-on="click:3 dblclick:4">b1</li>');
    const m = await loadChunk('/c/L.js');
    const s = { items: ['a', 'b'], picked: '' };
    const [values, hs, read] = m.default(s, {});
    expect(values[0]).toBe('<li m-on="click:1 dblclick:2">a0</li><li m-on="click:3 dblclick:4">b1</li>');
    expect(hs).toHaveLength(5);
    hs[3]();
    expect(read().picked).toBe('b');
    hs[2]();
    expect(read().items).toEqual(['b']);
  });

  it('render a hole in the browser when its markup has handlers, even if it reads no state', () => {
    const r = build(`
      export function A({ list }) {
        const rows = list.map((x) => <li onclick={() => alert(x)}>{x}</li>);
        return <ul>{rows}{list.map((x) => <li key={x} onclick={() => alert(x)}>{x}</li>)}</ul>;
      }`);
    expect(r.components[0].interactive).toBe(true);
    expect(r.clients[0].code).toContain('export const _$k = [[0, 0], [2, 1, _$t0, [[0, []]]]];');
  });
});

describe('components rendered in the browser', () => {
  const SRC = `
    import { Ext } from './ext.goal';
    import { helper } from './lib.js';
    const store = [];
    export server function save(v) { store.push(v); return store; }
    export function Panel({ title }) {
      var open = true;
      var n = 1;
      return (
        <div onclick={() => (open = !open)}>
          {if (open) <Counter start={n} />}
          <Counter start={n} />
          <Counter start={1} />
          <Show value={title} />
          {if (open) <Ext />}
        </div>
      );
    }
    export function Counter({ start }) {
      var count = start;
      return <p onclick={() => count++}>{count}</p>;
    }
    function Show({ value }) { return <b>{helper(value)}</b>; }
    route GET / { return <main><Panel title="t" /></main>; }`;

  it('render a component in a hole, and one whose props read state, from the render module', () => {
    const r = build(SRC, 'ui/Panel.goal');
    const panel = r.clients.find((c) => c.name === 'Panel').code;
    expect(panel).toContain('import { Ext } from "goal-render:./ext.goal";');
    expect(panel).toContain('import { Counter } from "goal-render:./Panel.goal";');
    expect(panel).toContain('Counter({\n    "start": n\n  }, _$B.h(0))'); // in the {if} hole
    expect(panel).toContain('Counter({\n    "start": n\n  }, _$B.h(1))'); // its own hole: its props read state
    expect(panel).toContain('Ext({}, _$B.h(2))');
    expect(panel).toContain('export { _$B } from');
    expect(panel).not.toContain('Show'); // fixed props: rendered once, on the server
    expect(r.render).toContain('export function Panel(');
    expect(r.render).toContain('export function Show(');
    expect(r.render).toContain('const _$o = _$c.k?.("/c/Counter.js", _$i);');
    expect(r.render).toContain('import { helper } from \'./lib.js\';');
    for (const gone of ['store', 'save', 'main']) expect(r.render).not.toContain(gone); // server code stays on the server
  });

  it('render the components in the children of one whose props read state in its hole, the first hole too', () => {
    const r = build(`
      function Card({ title, children }) { return <section><h2>{title}</h2>{children}</section>; }
      function Leaf({ n }) { var k = n; return <i onclick={() => k++}>{k}</i>; }
      export function T() {
        var count = 0;
        return <div><button onclick={() => count++}>+</button><Card title={'n=' + count}><Leaf n={1} /></Card><b>{count}</b></div>;
      }`);
    const t = r.clients.find((c) => c.name === 'T').code;
    expect(t).toMatch(/Leaf\(\{\n\s+"n": 1\n\s+\}, _\$B\.h\(0\)\)/);
    expect(t.match(/_\$B\.h\(\d\)/g)).toEqual(['_$B.h(0)', '_$B.h(0)']); // Leaf, then Card: hole 0 is Card's
  });

  it('render a component in a keyed row again only when one of its props changed', () => {
    const r = build(`export function Cal() {
      var days = [];
      var picked = 1;
      return <div>{days.map((x) => <Day key={x.d} d={x.d} sel={x.d === picked} onpick={(n) => (picked = n)} />)}</div>;
    }
    export function Day({ d, sel, onpick }) { return <span class={sel ? 'sel' : ''} onclick={() => onpick(d)}>{d}</span>; }`);
    const cal = r.clients.find((c) => c.name === 'Cal').code;
    expect(cal).toContain('export const _$k = [[2, 0, _$t0, [[3], [3], [2, []]]]];'); // its props have no place; its HTML replaces the row
    expect(cal).toContain('_$d0 = _$q ? _$o[3] : x.d,\n      _$d1 = x.d === picked;'); // a prop of the item is kept with it
    expect(cal).toContain('_$o && _$o[3] === _$d0 && _$o[4] === _$d1 ? _$o[5] : _$mk(Day({'); // the last HTML, unless a prop changed
    expect(cal).toContain('"onpick": _$f("r0", _$B.r.getAttribute("m-i"), [0, x.d])'); // a handler of the row, found by its key
    expect(cal).toContain('export { _$lp, _$lh, _$lk };');
    expect(r.server).toContain('_$mk(Day({');
  });

  it("name the file when goal.js itself fails on it", () => {
    const typesOf = () => {
      throw new TypeError('x is undefined');
    };
    expect(() => compile('#strict\nimport { A } from "./b.goal";', { file: 'ui/a.goal', typesOf })).toThrow(
      "ui/a.goal: goal.js failed on this file (x is undefined). That's a bug in goal.js: please report it with the file.",
    );
    expect(() => compile('#strict\nimport { A } from "./b.goal";', { typesOf })).toThrow(/^input\.goal: goal\.js failed/);
  });

  it('leave out module code the components never use, unless it runs something', () => {
    const r = build(`
      const cache = {};
      const table = { a: 1, b: [2, , 3] };
      const made = { ...seed() };
      const named = { [key()]: 1 };
      const listed = [now()];
      export function C() { var n = 0; return <p onclick={() => n++}>{n}</p>; }`);
    for (const gone of ['cache', 'table']) expect(r.render).not.toContain(gone);
    for (const kept of ['made', 'named', 'listed']) expect(r.render).toContain(kept);
  });

  it('put a component whose props read state between markers on the server', async () => {
    const { server } = await load(SRC.replace("import { Ext } from './ext.goal';", 'function Ext() { return <i>e</i>; }').replace("import { helper } from './lib.js';", 'const helper = (v) => v;'));
    const html = render(server.Panel, { title: 'T' }).html;
    expect(html).toContain('<!--0.0--><p m-on="click:0" m-c="/c/Counter.js" m-i="1" m-s="{&quot;count&quot;:1}">'); // in the hole
    expect(html).toContain('<!--/--><!--0.1--><p m-on="click:0" m-c="/c/Counter.js" m-i="2"');
    expect(html).toContain('<b>T</b>');
  });
});

describe('children', () => {
  const SRC = `
    export function Page() {
      var n = 0;
      var show = false;
      return (
        <main>
          <Card title="fixed"><p class="n">{n}</p><button class="inc" onclick={() => n++}>+</button></Card>
          <button class="show" onclick={() => (show = !show)}>show</button>
          {if (show) <Card title="later"><button class="dec" onclick={() => n--}>-</button></Card>}
        </main>
      );
    }
    export function Card({ title, children }) {
      var open = 0;
      return <section onclick={() => open++}><h2>{title}</h2>{children}<i class="open">{open}</i></section>;
    }`;

  it("give the child markup whose bindings and handlers are the parent's", async () => {
    const { server } = await load(SRC);
    const html = render(server.Page).html;
    expect(html).toContain('<p class="n"><!--0.0-->0<!--/--></p><button class="inc" m-on="click:0@0">+</button>');
    expect(html).toContain('<h2>fixed</h2>');
    expect(build('route GET / { return <main><Box><b>x</b></Box></main>; }\nfunction Box({ children }) { return <div>{children}</div>; }').server).toContain('"children": _$m(`<b>x</b>`)');
  });

  it.each([
    'export function Card({ children }) { var open = 1; return <div onclick={() => (open = !open)}>{if (open) children}</div>; }',
    'export function Card(props) { var open = 1; return <div onclick={() => (open = !open)}>{open ? props.children : null}</div>; }',
  ])('keep children out of a hole that renders again: %s', (src) => {
    expect(errorOf(src)).toContain('put {children} in the fixed part of the component');
  });
});

describe('function props', () => {
  it("pass a handler of the parent, which the page writes as {$h, $i}", async () => {
    const src = `
      export function Page() {
        var picked = '';
        var open = true;
        return <main onclick={() => (open = !open)}><Picker onpick={(x) => (picked = x)} /><p>{picked}</p>{if (open) <Picker format={(x) => x} />}</main>;
      }
      export function Picker({ onpick }) { var n = 0; return <button onclick={() => onpick(++n)}>pick</button>; }`;
    const { server, r } = await load(src);
    const html = render(server.Page).html;
    expect(html).toContain('m-p="{&quot;onpick&quot;:{&quot;$h&quot;:1,&quot;$i&quot;:0}}"');
    expect(r.server).toContain('"format": _$f(_$hd(x => x), _$i)'); // in a hole: made while rendering
    expect(r.clients.find((c) => c.name === 'Page').code).toContain('"format": _$f(_$hd(x => x), _$B.r.getAttribute("m-i"))');
  });

  it.each([
    ['route GET / { return <main><P onpick={(x) => x} /></main>; }\nfunction P() { return <p/>; }', 'a function prop (onpick) goes to a component inside a component'],
    ['export function A() { var n = 0; return <div onclick={() => n++}><P onpick="x" /></div>; }\nfunction P() { return <p/>; }', 'onpick takes a function'],
  ])('%s', (src, message) => {
    expect(errorOf(src)).toContain(message);
  });
});

describe('goal dev', () => {
  const SRC = `
    export function C({ start }) {
      var n = start;
      var m;
      return <b onclick={() => n++}>{n}{m}</b>;
    }
    export function H() { return <i onclick={() => alert(1)}>h</i>; }
    export function S() { return <p>s</p>; }`;

  it('start a component from the state its page kept, when it is the same component', async () => {
    const { server } = await load(SRC, { dev: true });
    const html = (hmr) => {
      const ctx = _$ctx();
      ctx.k = (c, i) => (hmr?.[i]?.c === c ? hmr[i].s : null); // as app.js does for a live update
      return render(server.C, { start: 1 }, ctx).html;
    };
    expect(html(undefined)).toContain('m-s="{&quot;n&quot;:1}"><!--0.0-->1<!--/-->');
    expect(html({ 0: { c: '/c/C.js', s: { n: 7, m: 'kept', gone: 1 } } })).toContain('m-s="{&quot;n&quot;:7,&quot;m&quot;:&quot;kept&quot;}"><!--0.0-->7<!--/--><!--0.1-->kept<!--/-->');
    expect(html({ 0: { c: '/c/C.js', s: {} } })).toContain('<!--0.0-->1<!--/-->'); // a var the page didn't have starts as written
    expect(html({ 0: { c: '/c/Other.js', s: { n: 7 } } })).toContain('<!--0.0-->1<!--/-->'); // another component's state
    expect(render(server.S).html).toBe('<p>s</p>');
    expect(render(server.H).html).toContain('>h</i>');
    expect(build(SRC).server).not.toContain('_$o');
  });
});

describe('keyed lists', () => {
  const TABLE = `
    export function T({ base }) {
      var rows = [{ id: 1, label: 'a' }, { id: 2, label: 'b <i>' }];
      var picked = 0;
      return (
        <table>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.id} class={if (row.id === picked) 'on'}>
                <td>{row.id}</td>
                <td><a href={base + row.id} onclick={() => (picked = row.id)}>{row.label}</a></td>
                <td><button onclick={() => (rows = rows.filter((r) => r !== row))} ondblclick={() => (picked = i)}>x</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }`;

  it('render rows on the server from a row template', async () => {
    const { server } = await load(TABLE);
    expect(render(server.T, { base: '/r/' }).html).toBe(
      '<table m-c="/c/T.js" m-i="0" m-s="{&quot;rows&quot;:[{&quot;id&quot;:1,&quot;label&quot;:&quot;a&quot;},{&quot;id&quot;:2,&quot;label&quot;:&quot;b &lt;i&gt;&quot;}],&quot;picked&quot;:0}" m-p="{&quot;base&quot;:&quot;/r/&quot;}"><tbody><!--0.0-->' +
        '<tr m-r="0"><td>1</td><td><a href="/r/1" m-on="click:r0">a</a></td><td><button m-on="click:r1 dblclick:r2">x</button></td></tr>' +
        '<tr m-r="0"><td>2</td><td><a href="/r/2" m-on="click:r0">b &lt;i&gt;</a></td><td><button m-on="click:r1 dblclick:r2">x</button></td></tr>' +
        '<!--/--></tbody></table>',
    );
  });

  it('give the browser each row as [key, values, handlers], with where each value goes', async () => {
    const { r, loadChunk } = await load(TABLE);
    const code = r.clients[0].code;
    expect(code).toContain('export const _$k = [[2, 0, _$t0, [[1, [], "class"], [0, [0]], [1, [1, 0], "href"], [0, [1, 0]]]]];');
    // one import from keyed.js: the list's helper, and the patcher and row handlers it gives the loader
    expect(code).toContain('import { _$L, _$lf, _$lp, _$lh } from "goaljs/keyed";');
    expect(code).toContain('export { _$lp, _$lh };');
    expect(code.indexOf('const _$t0')).toBeLessThan(code.indexOf('export const _$k'));
    const m = await loadChunk('/c/T.js');
    const s = { rows: [{ id: 1, label: 'a' }], picked: 1 };
    const [[list], , read] = m.default(s, { base: 'javascript:' });
    expect([...list]).toEqual([[1, s.rows[0], 0, 'on', '1', 'about:invalid#blocked', 'a']]);
    // The next run keeps a row whose item, and the values it reads from the component, are the same.
    const again = m.default(s, { base: 'javascript:' })[0][0];
    expect(again[0]).toBe(m.default(s, { base: 'javascript:' })[0][0][0]);
    const hs = list.h(s.rows[0], 0);
    hs[2]();
    expect(read().picked).toBe(0);
    hs[1]();
    expect(read().rows).toEqual([]);
    expect(m._$k[0][2]([0, 0, 0, null, '7', '/x', 'y'])).toBe('<tr m-r="0"><td>7</td><td><a href="/x" m-on="click:r0">y</a></td><td><button m-on="click:r1 dblclick:r2">x</button></td></tr>');
  });

  it('patch by key only a list whose rows have a key, and keep the plain form for static lists', async () => {
    const src = `
      export function A({ fixed }) {
        var items = ['a'];
        return (
          <div>
            <ul>{items.map(function (x) { const up = x.toUpperCase(); return <li key={x}>{up}</li>; })}</ul>
            <ol>{fixed.map((x) => <li key={x}>{x}</li>)}</ol>
            <p>{items.map((x) => <i>{x}</i>)}</p>
          </div>
        );
      }`;
    const code = build(src).clients[0].code;
    expect(code).toContain('const _$k = x,');
    expect(code).toContain('_$d0 = _$h(up);'); // a local of the callback: worked out on every run
    expect(code).toContain('export const _$k = [[2, 0, _$t0, [[0, []]]], [0, 1]];'); // the list without keys is a plain hole
    const { server } = await load(src);
    expect(render(server.A, { fixed: ['f'] }).html).toContain('<ol><li>f</li></ol>'); // a static list renders once: its key goes nowhere
    expect(build('route GET / { return <ul>{[1].map((x) => <li key={x}>{x}</li>)}</ul>; }').server).toContain('<li>${_$h(x)}</li>');
  });

  it('give the rows of a keyed list patched as a whole their key: in an element in an {if}, or in a row', async () => {
    const src = `
      export function A() {
        var xs = [{ id: 1, kids: [7] }];
        var on = 1;
        return (
          <div onclick={() => (on = !on)}>
            {if (on) <ul>{xs.map((x) => { return <li key={x.id}>{x.id}</li>; })}</ul>}
            <ol>{xs.map((x) => <li key={x.id}><i>{x.kids.map((k) => <b key={k}>{k}</b>)}</i></li>)}</ol>
          </div>
        );
      }`;
    const code = build(src).clients[0].code;
    expect(code).toContain('<li${_$a("m-k", x.id)}>');
    expect(code).toContain('<b${_$a("m-k", k)}>');
    const { server } = await load(src);
    const html = render(server.A).html;
    expect(html).toContain('<ul><li m-k="1">1</li></ul>');
    expect(html).toContain('<i><b m-k="7">7</b></i>');
  });

  it('patch a keyed list in an {if} or a ternary by key, with the other branch next to it', async () => {
    const src = `
      export function A() {
        var items = [{ id: 1, t: 'a' }];
        var on = true;
        return (
          <div onclick={() => (on = !on)}>
            <ul>{if (on) items.map((x) => <li key={x.id}>{x.t}</li>)}</ul>
            <ul>{if (on) items.map((x) => <li key={x.id}>{x.t}</li>) else <li>none</li>}</ul>
            <ul>{on ? <li>shown</li> : items.map((x) => <li key={x.id}>{x.t}</li>)}</ul>
          </div>
        );
      }`;
    const code = build(src).clients[0].code;
    expect(code).toContain('export const _$k = [[2, 0, _$t0, [[0, []]]], [2, 1, _$t2, [[0, []]]], [0, 2], [2, 3, _$t4, [[0, []]]], [0, 4]];');
    expect(code).toContain('const _$t1 = [];'); // no rows: the same empty list on every run
    expect(code).toContain(') : _$t1, (x, _$j) => [], _$s, "_$c0")');
    expect(code).toContain('_$L(on ? _$t5 : items.map(');
    expect(code).toContain('_$h(on ? null : _$m(`<li>none</li>`))');
    expect(code).toContain('_$h(on ? _$m(`<li>shown</li>`) : null)');
    const { server } = await load(src);
    expect(render(server.A).html).toContain(
      '<ul><!--0.0--><li m-r="0">a</li><!--/--></ul><ul><!--0.1--><li m-r="1">a</li><!--/--><!--0.2--><!--/--></ul><ul><!--0.3--><!--/--><!--0.4--><li>shown</li><!--/--></ul>',
    );
  });

  it('take a destructured item apart in an arrow, and look past returns of nested functions', () => {
    const r = build(`
      export function A() {
        var items = [{ id: 1 }];
        return <ul>{items.map(({ id }) => <li key={id}>{(() => { return id; })()}</li>)}</ul>;
      }`);
    expect(r.clients[0].code).toContain('items.map((_$r, _$j) => {\n    const {\n      id\n    } = _$r;');
    expect(r.clients[0].code).toContain('(_$r, _$j) => {\n    const {\n      id\n    } = _$r;\n    return [];\n  }');
  });

  it('make a changed row again when its values have no fixed place', () => {
    const r = build(`
      export function A() {
        var items = ['a'];
        return <ul>{items.map((x) => <li key={x}>{x}: <b>{x}</b><>{x}</></li>)}</ul>;
      }`);
    expect(r.clients[0].code).toContain('export const _$k = [[2, 0, _$t0, null]];');
  });

  it('render other lists as a whole', () => {
    const r = build(`
      export function A() {
        var items = ['a'];
        return (
          <div>
            <p>{items.filter(Boolean)}</p>
            <p>{items.map(String)}</p>
            <p>{items.map((x) => x)}</p>
            <p>{items.map((x) => { if (x) return <i>{x}</i>; return <b>{x}</b>; })}</p>
            <p>{items.map((x) => {})}</p>
            <p>{items[map]((x) => <i>{x}</i>)}</p>
          </div>
        );
      }`.replace('items[map]', "items['map']"));
    expect(r.clients[0].code).toContain('export const _$k = [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5]];');
    expect(r.clients[0].code).not.toContain('_$lp');
  });

  it.each([
    ['export function A() { var xs = []; return <ul>{xs.map((x) => <li><b key={x}>{x}</b></li>)}</ul>; }', 'key goes on the outer element of a list row'],
    ['export function A() { var xs = []; return <ul>{xs.map((x) => <li key="a">{x}</li>)}</ul>; }', 'a key is an expression'],
    ['export function A() { var xs = []; return <ul>{xs.map((x) => <li key={x}>{x && <b onclick={() => 1}>b</b>}</li>)}</ul>; }', 'put the handler on an element of the list row'],
    ['export function A() { var xs = []; return <p key={1}>{xs}</p>; }', 'key goes on the outer element of a list row'],
  ])('%s', (src, message) => {
    expect(errorOf(src)).toContain(message);
  });
});

describe('onmount and callbacks', () => {
  it('compiles onmount as an event, and tells every page of the app to bring the loader that runs it', async () => {
    const { r, server } = await load(`
      export function A() { var n = 0; return <p onmount={() => n++}>{n}</p>; }
      export function B() { return <i onmount={() => {}}>b</i>; }`);
    expect(r.server.match(/_\$ctx\.m = true/g)).toHaveLength(1);
    expect(r.server).not.toContain('_$ctx.w');
    expect(build('export function A() { var n = 0; return <p onclick={() => setTimeout(() => n++, 1)}>{n}</p>; }').server).toContain('_$ctx.w = true;');
    expect(render(server.A).html).toContain('m-on="mount:0"');
    expect(_$ctx.m).toBe(true);
    expect(r.render).not.toContain('_$ctx.m'); // the browser's render module
  });

  it('puts callbacks that change state in the run, where the loader finds them, and leaves the rest', () => {
    const r = build(`
      export function A() {
        var n = 0;
        function bump() { n++; }
        const show = (x) => x;
        return <p onclick={() => {
          function tick() { n = 2; }
          setTimeout(tick, 1);
          setTimeout(bump, 1);
          setTimeout(() => show(1), 1);
          setTimeout(() => { let z = 0; z = 1; globalThis.x = z; }, 1);
          setTimeout(() => setTimeout(() => (n = 3), 1), 1);
          const k = 5;
          setTimeout((e) => (n = k + e), 1);
          bump();
        }}>{n}</p>;
      }`);
    const c = r.clients[0].code;
    expect(c).toContain('export default function A(_$s, _$p, _$r)');
    expect(c).toContain('const tick = _$w(_$r, 0);');
    expect(c).toContain('setTimeout(_$w(_$r, 1), 1);'); // bump, given away
    expect(c).toContain('setTimeout(() => show(1), 1);');
    expect(c).toContain('globalThis.x = z;'); // changes no state: as written
    expect(c).toContain('setTimeout(() => setTimeout(_$w(_$r, 2), 1), 1);');
    expect(c).toMatch(/\n\s+bump\(\);/); // called in the handler: as written
    expect(c).toContain('setTimeout(_$w(_$r, 3, [k]), 1);'); // with what it uses from the handler
    expect(c).toMatch(/,, \[\(\) => function tick\(\) \{\n\s+n = 2;\n\s+\}, \(\) => bump, \(\) => \(\) => n = 3, k => e => n = k \+ e\]\];/);
  });

  it('refuses a callback that changes state and uses a variable around it that changes', () => {
    expect(errorOf('export function A() { var n = 0; return <p onclick={() => { let k = 1; setTimeout(() => (n = k), 1); k = 2; }}>{n}</p>; }')).toContain(
      "App.goal:1:102: `k` changes, so a callback that changes state can't use it: the callback takes it as it is when it's made. Make it state with var, or a const",
    );
  });
});

describe('server functions', () => {
  it('turn calls in handlers into requests the handler waits for, with no async or fetch written', async () => {
    const { r, server } = await load(`
      const db = [];
      export server function add(text) { db.push(text); return db.length; }
      server function count() { return db.length; }
      export function A() {
        var n = 0;
        var busy = false;
        function save() {
          busy = true;
          n = add('x');
          busy = false;
        }
        const again = () => save();
        function twice() { save(); again(); }
        return (
          <div>
            <button onclick={save}>a</button>
            <button onclick={() => (n = count())}>b</button>
            <button onclick={() => { again(); }}>c</button>
            <button onclick={twice}>d</button>
            <p>{n}{busy}</p>
          </div>
        );
      }
      route GET / {
        const before = count();
        add('route');
        const after = await count();
        return json([before, after]);
      }`);
    const code = r.clients[0].code;
    expect(code).toContain('async function save() {\n    busy = true;\n    n = await _$sf("/_m/App/add", [\'x\']);');
    expect(code).toContain('async () => n = await _$sf("/_m/App/count", [])');
    expect(code).toContain('const again = async () => await save();');
    expect(code).toContain('async function twice() {\n    await save();\n    await again();\n  }');
    expect(code).toContain('async () => {\n    await again();\n  }');
    expect(code).not.toContain('db.push');
    expect(r.serverFunctions).toEqual([
      { name: 'add', path: '/_m/App/add' },
      { name: 'count', path: '/_m/App/count' },
    ]);
    const [get, addRoute, countRoute] = server._$routes;
    expect([addRoute.method, addRoute.path, countRoute.path]).toEqual(['POST', '/_m/App/add', '/_m/App/count']);
    const x = { ctx: {}, json: (v, status = 200) => ({ v, status }) };
    expect(await get.handler({}, x)).toEqual({ v: [0, 1], status: 200 });
    expect(await addRoute.handler({ json: ['y'] }, x)).toEqual({ v: { v: 2 }, status: 200 });
    expect(await addRoute.handler({ json: { a: 1 } }, x)).toEqual({ v: { error: 'send the arguments as a JSON array' }, status: 400 });
    const none = await load('server function nothing() {}');
    expect(await none.server._$routes[0].handler({ json: [] }, x)).toEqual({ v: { v: null }, status: 200 });
  });

  it('can be imported from another .goal file', () => {
    const files = { './store.goal': { base: 'lib/store', names: ['save'] } };
    const r = compile(
      `import def, { save, other } from './store.goal';
       import { x } from './plain.goal';
       export function A() { var n = 0; return <p onclick={() => { n = save(n); other(); def(); x(); }}>{n}</p>; }`,
      { file: 'A.goal', serverFunctions: (spec) => files[spec] ?? null },
    );
    expect(r.clients[0].code).toContain('n = await _$sf("/_m/lib/store/save", [n]);');
    expect(r.clients[0].code).toContain("import def, { other } from './store.goal';");
    expect(r.serverFunctions).toEqual([]);
  });

  it.each([
    ['server function s() {}\nconst x = s();', 'call a server function from a route, another server function or an event handler'],
    ['server function s() {}\nfunction f() { return s(); }', 'call a server function from a route, another server function or an event handler'],
    ['server function s() {}\nfunction A() { const v = s(); return <p/>; }', "a server function can't run while a component renders"],
    ['server function s() {}\nfunction A() { const f = [1].map(() => () => s()); return <p/>; }', 'call server functions in an event handler, or in a function declared at the top'],
    ['server function s() {}\nfunction A() { function f() { s(); } f(); return <p/>; }', "a server function can't run while a component renders"],
  ])('%s', (src, message) => {
    expect(errorOf(src)).toContain(message);
  });
});

describe('source maps', () => {
  it('point the server module and client chunks at the .goal source', () => {
    const src = 'export function A() {\n  var n = 0;\n  return <p onclick={() => n++}>{n}</p>;\n}\n';
    const r = compile(src, { file: 'ui/A.goal' });
    for (const code of [r.server, r.clients[0].code]) {
      const map = JSON.parse(Buffer.from(code.split('base64,')[1], 'base64').toString());
      expect(map.sources).toEqual(['A.goal']);
      expect(map.sourcesContent).toEqual([src]);
      expect(map.mappings.length).toBeGreaterThan(10);
    }
  });
});

describe('client modules', () => {
  it('keep only the imports and helpers the component uses', () => {
    const r = build(`
      import fmt, { a, b } from './fmt.js';
      import * as ns from './ns.js';
      import { serverOnly } from './server.js';
      import { Other } from './Other.goal';
      const PURE = 1, TWO = 2;
      const unused = 'x';
      const fn = () => 1;
      let later;
      later = 1;
      const used = () => b(PURE);
      const effect = setup();
      function helper() { return a(); }
      function dead() { return serverOnly(); }
      export function exportedHelper() { return 1; }
      export { helper };
      export default fmt;
      class Box {}
      export function A() {
        var n = 0;
        return <div onclick={() => n++}><Other />{helper() + n}{used()}{fmt(n)}{TWO}</div>;
      }
      export function B() { return <p onclick={() => ns.go()}>b</p>; }`);
    const a = r.clients.find((c) => c.name === 'A').code;
    expect(a).toContain("import fmt, { a } from './fmt.js';");
    expect(a).toContain('function helper()');
    for (const gone of ['const used', 'serverOnly', './ns.js', 'Other', 'unused', 'dead', 'exportedHelper', 'const fn', 'export default fmt', 'export { helper'])
      expect(a).not.toContain(gone);
    expect(a).toContain('export { _$hm } from'); // its holes are patched by rt.js's _$hm
    expect(a).toContain('const PURE = 1,');
    expect(a).toContain('let later;');
    expect(a).toContain('const effect = setup();');
    expect(a).toContain('class Box');
    const b = r.clients.find((c) => c.name === 'B').code;
    expect(b).toContain("import * as ns from './ns.js';");
    expect(b).not.toContain('_$h');
  });
});

describe('secure markup', () => {
  it('checks URLs: static ones when compiling, dynamic ones when rendering and patching', async () => {
    const { server, r } = await load(`
      export function A({ to }) {
        var url = 'javascript:alert(1)';
        return <div><a href="/ok" title="javascript: is fine here">x</a><a href={url} onclick={() => (url = '/b')}>y</a><a href={to}>z</a></div>;
      }`);
    const html = render(server.A, { to: 'data:text/html,x' }).html;
    expect(html).toContain('<a href="/ok" title="javascript: is fine here">');
    expect(html).toContain('<a href="about:invalid#blocked" m-on="click:0" m-x="0.0">');
    expect(html).toContain('<a href="about:invalid#blocked">z</a>');
    expect(r.clients[0].code).toContain('_$u(url)');
  });

  it('adds the CSRF token to forms that send data, and turns other methods into POST', async () => {
    const { server } = await load(`
      export function F() {
        return (
          <div>
            <form method="get" action="/s"><input name="q" /></form>
            <form method="POST" action="/a"><button>a</button></form>
            <form method="delete" action="/b"><button>b</button></form>
          </div>
        );
      }`);
    const html = render(server.F, {}, _$ctx('tok"en')).html;
    expect(html).toContain('<form method="get" action="/s"><input name="q"></form>');
    expect(html).toContain('<form method="post" action="/a"><input type="hidden" name="_csrf" value="tok&quot;en"><button>');
    expect(html).toContain(
      '<form method="post" action="/b"><input type="hidden" name="_csrf" value="tok&quot;en"><input type="hidden" name="_method" value="delete"><button>',
    );
  });
});

describe('routes', () => {
  it('compile into handlers with their path parameters and helpers', async () => {
    const { server, r } = await load(`
      function Card({ n }) { return <li>{n}</li>; }
      const page = (body) => <html><body>{body}</body></html>;
      route GET /items/{id}/{part} {
        const list = [1, 2];
        return page(
          <main>
            <h1>{id} {part}</h1>
            <ul>{list.map((n) => <Card n={n} />)}</ul>
            <form method="put" action={'/items/' + id}><button>save</button></form>
            {if (request.query.x) <p>{request.query.x}</p>}
          </main>
        );
      }
      route POST / {
        cookie('a', 'b');
        return redirect('/');
      }`);
    expect(r.routes).toEqual([
      { method: 'GET', path: '/items/{id}/{part}' },
      { method: 'POST', path: '/' },
    ]);
    const [get, post] = server._$routes;
    expect([get.method, get.path, post.method]).toEqual(['GET', '/items/{id}/{part}', 'POST']);
    const ctx = _$ctx('T');
    const out = await get.handler({ params: { id: '7', part: '<x>' }, query: { x: 'q' } }, { ctx });
    expect(out.s).toBe(
      '<html><body><main><h1>7 &lt;x&gt;</h1><ul><li>1</li><li>2</li></ul><form method="post" action="/items/7"><input type="hidden" name="_csrf" value="T"><input type="hidden" name="_method" value="put"><button>save</button></form><p>q</p></main></body></html>',
    );
    const calls = [];
    const x = { ctx, redirect: (u) => ['redirect', u], cookie: (...a) => calls.push(a) };
    expect(await post.handler({}, x)).toEqual(['redirect', '/']);
    expect(calls).toEqual([['a', 'b']]);
  });

  it("let the file's own names win over the route helpers", () => {
    const r = build(`
      import { redirect } from './nav.js';
      route GET / { return redirect('/x'); }`);
    expect(r.server).toContain('const {\n    json,\n    notFound,\n    cookie,\n    reply,\n    stream,\n    events\n  } = _$x;');
    expect(r.server).not.toContain('request.params');
  });

  it('skip the helpers when the file has its own of every name', () => {
    const r = build(`
      import { redirect, json, notFound, cookie, reply, stream, events } from './h.js';
      route GET / { return json(1); }`);
    expect(r.server).not.toContain('= _$x;');
  });

  it('are left out of client modules', () => {
    const r = build(`
      export function A() { var n = 0; return <p onclick={() => n++}>{n}</p>; }
      route GET / { return <main><A /></main>; }`);
    expect(r.clients[0].code).not.toContain('_$r0');
  });
});

describe('errors', () => {
  it.each([
    ['export default function () { return <p/>; }', '1:16: give the function a name'],
    ['async function A() { return <p/>; }', "a component can't be async: call a server function"],
    ['function* A() { return <p/>; }', "a component can't be a generator"],
    ['function A() { const f = async () => 1; return <p/>; }', 'no async in components'],
    ['function A() { return <p onclick={async () => 1}/>; }', 'no async in components'],
    ['function A() { var d; return <p onclick={() => fetch("/x")}/>; }', 'call a server function instead of fetch'],
    ['function A(a, b) { return <p/>; }', 'takes one parameter'],
    ['function A() {}', 'ends with `return <element>`'],
    ['function A() { const x = 1; }', 'ends with `return <element>`'],
    ['function A() { return <>x</>; }', 'ends with `return <element>`'],
    ['function A() { if (1) return <a/>; return <p/>; }', 'one return, at the end'],
    ['function A() { var { a } = {}; return <p/>; }', 'one name at a time'],
    ['function A() { if (1) { var a = 1; } return <p/>; }', 'at the top of the component'],
    ['function A() { var n = 0; return <p onclick={() => { var m = n + 1; n = m; }}/>; }', '1:54: inside a function, use let or const: var declares state'],
    ['function A() { function f() { for (var i = 0; i < 2; i++); } return <p/>; }', '1:36: inside a function, use let or const'],
    ['function A() { var xs = []; return <ul>{xs.map((x) => { var y = x; return <li>{y}</li>; })}</ul>; }', 'inside a function, use let or const'],
    ['function A() { var a = 1; a = 2; return <p/>; }', 'change it in an event handler'],
    ['function A() { var a = 1; return <p onclick={() => { [a] = [2]; }}/>; }', 'not by destructuring'],
    ['function A() { let a = 1; return <p onclick={() => { a = 2; }}/>; }', 'Declare it with `var`'],
    ['function A() { return <x.y/>; }', 'plain tag names'],
    ['function A() { return <B/>; }', "a component's root is an element"],
    ['function A() { var xs = []; return <ul>{xs.map((x) => <B key="k" onx={() => 1} />)}</ul>; }', 'a key is an expression: key={x.id}'],
    ['function A() { var xs = []; return <ul>{xs.map((x) => <li key={x}>{x ? <B /> : null}</li>)}</ul>; }', "<B> can't go inside {...} in a keyed list's row yet"],
    ['function A() { var xs = []; return <ul>{xs.map((x) => <li key={x}><B>hi</B></li>)}</ul>; }', "<B> in a keyed list's row takes props, not children, yet"],
    ['function A() { var xs = []; return <ul>{xs.map((x) => <li key={x}><B {...x} /></li>)}</ul>; }', 'spread props are not supported yet'],
    ['function A() { var xs = []; return <ul>{xs.map((x) => <li key={x}><B a:b="1" /></li>)}</ul>; }', 'namespaced props are not supported'],
    ['function A() { var xs = []; return <ul>{xs.map((x) => <li key={x}><B onpick="go()" /></li>)}</ul>; }', 'onpick takes a function'],
    ['function A() { var xs = []; return <ul>{xs.map((x) => <li key={x}><B a=<i /> /></li>)}</ul>; }', 'a prop value is "text" or {expression}'],
    ['const x = <B/>;', '<B> goes in a route or in a component'],
    ['function A() { return <p {...x}/>; }', 'spread attributes'],
    ['function A() { return <p a:b="1"/>; }', 'namespaced attributes'],
    ['function A() { return <p onClick={() => 1}/>; }', 'write onclick, the HTML name, not onClick'],
    ['function A() { return <p onclick="go()"/>; }', "onclick takes a function: onclick={() => ...}. A string of code isn't allowed"],
    ['const x = <p onclick={() => 1}/>;', 'event handlers go inside a component'],
    ['route GET / { return <p onclick={() => 1}/>; }', 'event handlers go inside a component'],
    ['function A() { return <p className="a"/>; }', 'write class, as in HTML'],
    ['function A() { return <label htmlFor="a"/>; }', 'write for, as in HTML'],
    ['function A() { return <iframe srcdoc="<b>x</b>"/>; }', "srcdoc isn't allowed"],
    ['function A() { return <div><script>{"alert(1)"}</script></div>; }', "<script> isn't allowed"],
    ['function A() { return <div><style>{"p{}"}</style></div>; }', 'put CSS in a file under public/'],
    ['function A() { return <a href="javascript:alert(1)"/>; }', "href can't be a javascript: URL"],
    ['function A() { return <img src=" data:image/png,x"/>; }', "src can't be a data: URL"],
    ['function A() { return <p title=<b/>/>; }', 'an attribute value is "text" or {expression}'],
    ['function A() { return <form method={m}/>; }', 'write the form method as text'],
    ['function A() { return <form method="dialog"/>; }', "a form's method is one of get, post, put, patch, delete"],
    ['function A() { var n = 0; return <div>{n && <form method="post"></form>}</div>; }', 'a form that sends data goes in a route'],
    ['const f = <form method="post"></form>;', 'a form that sends data goes in a route'],
    ['function A() { return <br>x</br>; }', "<br> can't have children"],
    ['function A() { return <p>{...xs}</p>; }', '1:27: Unexpected token'],
    ['function A() { return <p><B {...x}/></p>; }', 'spread props'],
    ['function A() { return <p><B a:b="1"/></p>; }', 'namespaced props'],
    ['function A() { return <p><B t=<b/>/></p>; }', 'a prop value is "text" or {expression}'],
    ['route GET / { var a = 1; return <p/>; }', '`a`: state (var) belongs in a component'],
    ['route GET /{id} { const id = 2; return <p/>; }', "`id` is already the route's path parameter {id}"],
    // assignments JavaScript would refuse when the code runs
    ['function A() { const a = 1; a = 2; return <p>{a}</p>; }', "1:29: `a` is a const, so it can't be changed"],
    ['function A() { const a = 1; return <p onclick={() => { a = 2; }}/>; }', '`a` is a const'],
    ['function A() { var n = 0; return <p onclick={() => { const m = 1; m++; n = m; }}/>; }', '`m` is a const'],
    ['route GET / { const a = 1; a += 1; return <p/>; }', '`a` is a const'],
    ['const a = 1;\nexport function f() { a = 2; }', '2:23: `a` is a const'],
    ["import { x } from './x.js';\nfunction A() { return <p onclick={() => { x = 1; }}/>; }", "2:43: `x` is an import, so it can't be changed"],
    ['function A({ start }) { return <p onclick={() => { start = 2; }}/>; }', '`start` comes from the props, so a handler can\'t change it. Copy it into state (var)'],
    ['function A(props) { return <p onclick={() => props++}/>; }', '`props` comes from the props'],
    ['function A() { function f() {} return <p onclick={() => { f = 1; }}/>; }', "`f` is a function of the component's, so a handler can't change it"],
    ['route GET /u/{id} { id = Number(id); return <p>{id}</p>; }', "1:21: `id` is the route's path parameter {id}, so it can't be changed. Give the new value a name of its own"],
    ['route GET /u/{id} { const f = () => { [id] = [1]; }; return <p/>; }', "`id` is the route's path parameter {id}"],
    ['let hits = 0;\nfunction A() { return <p onclick={() => { hits++; }}/>; }', "2:43: `hits` is declared outside the component, so the component can't change it: on the server, every request shares it"],
    ['var n = 0;\nfunction A() { n = 1; return <p/>; }', '`n` is declared outside the component'],
    ['function f() {}\nfunction A() { return <p onclick={() => { f = 1; }}/>; }', '`f` is declared outside the component'],
  ])('%s', (src, message) => {
    expect(errorOf(src)).toContain(message);
  });

  it('allows the assignments JavaScript allows', () => {
    // a prop or a let set while rendering, a handler's own let, a route's own names, a parameter of its own
    build(`export function A({ start }) { start = start ?? 1; let a = 1; if (start) a = 2; return <p onclick={() => { let m = a; m++; }}>{a}</p>; }
      route GET /u/{id} { let n = 1; n++; const f = (id) => { id = 1; }; f(n); return <p>{id}</p>; }`);
    // the file's own variables, changed by server code: a route, a server function, a plain function
    build(`let visits = 0;
      function bump() { visits++; }
      export server function count() { visits++; return visits; }
      route GET / { visits++; bump(); return <p>{visits}</p>; }`);
  });

  it('says where the error is in the .goal source', () => {
    const e = (() => {
      try {
        build('route GET / { return <p>{if (1) 2}</p>; }\nfunction A() {\n  var a = 1;\n  a = 2;\n  return <p>{if (a) 1}</p>;\n}', 'src/A.goal');
      } catch (err) {
        return err;
      }
    })();
    expect(e.message).toBe('src/A.goal:4:3: `a` is state: change it in an event handler, not while rendering');
    expect([e.file, e.line, e.column]).toEqual(['src/A.goal', 4, 3]);
  });
});

describe('style blocks', () => {
  it("scope the file's CSS, and mark each element the file renders, on the server and in the browser", () => {
    const r = build(
      `style {\n  .card { color: red; }\n}\nexport function Card({ title, children }) { var n = 0; return <div class="card"><p onclick={() => n++}>{title}</p>{n > 1 ? <b>big</b> : null}{children}</div>; }\nroute GET / { return <main><Card title="t"><i>child</i></Card></main>; }`,
      'ui/Card.goal',
    );
    const g = scopeName('ui/Card.goal');
    expect(r.css).toBe(`\n  .card:where([${g}]) { color: red; }\n`);
    for (const html of [`<div ${g} class="card"`, `<b ${g}>big</b>`, `<main ${g}>`, `<i ${g}>child</i>`]) expect(r.server).toContain(html); // children: the file that writes them
    expect(r.clients[0].code).toContain(`<b ${g}>big</b>`);
    expect(r.render).toContain(`<div ${g} class="card"`);
  });

  it('leave a file without one, or with an empty one, as it was', () => {
    expect(build('export function A() { return <p/>; }').css).toBe('');
    const r = build('style {\n}\nexport function A() { return <p/>; }');
    expect([r.css, r.server.includes(' g-')]).toEqual(['', false]);
  });

  it('report a mistake in the CSS at its place in the .goal file', () => {
    expect(errorOf('export const a = 1;\nstyle {\n  @import "x.css";\n}')).toBe('App.goal:3:3: @import goes in a stylesheet under public/, linked from the page');
  });
});

describe('the package', () => {
  it('exports every helper file compiled code imports, server and browser', () => {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'));
    const r = compile(
      `export server function save(v) { return v; }
      export function A() { var q = ''; var r = call(save(q)); var list = [1]; return <ul onclick={() => save(1)}>{list.map((x) => <li key={x}>{x}</li>)}{r.value}</ul>; }`,
      { file: 'A.goal', rt: 'goaljs/rt', keyed: 'goaljs/keyed', chunk: (n) => `/c/${n}.js` },
    );
    const used = new Set([r.server, r.render, ...r.clients.map((c) => c.code)].flatMap((code) => [...code.matchAll(/from "goaljs\/(\w+)"/g)].map((m) => `./${m[1]}`)));
    expect([...used].sort()).toEqual(['./call', './keyed', './load', './render', './request', './rt']);
    for (const f of used) expect(pkg.exports[f]).toBe(`./src/${f.slice(2)}.js`);
  });
});
