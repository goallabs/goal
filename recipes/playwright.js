// goal add playwright: Playwright browser tests against the app as goal build and goal start serve it,
// with its security headers and Content-Security-Policy.

export default {
  name: 'playwright',
  aliases: ['@playwright/test'],
  package: '@playwright/test',
  about: 'Playwright: browser tests against the built app',
  docs: 'https://playwright.dev/docs/intro',
  versions: [
    {
      range: '1',
      devDependencies: { '@playwright/test': '1.65.1' },
      files: {
        'playwright.config.js': `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: 'http://localhost:4173' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // The app as production serves it
  webServer: {
    command: 'npx goal build . && npx goal start . --port 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
});
`,
        'e2e/home.spec.js': `import { test, expect } from '@playwright/test';

test('the home page loads with no errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text())); // a blocked inline script shows here
  const res = await page.goto('/');
  expect(res.status()).toBeLessThan(400);
  expect(errors).toEqual([]);
});
`,
      },
      lines: { '.gitignore': ['node_modules', 'dist', 'test-results', 'playwright-report'] },
      scripts: { 'test:e2e': 'playwright test' },
      run: ['npx playwright install chromium'],
      next: ['npm run test:e2e builds the app, starts it on port 4173 and runs the tests in e2e/ in Chromium', 'More browsers: add projects to playwright.config.js and npx playwright install'],
      test: { run: ['npx playwright test --reporter=line'] },
    },
  ],
};
