// npm run test:recipes [-- tool ...]: sets each recipe up for real, each of its versions in an app
// of its own (a copy of ./app, made with npm init -y), with this checkout's goaljs, and runs the
// recipe's test commands there. A pull request that changes a recipe runs it (see recipes/README.md).
// --keep leaves the apps, to look at.

import { mkdtempSync, cpSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recipes } from '../../src/add.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const names = args.filter((a) => a !== '--keep');
const all = (await recipes()).filter((r) => !names.length || names.includes(r.name));
if (names.length > all.length) throw new Error(`no recipe for ${names.filter((n) => !all.some((r) => r.name === n)).join(', ')}`);

const work = mkdtempSync(join(tmpdir(), 'goal-recipes-'));
execSync(`npm pack --silent --pack-destination "${work}"`, { cwd: ROOT, stdio: 'ignore' });
const tarball = join(work, readdirSync(work).find((f) => f.endsWith('.tgz')));
const failed = [];
for (const r of all)
  for (const e of r.versions) {
    const version = { ...e.dependencies, ...e.devDependencies }[r.package];
    const dir = join(work, `${r.name}-${version}`);
    const sh = (cmd, stdio = 'inherit') => execSync(cmd, { cwd: dir, stdio });
    console.log(`\n${r.name} ${e.range}, with ${r.package} ${version}`);
    try {
      cpSync(join(ROOT, 'test/recipes/app'), dir, { recursive: true });
      sh('npm init -y', 'ignore');
      sh(`npm install --no-audit --no-fund "${tarball}"`);
      sh(`npx goal add ${r.name}@${version}`);
      for (const [f, text] of Object.entries(e.test?.files ?? {})) {
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        writeFileSync(join(dir, f), text);
      }
      for (const cmd of e.test?.run ?? []) {
        console.log(`$ ${cmd}`);
        sh(cmd);
      }
      console.log(`ok: ${r.name} ${e.range}`);
    } catch {
      failed.push(`${r.name} ${e.range}`);
      console.log(`FAILED: ${r.name} ${e.range}`);
    }
  }
if (!keep) rmSync(work, { recursive: true, force: true });
else console.log(`\nThe apps are in ${work}`);
console.log(failed.length ? `\n${failed.length} failed: ${failed.join(', ')}` : '\nall recipes work');
process.exit(failed.length ? 1 : 0);
