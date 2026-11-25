// Tokenizes .goal text the way VS Code does: vscode-textmate with oniguruma, our grammar, and the
// TypeScript React grammar VS Code ships with (from the installed app, or GOAL_TSX_GRAMMAR).

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vsctm from 'vscode-textmate';
import oniguruma from 'vscode-oniguruma';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

const CANDIDATES = [
  process.env.GOAL_TSX_GRAMMAR,
  '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/typescript-basics/syntaxes/TypeScriptReact.tmLanguage.json',
  '/usr/share/code/resources/app/extensions/typescript-basics/syntaxes/TypeScriptReact.tmLanguage.json',
];

/** Where VS Code's TypeScript React grammar is, or undefined. */
export const TSX_GRAMMAR = CANDIDATES.find((p) => p && existsSync(p));

let registry;
function load() {
  const wasm = readFileSync(join(dirname(require.resolve('vscode-oniguruma')), 'onig.wasm')).buffer;
  const lib = oniguruma.loadWASM(wasm).then(() => ({
    createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
    createOnigString: (s) => new oniguruma.OnigString(s),
  }));
  const files = {
    'source.goal': join(HERE, '..', 'syntaxes', 'goal.tmLanguage.json'),
    'source.tsx': TSX_GRAMMAR,
  };
  return new vsctm.Registry({
    onigLib: lib,
    loadGrammar: async (scope) => (files[scope] ? vsctm.parseRawGrammar(readFileSync(files[scope], 'utf8'), files[scope]) : null),
  });
}

/** Each line's tokens: { text, scopes } with scopes from outermost to innermost. */
export async function tokenize(text) {
  registry ??= load();
  const grammar = await registry.loadGrammar('source.goal');
  let state = vsctm.INITIAL;
  return text.split('\n').map((line) => {
    const r = grammar.tokenizeLine(line, state);
    state = r.ruleStack;
    return r.tokens.map((t) => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes }));
  });
}

/** The innermost scopes of the first token with this text, searching from line `from` on. */
export function scopesOf(lines, text, from = 0) {
  for (const line of lines.slice(from)) {
    const t = line.find((t) => t.text.trim() === text);
    if (t) return t.scopes;
  }
  throw new Error(`no token ${JSON.stringify(text)}`);
}
