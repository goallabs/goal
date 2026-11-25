---
title: Home
nav_order: 1
---

<img src="assets/goal.svg" alt="" width="72" height="72">

# goal.js

A compiled JavaScript framework where **`var` is state** and **`let`/`const` are computed**.

- **Server-rendered and resumable.** Pages are rendered on the server, and the browser resumes them
  instead of hydrating: no component code runs at load.
- **Small.** Each component's code loads on its first event, in a chunk of its own: 270 to 560 B
  gzipped in the demo app. A page with no events ships no JavaScript at all.
- **No `async`, no `fetch`.** Components reach the server through [server functions](server-functions),
  called like plain functions.
- **Secure by default.** Escaping, URL checks, a strict Content-Security-Policy, CSRF protection and
  safe cookies are on with no setup. Each one has an explicit way out. See [Security](security).
- **HTML as written.** Events are `onclick`, attributes are `class` and `for`, and `{if}` goes straight
  in the markup. There is no `bind:`, `@`, `:` or `$`.

```jsx
// app.goal
import { Counter } from './Counter.goal';

route GET / {
  return <main><h1>Hello</h1><Counter start={1} /></main>;
}
```

```jsx
// Counter.goal
export function Counter({ start }) {
  var count = start;                         // state
  const double = count * 2;                  // computed

  return (
    <div>
      <button onclick={() => count++}>+</button>
      <p>{double}</p>
      {if (count > 9) <b>big</b> else <span>small</span>}
    </div>
  );
}
```

## Where to go next

- [Getting started](getting-started): install goal.js and run your first app.
- [Routes](routes) and [Components](components): the `.goal` language.
- [Server functions](server-functions): calling the server from a component.
- [Security](security): what is on by default, and how to change it.
- [How it works](how-it-works): parse, compile, render and resume, and debugging.
- [Performance](performance): benchmark results, and how to measure your own.
- [Vite](vite): working on an app inside Vite's dev server.

## Status

goal.js is young, and these are not supported yet:

- components inside a keyed list's row;
- goal.js's own type system and `goal check`.
