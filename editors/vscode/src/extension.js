// goal.js for VS Code: the .goal language (see package.json and syntaxes/), and the compiler's errors
// as you type.
//
// Each .goal file is checked with the goal.js the project uses (`goaljs/compiler`, resolved from the
// file, so a project's node_modules or goal.js's own repository), only in a trusted folder: that
// compiler is the folder's code. Anywhere else, the copy bundled in dist/compiler.mjs checks it. Each
// compiler runs in its own worker thread (check.mjs); when a project's compiler changes on disk, its
// worker is replaced, so the next check uses the new rules.

const vscode = require('vscode');
const { Worker } = require('node:worker_threads');
const { createRequire } = require('node:module');
const { watch } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const BUNDLED = path.join(__dirname, '..', 'dist', 'compiler.mjs');
const BUNDLED_LABEL = `goal.js ${require('../dist/compiler.json').version} (bundled)`; // see scripts/bundle.mjs
const DELAY = 200; // ms after the last keystroke
const WORD = /<\/?[A-Za-z][\w$.:-]*|[\w$][\w$-]*/; // what an error's squiggle covers: a name, or a tag's start

/** A worker thread with one compiler loaded. check() resolves to a problem, null, or undefined if the worker went away. */
class Checker {
  constructor(compiler) {
    this.pending = new Map();
    this.next = 0;
    this.worker = new Worker(path.join(__dirname, 'check.mjs'), { workerData: { compiler: pathToFileURL(compiler).href, path: compiler } });
    this.worker.on('message', ({ id, result }) => {
      this.pending.get(id)?.(result);
      this.pending.delete(id);
    });
    this.worker.on('exit', () => {
      this.dead = true;
      this.settle();
    });
  }

  check(text, file) {
    const id = this.next++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ id, text, file });
    });
  }

  settle() {
    for (const resolve of this.pending.values()) resolve(undefined);
    this.pending.clear();
  }

  dispose() {
    this.dead = true;
    this.watcher?.close();
    this.settle();
    this.worker.terminate();
  }
}

function activate(context) {
  const diagnostics = vscode.languages.createDiagnosticCollection('goal');
  const checkers = new Map(); // compiler path -> Checker
  const timers = new Map(); // document uri -> pending check

  /** The compiler for a document: the project's in a trusted folder, else the bundled copy. */
  function compilerFor(doc) {
    if (vscode.workspace.isTrusted && doc.uri.scheme === 'file') {
      try {
        return { path: createRequire(doc.uri.fsPath).resolve('goaljs/compiler'), source: 'goal.js' };
      } catch {
        // the project has no goaljs: use the bundled copy
      }
    }
    return { path: BUNDLED, source: BUNDLED_LABEL };
  }

  function checkerFor(compiler) {
    let c = checkers.get(compiler);
    if (c && !c.dead) return c;
    c = new Checker(compiler);
    checkers.set(compiler, c);
    if (compiler !== BUNDLED) {
      try {
        c.watcher = watch(path.dirname(compiler), () => {
          if (checkers.get(compiler) === c) checkers.delete(compiler);
          c.dispose();
          recheckAll();
        });
      } catch {
        // can't watch it: changes to the compiler show after a reload
      }
    }
    return c;
  }

  async function check(doc) {
    if (doc.isClosed || doc.languageId !== 'goal') return;
    const version = doc.version;
    const compiler = compilerFor(doc);
    const file = doc.uri.scheme === 'file' ? doc.uri.fsPath : path.posix.basename(doc.uri.path) || 'untitled.goal';
    const problem = await checkerFor(compiler.path).check(doc.getText(), file);
    if (problem === undefined || doc.isClosed || doc.version !== version) return; // a newer check is on its way
    diagnostics.set(doc.uri, problem ? [diagnostic(doc, problem, compiler.source)] : []);
  }

  function schedule(doc, delay = DELAY) {
    if (doc.languageId !== 'goal') return;
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        check(doc);
      }, delay),
    );
  }

  function recheckAll() {
    for (const doc of vscode.workspace.textDocuments) schedule(doc);
  }

  context.subscriptions.push(
    diagnostics,
    vscode.workspace.onDidOpenTextDocument((doc) => schedule(doc, 0)),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    // Saving a file can change the server functions it exports to the files that import them.
    vscode.workspace.onDidSaveTextDocument((doc) => doc.languageId === 'goal' && recheckAll()),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      clearTimeout(timers.get(doc.uri.toString()));
      timers.delete(doc.uri.toString());
      diagnostics.delete(doc.uri);
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(recheckAll),
    {
      dispose() {
        for (const t of timers.values()) clearTimeout(t);
        for (const c of checkers.values()) c.dispose();
      },
    },
  );
  for (const doc of vscode.workspace.textDocuments) schedule(doc, 0);
}

/** A compiler problem as an error under the name or tag it points at. */
function diagnostic(doc, { line, column, message }, source) {
  const at = doc.validatePosition(new vscode.Position(line - 1, column - 1));
  const range = doc.getWordRangeAtPosition(at, WORD) ?? doc.validateRange(new vscode.Range(at, at.translate(0, 1)));
  const d = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
  d.source = source;
  return d;
}

module.exports = { activate, deactivate() {} };
