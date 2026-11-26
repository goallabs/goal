---
title: Security
nav_order: 6
---

# Security

All of this is on with no setup. `goal.config.js`, at the top of the app folder, can change the parts
marked *config*:

```js
export default { csp: "default-src 'self'; script-src 'self' 'nonce-{nonce}'", csrf: false, bodyLimit: 5_000_000 };
```

`goal build` copies it into `dist/server` with the server code, so it can import `.js` files of the
app's, and `goal start` reads it from there.

## Escaping

Every value is escaped in text and in attributes. There is no raw-HTML escape hatch. `<script>`,
`<style>`, `srcdoc` and string event handlers (`onclick="..."`) are compile errors. A file's CSS goes
in its [style block](components#styles), which `goal build` puts in a stylesheet of its own, so pages
need no `<style>` elements. `style` attributes are allowed, since styles that change with state need
them: the policy sends `style-src-attr 'unsafe-inline'`. A value from data can only style the element
it's on, and the policy's `img-src 'self' data:` and `font-src 'self'` keep a CSS `url()` from
loading anything from another site.

## URLs

In `href`, `src`, `action`, `formaction` and the other URL attributes, only relative, `http(s):`,
`mailto:` and `tel:` URLs get through. A `javascript:` or `data:` URL written in the source is a
compile error. One that comes from data becomes `about:invalid#blocked`, on the server and when the
browser patches the page.

## Headers

Every response has:

- a strict Content-Security-Policy with a fresh nonce for the loader (*config* `csp`, where `{nonce}`
  is replaced, or `false` to send none);
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `frame-ancestors 'none'`;
- same-origin opener and resource policies, a Referrer-Policy and a Permissions-Policy;
- HSTS over TLS.

## CSRF

A POST, PUT, PATCH or DELETE from another site is refused: always when `Origin` or `Sec-Fetch-Site`
says cross-site, and without `Sec-Fetch-Site: same-origin` the request needs the CSRF token. Forms
that send data get the token as a hidden field automatically, server functions send it for you, and
your own `fetch` can send it as the `x-csrf-token` header (*config* `csrf: false` to turn it off).

Routes in a [`group /path api`](routes#api-routes) skip the check, because they neither read nor set
cookies: a request from another site carries nothing to misuse, and the route checks a token from a
header itself. Other sites' pages can read their answers only when *config* `cors` lists the site
(or is `'*'`), and never with cookies.

## Only what the browser needs

A component's root element carries its state and only the props its browser code reads. Props used
only while rendering on the server never reach the page.

## The rest

- A client may send 120 requests that change things (POST, PUT, PATCH, DELETE, server functions
  included) a minute; more get 429 with `Retry-After` (*config* `rateLimit: { max, window }` in
  milliseconds, or `false`). Reading is never limited. Behind a proxy or load balancer every request
  seems to come from it, so set *config* `trustProxy: true` (or the number of proxies) to tell
  clients apart by `X-Forwarded-For`.
- Request bodies are limited to 1 MB (*config* `bodyLimit`).
- `redirect()` stays on this site unless told otherwise.
- Cookies are `HttpOnly`, `Secure` and `SameSite=Lax` unless a route says otherwise. Browsers keep
  `Secure` cookies only over HTTPS, and on `localhost`. Opened over plain HTTP at another address,
  say a phone on your network at `http://192.168.1.20:5648`, the page gets no cookies, the CSRF one
  included, so forms answer 403. Test that way through an HTTPS tunnel.
- Static files are served only from `public/` and the chunks folder.
- Error details (the stack) are shown only in `goal dev`. Otherwise the page is a plain error page, and
  the error is logged.

## Errors

An error that a route or server function throws is logged, and answered with a 500 page. To report it
somewhere too, such as an error tracker, give `goal.config.js` an `onError` (*config*):

```js
import { report } from './report.js';

export default {
  onError(error, request) {
    report(error, { method: request.method, path: request.path });
  },
};
```

It runs after the answer is on its way, so it doesn't slow the page, and an error it throws is
logged. `goal add sentry` sets it up for [Sentry](tools).
