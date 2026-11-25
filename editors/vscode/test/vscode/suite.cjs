// Runs inside VS Code (see run.mjs). Uses the fixtures run.mjs wrote to GOAL_FIXTURES.

const vscode = require('vscode');
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const WS = process.env.GOAL_FIXTURES;

async function until(what, f, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const problems = (uri) => vscode.languages.getDiagnostics(uri);
const firstProblem = (uri, what) => until(what, () => problems(uri)[0]);

async function open(rel) {
  const uri = vscode.Uri.file(path.join(WS, rel));
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  return { uri, doc, editor };
}

function fakeCompiler(rule) {
  writeFileSync(
    path.join(WS, 'fake/node_modules/goaljs/compiler.js'),
    `export function compile(source, { file }) {
      const e = new Error(file + ':2:3: ' + ${JSON.stringify(rule)});
      Object.assign(e, { name: 'GoalError', file, line: 2, column: 3 });
      throw e;
    }\n`,
  );
}

exports.run = async function run() {
  // A project's own goal.js checks its files, and the squiggle covers the name.
  const { uri, doc, editor } = await open('app/C.goal');
  assert.equal(doc.languageId, 'goal');
  let d = await firstProblem(uri, 'the onClick error');
  assert.equal(d.message, 'write onclick, the HTML name, not onClick');
  assert.equal(d.source, 'goal.js');
  assert.equal(d.severity, vscode.DiagnosticSeverity.Error);
  assert.equal(doc.getText(d.range), 'onClick');
  assert.equal(d.range.start.line, 2);

  // Fixing it clears it; a new mistake shows as you type.
  await editor.edit((e) => e.replace(d.range, 'onclick'));
  await until('the error to clear', () => problems(uri).length === 0);
  await editor.edit((e) => e.insert(new vscode.Position(2, 0), '  n = 2;\n'));
  d = await firstProblem(uri, 'the state error');
  assert.equal(d.message, '`n` is state: change it in an event handler, not while rendering');
  assert.equal(doc.getText(d.range), 'n');

  // Highlighting, as VS Code renders it.
  const tokens = await vscode.commands.executeCommand('_workbench.captureSyntaxTokens', uri);
  const scopes = (text) => tokens.find((t) => t.c.trim() === text)?.t ?? '';
  assert.match(scopes('button'), /entity\.name\.tag\.js\.jsx/);
  assert.match(scopes('var'), /storage\.type\.js\.jsx/);

  // A folder without goaljs is checked by the bundled copy.
  const plain = await open('plain/D.goal');
  d = await firstProblem(plain.uri, 'the bundled check');
  assert.equal(d.message, 'write onclick, the HTML name, not onClick');
  assert.equal(d.source, 'goal.js (bundled)');

  // When a project's compiler changes on disk, the next check uses the new one.
  fakeCompiler('rule one');
  const fake = await open('fake/E.goal');
  d = await firstProblem(fake.uri, 'the fake compiler');
  assert.equal(d.message, 'rule one');
  assert.equal(d.range.start.line, 1);
  assert.equal(d.range.start.character, 2);
  fakeCompiler('rule two');
  await until('the new compiler', () => problems(fake.uri)[0]?.message === 'rule two');

  const routeTokens = await vscode.commands.executeCommand('_workbench.captureSyntaxTokens', fake.uri);
  assert.match(routeTokens.find((t) => t.c === 'route').t, /storage\.type\.route\.goal/);
  assert.match(routeTokens.find((t) => t.c === 'GET').t, /constant\.language\.http-method\.goal/);

  // A file that stops being goal (closed, or another language) loses its problems.
  await vscode.languages.setTextDocumentLanguage(fake.doc, 'plaintext');
  await until('problems to clear', () => problems(fake.uri).length === 0);
};
