// What every recipe in recipes/ must be. A pull request that adds or changes one runs this with
// npm test, and npm run test:recipes to set it up for real (see recipes/README.md).

import { describe, it, expect } from 'vitest';
import { recipes, satisfies } from '../src/add.js';

const all = await recipes();
const KEYS = ['name', 'aliases', 'package', 'about', 'docs', 'versions'];
const ENTRY = ['range', 'dependencies', 'devDependencies', 'files', 'prepend', 'lines', 'scripts', 'config', 'run', 'next', 'test'];
const strings = (x) => Array.isArray(x) && x.every((s) => typeof s === 'string' && s.length > 0);
const later = (a, b) => satisfies(a, `>${b}`);

describe('the recipes', () => {
  it('have names, and aliases, that are theirs alone', () => {
    const names = all.flatMap((r) => [r.name, ...(r.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
  });

  describe.each(all.map((r) => [r.name, r]))('%s', (_, r) => {
    it('says what it is: a name, the package whose version picks the entry, what it sets up, the docs', () => {
      expect(Object.keys(r).filter((k) => !KEYS.includes(k))).toEqual([]);
      expect(r.name).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
      expect(strings(r.aliases ?? ['x'])).toBe(true);
      expect(r.package).toMatch(/^(@[a-z0-9.-]+\/)?[a-z0-9.-]+$/);
      expect(typeof r.about).toBe('string');
      expect(r.docs).toMatch(/^https:\/\//);
      expect(r.versions.length).toBeGreaterThan(0);
    });

    it.each(r.versions.map((e) => [e.range, e]))('%s: pins the versions it was tested with, and has a test', (_, e) => {
      expect(Object.keys(e).filter((k) => !ENTRY.includes(k))).toEqual([]);
      expect(typeof e.range).toBe('string');
      const pins = { ...e.dependencies, ...e.devDependencies };
      for (const v of Object.values(pins)) expect(v).toMatch(/^\d+\.\d+\.\d+$/); // exact: what npm installs is what was tested
      expect(satisfies(pins[r.package], e.range)).toBe(true); // the package itself, in the entry's range
      for (const [f, text] of Object.entries(e.files ?? {})) {
        expect(f).toMatch(/^(?!\/)(?!.*\.\.)[\w./@-]+$/); // in the app's folder
        expect(typeof text).toBe('string');
      }
      for (const ops of [e.prepend, e.lines]) for (const want of Object.values(ops ?? {})) expect(strings(want)).toBe(true);
      for (const v of Object.values(e.scripts ?? {})) expect(typeof v).toBe('string');
      if (e.config) {
        expect(e.config.import).toMatch(/^import .* from '.+';$/);
        expect(Object.values(e.config.keys).every((v) => typeof v === 'string')).toBe(true);
      }
      for (const list of [e.run ?? ['x'], e.next ?? ['x']]) expect(strings(list)).toBe(true);
      expect(strings(e.test.run)).toBe(true); // npm run test:recipes runs it after goal add
      for (const text of Object.values(e.test.files ?? {})) expect(typeof text).toBe('string');
    });

    it('lists its entries newest first', () => {
      const pins = r.versions.map((e) => ({ ...e.dependencies, ...e.devDependencies })[r.package]);
      for (let i = 1; i < pins.length; i++) expect(later(pins[i - 1], pins[i])).toBe(true);
    });
  });
});
