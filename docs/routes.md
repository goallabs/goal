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
  fields), `files` (a form's files) and `json` (a JSON body).
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
