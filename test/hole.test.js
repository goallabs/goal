// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { _$hm, into } from '../src/rt.js';

describe('hole patching', () => {
  // A hole between its markers, as the server renders it, with a node after it that must stay.
  function hole(html) {
    const d = document.implementation.createHTMLDocument('t');
    d.body.innerHTML = `<div><!--0.1-->${html}<!--/--><p id="after">after</p></div>`;
    const c = d.body.firstChild.firstChild;
    return { d, c, patch: (next) => _$hm(d, c, next), inner: () => d.body.firstChild.innerHTML };
  }

  it('keeps the nodes that stay the same kind, so a focused input keeps its focus and what was typed', () => {
    const { d, c, patch, inner } = hole('<label>Name <input id="n"></label><b>1</b>');
    const input = d.getElementById('n');
    input.focus();
    input.value = 'typed';
    patch('<label>Name <input id="n" class="wide"></label><b>2</b>');
    expect(d.getElementById('n')).toBe(input);
    expect(d.activeElement).toBe(input);
    expect(input.value).toBe('typed');
    expect(inner()).toBe('<!--0.1--><label>Name <input id="n" class="wide"></label><b>2</b><!--/--><p id="after">after</p>');
    expect(c.nextSibling.nodeName).toBe('LABEL');
  });

  it('replaces nodes of another kind, adds new ones and removes the rest', () => {
    const { patch, inner } = hole('<b>a</b><i>b</i>text<span>c</span>');
    patch('<i>x</i><i>b</i>more<em>d</em><em>e</em>');
    expect(inner()).toBe('<!--0.1--><i>x</i><i>b</i>more<em>d</em><em>e</em><!--/--><p id="after">after</p>');
    patch('');
    expect(inner()).toBe('<!--0.1--><!--/--><p id="after">after</p>');
    patch('<b>back</b>');
    expect(inner()).toBe('<!--0.1--><b>back</b><!--/--><p id="after">after</p>');
  });

  it('removes attributes that went away, and makes value and checked follow their attributes', () => {
    const { d, patch } = hole('<input id="v" value="a" title="t"><input id="c" type="checkbox">');
    const v = d.getElementById('v');
    const box = d.getElementById('c');
    patch('<input id="v" value="b"><input id="c" type="checkbox" checked>');
    expect([v.value, v.hasAttribute('title'), box.checked]).toEqual(['b', false, true]);
    patch('<input id="v"><input id="c" type="checkbox">');
    expect([v.value, box.checked]).toEqual(['', false]);
  });
});

describe('keyed rows in a hole', () => {
  it('finds each row by its key and moves it, keeping its nodes', () => {
    const d = document.implementation.createHTMLDocument('t');
    d.body.innerHTML = '<div><!--0.0--><ul><li m-k="1">a</li><li m-k="2">b</li><li m-k="3">c</li></ul><!--/--></div>';
    const [one, two, three] = d.querySelectorAll('li');
    const c = d.body.firstChild.firstChild;
    _$hm(d, c, '<ul><li m-k="3">c</li><li m-k="1">a!</li><li m-k="4">d</li><li>plain</li></ul>');
    const lis = [...d.querySelectorAll('li')];
    expect(lis.map((l) => l.textContent)).toEqual(['c', 'a!', 'd', 'plain']);
    expect(lis[0]).toBe(three);
    expect(lis[1]).toBe(one);
    expect(lis).not.toContain(two);
  });

  it('puts markup into an element too, as keyed.js does for a row value', () => {
    const d = document.implementation.createHTMLDocument('t');
    d.body.innerHTML = '<p><b m-k="x">x</b><b m-k="y">y</b></p>';
    const [x, y] = d.querySelectorAll('b');
    into(d, d.body.firstChild, d.body.firstChild.firstChild, null, '<b m-k="y">y</b><b m-k="x">x</b>');
    expect([...d.querySelectorAll('b')]).toEqual([y, x]);
  });
});
