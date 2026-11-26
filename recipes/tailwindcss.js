// goal add tailwindcss: Tailwind CSS, compiled by goal build and goal dev through PostCSS (see
// src/css.js), with the classes the app's .goal files use.

const ignore = { '.gitignore': ['node_modules', 'dist'] };
const link = 'Link the stylesheet from your pages: <link rel="stylesheet" href="/style.css" />';
const check = (file) => `node -e "process.exit(require('fs').readFileSync('${file}', 'utf8').includes('.text-3xl') ? 0 : 1)"`;

export default {
  name: 'tailwindcss',
  aliases: ['tailwind'],
  package: 'tailwindcss',
  about: 'Tailwind CSS: utility classes, compiled into public/style.css',
  docs: 'https://tailwindcss.com/docs',
  versions: [
    {
      range: '4',
      devDependencies: { tailwindcss: '4.3.5', '@tailwindcss/postcss': '4.3.5', postcss: '8.5.33' },
      files: {
        'postcss.config.js': `export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
`,
      },
      // source(".."): the classes are looked for in the app's folder, wherever goal runs from
      prepend: { 'public/style.css': ['@import "tailwindcss" source("..");'] },
      lines: ignore,
      next: [link, 'Use its classes in markup, like <h1 class="text-3xl font-bold">: goal dev and goal build put the ones your .goal files use in /style.css'],
      test: { run: ['npx goal build .', check('dist/public/style.css')] },
    },
    {
      range: '3',
      devDependencies: { tailwindcss: '3.4.19', postcss: '8.5.33', autoprefixer: '10.7.0' },
      files: {
        'tailwind.config.js': `/** @type {import('tailwindcss').Config} */
export default {
  // The app's .goal files, from this file's folder
  content: { relative: true, files: ['./**/*.goal', '!./node_modules/**', '!./dist/**'] },
  theme: { extend: {} },
  plugins: [],
};
`,
        'postcss.config.js': `import { fileURLToPath } from 'node:url';

export default {
  plugins: {
    tailwindcss: { config: fileURLToPath(new URL('./tailwind.config.js', import.meta.url)) },
    autoprefixer: {},
  },
};
`,
      },
      prepend: { 'public/style.css': ['@tailwind base;', '@tailwind components;', '@tailwind utilities;'] },
      lines: ignore,
      next: [link, 'Use its classes in markup, like <h1 class="text-3xl font-bold">: goal dev and goal build put the ones your .goal files use in /style.css'],
      test: { run: ['npx goal build .', check('dist/public/style.css')] },
    },
  ],
};
