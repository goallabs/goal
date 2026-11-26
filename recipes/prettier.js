// goal add prettier: Prettier for the app's .js, .css, .json and .md files. It leaves .goal files
// alone: it doesn't know their routes and {if}.

export default {
  name: 'prettier',
  package: 'prettier',
  about: 'Prettier: formats .js, .css, .json and .md files',
  docs: 'https://prettier.io/docs/',
  versions: [
    {
      range: '3',
      devDependencies: { prettier: '3.10.1' },
      files: { '.prettierrc.json': '{}\n', '.prettierignore': 'dist\n' },
      scripts: { format: 'prettier --write .', 'format:check': 'prettier --check .' },
      next: ['npm run format formats the .js, .css, .json and .md files; .goal files are left as they are', 'Set options, like "singleQuote": true, in .prettierrc.json'],
      test: { run: ['npx prettier --write .', 'npx prettier --check .'] },
    },
  ],
};
