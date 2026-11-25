import { describe, it, expect } from 'vitest';
import { desugar, GoalError } from '../src/syntax.js';

const code = (src) => desugar(src, 'a.goal').code;
const error = (src) => {
  try {
    desugar(src, 'a.goal');
  } catch (e) {
    expect(e).toBeInstanceOf(GoalError);
    return e.message;
  }
  throw new Error('expected an error');
};

describe('if/else in markup', () => {
  it('becomes a ternary, with null when there is no else', () => {
    expect(code('x = <p>{if (a) <b/>}</p>;')).toBe('x = <p>{ (a) ? ( <b/>) : null}</p>;');
    expect(code('x = <p>{if (a) <b/> else <i/>}</p>;')).toBe('x = <p>{ (a) ? ( <b/>) : (<i/>)}</p>;');
    expect(code("x = <p>{if (a) 1 else if (b) 2 else if (c) 3}</p>;")).toBe('x = <p>{ (a) ? ( 1) :  (b) ? ( 2) :  (c) ? ( 3) : null}</p>;');
  });

  it('works in attributes and nested, and leaves JavaScript if statements alone', () => {
    expect(code("x = <p class={if (a) 'on' else 'off'}>{if (a) <b>{if (c) 1}</b>}</p>;")).toBe(
      "x = <p class={ (a) ? ( 'on') : ('off')}>{ (a) ? ( <b>{ (c) ? ( 1) : null}</b>) : null}</p>;",
    );
    expect(code('function f() { if (a) { g(); } else h(); }')).toBe('function f() { if (a) { g(); } else h(); }');
    expect(code('x = <p>{}{a}</p>;')).toBe('x = <p>{}{a}</p>;');
  });
});

describe('routes', () => {
  it('become async functions, and are listed', () => {
    const d = desugar('route GET / {\n  return 1;\n}\nroute DELETE /users/{id}/posts/{post} { await x; }\nroute = 2;', 'a.goal');
    expect(d.code).toBe('async function _$r0(request, _$x) {\n  return 1;\n}\nasync function _$r1(request, _$x) { await x; }\nroute = 2;');
    expect(d.routes).toEqual([
      { method: 'GET', path: '/', params: [], name: '_$r0' },
      { method: 'DELETE', path: '/users/{id}/posts/{post}', params: ['id', 'post'], name: '_$r1' },
    ]);
  });

  it('are only routes at the top level', () => {
    expect(() => desugar('function f() { route GET / {} }', 'a.goal')).toThrow(GoalError);
  });

  it.each([
    ['route GET /{}', '1:1: write a route as: route GET /path { ... }'],
    ['route FETCH / {}', 'unknown method FETCH; use GET, POST, PUT, PATCH, DELETE'],
    ['route GET users {}', 'write the path with plain words and {name} parameters, like /users/{id} (not users)'],
    ['route GET /a b {}', 'write a route as'],
    ['route GET /a/{x-y} {}', 'not /a/{x-y}'],
    ['route GET /a//b {}', 'not /a//b'],
    ['route GET /{a}/{a} {}', 'the path names {a} twice'],
    ['route GET /{request} {}', 'something other than {request}'],
  ])('%s', (src, message) => {
    expect(error(src)).toContain(message);
  });
});

describe('server functions', () => {
  it('become async functions, and are listed', () => {
    const d = desugar('server function a(x) { return await db(x); }\nexport server function b() {}\nconst server = 1;\nserver + 1;', 'a.goal');
    expect(d.code).toBe('async function a(x) { return await db(x); }\nexport async function b() {}\nconst server = 1;\nserver + 1;');
    expect(d.serverFns).toEqual([
      { name: 'a', exported: false },
      { name: 'b', exported: true },
    ]);
  });

  it('are declared at the top level only', () => {
    expect(error('function f() { server function z() {} }')).toBe('a.goal:1:16: declare a server function at the top level of a file');
  });
});

describe('positions', () => {
  it('reports JavaScript errors where they are in the source', () => {
    expect(error('const a = 1;\nconst = 2;')).toBe('a.goal:2:7: Unexpected token');
  });

  it('maps output positions back to the source', () => {
    const src = 'route GET / { return <p>{if (a) 1}</p>; }';
    const d = desugar(src, 'a.goal');
    const out = d.code;
    expect(d.map(out.indexOf('return'))).toBe(src.indexOf('return'));
    expect(d.map(out.indexOf('_$r0'))).toBe(0);
    expect(d.map(out.indexOf('(a)'))).toBe(src.indexOf('(a)'));
    expect(d.map(out.indexOf('1)'))).toBe(src.indexOf('1}'));
    expect(d.map(out.indexOf('</p>'))).toBe(src.indexOf('</p>'));
  });
});
