// The .goal syntax on top of JavaScript and JSX:
//
//   route GET /users/{id} { ... }                       a route, at the top level of a file
//   {if (a) <p>A</p> else if (b) <p>B</p> else <p>C</p>}  if/else as a value, inside markup
//   server function addNote(text) { ... }              runs on the server, called from the browser
//   #strict, then name: Type and type Note = { ... }    types, in a file that starts with #strict
//
// desugar() parses the file with acorn (extended for these two forms), and rewrites them into plain
// JavaScript + JSX with small text edits: a route becomes `async function _$r0(request, _$x) { ... }`
// an if becomes a chain of ternaries, and a server function becomes an async function. `map` turns a position in the output back into one in the
// source, so errors point at what the author wrote. Types are read into `types` and taken out of the
// code (see types.js, which checks them).

import { Parser, tokTypes as tt } from 'acorn';
import jsx from 'acorn-jsx';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const SERVER = /^server[ \t]+function[ \t]+([A-Za-z_$][\w$]*)/;
const SEGMENT = /^(?:[A-Za-z0-9\-._~]+|\{[A-Za-z_][A-Za-z0-9_]*(?:[ \t]*:[ \t]*(?:string|number))?\})$/;
const STRICT = /^\s*#strict[ \t]*(?=\r?\n|$)/;
const BASIC = new Set(['string', 'number', 'boolean', 'unknown', 'Markup', 'undefined']);

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
 * @returns {{ code: string, routes: { method: string, path: string, params: string[], types: object, name: string }[],
 *   serverFns: { name: string, exported: boolean }[], map: (pos: number) => number, strict: boolean,
 *   types: { decls: Map<string, { type: object, exported: boolean, at: number }>, at: Map<number, object> } }}
 *   types.at: the type written for the binding or function that starts at that source position
 */
export function desugar(source, file) {
  const edits = [];
  const routes = [];
  const serverFns = [];
  const types = { decls: new Map(), at: new Map() };
  const fail = (pos, message) => {
    throw errorAt(source, file, pos, message);
  };
  const s = STRICT.exec(source);
  const strict = !!s;
  if (s) edits.push({ at: s.index + s[0].indexOf('#'), del: 7, ins: '' });
  const input = s ? source.slice(0, s.index) + s[0].replace('#strict', '       ') + source.slice(s.index + s[0].length) : source;

  class GoalParser extends Base {
    isServerFn() {
      return this.type === tt.name && this.value === 'server' && SERVER.test(this.input.slice(this.start));
    }

    shouldParseExportStatement() {
      if (this.isTypeDecl()) {
        this.goalExportAt = this.lastTokStart; // the export keyword goes with the declaration
        return true;
      }
      if (!this.isServerFn()) return super.shouldParseExportStatement();
      this.goalExport = true;
      return true;
    }

    isTypeDecl() {
      return this.type === tt.name && this.value === 'type' && /^type[ \t]+[A-Za-z_$][\w$]*[ \t]*=/.test(this.input.slice(this.start));
    }

    // Types: read into `types`, and taken out of the code.
    typed(at) {
      if (!strict) fail(at, 'types go in a #strict file: put #strict on the first line');
    }

    goalAnnotation(at) {
      this.typed(this.start);
      const from = this.start;
      this.next();
      types.at.set(at, this.goalType());
      edits.push({ at: from, del: this.lastTokEnd - from, ins: '' });
    }

    parseBindingAtom() {
      const node = super.parseBindingAtom();
      if (this.type === tt.colon) this.goalAnnotation(node.start);
      return node;
    }

    parseFunctionParams(node) {
      super.parseFunctionParams(node);
      if (this.type === tt.colon) this.goalAnnotation(-node.start - 1); // a function's result: keyed apart from its name
    }

    parseParenItem(item) {
      if (this.type === tt.colon) this.goalAnnotation(item.start); // an arrow function's parameter
      return item;
    }

    goalTypeDecl() {
      const at = this.goalExportAt ?? this.start;
      const exported = this.goalExportAt !== undefined;
      this.goalExportAt = undefined;
      this.typed(at);
      const node = this.startNode();
      this.next();
      node.id = this.parseIdent();
      if (types.decls.has(node.id.name)) fail(node.id.start, `the type ${node.id.name} is declared twice`);
      this.expect(tt.eq);
      types.decls.set(node.id.name, { type: this.goalType(), exported, at: node.id.start });
      this.eat(tt.semi);
      edits.push({ at, del: this.lastTokEnd - at, ins: '' });
      return this.finishNode(node, 'GoalType');
    }

    // T | U, T[], string, 'a', { name: T, other?: U }, (x: T) => U, (T), a declared name
    goalType() {
      const of = [this.goalList()];
      while (this.eat(tt.bitwiseOR)) of.push(this.goalList());
      return of.length > 1 ? { k: 'union', of } : of[0];
    }

    goalList() {
      let t = this.goalPrimary();
      while (this.type === tt.bracketL && this.input[this.end] === ']') {
        this.next();
        this.next();
        t = { k: 'array', of: t };
      }
      return t;
    }

    goalPrimary() {
      const at = this.start;
      const v = this.value;
      if (this.eat(tt.string)) return { k: 'lit', v };
      if (this.eat(tt.num)) return { k: 'lit', v };
      if (this.eat(tt._true) || this.eat(tt._false)) return { k: 'lit', v: v === 'true' };
      if (this.eat(tt._null)) return { k: 'null' };
      if (this.eat(tt._void)) return { k: 'void' }; // what a function that returns nothing gives
      if (this.eat(tt.name)) return BASIC.has(v) ? { k: v } : { k: 'ref', name: v, at };
      if (this.eat(tt.braceL)) {
        const fields = {};
        while (!this.eat(tt.braceR)) {
          const name = this.value;
          if (this.type !== tt.name && this.type !== tt.string && !this.type.keyword) fail(this.start, 'write a field as name: type');
          this.next();
          const optional = this.eat(tt.question);
          this.expect(tt.colon);
          fields[name] = { type: this.goalType(), optional };
          if (!this.eat(tt.comma) && !this.eat(tt.semi) && this.type !== tt.braceR) fail(this.start, 'separate the fields with commas');
        }
        return { k: 'object', fields };
      }
      if (this.eat(tt.parenL)) {
        if (this.type === tt.parenR || (this.type === tt.name && /^[A-Za-z_$][\w$]*\s*\??\s*:/.test(this.input.slice(this.start)))) {
          const params = [];
          while (!this.eat(tt.parenR)) {
            this.next(); // the parameter's name: only its type matters
            const optional = this.eat(tt.question);
            this.expect(tt.colon);
            params.push({ type: this.goalType(), optional });
            if (this.type !== tt.parenR) this.expect(tt.comma);
          }
          this.expect(tt.arrow);
          return { k: 'fn', params, returns: this.goalType() };
        }
        const t = this.goalType();
        this.expect(tt.parenR);
        return t;
      }
      return fail(at, 'write a type: string, number, boolean, a list like Note[], or an object like { id: number }');
    }

    parseStatement(context, topLevel, exports) {
      if (this.isTypeDecl()) {
        if (!topLevel && this.goalExportAt === undefined) fail(this.start, 'declare a type at the top level of a file');
        return this.goalTypeDecl();
      }
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
      const m = /^route[ \t]+(\S+)[ \t]+((?:\{[^}\n]*\}|[^\s{])+)[ \t]+\{/.exec(this.input.slice(start));
      if (!m) fail(start, 'write a route as: route GET /path { ... }');
      const [head, method, path] = m;
      if (!METHODS.includes(method)) fail(start, `unknown method ${method}; use ${METHODS.join(', ')}`);
      const segs = path === '/' ? [] : path.slice(1).split('/');
      if (path[0] !== '/' || !segs.every((s) => SEGMENT.test(s)))
        fail(start, `write the path with plain words and {name} parameters, like /users/{id} (not ${path})`);
      const params = segs.filter((s) => s[0] === '{').map((s) => s.slice(1, -1).split(':')[0].trim());
      const typed = segs.filter((s) => s.includes(':'));
      if (typed.length) this.typed(start);
      const types = Object.fromEntries(typed.map((s) => s.slice(1, -1).split(':').map((x) => x.trim())));
      for (const [i, p] of params.entries()) {
        if (params.indexOf(p) !== i) fail(start, `the path names {${p}} twice`);
        if (p === 'request') fail(start, 'name the path parameter something other than {request}');
      }
      const name = `_$r${routes.length}`;
      routes.push({ method, path: path.replace(/\{([A-Za-z0-9_]+)[^}]*\}/g, '{$1}'), params, types, name });
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
    GoalParser.parse(input, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
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
  return { code, routes, serverFns, map, strict, types };
}
