// goal add drizzle: Drizzle ORM with SQLite (better-sqlite3), the tables in JavaScript.

export default {
  name: 'drizzle',
  aliases: ['drizzle-orm'],
  package: 'drizzle-orm',
  about: 'Drizzle ORM with SQLite: tables in JavaScript, and a client for server code',
  docs: 'https://orm.drizzle.team/docs/overview',
  versions: [
    {
      range: '>=0.45 <1',
      dependencies: { 'drizzle-orm': '0.45.4', 'better-sqlite3': '13.2.0' },
      devDependencies: { 'drizzle-kit': '0.31.11' },
      files: {
        'drizzle.config.js': `import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

if (existsSync('.env')) process.loadEnvFile(); // goal.js reads .env for the app; drizzle-kit doesn't

export default defineConfig({
  dialect: 'sqlite',
  schema: './db/schema.js',
  out: './drizzle',
  dbCredentials: { url: process.env.DB_FILE_NAME },
});
`,
        'db/schema.js': `import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

export const notes = sqliteTable('notes', {
  id: integer().primaryKey({ autoIncrement: true }),
  text: text().notNull(),
  createdAt: integer({ mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});
`,
        'db/index.js': `import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

// One connection per process: goal dev loads the server code again after each change.
export const db = (globalThis.drizzle ??= drizzle(process.env.DB_FILE_NAME, { schema }));
`,
      },
      lines: { '.env': ['DB_FILE_NAME=sqlite.db'], '.gitignore': ['node_modules', 'dist', '.env', 'sqlite.db*'] },
      scripts: { 'db:push': 'drizzle-kit push' },
      run: ['npx drizzle-kit push'],
      next: [
        "Use it from server code: import { db } from './db/index.js' and import { notes } from './db/schema.js', then: return db.select().from(notes)",
        'After changing db/schema.js: npm run db:push (or npx drizzle-kit generate and migrate)',
        'DB_FILE_NAME is in .env; in production, set it in the environment',
      ],
      test: {
        run: [
          `node --input-type=module --env-file=.env -e "import { db } from './db/index.js'; import { notes } from './db/schema.js'; await db.insert(notes).values({ text: 'hi' }); process.exit((await db.select().from(notes)).length === 1 ? 0 : 1)"`,
          'npx goal build .',
          `node --input-type=module --env-file=.env -e "import { db } from './dist/server/db/index.js'; import { notes } from './dist/server/db/schema.js'; process.exit((await db.select().from(notes)).length === 1 ? 0 : 1)"`,
        ],
      },
    },
  ],
};
