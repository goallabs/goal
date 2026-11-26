// What the extension knows about the tools `goal add` sets up (docs/tools.md), apart from VS Code.

const { readFileSync } = require('node:fs');
const path = require('node:path');

const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts'];

/**
 * The ESLint config that lints a .goal file with goaljs/eslint, or null: the nearest config in the
 * file's folder or above it (the one ESLint uses), up to `root`, if it imports goaljs/eslint.
 */
function goalESLintConfig(file, root) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    for (const name of ESLINT_CONFIGS) {
      let text;
      try {
        text = readFileSync(path.join(dir, name), 'utf8');
      } catch {
        continue;
      }
      return /['"]goaljs\/eslint['"]/.test(text) ? path.join(dir, name) : null;
    }
    if (dir === root || path.dirname(dir) === dir) return null;
  }
}

/**
 * VS Code's ESLint extension lints only the languages in eslint.validate, or when that isn't set, the
 * ones in eslint.probe that it knows, and goal isn't one. This is eslint.validate with goal added to
 * what it lints now, or null if goal is in it already. Under a flat config, a language on the list
 * whose files the config doesn't cover is still left alone.
 */
function validateWithGoal(validate, probe) {
  const now = Array.isArray(validate) ? validate : Array.isArray(probe) ? probe : [];
  return now.some((x) => x === 'goal' || x?.language === 'goal') ? null : [...now, 'goal'];
}

module.exports = { goalESLintConfig, validateWithGoal };
