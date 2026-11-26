---
title: Routes
nav_order: 3
---

# Routes

```jsx
route GET /notes { ... }
route POST /notes { ... }
route GET /users/{id}/posts/{post} { ... }
```

A route is written at the top level of any `.goal` file. It has a method (`GET`, `POST`, `PUT`,
`PATCH` or `DELETE`), a path where `{name}` is a parameter, and a body that runs on the server once
per request. The body may use `await`.

## In the body

- Path parameters are plain variables (`id`, `post`), as strings. They're constants: give a new value
  a name of its own (`const n = Number(id)`).
- `request` has `method`, `path`, `url`, `params`, `query`, `headers`, `cookies`, `form` (a form's
  fields), `files` (a form's files), `json` (a JSON body) and `signal`, an AbortSignal that's aborted
  when the client goes away.
- `cookie(name, value, options)` sets a cookie.

## What a route returns

| Return | Response |
|---|---|
| Markup | An HTML page |
| `redirect('/path')` | 303 to that path, on this site only; `redirect(url, { external: true })` to leave it |
| `json(value, status, headers)` | JSON |
| `reply(body, { status, type, headers })` | Markup as a page, text, or bytes (a Buffer), with any status and headers |
| `stream(source, { status, type, headers })` | Each piece an async generator gives, sent as it comes |
| `events(source, { ping, headers })` | Server-sent events: each value the source gives, as JSON |
| `notFound()` | 404 |
| Nothing | 204 |

The security headers stay on every answer; a header passed to `reply()` or the others replaces one of
them only when it has the same name.

## Streams and server-sent events

`stream()` sends a big answer a piece at a time, waiting while the client catches up. It stops when
the client goes away, and `request.signal` tells a slow source the same:

```jsx
route GET /export.csv {
  return stream((async function* () {
    yield 'id,title\n';
    for await (const n of notes(request.signal)) yield `${n.id},${n.title}\n`;
  })(), { type: 'text/csv' });
}
```

`events()` answers an `EventSource`. Each value is one message, as JSON, and a comment every `ping`
milliseconds (15 seconds by default) keeps the connection open through proxies:

```jsx
route GET /clock {
  return events((async function* () {
    while (!request.signal.aborted) {
      yield { now: Date.now() };
      await new Promise((ok) => setTimeout(ok, 1000));
    }
  })());
}
```

```js
new EventSource('/clock').onmessage = (e) => console.log(JSON.parse(e.data).now);
```

An error in the middle of a stream is logged and cuts the answer short, since its status is already
sent.

Markup that starts with `<html>` is the whole document: put `<title>` and
`<link rel="stylesheet" href="/style.css" />` in its `<head>`. Other markup goes in a plain document.
A component can be that document too: a layout, say `Shell({ title, children })`, that returns
`<html>` with `{children}` in its `<main>`, and that each route returns with its own content inside.

## Groups

A group puts routes under one path. Its `before` block runs before each of them, and one that
returns something answers the request in the route's place:

```jsx
group /admin {
  before {
    const user = await session(request.cookies.sid);
    if (!user?.admin) return redirect('/login');
    request.user = user;
  }

  route GET / { return <main><Dashboard user={request.user} /></main>; }
  route GET /users/{id} { return <main><User id={id} /></main>; }
}
```

These answer `/admin` and `/admin/users/{id}`. Groups can hold groups: the outer `before` runs first,
and a path parameter of a group's path is a constant in every block inside it. A group has at most
one `before`.

## API routes

A group written `group /path api` answers other programs: a mobile app, another server, a webhook,
or a page on another site. Its routes, and those of the groups inside it, work differently:

- **No CSRF check.** Cookies are neither read nor set (`request.cookies` is empty and `cookie()`
  throws), so a request from another site carries nothing it could misuse. Check a token from a
  header, such as `Authorization`, in `before`.
- **Any body.** JSON still arrives in `request.json`, and every body is in `request.body` as bytes
  (a Buffer), say to check a webhook's signature.
- **Errors as JSON**, like `{ "error": "Not found" }`, `notFound()` included, and a request under
  the group's path that no route takes, or whose typed parameter doesn't match.
- **Other sites' pages may read the answers only when allowed**, with *config* `cors` in
  `goal.config.js`: a list of origins, or `'*'` for any. Preflight `OPTIONS` requests are answered
  for you.

```jsx
group /api/v1 api {
  before {
    const user = await userFromToken(request.headers.authorization);
    if (!user) return json({ error: 'sign in' }, 401);
    request.user = user;
  }

  route GET /notes { return json(await notes(request.user)); }
  route POST /notes { return json(await addNote(request.user, request.json), 201); }
}
```

```js
// goal.config.js
export default { cors: ['https://app.example.com'] };
```

## Tenants

One app can serve many tenants (customers, teams, organizations), each by its own host or path.
`tenant` in `goal.config.js` tells them apart. It runs once per request, before the routes and server
functions, and can be async:

```js
// goal.config.js
import { tenants } from './db.js';

export default {
  // acme.app.com, globex.app.com, or a domain of the tenant's own
  tenant: async ({ hostname }) => tenants.byHost(hostname),
};
```

What it returns is `request.tenant`, in routes, `before` blocks and [server
functions](server-functions#the-request). `null` (or nothing) answers 404, so an unknown host never
reaches your code. Return a value of your own for a host without a tenant, such as the main site.

It gets `host`, `hostname` (without the port), `prefix`, `path`, `headers` and `cookies`. Behind a
proxy, set *config* `trustProxy` to read the host from `X-Forwarded-Host`.

**By path.** With `tenantPrefix: true`, the path's first part names the tenant: `app.com/acme/notes`
gives the resolver `prefix: 'acme'`, and the routes see `/notes`, so a route is written once for every
tenant. `request.base` is `/acme`. `redirect('/notes')` goes to `/acme/notes`, and the page's server
function calls go under `/acme` too. Links and form actions are yours to write:
`<a href={request.base + '/notes'}>`.

- Each tenant's data is yours to keep apart: filter every query by `request.tenant`.
- Cookies are for the host that set them, so tenants on different hosts don't share a session. Tenants
  by path share the host, and so its cookies.
- The rate limit counts each tenant on its own.
- Static files are the same for every tenant, and no tenant is looked up for them.

## Typed input

In a [`#strict`](types) file, a route can name the types of its `json`, `query` and `form` in
parentheses after its path. A request whose input doesn't fit is answered 400 and never reaches the
route, and inside it `request.json`, `request.query` and `request.form` have those types:

```jsx
#strict
type NewNote = { title: string, tags?: string[] };

group /api api {
  route POST /notes (json: NewNote) {
    return json(await addNote(request.json), 201);
  }
  route GET /notes (query: { page?: number, q?: string }) {
    return json(await notes(request.query.page ?? 1, request.query.q));
  }
}
```

- A query and a form arrive as text, so their type is an object whose fields are `string`, `number` or
  `boolean`. Text that reads as one is converted first: `?page=2` gives `2`, and `true`, `false` and a
  checkbox's `on` give booleans.
- The 400 names what's wrong, by field and never by value, up to ten things:
  `{ "error": "Bad request", "problems": ["json.title: missing"] }` in an [API group](#api-routes), and
  the same list on the error page elsewhere.
- The check runs after the groups' `before` blocks, so a request that isn't signed in gets their answer
  first.

## Matching

- Fixed paths win over paths with parameters: `/users/new` is chosen before `/users/{id}`.
- A path with the wrong method gets 405, with an `Allow` header.
- HEAD works wherever GET does.

## File uploads

A form with `enctype="multipart/form-data"` sends its files. Its text fields arrive in `request.form`,
and each file input's files in `request.files`, as a list under the input's name. A file is
`{ name, type, size, data }`, where `data` is a Buffer:

```jsx
<form method="post" action="/photos" enctype="multipart/form-data">
  <input type="file" name="photo" multiple />
  <button>Upload</button>
</form>
```

```jsx
route POST /photos {
  for (const f of request.files.photo ?? []) save(f.data);
  return redirect('/photos');
}
```

The file name and type come from the browser, so don't use them as a path or trust them. A file input
left empty arrives as an empty field. The whole body is limited to 1 MB by default: raise
[`bodyLimit`](security#the-rest) for bigger files.

## Forms with any method

A form can use any method. `<form method="delete" action="/notes">` is sent as a POST with the method
in a hidden field, and the route for `DELETE /notes` answers it. Forms that send data get the
[CSRF token](security#csrf) automatically.
