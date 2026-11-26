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
- A component can't call one while rendering, except through [`call()`](#loading-data-with-call).
  Otherwise, load the data in the route and pass it as a prop.
- Server functions are declared at the top level of a file. `export server function` lets other
  `.goal` files import them.

## The request

Inside a server function, `request` is the request it runs for, as in a route: its `cookies`,
`headers`, `tenant` and the rest. It's the same whether an event handler called the function, a route
did, or a page rendering with `call()`:

```jsx
server function myNotes() {
  const user = await session(request.cookies.sid);
  if (!user) return [];
  return db.notes.where({ tenant: request.tenant.id, owner: user.id });
}
```

A function with a parameter or a variable named `request` keeps its own. Outside a request (a script,
a test), `request` is `undefined`.

## Loading data with call()

`call()` lets a component load its own data. It runs a server function as the component renders,
and its answer becomes state:

```jsx
// search.goal
export server function search(q) {
  return db.fruit.filter((f) => f.includes(q));
}

export function Search() {
  var q = '';
  var found = call(search(q));

  return (
    <div>
      <input value={q} oninput={(e) => (q = e.target.value)} />
      <button onclick={found.reload}>Reload</button>
      {if (found.error) <p>{found.error}</p>
       else if (!found.value) <p>Loading…</p>
       else <ul class={found.loading ? 'dim' : ''}>{found.value.map((f) => <li key={f}>{f}</li>)}</ul>}
    </div>
  );
}
```

`found` is an object:

| Field | What it is |
|---|---|
| `value` | The answer: `undefined` until the first one arrives, then the latest. |
| `loading` | `true` while a request is on its way. The last value stays until the new one arrives. |
| `error` | `null`, or a message when the server function failed. The value it had stays. |
| `reload()` | Sends the request again, with the same arguments. |
| `cancel()` | Stops a request on its way, and keeps the value it had. |

How it runs:

- **On the server:** the call runs while the page renders, and the page is sent with the answer in
  it. Calls with the same function and arguments run once per page. A call whose arguments read
  another call's value runs after it; the others start together.
- **In the browser:** the page keeps that answer, so nothing is fetched when the page loads. When an
  argument (here `q`, which is state) changes, the call runs again. A newer request stops the one
  before it, so an old answer never replaces a new one. A component that first appears in the
  browser (in an `{if}`, say) sends its request as it renders.
- **Errors:** a failure on the server is logged and goes to
  [`onError`](security#errors). The page shows the same message the browser would get,
  `server function /_m/<file>/<name> failed: 500`, and never the error's own details.
- **Cancel:** `cancel()` stops the request in the browser and drops its answer. The server may
  still finish the work.

The rules:

- `call()` goes at the top of a component, as `var name = call(load(args))`, with one server function
  call inside. Anywhere else it is a compile error.
- Don't assign the var: run the call again with `name.reload()`. A handler can set `name.value`, as
  when a server function already gives the new list: `found.value = addFruit(name)`.
- The code for `call()` is a small file of its own, and only components that use it load it.
- In a `#strict` file, `found.value` has the server function's return type, or `undefined`.
- A file that declares or imports its own `call` uses that one instead.

