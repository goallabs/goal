// Every .goal file in the repository's example apps.

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples');

const goals = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? (['dist', 'node_modules'].includes(d.name) ? [] : goals(join(dir, d.name))) : d.name.endsWith('.goal') ? [join(dir, d.name)] : [],
  );

export const EXAMPLES = goals(EXAMPLES_DIR);
