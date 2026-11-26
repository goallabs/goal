// goal add postcss: PostCSS, which goal build and goal dev run the stylesheets in public/ through
// (see src/css.js), with autoprefixer to start with.

export default {
  name: 'postcss',
  aliases: ['autoprefixer'],
  package: 'postcss',
  about: 'PostCSS: the stylesheets in public/ through plugins, autoprefixer first',
  docs: 'https://postcss.org',
  versions: [
    {
      range: '8',
      devDependencies: { postcss: '8.5.33', autoprefixer: '10.7.0' },
      files: {
        'postcss.config.js': `export default {
  plugins: {
    autoprefixer: {},
  },
};
`,
      },
      lines: { '.gitignore': ['node_modules', 'dist'] },
      next: [
        'goal dev and goal build run every stylesheet in public/ through the plugins in postcss.config.js',
        'Add a plugin: npm install --save-dev <plugin>, then name it in postcss.config.js',
      ],
      test: {
        run: ['npx goal build .', `node -e "process.exit(require('fs').readFileSync('dist/public/style.css', 'utf8').includes('-webkit-user-select') ? 0 : 1)"`],
      },
    },
  ],
};
