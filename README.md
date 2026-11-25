# goal.js

A compiled JavaScript framework where **`var` is state** and **`let`/`const` are computed**. Pages are
rendered on the server and the browser **resumes** them instead of hydrating: no component code runs at
load, and each component's code (at most **1 KB gzipped**) loads on its first event. Components reach the
server through **server functions**, with no `async` and no `fetch`. It is **secure by default**.

```jsx
// app.goal
import { Counter } from './Counter.goal';

route GET / {
  return <main><h1>Hello</h1><Counter start={1} /></main>;
}

route GET /users/{id} {
  return <main><h1>User {id}</h1></main>;
}
```

```jsx
// Counter.goal
export function Counter({ start }) {
  var count = start;                         // state
  const double = count * 2;                  // computed
  const tone = count % 2 ? 'odd' : 'even';   // computed

  return (
    <div class={tone}>
      <button onclick={() => count++}>+</button>
      <p>{double}</p>
      {if (count > 9) <b>big</b> else if (count < 0) <i>negative</i> else <span>small</span>}
    </div>
  );
}
```

## Try it

```bash
npm install
npm run demo          # builds examples/demo, serves it on http://localhost:3000, rebuilds on save
npm test              # the tests, with 100% coverage required
```

```bash
goal build <app>      # compile into <app>/dist; prints the routes and each chunk's size
goal start <app>      # serve a built app (--port 3000)
goal dev <app>        # build, serve with error details, rebuild when a file changes
```

An app is a folder of `.goal` files (anywhere in it), `.js` files for server code they import, a
`public/` folder for CSS, images and fonts, and an optional `goal.config.js`.

## Routes

```jsx
route GET /notes { ... }
route POST /notes { ... }
route GET /users/{id}/posts/{post} { ... }
```

A route is written at the top level of any `.goal` file: a method (`GET`, `POST`, `PUT`, `PATCH`,
`DELETE`), a path where `{name}` is a parameter, and a body that runs on the server, once per request
(it may `await`). In the body:

- path parameters are plain variables (`id`, `post`), as strings;
- `request` has `method`, `path`, `url`, `params`, `query`, `headers`, `cookies`, `form` (a form's
  fields) and `json` (a JSON body);
- return markup for an HTML page, `redirect('/path')` (303, to this site only; `{ external: true }` to
  leave it), `json(value, status)`, `notFound()`, or nothing (204). `cookie(name, value, options)` sets
  a cookie.

Markup a route returns that starts with `<html>` is the whole document (put `<title>` and
`<link rel="stylesheet" href="/style.css" />` in its `<head>`). Other markup goes in a plain document.
Fixed paths win over paths with parameters, a path with the wrong method gets 405, and HEAD works
wherever GET does.

A form can use any method: `<form method="delete" action="/notes">` is sent as a POST with the method
in a hidden field, and the route for DELETE answers it.

## Server functions

```jsx
// notes.goal
const notes = [];

export server function addNote(text) {
  notes.push(String(text).slice(0, 200));
  return notes;
}

export function Notes() {
  var list = [];
  var saving = false;

  function add(e) {
    saving = true;              // shown at once
    list = addNote('hello');    // a request to the server; the handler waits for the answer
    saving = false;
  }

  return <button onclick={add} disabled={saving}>Add ({list.length})</button>;
}
```

A `server function` runs on the server. A component calls it like any other function, from an event
handler or from a function declared at the top of the component, and goal.js sends the request and waits
for the answer. Nobody writes `async`, `await` or `fetch`: in a component they are compile errors. The
page updates as soon as the handler changes something (`saving = true`), and again when the server
answers. Routes and other server functions call them directly, also with no `await`.

- Arguments and the return value travel as JSON. Each server function is a `POST /_m/<file>/<name>`
  endpoint behind the CSRF check (the page carries the token), so treat its arguments as untrusted input.
- A component can't call one while rendering: load data in the route and pass it as a prop.
- Server functions are declared at the top level, and `export server function` lets other `.goal` files
  import them.

## Components

- A **component** is a top-level function with a capitalised name that ends in `return <element>`: one
  element, not a fragment, and no other `return`. It takes at most one parameter, its props.
- **`var`** declares state, one name at a time, at the top of the component. State changes only in event
  handlers (`count++`, `count = x`), never while rendering. Replace arrays and objects
  (`items = [...items, x]`): a change is seen when the variable is assigned.
- **`let` and `const`** are computed: they are worked out again from state each time. A `let` can be set by
  `if`/`else` while rendering, but a handler can't change it (the compiler says to use `var`).
- **`{if (a) X else if (b) Y else Z}`** and ternaries go straight in markup, and in attribute values.
  Without an `else`, nothing is rendered.
- **HTML names**: events are `onclick`, `oninput`, `onsubmit`, ... with a function. Attributes are
  `class`, `for`, `disabled`, `value`. A reactive attribute is just `name={expression}`. There is no
  `bind:`, `@`, `:` or `$`. A form with `onsubmit` never reloads the page.
- Event handlers work anywhere in the markup, including on list items: `{items.map((x) => <li
  onclick={() => (picked = x)}>{x}</li>)}`.
- **`key`** on a list's rows patches the list by key: `{items.map((x) => <li key={x.id}>{x.text}</li>)}`.
  When it changes, a kept row gets only its changed values written, new rows are added in one go, and
  only the rows out of order move. Only a component with a keyed list loads that code (`keyed.js`). A
  list without keys is made again as a whole when it changes, which is fine for a short one. A keyed
  list goes straight in the markup, or straight in an `{if}` or ternary branch:
  `{if (open) items.map((x) => <li key={x.id}>{x.text}</li>) else <li>Closed</li>}`.
- The component body runs again on every update, so it must be pure: no side effects while rendering.
- `{value}` children are escaped, `null`, `false` and `true` render nothing, and arrays are joined.

Breaking a rule is a compile error with the file, line and column:

```
components/Counter.goal:6:3: `count` is state: change it in an event handler, not while rendering
components/Counter.goal:9:15: write onclick, the HTML name, not onClick
```

## Debugging

The browser runs the component as you wrote it: the same top level (`var count = …`, your `const`s,
your functions by name), with only the `var`s starting from the saved state and the markup turned into
values. `goal dev` serves the chunks unminified, with source maps back to the `.goal` files, so the
browser's debugger shows your source, and breakpoints and stack traces point at your lines. Server
stack traces in `goal dev` point at the `.goal` files too. `goal build` minifies and ships no source maps,
so the source stays on the server.

## Secure by default

All of this is on with no setup. `goal.config.js` can change the parts marked *config*:

```js
export default { csp: "default-src 'self'; script-src 'self' 'nonce-{nonce}'", csrf: false, bodyLimit: 5_000_000 };
```

- **Escaping.** Every value is escaped in text and attributes. There is no raw-HTML escape hatch.
  `<script>`, `<style>`, `srcdoc` and string event handlers (`onclick="..."`) are compile errors.
- **URLs.** In `href`, `src`, `action`, `formaction` and other URL attributes, only relative,
  `http(s):`, `mailto:` and `tel:` URLs get through. A `javascript:` or `data:` URL written in the source
  is a compile error. One that comes from data becomes `about:invalid#blocked`, on the server and when
  the browser patches.
- **Headers** on every response: a strict Content-Security-Policy with a fresh nonce for the loader
  (*config* `csp`, where `{nonce}` is replaced, or `false`), `nosniff`, `X-Frame-Options: DENY`,
  `frame-ancestors 'none'`, same-origin opener and resource policies, a Referrer-Policy and
  Permissions-Policy, and HSTS over TLS.
- **CSRF.** A POST, PUT, PATCH or DELETE from another site is refused: a cross-site `Origin` or
  `Sec-Fetch-Site` always, and without `Sec-Fetch-Site: same-origin` the request needs the CSRF token.
  Forms that send data get the token as a hidden field automatically, and `fetch` can send it as
  `x-csrf-token` (*config* `csrf: false`).
- **Only what the browser needs.** A component's root element carries its state and only the props its
  browser code reads. Props used only while rendering on the server never reach the page.
- **The rest.** Bodies are limited to 1 MB (*config* `bodyLimit`). `redirect()` stays on this site
  unless told otherwise. Cookies are `HttpOnly`, `Secure` and `SameSite=Lax` unless a route says
  otherwise. Static files are served only from `public/` and the chunks folder. Error details (the stack)
  are shown only in `goal dev`; otherwise a plain error page, with the error logged.

## How it works

1. **Parse.** `src/syntax.js` reads `.goal` with acorn, extended for `route` and `{if}`, and rewrites
   them into plain JavaScript and JSX: a route becomes an async function, an `if` chain becomes
   ternaries. A position map sends errors back to the line and column in the `.goal` file.
2. **Compile.** Each file becomes a server module and, for every interactive component, a client chunk.
   The compiler finds which `let`/`const`/functions depend on state, and marks only the parts of the
   markup that do: `{...}` holes get comment markers, and attributes get an `m-x` id. Everything else is
   plain HTML.
3. **Render on the server.** A component's root element carries its chunk URL (`m-c`), its state (`m-s`)
   and the props its browser code reads (`m-p`). The page inlines the loader (under 1 KB gzipped), with
   the CSP nonce, only if the page has events. A page with no events ships no JavaScript at all.
4. **Resume in the browser.** The loader listens for the page's events at the document. On the first event
   in a component it loads that component's chunk: the component as written, `function Counter(state,
   props)`, whose `var`s start from the state and which returns `[binding values, handlers, read the
   state]`. It runs the handlers on the event's path, saves the `var`s they changed, runs the body again,
   and patches only the bindings whose value changed; if a handler waits for a server function, it
   patches again when the server answers. Handlers made while rendering a list are numbered in the order
   they're made, the same on the server and in the browser. The chunk starts loading on intent (pointer
   over, focus), so it's usually there before the click or the first key.

Each client chunk must be at most 1 KB gzipped (`BUDGET` in `src/build.js`); `goal build` fails otherwise.
In the demo, the component chunks are 270 to 550 B, the helpers they share 617 B, `keyed.js` 1015 B,
and the loader 947 B.

## Measuring

`npm run bench:virtual` builds `examples/virtual`, a virtual list of 100,000 rows whose structure
differs from row to row (a badge that comes and goes, tags of any length, a meter), and measures it in
headless Chrome. For scroll steps, random jumps and updates it reports the time from the event to the
patched DOM and the main thread's time per operation. For memory it repeats all three in cycles and
compares the JS heap, DOM nodes and event listeners after a garbage collection: growth from cycle to
cycle is a leak. `--quick` makes a short run, `--json file` saves the numbers, and `CHROME` sets the
browser's path. It drives Chrome over the DevTools protocol, with no extra dependency.

## Editor

`editors/vscode` is the VS Code extension: highlighting for `.goal` (routes, server functions, `{if}` in
markup) and the compiler's errors as you type, checked with the project's own goal.js. See its
README to install it.

## Not yet (next milestones)

- Keyed lists inside another list's row, or inside an element in an `{if}` branch (a compile error for
  now).
- Props that change, children passed to components, function props, and components inside `{...}`
  holes of a component (in routes they work anywhere).
- A `{...}` hole is replaced as a whole when it changes, so an input inside one loses focus.
- goal's own type system and `goal check`, a Vite plugin, and multipart (file upload) bodies.
