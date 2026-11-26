// goal add sentry: errors that routes and server functions throw, reported to Sentry from
// goal.config.js's onError (see src/app.js).

export default {
  name: 'sentry',
  aliases: ['@sentry/node'],
  package: '@sentry/node',
  about: 'Sentry: errors from routes and server functions',
  docs: 'https://docs.sentry.io/platforms/javascript/guides/node/',
  versions: [
    {
      range: '11',
      dependencies: { '@sentry/node': '11.18.0' },
      files: {
        'sentry.js': `// Errors that routes and server functions throw, reported to Sentry: goal.config.js passes them to
// onError. Without SENTRY_DSN, in .env or the environment, nothing is sent.
import * as Sentry from '@sentry/node';

Sentry.init({ dsn: process.env.SENTRY_DSN });

export function onError(error, request) {
  Sentry.captureException(error, { extra: { method: request?.method, path: request?.path } });
}
`,
      },
      config: { import: "import { onError } from './sentry.js';", keys: { onError: 'onError' } },
      lines: { '.env': ['SENTRY_DSN='], '.gitignore': ['node_modules', 'dist', '.env'] },
      next: ["Put your Sentry project's DSN in .env as SENTRY_DSN, and in the environment in production; until then nothing is sent"],
      test: {
        files: {
          'Boom.goal': 'route GET /boom {\n  throw new Error("boom from a route");\n}\n',
          'check-sentry.mjs': `// A stand-in for Sentry, and the app with SENTRY_DSN pointing at it: a route's error must reach it.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const got = [];
const sentry = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => (got.push(body), res.end('{}')));
});
await new Promise((ok) => sentry.listen(0, ok));
const env = { ...process.env, SENTRY_DSN: \`http://public@localhost:\${sentry.address().port}/1\` };
const app = spawn(process.execPath, ['node_modules/goaljs/bin/goal.js', 'start', '.', '--port', '4179'], { env, stdio: 'ignore' });
let res;
for (let i = 0; i < 100 && !res; i++) res = await fetch('http://localhost:4179/boom').catch(() => new Promise((ok) => setTimeout(ok, 100)));
for (let i = 0; i < 50 && !got.some((b) => b.includes('boom from a route')); i++) await new Promise((ok) => setTimeout(ok, 100));
app.kill();
sentry.close();
process.exit(res.status === 500 && got.some((b) => b.includes('boom from a route')) ? 0 : 1);
`,
        },
        run: ['npx goal build .', 'node check-sentry.mjs'],
      },
    },
  ],
};
