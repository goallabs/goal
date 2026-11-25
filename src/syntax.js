// The .goal syntax on top of JavaScript and JSX:
//
//   route GET /users/{id} { ... }                       a route, at the top level of a file
//   {if (a) <p>A</p> else if (b) <p>B</p> else <p>C</p>}  if/else as a value, inside markup
//   server function addNote(text) { ... }              runs on the server, called from the browser
//
// desugar() parses the file with acorn (extended for these two forms), and rewrites them into plain
// JavaScript + JSX with small text edits: a route becomes `async function _$r0(request, _$x) { ... }`
// an if becomes a chain of ternaries, and a server function becomes an async function. `map` turns a position in the output back into one in the
// source, so errors point at what the author wrote.

import { Parser, tokTypes as tt } from 'acorn';
import jsx from 'acorn-jsx';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const SERVER = /^server[ \t]+function[ \t]+([A-Za-z_$][\w$]*)/;
const SEGMENT = /^(?:[A-Za-z0-9\-._~]+|\{[A-Za-z_][A-Za-z0-9_]*\})$/;

export class GoalError extends Error {
  constructor(message, file, line, column) {
    super(`${file}:${line}:${column}: ${message}`);
    this.name = 'GoalError';
    this.file = file;
    this.line = line;
    this.column = column;
  }
}

/** A GoalError at an offset in the source. */
export function errorAt(source, file, pos, message) {
  const before = source.slice(0, pos).split('\n');
  return new GoalError(message, file, before.length, before.at(-1).length + 1);
}

const Base = Parser.extend(jsx());

/**
 * @returns {{ code: string, routes: { method: string, path: string, params: string[], name: string }[],
 *   serverFns: { name: string, exported: boolean }[], map: (pos: number) => number }}
 */
export function desugar(source, file) {
  const edits = [];
  const routes = [];
  const serverFns = [];
  const fail = (pos, message) => {
    throw errorAt(source, file, pos, message);
  };

  class GoalParser extends Base {
    isServerFn() {
      return this.type === tt.name && this.value === 'server' && SERVER.test(this.input.slice(this.start));
    }

    shouldParseExportStatement() {
      if (!this.isServerFn()) return super.shouldParseExportStatement();
      this.goalExport = true;
      return true;
    }

    parseStatement(context, topLevel, exports) {
      if (this.isServerFn()) {
        if (!topLevel && !this.goalExport) fail(this.start, 'declare a server function at the top level of a file');
        serverFns.push({ name: SERVER.exec(this.input.slice(this.start))[1], exported: !!this.goalExport });
        this.goalExport = false;
        edits.push({ at: this.start, del: 6, ins: 'async' });
        const node = this.startNode();
        this.next();
        return this.parseFunctionStatement(node, true, true);
      }
      if (topLevel && this.type === tt.name && this.value === 'route' && /^route[ \t]+[A-Z]/.test(this.input.slice(this.start)))
        return this.goalRoute();
      return super.parseStatement(context, topLevel, exports);
    }

    goalRoute() {
      const start = this.start;
      const m = /^route[ \t]+(\S+)[ \t]+(\S+)[ \t]+\{/.exec(this.input.slice(start));
      if (!m) fail(start, 'write a route as: route GET /path { ... }');
      const [head, method, path] = m;
      if (!METHODS.includes(method)) fail(start, `unknown method ${method}; use ${METHODS.join(', ')}`);
      const segs = path === '/' ? [] : path.slice(1).split('/');
      if (path[0] !== '/' || !segs.every((s) => SEGMENT.test(s)))
        fail(start, `write the path with plain words and {name} parameters, like /users/{id} (not ${path})`);
      const params = segs.filter((s) => s[0] === '{').map((s) => s.slice(1, -1));
      for (const [i, p] of params.entries()) {
        if (params.indexOf(p) !== i) fail(start, `the path names {${p}} twice`);
        if (p === 'request') fail(start, 'name the path parameter something other than {request}');
      }
      const name = `_$r${routes.length}`;
      routes.push({ method, path, params, name });
      const brace = start + head.length - 1;
      edits.push({ at: start, del: brace - start, ins: `async function ${name}(request, _$x) ` });
      const node = this.startNode();
      this.pos = brace;
      this.next();
      this.enterScope(2 | 4); // an async function's scope (acorn's SCOPE_FUNCTION | SCOPE_ASYNC)
      node.body = this.parseBlock(false);
      this.exitScope();
      return this.finishNode(node, 'GoalRoute');
    }

    jsx_parseExpressionContainer() {
      const node = this.startNode();
      this.next();
      if (this.type === tt._if) node.expression = this.goalIf();
      else node.expression = this.type === tt.braceR ? this.jsx_parseEmptyExpression() : this.parseExpression();
      this.expect(tt.braceR);
      return this.finishNode(node, 'JSXExpressionContainer');
    }

    // if (a) X else if (b) Y else Z   ->   (a) ? (X) : (b) ? (Y) : (Z)
    goalIf() {
      const node = this.startNode();
      edits.push({ at: this.start, del: 2, ins: '' });
      this.next();
      this.parseParenExpression();
      edits.push({ at: this.lastTokEnd, del: 0, ins: ' ? (' });
      this.parseMaybeAssign();
      const end = this.lastTokEnd;
      if (this.type === tt._else) {
        edits.push({ at: end, del: 0, ins: ')' });
        edits.push({ at: this.start, del: 4, ins: ':' });
        this.next();
        if (this.type === tt._if) this.goalIf();
        else {
          edits.push({ at: this.start, del: 0, ins: '(' });
          this.parseMaybeAssign();
          edits.push({ at: this.lastTokEnd, del: 0, ins: ')' });
        }
      } else edits.push({ at: end, del: 0, ins: ') : null' });
      return this.finishNode(node, 'GoalIf');
    }
  }

  try {
    GoalParser.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  } catch (e) {
    if (e instanceof GoalError) throw e;
    fail(e.pos, e.message.replace(/ \(\d+:\d+\)$/, ''));
  }

  edits.sort((a, b) => a.at - b.at);
  let code = '';
  let last = 0;
  for (const e of edits) {
    code += source.slice(last, e.at) + e.ins;
    last = e.at + e.del;
  }
  code += source.slice(last);

  const map = (pos) => {
    let shift = 0;
    for (const e of edits) {
      const at = e.at + shift;
      if (pos < at) break;
      if (pos < at + e.ins.length) return e.at;
      shift += e.ins.length - e.del;
    }
    return pos - shift;
  };
  return { code, routes, serverFns, map };
}
