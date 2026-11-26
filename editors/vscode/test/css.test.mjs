import { test } from 'node:test';
import assert from 'node:assert/strict';
import css from '../src/css.js';

const { styleBlock, cssOnly } = css;
const inner = (text) => {
  const b = styleBlock(text);
  return b && text.slice(b.start, b.end);
};

test('styleBlock: the CSS of `style {` at the start of a line, to its own }', () => {
  const card = '\n  .card { border: 1px solid #ccc; }\n  @media (min-width: 1px) { p { margin: 0 } }\n';
  assert.equal(inner(`style {${card}}\nexport function A() { return <p />; }`), card);
  assert.equal(inner(`import x from './x.js';\n\n  style{${card}}`), card);
  // braces in strings and comments don't count, as in goal.js's syntax.js
  const tricky = ' .a::after { content: "}"; } .b { content: \'{\\\'}\'; } /* } { */ ';
  assert.equal(inner(`style {${tricky}}\nconst b = 1;`), tricky);
  // one that doesn't close yet goes to the end, as you type it
  assert.equal(inner('style {\n  .a { color: re'), '\n  .a { color: re');
  assert.equal(inner('style {\n  /* no end'), '\n  /* no end');
  // not a name or a property, not in the middle of a line
  for (const text of ['const style = { a: 1 };', 'style.a = {};', 'styles {}', 'const x = 1; style {}', 'export function A() { return <p style="a" />; }'])
    assert.equal(styleBlock(text), null, text);
});

test('cssOnly: only the CSS left, at the same places', () => {
  const text = 'style {\r\n  .a { color: red; }\r\n}\r\nexport function A() {\n  return <p class="a">x</p>;\n}\n';
  const copy = cssOnly(text, styleBlock(text));
  assert.equal(copy.length, text.length);
  assert.deepEqual(copy.split(/\r\n|\n/).map((l) => l.length), text.split(/\r\n|\n/).map((l) => l.length));
  assert.equal(copy.trim(), '.a { color: red; }');
  assert.equal(copy.indexOf('color'), text.indexOf('color'));
});
