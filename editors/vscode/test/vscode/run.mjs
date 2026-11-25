// Runs suite.cjs inside a real VS Code, with this extension loaded from source and a fresh profile:
//   npm run test:vscode            (VS_CODE=/path/to/Code to pick the executable)
// It opens a window for a few seconds.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '..', '..');
const ROOT = join(EXT, '..', '..');
const CODE = process.env.VS_CODE ?? ['/Applications/Visual Studio Code.app/Contents/MacOS/Code', '/usr/share/code/code'].find(existsSync);
if (!CODE) {
  console.error('VS Code not found: set VS_CODE to its executable');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'goal-vscode-'));
const write = (rel, text) => {
  mkdirSync(dirname(join(tmp, rel)), { recursive: true });
  writeFileSync(join(tmp, rel), text);
};
const BAD = 'export function C() {\n  var n = 0;\n  return <div><button onClick={() => n++}>+</button>{n}</div>;\n}\n';
// a project that uses this repository's goal.js, through node_modules like an app would
write('ws/app/C.goal', BAD);
mkdirSync(join(tmp, 'ws/app/node_modules'), { recursive: true });
symlinkSync(ROOT, join(tmp, 'ws/app/node_modules/goaljs'), 'dir');
// no goaljs: the bundled copy checks it
write('ws/plain/D.goal', BAD);
write('ws/plain/S.goal', '#strict\ntype Note = { done: boolean };\n\nroute GET /notes/{id: number} {\n  return <p>{id}</p>;\n}\n');
// a goaljs whose compiler the suite rewrites, to see the next check use the new one
write('ws/fake/node_modules/goaljs/package.json', JSON.stringify({ name: 'goaljs', type: 'module', exports: { './compiler': './compiler.js' } }));
write('ws/fake/E.goal', 'route GET / {\n  return <p>hi</p>;\n}\n');

const args = [
  join(tmp, 'ws'),
  `--extensionDevelopmentPath=${EXT}`,
  `--extensionTestsPath=${join(HERE, 'suite.cjs')}`,
  `--user-data-dir=${join(tmp, 'user')}`,
  `--extensions-dir=${join(tmp, 'extensions')}`,
  '--disable-extensions',
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
  '--new-window',
];
const child = spawn(CODE, args, { stdio: 'inherit', env: { ...process.env, GOAL_FIXTURES: join(tmp, 'ws'), ELECTRON_RUN_AS_NODE: '' } });
child.on('exit', (code) => {
  rmSync(tmp, { recursive: true, force: true });
  console.log(code === 0 ? 'VS Code suite passed' : `VS Code suite failed (${code})`);
  process.exit(code ?? 1);
});
