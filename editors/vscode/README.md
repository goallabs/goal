# goal.js for VS Code

Support for `.goal` files:

- **Highlighting.** JavaScript and JSX highlight as usual, plus the parts that are goal's own:
  `route GET /users/{id} { }` (the method, the path and its `{params}`), `server function`, and
  `{if (a) <b>…</b> else if (b) … else …}` in markup and in attribute values, with the markup after the
  condition and after `else` highlighted as markup. In a `#strict` file, the types highlight too:
  `type Note = { id: number, text?: string }`, `var count: number`, a function's `(text: string): Note[]`,
  and a route's `{id: number}`.
- **Errors as you type.** Each `.goal` file is compiled as you edit it, and the compiler's error shows
  where it points, with goal's own message: ``write onclick, the HTML name, not onClick``, `` `count` is
  state: change it in an event handler, not while rendering``, a bad route, a syntax error. Server
  functions imported from other `.goal` files are known, as in `goal build`.
- **Snippets**: `route`, `component`, `server`.
- Comments, brackets, indentation and folding like JavaScript, `{/* */}` comments in markup, and a file
  icon.

## Which compiler checks a file

In a trusted folder, the project's own goal.js does: `goaljs/compiler` resolved from the file (the
app's `node_modules/goaljs`, or goal.js's repository itself). So the rules are always the ones the
project builds with, and when that compiler changes on disk (`npm install`, or editing goal.js), the
next check uses the new one. A problem says which compiler found it: `goal.js`.

In a folder you haven't trusted, or one without goaljs, the copy of the compiler the extension carries
does (`goal.js 0.5.0 (bundled)`, with the version it is): the folder's own goal.js is code, and isn't
run until you trust the folder. A packaged extension carries goal.js as committed, never work in
progress: `npm run package` bundles `src/` at `HEAD`.

## Install from source

```bash
cd editors/vscode
npm install
npm run package                       # bundles the compiler as committed at HEAD, writes goal.vsix
code --install-extension goal.vsix
```

## Develop

```bash
npm test               # the grammar (with VS Code's TextMate engine and TSX grammar) and the checker
npm run test:vscode    # the extension in a real VS Code window, with a fresh profile
```

Press F5 with this folder open to try it in an Extension Development Host. The grammar
(`syntaxes/goal.tmLanguage.json`) includes VS Code's built-in TypeScript React grammar (`source.tsx`),
which highlights plain JavaScript and JSX exactly as the JavaScript React one does and also knows the
types, and adds goal's forms as injections. `src/check.mjs` runs the compiler (in a worker thread per
compiler) and `src/extension.js` turns its errors into diagnostics. When the `.goal` syntax changes in
`src/syntax.js`, update the grammar and its tests here.
