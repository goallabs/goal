import { describe, it, expect, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { desugar, GoalError } from '../src/syntax.js';
import { createApp } from '../src/app.js';
import { build, load } from './helpers.js';

const error = (src, f = (s) => desugar(s, 'a.goal')) => {
  try {
    f(src);
  } catch (e) {
    expect(e).toBeInstanceOf(GoalError);
    return e.message.replace(/^\w+\.goal:/, '');
  }
  throw new Error('expected an error');
};

describe('typed route input: syntax and types', () => {
  it('reads the types of json, query and form, and takes them out of the code', () => {
    const d = desugar('#strict\nroute POST /n (json: { a: number }, query: { p?: number }) { return 1; }', 'a.goal');
    expect(d.routes[0].input).toEqual({
      json: { k: 'object', fields: { a: { type: { k: 'number' }, optional: false } } },
      query: { k: 'object', fields: { p: { type: { k: 'number' }, optional: true } } },
    });
    expect(d.code).toBe('\nasync function _$r0(request, _$x) { return 1; }');
  });

  it('reports what is wrong', () => {
    expect(error('route POST /n (json: string) { }')).toBe('1:1: types go in a #strict file: put #strict on the first line');
    expect(error('#strict\nroute POST /n (body: string) { }')).toBe(
      '2:16: a route takes the types of its input: (json: Note, query: { page?: number }, form: { title: string })',
    );
    expect(error('#strict\nroute POST /n ("json": string) { }')).toMatch(/^2:16: a route takes the types of its input/);
    expect(error('#strict\nroute POST /n (json: string, json: number) { }')).toBe('2:30: the route names the type of json twice');
    expect(error('#strict\nroute POST /n (json: string) => { }')).toBe("2:30: the route's body goes in { } after its types");
    expect(error('#strict\nroute POST /n (form: { tags: string[] }) { }', build)).toBe(
      '2:1: form arrives as text: give it an object type whose fields are string, number or boolean, not { tags: string[] }',
    );
    expect(error('#strict\nroute POST /n (query: string) { }', build)).toMatch(/^2:1: query arrives as text/);
  });

  it('gives request those types inside the route', () => {
    expect(error('#strict\ntype N = { title: string };\nroute POST /n (json: N) { const n: number = request.json.title; return json(n); }', build)).toBe(
      '3:45: n is number, not string',
    );
    expect(() => build('#strict\ntype N = { title: string };\nroute POST /n (json: N) { const t: string = request.json.title; request.user = 1; return json([t, request.headers]); }')).not.toThrow();
  });
});

const app = `#strict
type NewNote = { title: string, tags?: string[], kind?: 'a' | 'b' };
group /api api {
  before { if (request.headers.authorization !== 'k') return json({ error: 'sign in' }, 401); }
  route POST /notes (json: NewNote) { return json({ got: request.json.title }, 201); }
  route GET /notes (query: { page: number, all?: boolean, q?: string }) { return json(request.query); }
}
route POST /form (form: { n: number, ok: boolean }) { return json(request.form); }
`;

const servers = [];
afterAll(() => Promise.all(servers.map((s) => new Promise((ok) => s.close(ok)))));
let url;
const call = (path, body, headers = {}) =>
  fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'k', 'content-type': 'application/json', ...headers }, body });

describe('typed route input: requests', () => {
  it('lets input of the types through, and answers 400 naming what is wrong', async () => {
    const { server } = await load(app);
    const s = createServer(createApp(server._$routes, { log: () => {}, config: { csrf: false } }));
    servers.push(s);
    await new Promise((ok) => s.listen(0, ok));
    url = `http://localhost:${s.address().port}`;

    const ok = await call('/api/notes', '{"title":"x","tags":["a"],"kind":"b"}');
    expect([ok.status, await ok.json()]).toEqual([201, { got: 'x' }]);
    const bad = await call('/api/notes', '{"tags":[1,"b",2],"kind":"c"}');
    expect([bad.status, await bad.json()]).toEqual([
      400,
      { error: 'Bad request', problems: ['json.title: missing', 'json.tags[0]: expected string', 'json.tags[2]: expected string', 'json.kind: expected "a" or "b"'] },
    ]);
    expect(await (await call('/api/notes', '[1]')).json()).toEqual({ error: 'Bad request', problems: ['json: expected an object'] });
    expect(await (await call('/api/notes', '{"title":"x","tags":"a"}')).json()).toEqual({ error: 'Bad request', problems: ['json.tags: expected a list'] });
    expect(await (await call('/api/notes', '')).json()).toEqual({ error: 'Bad request', problems: ['json: expected an object'] });
  });

  it('checks after the before blocks, and lists ten problems at most', async () => {
    expect((await call('/api/notes', '{}', { authorization: 'no' })).status).toBe(401);
    const many = await call('/api/notes', JSON.stringify({ title: 'x', tags: Array(50).fill(1) }));
    expect((await many.json()).problems).toHaveLength(10);
  });

  it('converts a query or a form to the numbers and booleans its type has', async () => {
    expect(await (await call('/api/notes?page=2&all=true&q=7')).json()).toEqual({ page: 2, all: true, q: '7' });
    expect(await (await call('/api/notes?page=-1.5&all=false')).json()).toEqual({ page: -1.5, all: false });
    expect(await (await call('/api/notes?page=two&all=maybe')).json()).toEqual({ error: 'Bad request', problems: ['query.page: expected number', 'query.all: expected boolean'] });
    expect(await (await call('/api/notes')).json()).toEqual({ error: 'Bad request', problems: ['query.page: missing'] });
    const form = await call('/form', 'n=3&ok=on', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(await form.json()).toEqual({ n: 3, ok: true });
  });

  it('answers a page route with an error page that lists the problems', async () => {
    const res = await call('/form', 'n=x', { 'content-type': 'application/x-www-form-urlencoded' });
    expect([res.status, res.headers.get('content-type')]).toEqual([400, 'text/html; charset=utf-8']);
    expect(await res.text()).toContain('<h1>Bad request</h1><ul><li>form.n: expected number</li><li>form.ok: missing</li></ul>');
  });
});
