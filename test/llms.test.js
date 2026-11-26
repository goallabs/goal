import { describe, it, expect } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { llmsFull, pages, SITE } from '../scripts/llms.mjs';
import { TMP } from './helpers.js';

const DOCS = join(import.meta.dirname, '../docs');

describe('llms.txt', () => {
  it('links every page of the docs, and only pages there are', () => {
    const index = readFileSync(join(DOCS, 'llms.txt'), 'utf8');
    const linked = [...index.matchAll(new RegExp(`\\]\\(${SITE}/([a-z-]+)\\)`, 'g'))].map((m) => m[1]);
    const names = pages().map((p) => p.name);
    expect(linked.filter((n) => n !== 'llms-full').sort()).toEqual(names.filter((n) => n !== 'index').sort());
    expect(index).toMatch(/^# goal\.js\n\n> /); // the title, then the summary, as llmstxt.org has them
  });

  it('has an llms-full.txt up to date with the docs: npm run docs:llms writes it', () => {
    expect(readFileSync(join(DOCS, 'llms-full.txt'), 'utf8')).toBe(llmsFull());
  });

  it('puts the pages in order, without front matter or the logo, with links to pages made absolute', () => {
    const dir = join(TMP, `llms${process.pid}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'b.md'), '---\ntitle: B\nnav_order: 2\n---\n\n# B\n\nSee [A](a#x), [out](https://x.org), [top](#y) and `f[i](e)`.\n');
    writeFileSync(join(dir, 'a.md'), '---\ntitle: A\nnav_order: 1\n---\n\n<img src="x.svg" alt="">\n\n# A\n');
    writeFileSync(join(dir, 'notes.txt'), 'not a page');
    expect(llmsFull(dir)).toBe(
      `# goal.js: all the docs\n\n> Every page of ${SITE}, in one file. The short index is ${SITE}/llms.txt.\n\n# A\n\n# B\n\nSee [A](${SITE}/a#x), [out](https://x.org), [top](#y) and \`f[i](e)\`.\n`,
    );
  });
});
