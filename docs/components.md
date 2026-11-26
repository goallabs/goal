---
title: Components
nav_order: 4
---

# Components

```jsx
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

A component is a top-level function with a capitalised name that ends in `return <element>`: one
element, not a fragment, and no other `return`. It takes at most one parameter, its props.

## State and computed values

- **`var`** declares state, one name at a time, at the top of the component. A `var` anywhere else in
  a component, in a block or inside a function such as an event handler, is an error, so a `var` is
  always state. Inside a function, `let` and `const` are ordinary local variables.
- State changes only in event handlers (`count++`, `count = x`), never while rendering.
- Replace arrays and objects instead of changing them in place: `items = [...items, x]`. A change is
  seen when the variable is assigned.
- **`let` and `const`** are computed: they are worked out again from state each time. A `let` can be
  set by `if`/`else` while rendering, but a handler can't change it. The compiler says to use `var`.
- A handler can't change a prop either: copy it into state (`var count = start`) and change that.
- A component can't change a variable declared outside it, at the top of the file: no page would
  update, and on the server every request shares it. Routes and server functions can.
- A `const` or an import that's assigned is an error when the app compiles, not when the code runs.
- The component body runs again on every update, so it must be pure: no side effects while rendering.

## Markup

- **`{if (a) X else if (b) Y else Z}`** and ternaries go straight in markup, and in attribute values.
  Without an `else`, nothing is rendered.
- **HTML names.** Events are `onclick`, `oninput`, `onsubmit` and so on, with a function. Attributes are
  `class`, `for`, `disabled`, `value`. A reactive attribute is just `name={expression}`.
- A form with `onsubmit` never reloads the page.
- `{value}` children are escaped. `null`, `false` and `true` render nothing, and arrays are joined.
- When a `{...}` hole changes, its new markup goes into the nodes already there: an element that is
  still the same kind of element is kept, so an input inside the hole keeps its focus and what was
  typed.

## Lists

Event handlers work anywhere in the markup, including on list items:

```jsx
<ul>{items.map((x) => <li onclick={() => (picked = x)}>{x}</li>)}</ul>
```

A list without keys is made again as a whole when it changes, which is fine for a short one.

### Keyed lists

`key` on a list's rows patches the list by key:

```jsx
<ul>{items.map((x) => <li key={x.id}>{x.text}</li>)}</ul>
```

When the list changes, a kept row gets only its changed values written, new rows are added in one go,
and only the rows that are out of order move. Only a component with a keyed list loads that code.

A keyed list can go anywhere in the markup: straight in it, in an `{if}` or ternary branch, inside
an element in a branch, or inside another list's row.

```jsx
<ul>{if (open) items.map((x) => <li key={x.id}>{x.text}</li>) else <li>Closed</li>}</ul>
```

Inside an element in a branch, or in a row, the rows carry their key. When the markup around them
changes, each row is found by its key and moved, keeping its nodes, and with them an input's focus
and what was typed.

A list that never changes, such as one in a route, renders once and needs no key.

## Components inside components

A component can render another anywhere in its markup: in its fixed part, in an `{if}` or ternary
branch, or in a list without keys.

```jsx
export function Panel() {
  var open = true;
  var n = 1;
  return (
    <div>
      <button onclick={() => n++}>more</button>
      {if (open) <Counter start={n} />}
      <Counter start={n} />
    </div>
  );
}
```

- When the props a child gets read state, the child is rendered again in the browser when they change.
  It keeps its own state, so the second `Counter` above shows the new `start` and keeps its count.
- A component in a `{...}` hole starts from its props when it appears, and keeps its state while it
  stays. Each one keeps its own, even next to others of its kind. In a keyed list's rows, each keeps
  its state by its row's key, so the components of a row that moves move with it.
- A child without state or handlers ships no code of its own: its parent renders it again.

To render a child in the browser, the parent's code includes the child's template, and the module code
it uses, but nothing else from the child's file: routes and server functions stay on the server.

### Children

Markup between a component's tags is its `children`:

```jsx
<Card title="Total"><p>{count}</p><button onclick={() => count++}>+</button></Card>
```

```jsx
export function Card({ title, children }) {
  return <section><h2>{title}</h2>{children}</section>;
}
```

Children belong to the component that wrote them: `{count}` and the `onclick` above are the parent's,
wherever `Card` puts them. Put `{children}` in the child's fixed part, not inside a `{...}` hole that
renders again: that would be a compile error.

### Function props

A function passed as a prop runs in the component that passed it:

```jsx
<Picker onpick={(x) => (picked = x)} />
```

```jsx
export function Picker({ onpick }) {
  var n = 0;
  return <button onclick={() => onpick(++n)}>pick</button>;
}
```

When `Picker` calls `onpick`, the parent's state changes and the parent updates, as if it had handled
an event itself. Call a function prop from an event handler, not while rendering: on the server it does
nothing.

## Styles

A `style` block holds a file's CSS. It styles only the markup that file renders:

```jsx
style {
  .card { border: 1px solid #ccc; border-radius: 8px; }
  strong { color: #1d4ed8; }
}

export function Counter({ start = 0 }) {
  var count = start;
  return <div class="card"><strong>{count}</strong></div>;
}
```

- Each element the file renders carries the file's scope, an attribute like `g-x7k2pq`, and each
  selector gets it on its last part: `.card strong` styles a `<strong>` this file renders, inside any
  `.card`. The scope adds no specificity, so a selector weighs what it does as written.
- Markup given to a component as children belongs to the file that writes it, and so do its styles.
  A parent styles what it passes in; the child styles its own markup.
- Rules inside `@media`, `@supports`, `@container` and `@layer` are scoped too, and so are nested
  rules. `@keyframes` and `@font-face` are kept as written, and their names are the page's.
- A file has one style block, at its top level. `@import` doesn't go in one: put page-wide CSS in a
  stylesheet under `public/` and link it.
- `goal build` puts every file's style block in one stylesheet, `/c/_/style.css`, and each page links
  it at the end of its head, after the page's own stylesheets. With a `postcss.config.js`, it goes
  through PostCSS too. There is no inline style, so the strict Content-Security-Policy stays.

## Compile errors

Breaking a rule is a compile error with the file, line and column:

```
components/Counter.goal:6:3: `count` is state: change it in an event handler, not while rendering
components/Counter.goal:9:15: write onclick, the HTML name, not onClick
```

## Not supported yet

- Components inside a keyed list's row.
