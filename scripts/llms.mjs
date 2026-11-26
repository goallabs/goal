// node scripts/llms.mjs: writes docs/llms-full.txt, every page of the docs in one Markdown file, for
// AI assistants (see llmstxt.org; docs/llms.txt is the short index, written by hand). The pages go
// in the site's order, without their front matter, and with links to other pages made absolute.
// test/llms.test.js fails when the file is out of date with the docs.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SITE = 'https://goallabs.github.io/goal';
const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');

/** The docs pages, in the site's order: { name, title, body } with the front matter taken off. */
export function pages(dir = DOCS) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const text = readFileSync(join(dir, f), 'utf8');
      const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
      const field = (k) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(front)?.[1];
      return { name: f.slice(0, -3), title: field('title'), order: Number(field('nav_order')), body };
    })
    .sort((a, b) => a.order - b.order);
}

/** docs/llms-full.txt's text. */
export function llmsFull(dir = DOCS) {
  const all = pages(dir);
  const names = new Set(all.map((p) => p.name));
  const page = ({ body }) =>
    body
      .replace(/^<img [^>]*>\n+/gm, '') // the logo
      .replace(/\]\(([a-z-]+)(#[\w-]+)?\)/g, (m, name, anchor = '') => (names.has(name) ? `](${SITE}/${name}${anchor})` : m)) // [Security](security#errors), not code
      .trim();
  return `${['# goal.js: all the docs', `> Every page of ${SITE}, in one file. The short index is ${SITE}/llms.txt.`, ...all.map(page)].join('\n\n')}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(join(DOCS, 'llms-full.txt'), llmsFull());
  console.log('wrote docs/llms-full.txt');
}
