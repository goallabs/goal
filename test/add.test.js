import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { add, recipes, satisfies, pick } from '../src/add.js';
import { main, args } from '../src/cli.js';
import { TMP } from './helpers.js';

// A recipe with every kind of step, in a folder of its own
const RECIPES = join(TMP, `recipes${process.pid}`);
const TOOL = {
  name: 'tool',
  aliases: ['the-tool'],
  package: 'tool-core',
  about: 'A tool',
  docs: 'https://example.com/docs',
  versions: [
    {
      range: '2',
      dependencies: { 'tool-core': '2.1.0', 'tool-db': '1.0.0' },
      devDependencies: { 'tool-cli': '2.1.0' },
      files: { 'tool.config.js': 'export default {};\n', 'lib/tool.js': 'export const tool = 1;\n' },
      prepend: { 'public/style.css': ['@import "tool";'] },
      lines: { '.gitignore': ['node_modules', 'dist'], '.env': ['TOOL_KEY=', 'TOOL_URL=x'] },
      scripts: { test: 'tool test', lint: 'tool lint', go: 'tool go' },
      config: { import: "import { onError } from './lib/tool.js';", keys: { onError: 'onError', level: "'all'" } },
      run: ['npx tool init'],
      next: ['Use the tool'],
    },
    { range: '1', devDependencies: { 'tool-core': '1.0.0' } },
  ],
};
rmSync(RECIPES, { recursive: true, force: true });
mkdirSync(RECIPES, { recursive: true });
writeFileSync(join(RECIPES, 'tool.js'), `export default ${JSON.stringify(TOOL)};`);
writeFileSync(join(RECIPES, 'README.md'), 'not a recipe');
writeFileSync(
  join(RECIPES, 'echo.js'),
  `export default ${JSON.stringify({ name: 'echo', package: 'echo', about: 'Runs a command', docs: 'https://example.com', versions: [{ range: '1', lines: { '.gitignore': ['dist'] }, run: [`node -e "require('fs').writeFileSync('ran.txt', 'here')"`] }] })};`,
);

let n = 0;
function app(files = {}) {
  const dir = join(TMP, `add${process.pid}-${n++}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), typeof text === 'string' ? text : JSON.stringify(text));
  }
  return dir;
}

/** goal add with the recipe above: what it logged, and the commands it ran. */
async function run(dir, spec) {
  const log = [];
  const ran = [];
  await add(dir, spec, { log: (m) => log.push(m), run: (cmd, cwd) => ran.push([cmd, cwd]), dir: RECIPES });
  return { log: log.join('\n'), ran: ran.map(([cmd, cwd]) => (cwd === dir ? cmd : 'elsewhere')) };
}
const read = (dir, f) => readFileSync(join(dir, f), 'utf8');

describe('versions', () => {
  it('matches npm ranges: a major, x, comparisons, alternatives, partial versions', () => {
    expect(satisfies('4.3.5', '4')).toBe(true);
    expect(satisfies('4.3.5', '4.x')).toBe(true);
    expect(satisfies('4.3.5', '*')).toBe(true);
    expect(satisfies('3.4.19', '4')).toBe(false);
    expect(satisfies('0.45.4', '>=0.45 <1')).toBe(true);
    expect(satisfies('0.44.9', '>=0.45 <1')).toBe(false);
    expect(satisfies('1.0.0', '>=0.45 <1')).toBe(false);
    expect(satisfies('2.0.0-rc.1', '>1.9 <=2')).toBe(true); // a prerelease counts as its version
    expect(satisfies('3', '=3.0.0')).toBe(true);
    expect(satisfies('5.1.0', '3 || 5')).toBe(true);
    expect(satisfies('4', '3 || 5')).toBe(false);
  });

  it("picks the newest entry, or the one for a version, and says when there's none", () => {
    expect(pick(TOOL)).toBe(TOOL.versions[0]);
    expect(pick(TOOL, '1.2')).toBe(TOOL.versions[1]);
    expect(() => pick(TOOL, '7')).toThrow('goal add has no recipe for tool-core 7, only for 2, 1. To add one, see https://github.com/goallabs/goal/tree/main/recipes');
  });

  it("loads goal.js's own recipes", async () => {
    const names = (await recipes()).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['tailwindcss', 'postcss', 'prisma', 'drizzle', 'eslint', 'prettier', 'vitest', 'playwright', 'sentry']));
  });
});

describe('goal add', () => {
  it('lists the recipes', async () => {
    const log = [];
    await add('.', undefined, { log: (m) => log.push(m), dir: RECIPES });
    expect(log).toEqual(['goal add <tool> [app folder] sets a tool up in the app. Recipes:', `  ${'echo'.padEnd(24)} Runs a command (1)`, `  ${'tool, the-tool'.padEnd(24)} A tool (2, 1)`]);
  });

  it("refuses a tool it has no recipe for", async () => {
    await expect(run(app(), 'nothing')).rejects.toThrow('goal add has no recipe for nothing; it has echo, tool. To add one, see');
  });

  it('sets a tool up in a new app: installs, writes files and lines, scripts, goal.config.js, runs, says what next', async () => {
    const dir = app();
    const { log, ran } = await run(dir, 'tool');
    expect(ran).toEqual(['npm install --save tool-core@2.1.0 tool-db@1.0.0', 'npm install --save-dev tool-cli@2.1.0', 'npx tool init']);
    expect(JSON.parse(read(dir, 'package.json'))).toEqual({ private: true, type: 'module', scripts: { test: 'tool test', lint: 'tool lint', go: 'tool go' } });
    expect(read(dir, 'tool.config.js')).toBe('export default {};\n');
    expect(read(dir, 'lib/tool.js')).toBe('export const tool = 1;\n');
    expect(read(dir, 'public/style.css')).toBe('@import "tool";\n');
    expect(read(dir, '.gitignore')).toBe('node_modules\ndist\n');
    expect(read(dir, 'goal.config.js')).toBe("import { onError } from './lib/tool.js';\n\nexport default {\n  onError,\n  level: 'all',\n};\n");
    expect(log).toBe(
      [
        'tool: the recipe for tool-core 2',
        '  set "type": "module" in package.json: goal.js apps are ES modules',
        '  $ npm install --save tool-core@2.1.0 tool-db@1.0.0',
        '  $ npm install --save-dev tool-cli@2.1.0',
        '  created tool.config.js',
        '  created lib/tool.js',
        '  added to public/style.css: @import "tool";',
        '  added to .gitignore: node_modules, dist',
        '  added to .env: TOOL_KEY=, TOOL_URL=x',
        '  added the scripts test, lint, go to package.json',
        '  created goal.config.js',
        '  $ npx tool init',
        'Next:',
        '  - Use the tool',
        '  - Docs: https://example.com/docs',
      ].join('\n'),
    );
  });

  it("keeps what the app has: its packages, files, lines, scripts and goal.config.js keys", async () => {
    const dir = app({
      'package.json': { name: 'a', type: 'module', dependencies: { 'tool-core': '^2.0.1' }, devDependencies: { 'tool-cli': '2.0.0' }, scripts: { test: 'echo "Error: no test specified" && exit 1', lint: 'mine', go: 'tool go' } },
      'tool.config.js': 'export default {};\n',
      'lib/tool.js': 'mine\n',
      'public/style.css': 'p {}',
      '.gitignore': '/node_modules/\ndist',
      '.env': 'TOOL_KEY=secret\n',
      'goal.config.js': "import x from './x.js';\n\nexport default {\n  csrf: false,\n  'level': 1,\n};\n",
    });
    const { log, ran } = await run(dir, 'the-tool');
    expect(ran).toEqual(['npm install --save tool-db@1.0.0', 'npx tool init']);
    expect(log).toContain('tool: the recipe for tool-core 2 (the app has ^2.0.1)');
    expect(log).toContain('  kept tool-core ^2.0.1\n  $ npm install --save tool-db@1.0.0\n  kept tool-cli 2.0.0\n');
    expect(log).toContain("  kept tool.config.js: it's set up already");
    expect(log).toContain("  kept lib/tool.js, which isn't the recipe's. The recipe's:\n      export const tool = 1;\n  added");
    expect(read(dir, 'lib/tool.js')).toBe('mine\n');
    expect(read(dir, 'public/style.css')).toBe('@import "tool";\np {}');
    expect(read(dir, '.gitignore')).toBe('/node_modules/\ndist'); // the same lines, written their way
    expect(read(dir, '.env')).toBe('TOOL_KEY=secret\nTOOL_URL=x\n'); // a key it has keeps its value
    expect(log).toContain('  kept the script lint: mine (the recipe\'s: tool lint)');
    expect(JSON.parse(read(dir, 'package.json')).scripts).toEqual({ test: 'tool test', lint: 'mine', go: 'tool go' }); // npm init's test script isn't one to keep
    expect(log).toContain('  added the script test to package.json');
    expect(read(dir, 'goal.config.js')).toBe("import x from './x.js';\nimport { onError } from './lib/tool.js';\n\nexport default {\n  onError,\n  csrf: false,\n  'level': 1,\n};\n");
    expect(log).toContain('  added onError to goal.config.js');
    expect(log).not.toContain('"type": "module"');
  });

  it("picks the recipe for the version the app has, or the one asked for", async () => {
    const dir = app({ 'package.json': { type: 'commonjs', devDependencies: { 'tool-core': '~1.4.0' } } });
    const { log, ran } = await run(dir, 'tool');
    expect(log).toContain('tool: the recipe for tool-core 1 (the app has ~1.4.0)');
    expect(log).toContain('set "type": "module" in package.json');
    expect(ran).toEqual([]);
    expect(JSON.parse(read(dir, 'package.json')).scripts).toBe(undefined);
    const other = await run(app({ 'package.json': { type: 'module', dependencies: { 'tool-core': 'latest' } } }), 'tool@1');
    expect(other.log).toContain('tool: the recipe for tool-core 1\n');
    expect((await run(app({ 'package.json': { type: 'module', dependencies: { 'tool-core': 'github:x/y' } } }), 'tool')).log).toContain('the recipe for tool-core 2\n'); // no version to go by
  });

  it("adds what goal.config.js lacks, and says what to add when it can't", async () => {
    const top = app({ 'goal.config.js': 'export default { onError: report };\n' });
    expect((await run(top, 'tool')).log).toContain('  added level to goal.config.js');
    expect(read(top, 'goal.config.js')).toBe("import { onError } from './lib/tool.js';\nexport default {\n  level: 'all', onError: report };\n");
    const has = app({ 'goal.config.js': "import { onError } from './lib/tool.js';\nexport default { onError, level: 1 };\n" });
    expect((await run(has, 'tool')).log).toContain('  kept goal.config.js: it has onError, level already');
    const imported = app({ 'goal.config.js': "import { onError } from './lib/tool.js';\nexport default { level: 1 };\n" });
    await run(imported, 'tool');
    expect(read(imported, 'goal.config.js')).toBe("import { onError } from './lib/tool.js';\nexport default {\n  onError, level: 1 };\n"); // the import once
    const hint = "  goal.config.js: add this to it yourself (its default export isn't an object to add to):\n    import { onError } from './lib/tool.js';\n    onError, level: 'all'";
    expect((await run(app({ 'goal.config.js': 'const c = {};\nexport default c;\n' }), 'tool')).log).toContain(hint);
    expect((await run(app({ 'goal.config.js': 'export default {' }), 'tool')).log).toContain(hint);
  });

  it("runs the recipe's commands in the app's folder, and adds lines to a file that doesn't end in one", async () => {
    const dir = app({ '.gitignore': 'node_modules' });
    await add(dir, 'echo', { log: () => {}, dir: RECIPES });
    expect(read(dir, 'ran.txt')).toBe('here');
    expect(read(dir, '.gitignore')).toBe('node_modules\ndist\n');
  });

  it('runs from the command line', async () => {
    expect(args(['add', 'tool', 'my-app'])).toEqual({ cmd: 'add', app: 'my-app', port: 3000, tool: 'tool' });
    expect(args(['add'])).toEqual({ cmd: 'add', app: '.', port: 3000, tool: undefined });
    const log = [];
    expect(await main(['add', 'tool@1', app()], (m) => log.push(m), { dir: RECIPES, run: () => {} })).toBe(0);
    expect(log[0]).toBe('tool: the recipe for tool-core 1');
    expect(await main(['add', 'tool@9', app()], (m) => log.push(m), { dir: RECIPES })).toBe(1);
    expect(log.at(-1)).toContain('goal add has no recipe for tool-core 9');
    expect(existsSync(join(RECIPES, 'tool.js'))).toBe(true);
  });
});
