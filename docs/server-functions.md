---
title: Server functions
nav_order: 5
---

# Server functions

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
handler or from a function declared at the top of the component, and goal.js sends the request and
waits for the answer.

Nobody writes `async`, `await` or `fetch`: in a component they are compile errors. The page updates as
soon as the handler changes something (`saving = true` above), and again when the server answers.
Routes and other server functions call server functions directly, also with no `await`.

## Rules

- Arguments and the return value travel as JSON, so dates, maps and class instances don't arrive as
  they were.
- Each server function is a `POST /_m/<file>/<name>` endpoint behind the [CSRF check](security#csrf);
  the page carries the token. Treat its arguments as untrusted input.
- A component can't call one while rendering. Load the data in the route and pass it as a prop.
- Server functions are declared at the top level of a file. `export server function` lets other
  `.goal` files import them.
