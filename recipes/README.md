# goal add recipes

`goal add <tool>` sets a tool up in a goal.js app. This folder holds one recipe per tool. A recipe is
plain data: which packages to install, and what the app needs around them. Tool maintainers and users
are welcome to send pull requests that update a recipe for a new version, or add a tool.

## A recipe

`recipes/<tool>.js` exports the recipe as its default export:

```js
export default {
  name: 'tailwindcss',          // goal add tailwindcss
  aliases: ['tailwind'],        // other names goal add takes (optional)
  package: 'tailwindcss',       // the package whose version picks the entry
  about: 'Tailwind CSS: utility classes, compiled into public/style.css',
  docs: 'https://tailwindcss.com/docs',
  versions: [
    // Newest first. goal add uses the first entry, unless the app already has the package
    // (its version picks the entry) or the version is asked for: goal add tailwindcss@3.
    {
      range: '4',
      devDependencies: { tailwindcss: '4.3.5', '@tailwindcss/postcss': '4.3.5', postcss: '8.5.33' },
      files: { 'postcss.config.js': 'export default { ... };\n' },
      prepend: { 'public/style.css': ['@import "tailwindcss" source("..");'] },
      lines: { '.gitignore': ['node_modules', 'dist'] },
      next: ['Link the stylesheet from your pages: <link rel="stylesheet" href="/style.css" />'],
      test: { run: ['npx goal build .', 'node -e "..."'] },
    },
    { range: '3', ... },
  ],
};
```

Each entry can have:

| Key | What `goal add` does with it |
| --- | --- |
| `range` | The versions of `package` the entry is for: `4`, `4.x`, `>=0.45 <1`, `3 \|\| 4`. |
| `dependencies`, `devDependencies` | Installs each package the app doesn't have yet, at the exact version given: the one you tested. npm saves it as a `^` range. |
| `files` | Writes each file, unless the app has it. If the app's differs, it's kept, and the recipe's is printed. |
| `prepend`, `lines` | Adds each line the file doesn't have yet, at its start or its end, and makes the file if it isn't there. `KEY=value` lines compare by key, so a `.env` keeps its values. `dist` and `/dist/` count as the same line. |
| `scripts` | Adds each `package.json` script the app doesn't have. |
| `config` | Adds keys to `goal.config.js`'s exported object, with an import: `{ import: "import { onError } from './sentry.js';", keys: { onError: 'onError' } }`. Each value is code. |
| `run` | Commands to run once, in the app's folder, after all of the above, such as `npx prisma generate`. |
| `next` | What to tell the user to do next. The recipe's `docs` link is added. |
| `test` | For `npm run test:recipes` only: `files` to add to the test app, then `run`, commands that must all succeed. |

`goal add` also sets `"type": "module"` in `package.json`, so write config files as ES modules.

## What a goal.js app is like

Keep these in mind when you write files for an app:

- `.goal` files hold routes and components. Server code (routes and server functions) can import `.js`
  files and npm packages. Components can't use `async`, `await` or `fetch`.
- `goal build` copies the app's `.js` and `.json` files into `dist/server/` and runs the server from
  there, with the app's folder as the working directory. Other files, such as `.ts`, aren't copied,
  so server code imports only `.js`, `.json` and packages.
- `goal dev` loads the server code again after every change. A database client belongs on
  `globalThis` (`globalThis.prisma ??= new PrismaClient()`), so each change doesn't open another one.
- `goal dev`, `goal start` and the Vite plugin read the app's `.env` into `process.env`. Commands like
  `prisma` or `drizzle-kit` don't, so their config loads it (`process.loadEnvFile()`).
- With a `postcss.config.js`, every stylesheet in `public/` goes through PostCSS.
- `goal.config.js` can have `onError(error, request)`, called for each error a route or server
  function throws.
- The page has a strict Content-Security-Policy: no inline scripts or styles.

## Updating a recipe for a new version

- **The setup didn't change:** raise the versions in the entry, and widen its `range` if it's narrow.
- **The setup changed** (a new config format, a new package): add an entry for the new range at the
  top of `versions`. Keep the old entry, and narrow its `range`, so apps on the old version still get
  a setup that works.
- **A new tool:** add `recipes/<tool>.js`, and a row for it in `docs/tools.md`.

## Testing it

```bash
npm install
npm test                                # checks every recipe's shape, among the other tests
npm run test:recipes -- tailwindcss     # sets each tailwindcss entry up for real, and runs its test
npm run test:recipes -- prisma --keep   # keeps the test apps, to look at
npm run test:recipes                    # all of them
```

`npm run test:recipes` copies [test/recipes/app](../test/recipes/app), a small app with a route, a
component and a stylesheet, into a new folder for each entry. It runs `npm init -y`, installs this
checkout of goal.js, runs `goal add <tool>@<version>` with npm for real, and then runs the entry's
`test`. A test should show that the tool works with goal.js, not only that it installed. For example,
Tailwind CSS's test checks that a class from a `.goal` file is in the built stylesheet. Prisma's test
writes a row from `db.js`, then reads it back from the `dist/server` copy.

## Your pull request

- The versions are exact and are the ones you tested.
- `npm test` passes, and so does `npm run test:recipes -- <tool>`.
- If the tool is new, or what `goal add` does for it changed, `docs/tools.md` says so.

A pull request that changes a recipe runs both in CI (`.github/workflows/recipes.yml`).
