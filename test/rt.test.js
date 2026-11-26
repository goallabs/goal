import { describe, it, expect } from 'vitest';
import { _$e, _$m, _$h, _$a, _$u, Html } from '../src/rt.js';
import { _$pa, _$ctx, _$f } from '../src/render.js';

describe('rt helpers', () => {
  it('escapes text and attributes', () => {
    expect(_$e(`<a href="x">Tom & 'Jerry'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;');
    expect(_$e(42)).toBe('42');
  });

  it('renders children: markup raw, lists joined, nothing for null and booleans, the rest escaped', () => {
    expect(_$m('<b>x</b>')).toBeInstanceOf(Html);
    expect(_$h(_$m('<b>x</b>'))).toBe('<b>x</b>');
    expect(String(_$m('<i></i>'))).toBe('<i></i>');
    expect(_$h(['a<', _$m('<br>'), 3, null, [false, 'z']])).toBe('a&lt;<br>3z');
    expect([_$h(null), _$h(undefined), _$h(true), _$h(false), _$h(0)]).toEqual(['', '', '', '', '0']);
  });

  it('lets through relative and http(s)/mailto/tel URLs only', () => {
    for (const ok of ['/a', 'b?c=1', '#top', 'https://x.org', 'HTTP://x', 'mailto:a@b.c', 'tel:+1', '//cdn.x/a.png', ''])
      expect(_$u(ok)).toBe(ok);
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:x', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd'])
      expect(_$u(bad)).toBe('about:invalid#blocked');
    expect([_$u(null), _$u(undefined), _$u(true), _$u(false)]).toEqual([null, undefined, true, false]);
  });

  it('renders attributes, checking URLs', () => {
    expect(_$a('title', 'a"b')).toBe(' title="a&quot;b"');
    expect(_$a('disabled', true)).toBe(' disabled');
    expect(_$a('disabled', false)).toBe('');
    expect(_$a('title', null)).toBe('');
    expect(_$a('tabindex', 0)).toBe(' tabindex="0"');
    expect(_$a('href', 'javascript:alert(1)')).toBe(' href="about:invalid#blocked"');
    expect(_$a('href', '/ok')).toBe(' href="/ok"');
    expect(_$a('href', null)).toBe('');
  });

  it('writes only the props asked for', () => {
    expect(_$pa({ a: 1, secret: 's' }, [])).toBe('');
    expect(_$pa({ a: 1, secret: 's' }, ['a', 'missing'])).toBe(' m-p="{&quot;a&quot;:1}"');
  });

  it('numbers instances, collects events and holds the token', () => {
    const c = _$ctx();
    expect(c.i++).toBe(0);
    expect(c.t).toBe('');
    c.e(['click', 'input']);
    c.e(['click']);
    expect([...c.ev]).toEqual(['click', 'input']);
    expect(_$ctx('tok').t).toBe('tok');
  });
});

describe('function props', () => {
  it('do nothing where they are made, and go to the page as the handler and instance they name', () => {
    expect(_$f(1, 2)()).toBe(undefined);
    expect(JSON.stringify({ onpick: _$f(1, 2) })).toBe('{"onpick":{"$h":1,"$i":2}}');
  });
});
