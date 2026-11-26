// goal add vitest: Vitest, with goal.js's Vite plugin, so tests import components and server
// functions from .goal files as server code does.

export default {
  name: 'vitest',
  package: 'vitest',
  about: 'Vitest: tests that import .goal files',
  docs: 'https://vitest.dev/guide/',
  versions: [
    {
      range: '5',
      devDependencies: { vitest: '5.1.2' },
      files: {
        'vitest.config.js': `import { defineConfig } from 'vitest/config';
import { goal } from 'goaljs/vite';

export default defineConfig({
  plugins: [goal()], // tests import .goal files
  test: { include: ['**/*.test.js'], exclude: ['node_modules/**', 'dist/**'] },
});
`,
      },
      scripts: { test: 'vitest' },
      next: [
        "Write tests as *.test.js. They import from .goal files: import { Counter } from './Counter.goal'",
        'A component renders to HTML: expect(String(Counter({ start: 1 }))).toContain(\'1\'); a server function is a plain async function',
        'npm test runs them and watches; npx vitest run runs them once',
      ],
      test: {
        files: {
          'tests/counter.test.js': `import { test, expect } from 'vitest';
import { Counter } from '../Counter.goal';

test('Counter renders its start', () => {
  expect(String(Counter({ start: 41 }))).toContain('41');
});
`,
        },
        run: ['npx vitest run'],
      },
    },
  ],
};
