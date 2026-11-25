import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize, scopesOf, JSX_GRAMMAR } from './tokens.mjs';

const DEMO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', 'demo');
const skip = JSX_GRAMMAR ? false : "VS Code's JavaScriptReact grammar wasn't found (set GOAL_JSX_GRAMMAR)";
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
  assert.equal(inner(scopesOf(lines, 'return', 1)), 'keyword.control.flow.js.jsx');
  assert.equal(inner(scopesOf(lines, 'main', 1)), 'entity.name.tag.js.jsx');
});

test('route: only as a statement, not in strings, comments or markup', { skip }, async () => {
  const lines = await tokenize('const s = `\nroute GET /x {`;\n// route GET /y {\nconst m = <p>\nroute GET /z {\n</p>;');
  for (const l of lines) for (const t of l) assert.ok(!t.scopes.some((s) => s.endsWith('route.goal')), JSON.stringify(t));
});

test('server function, exported or not', { skip }, async () => {
  const lines = await tokenize('export server function addNote(text) {\n  return text;\n}\nserver function load() {}');
  assert.equal(inner(scopesOf(lines, 'export')), 'keyword.control.export.goal');
  assert.equal(inner(scopesOf(lines, 'server')), 'storage.modifier.server.goal');
  assert.equal(inner(scopesOf(lines, 'addNote')), 'entity.name.function.js.jsx');
  assert.equal(inner(scopesOf(lines, 'text')), 'variable.parameter.js.jsx');
  assert.equal(inner(scopesOf(lines, 'server', 3)), 'storage.modifier.server.goal');
  assert.equal(inner(scopesOf(lines, 'load')), 'entity.name.function.js.jsx');
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
  for (const tag of ['b', 'i']) assert.equal(inner(scopesOf(lines, tag)), 'entity.name.tag.js.jsx');
  assert.equal(inner(scopesOf(lines, 'Small')), 'support.class.component.js.jsx');
  assert.equal(inner(scopesOf(lines, '<', 0)), 'punctuation.definition.tag.begin.js.jsx');
  // n < 0 in the condition is still a comparison
  assert.ok(tokens.some((t) => t.text === '<' && inner(t.scopes) === 'keyword.operator.relational.js.jsx'));
  // in an attribute value, and with no else
  assert.equal(inner(scopesOf(lines, 'if', 1)), 'keyword.control.conditional.goal');
  assert.equal(inner(scopesOf(lines, 'span', 1)), 'entity.name.tag.js.jsx');
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
  assert.equal(inner(scopesOf(lines, 'p', 4)), 'entity.name.tag.js.jsx');
  for (const i of [6, 7, 8]) assert.equal(inner(scopesOf(lines, 'return', i)), 'keyword.control.flow.js.jsx');
  for (const tag of ['s', 'b', 'li']) assert.equal(inner(scopesOf(lines, tag, 6)), 'entity.name.tag.js.jsx');
  assert.equal(inner(scopesOf(lines, 'elsewhere', 10)), 'variable.other.readwrite.js.jsx');
  assert.equal(inner(scopesOf(lines, 'ifx', 10)), 'variable.other.readwrite.js.jsx');
  assert.ok(lines[10].some((t) => t.text.trim() === '<' && inner(t.scopes) === 'keyword.operator.relational.js.jsx'));
  assert.equal(inner(scopesOf(lines, 'ul', 11)), 'entity.name.tag.js.jsx');
});

test('the demo app tokenizes with nothing invalid, and closes every block', { skip }, async () => {
  const files = ['app.goal', ...readdirSync(join(DEMO, 'components')).map((f) => `components/${f}`)];
  for (const f of files) {
    const lines = await tokenize(readFileSync(join(DEMO, f), 'utf8'));
    for (const t of lines.flat()) assert.ok(!t.scopes.some((s) => s.startsWith('invalid')), `${f}: ${JSON.stringify(t)}`);
    const last = lines.filter((l) => l.some((t) => t.text.trim())).at(-1);
    assert.equal(last.at(-1).text, '}', f);
  }
});
