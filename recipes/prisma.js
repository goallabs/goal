// goal add prisma: Prisma ORM with SQLite. The client is generated into node_modules and imported as
// @prisma/client, so the server code finds it from the app's folder and from dist/server alike.

export default {
  name: 'prisma',
  aliases: ['@prisma/client'],
  package: 'prisma',
  about: 'Prisma ORM with SQLite: a schema, and a client for server code',
  docs: 'https://www.prisma.io/docs/orm',
  versions: [
    {
      range: '7',
      dependencies: { '@prisma/client': '7.10.1', '@prisma/adapter-better-sqlite3': '7.10.1' },
      devDependencies: { prisma: '7.10.1' },
      files: {
        'prisma/schema.prisma': `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
}

model Note {
  id        Int      @id @default(autoincrement())
  text      String
  createdAt DateTime @default(now())
}
`,
        // Prisma 7 looks for prisma7.config.* before prisma.config.*
        'prisma7.config.js': `import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

if (existsSync('.env')) process.loadEnvFile(); // goal.js reads .env for the app; the prisma command doesn't

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: process.env.DATABASE_URL },
});
`,
        'db.js': `import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

// One client per process: goal dev loads the server code again after each change.
export const db = (globalThis.prisma ??= new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL }),
}));
`,
      },
      lines: { '.env': ['DATABASE_URL="file:./dev.db"'], '.gitignore': ['node_modules', 'dist', '.env', 'dev.db*'] },
      scripts: { postinstall: 'prisma generate', 'db:push': 'prisma db push' },
      run: ['npx prisma generate', 'npx prisma db push'],
      next: [
        "Use it from server code: import { db } from './db.js', then in a route or server function: return db.note.findMany()",
        'After changing prisma/schema.prisma: npm run db:push (or npx prisma migrate dev), and restart goal dev',
        'DATABASE_URL is in .env; in production, set it in the environment',
      ],
      test: {
        run: [
          `node --input-type=module --env-file=.env -e "import { db } from './db.js'; await db.note.create({ data: { text: 'hi' } }); process.exit((await db.note.count()) === 1 ? 0 : 1)"`,
          'npx goal build .',
          `node --input-type=module --env-file=.env -e "import { db } from './dist/server/db.js'; process.exit((await db.note.count()) === 1 ? 0 : 1)"`,
        ],
      },
    },
  ],
};
