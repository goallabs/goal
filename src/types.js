// Types, in a file that starts with #strict (see syntax.js, which reads them out of the code).
//
// check() runs on the file's AST before it is compiled. A #strict file gives a type to what has no
// other way to get one: a component's props, a server function's parameters, and a var whose initial
// value doesn't say (an empty list, null), or that comes from a .js module, which has no types. The
// rest is inferred. It reports a prop of the wrong type, a required prop left out or one the component
// doesn't take; state, an argument or a returned value of the wrong type; markup that can't render;
// and a .goal import without #strict. What can't be inferred is unknown, and unknown is never an error.
//
// A type is { k: 'string' | 'number' | 'boolean' | 'null' | 'undefined' | 'void' | 'unknown' |
// 'Markup' | 'never' } or { k: 'lit', v }, { k: 'array', of }, { k: 'object', fields: { name:
// { type, optional } } }, { k: 'fn', params: [{ type, optional }], returns }, { k: 'union', of }, or
// { k: 'ref', name }, a declared type.

import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { desugar } from './syntax.js';

const T = (k) => ({ k });
const UNKNOWN = T('unknown');
const BOOLEAN_ATTRS = new Set(['disabled', 'checked', 'hidden', 'required', 'readonly', 'multiple', 'selected', 'open', 'autofocus']);
const ARRAY_SAME = new Set(['filter', 'slice', 'concat', 'reverse', 'sort', 'toSorted', 'toReversed']);
const ARRAY_BOOL = new Set(['some', 'every', 'includes']);
const STRING_SAME = new Set(['trim', 'slice', 'toUpperCase', 'toLowerCase', 'replace', 'replaceAll', 'padStart', 'padEnd', 'repeat', 'at']);
const STRING_BOOL = new Set(['includes', 'startsWith', 'endsWith']);

/** The words a type is written in, for errors. */
export function show(x) {
  switch (x.k) {
    case 'lit':
      return JSON.stringify(x.v);
    case 'array':
      return `${x.of.k === 'union' || x.of.k === 'fn' ? `(${show(x.of)})` : show(x.of)}[]`;
    case 'object':
      return `{ ${Object.entries(x.fields).map(([n, f]) => `${n}${f.optional ? '?' : ''}: ${show(f.type)}`).join(', ')} }`;
    case 'fn':
      return `(${x.params.map((p, i) => `${String.fromCharCode(97 + i)}${p.optional ? '?' : ''}: ${show(p.type)}`).join(', ')}) => ${show(x.returns)}`;
    case 'union':
      return x.of.map(show).join(' | ');
    case 'ref':
      return x.name;
    default:
      return x.k;
  }
}

const union = (of) => {
  const flat = [];
  for (const x of of) for (const y of x.k === 'union' ? x.of : [x]) if (!flat.some((z) => show(z) === show(y))) flat.push(y);
  return flat.length === 1 ? flat[0] : { k: 'union', of: flat };
};

/** A literal's own type: what a var it starts takes (var n = 0 is a number, not just 0). */
const widen = (x) => (x.k === 'lit' ? T(typeof x.v) : x.k === 'union' ? union(x.of.map(widen)) : x);

/**
 * Checks a #strict file. `d` is what desugar() read (its types), `other(spec)` what another .goal file
 * exports (see exportsOf), and `fail(message, node)` reports at a node of `ast`, whose positions are
 * the source's.
 */
export function check(ast, d, other, fail) {
  const decls = new Map([...d.types.decls].map(([n, x]) => [n, x.type]));
  const pos = (node) => node.loc.start.index; // in the source (see relocate in compiler.js)
  const at = (node) => d.types.at.get(pos(node));
  const result = (fn) => d.types.at.get(-pos(fn) - 1); // a function's written result: see syntax.js
  const here = (index) => ({ loc: { start: { index } } });
  const resolve = (x) => {
    while (x.k === 'ref') x = decls.get(x.name);
    return x;
  };
  const known = (x, node) => {
    if (x.k === 'ref' && !decls.has(x.name)) fail(`no type is named ${x.name}`, node);
    for (const y of [...(x.of ? [x.of].flat() : []), ...Object.values(x.fields ?? {}).map((f) => f.type), ...(x.params ?? []).map((p) => p.type), ...(x.returns ? [x.returns] : [])])
      known(y, node);
  };

  // Imports: .goal files that are #strict too (their types, components and server functions), and
  // .js modules, whose values are unknown until given a type.
  const imported = new Map(); // local name -> its type
  for (const s of ast.program.body) {
    if (!t.isImportDeclaration(s)) continue;
    const spec = s.source.value;
    if (!spec.endsWith('.goal')) {
      for (const x of s.specifiers) imported.set(x.local.name, { k: 'unknown', js: spec });
      continue;
    }
    const info = other?.(spec);
    if (!info?.strict) fail(`${spec} isn't #strict: a #strict file can import only #strict .goal files`, s);
    s.specifiers = s.specifiers.filter((x) => {
      const name = t.isImportSpecifier(x) ? x.imported.name : 'default';
      if (info.types.has(name)) {
        decls.set(x.local.name, info.types.get(name)); // a type: it exists only here
        return false;
      }
      imported.set(x.local.name, info.values.get(name) ?? UNKNOWN);
      return true;
    });
  }
  for (const x of d.types.decls.values()) known(x.type, here(x.at));
  for (const [i, x] of d.types.at) known(x, here(i < 0 ? -i - 1 : i));

  const server = new Set(d.serverFns.map((f) => f.name));
  const fns = new Map(); // function node -> its type
  const comps = new Map(); // component name -> its props type, or null for one without props
  const types = new Map(); // binding -> its type, once worked out

  traverse(ast, {
    Program(p) {
      for (const s of p.get('body')) {
        const fn = s.isExportNamedDeclaration() || s.isExportDefaultDeclaration() ? s.get('declaration') : s;
        if (!fn.isFunctionDeclaration() || !fn.node.id) continue;
        const name = fn.node.id.name;
        const param = fn.node.params[0];
        if (/^[A-Z]/.test(name)) {
          if (param && !at(param)) fail(`give ${name}'s props a type: function ${name}(props: { ... })`, param);
          comps.set(name, param ? resolve(at(param)) : null);
        } else if (server.has(name))
          for (const x of fn.node.params) if (!at(x)) fail(`${name}'s arguments come from the network: give ${t.isIdentifier(x) ? x.name : 'each one'} a type`, x);
        const returns = result(fn.node);
        if (server.has(name) && returns && !json(resolve(returns))) fail(`${name}'s result travels as JSON: ${show(returns)} can't`, fn.node);
      }
      p.stop();
    },
  });

  /** Can a value of this type travel as JSON? */
  function json(x) {
    x = resolve(x);
    if (x.k === 'fn' || x.k === 'Markup') return false;
    if (x.k === 'array') return json(x.of);
    if (x.k === 'union') return x.of.every(json);
    if (x.k === 'object') return Object.values(x.fields).every((f) => json(f.type));
    return true;
  }

  /** Does a value of type s fit where type to is expected? Unknown fits anywhere, and takes anything. */
  function fits(s, to) {
    s = resolve(s);
    to = resolve(to);
    if (s.k === 'unknown' || to.k === 'unknown' || s.k === 'never' || to.k === 'void') return true;
    if (s.k === 'union') return s.of.every((x) => fits(x, to));
    if (to.k === 'union') return to.of.some((x) => fits(s, x));
    if (s.k === 'lit') return to.k === 'lit' ? to.v === s.v : to.k === typeof s.v;
    if (s.k !== to.k) return s.k === 'void' && to.k === 'undefined';
    if (s.k === 'array') return fits(s.of, to.of);
    if (s.k === 'object')
      return Object.entries(to.fields).every(([n, f]) => (s.fields[n] ? fits(s.fields[n].type, f.optional ? union([f.type, T('undefined')]) : f.type) : f.optional));
    if (s.k === 'fn') return to.params.every((p, i) => !s.params[i] || fits(p.type, s.params[i].type)) && fits(s.returns, to.returns);
    return true;
  }

  /** The type of what a binding holds. */
  function bindingType(b) {
    if (types.has(b)) return types.get(b);
    types.set(b, UNKNOWN); // while working it out: a binding that reads itself is unknown
    const x = workOut(b);
    types.set(b, x);
    return x;
  }

  function workOut(b) {
    const p = b.path;
    if (imported.has(b.identifier.name) && (p.isImportSpecifier() || p.isImportDefaultSpecifier() || p.isImportNamespaceSpecifier())) return imported.get(b.identifier.name);
    if (p.isVariableDeclarator()) {
      if (!t.isIdentifier(p.node.id)) return UNKNOWN;
      const written = at(p.node.id);
      if (written) return written;
      const init = p.get('init');
      const x = init.node ? typeOf(init) : T('undefined');
      const name = p.node.id.name;
      if (x.js) fail(`${name} comes from ${x.js}, which has no types: give it one, like ${p.parent.kind} ${name}: Type = ...`, p.node);
      if (b.kind === 'var' && (!init.node || x.k === 'null' || x.k === 'undefined' || (x.k === 'array' && x.of.k === 'never')))
        fail(`give ${name} a type: its initial value doesn't say, so write var ${name}: Type = ...`, p.node);
      return widen(x);
    }
    if (p.isFunctionDeclaration()) return fnType(p);
    if (b.kind === 'param') return paramType(b);
    return UNKNOWN;
  }

  /** A parameter's type: written, a component's prop, or what a list method gives its callback. */
  function paramType(b) {
    const fn = b.scope.path;
    const i = fn.node.params.findIndex((x) => Object.values(t.getBindingIdentifiers(x)).includes(b.identifier));
    const param = fn.node.params[i];
    const whole = t.isAssignmentPattern(param) ? param.left : param;
    const written = at(whole);
    let x = written ? resolve(written) : null;
    if (!x && fn.parentPath.isCallExpression() && fn.listKey === 'arguments' && fn.key === 0) {
      const callee = fn.parentPath.get('callee');
      if (callee.isMemberExpression() && !callee.node.computed) {
        const list = resolve(typeOf(callee.get('object')));
        if (list.k === 'array') x = i === 0 ? list.of : i === 1 ? T('number') : null;
      }
    }
    if (!x) return UNKNOWN;
    if (whole === b.identifier) return x;
    // Destructured: { a, b } takes the fields of the object type.
    const field = x.k === 'object' ? x.fields[b.identifier.name] : null;
    return field ? (field.optional ? union([field.type, T('undefined')]) : field.type) : UNKNOWN;
  }

  function fnType(p) {
    if (fns.has(p.node)) return fns.get(p.node);
    const written = result(p.node);
    fns.set(p.node, { k: 'fn', params: [], returns: UNKNOWN });
    const params = p.node.params.map((x) => ({ type: at(t.isAssignmentPattern(x) ? x.left : x) ?? UNKNOWN, optional: t.isAssignmentPattern(x) }));
    let returns = written;
    if (!returns) {
      const body = p.get('body');
      if (!body.isBlockStatement()) returns = typeOf(body);
      else {
        const found = [];
        body.traverse({
          ReturnStatement(r) {
            found.push(r.node.argument ? typeOf(r.get('argument')) : T('undefined')); // its own: nested functions are skipped
          },
          Function(f) {
            f.skip();
          },
        });
        returns = found.length ? union(found) : T('void');
      }
    }
    const x = { k: 'fn', params, returns };
    fns.set(p.node, x);
    return x;
  }

  /** The type of an expression, as far as it can be worked out: unknown otherwise. */
  function typeOf(p) {
    const n = p.node;
    if (p.isNumericLiteral() || p.isStringLiteral() || p.isBooleanLiteral()) return { k: 'lit', v: n.value };
    if (p.isNullLiteral()) return T('null');
    if (p.isTemplateLiteral()) return T('string');
    if (p.isJSXElement() || p.isJSXFragment()) return T('Markup');
    if (p.isIdentifier()) {
      if (n.name === 'undefined') return T('undefined');
      const b = p.scope.getBinding(n.name);
      return b ? bindingType(b) : UNKNOWN;
    }
    if (p.isArrayExpression()) return { k: 'array', of: n.elements.length ? widen(union(p.get('elements').map(typeOf))) : T('never') };
    if (p.isObjectExpression()) {
      const fields = {};
      for (const f of p.get('properties')) {
        if (!f.isObjectProperty() || f.node.computed) return UNKNOWN;
        fields[t.isIdentifier(f.node.key) ? f.node.key.name : f.node.key.value] = { type: widen(typeOf(f.get('value'))), optional: false };
      }
      return { k: 'object', fields };
    }
    if (p.isMemberExpression()) return member(p);
    if (p.isCallExpression()) return call(p);
    if (p.isBinaryExpression()) {
      if (n.operator === '+') {
        const [a, b] = [resolve(typeOf(p.get('left'))), resolve(typeOf(p.get('right')))];
        const str = (x) => x.k === 'string' || (x.k === 'lit' && typeof x.v === 'string');
        const num = (x) => x.k === 'number' || (x.k === 'lit' && typeof x.v === 'number');
        return str(a) || str(b) ? T('string') : num(a) && num(b) ? T('number') : UNKNOWN;
      }
      return ['-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>'].includes(n.operator) ? T('number') : T('boolean');
    }
    if (p.isLogicalExpression()) return union([typeOf(p.get('left')), typeOf(p.get('right'))]);
    if (p.isUnaryExpression()) return n.operator === '!' || n.operator === 'delete' ? T('boolean') : n.operator === 'typeof' ? T('string') : n.operator === 'void' ? T('undefined') : T('number');
    if (p.isUpdateExpression()) return T('number');
    if (p.isConditionalExpression()) return union([typeOf(p.get('consequent')), typeOf(p.get('alternate'))]);
    if (p.isAssignmentExpression()) return typeOf(p.get('right'));
    if (p.isArrowFunctionExpression() || p.isFunctionExpression()) return fnType(p);
    if (p.isAwaitExpression()) return typeOf(p.get('argument'));
    return UNKNOWN;
  }

  function member(p) {
    const obj = resolve(typeOf(p.get('object')));
    if (obj.k === 'unknown') return obj;
    if (p.node.computed) return obj.k === 'array' ? obj.of : UNKNOWN;
    const name = p.node.property.name;
    if (name === 'length' && (obj.k === 'array' || obj.k === 'string')) return T('number');
    const f = obj.k === 'object' ? obj.fields[name] : null;
    return f ? (f.optional ? union([f.type, T('undefined')]) : f.type) : UNKNOWN;
  }

  function call(p) {
    const callee = p.get('callee');
    const args = p.get('arguments');
    if (callee.isIdentifier()) {
      const conv = { Number: 'number', String: 'string', Boolean: 'boolean' }[callee.node.name];
      if (conv && !p.scope.getBinding(callee.node.name)) return T(conv);
      // call(load(id)): the server function's answer as state (load.js); no value until it answers
      if (callee.node.name === 'call' && !p.scope.getBinding('call') && args[0]?.isCallExpression()) {
        const field = (type) => ({ type, optional: false });
        const run = field({ k: 'fn', params: [], returns: T('undefined') });
        return { k: 'object', fields: { value: field(union([widen(typeOf(args[0])), T('undefined')])), loading: field(T('boolean')), error: field(union([T('string'), T('null')])), reload: run, cancel: run } };
      }
    }
    if (callee.isMemberExpression() && !callee.node.computed) {
      const obj = resolve(typeOf(callee.get('object')));
      const name = callee.node.property.name;
      if (obj.k === 'array') {
        if (name === 'map') {
          const fn = args[0] && resolve(typeOf(args[0]));
          return { k: 'array', of: fn?.k === 'fn' ? widen(fn.returns) : UNKNOWN };
        }
        if (ARRAY_SAME.has(name)) return obj;
        if (name === 'find') return union([obj.of, T('undefined')]);
        if (ARRAY_BOOL.has(name)) return T('boolean');
        if (name === 'join') return T('string');
        if (name === 'indexOf' || name === 'findIndex') return T('number');
      }
      if (obj.k === 'string' || (obj.k === 'lit' && typeof obj.v === 'string')) {
        if (STRING_SAME.has(name)) return T('string');
        if (STRING_BOOL.has(name)) return T('boolean');
        if (name === 'indexOf') return T('number');
        if (name === 'split') return { k: 'array', of: T('string') };
      }
    }
    const fn = resolve(typeOf(callee));
    return fn.k === 'fn' ? fn.returns : fn.js ? fn : UNKNOWN;
  }

  const sure = (s, to, message, node) => {
    if (!fits(s, to)) fail(message, node);
  };
  const near = (word, words) => words.find((w) => w !== word && w.length > 2 && distance(word, w) <= 2);

  // What each part of the file does with these types.
  traverse(ast, {
    VariableDeclarator(p) {
      if (!t.isIdentifier(p.node.id)) return;
      const b = p.scope.getBinding(p.node.id.name);
      const x = bindingType(b);
      if (at(p.node.id) && p.node.init) sure(typeOf(p.get('init')), x, `${p.node.id.name} is ${show(x)}, not ${show(widen(typeOf(p.get('init'))))}`, p.node.init);
    },
    AssignmentExpression(p) {
      const left = p.get('left');
      if (!left.isIdentifier() || p.node.operator !== '=') return;
      const b = p.scope.getBinding(left.node.name);
      if (!b) return;
      const x = bindingType(b);
      const v = typeOf(p.get('right'));
      sure(v, x, `${left.node.name} is ${show(x)}, not ${show(widen(v))}`, p.node);
    },
    ReturnStatement(p) {
      const fn = p.getFunctionParent();
      const written = fn && result(fn.node);
      if (!written || !p.node.argument) return;
      const name = fn.node.id?.name ?? 'the function';
      sure(typeOf(p.get('argument')), written, `${name} returns ${show(written)}, not ${show(widen(typeOf(p.get('argument'))))}`, p.node);
    },
    CallExpression(p) {
      const fn = resolve(typeOf(p.get('callee')));
      if (fn.k !== 'fn') return;
      const name = p.get('callee').isIdentifier() ? p.node.callee.name : 'the function';
      const args = p.get('arguments');
      const need = fn.params.filter((x) => !x.optional).length;
      if (args.length < need || args.length > fn.params.length) fail(`${name} takes ${need === fn.params.length ? need : `${need} to ${fn.params.length}`} argument${fn.params.length === 1 ? '' : 's'}, not ${args.length}`, p.node);
      args.forEach((a, i) => sure(typeOf(a), fn.params.at(i).type, `${name} takes ${show(fn.params.at(i).type)}, not ${show(widen(typeOf(a)))}`, a.node));
    },
    JSXExpressionContainer(p) {
      if (!p.parentPath.isJSXElement() && !p.parentPath.isJSXFragment()) return;
      const e = p.get('expression');
      if (e.isJSXEmptyExpression()) return;
      const bad = unrenderable(typeOf(e));
      if (bad) fail(bad === 'fn' ? "a function can't be rendered: call it, or render what it gives" : `${show(bad)} can't be rendered: render a field of it, like {${e.isIdentifier() ? e.node.name : 'it'}.${Object.keys(resolve(bad).fields)[0] ?? 'name'}}`, e.node);
    },
    JSXAttribute(p) {
      const v = p.get('value');
      const name = p.node.name.name;
      if (!v.isJSXExpressionContainer() || /^[A-Z]/.test(p.parent.name.name)) return; // a component's prop: see JSXOpeningElement
      if (BOOLEAN_ATTRS.has(name)) {
        const x = typeOf(v.get('expression'));
        sure(x, T('boolean'), `${name} takes true or false, not ${show(widen(x))}`, v.node);
      }
    },
    JSXOpeningElement(p) {
      const name = p.node.name.name;
      if (typeof name !== 'string' || !/^[A-Z]/.test(name)) return;
      const props = comps.has(name) ? comps.get(name) : resolve(imported.get(name) ?? UNKNOWN).props;
      if (props === undefined) return; // a component whose props aren't known
      const fields = props?.fields ?? {};
      const given = new Set();
      for (const a of p.get('attributes')) {
        if (!a.isJSXAttribute()) return; // a spread: the compiler says it isn't supported
        const prop = a.node.name.name;
        given.add(prop);
        if (!fields[prop]) fail(`${name} has no prop ${prop}${near(prop, Object.keys(fields)) ? `; did you mean ${near(prop, Object.keys(fields))}?` : ''}`, a.node);
        const v = a.get('value');
        const x = !v.node ? { k: 'lit', v: true } : v.isStringLiteral() ? { k: 'lit', v: v.node.value } : typeOf(v.get('expression'));
        sure(x, fields[prop].type, `${name}'s ${prop} is ${show(fields[prop].type)}, not ${show(widen(x))}`, a.node);
      }
      const kids = p.parent.children.some((c) => !t.isJSXText(c) || c.value.trim());
      if (kids) {
        if (!fields.children) fail(`${name} takes no children`, p.parent);
        given.add('children');
      }
      for (const [n, f] of Object.entries(fields)) if (!f.optional && !given.has(n)) fail(`${name} needs ${n}`, p.node);
    },
  });

  // What the server checks at runtime: each server function's parameters, declared names written out.
  const out = (x, seen = new Set()) => {
    if (x.k === 'ref') return seen.has(x.name) ? UNKNOWN : out(decls.get(x.name), new Set([...seen, x.name]));
    if (x.k === 'array') return { k: 'array', of: out(x.of, seen) };
    if (x.k === 'union') return { k: 'union', of: x.of.map((y) => out(y, seen)) };
    if (x.k === 'object') return { k: 'object', fields: Object.fromEntries(Object.entries(x.fields).map(([n, f]) => [n, { type: out(f.type, seen), optional: f.optional }])) };
    return x;
  };
  const params = new Map();
  for (const s of ast.program.body) {
    const fn = t.isExportNamedDeclaration(s) ? s.declaration : s;
    if (t.isFunctionDeclaration(fn) && server.has(fn.id.name))
      params.set(fn.id.name, fn.params.map((x) => ({ type: out(at(t.isAssignmentPattern(x) ? x.left : x)), optional: t.isAssignmentPattern(x) })));
  }
  return { params };

  /** What in a type can't be rendered as markup: an object, or 'fn' for a function. */
  function unrenderable(x) {
    x = resolve(x);
    if (x.k === 'fn') return 'fn';
    if (x.k === 'object') return x;
    if (x.k === 'array') return unrenderable(x.of);
    if (x.k === 'union') return x.of.map(unrenderable).find(Boolean);
    return null;
  }
}

/** How far apart two words are: edits to turn one into the other. */
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next.push(Math.min(row.at(j) + 1, next.at(j - 1) + 1, row.at(j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1)));
    row = next;
  }
  return row.at(-1);
}

/**
 * What a .goal file gives a #strict file that imports it: whether it is #strict, its exported types
 * (with the names they use resolved), and the type of each exported value: a component carries its
 * props as `props`, a server function its parameters and result.
 */
export function exportsOf(source, file) {
  const d = desugar(source, file);
  const info = { strict: d.strict, types: new Map(), values: new Map() };
  if (!d.strict) return info;
  const decls = new Map([...d.types.decls].map(([n, x]) => [n, x.type]));
  const inline = (x, seen = new Set()) => {
    if (x.k === 'ref') return decls.has(x.name) && !seen.has(x.name) ? inline(decls.get(x.name), new Set([...seen, x.name])) : UNKNOWN;
    if (x.k === 'array') return { k: 'array', of: inline(x.of, seen) };
    if (x.k === 'union') return { k: 'union', of: x.of.map((y) => inline(y, seen)) };
    if (x.k === 'object') return { k: 'object', fields: Object.fromEntries(Object.entries(x.fields).map(([n, f]) => [n, { ...f, type: inline(f.type, seen) }])) };
    if (x.k === 'fn') return { k: 'fn', params: x.params.map((p) => ({ ...p, type: inline(p.type, seen) })), returns: inline(x.returns, seen) };
    return x;
  };
  for (const [n, x] of d.types.decls) if (x.exported) info.types.set(n, inline(x.type));
  const at = (pos) => d.types.at.get(d.map(pos));
  const server = new Set(d.serverFns.map((f) => f.name));
  for (const s of parse(d.code, { sourceType: 'module', plugins: ['jsx'] }).program.body) {
    const fn = s.declaration;
    if (!t.isExportNamedDeclaration(s) || !t.isFunctionDeclaration(fn)) continue;
    const name = fn.id.name;
    if (/^[A-Z]/.test(name)) info.values.set(name, { k: 'unknown', props: fn.params[0] ? inline(at(fn.params[0].start) ?? UNKNOWN) : null });
    else if (server.has(name)) {
      const params = fn.params.map((x) => ({ type: inline(at(x.start) ?? UNKNOWN), optional: false }));
      info.values.set(name, { k: 'fn', params, returns: inline(d.types.at.get(-d.map(fn.start) - 1) ?? UNKNOWN) });
    }
  }
  return info;
}
