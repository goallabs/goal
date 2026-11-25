import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { check } from '../src/check.mjs';
import { EXAMPLES } from './examples.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const compilers = {
  repository: (await import(pathToFileURL(join(ROOT, 'src', 'compiler.js')).href)).compile,
  bundled: (await import(pathToFileURL(join(HERE, '..', 'dist', 'compiler.mjs')).href)).compile,
};

for (const [name, compile] of Object.entries(compilers)) {
  test(`${name} compiler: the example apps have no problems`, () => {
    assert.ok(EXAMPLES.length >= 7, EXAMPLES.join());
    for (const f of EXAMPLES) assert.equal(check(compile, readFileSync(f, 'utf8'), f), null, f);
  });

  test(`${name} compiler: a problem's line, column and message`, () => {
    const text = 'export function C() {\n  var n = 0;\n  return <div><button onClick={() => n++}>+</button></div>;\n}\n';
    assert.deepEqual(check(compile, text, '/app/C.goal'), { line: 3, column: 23, message: 'write onclick, the HTML name, not onClick' });
    assert.deepEqual(check(compile, 'route GOT /x {\n}\n', 'untitled.goal'), {
      line: 1,
      column: 1,
      message: 'unknown method GOT; use GET, POST, PUT, PATCH, DELETE',
    });
    // a syntax error, from the parser
    assert.deepEqual(check(compile, 'export function C() {\n  return <p>{if (a) <b /></p>;\n', 'untitled.goal'), {
      line: 2,
      column: 26,
      message: 'Adjacent JSX elements must be wrapped in an enclosing tag',
    });
  });
}

test('server functions imported from another .goal file are known, as in goal build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'goal-vscode-'));
  try {
    writeFileSync(join(dir, 'notes.goal'), 'export server function load() {\n  return [];\n}\nserver function hidden() {}\n');
    const text = "import { load } from './notes.goal';\nexport function C() {\n  var n = load();\n  return <p onclick={() => n++}>{n}</p>;\n}\n";
    const problem = { line: 3, column: 11, message: "a server function can't run while a component renders: call it from an event handler, or load the data in the route" };
    assert.deepEqual(check(compilers.repository, text, join(dir, 'C.goal')), problem);
    // a file that isn't saved, or an import that isn't there, knows no server functions
    assert.equal(check(compilers.repository, text, 'C.goal'), null);
    assert.equal(check(compilers.repository, text.replace('./notes.goal', './gone.goal'), join(dir, 'C.goal')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a compiler that crashes is a problem at the top of the file', () => {
  const r = check(() => {
    throw new TypeError('boom');
  }, 'x', '/app/x.goal');
  assert.equal(r.line, 1);
  assert.equal(r.column, 1);
  assert.match(r.message, /^the goal.js compiler failed on this file: TypeError: boom/);
});

function inWorker(compiler, messages) {
  const worker = new Worker(join(HERE, '..', 'src', 'check.mjs'), { workerData: { compiler: pathToFileURL(compiler).href, path: compiler } });
  const results = new Map();
  return new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', ({ id, result }) => {
      results.set(id, result);
      if (results.size === messages.length) worker.terminate().then(() => resolve(results));
    });
    for (const m of messages) worker.postMessage(m);
  });
}

test('as a worker: loads the compiler once and answers each check by id', async () => {
  const results = await inWorker(join(HERE, '..', 'dist', 'compiler.mjs'), [
    { id: 1, text: 'export function C() {\n  return <p className="x">a</p>;\n}\n', file: 'a.goal' },
    { id: 2, text: 'route GET / {\n  return <p>hi</p>;\n}\n', file: 'b.goal' },
  ]);
  assert.equal(results.get(1).message, 'write class, as in HTML');
  assert.equal(results.get(2), null);
});

test("as a worker: a compiler that doesn't load is a problem at the top of the file", async () => {
  const results = await inWorker(join(HERE, 'no-such-compiler.mjs'), [{ id: 7, text: '', file: 'a.goal' }]);
  assert.equal(results.get(7).line, 1);
  assert.match(results.get(7).message, /^couldn't load the goal.js compiler at .*no-such-compiler\.mjs: /);
});

for (const [name, path] of [
  ['repository', join(ROOT, 'src', 'compiler.js')],
  ['bundled', join(HERE, '..', 'dist', 'compiler.mjs')],
]) {
  test(`${name} compiler: a #strict file is checked against the #strict files it imports`, async () => {
    const { compile, exportsOf } = await import(pathToFileURL(path).href);
    const dir = mkdtempSync(join(tmpdir(), 'goal-strict-'));
    try {
      writeFileSync(join(dir, 'B.goal'), '#strict\nexport function B({ n }: { n: number }) { return <b>{n}</b>; }\n');
      const a = join(dir, 'A.goal');
      const text = '#strict\nimport { B } from "./B.goal";\nexport function A() { return <div><B n={1} /></div>; }\n';
      assert.equal(check(compile, text, a, exportsOf), null);
      assert.deepEqual(check(compile, text.replace('{1}', '"1"'), a, exportsOf), { line: 3, column: 38, message: "B's n is number, not string" });
      assert.equal(check(compile, text.replace('./B.goal', './Missing.goal'), a, exportsOf).message, "./Missing.goal isn't #strict: a #strict file can import only #strict .goal files");
      assert.equal(check(compile, text, a).message, "./B.goal isn't #strict: a #strict file can import only #strict .goal files"); // a compiler without exportsOf
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
