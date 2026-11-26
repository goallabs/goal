import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import tools from '../src/tools.js';

const { goalESLintConfig, validateWithGoal } = tools;
const GOAL = "import goal from 'goaljs/eslint';\nexport default [...goal.configs.recommended];\n";

test("goalESLintConfig: the nearest ESLint config, if it's goal's", () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-tools-'));
  const write = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  try {
    write('app/eslint.config.js', GOAL);
    write('app/routes/deep/A.goal', '');
    write('other/eslint.config.mjs', 'export default [];\n');
    write('other/B.goal', '');
    write('mixed/eslint.config.mjs', GOAL.replaceAll("'", '"'));
    write('mixed/inner/eslint.config.cjs', 'module.exports = [];\n');
    write('mixed/inner/C.goal', '');
    write('mixed/D.goal', '');
    write('none/E.goal', '');
    // in the file's folder or above it, any of the names ESLint looks for, either quote
    assert.equal(goalESLintConfig(join(root, 'app/routes/deep/A.goal'), root), join(root, 'app/eslint.config.js'));
    assert.equal(goalESLintConfig(join(root, 'mixed/D.goal'), root), join(root, 'mixed/eslint.config.mjs'));
    // a config without goaljs/eslint, even with goal's further up: ESLint uses the nearest one
    assert.equal(goalESLintConfig(join(root, 'other/B.goal'), root), null);
    assert.equal(goalESLintConfig(join(root, 'mixed/inner/C.goal'), root), null);
    // none up to the root, which it doesn't look above
    assert.equal(goalESLintConfig(join(root, 'none/E.goal'), root), null);
    write('eslint.config.js', GOAL);
    assert.equal(goalESLintConfig(join(root, 'none/E.goal'), join(root, 'none')), null);
    assert.equal(goalESLintConfig(join(root, 'none/E.goal'), root), join(root, 'eslint.config.js'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validateWithGoal: what ESLint lints now, and goal', () => {
  const probe = ['javascript', 'javascriptreact', 'typescript', 'html'];
  // no eslint.validate: the probed languages, now validated, so they stay linted
  assert.deepEqual(validateWithGoal(null, probe), [...probe, 'goal']);
  assert.deepEqual(validateWithGoal(undefined, undefined), ['goal']);
  // the user's eslint.validate, kept as it is
  assert.deepEqual(validateWithGoal(['javascript', { language: 'vue', autoFix: true }], probe), ['javascript', { language: 'vue', autoFix: true }, 'goal']);
  assert.deepEqual(validateWithGoal([], probe), ['goal']);
  // goal in it already: nothing to do
  assert.equal(validateWithGoal(['javascript', 'goal'], probe), null);
  assert.equal(validateWithGoal([{ language: 'goal' }], probe), null);
  assert.equal(validateWithGoal(null, [...probe, 'goal']), null);
});
