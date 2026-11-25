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

- Path parameters are plain variables (`id`, `post`), as strings.
- `request` has `method`, `path`, `url`, `params`, `query`, `headers`, `cookies`, `form` (a form's
  fields) and `json` (a JSON body).
- `cookie(name, value, options)` sets a cookie.

## What a route returns

| Return | Response |
|---|---|
| Markup | An HTML page |
| `redirect('/path')` | 303 to that path, on this site only; `redirect(url, { external: true })` to leave it |
| `json(value, status)` | JSON |
| `notFound()` | 404 |
| Nothing | 204 |

Markup that starts with `<html>` is the whole document: put `<title>` and
`<link rel="stylesheet" href="/style.css" />` in its `<head>`. Other markup goes in a plain document.

## Matching

- Fixed paths win over paths with parameters: `/users/new` is chosen before `/users/{id}`.
- A path with the wrong method gets 405, with an `Allow` header.
- HEAD works wherever GET does.

## Forms with any method

A form can use any method. `<form method="delete" action="/notes">` is sent as a POST with the method
in a hidden field, and the route for `DELETE /notes` answers it. Forms that send data get the
[CSRF token](security#csrf) automatically.
