---
title: How it works
nav_order: 8
---

# How it works

1. **Parse.** goal.js reads `.goal` files with acorn, extended for `route` and `{if}`, and rewrites
   them into plain JavaScript and JSX: a route becomes an async function, and an `if` chain becomes
   ternaries. A position map sends errors back to the line and column in the `.goal` file.
2. **Compile.** Each file becomes a server module and, for every interactive component, a client
   chunk. The compiler finds which `let`s, `const`s and functions depend on state, and marks only the
   parts of the markup that do: `{...}` holes get comment markers, and attributes get an id. Everything
   else is plain HTML.
3. **Render on the server.** A component's root element carries its chunk's URL, its state and the
   props its browser code reads. The page inlines the loader (about 1 KB gzipped), with the CSP nonce,
   only if the page has events. A page with no events ships no JavaScript at all.
4. **Resume in the browser.** The loader listens for the page's events at the document. On the first
   event in a component, it loads that component's chunk: the component as written,
   `function Counter(state, props)`, whose `var`s start from the saved state. The loader runs the
   handlers on the event's path, saves the `var`s they changed, runs the body again, and patches only
   the bindings whose value changed. If a handler waits for a server function, it patches again when
   the server answers. The chunk starts loading on intent (pointer over, focus), so it's usually there
   before the click or the first key.

## Size

`goal build` prints the gzipped size of each client chunk and of the loader. Helpers that several
components share go in a chunk of their own, and the keyed-list code in another, loaded only by
components with a keyed list. The code for calling server functions, and for rendering a component
inside another in the browser, goes only to the components that do it. In the demo app, the
component chunks are 220 to 1251 B, the shared helpers 980 B, the keyed-list code 1190 B, and the
loader 1064 B. The files' style blocks are one stylesheet, 327 B there.

## Live updates in goal dev

`goal dev` builds again when a file changes and tells the open pages what changed, over a stream at
`/_goal/hmr`:

- **A stylesheet:** the page loads it again in place. So does a style block: after a change to
  one, the page loads the stylesheet of the style blocks again, as well as getting the new code.
- **Code**, a component's or the server's: the page asks the server for itself again, sending the
  state each component has now. The server renders the page with that state, and the new body takes
  the old one's place, keeping the scroll. The focused element keeps the focus, and an input its
  caret and selection: it's found by its place in its component, so it needs no `id`, unless the
  change put another kind of element there. The next event runs the new code, because a
  dev chunk's URL names its build. With PostCSS, the stylesheet loads again too, because Tailwind
  CSS makes it from the code.
- **A compile error:** it shows over the page until a build works again.

A page reloads instead when the new code listens for an event type the page doesn't yet, or when the
state is too big to send. None of this is in `goal build`.

## Debugging

The browser runs the component as you wrote it: the same top level (`var count = …`, your `const`s,
your functions by name), with only the `var`s starting from the saved state and the markup turned into
values.

- `goal dev` serves the chunks unminified, with source maps back to the `.goal` files, so the browser's
  debugger shows your source, and breakpoints and stack traces point at your lines. Server stack
  traces in `goal dev` point at the `.goal` files too.
- `goal build` minifies and ships no source maps, so the source stays on the server.

## Editor support

The repository's `editors/vscode` folder has a VS Code extension: highlighting for `.goal` files
(routes, server functions, `{if}` in markup) and the compiler's errors as you type. Its README says how
to install it.
