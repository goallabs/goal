// goal add <tool>: sets a tool up in the app. A recipe (recipes/<tool>.js) says, for each range of
// the tool's versions, which packages to install and what the app needs around them: files, lines in
// files like .gitignore, package.json scripts, goal.config.js keys, commands to run once, and what to
// do next. Recipes are data, kept up to date by pull request (see recipes/README.md).
//
// Nothing of the app's is overwritten: a file that's there already is kept and the recipe's version
// shown, a package the app has already isn't installed again, and its version picks the recipe.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';

const RECIPES = join(dirname(fileURLToPath(import.meta.url)), '..', 'recipes');
const HELP = 'https://github.com/goallabs/goal/tree/main/recipes';

/** Every recipe, by file name. */
export async function recipes(dir = RECIPES) {
  const all = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) all.push((await import(pathToFileURL(join(dir, f)).href)).default);
  return all;
}

/** 4.3.5-rc.1 → [4, 3, 5]; 4 → [4, 0, 0] */
const parts = (v) => {
  const p = v.split('-')[0].split('.').map(Number);
  return [p[0], p[1] ?? 0, p[2] ?? 0];
};

/**
 * Is the version in the range? Ranges are npm's, in part: `4` or `4.x` (any 4), `>=0.30 <0.32`
 * (all of them), `3 || 4` (either). A version may be partial: `3` is 3.0.0 to a comparison.
 */
export function satisfies(version, range) {
  const v = parts(version);
  const cmp = (w) => v[0] - w[0] || v[1] - w[1] || v[2] - w[2];
  return range.split('||').some((alt) =>
    alt
      .trim()
      .split(/\s+/)
      .every((c) => {
        const [, op, n] = /^(>=|<=|>|<|=)?(.*)$/.exec(c);
        if (!op) return n.split('.').filter((x) => x !== 'x' && x !== '*').every((x, i) => v[i] === Number(x)); // 3 is 3.0.0 here too
        const d = cmp(parts(n));
        return { '>=': d >= 0, '<=': d <= 0, '>': d > 0, '<': d < 0, '=': d === 0 }[op];
      }),
  );
}

/** The recipe's entry for a version of its package; its newest without one. */
export function pick(recipe, version) {
  if (!version) return recipe.versions[0];
  const v = recipe.versions.find((e) => satisfies(version, e.range));
  if (!v) throw new Error(`goal add has no recipe for ${recipe.package} ${version}, only for ${recipe.versions.map((e) => e.range).join(', ')}. To add one, see ${HELP}`);
  return v;
}

/** Is this line, or one that means the same, in the list? `dist` and `/dist/`, `KEY=a` and `KEY=b` do. */
const has = (lines, line) => {
  const key = (l) => /^[A-Za-z_]\w*=/.exec(l.trim())?.[0] ?? l.trim().replace(/^\/|\/$/g, '');
  return lines.some((l) => key(l) === key(line));
};

/** The app's version of a package, from a range like ^4.1.0; nothing for a tag, a URL or a path. */
const coerce = (range) => /^[\^~=v]*(\d+(\.\d+){0,2})/.exec(range ?? '')?.[1];

/** goal.config.js gets the recipe's keys, and the import they need, unless it has them already. */
function configure(app, c, log) {
  const file = join(app, 'goal.config.js');
  const prop = (k) => (c.keys[k] === k ? k : `${k}: ${c.keys[k]}`);
  if (!existsSync(file)) {
    writeFileSync(file, `${c.import}\n\nexport default {\n${Object.keys(c.keys).map((k) => `  ${prop(k)},\n`).join('')}};\n`);
    return log('  created goal.config.js');
  }
  let text = readFileSync(file, 'utf8');
  let body;
  try {
    body = parse(text, { sourceType: 'module' }).program.body;
  } catch {
    body = [];
  }
  const obj = body.find((n) => n.type === 'ExportDefaultDeclaration')?.declaration;
  if (obj?.type !== 'ObjectExpression')
    return log(`  goal.config.js: add this to it yourself (its default export isn't an object to add to):\n    ${c.import}\n    ${Object.keys(c.keys).map(prop).join(', ')}`);
  const keys = new Set(obj.properties.map((p) => p.key?.name ?? p.key?.value));
  const missing = Object.keys(c.keys).filter((k) => !keys.has(k));
  if (!missing.length) return log(`  kept goal.config.js: it has ${Object.keys(c.keys).join(', ')} already`);
  text = text.slice(0, obj.start + 1) + missing.map((k) => `\n  ${prop(k)},`).join('') + text.slice(obj.start + 1);
  if (!text.includes(c.import)) {
    const at = body.filter((n) => n.type === 'ImportDeclaration').at(-1)?.end;
    text = at === undefined ? `${c.import}\n${text}` : `${text.slice(0, at)}\n${c.import}${text.slice(at)}`;
  }
  writeFileSync(file, text);
  log(`  added ${missing.join(', ')} to goal.config.js`);
}

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

/**
 * Sets a tool up in the app: `spec` is the recipe's name, with a version to pick the recipe for one
 * (`tailwindcss@3`). Without a name, lists the recipes. `run` runs a command in the app's folder.
 */
export async function add(app, spec, { log = console.log, run = sh, dir } = {}) {
  const all = await recipes(dir);
  if (!spec) {
    log('goal add <tool> [app folder] sets a tool up in the app. Recipes:');
    for (const r of all) log(`  ${[r.name, ...(r.aliases ?? [])].join(', ').padEnd(24)} ${r.about} (${r.versions.map((e) => e.range).join(', ')})`);
    return;
  }
  const at = spec.lastIndexOf('@');
  const [name, version] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec];
  const recipe = all.find((r) => r.name === name || r.package === name || r.aliases?.includes(name));
  if (!recipe) throw new Error(`goal add has no recipe for ${name}; it has ${all.map((r) => r.name).join(', ')}. To add one, see ${HELP}`);

  const pkgFile = join(app, 'package.json');
  const read = () => (existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, 'utf8')) : { private: true });
  let pkg = read();
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const mine = coerce(deps[recipe.package]);
  const e = pick(recipe, version ?? mine);
  log(`${recipe.name}: the recipe for ${recipe.package} ${e.range}${mine && !version ? ` (the app has ${deps[recipe.package]})` : ''}`);

  if (pkg.type !== 'module') {
    pkg.type = 'module';
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
    log('  set "type": "module" in package.json: goal.js apps are ES modules');
  }
  for (const [field, flag] of [['dependencies', '--save'], ['devDependencies', '--save-dev']]) {
    const names = Object.keys(e[field] ?? {}).filter((n) => !(n in deps));
    for (const n of Object.keys(e[field] ?? {}).filter((n) => n in deps)) log(`  kept ${n} ${deps[n]}`);
    if (!names.length) continue;
    const cmd = `npm install ${flag} ${names.map((n) => `${n}@${e[field][n]}`).join(' ')}`;
    log(`  $ ${cmd}`);
    run(cmd, app);
  }

  for (const [f, text] of Object.entries(e.files ?? {})) {
    const file = join(app, f);
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
      log(`  created ${f}`);
    } else if (readFileSync(file, 'utf8') === text) log(`  kept ${f}: it's set up already`);
    else log(`  kept ${f}, which isn't the recipe's. The recipe's:\n${text.trimEnd().replace(/^(?=.)/gm, '      ')}`);
  }
  // Lines a file needs: at its start (prepend), like a stylesheet's @import, or at its end (lines)
  for (const [where, ops] of [['start', e.prepend], ['end', e.lines]])
    for (const [f, want] of Object.entries(ops ?? {})) {
      const file = join(app, f);
      const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const now = text.split(/\r?\n/);
      const add = want.filter((l) => !has(now, l));
      if (!add.length) continue;
      mkdirSync(dirname(file), { recursive: true });
      const lines = add.join('\n') + '\n';
      writeFileSync(file, where === 'start' ? lines + text : text + (text && !text.endsWith('\n') ? '\n' : '') + lines);
      log(`  added to ${f}: ${add.join(', ')}`);
    }
  pkg = read(); // as npm left it
  const placeholder = /^echo "Error: no test specified" && exit 1$/; // npm init's
  const scripts = Object.entries(e.scripts ?? {}).filter(([k, v]) => {
    if (!pkg.scripts?.[k] || placeholder.test(pkg.scripts[k])) return true;
    if (pkg.scripts[k] !== v) log(`  kept the script ${k}: ${pkg.scripts[k]} (the recipe's: ${v})`);
    return false;
  });
  if (scripts.length) {
    pkg.scripts = { ...pkg.scripts, ...Object.fromEntries(scripts) };
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
    log(`  added the script${scripts.length > 1 ? 's' : ''} ${scripts.map(([k]) => k).join(', ')} to package.json`);
  }
  if (e.config) configure(app, e.config, log);
  for (const cmd of e.run ?? []) {
    log(`  $ ${cmd}`);
    run(cmd, app);
  }
  log('Next:');
  for (const n of [...(e.next ?? []), `Docs: ${recipe.docs}`]) log(`  - ${n}`);
}
