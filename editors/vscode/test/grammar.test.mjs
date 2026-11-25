import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { tokenize, scopesOf, TSX_GRAMMAR } from './tokens.mjs';
import { EXAMPLES, EXAMPLES_DIR } from './examples.mjs';

const skip = TSX_GRAMMAR ? false : "VS Code's JavaScriptReact grammar wasn't found (set GOAL_TSX_GRAMMAR)";
const inner = (scopes) => scopes.at(-1);

test('route: keyword, method, path and {params}', { skip }, async () => {
  const lines = await tokenize('route GET /users/{id}/posts/{post} {\n  return <main>{id}</main>;\n}\nroute GOT /x {\n}');
  assert.equal(inner(scopesOf(lines, 'route')), 'storage.type.route.goal');
  assert.equal(inner(scopesOf(lines, 'GET')), 'constant.language.http-method.goal');
  assert.equal(inner(scopesOf(lines, 'users')), 'string.unquoted.route-path.goal');
  assert.equal(inner(scopesOf(lines, 'id')), 'variable.parameter.route.goal');
  assert.equal(inner(scopesOf(lines, 'post')), 'variable.parameter.route.goal');
  assert.equal(inner(scopesOf(lines, 'GOT')), 'invalid.illegal.http-method.goal');
  // the body is an ordinary block, with markup in it
  assert.equal(inner(scopesOf(lines, 'return', 1)), 'keyword.control.flow.tsx');
  assert.equal(inner(scopesOf(lines, 'main', 1)), 'entity.name.tag.tsx');
});

test('route: only as a statement, not in strings, comments or markup', { skip }, async () => {
  const lines = await tokenize('const s = `\nroute GET /x {`;\n// route GET /y {\nconst m = <p>\nroute GET /z {\n</p>;');
  for (const l of lines) for (const t of l) assert.ok(!t.scopes.some((s) => s.endsWith('route.goal')), JSON.stringify(t));
});

test('server function, exported or not', { skip }, async () => {
  const lines = await tokenize('export server function addNote(text) {\n  return text;\n}\nserver function load() {}');
  assert.equal(inner(scopesOf(lines, 'export')), 'keyword.control.export.goal');
  assert.equal(inner(scopesOf(lines, 'server')), 'storage.modifier.server.goal');
  assert.equal(inner(scopesOf(lines, 'addNote')), 'entity.name.function.tsx');
  assert.equal(inner(scopesOf(lines, 'text')), 'variable.parameter.tsx');
  assert.equal(inner(scopesOf(lines, 'server', 3)), 'storage.modifier.server.goal');
  assert.equal(inner(scopesOf(lines, 'load')), 'entity.name.function.tsx');
});

test('{if} in markup: keywords, and markup right after the condition and after else', { skip }, async () => {
  const lines = await tokenize(
    'const x = <p>{if (n >= 10) <b>big</b> else if (n < 0) <i>neg</i> else <Small kind="x" />}</p>;\n' +
      'const y = <button aria-expanded={if (open) "true" else "false"}>{if (open) <span>a</span>}</button>;',
  );
  const tokens = lines[0];
  const ifs = tokens.filter((t) => t.text === 'if' || t.text === 'else');
  assert.equal(ifs.length, 4);
  for (const t of ifs) assert.equal(inner(t.scopes), 'keyword.control.conditional.goal');
  for (const tag of ['b', 'i']) assert.equal(inner(scopesOf(lines, tag)), 'entity.name.tag.tsx');
  assert.equal(inner(scopesOf(lines, 'Small')), 'support.class.component.tsx');
  assert.equal(inner(scopesOf(lines, '<', 0)), 'punctuation.definition.tag.begin.tsx');
  // n < 0 in the condition is still a comparison
  assert.ok(tokens.some((t) => t.text === '<' && inner(t.scopes) === 'keyword.operator.relational.tsx'));
  // in an attribute value, and with no else
  assert.equal(inner(scopesOf(lines, 'if', 1)), 'keyword.control.conditional.goal');
  assert.equal(inner(scopesOf(lines, 'span', 1)), 'entity.name.tag.tsx');
});

test('{if} over several lines, and a real if statement in a list callback', { skip }, async () => {
  const lines = await tokenize(
    [
      'const x = <ul>',
      '  {if (items.length)',
      '    <p>many</p>',
      '  else',
      '    <p>none</p>}',
      '  {items.map((x) => {',
      '    if (x.done) return <s>{x.t}</s>;',
      '    else if (x.a) { return <b>a</b>; }',
      '    return <li>{x.t}</li>;',
      '  })}',
      '  <p>{elsewhere} {ifx} {a < b ? 1 : 2}</p>',
      '</ul>;',
    ].join('\n'),
  );
  assert.equal(inner(scopesOf(lines, 'else', 3)), 'keyword.control.conditional.goal');
  assert.equal(inner(scopesOf(lines, 'p', 4)), 'entity.name.tag.tsx');
  for (const i of [6, 7, 8]) assert.equal(inner(scopesOf(lines, 'return', i)), 'keyword.control.flow.tsx');
  for (const tag of ['s', 'b', 'li']) assert.equal(inner(scopesOf(lines, tag, 6)), 'entity.name.tag.tsx');
  assert.equal(inner(scopesOf(lines, 'elsewhere', 10)), 'variable.other.readwrite.tsx');
  assert.equal(inner(scopesOf(lines, 'ifx', 10)), 'variable.other.readwrite.tsx');
  assert.ok(lines[10].some((t) => t.text.trim() === '<' && inner(t.scopes) === 'keyword.operator.relational.tsx'));
  assert.equal(inner(scopesOf(lines, 'ul', 11)), 'entity.name.tag.tsx');
});

test('keyed lists, components, children and function props in markup', { skip }, async () => {
  const lines = await tokenize(
    'const a = <ul>{if (open) items.map((x) => <li key={x.id}>{x.text}</li>) else <li>Closed</li>}</ul>;\n' +
      'const b = <div>{if (open) <Counter start={n} />}<Card title="t"><p>kid</p></Card><Picker onpick={(v) => (picked = v)} /></div>;',
  );
  assert.equal(inner(scopesOf(lines, 'map')), 'entity.name.function.tsx');
  assert.equal(inner(scopesOf(lines, 'key')), 'entity.other.attribute-name.tsx');
  assert.equal(inner(scopesOf(lines, 'else')), 'keyword.control.conditional.goal');
  assert.equal(inner(lines[0].filter((t) => t.text === 'li').at(-1).scopes), 'entity.name.tag.tsx');
  for (const c of ['Counter', 'Card', 'Picker']) assert.equal(inner(scopesOf(lines, c, 1)), 'support.class.component.tsx');
  assert.equal(inner(scopesOf(lines, 'kid', 1)), 'meta.jsx.children.tsx');
  assert.equal(inner(scopesOf(lines, 'onpick', 1)), 'entity.other.attribute-name.tsx');
  assert.equal(inner(scopesOf(lines, '=>', 1)), 'storage.type.function.arrow.tsx');
});

const STRICT = `#strict
export type Note = { id: number, text?: string; done: boolean };
type Pick = (n: number) => void;
type Tone = "odd" | "even" | null;

export server function addNote(text: string): Note[] {
  return [];
}

export function Counter({ start, onpick }: { start: number, onpick?: Pick }): Markup {
  var count: number = start;
  const notes: Note[] = [];
  return <div onclick={(e: unknown) => count++}>{if (count > 9) <b>big</b> else <i>{notes.length}</i>}</div>;
}

route GET /users/{id: number}/posts/{slug:string} {
  return <main>{id}</main>;
}`;

test('#strict, on the first line only', { skip }, async () => {
  const lines = await tokenize(STRICT);
  assert.equal(lines[0][0].text, '#strict');
  assert.equal(inner(lines[0][0].scopes), 'keyword.control.directive.strict.goal');
  const later = await tokenize('const a = 1;\n#strict');
  assert.ok(!later[1].some((t) => t.scopes.some((s) => s.endsWith('strict.goal'))));
});

test('types in a #strict file: declarations and annotations', { skip }, async () => {
  const lines = await tokenize(STRICT);
  assert.equal(inner(scopesOf(lines, 'type', 1)), 'storage.type.type.tsx');
  assert.equal(inner(scopesOf(lines, 'Note', 1)), 'entity.name.type.alias.tsx');
  assert.equal(inner(scopesOf(lines, 'boolean', 1)), 'support.type.primitive.tsx');
  assert.equal(inner(scopesOf(lines, '?', 1)), 'keyword.operator.optional.tsx');
  assert.equal(inner(scopesOf(lines, '|', 3)), 'keyword.operator.type.tsx');
  // a server function's parameter and result, with goal's `server` still marked
  assert.equal(inner(scopesOf(lines, 'server', 5)), 'storage.modifier.server.goal');
  assert.equal(inner(scopesOf(lines, 'addNote', 5)), 'entity.name.function.tsx');
  assert.equal(inner(lines[5].find((t) => t.text === 'Note').scopes), 'entity.name.type.tsx');
  // props, state, computed values and an arrow's parameter
  assert.equal(inner(scopesOf(lines, 'Markup', 9)), 'entity.name.type.tsx');
  assert.equal(inner(scopesOf(lines, 'Pick', 9)), 'entity.name.type.tsx');
  assert.equal(inner(lines[10].find((t) => t.text === 'number').scopes), 'support.type.primitive.tsx');
  assert.equal(inner(scopesOf(lines, 'unknown', 12)), 'support.type.primitive.tsx');
  // markup and {if} are unchanged
  assert.equal(inner(scopesOf(lines, 'if', 12)), 'keyword.control.conditional.goal');
  assert.equal(inner(scopesOf(lines, 'b', 12)), 'entity.name.tag.tsx');
  for (const t of lines.flat()) assert.ok(!t.scopes.some((s) => s.startsWith('invalid')), JSON.stringify(t));
});

test('route parameters with a type: string or number', { skip }, async () => {
  const lines = await tokenize(STRICT);
  const route = lines[15];
  const scope = (text) => inner(route.find((t) => t.text.trim() === text).scopes);
  assert.equal(scope('id'), 'variable.parameter.route.goal');
  assert.equal(scope('number'), 'support.type.primitive.goal');
  assert.equal(scope('slug'), 'variable.parameter.route.goal');
  assert.equal(scope('string'), 'support.type.primitive.goal');
  assert.equal(route.filter((t) => t.text === ':').length, 2);
  assert.equal(inner(scopesOf(lines, 'return', 16)), 'keyword.control.flow.tsx');
  const bad = await tokenize('route GET /x/{n: Note}/{m:numbers} {\n}');
  for (const name of ['Note', 'numbers']) assert.equal(inner(scopesOf(bad, name)), 'invalid.illegal.route-parameter-type.goal');
});

test('the example apps tokenize with nothing invalid, and close every block', { skip }, async () => {
  for (const file of EXAMPLES) {
    const f = relative(EXAMPLES_DIR, file);
    const lines = await tokenize(readFileSync(file, 'utf8'));
    for (const t of lines.flat()) assert.ok(!t.scopes.some((s) => s.startsWith('invalid')), `${f}: ${JSON.stringify(t)}`);
    const last = lines.filter((l) => l.some((t) => t.text.trim())).at(-1);
    assert.equal(last.at(-1).text, '}', f);
  }
});
