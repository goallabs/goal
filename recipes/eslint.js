// goal add eslint: ESLint for the app's .js and .goal files. goaljs/eslint (src/eslint.js) lets it
// read .goal files and reports each problem where it is in the file.

export default {
  name: 'eslint',
  package: 'eslint',
  about: 'ESLint for .js and .goal files',
  docs: 'https://eslint.org/docs/latest/',
  versions: [
    {
      range: '10',
      devDependencies: { eslint: '10.15.0', '@eslint/js': '10.0.1', globals: '17.14.0' },
      files: {
        'eslint.config.js': `import js from '@eslint/js';
import globals from 'globals';
import goal from 'goaljs/eslint';

export default [
  { ignores: ['dist/'] },
  js.configs.recommended,
  ...goal.configs.recommended,
  { languageOptions: { globals: globals.node } },
  { files: ['**/*.goal/*.jsx'], languageOptions: { globals: globals.browser } }, // event handlers run in the page
];
`,
      },
      scripts: { lint: 'eslint .' },
      next: ['npm run lint checks the .js and .goal files; add rules to eslint.config.js', 'Your editor\'s ESLint extension shows the problems in .goal files too once it lints them (VS Code: "eslint.validate": ["javascript", "goal"])'],
      test: {
        files: { 'Unused.goal': "import { Counter } from './Counter.goal';\nexport function Unused() {\n  const x = 1;\n  return <Counter start={1} />;\n}\n" },
        run: [
          `node -e "const { execSync } = require('child_process'); let out = ''; try { execSync('npx eslint .', { encoding: 'utf8' }); } catch (e) { out = e.stdout; } process.exit(/Unused\\.goal\\s+3:9\\s+error\\s+'x' is assigned a value but never used/.test(out) ? 0 : 1)"`,
          'npx eslint --ignore-pattern Unused.goal .',
        ],
      },
    },
  ],
};
