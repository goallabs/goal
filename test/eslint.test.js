import { describe, it, expect } from 'vitest';
import goal from '../src/eslint.js';

const { preprocess, postprocess } = goal.processors.goal;

const SRC = `import { Counter } from './Counter.goal';
export function A() {
  var n = 0;
  let x = 1;
  return <p onclick={() => n++}>{if (n) <b>{n}</b> else <i>{missing}</i>}</p>;
}
route GET /u/{id}/{name} {
  return redirect('/' + name);
}
route GET / { return 1; }
`;

/** Where the text is, in what ESLint sees (`nth` time it's there), as ESLint gives it: line and column from 1. */
function at(code, text, nth = 0) {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = code.indexOf(text, i + 1);
  const before = code.slice(0, i).split('\n');
  return { line: before.length, column: before.at(-1).length + 1, i };
}
const place = ({ line, column }) => ({ line, column });

/** The same, in the .goal source. */
const inSource = (text, nth) => place(at(SRC, text, nth));

describe('ESLint for .goal files', () => {
  it("gives ESLint the file's JavaScript, with a route's path parameters as its function's", () => {
    const [block] = preprocess(SRC, 'A.goal');
    expect(block.filename).toBe('goal.jsx');
    expect(block.text).toContain('async function _$r0(request, _$x, { id, name }) {');
    expect(block.text).toContain('async function _$r1(request, _$x) {');
    expect(block.text).toContain('(n) ?');
    postprocess([[]], 'A.goal');
  });

  it("reports each problem where it is in the .goal file, and leaves out goal.js's own code", () => {
    const code = preprocess(SRC, 'A.goal')[0].text;
    const missing = at(code, 'missing');
    const end = at(code, '}</i>');
    const x = at(code, 'let x');
    const cond = at(code, '(n) ?');
    const out = postprocess(
      [
        [
          { ruleId: 'no-undef', message: "'missing' is not defined.", ...place(missing), endLine: end.line, endColumn: end.column },
          { ruleId: 'prefer-const', message: "'x' is never reassigned.", ...place(at(code, 'x = 1')), fix: { range: [x.i, x.i + 3], text: 'const' } },
          { ruleId: 'no-unused-vars', message: "'request' is defined but never used.", ...place(at(code, 'request')) }, // goal.js wrote it
          { ruleId: 'no-unused-vars', message: "'id' is defined but never used.", ...place(at(code, 'id, name }')) }, // the path parameter added
          { ruleId: 'x', message: 'over an {if}', ...place(cond), fix: { range: [cond.i - 1, cond.i + 6], text: '' }, suggestions: [{ desc: 'no', fix: { range: [cond.i - 1, cond.i + 6], text: '' } }, { desc: 'yes', fix: { range: [x.i, x.i + 3], text: 'const' } }] },
          { ruleId: 'x', message: 'after the path parameters', ...place(at(code, "'/' + name")) },
          { ruleId: null, message: 'about the file' },
        ],
      ],
      'A.goal',
    );
    expect(out).toEqual([
      { ruleId: 'no-undef', message: "'missing' is not defined.", ...inSource('missing'), endLine: inSource('}</i>').line, endColumn: inSource('}</i>').column },
      { ruleId: 'prefer-const', message: "'x' is never reassigned.", ...inSource('x = 1'), fix: { range: [SRC.indexOf('let x'), SRC.indexOf('let x') + 3], text: 'const' } },
      { ruleId: 'x', message: 'over an {if}', ...inSource('(n)'), suggestions: [{ desc: 'yes', fix: { range: [SRC.indexOf('let x'), SRC.indexOf('let x') + 3], text: 'const' } }] }, // the fix over goal.js's code is left out
      { ruleId: 'x', message: 'after the path parameters', ...inSource("'/' + name") },
      { ruleId: null, message: 'about the file' },
    ]);
  });

  it("gives a file that doesn't parse its parse error", () => {
    expect(preprocess('route GET / {\n  return <p>{if (x) <b/> el <i/>}</p>;\n}\n', 'B.goal')).toEqual([]);
    expect(postprocess([], 'B.goal')).toEqual([{ ruleId: null, fatal: true, severity: 2, message: 'Unexpected token', line: 2, column: 26 }]);
  });

  it('comes with a config: .goal files through the processor, JSX, the route helpers, var allowed', () => {
    const [files, blocks] = goal.configs.recommended;
    expect(files).toEqual({ files: ['**/*.goal'], plugins: { goal }, processor: 'goal/goal' });
    expect(blocks.files).toEqual(['**/*.goal/*.jsx']);
    expect(blocks.languageOptions.parserOptions.ecmaFeatures.jsx).toBe(true);
    expect(Object.keys(blocks.languageOptions.globals)).toEqual(['redirect', 'json', 'notFound', 'cookie', 'reply', 'stream', 'events', 'call']);
    expect(blocks.rules['no-var']).toBe('off');
  });
});

describe('ESLint and style blocks', () => {
  it("leaves the CSS out, and reports what's after it where it is", () => {
    const src = "style {\n  .a { color: red; }\n  b { margin: 0 }\n}\nexport function A() {\n  return <p>{missing}</p>;\n}\n";
    const [block] = preprocess(src, 'S.goal');
    expect(block.text).not.toContain('color');
    const w = at(block.text, 'missing');
    const [m] = postprocess([[{ ruleId: 'no-undef', message: "'missing' is not defined.", line: w.line, column: w.column, endLine: w.line, endColumn: w.column + 7 }]], 'S.goal');
    expect(place(m)).toEqual(place(at(src, 'missing')));
    expect([m.endLine, m.endColumn]).toEqual([6, 21]);
  });
});
