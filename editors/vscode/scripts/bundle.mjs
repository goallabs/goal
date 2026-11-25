// Bundles goal.js's compiler (the repository's src/compiler.js and what it imports) into
// dist/compiler.mjs: the copy that checks files in folders that aren't trusted or have no goaljs.

import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

await build({
  entryPoints: [join(ROOT, 'src', 'compiler.js')],
  outfile: join(HERE, '..', 'dist', 'compiler.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  minify: true,
  logLevel: 'warning',
});
