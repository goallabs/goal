import { describe, it, expect } from 'vitest';
import { render, page, loaderScript, hmrScript } from '../src/server.js';
import { _$ctx } from '../src/render.js';

describe('server', () => {
  it('renders a component with default props and a fresh context', () => {
    expect(render((p, c) => `<p>${c.i}${JSON.stringify(p)}</p>`)).toEqual({ html: '<p>0{}</p>', events: [] });
    const ctx = _$ctx('t');
    ctx.i = 5;
    expect(render((p, c) => `${c.i}${c.t}`, {}, ctx).html).toBe('5t');
  });

  it('wraps markup in a plain document, with no script when nothing is interactive', () => {
    expect(page('<p>hi</p>', [], 'n')).toBe(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>goal.js</title></head><body><p>hi</p></body></html>',
    );
  });

  it("links the app's stylesheet at the end of the head, after the page's own", () => {
    const css = '/c/_/style.css?v=a&b';
    const link = '<link rel="stylesheet" href="/c/_/style.css?v=a&amp;b">';
    expect(page('<html><head><link rel="stylesheet" href="/style.css"></head><body>x</body></html>', [], 'n', '', false, css)).toBe(
      `<!doctype html><html><head><link rel="stylesheet" href="/style.css">${link}</head><body>x</body></html>`,
    );
    expect(page('<html lang="en"><body>x</body></html>', [], 'n', '', false, css)).toBe(`<!doctype html><html lang="en">${link}<body>x</body></html>`);
    expect(page('<p>x</p>', [], 'n', '', false, css)).toContain(`<title>goal.js</title>${link}</head>`);
    expect(page('<p>x</p>', [], 'n')).not.toContain('<link');
  });

  it('uses a document the route wrote, and puts the loader before </body> with the nonce', () => {
    const script = `<meta name="goal-csrf" content=""><script type="module" nonce="abc">${loaderScript().replace('"__GOAL_EVENTS__"', '["click"]')}</script>`;
    expect(page('<html><body><p>x</p></body></html>', ['click'], 'abc')).toBe(`<!doctype html><html><body><p>x</p>${script}</body></html>`);
    expect(page('<html lang="en"><p>x</p></html>', ['click'], 'abc')).toBe(`<!doctype html><html lang="en"><p>x</p></html>${script}`);
    expect(page('<htmlx>', [], 'abc')).toContain('<body><htmlx></body>');
    expect(page('<p></p>', ['click'], 'n', 'a"b')).toContain('<meta name="goal-csrf" content="a&quot;b"><script');
    expect(page('<p></p>', ['click'], 'n', 't', false, null, '/a"b')).toContain('<meta name="goal-csrf" content="t"><meta name="goal-base" content="/a&quot;b"><script');
    expect(loaderScript()).toBe(loaderScript());
    expect(loaderScript()).toMatch(/^\(\(\)=>\{.*\(document,"__GOAL_EVENTS__"\);\}\)\(\);$/s);
  });

  it('adds the live updates to every page in goal dev, with the events the page listens for', () => {
    const live = (events) => `<meta name="goal-events" content="${events}"><script type="module" nonce="n">${hmrScript()}</script>`;
    expect(page('<p>x</p>', ['click'], 'n', '', true)).toContain(`</script>${live('[&quot;click&quot;]')}</body>`);
    expect(page('<p>x</p>', [], 'n', '', true)).toContain(`<body><p>x</p>${live('[]')}</body>`);
    expect(hmrScript()).toBe(hmrScript());
    expect(hmrScript()).toMatch(/^\(\(\)=>\{.*\(document,window\);\}\)\(\);$/s);
  });
});
