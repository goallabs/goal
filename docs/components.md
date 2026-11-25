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

- **`var`** declares state, one name at a time, at the top of the component.
- State changes only in event handlers (`count++`, `count = x`), never while rendering.
- Replace arrays and objects instead of changing them in place: `items = [...items, x]`. A change is
  seen when the variable is assigned.
- **`let` and `const`** are computed: they are worked out again from state each time. A `let` can be
  set by `if`/`else` while rendering, but a handler can't change it. The compiler says to use `var`.
- The component body runs again on every update, so it must be pure: no side effects while rendering.

## Markup

- **`{if (a) X else if (b) Y else Z}`** and ternaries go straight in markup, and in attribute values.
  Without an `else`, nothing is rendered.
- **HTML names.** Events are `onclick`, `oninput`, `onsubmit` and so on, with a function. Attributes are
  `class`, `for`, `disabled`, `value`. A reactive attribute is just `name={expression}`.
- A form with `onsubmit` never reloads the page.
- `{value}` children are escaped. `null`, `false` and `true` render nothing, and arrays are joined.

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

A keyed list goes straight in the markup, or straight in an `{if}` or ternary branch:

```jsx
<ul>{if (open) items.map((x) => <li key={x.id}>{x.text}</li>) else <li>Closed</li>}</ul>
```

A list that never changes, such as one in a route, renders once and needs no key.

## Compile errors

Breaking a rule is a compile error with the file, line and column:

```
components/Counter.goal:6:3: `count` is state: change it in an event handler, not while rendering
components/Counter.goal:9:15: write onclick, the HTML name, not onClick
```

## Not supported yet

- Props that change, children passed to components, and function props.
- Components inside `{...}` holes of a component. In routes they work anywhere.
- Keyed lists inside another list's row, or inside an element in an `{if}` branch.
- A `{...}` hole is replaced as a whole when it changes, so an input inside one loses focus.
