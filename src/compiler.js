// The goal.js compiler.
//
// A component is a top-level function with a capitalised name that ends in `return <element>`:
//
//   export function Counter({ start }) {
//     var count = start;                                 // state
//     const double = count * 2;                          // computed
//     return (
//       <div>
//         <button onclick={() => count++}>+</button>
//         {if (count > 9) <p>big: {double}</p> else <p>{double}</p>}
//       </div>
//     );
//   }
//
//   route GET /users/{id} { return <main><Counter start={Number(id)} /></main>; }
//   server function save(text) { ... }       called from a handler as save(text): no async, no fetch
//
// compile() turns one .goal file into
//   - a server module: each component becomes `Name(props, ctx)` returning HTML, with markers around
//     the parts that depend on state, and the state and the props the browser needs written into its
//     root element; each route becomes a handler in `_$routes`;
//   - one client module per interactive component: `default(state, props)` is the component as it was
//     written (its `var`s start from the state), returning [binding values, handlers, read the state].
//     The loader runs a handler, saves the state, runs the body again, and patches the bindings whose
//     value changed. Nothing runs until the first event.
// Both carry source maps back to the .goal file, so a debugger shows the code as it was written.

import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { generate } from '@babel/generator';
import * as t from '@babel/types';
import { desugar, errorAt, GoalError } from './syntax.js';
import { URL_ATTRS, _$u } from './rt.js';

export { GoalError };

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const HELPERS = ['_$m', '_$h', '_$a', '_$e', '_$u', '_$pa', '_$ctx', '_$sf', '_$call', '_$hl', '_$L'];
const ROUTE_HELPERS = ['redirect', 'json', 'notFound', 'cookie'];
const FORM_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

let SRC; // the file being compiled: { source, file }

/** An error at a node; positions are already in the .goal source (see relocate). */
function fail(message, node) {
  throw errorAt(SRC.source, SRC.file, node.loc.start.index, message);
}

/** Moves every node's position from the desugared code back to the .goal source. */
function relocate(ast, source, map, file) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  const pos = (index) => {
    const at = map(index);
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: at - starts[lo], index: at };
  };
  t.traverseFast(ast, (n) => {
    n.loc = { start: pos(n.loc.start.index), end: pos(n.loc.end.index), filename: file, identifierName: n.loc.identifierName };
  });
}

/** Code with an inline source map back to the .goal source. */
function emit(node) {
  const out = generate(node, { sourceMaps: true, sourceFileName: SRC.file.split('/').at(-1) }, SRC.source);
  return `${out.code}\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(JSON.stringify(out.map)).toString('base64')}\n`;
}

/**
 * Compiles one .goal file.
 * @param {string} source
 * @param {{ file?: string, base?: string, rt?: string, list?: string, chunk?: (name: string) => string,
 *   serverFunctions?: (specifier: string) => { base: string, names: string[] } | null }} [opts]
 *   file: the name in errors and source maps; base: the file's path without .goal, which names its
 *   server functions' URLs (/_m/<base>/<name>); rt and keyed: where compiled code imports the helpers
 *   and the keyed list patcher from;
 *   chunk: the URL the browser loads a component's client module from; serverFunctions: the server
 *   functions another .goal file exports, for imports of it.
 */
export function compile(source, opts = {}) {
  const file = opts.file ?? 'input.goal';
  const base = opts.base ?? file.replace(/\.goal$/, '');
  const o = { file, rt: opts.rt ?? 'goaljs/rt', keyed: opts.keyed ?? 'goaljs/keyed', chunk: opts.chunk ?? ((n) => `/${n}.js`), sfns: new Map() };
  const d = desugar(source, file);
  SRC = { source, file };
  const ast = parse(d.code, { sourceType: 'module', plugins: ['jsx'] });
  relocate(ast, source, d.map, file.split('/').at(-1)); // source maps name the file next to the compiled one

  // Server functions this file can call: its own, and the ones it imports from other .goal files.
  for (const f of d.serverFns) o.sfns.set(f.name, `/_m/${base}/${f.name}`);
  for (const s of ast.program.body) {
    if (!t.isImportDeclaration(s) || !s.source.value.endsWith('.goal')) continue;
    const other = opts.serverFunctions?.(s.source.value);
    for (const sp of s.specifiers)
      if (other && t.isImportSpecifier(sp) && other.names.includes(sp.imported.name)) o.sfns.set(sp.local.name, `/_m/${other.base}/${sp.imported.name}`);
  }
  o.own = new Set(d.serverFns.map((f) => f.name));

  const server = transform(ast, 'server', o, d.routes);
  const client = transform(ast, 'client', o, d.routes);
  const clients = [];
  for (const c of client.components.filter((c) => c.interactive)) {
    const { code, keys } = clientModule(client.program, c, o);
    clients.push({ name: c.name, code });
    server.components.find((s) => s.name === c.name).keys.elements.push(...keys.map((k) => t.stringLiteral(k)));
  }

  const body = server.program;
  body.unshiftContainer('body', importHelpers(o.rt));
  const endpoints = d.serverFns.map((f) => ({ name: f.name, path: o.sfns.get(f.name) }));
  if (d.routes.length || endpoints.length)
    body.pushContainer(
      'body',
      t.exportNamedDeclaration(
        t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier('_$routes'),
            t.arrayExpression([
              ...d.routes.map((r) => routeEntry(r.method, r.path, t.identifier(r.name))),
              ...endpoints.map((f) =>
                routeEntry(
                  'POST',
                  f.path,
                  t.arrowFunctionExpression(
                    [t.identifier('r'), t.identifier('x')],
                    t.callExpression(t.identifier('_$call'), [t.identifier(f.name), t.identifier('r'), t.identifier('x')]),
                  ),
                ),
              ),
            ]),
          ),
        ]),
      ),
    );
  return {
    server: emit(body.node),
    clients,
    components: server.components.map(({ name, interactive, events }) => ({ name, interactive, events })),
    routes: d.routes.map(({ method, path }) => ({ method, path })),
    serverFunctions: endpoints,
  };
}

const routeEntry = (method, path, handler) =>
  t.objectExpression([
    t.objectProperty(t.identifier('method'), t.stringLiteral(method)),
    t.objectProperty(t.identifier('path'), t.stringLiteral(path)),
    t.objectProperty(t.identifier('handler'), handler),
  ]);

// ---------------------------------------------------------------------------------------------
// Whole-file transform. Each mode works on its own deep copy of the file, so both copies have
// fresh scope information and the same traversal order (binding and handler numbers match).

function transform(ast, mode, o, routes) {
  const program = programPath(t.cloneNode(ast, true));
  o.tplN = 0; // row templates are numbered the same way in both modes
  const byName = new Map(routes.map((r) => [r.name, r]));
  const routeFns = program.get('body').filter((s) => s.isFunctionDeclaration() && byName.has(s.node.id.name));
  for (const r of routeFns) if (mode === 'client') r.remove();
  const comps = componentPaths(program);
  for (const fn of comps) clientRules(fn);
  serverCalls(program, comps, o);
  const components = comps.map((fn) => component(fn, program, mode, o));
  if (mode === 'server') for (const r of routeFns) route(r, byName.get(r.node.id.name), program);
  // Markup outside components and routes (helpers that return markup) becomes plain templates.
  program.traverse(jsxVisitor({ kind: 'module', hs: null, scope: program.scope, program: program.scope, reactive: new Set() }));
  return { program, components };
}

function programPath(file) {
  let found;
  traverse(file, {
    Program(p) {
      found = p;
      p.stop();
    },
  });
  return found;
}

function componentPaths(program) {
  const out = [];
  for (const s of program.get('body')) {
    const isExport = s.isExportNamedDeclaration() || s.isExportDefaultDeclaration();
    const d = isExport ? s.get('declaration') : s;
    if (!d.isFunctionDeclaration()) continue;
    if (!d.node.id) fail('give the function a name: export default function Page() { ... }', d.node);
    if (/^[A-Z]/.test(d.node.id.name)) out.push(d);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Server functions. A call in an event handler becomes `await _$sf(url, [args])`, a request to the
// server, and the handler waits for it; a call in a route or another server function is awaited.
// Nobody writes async, await or fetch for it.

/** Components run in the browser, where data comes from server functions: no async, no fetch. */
function clientRules(comp) {
  if (comp.node.async) fail("a component can't be async: call a server function from an event handler, and goal.js waits for it", comp.node);
  comp.traverse({
    Function(p) {
      if (p.node.async) fail('no async in components: call a server function, and goal.js waits for it', p.node);
    },
    Identifier(p) {
      if (p.node.name === 'fetch' && p.isReferencedIdentifier() && !p.scope.hasBinding('fetch'))
        fail('call a server function instead of fetch: server function load() { ... } in a .goal file', p.node);
    },
  });
}

function serverCalls(program, comps, o) {
  const made = new Set(); // functions in components that now wait for the server
  const visit = (call, url) => {
    const fn = call.getFunctionParent();
    if (!fn) fail('call a server function from a route, another server function or an event handler', call.node);
    const comp = comps.find((c) => c.node === fn.node || fn.isDescendant(c));
    if (!comp) {
      if (!fn.node.async) fail('call a server function from a route, another server function or an event handler', call.node);
      if (url && !call.parentPath.isAwaitExpression()) call.replaceWith(t.awaitExpression(call.node));
      return;
    }
    if (fn.node === comp.node) fail("a server function can't run while a component renders: call it from an event handler, or load the data in the route", call.node);
    const parent = fn.parentPath;
    const handler = parent.isJSXExpressionContainer() && parent.parentPath.isJSXAttribute() && /^on/.test(parent.parent.name.name);
    const declared = fn.isFunctionDeclaration() ? fn : parent.isVariableDeclarator() ? parent : null;
    const top = declared && (fn.isFunctionDeclaration() ? fn.parent : declared.parentPath.parent) === comp.node.body;
    if (!handler && !top) fail('call server functions in an event handler, or in a function declared at the top of the component', call.node);
    fn.node.async = true;
    const args = t.arrayExpression(call.node.arguments);
    if (url) call.replaceWith(t.awaitExpression(t.callExpression(t.identifier('_$sf'), [t.stringLiteral(url), args])));
    else call.replaceWith(t.awaitExpression(call.node)); // a call to a function made to wait just above
    if (!top) return;
    // Calls to this function wait for it too.
    const b = comp.scope.getBinding(fn.isFunctionDeclaration() ? fn.node.id.name : parent.node.id.name);
    if (!made.has(b)) {
      made.add(b);
      for (const r of b.referencePaths) if (r.parentPath.isCallExpression({ callee: r.node })) visit(r.parentPath, null);
    }
  };
  program.traverse({
    CallExpression(p) {
      const callee = p.node.callee;
      if (t.isIdentifier(callee) && o.sfns.has(callee.name) && p.scope.getBinding(callee.name)?.scope === program.scope) visit(p, o.sfns.get(callee.name));
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Routes: server-only handlers, run once per request.

function route(fn, meta, program) {
  for (const [name, b] of Object.entries(fn.scope.bindings))
    if (b.kind === 'var') fail(`\`${name}\`: state (var) belongs in a component, because a route runs once per request. Use let or const`, b.path.node);
  for (const p of meta.params) if (fn.scope.hasOwnBinding(p)) fail(`\`${p}\` is already the route's path parameter {${p}}`, fn.scope.getBinding(p).identifier);

  const cId = t.identifier('_$c');
  fn.get('body').traverse(jsxVisitor({ kind: 'route', hs: null, scope: fn.scope, program: program.scope, reactive: new Set(), cId }));

  const x = t.identifier('_$x');
  const pre = [t.variableDeclaration('const', [t.variableDeclarator(cId, t.memberExpression(x, t.identifier('ctx')))])];
  const helpers = ROUTE_HELPERS.filter((n) => !fn.scope.hasBinding(n));
  if (helpers.length) pre.push(t.variableDeclaration('const', [t.variableDeclarator(t.objectPattern(helpers.map(shorthand)), x)]));
  if (meta.params.length)
    pre.push(t.variableDeclaration('const', [t.variableDeclarator(t.objectPattern(meta.params.map(shorthand)), t.memberExpression(t.identifier('request'), t.identifier('params')))]));
  fn.get('body').unshiftContainer('body', pre);
}

const shorthand = (n) => t.objectProperty(t.identifier(n), t.identifier(n), false, true);

// ---------------------------------------------------------------------------------------------
// One component.

function component(fn, program, mode, o) {
  const name = fn.node.id.name;
  const { state, reactive, withHandlers } = analyze(fn);
  const cx = {
    kind: 'component',
    scope: fn.scope,
    program: program.scope,
    reactive,
    withHandlers,
    dyn: 0, // handlers made while rendering, e.g. one per list item
    offset: t.numericLiteral(0), // where they start: after the fixed handlers
    binds: [], // { k: [kind, n, attr?], e: expression }   kind 0: child, 1: attribute
    hs: [], // handler expressions, in the order they appear
    events: new Set(),
    elems: 0,
    iId: t.identifier('_$i'),
    cId: t.identifier('_$c'),
    tpls: [], // row templates of keyed lists, as module-level declarations
    cache: [], // keyed lists whose rows the browser keeps from run to run
    mode,
    o,
  };

  const body = fn.get('body');
  const ret = body.get('body').at(-1);
  const rootParts = element(ret.get('argument'), cx, true, true);
  ret.get('argument').replaceWith(t.nullLiteral());
  body.traverse(jsxVisitor(cx)); // other markup in the body: helpers, saved fragments

  cx.offset.value = cx.hs.length;
  const interactive = cx.binds.length > 0 || cx.hs.length > 0 || cx.dyn > 0;
  const events = [...cx.events];
  const param = fn.node.params[0];
  const keys = t.arrayExpression([]); // the props the browser needs, filled in from the client module
  const info = { name, interactive, events, state, binds: cx.binds, hs: cx.hs, param, keys, dyn: cx.dyn, offset: cx.offset, tpls: cx.tpls, cache: cx.cache };
  program.pushContainer('body', cx.tpls);

  if (mode === 'server') {
    const pId = t.identifier('_$p');
    const parts = rootParts.flatMap((x) => (x === ROOT ? (interactive ? rootAttrs(cx, o.chunk(name), state, param, pId, keys) : []) : [x]));
    ret.get('argument').replaceWith(template(parts));
    const pre = [];
    if (param) pre.push(t.variableDeclaration('let', [t.variableDeclarator(patternOf(param), pId)]));
    pre.push(t.variableDeclaration('const', [t.variableDeclarator(cx.iId, t.updateExpression('++', t.memberExpression(cx.cId, t.identifier('i'))))]));
    if (events.length) pre.push(t.expressionStatement(t.callExpression(t.memberExpression(cx.cId, t.identifier('e')), [t.valueToNode(events)])));
    if (cx.dyn) {
      // The server only numbers the handlers made while rendering; the browser keeps them.
      pre.push(t.variableDeclaration('let', [t.variableDeclarator(t.identifier('_$n'), t.numericLiteral(0))]));
      pre.push(
        t.variableDeclaration('const', [
          t.variableDeclarator(t.identifier('_$hd'), t.arrowFunctionExpression([], t.binaryExpression('+', cx.offset, t.updateExpression('++', t.identifier('_$n'))))),
        ]),
      );
    }
    body.unshiftContainer('body', pre);
    fn.node.params = [t.assignmentPattern(pId, t.objectExpression([])), t.assignmentPattern(cx.cId, t.callExpression(t.identifier('_$ctx'), []))];
  }
  return info;
}

const patternOf = (param) => (t.isAssignmentPattern(param) ? param.left : param);

const ROOT = Symbol('root attributes');

function rootAttrs(cx, url, state, param, pId, keys) {
  const parts = [` m-c="${escAttr(url)}" m-i="`, cx.iId, '"'];
  if (state.length)
    parts.push(
      ' m-s="',
      t.callExpression(t.identifier('_$e'), [
        t.callExpression(t.memberExpression(t.identifier('JSON'), t.identifier('stringify')), [t.objectExpression(state.map(shorthand))]),
      ]),
      '"',
    );
  if (param) parts.push(t.callExpression(t.identifier('_$pa'), [pId, keys]));
  return parts;
}

// The rules, and which bindings depend on state.
function analyze(fn) {
  const node = fn.node;
  if (node.generator) fail("a component can't be a generator", node);
  if (node.params.length > 1) fail('a component takes one parameter, its props', node.params[1]);
  const stmts = fn.get('body.body');
  const last = stmts.at(-1);
  if (!last || !last.isReturnStatement() || !last.get('argument').isJSXElement())
    fail('a component ends with `return <element>` (one element, not a fragment)', last ? last.node : node);
  fn.get('body').traverse({
    ReturnStatement(p) {
      if (p.node !== last.node && p.getFunctionParent() === fn) fail('a component has one return, at the end', p.node);
    },
  });

  const state = [];
  const deps = new Map();
  for (const [name, b] of Object.entries(fn.scope.bindings)) {
    if (b.kind === 'var') {
      const d = b.path;
      if (!t.isIdentifier(d.node.id)) fail('declare state one name at a time: var name = value', d.node);
      if (d.parentPath.parent !== node.body) fail(`declare \`var ${name}\` at the top of the component, not inside a block`, d.node);
      for (const v of b.constantViolations) {
        if (v.getFunctionParent() === fn) fail(`\`${name}\` is state: change it in an event handler, not while rendering`, v.node);
        if (!v.isUpdateExpression() && !(v.isAssignmentExpression() && t.isIdentifier(v.node.left)))
          fail(`change state with \`${name} = value\`, not by destructuring`, v.node);
      }
      state.push(name);
    } else if (b.kind === 'let' || b.kind === 'const' || b.kind === 'hoisted') {
      for (const v of b.constantViolations)
        if (v.getFunctionParent() !== fn) fail(`\`${name}\` is computed from state, so a handler can't change it. Declare it with \`var\` to make it state`, v.node);
      deps.set(name, [b.path, ...b.constantViolations.map((v) => topStatement(v, node.body))]);
    }
  }

  // Names whose markup has event handlers: a hole that uses one is rendered in the browser too.
  const withHandlers = new Set();
  for (const [name, paths] of deps) {
    let found = false;
    paths[0].traverse({
      JSXAttribute(a) {
        if (/^on/.test(a.node.name.name)) found = true;
      },
    });
    if (found) withHandlers.add(name);
  }

  const reactive = new Set(state);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, paths] of deps)
      if (!reactive.has(name) && paths.some((p) => uses(p, fn.scope, reactive))) {
        reactive.add(name);
        grew = true;
      }
  }
  return { state, reactive, withHandlers };
}

function topStatement(p, body) {
  while (p.parent !== body) p = p.parentPath;
  return p;
}

/** Does the code at `path` read any of `names`, as bound in `scope`? */
function uses(path, scope, names) {
  let hit = false;
  const check = (p) => {
    if (names.has(p.node.name) && p.scope.getBinding(p.node.name)?.scope === scope) hit = true;
  };
  if (path.isIdentifier()) check(path);
  path.traverse({
    Identifier(p) {
      if (p.isReferencedIdentifier()) check(p);
    },
  });
  return hit;
}

// ---------------------------------------------------------------------------------------------
// Markup to HTML templates.
//
// `top` is the fixed part of a component: its root and the elements around the holes. There, holes
// and attributes that depend on state become bindings with markers. Inside a hole (a `{...}` child)
// everything is a plain template, and the whole hole is rendered again when it changes.

function element(p, cx, top, root, row) {
  const rowRoot = row && p.node === row.root;
  const nameNode = p.node.openingElement.name;
  if (!t.isJSXIdentifier(nameNode)) fail('use plain tag names and component names, like <div> or <Counter>', nameNode);
  const tag = nameNode.name;
  if (/^[A-Z]/.test(tag)) {
    if (cx.kind === 'route' || (cx.kind === 'component' && top && !root)) return componentCall(p, cx, tag);
    fail(
      cx.kind === 'component'
        ? `place <${tag}> in the fixed part of a component: not as its root, not inside {...}`
        : `<${tag}> goes in a route or in the fixed part of a component`,
      p.node,
    );
  }
  if (tag === 'script') fail("<script> isn't allowed: goal.js writes the page's scripts. Put the code in a component", p.node);
  if (tag === 'style') fail('put CSS in a file under public/ and link it: <link rel="stylesheet" href="/style.css" />', p.node);

  const parts = ['<' + tag];
  const ons = []; // m-on entries: "click:0" for a fixed handler, or parts that number one made while rendering
  let id;
  let method;
  for (const a of p.get('openingElement.attributes')) {
    if (a.isJSXSpreadAttribute()) fail('spread attributes are not supported yet', a.node);
    if (!t.isJSXIdentifier(a.node.name)) fail('namespaced attributes are not supported', a.node);
    const name = a.node.name.name;
    const v = a.get('value');
    if (name === 'key') {
      if (!v.isJSXExpressionContainer()) fail('a key is an expression: key={x.id}', a.node);
      if (rowRoot) {
        row.key = v.node.expression;
        continue;
      }
      // Not a row the browser patches by key: fine for a list that never changes, which renders once.
      const list = mapOf(p);
      if (!list) fail('key goes on the outer element of a list row: items.map((x) => <li key={x.id}>...</li>)', a.node);
      if (cx.inRow) fail("a keyed list can't go inside another list's row yet: drop this key, and the inner list is made again with its row", a.node);
      if (cx.kind === 'component' && changes(list, cx))
        fail('a keyed list that changes goes straight in the markup, or straight in an {if} or a ternary: <ul>{items.map((x) => <li key={x.id}>...</li>)}</ul>', a.node);
      continue;
    }
    if (/^on/i.test(name)) {
      if (/[A-Z]/.test(name)) fail(`write ${name.toLowerCase()}, the HTML name, not ${name}`, a.node);
      if (!v.isJSXExpressionContainer()) fail(`${name} takes a function: ${name}={() => ...}. A string of code isn't allowed`, a.node);
      if (!cx.hs) fail(cx.inRow ? 'put the handler on an element of the list row, not inside {...}' : 'event handlers go inside a component', a.node);
      const ev = name.slice(2);
      cx.events.add(ev);
      if (row) {
        ons.push([`${ev}:r${row.hs.length}`]); // the row's own handler, found from the row at run time
        row.hs.push(v.node.expression);
      } else if (top) {
        ons.push([`${ev}:${cx.hs.length}`]);
        cx.hs.push(v.node.expression);
      } else {
        ons.push([`${ev}:`, t.callExpression(t.identifier('_$hd'), [v.node.expression])]);
        cx.dyn++;
      }
      continue;
    }
    if (name === 'className') fail('write class, as in HTML', a.node);
    if (name === 'htmlFor') fail('write for, as in HTML', a.node);
    if (name === 'srcdoc') fail("srcdoc isn't allowed: it puts raw HTML in the page", a.node);
    if (tag === 'form' && name === 'method') {
      if (!v.isStringLiteral()) fail('write the form method as text: method="post"', a.node);
      method = v.node.value.toLowerCase();
      if (!FORM_METHODS.includes(method)) fail(`a form's method is one of ${FORM_METHODS.join(', ')}`, a.node);
      parts.push(` method="${method === 'get' ? 'get' : 'post'}"`);
    } else if (!v.node) parts.push(' ' + name);
    else if (v.isStringLiteral()) {
      const s = v.node.value;
      if (URL_ATTRS.has(name) && _$u(s) !== s) fail(`${name} can't be a ${s.split(':')[0].trim()}: URL`, a.node);
      parts.push(` ${name}="${escAttr(s)}"`);
    } else if (v.isJSXExpressionContainer() && row) {
      const e = v.node.expression;
      const val = URL_ATTRS.has(name) ? t.callExpression(t.identifier('_$u'), [e]) : e;
      parts.push(t.callExpression(t.identifier('_$a'), [t.stringLiteral(name), rowValue(row, val, [1, [...row.path], name], v.get('expression'), cx)]));
    } else if (v.isJSXExpressionContainer()) {
      const e = v.get('expression');
      if (top && uses(e, cx.scope, cx.reactive)) {
        id ??= cx.elems++;
        cx.binds.push({ k: [1, id, name], e: URL_ATTRS.has(name) ? t.callExpression(t.identifier('_$u'), [e.node]) : e.node });
      }
      parts.push(t.callExpression(t.identifier('_$a'), [t.stringLiteral(name), e.node]));
    } else fail('an attribute value is "text" or {expression}', a.node);
  }
  if (ons.length) parts.push(' m-on="', ...ons.flatMap((o, i) => (i ? [' ', ...o] : o)), '"');
  if (id !== undefined) parts.push(' m-x="', cx.iId, `.${id}"`);
  if (rowRoot) parts.push(` m-r="${row.k}"`);
  if (root) parts.push(ROOT);
  parts.push('>');
  if (method && method !== 'get') {
    if (!(cx.kind === 'route' || (cx.kind === 'component' && top)))
      fail('a form that sends data goes in a route, or in the fixed part of a component', p.node);
    parts.push('<input type="hidden" name="_csrf" value="', t.callExpression(t.identifier('_$e'), [t.memberExpression(cx.cId, t.identifier('t'))]), '">');
    if (method !== 'post') parts.push(`<input type="hidden" name="_method" value="${method}">`);
  }
  if (VOID.has(tag)) {
    if (p.node.children.length) fail(`<${tag}> can't have children`, p.node);
    return parts;
  }
  children(p, cx, top, parts, row);
  parts.push(`</${tag}>`);
  return parts;
}

/**
 * A value of a list row: a row is [key, item, index, ...values], and the row template reads it as
 * v[i]. A value that reads only the item, the index and module-level names depends on the item
 * alone, so a row whose item is the same keeps it; any other (`row.id === selected`, or a local of
 * the callback) is worked out on every run.
 */
function rowValue(row, e, part, path, cx) {
  row.parts.push(part);
  row.outer.push(refs(path, (b) => b.scope !== cx.program && !(b.kind === 'param' && b.scope === row.scope)));
  return t.memberExpression(t.identifier('v'), t.numericLiteral(row.vals.push(e) + 2), true);
}

/** Does the code at `path` read a name whose binding passes `test`? */
function refs(path, test) {
  let hit = false;
  const check = (p) => {
    const b = p.scope.getBinding(p.node.name);
    if (b && test(b)) hit = true;
  };
  if (path.isIdentifier()) check(path);
  path.traverse({
    Identifier(p) {
      if (p.isReferencedIdentifier()) check(p);
    },
  });
  return hit;
}

function children(p, cx, top, parts, row) {
  let n = 0; // the element's index among its element children: a row value's path
  for (const c of p.get('children')) {
    if (c.isJSXText()) parts.push(cleanText(c.node.value));
    else if (c.isJSXElement()) {
      row?.path.push(n++);
      parts.push(...element(c, cx, top, false, row));
      row?.path.pop();
    } else if (c.isJSXFragment()) {
      if (row) row.whole = true; // element paths through a fragment are not tracked: a changed row is made again
      children(c, cx, top, parts, row);
    } else if (c.get('expression').isJSXEmptyExpression()) continue;
    else if (row) {
      // A hole in a row: the text of its element when it is the only child, otherwise the row is made again.
      if (!p.node.children.every((x) => x === c.node || (t.isJSXText(x) && cleanText(x.value) === ''))) row.whole = true;
      inner(c.get('expression'), { ...cx, hs: null, inRow: true });
      parts.push(rowValue(row, t.callExpression(t.identifier('_$h'), [c.node.expression]), [0, [...row.path]], c.get('expression'), cx));
    } else if (top && cx.kind === 'component' && keyedList(c, cx, parts)) continue;
    else hole(c, cx, top, parts);
  }
}

/** Does this expression read state, or a function that changes state? Then what it renders can change. */
const changes = (e, cx) => uses(e, cx.scope, cx.reactive) || uses(e, cx.scope, cx.withHandlers);

/** A `{...}` hole: in the fixed part of a component, one that can change becomes a binding between markers. */
function hole(c, cx, top, parts) {
  const dyn = cx.dyn;
  inner(c.get('expression'), cx);
  const ex = t.callExpression(t.identifier('_$h'), [c.node.expression]);
  if (top && (cx.dyn > dyn || changes(c.get('expression'), cx))) {
    const k = cx.binds.length;
    cx.binds.push({ k: [0, k], e: ex });
    parts.push('<!--', cx.iId, `.${k}-->`, ex, '<!--/-->');
  } else parts.push(ex);
}

const isMap = (e) => e.isCallExpression() && t.isMemberExpression(e.node.callee, { computed: false }) && e.node.callee.property.name === 'map';

/** The `.map(...)` call whose callback returns this element, when the element is a list row. */
function mapOf(p) {
  let f = p.parentPath;
  if (f.isReturnStatement()) f = f.parentPath.parentPath; // `return <li>` in the callback's body
  return (f.isArrowFunctionExpression() || f.isFunctionExpression()) && f.listKey === 'arguments' && f.key === 0 && isMap(f.parentPath) ? f.parentPath : null;
}

/**
 * Where a hole's keyed list is: the hole is the `.map(...)` call, or the call is one branch of a
 * condition, `{if (c) items.map(...) else ...}` or `{c ? ... : items.map(...)}`. The other branch,
 * unless it renders nothing, becomes a hole of its own right after the list.
 */
function listIn(e) {
  if (isMap(e)) return { map: e };
  if (!e.isConditionalExpression()) return null;
  const yes = isMap(e.get('consequent'));
  if (!yes && !isMap(e.get('alternate'))) return null;
  const other = e.node[yes ? 'alternate' : 'consequent'];
  return { map: e.get(yes ? 'consequent' : 'alternate'), test: e.node.test, yes, other: t.isNullLiteral(other) ? null : other };
}

/**
 * `{items.map((x, i) => <tr key={x.id}>...</tr>)}` in the fixed part of a component: a keyed list,
 * patched by key in the browser (keyed.js), which only a component with one loads. A list without
 * keys is a plain hole, made again as a whole when it changes. The row becomes a template (a
 * module-level function of a row) and the callback returns [key, item, index, ...values] for each
 * item. The row's handlers come from a second function of (item, index), called only for a row
 * that gets an event. In a condition the list is the rows of its branch, or none.
 */
function keyedList(c, cx, parts) {
  const shape = listIn(c.get('expression'));
  if (!shape) return false;
  const e = shape.map;
  const fn = e.get('arguments.0');
  if (!fn || !(fn.isArrowFunctionExpression() || fn.isFunctionExpression())) return false;
  let rowEl = fn.get('body');
  let returns = 0;
  let handlers = false;
  fn.traverse({
    ReturnStatement(r) {
      if (r.getFunctionParent() === fn) returns++;
    },
    JSXAttribute(a) {
      if (/^on/i.test(a.node.name.name)) handlers = true;
    },
  });
  if (rowEl.isBlockStatement()) {
    const last = rowEl.get('body').at(-1);
    rowEl = returns === 1 && last?.isReturnStatement() ? last.get('argument') : null;
  }
  if (!rowEl?.isJSXElement()) return false;
  if (!rowEl.node.openingElement.attributes.some((a) => t.isJSXAttribute(a) && a.name.name === 'key')) return false;
  if (!handlers && !changes(c.get('expression'), cx)) return false;

  const k = cx.binds.length;
  cx.binds.push(null);
  const row = { k, root: rowEl.node, scope: fn.scope, vals: [], hs: [], parts: [], outer: [], path: [], whole: false, key: null };
  // Does the row read its index? Then a row moved to another index is worked out again.
  const index = fn.node.params[1];
  const byIndex = !!index && (!t.isIdentifier(index) || refs(rowEl, (b) => b.identifier === index));
  const tplParts = element(rowEl, cx, false, false, row);
  // The callback gets (item, index) as plain names: a pattern is taken apart inside it.
  const params = fn.node.params;
  const pre = [];
  ['_$r', '_$j'].forEach((id, n) => {
    if (t.isIdentifier(params[n])) return;
    if (params[n]) pre.push(t.variableDeclaration('const', [t.variableDeclarator(params[n], t.identifier(id))]));
    params[n] = t.identifier(id);
  });
  const result = (els) => (fn.get('body').isBlockStatement() ? t.blockStatement([...pre, ...fn.node.body.body.slice(0, -1), t.returnStatement(t.arrayExpression(els))]) : pre.length ? t.blockStatement([...pre, t.returnStatement(t.arrayExpression(els))]) : t.arrayExpression(els));
  const rowHandlers = t.arrowFunctionExpression(params.map((x) => t.cloneNode(x)), t.cloneNode(result(row.hs), true));
  const name = `_$t${cx.o.tplN++}`;
  cx.tpls.push(t.variableDeclaration('const', [t.variableDeclarator(t.identifier(name), t.arrowFunctionExpression([t.identifier('v')], template(tplParts)))]));
  if (cx.mode === 'server') fn.node.body = result([row.key, params[0], params[1], ...row.vals]);
  else {
    // In the browser a row is kept from the last run when its item (and index, if it reads it) and
    // the component values it reads are the same: then the list patch skips it at once.
    const id = (n) => t.identifier(n + k);
    const [item, idx] = params;
    const kv = t.identifier('_$k');
    const o = t.identifier('_$o');
    const same = t.identifier('_$q');
    const member = (n) => t.memberExpression(o, t.numericLiteral(n), true);
    const and = (xs) => xs.reduce((x, y) => t.logicalExpression('&&', x, y));
    const outer = row.vals.map((v, i) => (row.outer[i] ? t.identifier(`_$d${i}`) : null));
    const vals = row.vals.map((v, i) => outer[i] ?? t.conditionalExpression(same, member(i + 3), v));
    cx.cache.push(k);
    fn.node.body = t.blockStatement([
      ...(t.isBlockStatement(fn.node.body) ? [...pre, ...fn.node.body.body.slice(0, -1)] : pre),
      t.variableDeclaration('const', [
        t.variableDeclarator(kv, row.key),
        t.variableDeclarator(o, t.callExpression(t.memberExpression(id('_$C'), t.identifier('get')), [kv])),
        t.variableDeclarator(same, and([o, t.binaryExpression('===', member(1), item), ...(byIndex ? [t.binaryExpression('===', member(2), idx)] : [])])),
        ...row.vals.flatMap((v, i) => (outer[i] ? [t.variableDeclarator(outer[i], v)] : [])),
      ]),
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier('_$w'),
          t.conditionalExpression(and([same, ...outer.flatMap((d, i) => (d ? [t.binaryExpression('===', member(i + 3), d)] : []))]), o, t.arrayExpression([kv, item, idx, ...vals])),
        ),
      ]),
      t.expressionStatement(t.callExpression(t.memberExpression(id('_$N'), t.identifier('set')), [kv, t.identifier('_$w')])),
      t.returnStatement(t.identifier('_$w')),
    ]);
  }
  let list = e.node;
  if (shape.test) {
    // No rows while the condition says no: one empty array for the module, so a list that stays
    // empty is the same value from run to run and the browser leaves it alone.
    const none = t.identifier(`_$t${cx.o.tplN++}`);
    cx.tpls.push(t.variableDeclaration('const', [t.variableDeclarator(none, t.arrayExpression([]))]));
    list = t.conditionalExpression(shape.test, shape.yes ? list : none, shape.yes ? none : list);
  }
  cx.binds[k] = { k: [2, k, name, row.whole ? null : row.parts], e: t.callExpression(t.identifier('_$L'), [list, rowHandlers]) };
  parts.push('<!--', cx.iId, `.${k}-->`, t.callExpression(t.identifier('_$hl'), [list, t.identifier(name)]), '<!--/-->');
  if (shape.other) {
    const other = t.cloneNode(shape.other, true);
    const [after] = c.insertAfter(t.jsxExpressionContainer(t.conditionalExpression(t.cloneNode(shape.test, true), shape.yes ? t.nullLiteral() : other, shape.yes ? other : t.nullLiteral())));
    hole(after, cx, true, parts);
  }
  return true;
}

/** Replaces the markup inside an expression with templates. */
function inner(e, cx) {
  if (e.isJSXElement() || e.isJSXFragment()) e.replaceWith(markup(e, cx));
  else e.traverse(jsxVisitor(cx));
}

function jsxVisitor(cx) {
  return {
    'JSXElement|JSXFragment'(p) {
      p.replaceWith(markup(p, cx));
      p.skip();
    },
  };
}

function markup(p, cx) {
  let parts = [];
  if (p.isJSXElement()) parts = element(p, cx, false, false);
  else children(p, cx, false, parts);
  return t.callExpression(t.identifier('_$m'), [template(parts)]);
}

function componentCall(p, cx, tag) {
  if (p.node.children.some((c) => !t.isJSXText(c) || cleanText(c.value) !== ''))
    fail(`passing children to <${tag}> comes in the next milestone`, p.node);
  const props = [];
  for (const a of p.get('openingElement.attributes')) {
    if (a.isJSXSpreadAttribute()) fail('spread props are not supported yet', a.node);
    if (!t.isJSXIdentifier(a.node.name)) fail('namespaced props are not supported', a.node);
    const name = a.node.name.name;
    if (/^on/i.test(name)) fail(`a component can't take a function prop (${name}) yet`, a.node);
    const v = a.get('value');
    let value;
    if (!v.node) value = t.booleanLiteral(true);
    else if (v.isStringLiteral()) value = v.node;
    else if (v.isJSXExpressionContainer()) {
      if (uses(v.get('expression'), cx.scope, cx.reactive))
        fail(`prop \`${name}\` depends on state; props that change come in the next milestone`, a.node);
      inner(v.get('expression'), cx);
      value = v.node.expression;
    } else fail('a prop value is "text" or {expression}', a.node);
    props.push(t.objectProperty(t.stringLiteral(name), value));
  }
  return [t.callExpression(t.identifier(tag), [t.objectExpression(props), cx.cId])];
}

// Text in markup, with whitespace cleaned the way React does it.
function cleanText(value) {
  const lines = value.split(/\r\n|\n|\r/);
  let last = 0;
  lines.forEach((l, i) => {
    if (/[^ \t]/.test(l)) last = i;
  });
  let out = '';
  lines.forEach((line, i) => {
    let s = line.replace(/\t/g, ' ');
    if (i !== 0) s = s.replace(/^[ ]+/, '');
    if (i !== lines.length - 1) s = s.replace(/[ ]+$/, '');
    if (s) out += i !== last ? s + ' ' : s;
  });
  return out;
}

const escAttr = (s) => s.replace(/"/g, '&quot;');

/** Strings and expressions into one template literal. */
function template(parts) {
  const quasis = [];
  const exprs = [];
  let s = '';
  for (const x of parts) {
    if (typeof x === 'string') s += x;
    else {
      quasis.push(s);
      exprs.push(x);
      s = '';
    }
  }
  quasis.push(s);
  return t.templateLiteral(
    quasis.map((q, i) => t.templateElement({ raw: q.replace(/\\|`|\$\{/g, (m) => '\\' + m), cooked: q }, i === quasis.length - 1)),
    exprs,
  );
}

// ---------------------------------------------------------------------------------------------
// Client modules.

function importHelpers(rt) {
  return t.importDeclaration(HELPERS.map((h) => t.importSpecifier(t.identifier(h), t.identifier(h))), t.stringLiteral(rt));
}

function clientModule(program, info, o) {
  const body = [importHelpers(o.rt)];
  let comp;
  for (const s of program.node.body) {
    const d = t.isExportNamedDeclaration(s) || t.isExportDefaultDeclaration(s) ? s.declaration : s;
    if (t.isFunctionDeclaration(d) && (/^[A-Z]/.test(d.id.name) || o.own.has(d.id.name))) {
      if (d.id.name === info.name) comp = d;
    } else if (t.isStatement(d) && !/^_\$t\d/.test(d.declarations?.[0].id.name)) body.push(t.cloneNode(d, true)); // `export { a }` and `export default expr` are dropped
  }
  body.push(...info.tpls.map((x) => t.cloneNode(x, true)), ...clientComponent(comp, info)); // row templates before _$k reads them
  if (info.binds.some((b) => b.k[0] === 2))
    body.push(
      t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier('_$lp'), t.identifier('_$lp'))], t.stringLiteral(o.keyed)),
      t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier('_$lh'), t.identifier('_$lh'))], t.stringLiteral(o.rt)),
    );
  const file = t.file(t.program(body));
  const prog = programPath(file);
  const fn = prog.get('body').find((s) => s.isExportDefaultDeclaration()).get('declaration');
  shake(fn);
  const keys = propKeys(fn);
  prune(prog, new Set(['_$k', info.name]));
  return { code: emit(file), keys };
}

/**
 * The component as written: each `var` starts from the state, the rest is the same body. It returns
 * the binding values, the handlers, and a function that reads the state back after a handler.
 */
function clientComponent(fn, info) {
  const s = t.identifier('_$s');
  const stmts = fn.body.body.slice(0, -1).map((st) => {
    if (!t.isVariableDeclaration(st) || st.kind !== 'var') return st;
    const decl = t.variableDeclaration(
      'var',
      st.declarations.map((d) => Object.assign(t.variableDeclarator(d.id, t.memberExpression(s, t.identifier(d.id.name))), { loc: d.loc })),
    );
    decl.loc = st.loc;
    return decl;
  });
  const pre = [];
  if (info.dyn)
    pre.push(
      t.variableDeclaration('const', [t.variableDeclarator(t.identifier('_$H'), t.arrayExpression([]))]),
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier('_$hd'),
          t.arrowFunctionExpression(
            [t.identifier('f')],
            t.binaryExpression('-', t.binaryExpression('+', info.offset, t.callExpression(t.memberExpression(t.identifier('_$H'), t.identifier('push')), [t.identifier('f')])), t.numericLiteral(1)),
          ),
        ),
      ]),
    );
  // Each keyed list's rows from the last run (_$C), and this run's (_$N), kept on the state object.
  for (const k of info.cache)
    pre.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(t.identifier('_$C' + k), t.logicalExpression('||', t.memberExpression(s, t.identifier('_$c' + k)), t.newExpression(t.identifier('Map'), []))),
        t.variableDeclarator(t.identifier('_$N' + k), t.assignmentExpression('=', t.memberExpression(s, t.identifier('_$c' + k)), t.newExpression(t.identifier('Map'), []))),
      ]),
    );
  const handlers = t.arrayExpression([...info.hs, ...(info.dyn ? [t.spreadElement(t.identifier('_$H'))] : [])]);
  const read = t.arrowFunctionExpression([], t.objectExpression(info.state.map(shorthand)));
  const result = t.arrayExpression([t.arrayExpression(info.binds.map((b) => b.e)), handlers, read]);
  const f = t.functionDeclaration(t.identifier(info.name), [s, ...(info.param ? [info.param] : [])], t.blockStatement([...pre, ...stmts, t.returnStatement(result)]));
  f.loc = fn.loc;
  return [
    t.exportNamedDeclaration(
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier('_$k'),
          t.arrayExpression(
            info.binds.map(({ k }) => (k[0] === 2 ? t.arrayExpression([t.numericLiteral(2), t.numericLiteral(k[1]), t.identifier(k[2]), t.valueToNode(k[3])]) : t.valueToNode(k))),
          ),
        ),
      ]),
    ),
    t.exportDefaultDeclaration(t.cloneNode(f, true)),
  ];
}

/** Removes computeds and functions in the client body that nothing reads. */
function shake(fn) {
  for (let removed = true; removed; ) {
    removed = false;
    fn.scope.crawl();
    for (const b of Object.values(fn.scope.bindings)) {
      if (b.referenced || b.constantViolations.length) continue;
      const p = b.path;
      if (p.isVariableDeclarator() && pure(p.node.init) && p.parent.declarations.length === 1) {
        p.parentPath.remove();
        removed = true;
      } else if (p.isFunctionDeclaration()) {
        p.remove();
        removed = true;
      }
    }
  }
}

/** Code that can be dropped when its value is unused: no calls, no assignments. */
const pure = (n) =>
  !n ||
  t.isIdentifier(n) ||
  t.isFunction(n) ||
  (t.isTemplateLiteral(n) ? n.expressions.every(pure) : t.isLiteral(n)) ||
  (t.isMemberExpression(n) && pure(n.object) && (!n.computed || pure(n.property))) ||
  ((t.isBinaryExpression(n) || t.isLogicalExpression(n)) && pure(n.left) && pure(n.right)) ||
  (t.isConditionalExpression(n) && pure(n.test) && pure(n.consequent) && pure(n.alternate));

/** Which props the browser code reads: only those are written into the page. */
function propKeys(fn) {
  const param = fn.node.params[1];
  if (!param) return [];
  const pat = patternOf(param);
  if (t.isIdentifier(pat)) {
    const keys = new Set();
    for (const r of fn.scope.getBinding(pat.name).referencePaths) {
      const m = r.parentPath;
      if (!m.isMemberExpression({ object: r.node }) || m.node.computed)
        fail('read props as props.name, or destructure them, so goal.js knows which ones the browser needs', r.node);
      keys.add(m.node.property.name);
    }
    return [...keys];
  }
  if (!t.isObjectPattern(pat)) fail('props are an object: write ({ name }) or (props)', pat);
  const keys = [];
  for (const prop of pat.properties) {
    if (t.isRestElement(prop)) fail("an interactive component can't take ...rest props; name the ones it uses", prop);
    if (prop.computed) fail('name each prop: { name }, not { [key] }', prop);
    const names = Object.keys(t.getBindingIdentifiers(prop.value));
    if (names.some((n) => fn.scope.getBinding(n).referenced)) keys.push(t.isIdentifier(prop.key) ? prop.key.name : prop.key.value);
  }
  return keys;
}

/** Removes imports and helper functions the component doesn't use, so they don't ship. */
function prune(prog, keep) {
  for (let removed = true; removed; ) {
    removed = false;
    prog.scope.crawl();
    for (const b of Object.values(prog.scope.bindings)) {
      if (b.referenced || keep.has(b.identifier.name)) continue;
      const p = b.path;
      if (p.isImportSpecifier() || p.isImportDefaultSpecifier() || p.isImportNamespaceSpecifier()) {
        const decl = p.parentPath;
        p.remove();
        if (!decl.node.specifiers.length) decl.remove();
        removed = true;
      } else if (p.isFunctionDeclaration() || (p.isVariableDeclarator() && pure(p.node.init) && p.parent.declarations.length === 1 && !b.constantViolations.length)) {
        (p.isVariableDeclarator() ? p.parentPath : p).remove();
        removed = true;
      }
    }
  }
}
