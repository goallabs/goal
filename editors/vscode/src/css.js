// A .goal file's style block (docs/components.md, Styles): where its CSS is, and the file with only
// that CSS left in it, which VS Code's own CSS support answers for (see extension.js).

/** Where a style block's CSS, from `i`, ends: its closing brace, past nested blocks, strings and comments, as goal.js's syntax.js reads it. -1 if it doesn't. */
function cssEnd(s, i) {
  for (let depth = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '*') {
      i = s.indexOf('*/', i + 2) + 1;
      if (!i) return -1;
    } else if (c === '"' || c === "'") {
      while (++i < s.length && s[i] !== c) if (s[i] === '\\') i++;
    } else if (c === '{') depth++;
    else if (c === '}' && !depth--) return i;
  }
  return -1;
}

/**
 * The file's style block, as offsets: where its CSS starts and ends, or null. It's `style {` at the
 * start of a line, as the grammar highlights it; one that doesn't close yet goes to the end of the file.
 */
function styleBlock(text) {
  const m = /^[ \t]*style[ \t]*\{/m.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = cssEnd(text, start);
  return { start, end: end < 0 ? text.length : end };
}

/** The file with everything but its style block's CSS blanked out: the same length, lines and columns, so a place in one is the same place in the other. */
function cssOnly(text, { start, end }) {
  const blank = (s) => s.replace(/[^\r\n]/g, ' ');
  return blank(text.slice(0, start)) + text.slice(start, end) + blank(text.slice(end));
}

module.exports = { styleBlock, cssOnly };
