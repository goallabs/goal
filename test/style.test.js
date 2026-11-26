import { describe, it, expect } from 'vitest';
import { scopeName, scopeCss } from '../src/style.js';

const scoped = (css) => scopeCss(css, 'g-abc123', (i, m) => {
  throw new Error(`${i}: ${m}`);
});
const error = (css) => {
  try {
    scoped(css);
  } catch (e) {
    return e.message;
  }
  throw new Error('expected an error');
};
const W = ':where([g-abc123])';

describe('scope names', () => {
  it('are g- and six letters and digits, the same for a file each time, and differ between files', () => {
    expect(scopeName('components/Counter.goal')).toMatch(/^g-[0-9a-z]{6}$/);
    expect(scopeName('components/Counter.goal')).toBe(scopeName('components/Counter.goal'));
    expect(scopeName('app.goal')).not.toBe(scopeName('apps.goal'));
    expect(scopeName('')).toMatch(/^g-[0-9a-z]{6}$/);
  });
});

describe('scoped CSS', () => {
  it("puts the scope on each selector's last part, keeping the rest as written", () => {
    expect(scoped('.card { border: 1px solid #ccc; }')).toBe(`.card${W} { border: 1px solid #ccc; }`);
    expect(scoped(' .card p , strong>em,a + b ~ c{x:y}')).toBe(` .card p${W} , strong>em${W},a + b ~ c${W}{x:y}`);
    expect(scoped('ul li:nth-child(2n+1), input[type="a b" i]:focus { x: y }')).toBe(`ul li:nth-child(2n+1)${W}, input[type="a b" i]:focus${W} { x: y }`);
    expect(scoped(':is(.a, .b) .c, [title="x,y \\" z"] {}')).toBe(`:is(.a, .b) .c${W}, [title="x,y \\" z"]${W} {}`);
    expect(scoped('.md\\:flex .a\\+b {}')).toBe(`.md\\:flex .a\\+b${W} {}`); // escaped characters, as Tailwind's classes have
    expect(scoped('{ x: y }')).toBe(`${W}{ x: y }`);
  });

  it('puts it before a pseudo-element, in either spelling', () => {
    expect(scoped('p::before, p:after, p:first-line, p:FIRST-LETTER, a:hover::after, b:before-x {}')).toBe(
      `p${W}::before, p${W}:after, p${W}:first-line, p${W}:FIRST-LETTER, a:hover${W}::after, b:before-x${W} {}`,
    );
  });

  it('scopes rules inside @media, @supports, @layer and nested rules, and keeps @keyframes and @font-face as written', () => {
    expect(scoped('@MEDIA (min-width: 40rem) { .a { padding: 0; & b { c: d } } }')).toBe(`@MEDIA (min-width: 40rem) { .a${W} { padding: 0; & b${W} { c: d } } }`);
    expect(scoped('@layer base { p { m: 0 } } @layer a, b;')).toBe(`@layer base { p${W} { m: 0 } } @layer a, b;`);
    expect(scoped('@keyframes spin { from { r: 0 } to { r: "}" } }')).toBe('@keyframes spin { from { r: 0 } to { r: "}" } }');
    expect(scoped('@font-face { font-family: X; /* } */ src: url(x.woff2) }')).toBe('@font-face { font-family: X; /* } */ src: url(x.woff2) }');
  });

  it('reads past strings, comments and brackets', () => {
    expect(scoped('/* .x { */ .a { content: "}{;"; b: url(data:image/png;base64,AA) }')).toBe(`/* .x { */ .a${W} { content: "}{;"; b: url(data:image/png;base64,AA) }`);
    expect(scoped("a { content: 'it\\'s' }")).toBe(`a${W} { content: 'it\\'s' }`);
  });

  it("says where it can't read the CSS", () => {
    expect(error('.a { color: red')).toBe('3: this { has no closing }');
    expect(error('@keyframes x { from { a: b }')).toBe('13: this { has no closing }');
    expect(error('.a { } }')).toBe('7: this } closes nothing');
    expect(error('.a { content: "x }')).toBe('14: this string has no end');
    expect(error(".a { content: 'x\n' }")).toBe('14: this string has no end');
    expect(error('.a {} /* x')).toBe('6: this comment has no end: */');
    expect(error('  @import "x.css";')).toBe('2: @import goes in a stylesheet under public/, linked from the page');
  });
});
