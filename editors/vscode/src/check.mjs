// Checks one .goal file with a goal.js compiler. The extension runs this file as a worker thread with
// one compiler loaded (workerData.compiler, a file URL), so a compiler that changes on disk is loaded
// fresh in a new worker. The tests call check() directly.

import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

const EXPORTED = /\bexport[ \t]+server[ \t]+function[ \t]+([A-Za-z_$][\w$]*)/g;

/**
 * The server functions another .goal file exports, read from disk, so that a file importing them is
 * checked the way `goal build` compiles it.
 */
function serverFunctions(file) {
  return (spec) => {
    if (!isAbsolute(file) || !spec.startsWith('.')) return null;
    const target = resolve(dirname(file), spec);
    let text;
    try {
      text = readFileSync(target, 'utf8');
    } catch {
      return null;
    }
    return { base: target.slice(0, -'.goal'.length), names: [...text.matchAll(EXPORTED)].map((m) => m[1]) };
  };
}

/**
 * Compiles `text`, the contents of `file`, and returns the first problem, or null.
 * @param {(source: string, opts: object) => unknown} compile  goal.js's compile()
 * @param {string} text
 * @param {string} file  an absolute path, or just a name for a file that isn't saved
 * @returns {{ line: number, column: number, message: string } | null}  line and column count from 1
 */
export function check(compile, text, file) {
  try {
    compile(text, { file: basename(file), serverFunctions: serverFunctions(file) });
    return null;
  } catch (e) {
    if (e?.name === 'GoalError') return { line: e.line, column: e.column, message: e.message.slice(`${e.file}:${e.line}:${e.column}: `.length) };
    return { line: 1, column: 1, message: `the goal.js compiler failed on this file: ${e?.stack ?? e}` };
  }
}

if (parentPort) {
  const compiler = import(workerData.compiler).then((m) => m.compile);
  compiler.catch(() => {}); // a compiler that doesn't load is reported with each check, below
  parentPort.on('message', async ({ id, text, file }) => {
    let result;
    try {
      result = check(await compiler, text, file);
    } catch (e) {
      result = { line: 1, column: 1, message: `couldn't load the goal.js compiler at ${workerData.path}: ${e?.message ?? e}` };
    }
    parentPort.postMessage({ id, result });
  });
}
