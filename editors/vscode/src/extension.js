// goal.js for VS Code: the .goal language (see package.json and syntaxes/), and the compiler's errors
// as you type.
//
// Each .goal file is checked with the goal.js the project uses (`goaljs/compiler`, resolved from the
// file, so a project's node_modules or goal.js's own repository), only in a trusted folder: that
// compiler is the folder's code. Anywhere else, the copy bundled in dist/compiler.mjs checks it. Each
// compiler runs in its own worker thread (check.mjs); when a project's compiler changes on disk, its
// worker is replaced, so the next check uses the new rules.
//
// In a style block, VS Code's own CSS support completes, describes and shows colors: it's asked about
// a copy of the file with only the block's CSS in it, at the same places (see css.js).
//
// The tools `goal add` sets up: when a project's ESLint lints .goal files (goaljs/eslint), it offers to
// turn VS Code's ESLint extension on for them (see tools.js). Tailwind CSS IntelliSense reads .goal
// files as JSX through a default in package.json.

const vscode = require('vscode');
const { Worker } = require('node:worker_threads');
const { createRequire } = require('node:module');
const { watch } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { goalESLintConfig, validateWithGoal } = require('./tools.js');
const { styleBlock, cssOnly } = require('./css.js');

const ESLINT = 'dbaeumer.vscode-eslint'; // VS Code's ESLint extension
const CSS_COPY = 'goal-css'; // the scheme of a style block's copy
const BUNDLED = path.join(__dirname, '..', 'dist', 'compiler.mjs');
const BUNDLED_LABEL = `goal.js ${require('../dist/compiler.json').version} (bundled)`; // see scripts/bundle.mjs
const DELAY = 200; // ms after the last keystroke
const WORD = /<\/?[A-Za-z][\w$.:-]*|@[A-Za-z][\w-]*|[\w$][\w$-]*/; // what an error's squiggle covers: a name, a tag's start, or a CSS @rule

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

  /** When the project's ESLint lints .goal files but VS Code's ESLint extension doesn't, offer to turn it on (once per folder a session). */
  const offered = new Set();
  function offerESLint(doc) {
    if (doc.languageId !== 'goal' || doc.uri.scheme !== 'file' || !vscode.workspace.isTrusted || !vscode.extensions.getExtension(ESLINT)) return;
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder) return;
    const key = `eslint.dontAsk ${folder.uri}`;
    if (offered.has(key) || context.workspaceState.get(key)) return;
    const eslint = vscode.workspace.getConfiguration('eslint', folder.uri);
    if (!validateWithGoal(eslint.get('validate'), eslint.get('probe')) || !goalESLintConfig(doc.uri.fsPath, folder.uri.fsPath)) return;
    offered.add(key);
    const on = 'Turn on';
    const never = "Don't ask again";
    vscode.window
      .showInformationMessage(`This project's ESLint checks .goal files (goaljs/eslint). Show its problems in VS Code too? This adds goal to eslint.validate in the settings of ${folder.name}.`, on, never)
      .then((choice) => (choice === on ? lintWithESLint(folder) : choice === never && context.workspaceState.update(key, true)));
  }

  context.subscriptions.push(
    diagnostics,
    vscode.commands.registerCommand('goal.lintWithESLint', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      const folders = vscode.workspace.workspaceFolders ?? [];
      const folder = (doc && vscode.workspace.getWorkspaceFolder(doc.uri)) ?? (folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick());
      if (folder) await lintWithESLint(folder);
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      schedule(doc, 0);
      offerESLint(doc);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    // Saving a file can change the server functions it exports to the files that import them.
    vscode.workspace.onDidSaveTextDocument((doc) => doc.languageId === 'goal' && recheckAll()),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      clearTimeout(timers.get(doc.uri.toString()));
      timers.delete(doc.uri.toString());
      diagnostics.delete(doc.uri);
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      recheckAll();
      vscode.workspace.textDocuments.forEach(offerESLint);
    }),
    {
      dispose() {
        for (const t of timers.values()) clearTimeout(t);
        for (const c of checkers.values()) c.dispose();
      },
    },
  );
  for (const doc of vscode.workspace.textDocuments) {
    schedule(doc, 0);
    offerESLint(doc);
  }
  cssInStyleBlocks(context);
}

/**
 * CSS completions, hovers and colors in a style block, from VS Code's own CSS support: it's asked about
 * a copy of the file with only the block's CSS left (css.js), so its answers are at the right places.
 * Each .goal file has one copy, open while it's asked about (VS Code's color command only takes an
 * open document), and brought up to date before each question.
 */
function cssInStyleBlocks(context) {
  const copies = new Map(); // a copy's uri -> its text
  const changed = new vscode.EventEmitter(); // a copy's uri, when its text changes
  const support = vscode.extensions.getExtension('vscode.css-language-features'); // VS Code's CSS support, unless it's been disabled
  const copyOf = (doc) => vscode.Uri.from({ scheme: CSS_COPY, path: `/${encodeURIComponent(doc.uri.toString())}.css` });
  /** The uri of the file's copy, up to date, if it has a style block and the offset `at` is in its CSS (or isn't given). */
  async function copy(doc, at) {
    if (!support) return;
    if (!support.isActive) await support.activate(); // opening a copy doesn't start it
    const text = doc.getText();
    const block = styleBlock(text);
    if (!block || (at !== undefined && (at < block.start || at > block.end))) return;
    const uri = copyOf(doc);
    const css = cssOnly(text, block);
    copies.set(uri.toString(), css);
    const open = await vscode.workspace.openTextDocument(uri);
    if (open.getText() !== css) {
      // VS Code asks for the new text, and has it once the copy changes (or a newer question has taken over)
      await new Promise((resolve) => {
        const done = () => (sub.dispose(), clearTimeout(timer), resolve());
        const sub = vscode.workspace.onDidChangeTextDocument((e) => e.document === open && (open.getText() === css || copies.get(uri.toString()) !== css) && done());
        const timer = setTimeout(done, 1000);
        changed.fire(uri);
      });
    }
    return uri;
  }
  // It takes a moment to answer once started, so it starts as soon as a .goal file has a style block.
  const start = (doc) => doc.languageId === 'goal' && support && !support.isActive && styleBlock(doc.getText()) && support.activate();
  vscode.workspace.textDocuments.forEach(start);
  const goal = { language: 'goal' };
  context.subscriptions.push(
    changed,
    vscode.workspace.onDidOpenTextDocument(start),
    vscode.workspace.onDidChangeTextDocument((e) => start(e.document)),
    vscode.workspace.registerTextDocumentContentProvider(CSS_COPY, { onDidChange: changed.event, provideTextDocumentContent: (uri) => copies.get(uri.toString()) ?? '' }),
    vscode.languages.registerCompletionItemProvider(
      goal,
      {
        async provideCompletionItems(doc, pos, _token, { triggerCharacter }) {
          const uri = await copy(doc, doc.offsetAt(pos));
          return uri && vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, pos, triggerCharacter);
        },
      },
      '/',
      '-',
      ':', // as VS Code's CSS support has them
    ),
    vscode.languages.registerHoverProvider(goal, {
      async provideHover(doc, pos) {
        const uri = await copy(doc, doc.offsetAt(pos));
        return uri && (await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, pos))[0];
      },
    }),
    vscode.languages.registerColorProvider(goal, {
      async provideDocumentColors(doc) {
        const uri = await copy(doc);
        return uri ? vscode.commands.executeCommand('vscode.executeDocumentColorProvider', uri) : [];
      },
      async provideColorPresentations(color, { document, range }) {
        const uri = await copy(document);
        return uri && vscode.commands.executeCommand('vscode.executeColorPresentationProvider', color, { uri, range });
      },
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => doc.languageId === 'goal' && copies.delete(copyOf(doc).toString())),
  );
}

/** Turns VS Code's ESLint extension on for .goal files in a folder: goal in eslint.validate, in the folder's settings. */
async function lintWithESLint(folder) {
  if (!vscode.extensions.getExtension(ESLINT)) {
    vscode.window.showWarningMessage(`VS Code's ESLint extension (${ESLINT}) isn't installed.`);
    return;
  }
  const eslint = vscode.workspace.getConfiguration('eslint', folder.uri);
  const validate = validateWithGoal(eslint.get('validate'), eslint.get('probe'));
  if (validate) await eslint.update('validate', validate, vscode.ConfigurationTarget.WorkspaceFolder);
}

/** A compiler problem as an error under the name or tag it points at. */
function diagnostic(doc, { line, column, message }, source) {
  const at = doc.validatePosition(new vscode.Position(line - 1, column - 1));
  const range = doc.getWordRangeAtPosition(at, WORD) ?? named(doc, at, message) ?? doc.validateRange(new vscode.Range(at, at.translate(0, 1)));
  const d = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
  d.source = source;
  return d;
}

/** At `++n` or `[n] = …`, where a problem points at no name: the name its message is about (`n`), where it comes next on the line. */
function named(doc, at, message) {
  const name = /`([\w$]+)`/.exec(message)?.[1];
  if (!name) return;
  const i = doc.lineAt(at.line).text.slice(at.character).search(new RegExp(`(?<![\\w$])${name.replaceAll('$', '\\$')}(?![\\w$])`));
  if (i >= 0) return new vscode.Range(at.translate(0, i), at.translate(0, i + name.length));
}

module.exports = { activate, deactivate() {} };
