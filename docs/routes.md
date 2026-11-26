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
