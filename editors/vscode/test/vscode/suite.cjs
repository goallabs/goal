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

function fakeCompiler(rule, column = 3) {
  writeFileSync(
    path.join(WS, 'fake/node_modules/goaljs/compiler.js'),
    `export function compile(source, { file }) {
      const e = new Error(file + ':2:${column}: ' + ${JSON.stringify(rule)});
      Object.assign(e, { name: 'GoalError', file, line: 2, column: ${column} });
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
  assert.match(scopes('button'), /entity\.name\.tag\.tsx/);
  assert.match(scopes('var'), /storage\.type\.tsx/);

  // A #strict file is checked against the types of the #strict files it imports.
  const strict = await open('app/A.goal');
  d = await firstProblem(strict.uri, 'the prop type error');
  assert.equal(d.message, "B's n is number, not string");
  assert.equal(d.source, 'goal.js');
  assert.equal(d.range.start.line, 4);
  assert.equal(strict.doc.getText(d.range), 'n');
  const wrong = strict.doc.getText().indexOf('"1"');
  await strict.editor.edit((e) => e.replace(new vscode.Range(strict.doc.positionAt(wrong), strict.doc.positionAt(wrong + 3)), '{1}'));
  await until('the type error to clear', () => problems(strict.uri).length === 0);

  // A folder without goaljs is checked by the bundled copy.
  const plain = await open('plain/D.goal');
  d = await firstProblem(plain.uri, 'the bundled check');
  assert.equal(d.message, 'write onclick, the HTML name, not onClick');
  assert.match(d.source, /^goal\.js \d+\.\d+\.\d+ \(bundled\)$/);

  // It knows goal.js's latest release: a group, and a route's input types
  const group = await open('plain/G.goal');
  d = await firstProblem(group.uri, 'the input type error');
  assert.match(d.message, /^query arrives as text/);
  assert.equal(group.doc.getText(d.range), 'route');
  const groupTokens = await vscode.commands.executeCommand('_workbench.captureSyntaxTokens', group.uri);
  assert.match(groupTokens.find((t) => t.c === 'group').t, /storage\.type\.group\.goal/);
  assert.match(groupTokens.find((t) => t.c === 'query').t, /variable\.parameter\.route-input\.goal/);

  // In a style block, VS Code's CSS support completes, describes and shows colors; outside it, it doesn't.
  const card = await open('plain/Card.goal');
  const at = (s, d = 0) => card.doc.positionAt(card.doc.getText().indexOf(s) + d);
  const labels = async (pos) => (await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', card.uri, pos)).items.map((i) => i.label.label ?? i.label);
  await until('CSS property names in the style block', async () => (await labels(at('border-radius', 3))).includes('border-radius'));
  assert.ok((await labels(at('rebeccapurple'))).includes('red'));
  assert.ok(!(await labels(at('n++'))).includes('border-radius'));
  const [hover] = await vscode.commands.executeCommand('vscode.executeHoverProvider', card.uri, at('border-radius', 3));
  assert.match(hover.contents.map((c) => c.value ?? c).join(''), /radii/);
  assert.equal(card.doc.getText(hover.range), 'border-radius: 8px');
  assert.equal((await vscode.commands.executeCommand('vscode.executeHoverProvider', card.uri, at('onclick', 2))).length, 0);
  const colors = await vscode.commands.executeCommand('vscode.executeDocumentColorProvider', card.uri);
  assert.ok(colors.some((c) => card.doc.getText(c.range) === 'rebeccapurple'));
  // and the compiler's errors in it: the squiggle covers an @rule
  const imp = await open('plain/Imp.goal');
  d = await firstProblem(imp.uri, 'the @import error');
  assert.match(d.message, /@import/);
  assert.equal(imp.doc.getText(d.range), '@import');

  // A #strict file's types, highlighted by VS Code's TypeScript React grammar under goal's.
  const typed = await vscode.commands.executeCommand('_workbench.captureSyntaxTokens', vscode.Uri.file(path.join(WS, 'plain/S.goal')));
  const typedScopes = (text) => typed.find((t) => t.c.trim() === text)?.t ?? '';
  assert.match(typedScopes('#strict'), /keyword\.control\.directive\.strict\.goal/);
  assert.match(typedScopes('Note'), /entity\.name\.type\.alias\.tsx/);
  assert.match(typedScopes('boolean'), /support\.type\.primitive\.tsx/);
  assert.match(typedScopes('id'), /variable\.parameter\.route\.goal/);
  assert.match(typedScopes('number'), /support\.type\.primitive\.goal/);

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

  // A problem at `++x` or `[x] = …` points at no name: the squiggle goes under the one it's about.
  await fake.editor.edit((e) => e.insert(new vscode.Position(1, 2), '++$hits; [$hits] = [1]; '));
  for (const [column, start] of [
    [3, 4],
    [12, 12],
  ]) {
    fakeCompiler('`$hits` is declared outside the component', column);
    d = await until(`the squiggle under $hits from column ${column}`, () => problems(fake.uri).find((p) => p.message.startsWith('`$hits`') && p.range.start.character === start));
    assert.equal(fake.doc.getText(d.range), '$hits');
  }

  // A file that stops being goal (closed, or another language) loses its problems.
  await vscode.languages.setTextDocumentLanguage(fake.doc, 'plaintext');
  await until('problems to clear', () => problems(fake.uri).length === 0);

  // A project whose ESLint checks .goal files: opening one offers to turn VS Code's ESLint extension on
  // for them, keeping what it lints already, and its problems show where they are in the file.
  if (!vscode.extensions.getExtension('dbaeumer.vscode-eslint')) {
    console.log("VS Code's ESLint extension isn't installed: skipped the ESLint check");
    return;
  }
  const lint = await open('lint/L.goal');
  const eslint = () => vscode.workspace.getConfiguration('eslint', lint.uri);
  const probe = eslint().get('probe');
  assert.ok(probe.includes('javascript') && eslint().get('validate') === null);
  await until('the offer, and Turn on', async () => {
    await vscode.commands.executeCommand('notification.acceptPrimaryAction');
    return eslint().get('validate');
  });
  assert.deepEqual(eslint().get('validate'), [...probe, 'goal']);
  d = await until("ESLint's problem", () => problems(lint.uri).find((p) => p.source === 'eslint'));
  assert.match(d.message, /^'x' is assigned a value but never used/);
  assert.equal(d.range.start.line, 1);
  assert.equal(lint.doc.getText(d.range), 'x');

  // The command does it too, once.
  await eslint().update('validate', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  for (let i = 0; i < 2; i++) await vscode.commands.executeCommand('goal.lintWithESLint');
  assert.deepEqual(eslint().get('validate'), [...probe, 'goal']);
};
