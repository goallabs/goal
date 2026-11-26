---
title: Types
nav_order: 7
---

# Types

A `.goal` file that starts with `#strict` is type-checked: goal.js finds wrong props, state of the
wrong type, markup that can't render and bad data sent to the server, before the app runs. Any other
file compiles as it always has.

```jsx
#strict
export type Note = { id: number, text: string, done?: boolean };

export function Board({ initial }: { initial: Note[] }) {
  var notes = initial;                // a Note[]: worked out from initial
  var draft: string | null = null;    // written: null alone doesn't say
  ...
}

export server function addNote(text: string): Note[] { ... }

route GET /notes/{id: number} { ... }
```

## Writing types

Types are written `name: Type`, in five places; everything else is worked out from the code.

1. A component's props, on its parameter.
2. A `var` whose initial value doesn't say its type, like `[]` or `null`.
3. A server function's parameters, and its result if you want it checked.
4. A route's path parameters: `{id: number}` matches only a number, and the route gets it as one.
5. `type` declarations, which `export` shares with other `.goal` files.

| Type | Written |
| --- | --- |
| Text, numbers, true or false, nothing | `string`, `number`, `boolean`, `null`, `undefined` |
| A choice of values | `'draft' \| 'sent'`, `string \| null` |
| A list | `Note[]` |
| An object, with optional fields | `{ id: number, text: string, done?: boolean }` |
| A function, for function props | `(x: string) => void` |
| Markup, for children | `Markup` |
| Anything, unchecked | `unknown` |
| A declared type | `Note` |

## What is checked

| Check | Code | Error |
| --- | --- | --- |
| A prop of the wrong type | `<Counter start="1" />` | `Counter's start is number, not string` |
| A required prop left out | `<Counter />` | `Counter needs start` |
| A prop the component doesn't take | `<Counter strat={1} />` | `Counter has no prop strat; did you mean start?` |
| State given the wrong type | `count = 'x'` | `count is number, not string` |
| Markup that can't render | `{user}` | `{ name: string } can't be rendered: render a field of it, like {user.name}` |
| A true-or-false attribute | `disabled={'no'}` | `disabled takes true or false, not string` |
| A call's arguments | `addNote(42)` | `addNote takes string, not number` |
| A returned value | `return 1` in a function typed `: string` | `f returns string, not number` |
| A server function's result | `: () => void` | `addNote's result travels as JSON: () => void can't` |

A `#strict` file must also give a type wherever one can't be worked out: a component's props, a server
function's parameters, a `var` that starts as `[]` or `null`, and a value from a `.js` module, which has
no types (`const rows: Note[] = db.all()`). What still can't be worked out is unknown, and unknown is
never an error.

## Imports

A `#strict` file can import `.js` modules and npm packages freely. Among `.goal` files it can import
only `#strict` ones, so the props, types and server functions it uses are all known:

```
A.goal:2:1: ./Card.goal isn't #strict: a #strict file can import only #strict .goal files
```

## At runtime

Types are erased: the browser code carries none. Three checks stay on the server, because their values
come from the network:

- A server function's typed parameters: a request whose arguments don't fit is answered 400 and never
  reaches the function.
- A route's typed path parameters: `/notes/abc` doesn't match `/notes/{id: number}`, so it gets a 404.
- A route's [typed input](routes#typed-input): a body or query that doesn't fit is answered 400, naming
  the fields that are wrong.

## Where errors show

- `goal check` checks every file and lists each file's first error; it exits 1 when there are any.
- `goal build` fails on a type error, like any compile error.
- `goal dev` and the [Vite plugin](vite) show it over the page until it's fixed.
- The VS Code extension underlines it as you type.
