// The .goal syntax on top of JavaScript and JSX:
//
//   route GET /users/{id} { ... }                       a route, at the top level of a file
//   group /api api { before { ... } route ... }         routes under one path, with a before block
//   {if (a) <p>A</p> else if (b) <p>B</p> else <p>C</p>}  if/else as a value, inside markup
//   server function addNote(text) { ... }              runs on the server, called from the browser
//   #strict, then name: Type and type Note = { ... }    types, in a file that starts with #strict
//   style { .card { ... } }                             the file's CSS, scoped to what it renders
//
// desugar() parses the file with acorn (extended for these two forms), and rewrites them into plain
// JavaScript + JSX with small text edits: a route becomes `async function _$r0(request, _$x) { ... }`
// an if becomes a chain of ternaries, and a server function becomes an async function. `map` turns a position in the output back into one in the
// source, so errors point at what the author wrote. Types are read into `types` and taken out of the
// code (see types.js, which checks them), and so is the style block, as text (see style.js).

import { Parser, tokTypes as tt } from 'acorn';
import jsx from 'acorn-jsx';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const INPUTS = ['json', 'query', 'form'];
const SERVER = /^server[ \t]+function[ \t]+([A-Za-z_$][\w$]*)/;
const SEGMENT = /^(?:[A-Za-z0-9\-._~]+|\{[A-Za-z_][A-Za-z0-9_]*(?:[ \t]*:[ \t]*(?:string|number))?\})$/;
const STRICT = /^\s*#strict[ \t]*(?=\r?\n|$)/;
const BASIC = new Set(['string', 'number', 'boolean', 'unknown', 'Markup', 'undefined']);

/** Where a style block's CSS, from `i`, ends: its closing brace, past nested blocks, strings and comments. */
function cssEnd(s, i) {
  for (let depth = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '*') {
      i = s.indexOf('*/', i + 2) + 1;
      if (!i) return -1;
    } else if (c === '"' || c === "'") {
      while (++i < s.length && s[i] !== c) if (s[i] === '\\') i++;
    } else if (c === '{') depth++;
    else if (c === '}' && !depth--) return i;
  }
  return -1;
}

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
const TOP = { path: '/', params: [], types: {}, api: false, before: [] }; // what a route outside any group joins

/**
 * @returns {{ code: string, routes: { method: string, path: string, params: string[], types: object, name: string, api?: string, before?: string[] }[],
 *   befores: { name: string, params: string[] }[],
 *   serverFns: { name: string, exported: boolean }[], map: (pos: number) => number, strict: boolean,
 *   style: { css: string, at: number } | null,
 *   types: { decls: Map<string, { type: object, exported: boolean, at: number }>, at: Map<number, object> } }}
 *   types.at: the type written for the binding or function that starts at that source position
 */
export function desugar(source, file) {
  const edits = [];
  const routes = [];
  const befores = []; // groups' before blocks
  const serverFns = [];
  const types = { decls: new Map(), at: new Map() };
  let style = null; // the style block: its CSS, and where that starts in the source
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
      if (topLevel && this.type === tt.name && this.value === 'group' && /^group[ \t]+\//.test(this.input.slice(this.start))) return this.goalGroup();
      if (topLevel && this.type === tt.name && this.value === 'style' && /^style[ \t]*\{/.test(this.input.slice(this.start))) return this.goalStyle();
      return super.parseStatement(context, topLevel, exports);
    }

    goalRoute(group = TOP) {
      const start = this.start;
      const m = /^route[ \t]+(\S+)[ \t]+((?:\{[^}\n]*\}|[^\s{])+)[ \t]+([{(])/.exec(this.input.slice(start));
      if (!m) fail(start, 'write a route as: route GET /path { ... }');
      const [head, method, path] = m;
      if (!METHODS.includes(method)) fail(start, `unknown method ${method}; use ${METHODS.join(', ')}`);
      const p = this.goalPath(start, path, group);
      const name = `_$r${routes.length}`;
      const input = m[3] === '(' ? this.goalInput(start, start + head.length - 1) : null;
      const length = input ? this.start + 1 - start : head.length;
      routes.push({ method, ...p, name, ...(group.api ? { api: group.api } : {}), ...(group.before.length ? { before: group.before } : {}), ...(input ? { input, at: start } : {}) });
      return this.goalHandler(start, length, name, 'GoalRoute');
    }

    // (json: Note, query: { page?: number }): the types of a route's input, which the server checks.
    // Inside the route, request has them (keyed at the route, where its request parameter maps).
    goalInput(start, paren) {
      this.typed(start);
      this.pos = paren;
      this.next();
      this.next();
      const input = {};
      while (!this.eat(tt.parenR)) {
        const key = this.value;
        if (this.type !== tt.name || !INPUTS.includes(key)) fail(this.start, 'a route takes the types of its input: (json: Note, query: { page?: number }, form: { title: string })');
        if (input[key]) fail(this.start, `the route names the type of ${key} twice`);
        this.next();
        this.expect(tt.colon);
        input[key] = this.goalType();
        if (this.type !== tt.parenR) this.expect(tt.comma);
      }
      if (this.type !== tt.braceL) fail(this.start, "the route's body goes in { } after its types");
      types.at.set(start, { k: 'object', fields: Object.fromEntries(Object.entries(input).map(([k, type]) => [k, { type, optional: false }])) });
      return input;
    }

    // A route's or group's path, joined to its group's: the full path, its parameters and their types
    goalPath(start, path, group) {
      const segs = path === '/' ? [] : path.slice(1).split('/');
      if (path[0] !== '/' || !segs.every((s) => SEGMENT.test(s)))
        fail(start, `write the path with plain words and {name} parameters, like /users/{id} (not ${path})`);
      const typed = segs.filter((s) => s.includes(':'));
      if (typed.length) this.typed(start);
      const params = [...group.params, ...segs.filter((s) => s[0] === '{').map((s) => s.slice(1, -1).split(':')[0].trim())];
      for (const [i, p] of params.entries()) {
        if (params.indexOf(p) !== i) fail(start, `the path names {${p}} twice`);
        if (p === 'request') fail(start, 'name the path parameter something other than {request}');
      }
      const own = path === '/' ? '' : path.replace(/\{([A-Za-z0-9_]+)[^}]*\}/g, '{$1}');
      const full = group.path === '/' ? own || '/' : group.path + own;
      return { path: full, params, types: { ...group.types, ...Object.fromEntries(typed.map((s) => s.slice(1, -1).split(':').map((x) => x.trim()))) } };
    }

    // The body of a route or a group's before block: a function that runs on the server per request
    goalHandler(start, length, name, type) {
      const brace = start + length - 1;
      edits.push({ at: start, del: brace - start, ins: `async function ${name}(request, _$x) ` });
      const node = this.startNode();
      this.pos = brace;
      this.next();
      this.enterScope(2 | 4); // an async function's scope (acorn's SCOPE_FUNCTION | SCOPE_ASYNC)
      node.body = this.parseBlock(false);
      this.exitScope();
      return this.finishNode(node, type);
    }

    // group /path api { before { ... } route ... group ... }: routes under one path, which share a
    // before block (run first, outer groups' first) and, with api, take requests from other programs
    goalGroup(outer = TOP) {
      const start = this.start;
      const m = /^group[ \t]+((?:\{[^}\n]*\}|[^\s{])+)(?:[ \t]+(api))?[ \t]*\{/.exec(this.input.slice(start));
      if (!m) fail(start, 'write a group as: group /path { routes }, or group /path api { routes }');
      const group = { ...this.goalPath(start, m[1], outer), before: outer.before };
      group.api = outer.api || (!!m[2] && group.path); // the path of the api group: what's under it is answered as JSON, 404s too
      edits.push({ at: start, del: m[0].length, ins: '' });
      const node = this.startNode();
      this.pos = start + m[0].length;
      this.next();
      let before = false;
      while (this.type !== tt.braceR) {
        const at = this.input.slice(this.start);
        if (this.type === tt.name && /^before[ \t]*\{/.test(at)) {
          if (before) fail(this.start, 'a group has one before block');
          before = true;
          const name = `_$b${befores.length}`;
          befores.push({ name, params: group.params });
          group.before = [...group.before, name];
          this.goalHandler(this.start, /^before[ \t]*\{/.exec(at)[0].length, name, 'GoalBefore');
        } else if (this.type === tt.name && this.value === 'route') this.goalRoute(group);
        else if (this.type === tt.name && this.value === 'group') this.goalGroup(group);
        else fail(this.start, this.type === tt.eof ? 'this group has no closing }' : 'a group holds routes, groups and a before { } block');
      }
      edits.push({ at: this.start, del: 1, ins: '' });
      this.next();
      return this.finishNode(node, 'GoalGroup');
    }

    // style { CSS }: not JavaScript, so it's read as text up to its closing brace, and taken out
    goalStyle() {
      const start = this.start;
      if (style) fail(start, 'a file has one style block: put all of its CSS in it');
      const open = this.input.indexOf('{', start);
      const close = cssEnd(this.input, open + 1);
      if (close < 0) fail(open, 'this style block has no closing }');
      style = { css: this.input.slice(open + 1, close), at: open + 1 };
      edits.push({ at: start, del: close + 1 - start, ins: '' });
      const node = this.startNode();
      this.pos = close + 1;
      this.next();
      return this.finishNode(node, 'EmptyStatement');
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
  return { code, routes, befores, serverFns, map, strict, types, style };
}
