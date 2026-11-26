// ESLint for .goal files:
//
//   // eslint.config.js
//   import goal from 'goaljs/eslint';
//   export default [js.configs.recommended, ...goal.configs.recommended];
//
// ESLint checks the JavaScript each .goal file becomes (see syntax.js): routes as functions, {if} as
// ternaries, types taken out, a route's path parameters as its function's. A problem is reported
// where it is in the .goal file, and a fix is kept when the text it changes is the file's own.
// Problems in code goal.js wrote, like a route's parameters, aren't the file's and are left out. A
// file that doesn't parse gets its parse error.

import { desugar } from './syntax.js';

const seen = new Map(); // by file: what preprocess made of it, for postprocess

/** Where each line starts. */
const starts = (text) => {
  const s = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') s.push(i + 1);
  return s;
};

const processor = {
  meta: { name: 'goal' },
  supportsAutofix: true,
  preprocess(text, file) {
    try {
      const r = desugar(text, file);
      // The compiler declares a route's path parameters in its function; here they're its parameters.
      let code = r.code;
      const added = [];
      for (const route of r.routes.filter((x) => x.params.length)) {
        const at = code.indexOf(`${route.name}(request, _$x`) + route.name.length + 13;
        const ins = `, { ${route.params.join(', ')} }`;
        code = code.slice(0, at) + ins + code.slice(at);
        added.push({ at, length: ins.length });
      }
      seen.set(file, { text, code, map: r.map, added, from: starts(code), to: starts(text) });
      return [{ text: code, filename: 'goal.jsx' }];
    } catch (e) {
      seen.set(file, { error: e });
      return [];
    }
  },
  postprocess([messages = []], file) {
    const f = seen.get(file);
    seen.delete(file);
    if (f.error) return [{ ruleId: null, fatal: true, severity: 2, message: f.error.message.replace(/^.*?:\d+:\d+: /, ''), line: f.error.line, column: f.error.column }];
    // From a place in what ESLint saw, to one in the desugared code (-1 in a path parameter added)
    const desugared = (o) => {
      let d = 0;
      for (const a of f.added) {
        if (o < a.at) break;
        if (o < a.at + a.length) return -1;
        d += a.length;
      }
      return o - d;
    };
    const at = (line, column) => f.map(desugared(f.from[line - 1] + column - 1));
    const ours = (line, column) => {
      const o = desugared(f.from[line - 1] + column - 1);
      return o < 0 || f.map(o) === f.map(o + 1); // goal.js's code maps to one place
    };
    const place = (o) => {
      const line = f.to.findLastIndex((s) => s <= o);
      return { line: line + 1, column: o - f.to[line] + 1 };
    };
    // A fix or suggestion over the file's own text, at its place in the file
    const fix = (x) => {
      const [a, b] = x.range.map((o) => f.map(desugared(o)));
      return f.text.slice(a, b) === f.code.slice(...x.range) ? { range: [a, b], text: x.text } : undefined;
    };
    return messages
      .filter((m) => !m.line || !ours(m.line, m.column))
      .map((m) => {
        if (!m.line) return m;
        const out = { ...m, ...place(at(m.line, m.column)) };
        if (m.endLine) {
          const end = place(at(m.endLine, m.endColumn));
          out.endLine = end.line;
          out.endColumn = end.column;
        }
        if (m.fix) out.fix = fix(m.fix);
        if (m.suggestions) out.suggestions = m.suggestions.map((s) => ({ ...s, fix: fix(s.fix) })).filter((s) => s.fix);
        if (!out.fix) delete out.fix;
        return out;
      });
  },
};

const plugin = { meta: { name: 'goaljs' }, processors: { goal: processor }, configs: {} };

plugin.configs.recommended = [
  { files: ['**/*.goal'], plugins: { goal: plugin }, processor: 'goal/goal' },
  {
    files: ['**/*.goal/*.jsx'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { redirect: 'readonly', json: 'readonly', notFound: 'readonly', cookie: 'readonly', call: 'readonly' }, // a route's helpers, and a component's call()
    },
    rules: { 'no-var': 'off' }, // var is a component's state
  },
];

export default plugin;
