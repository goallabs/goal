---
title: How it works
nav_order: 7
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
   props its browser code reads. The page inlines the loader (under 1 KB gzipped), with the CSP nonce,
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
components with a keyed list. In the demo app, the component chunks are 270 to 550 B,
the shared helpers 617 B, the keyed-list code 1015 B, and the loader 947 B.

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
