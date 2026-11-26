import { describe, it, expect } from 'vitest';
import { desugar } from '../src/syntax.js';
import { compile } from '../src/compiler.js';
import { exportsOf, show } from '../src/types.js';
import { _$ok, _$call } from '../src/rt.js';

/** The first error compiling a #strict file, or 'ok'. */
const errorOf = (src, typesOf) => {
  try {
    compile(`#strict\n${src}`, { file: 'A.goal', typesOf });
    return 'ok';
  } catch (e) {
    return e.message.replace(/^A\.goal:\d+:\d+: /, '');
  }
};
const syntaxError = (src) => {
  try {
    desugar(src, 'a.goal');
    return 'ok';
  } catch (e) {
    return e.message.replace(/^a\.goal:\d+:\d+: /, '');
  }
};

describe('writing types', () => {
  it('reads #strict, annotations and type declarations, and takes them out of the code', () => {
    const d = desugar(
      `\n  #strict
export type Note = { id: number, 'text': string; default?: boolean, kind: 'a' | 1 | true | false | null, list: (string | undefined)[][], any: unknown, m: Markup }
type Pick = () => void;
type Fn = (x: string, y?: number) => Note;
function f(a: number, { b }: { b: string }, c: Note = null): string { return [1].map((n: number) => n); }
var v: string | null = null;
route GET /notes/{id: number}/{name: string}/x { return id; }`,
      'a.goal',
    );
    expect(d.strict).toBe(true);
    expect(d.code).toBe('\n  \n\n\n\nfunction f(a, { b }, c = null) { return [1].map((n) => n); }\nvar v = null;\nasync function _$r0(request, _$x) { return id; }');
    const note = d.types.decls.get('Note');
    expect(note.exported).toBe(true);
    expect(show(note.type)).toBe("{ id: number, text: string, default?: boolean, kind: \"a\" | 1 | true | false | null, list: (string | undefined)[][], any: unknown, m: Markup }");
    expect(show(d.types.decls.get('Pick').type)).toBe('() => void');
    expect(show(d.types.decls.get('Fn').type)).toBe('(a: string, b?: number) => Note');
    expect([...d.types.at.values()].map(show)).toEqual(['number', '{ b: string }', 'Note', 'string', 'number', 'string | null']);
    expect(d.routes[0]).toMatchObject({ path: '/notes/{id}/{name}/x', params: ['id', 'name'], types: { id: 'number', name: 'string' } });
  });

  it('are only in a #strict file, and say what is wrong with one', () => {
    expect(syntaxError('function f(a: number) {}')).toBe('types go in a #strict file: put #strict on the first line');
    expect(syntaxError('type A = string;')).toBe('types go in a #strict file: put #strict on the first line');
    expect(syntaxError('route GET /a/{id: number} { }')).toBe('types go in a #strict file: put #strict on the first line');
    expect(syntaxError('#strict\ntype A = string;\ntype A = number;')).toBe('the type A is declared twice');
    expect(syntaxError('#strict\nfunction f() { type A = string; }')).toBe('declare a type at the top level of a file');
    expect(syntaxError('#strict\ntype A = { 1: string };')).toBe('write a field as name: type');
    expect(syntaxError('#strict\ntype A = { a: string b: number };')).toBe('separate the fields with commas');
    expect(syntaxError('#strict\ntype A = [];')).toBe('write a type: string, number, boolean, a list like Note[], or an object like { id: number }');
    expect(syntaxError('#strict\ntype A = (string);')).toBe('ok');
    expect(syntaxError('#strict\nconst x = { a: 1 }; type = 2;')).toBe('ok'); // `type` stays a name
  });
});

describe('checking a #strict file', () => {
  const NOTE = 'type Note = { id: number, text: string, done?: boolean };';
  it.each([
    // props
    ['export function A() { return <div><B n="1" /></div>; }\nfunction B({ n }: { n: number }) { return <b>{n}</b>; }', "B's n is number, not string"],
    ['export function A() { return <div><B /></div>; }\nfunction B({ n }: { n: number }) { return <b>{n}</b>; }', 'B needs n'],
    ['export function A() { return <div><B nmae="x" /></div>; }\nfunction B({ name }: { name: string }) { return <b>{name}</b>; }', 'B has no prop nmae; did you mean name?'],
    ['export function A() { return <div><B zz="x" /></div>; }\nfunction B({ name }: { name: string }) { return <b>{name}</b>; }', 'B has no prop zz'],
    ['export function A() { return <div><B>hi</B></div>; }\nfunction B() { return <b>b</b>; }', 'B takes no children'],
    ['export function A() { return <div><B big>hi</B></div>; }\nfunction B({ big, children }: { big: boolean, children: Markup }) { return <b>{children}</b>; }', 'ok'],
    ['export function A({ n }) { return <b>{n}</b>; }', "give A's props a type: function A(props: { ... })"],
    // state and values
    ['export function A() { var n = 0; return <b onclick={() => (n = "x")}>{n}</b>; }', 'n is number, not string'],
    ['export function A() { var xs = []; return <b>{xs.length}</b>; }', "give xs a type: its initial value doesn't say, so write var xs: Type = ..."],
    ['export function A() { var x = null; return <b>{x}</b>; }', "give x a type: its initial value doesn't say, so write var x: Type = ..."],
    ['export function A() { var x; return <b>{x}</b>; }', "give x a type: its initial value doesn't say, so write var x: Type = ..."],
    ['export function A() { var n: number = "a"; return <b>{n}</b>; }', 'n is number, not string'],
    ['import { db } from "./db.js";\nexport function A() { const rows = db.all(); return <b>{rows}</b>; }', 'rows comes from ./db.js, which has no types: give it one, like const rows: Type = ...'],
    ['import db from "./db.js";\nexport function A() { const rows: string[] = db.all(); return <b>{rows}</b>; }', 'ok'],
    ['export function A({ u }: { u: { name: string } }) { return <b>{u}</b>; }', "{ name: string } can't be rendered: render a field of it, like {u.name}"],
    ['export function A({ u }: { u: {} }) { return <b>{u.x ? u : null}</b>; }', "{  } can't be rendered: render a field of it, like {it.name}"],
    ['export function A({ f }: { f: () => void }) { return <b>{f}</b>; }', "a function can't be rendered: call it, or render what it gives"],
    [`${NOTE}\nexport function A({ xs }: { xs: Note[] }) { return <ul>{xs.map((n) => <li>{n.text}{n.done ? 'y' : 'n'}</li>)}{xs}</ul>; }`, "{ id: number, text: string, done?: boolean } can't be rendered: render a field of it, like {xs.id}"],
    ['export function A() { var s = "x"; return <button disabled={s} onclick={() => (s = "y")}>b</button>; }', 'disabled takes true or false, not string'],
    ['export function A() { var s = 1; return <button disabled={s > 0} onclick={() => s++}>{s}</button>; }', 'ok'],
    // server functions and calls
    ['export server function save(v) { return v; }', "save's arguments come from the network: give v a type"],
    ['export server function save({ v }) { return v; }', "save's arguments come from the network: give each one a type"],
    ['export server function save(v: number): () => void { return () => {}; }', "save's result travels as JSON: () => void can't"],
    ['export server function save(v: number): { a: Markup[] } | null { return null; }', "save's result travels as JSON: { a: Markup[] } | null can't"],
    ['export server function save(v: number, w: string = ""): number { return v; }\nexport function A() { var n = 0; return <b onclick={() => (n = save("x"))}>{n}</b>; }', 'save takes number, not string'],
    ['export server function save(v: number = 1): number { return v; }\nexport function A() { var n = 0; return <b onclick={() => (n = save(1, 2))}>{n}</b>; }', 'save takes 0 to 1 argument, not 2'],
    ['function two(a: number, b: number) { return a + b; }\nexport function A() { var n = two(1); return <b>{n}</b>; }', 'two takes 2 arguments, not 1'],
    ['const f = (a: number) => a;\nexport function A() { var n = f("x"); return <b>{n}</b>; }', 'the function takes number, not string'.replace('the function', 'f')],
    ['function f(x: number): string { return x; }', 'f returns string, not number'],
    ['export const g = function (x: number): string { return x; };', 'the function returns string, not number'],
    ['function f(x: number): string { if (x) return; return "a"; }', 'ok'],
    // imports and declared names
    ['import { B } from "./B.goal";\nexport function A() { return <div><B /></div>; }', "./B.goal isn't #strict: a #strict file can import only #strict .goal files"],
    ['export function A({ n }: { n: Nte }) { return <b>{n}</b>; }', 'no type is named Nte'],
    ['function f(): Missing[] { return []; }', 'no type is named Missing'],
  ])('%s', (src, message) => {
    expect(errorOf(src)).toBe(message);
  });

  it('works out types through the code, and lets unknown values be', () => {
    const src = `${NOTE}
type Pick = (x: string) => void;
export function A({ notes, title, pick, opt }: { notes: Note[], title?: string, pick: Pick, opt?: number }) {
  var first = notes.find((n) => n.done) ?? notes[0];
  var shown: number = notes.filter((n) => !n.done).length + notes.findIndex((n, i) => i > 0) + notes.indexOf(notes[0]);
  var words: string = notes.map((n) => n.text).join(', ') + title + \`\${shown}\` + 'x'.trim().slice(1) + 'a'.split(',')[0];
  var flags: boolean = notes.some((n) => n.done) && 'abc'.startsWith('a') && typeof title === 'string' && !first && 'x'.indexOf('y') > -1;
  var count: number = Number('1') + -shown + ~1 + (shown ** 2) + (opt ?? 0);
  var label: string = String(1) + (shown > 1 ? 'many' : 'one') + void 0;
  var ok: boolean = Boolean(1) && (delete notes[0]);
  var copy: Note[] = notes.slice().reverse().concat([]);
  var rec = { a: 1, 'b': 'x' };
  var unknownish = { [title]: 1 };
  var spread = { ...rec };
  var nested: number[][] = [[1], [2, 3]];
  var u: unknown = notes.whatever();
  var later: string = ('a', 'x');
  return <div onclick={() => { count = shown++; pick('a'); words = rec.b; label = (words = 'z'); }}>{words}{count}{label}{String(flags)}{copy.length}{nested[0].length}{first?.text}{undefined}{null}{true}</div>;
}`;
    expect(errorOf(src)).toBe('ok');
    expect(errorOf('export function A() { var n = 1; var s: string = n + 1; return <b>{s}</b>; }')).toBe('s is string, not number');
    expect(errorOf('export server function s(n: number) { const r: string = await Promise.resolve(n); const q: string = await (n); return r + q; }')).toBe('q is string, not number');
    expect(errorOf('export function A() { var x = 1; var y: string = x + undefined; return <b>{y}</b>; }')).toBe('ok'); // unknown sum
    expect(errorOf('function f(a: number) { return a; }\nexport function A() { var y: string = f(1); return <b>{y}</b>; }')).toBe('y is string, not number');
    expect(errorOf('function loop(a: number) { return loop(a); }\nexport function A() { var y: string = loop(1); return <b>{y}</b>; }')).toBe('ok');
    expect(errorOf('export function A() { var f = () => 1; var y: number = f(); const z = (() => { return; })(); return <b>{y}</b>; }')).toBe('ok');
    expect(errorOf('export function A({ xs }: { xs: string[] }) { var ys: number[] = xs.map(String); const [a] = xs; return <b>{a}</b>; }')).toBe('ok');
    expect(errorOf('export function A({ o }: { o: { a?: number } }) { var n: number = o.a; return <b>{n}</b>; }')).toBe('n is number, not number | undefined');
    expect(errorOf('export function A({ o = 1 }: { o?: number }) { var n: number = o; return <b>{n}</b>; }')).toBe('n is number, not number | undefined');
    expect(errorOf('export function A(props: { n: number }) { var s: string = props.n; return <b>{s}</b>; }')).toBe('s is string, not number');
    expect(errorOf('export function A({ a: { b } }: { a: { b: number } }) { return <b>{b}</b>; }')).toBe('ok');
    expect(errorOf('class K {}\nfunction f(x: number) { const g = () => { return "a"; }; return x; }\nexport function A() { var k = K; var y: string = f(1); return <b>{y}</b>; }')).toBe('y is string, not number');
  });

  it('fits values to types: unions, literals, lists, objects and functions', () => {
    const fits = (from, to) => errorOf(`function f(v: ${from}) { var x: ${to} = v; return x; }`);
    expect(fits('"a"', "'a' | 'b'")).toBe('ok');
    expect(fits('"c"', "'a' | 'b'")).toBe('x is "a" | "b", not string');
    expect(fits("'a' | 'b'", 'string')).toBe('ok');
    expect(fits('string | number', 'string')).toBe('x is string, not string | number');
    expect(fits('1', 'number')).toBe('ok');
    expect(fits('null', 'string | null')).toBe('ok');
    expect(fits('number[]', 'number[]')).toBe('ok');
    expect(fits('number[]', 'string[]')).toBe('x is string[], not number[]');
    expect(fits('{ a: number, b: string }', '{ a: number }')).toBe('ok');
    expect(fits('{ b: string }', '{ a: number }')).toBe('x is { a: number }, not { b: string }');
    expect(fits('{ b: string }', '{ a?: number }')).toBe('ok');
    expect(fits('{ a: number }', '{ a?: number }')).toBe('ok');
    expect(fits('(a: string) => void', '(a: string) => void')).toBe('ok');
    expect(fits('(a: string) => number', '(a: number) => number')).toBe('x is (a: number) => number, not (a: string) => number');
    expect(fits('() => number', '(a: string) => void')).toBe('ok');
    expect(fits('() => void', '() => undefined')).toBe('ok');
    expect(fits('() => string', '() => number')).toBe('x is () => number, not () => string');
    expect(fits('Markup', 'Markup')).toBe('ok');
    expect(fits('boolean', 'Markup')).toBe('x is Markup, not boolean');
    expect(fits('(string | number)[]', '(string | number)[]')).toBe('ok');
    expect(fits('((a: string) => void)[]', 'unknown')).toBe('ok');
  });

  it('fits literals in objects and lists to literal types, and widens them in a variable without a type', () => {
    const W = "type Week = { day: 'mon' | 'sun' };\n";
    expect(errorOf(W + "const a: Week = { day: 'mon' }; const b: Week[] = [{ day: 'sun' }, { day: 'mon' }]; const c: ('a' | 'b')[] = ['a'];")).toBe('ok');
    expect(errorOf(W + "function f(w: Week) { return w; } f({ day: 'sun' });")).toBe('ok');
    expect(errorOf(W + "const a: Week = { day: 'tue' };")).toBe('a is Week, not { day: string }');
    expect(errorOf(W + "const o = { day: 'mon', n: [1] }; const a: Week = o;")).toBe('a is Week, not { day: string, n: number[] }');
    expect(errorOf("var o = { day: 'mon', n: [1] }; function f() { o = { day: 'sun', n: [2, 3] }; }")).toBe('ok');
  });
});

describe('#strict files importing each other', () => {
  const B = `#strict
export type Note = { id: number, text: string, tags: Tag[], self: Loop };
type Tag = string;
type Loop = { next: Loop };
export function Card({ note, size }: { note: Note, size?: number }) { return <p>{note.text}</p>; }
export function Plain() { return <hr />; }
export server function save(note: Note, flag): Note[] { return [note]; }
export server function load() { return []; }
function inner() {}
export const x = 1;`;
  const typesOf = (spec) => (spec === './B.goal' ? exportsOf(B, 'B.goal') : exportsOf('export function P() { return <p/>; }', 'P.goal'));

  it('reads what a #strict file exports, with the names its types use written out', () => {
    const info = exportsOf(B, 'B.goal');
    expect(info.strict).toBe(true);
    expect(show(info.types.get('Note'))).toBe('{ id: number, text: string, tags: string[], self: { next: unknown } }');
    expect(info.types.has('Tag')).toBe(false);
    expect(show(info.values.get('Card').props)).toBe('{ note: { id: number, text: string, tags: string[], self: { next: unknown } }, size?: number }');
    expect(info.values.get('Plain').props).toBe(null);
    expect(show(info.values.get('save'))).toBe('(a: { id: number, text: string, tags: string[], self: { next: unknown } }, b: unknown) => { id: number, text: string, tags: string[], self: { next: unknown } }[]');
    expect(show(info.values.get('load'))).toBe('() => unknown');
    expect(exportsOf('export function P() {}', 'P.goal')).toEqual({ strict: false, types: new Map(), values: new Map() });
  });

  it('checks props and calls against what the other file exports, and leaves its types out of the code', () => {
    const use = (body) => errorOf(`import { Card, Plain, save, Note, x } from "./B.goal";\n${body}`, typesOf);
    expect(use('export function A({ n }: { n: Note }) { return <div><Card note={n} /><Plain /></div>; }')).toBe('ok');
    expect(use('export function A({ n }: { n: Note }) { return <div><Card note={n} size="big" /></div>; }')).toBe("Card's size is number, not string");
    expect(use('export function A({ n }: { n: Note }) { var all: Note[] = []; return <b onclick={() => (all = save("x", 1))}>{all.length}</b>; }')).toBe('save takes { id: number, text: string, tags: string[], self: { next: unknown } }, not string');
    const r = compile(`#strict\nimport { Card, Note } from "./B.goal";\nexport function A({ n }: { n: Note }) { return <div><Card note={n} /></div>; }`, { file: 'A.goal', typesOf });
    expect(r.server).toContain('import { Card } from "./B.goal";');
    expect(errorOf('import { P } from "./P.goal";\nexport function A() { return <div><P /></div>; }', typesOf)).toBe("./P.goal isn't #strict: a #strict file can import only #strict .goal files");
    expect(errorOf('import Def from "./B.goal";\nexport function A() { return <div><Def /></div>; }', typesOf)).toBe('ok'); // nothing known about it: unchecked
  });
});

describe('the corners of inference', () => {
  it.each([
    ['import { db } from "./db.js";\nfunction f() { const db: number = 1; var s: string = db; return s; }', 's is string, not number'], // a local db, not the import
    ['export function A() { const { a } = { a: 1 }; var s: string = a; return <b>{s}</b>; }', 'ok'], // destructured: unknown
    ['export function A({ xs }: { xs: string[] }) { var n: string = xs.map((x, i, all) => i)[0]; return <b>{n}</b>; }', 'n is string, not number'],
    ['export function A({ xs }: { xs: string[] }) { var n: string = xs.map((x, i, all) => all)[0]; return <b>{n}</b>; }', 'ok'],
    ['function run(f: unknown) { return f; }\nexport function A({ ns }: { ns: number[] }) { run((x) => x); var o = ns.map(({ a }) => a); return <b>{o.length}</b>; }', 'ok'],
    ['function f(x: number) { x; }\nexport function A() { var y: string = f(1); return <b>{y}</b>; }', 'y is string, not void'],
    ['export function A({ b }: { b: number }) { var all: string = [!b, -b, +b, ~b, typeof b, void b, delete b.x][0]; return <b>{all}</b>; }', 'all is string, not boolean | number | string | undefined'],
    ['export function A() { const rec = { a: 1 }; var n: string = rec["a"]; var t = "ab"; var m: string = t.length; return <b>{n}{m}</b>; }', 'm is string, not number'],
    ['export function A() { var c: string = "x".charCodeAt(0); return <b>{c}</b>; }', 'ok'],
    ['export function A() { var i: string = "x".indexOf("y"); return <b>{i}</b>; }', 'i is string, not number'],
    ['function f() { return "abc".split((m) => { const q: number = m; return "x"; }); }', 'ok'], // called on text, not a list: m is unknown
    ['export function A() { const o = { a: 1 }; var n = 0; return <b onclick={() => { o.a = 2; n += 1; zz = 3; }}>{n}{/* nothing */}</b>; }', 'ok'],
    ['export function A() { return <div><Nope n={1} /></div>; }', 'ok'],
    ['export function A() { return <div><B {...{ n: 1 }} /></div>; }\nfunction B({ n }: { n: number }) { return <b>{n}</b>; }', 'spread props are not supported yet'],
  ])('%s', (src, message) => {
    expect(errorOf(src)).toBe(message);
  });

  it('reads exported union and function types, and a component whose props have no type', () => {
    const info = exportsOf('#strict\nexport type F = (a: string | number) => void;\nexport function C({ n }) { return <b>{n}</b>; }\nexport function helper() {}', 'C.goal');
    expect(show(info.types.get('F'))).toBe('(a: string | number) => void');
    expect(info.values.get('C').props).toEqual({ k: 'unknown' });
  });
});

describe('compiled #strict code', () => {
  it('checks typed path parameters and server function arguments at runtime', () => {
    const r = compile('#strict\ntype L = { next: L, tags: (string | null)[] };\nexport server function save(l: L, n: number = 1) { return n; }\nroute GET /n/{id: number} { return <p>{id}</p>; }', { file: 'A.goal' });
    const table = r.server.slice(r.server.indexOf('export const _$routes')).replace(/\s+/g, ' ');
    expect(table).toContain('path: "/n/{id}", handler: _$r0, types: { id: "number" } }');
    expect(table).toContain('_$call(save, r, x, [{ type: { k: "object", fields: { next: { type: { k: "unknown" }, optional: false }, tags: { type: { k: "array", of: { k: "union", of: [{ k: "string" }, { k: "null" }] } }, optional: false } } }, optional: false }, { type: { k: "number" }, optional: true }])');
    expect(compile('export server function save(v) { return v; }', { file: 'A.goal' }).server).toContain('_$call(save, r, x)');
  });
});

describe('types at runtime', () => {
  it('check a JSON value against a type', () => {
    const note = { k: 'object', fields: { id: { type: { k: 'number' }, optional: false }, tag: { type: { k: 'string' }, optional: true } } };
    expect(_$ok({ id: 1 }, note)).toBe(true);
    expect(_$ok({ id: 1, tag: null }, note)).toBe(true);
    expect(_$ok({ id: 1, tag: 2 }, note)).toBe(false);
    expect(_$ok({ tag: 'x' }, note)).toBe(false);
    expect(_$ok([], note)).toBe(false);
    expect(_$ok(null, note)).toBe(false);
    expect(_$ok([1, 2], { k: 'array', of: { k: 'number' } })).toBe(true);
    expect(_$ok([1, 'x'], { k: 'array', of: { k: 'number' } })).toBe(false);
    expect(_$ok('a', { k: 'union', of: [{ k: 'lit', v: 'a' }, { k: 'null' }] })).toBe(true);
    expect(_$ok(true, { k: 'boolean' })).toBe(true);
    expect(_$ok(null, { k: 'null' })).toBe(true);
    expect(_$ok(null, { k: 'undefined' })).toBe(true);
    expect(_$ok(1, { k: 'void' })).toBe(false);
    expect(_$ok({ any: 1 }, { k: 'unknown' })).toBe(true);
  });

  it('turn away arguments of the wrong types before a server function runs', async () => {
    const x = { json: (value, status = 200) => ({ value, status }) };
    const fn = async (a, b) => (b ?? 0) + a;
    const types = [
      { type: { k: 'number' }, optional: false },
      { type: { k: 'number' }, optional: true },
    ];
    expect(await _$call(fn, { json: [1, 2] }, x, types)).toEqual({ value: { v: 3 }, status: 200 });
    expect(await _$call(fn, { json: [1] }, x, types)).toEqual({ value: { v: 1 }, status: 200 });
    expect(await _$call(fn, { json: [1, null] }, x, types)).toEqual({ value: { v: 1 }, status: 200 });
    expect((await _$call(fn, { json: ['1'] }, x, types)).status).toBe(400);
    expect((await _$call(fn, { json: [] }, x, types)).status).toBe(400);
    expect((await _$call(fn, { json: [1, 2, 3] }, x, types)).status).toBe(400);
    expect((await _$call(fn, { json: [null] }, x, [{ type: { k: 'null' }, optional: false }])).status).toBe(200);
    expect((await _$call(fn, { json: 'x' }, x, types)).status).toBe(400);
  });
});
