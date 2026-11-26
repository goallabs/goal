import { describe, it, expect, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { desugar, GoalError } from '../src/syntax.js';
import { createApp } from '../src/app.js';
import { load } from './helpers.js';

const error = (src) => {
  try {
    desugar(src, 'a.goal');
  } catch (e) {
    expect(e).toBeInstanceOf(GoalError);
    return e.message.replace(/^a\.goal:/, '');
  }
  throw new Error('expected an error');
};

describe('route groups: syntax', () => {
  it('join their paths, and route / is the group itself', () => {
    const d = desugar(
      `group /api {
  route GET / { }
  route GET /notes/{id} { }
  group /admin/{team} { route POST /x { } }
}
group / { route GET /y { } route GET / { } }`,
      'a.goal',
    );
    expect(d.routes.map((r) => [r.method, r.path, r.params])).toEqual([
      ['GET', '/api', []],
      ['GET', '/api/notes/{id}', ['id']],
      ['POST', '/api/admin/{team}/x', ['team']],
      ['GET', '/y', []],
      ['GET', '/', []],
    ]);
    expect(d.code).not.toContain('group');
  });

  it('give their routes the before blocks, outer first, and api, with the api group\'s path, to everything inside', () => {
    const d = desugar(
      `group /a api {
  before { }
  group /b { before { } route GET /c { } }
  route GET /d { }
}
route GET /e { }`,
      'a.goal',
    );
    expect(d.routes.map((r) => [r.path, r.api, r.before])).toEqual([
      ['/a/b/c', '/a', ['_$b0', '_$b1']],
      ['/a/d', '/a', ['_$b0']],
      ['/e', undefined, undefined],
    ]);
    expect(d.befores).toEqual([
      { name: '_$b0', params: [] },
      { name: '_$b1', params: [] },
    ]);
    expect(d.code).toContain('async function _$b0(request, _$x) { }');
  });

  it('take typed parameters in a #strict file', () => {
    const d = desugar('#strict\ngroup /t/{team: number} { route GET /u/{id: string} { } }', 'a.goal');
    expect(d.routes[0]).toMatchObject({ path: '/t/{team}/u/{id}', params: ['team', 'id'], types: { team: 'number', id: 'string' } });
    expect(error('group /t/{team: number} { }')).toBe('1:1: types go in a #strict file: put #strict on the first line');
  });

  it('leave the name group alone elsewhere', () => {
    expect(desugar('const group = (x) => x; group(1); group\n/ 2 / 3;', 'a.goal').routes).toEqual([]);
  });

  it('report what is wrong', () => {
    expect(error('group /a b { }')).toBe('1:1: write a group as: group /path { routes }, or group /path api { routes }');
    expect(error('group /a/b c/ { }')).toBe('1:1: write a group as: group /path { routes }, or group /path api { routes }');
    expect(error('group /a { before { } before { } }')).toBe('1:23: a group has one before block');
    expect(error('group /a { const x = 1; }')).toBe('1:12: a group holds routes, groups and a before { } block');
    expect(error('group /a { route GET / { }')).toBe('1:27: this group has no closing }');
    expect(error('group /a/{id} { route GET /{id} { } }')).toBe('1:17: the path names {id} twice');
    expect(error('group /a { route GO / { } }')).toBe('1:12: unknown method GO; use GET, POST, PUT, PATCH, DELETE');
    expect(error('group /a% { }')).toBe('1:1: write the path with plain words and {name} parameters, like /users/{id} (not /a%)');
  });
});

const app = `#strict
group /api api {
  before {
    if (request.headers.authorization !== 'Bearer k') return json({ error: 'sign in' }, 401);
    request.user = 'ann';
  }
  route GET /me { return json({ user: request.user, cookies: request.cookies }); }
  route POST /notes { return json({ got: request.json, by: request.user }, 201); }
  route POST /hook { return reply(request.body.toString()); }
  route GET /gone { return notFound(); }
  route GET /n/{id: number} { return json(id); }
  route GET /crumb { cookie('a', 'b'); return json(1); }
  group /teams/{team} {
    before { if (team === 'closed') return json({ error: 'closed' }, 403); request.order = [request.user, team]; }
    route GET /who { return json(request.order); }
  }
}
group /admin {
  before { if (!request.query.admin) return redirect('/'); }
  route GET / { return <main>admin</main>; }
}
route GET / { return <main>home</main>; }
`;

const servers = [];
afterAll(() => Promise.all(servers.map((s) => new Promise((ok) => s.close(ok)))));
async function start(config = {}) {
  const { server } = await load(app);
  const s = createServer(createApp(server._$routes, { log: () => {}, config }));
  servers.push(s);
  await new Promise((ok) => s.listen(0, ok));
  return `http://localhost:${s.address().port}`;
}
const auth = { authorization: 'Bearer k' };

describe('route groups: requests', () => {
  it('run the before blocks first, outer first, and a block that answers stops the route', async () => {
    const url = await start();
    expect((await fetch(url + '/api/me')).status).toBe(401);
    expect(await (await fetch(url + '/api/teams/red/who', { headers: auth })).json()).toEqual(['ann', 'red']);
    const closed = await fetch(url + '/api/teams/closed/who', { headers: auth });
    expect([closed.status, await closed.json()]).toEqual([403, { error: 'closed' }]);
    expect((await fetch(url + '/admin', { redirect: 'manual' })).status).toBe(303);
    expect(await (await fetch(url + '/admin?admin=1')).text()).toContain('<main>admin</main>');
  });

  it('take requests from other programs in an api group: no CSRF check, and no cookies either way', async () => {
    const url = await start();
    const res = await fetch(url + '/api/notes', { method: 'POST', headers: { ...auth, 'content-type': 'application/json', cookie: 'sid=1' }, body: '{"t":"x"}' });
    expect([res.status, res.headers.get('set-cookie'), await res.json()]).toEqual([201, null, { got: { t: 'x' }, by: 'ann' }]);
    expect(await (await fetch(url + '/api/me', { headers: { ...auth, cookie: 'sid=1' } })).json()).toEqual({ user: 'ann', cookies: {} });
    // Outside the group, the defaults stay
    expect((await fetch(url + '/')).headers.get('set-cookie')).toContain('goal_csrf=');
  });

  it('read any body in an api group, as bytes in request.body', async () => {
    const url = await start();
    const hook = await fetch(url + '/api/hook', { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body: 'signed' });
    expect(await hook.text()).toBe('signed');
    const bad = await fetch(url + '/api/hook', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{' });
    expect([bad.status, await bad.json()]).toEqual([400, { error: 'Bad request' }]);
  });

  it('answer errors as JSON in an api group', async () => {
    const url = await start();
    const gone = await fetch(url + '/api/gone', { headers: auth });
    expect([gone.status, await gone.json()]).toEqual([404, { error: 'Not found' }]);
    // A path under the group that no route takes, or whose typed parameter doesn't match, too
    for (const path of ['/api/nothing', '/api/teams/red/who/else', '/api/n/1'])
      expect([path, (await fetch(url + path, { headers: auth })).headers.get('content-type')]).toEqual([path, 'application/json; charset=utf-8']);
    expect((await fetch(url + '/apix')).headers.get('content-type')).toBe('text/html; charset=utf-8');
    const wrong = await fetch(url + '/api/me', { method: 'DELETE', headers: auth });
    expect([wrong.status, wrong.headers.get('allow'), await wrong.json()]).toEqual([405, 'GET', { error: 'Method not allowed' }]);
    const crumb = await fetch(url + '/api/crumb', { headers: auth });
    expect([crumb.status, await crumb.json()]).toEqual([500, { error: 'Something went wrong' }]);
    expect((await fetch(url + '/admin', { method: 'DELETE' })).headers.get('content-type')).toBe('text/html; charset=utf-8');
    const limited = await start({ rateLimit: { max: 0 } });
    const many = await fetch(limited + '/api/notes', { method: 'POST', headers: auth });
    expect([many.status, await many.json()]).toEqual([429, { error: 'Too many requests' }]);
  });

  it('keep api answers from other sites unless goal.config.js cors lets them', async () => {
    const closed = await start();
    const o = { origin: 'https://app.example' };
    expect((await fetch(closed + '/api/me', { headers: { ...auth, ...o } })).headers.get('access-control-allow-origin')).toBe(null);
    const any = await start({ cors: '*' });
    const r = await fetch(any + '/api/me', { headers: { ...auth, ...o } });
    expect([r.headers.get('access-control-allow-origin'), r.headers.get('vary')]).toEqual(['*', null]);
    const listed = await start({ cors: ['https://app.example'] });
    const yes = await fetch(listed + '/api/me', { headers: { ...auth, ...o } });
    expect([yes.headers.get('access-control-allow-origin'), yes.headers.get('vary')]).toEqual(['https://app.example', 'Origin']);
    const no = await fetch(listed + '/api/me', { headers: { ...auth, origin: 'https://evil.example' } });
    expect([no.headers.get('access-control-allow-origin'), no.headers.get('vary')]).toEqual([null, 'Origin']);
    expect((await fetch(listed + '/', { headers: o })).headers.get('access-control-allow-origin')).toBe(null);
  });

  it('answer CORS preflights in an api group', async () => {
    const url = await start({ cors: 'https://app.example' });
    const ask = (origin, headers) =>
      fetch(url + '/api/notes', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', ...(headers && { 'access-control-request-headers': headers }) } });
    const ok = await ask('https://app.example', 'authorization, content-type');
    expect([ok.status, ok.headers.get('allow'), ok.headers.get('access-control-allow-methods'), ok.headers.get('access-control-allow-headers'), ok.headers.get('access-control-max-age')]).toEqual([
      204,
      'POST, OPTIONS',
      'POST',
      'authorization, content-type',
      '600',
    ]);
    expect((await ask('https://app.example', 'a b')).headers.get('access-control-allow-headers')).toBe(null);
    expect((await ask('https://app.example')).headers.get('access-control-allow-headers')).toBe(null);
    const no = await ask('https://evil.example', 'authorization');
    expect([no.status, no.headers.get('access-control-allow-methods'), no.headers.get('access-control-allow-headers')]).toEqual([204, null, null]);
    // Outside an api group, OPTIONS is a method like any other
    expect((await fetch(url + '/admin', { method: 'OPTIONS' })).status).toBe(403);
  });
});
