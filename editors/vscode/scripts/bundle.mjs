// Bundles goal.js's compiler (src/compiler.js and what it imports) into dist/compiler.mjs: the copy
// that checks files in folders that aren't trusted or have no goaljs. dist/compiler.json says which
// goal.js it is.
//
//   node scripts/bundle.mjs                 the working tree's src/ (what the tests use)
//   node scripts/bundle.mjs --ref <rev>     src/ as committed at that revision
//   node scripts/bundle.mjs --ref release   src/ at goal.js's latest release, the newest v* tag at HEAD:
//                                           what `npm run package` ships, so the extension carries a
//                                           released goal.js, never work in progress
//
// With --ref, the extension's version has to be that goal.js's: they're released together.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const DIST = join(HERE, '..', 'dist');
const git = (...args) => execFileSync('git', ['-C', ROOT, ...args]).toString().trim();
const i = process.argv.indexOf('--ref');
let ref = i < 0 ? null : process.argv[i + 1];
if (ref === 'release') ref = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD');

let src = ROOT;
let version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
let commit = null;
if (ref) {
  commit = git('rev-parse', '--short', `${ref}^{commit}`);
  version = JSON.parse(git('show', `${commit}:package.json`)).version;
  const ours = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version;
  if (ours !== version) {
    console.error(`The extension is ${ours} and ${ref} is goal.js ${version}: set the extension's version (package.json) to ${version}.`);
    process.exit(1);
  }
  src = mkdtempSync(join(tmpdir(), 'goal-src-'));
  execFileSync('tar', ['-x', '-C', src], { input: execFileSync('git', ['-C', ROOT, 'archive', '--format=tar', commit, 'src']) });
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
  const from = !ref ? 'working tree' : ref === commit ? commit : `${ref}, ${commit}`;
  writeFileSync(join(DIST, 'compiler.json'), JSON.stringify({ version, commit: from }, null, 2) + '\n');
  console.log(`bundled goal.js ${version} (${from})`);
} finally {
  if (ref) rmSync(src, { recursive: true, force: true });
}
