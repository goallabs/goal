---
title: Tools
nav_order: 11
---

# Tools

`goal add` sets a tool up in an app: it installs the packages with npm and writes the config and glue
the tool needs, so it works with `.goal` files from the first run.

```bash
npx goal add tailwindcss          # in the app's folder
npx goal add prisma my-app        # or name the folder
npx goal add                      # lists the tools
```

| Tool | `goal add` | What you get |
| --- | --- | --- |
| [Tailwind CSS](https://tailwindcss.com/docs) | `tailwindcss` (4 or 3) | Classes from your `.goal` files compiled into `/style.css` |
| [PostCSS](https://postcss.org) | `postcss` | The stylesheets in `public/` run through PostCSS plugins, autoprefixer first |
| [Prisma](https://www.prisma.io/docs/orm) | `prisma` | SQLite, a schema with a `Note` model, and `db.js` for server code |
| [Drizzle](https://orm.drizzle.team/docs/overview) | `drizzle` | SQLite, a `notes` table in `db/schema.js`, and `db/index.js` for server code |
| [ESLint](https://eslint.org/docs/latest/) | `eslint` | `npm run lint` for `.js` and `.goal` files |
| [Prettier](https://prettier.io/docs/) | `prettier` | `npm run format` for `.js`, `.css`, `.json` and `.md` files |
| [Vitest](https://vitest.dev/guide/) | `vitest` | `npm test`, with tests that import `.goal` files |
| [Playwright](https://playwright.dev/docs/intro) | `playwright` | `npm run test:e2e`: Chromium against the built app |
| [Sentry](https://docs.sentry.io/platforms/javascript/guides/node/) | `sentry` | Errors from routes and server functions reported to Sentry |

When it's done, `goal add` says what it did and what to do next:

```
tailwindcss: the recipe for tailwindcss 4
  $ npm install --save-dev tailwindcss@4.3.5 @tailwindcss/postcss@4.3.5 postcss@8.5.33
  created postcss.config.js
  added to public/style.css: @import "tailwindcss" source("..");
  added to .gitignore: node_modules, dist
Next:
  - Link the stylesheet from your pages: <link rel="stylesheet" href="/style.css" />
  ...
```

## What it changes

- **Nothing of yours is overwritten.** A file that's already there is kept, and `goal add` prints the
  recipe's version of it, so you can merge the two. A line a file already has, such as `dist` in
  `.gitignore` or `DATABASE_URL=` in `.env`, isn't added again. A script that's already in
  `package.json` is kept, except the placeholder `test` script that `npm init` writes.
- **Packages you have stay as they are.** The version you have also picks the recipe: an app on
  Tailwind CSS 3 gets the setup for 3. To ask for one, name it: `goal add tailwindcss@3`.
- **Each recipe installs the versions it was tested with.** npm saves them as `^` ranges, as it always
  does.
- **`package.json` gets `"type": "module"`.** Tools load their config files as ES modules, the way
  goal.js writes them. (`goal build` marks its own output as ES modules either way.)

## Notes on each tool

**Tailwind CSS and PostCSS.** When an app has a `postcss.config.js`, `goal dev` and `goal build` run
every stylesheet in `public/` through it, and the stylesheet of the files'
[style blocks](components#styles) too, and so does the [Vite plugin](vite). PostCSS and its plugins
come from the app's own `node_modules`. Tailwind CSS finds its classes in your `.goal` files. In
`goal dev`, a class you add to a `.goal` file is styled as soon as you save it, without a reload.

**Prisma and Drizzle.** Both use SQLite, with the database file named in `.env`. `goal dev`,
`goal start` and the Vite plugin read the app's `.env` into `process.env`, and a variable that's
already set in the environment wins. The database is used from server code only: a route or a
server function, where `await` is allowed.

```jsx
import { db } from './db.js';

export server function addNote(text) {
  await db.note.create({ data: { text } });
  return db.note.findMany();
}
```

**ESLint.** `goaljs/eslint` lets ESLint read `.goal` files. Each problem is reported at its place in
the `.goal` file, and `eslint --fix` fixes them there.

**Prettier.** Prettier doesn't format `.goal` files yet, so it leaves them alone.

**Vitest.** Tests import components and server functions from `.goal` files, through goal.js's
[Vite plugin](vite). A component called as a function renders its HTML:

```js
import { test, expect } from 'vitest';
import { Counter } from './Counter.goal';

test('Counter renders its start', () => {
  expect(String(Counter({ start: 41 }))).toContain('41');
});
```

**Playwright.** The tests run against the app as `goal build` and `goal start` serve it, with all the
[security headers](security). The example test fails on any console error, which includes a script
or style the Content-Security-Policy blocks.

**Sentry.** `goal.config.js` gets an `onError` hook (see [Security](security#errors)) that reports each
error to Sentry. Nothing is sent until `SENTRY_DSN` is set in `.env` or the environment.

## Recipes

Each tool's setup is a recipe: a file in the repository's
[recipes/](https://github.com/goallabs/goal/tree/main/recipes) folder, with one entry for each range
of the tool's versions. When a tool releases a version that needs a different setup, a pull request
adds an entry for it, and the tool's maintainers are welcome to send it. The folder's README covers
writing and testing a recipe.
