# goal.js for VS Code

Support for `.goal` files:

- **Highlighting.** JavaScript and JSX highlight as usual, plus the parts that are goal's own:
  `route GET /users/{id} { }` (the method, the path and its `{params}`), `server function`, and
  `group /api api { before { … } route … }`, `{if (a) <b>…</b> else if (b) … else …}` in markup and in attribute values, with the markup after the
  condition and after `else` highlighted as markup. A `style { }` block highlights as CSS. In a
  `#strict` file, the types highlight too: `type Note = { id: number, text?: string }`,
  `var count: number`, a function's `(text: string): Note[]`, a route's `{id: number}`, and the types of its input: `route POST /notes (json: NewNote) { }`.
- **CSS in a style block.** VS Code's own CSS support completes properties and values, describes them
  on hover, and shows a swatch and a color picker for each color, as in a `.css` file.
- **Errors as you type.** Each `.goal` file is compiled as you edit it, and the compiler's error shows
  under the name it's about, with goal's own message: ``write onclick, the HTML name, not onClick``,
  `` `count` is state: change it in an event handler, not while rendering``, `` `start` comes from the
  props``, `@import` in a style block, a bad route or group, a route's `query` type that text can't fill, a syntax
  error. Server functions imported from other
  `.goal` files are known, as in `goal build`.
- **Snippets**: `route`, `group`, `component`, `server`.
- Comments, brackets, indentation and folding like JavaScript, `{/* */}` comments in markup, and a file
  icon.

## With the tools `goal add` sets up

- **ESLint.** When a project's ESLint checks `.goal` files (`goal add eslint`, or an `eslint.config.*`
  that imports `goaljs/eslint`), VS Code's [ESLint extension](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)
  can show its problems in them too, but it only lints languages it's told to. Opening a `.goal` file
  in such a project offers to turn it on: **Turn on** adds `goal` to `eslint.validate` in the folder's
  settings (`.vscode/settings.json`), with the languages ESLint lints already, so nothing else stops
  being linted. The command **goal.js: Lint .goal Files with ESLint** does the same.
- **Tailwind CSS.** [Tailwind CSS IntelliSense](https://marketplace.visualstudio.com/items?itemName=bradlc.vscode-tailwindcss)
  completes and previews classes in `.goal` files: the extension maps `goal` to JSX in
  `tailwindCSS.includeLanguages`.

## Which compiler checks a file

In a trusted folder, the project's own goal.js does: `goaljs/compiler` resolved from the file (the
app's `node_modules/goaljs`, or goal.js's repository itself). So the rules are always the ones the
project builds with, and when that compiler changes on disk (`npm install`, or editing goal.js), the
next check uses the new one. A problem says which compiler found it: `goal.js`.

In a folder you haven't trusted, or one without goaljs, the copy of the compiler the extension carries
does (`goal.js <version> (bundled)`): the folder's own goal.js is code, and isn't
run until you trust the folder. A packaged extension carries goal.js's latest release, never work in
progress: `npm run package` bundles `src/` at the newest `v*` tag, and the extension's version is that
release's (packaging stops if it isn't).

## Install from source

```bash
cd editors/vscode
npm install
npm run package                       # bundles goal.js's latest release, writes goal.vsix
code --install-extension goal.vsix
```

## Develop

```bash
npm test               # the grammar (with VS Code's TextMate engine and its TSX and CSS grammars), the checker, css.js, tools.js
npm run test:vscode    # the extension in a real VS Code window, with a fresh profile
```

`test:vscode` also runs VS Code's ESLint extension, copied into the fresh profile from the one installed
in your VS Code, to see a `.goal` file's ESLint problems once it's turned on. Without it installed, that
part is skipped.

Press F5 with this folder open to try it in an Extension Development Host. The grammar
(`syntaxes/goal.tmLanguage.json`) includes VS Code's built-in TypeScript React grammar (`source.tsx`),
which highlights plain JavaScript and JSX exactly as the JavaScript React one does and also knows the
types, and adds goal's forms as injections; a style block includes VS Code's CSS grammar.
`src/check.mjs` runs the compiler (in a worker thread per compiler) and `src/extension.js` turns its
errors into diagnostics. `src/css.js` finds a file's style block and makes the copy of the file with
only its CSS, which VS Code's CSS support answers for. `src/tools.js` finds a project's
`goaljs/eslint` config and works out `eslint.validate`. When the `.goal` syntax changes in
`src/syntax.js`, update the grammar and its tests here.
