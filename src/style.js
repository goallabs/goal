// Scoped CSS. A .goal file's style block styles only the markup the file renders: each element the
// file renders carries its scope attribute (g-abc123, see compile), and each selector in the block
// gets it on its last part, the element it styles: `.card p` becomes `.card p:where([g-abc123])`.
// :where() weighs nothing, so a selector keeps the specificity it has as written. Markup given to a
// component as children is the file's that writes it, and so are its styles.

/** A file's scope attribute: g- and six letters and digits, from its path, the same in each build. */
export function scopeName(file) {
  let h = 2166136261; // FNV-1a
  for (const c of file) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return 'g-' + (h >>> 0).toString(36).padStart(7, '0').slice(-6);
}

// At-rules whose blocks hold rules, which are scoped too. The others (@keyframes, @font-face, @page
// and the rest) are kept as written.
const NESTED = new Set(['media', 'supports', 'container', 'layer', 'scope', 'starting-style']);

/**
 * The CSS with each selector scoped to the attribute `attr`. `fail(offset, message)` reports what
 * can't be read: a block, string or comment that doesn't end, or a } that closes nothing.
 */
export function scopeCss(css, attr, fail) {
  const where = `:where([${attr}])`;
  let i = 0;
  // Past the comment or string at j, if there is one there.
  const skip = (j) => {
    if (css.startsWith('/*', j)) {
      const e = css.indexOf('*/', j + 2);
      if (e < 0) fail(j, 'this comment has no end: */');
      return e + 2;
    }
    const q = css[j];
    if (q !== '"' && q !== "'") return j;
    for (let k = j + 1; k < css.length && css[k] !== '\n'; k++) {
      if (css[k] === '\\') k++;
      else if (css[k] === q) return k + 1;
    }
    fail(j, 'this string has no end');
  };
  // From i up to the first { ; or } outside brackets, strings and comments.
  const prelude = () => {
    const from = i;
    for (let depth = 0; i < css.length; ) {
      const j = skip(i);
      if (j !== i) {
        i = j;
        continue;
      }
      const c = css[i];
      if (!depth && (c === '{' || c === ';' || c === '}')) break;
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      i++;
    }
    return css.slice(from, i);
  };
  // A block's contents as written, up to its }.
  const raw = (open) => {
    const from = i;
    for (let depth = 0; i < css.length; ) {
      const j = skip(i);
      if (j !== i) {
        i = j;
        continue;
      }
      if (css[i] === '}' && !depth--) return css.slice(from, i);
      if (css[i] === '{') depth++;
      i++;
    }
    fail(open, 'this { has no closing }');
  };
  // Rules, at-rules and declarations, up to the } of the block that opened at `open` (-1: the top).
  const block = (open) => {
    let out = '';
    for (;;) {
      const p = prelude();
      const c = css[i];
      if (c === undefined) {
        if (open >= 0) fail(open, 'this { has no closing }');
        return out + p;
      }
      if (c === '}') {
        if (open < 0) fail(i, 'this } closes nothing');
        return out + p;
      }
      const name = /^\s*@([\w-]+)/.exec(p)?.[1].toLowerCase();
      if (name === 'import') fail(i - p.trimStart().length, '@import goes in a stylesheet under public/, linked from the page');
      if (c === ';') {
        out += p + ';';
        i++;
        continue;
      }
      const at = i++;
      out += (name === undefined ? selectors(p) : p) + '{' + (name === undefined || NESTED.has(name) ? block(at) : raw(at)) + '}';
      i++; // past the }
    }
  };
  const selectors = (p) => split(p).map(scope).join(',');
  // One selector, with the attribute on its last part, before a pseudo-element (p::before).
  const scope = (sel) => {
    const s = sel.trim();
    const [start] = parts(s);
    const end = sel.length - sel.trimStart().length + start + pseudoElement(s.slice(start));
    return sel.slice(0, end) + where + sel.slice(end);
  };
  return block(-1);
}

/**
 * Walks a selector outside brackets and strings: `visit(char, index)` for each such character. Gives
 * where its last compound selector starts: after the last combinator (a space, >, + or ~).
 */
function parts(s, visit = () => {}) {
  let start = 0;
  let depth = 0;
  let q = '';
  let comb = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (q) {
      if (c === '\\') k++;
      else if (c === q) q = '';
      continue;
    }
    if (!depth && /[\s>+~]/.test(c)) {
      comb = true;
      continue;
    }
    if (comb) (start = k), (comb = false);
    if (!depth && visit(c, k)) return [start, k];
    if (c === '"' || c === "'") q = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '\\') k++;
  }
  return [start, -1];
}

/** Where a compound selector's pseudo-element starts (::before, or :before as CSS 2 wrote it); its end if it has none. */
function pseudoElement(c) {
  const [, k] = parts(c, (ch, j) => ch === ':' && (c[j + 1] === ':' || /^:(before|after|first-line|first-letter)(?![\w-])/i.test(c.slice(j))));
  return k < 0 ? c.length : k;
}

/** A selector list's selectors: split at its commas, outside brackets and strings. */
function split(p) {
  const out = [];
  let from = 0;
  parts(p, (c, k) => {
    if (c === ',') (out.push(p.slice(from, k)), (from = k + 1));
  });
  return [...out, p.slice(from)];
}
