// Bundles goal.js's compiler (src/compiler.js and what it imports) into dist/compiler.mjs: the copy
// that checks files in folders that aren't trusted or have no goaljs. dist/compiler.json says which
// goal.js it is.
//
//   node scripts/bundle.mjs              the working tree's src/ (what the tests use)
//   node scripts/bundle.mjs --ref HEAD   src/ as committed at that revision (what `npm run package` ships,
//                                        so work in progress never goes into the extension)

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const DIST = join(HERE, '..', 'dist');
const i = process.argv.indexOf('--ref');
const ref = i < 0 ? null : process.argv[i + 1];

let src = ROOT;
let version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
let commit = null;
if (ref) {
  const git = (...args) => execFileSync('git', ['-C', ROOT, ...args]);
  commit = git('rev-parse', '--short', `${ref}^{commit}`).toString().trim();
  version = JSON.parse(git('show', `${commit}:package.json`).toString()).version;
  src = mkdtempSync(join(tmpdir(), 'goal-src-'));
  execFileSync('tar', ['-x', '-C', src], { input: git('archive', '--format=tar', commit, 'src') });
}

try {
  await build({
    entryPoints: [join(src, 'src', 'compiler.js')],
    outfile: join(DIST, 'compiler.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    minify: true,
    nodePaths: [join(ROOT, 'node_modules')],
    logLevel: 'warning',
  });
  writeFileSync(join(DIST, 'compiler.json'), JSON.stringify({ version, commit: commit ?? 'working tree' }, null, 2) + '\n');
  console.log(`bundled goal.js ${version} (${commit ?? 'working tree'})`);
} finally {
  if (ref) rmSync(src, { recursive: true, force: true });
}
