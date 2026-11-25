// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { _$lp } from '../src/keyed.js';

// A row template like the compiler makes: a row is [key, item, index, class, label, checked, value].
const tpl = (v) => `<li${v[3] == null ? '' : ` class="${v[3]}"`}><b>${v[4]}</b><input type="checkbox"><input></li>`;
const PARTS = [
  [1, [], 'class'],
  [0, [0]],
  [1, [1], 'checked'],
  [1, [2], 'value'],
];
const row = (key, label = `r${key}`, cls = 'c', checked = false, value = '') => [key, key, 0, cls, label, checked, value];

function setup(rows, parts = PARTS) {
  const d = document.implementation.createHTMLDocument('t');
  d.body.innerHTML = `<ul><!--0.0-->${rows.map(tpl).join('')}<!--/--><li id="after"></li></ul>`;
  const c = d.querySelector('ul').firstChild;
  let cur = rows;
  return {
    d,
    to(next) {
      _$lp(d, c, cur, next, tpl, parts);
      cur = next;
    },
    lis: () => [...d.querySelectorAll('li:not(#after)')],
    labels: () => [...d.querySelectorAll('li:not(#after) b')].map((b) => b.innerHTML),
  };
}

describe('keyed lists', () => {
  it('writes only the values that changed, in place', () => {
    const l = setup([row(1), row(2), row(3)]);
    const before = l.lis();
    l.to([row(1, 'one', 'sel', true, 'x'), row(2, 'a &amp; <i>c</i>'), row(3)]);
    const after = l.lis();
    expect(after).toEqual(before);
    expect(after[0].className).toBe('sel');
    expect(after[0].querySelector('b').textContent).toBe('one');
    expect(after[0].querySelector('[type=checkbox]').checked).toBe(true);
    expect(after[0].querySelectorAll('input')[1].value).toBe('x');
    expect(after[1].querySelector('b').innerHTML).toBe('a &amp; <i>c</i>');
    l.to([row(1, 'one', null, false, null), row(2, 'a &amp; <i>c</i>'), row(3)]);
    expect(after[0].hasAttribute('class')).toBe(false);
    expect(after[0].querySelector('[type=checkbox]').checked).toBe(false);
    expect(after[0].querySelectorAll('input')[1].value).toBe('');
    l.to([row(1, 'one', true), row(2, 'a &amp; <i>c</i>'), row(3)]);
    expect(after[0].getAttribute('class')).toBe('');
  });

  it('adds, removes, swaps and clears with as few moves as it can', () => {
    const l = setup([row(1), row(2), row(3), row(4), row(5)]);
    const [n1, n2, n3, n4, n5] = l.lis();
    l.to([row(1), row(4), row(3), row(2), row(5)]); // swap
    expect(l.lis()).toEqual([n1, n4, n3, n2, n5]);
    l.to([row(1), row(4), row(2), row(5)]); // remove
    expect(l.lis()).toEqual([n1, n4, n2, n5]);
    l.to([row(0), row(1), row(4), row(9), row(2), row(5), row(6)]); // insert at the start, middle and end
    expect(l.labels()).toEqual(['r0', 'r1', 'r4', 'r9', 'r2', 'r5', 'r6']);
    expect(l.lis()[1]).toBe(n1);
    l.to([]);
    expect(l.lis()).toEqual([]);
    l.to([row(7), row(8)]);
    expect(l.labels()).toEqual(['r7', 'r8']);
    l.to([row(10), row(11)]); // nothing kept
    expect(l.labels()).toEqual(['r10', 'r11']);
    expect(l.d.querySelector('ul').lastElementChild.id).toBe('after');
  });

  it('empties a list that is all its parent holds in one go, keeping its markers', () => {
    const d = document.implementation.createHTMLDocument('t');
    d.body.innerHTML = `<ul><!--0.0-->${[row(1), row(2)].map(tpl).join('')}<!--/--></ul>`;
    const ul = d.querySelector('ul');
    _$lp(d, ul.firstChild, [row(1), row(2)], [row(3)], tpl, PARTS);
    expect([...ul.querySelectorAll('b')].map((b) => b.textContent)).toEqual(['r3']);
    _$lp(d, ul.firstChild, [row(3)], [], tpl, PARTS);
    expect(ul.innerHTML).toBe('<!--0.0--><!--/-->');
  });

  it('gets every reordering right, keeping each kept row', () => {
    let seed = 7;
    const rand = (n) => ((seed = (seed * 16807) % 2147483647) % n);
    for (let round = 0; round < 60; round++) {
      const start = Array.from({ length: rand(12) }, (_, i) => row(i));
      const l = setup(start);
      const nodes = new Map(start.map((r, i) => [r[0], l.lis()[i]]));
      const next = [...start, ...Array.from({ length: rand(5) }, (_, i) => row(100 + i))].filter(() => rand(4) > 0).sort(() => rand(3) - 1);
      l.to(next);
      expect(l.labels()).toEqual(next.map((r) => `r${r[0]}`));
      l.lis().forEach((li, i) => {
        if (nodes.has(next[i][0])) expect(li).toBe(nodes.get(next[i][0]));
      });
    }
  });

  it('writes text into an empty element, or one that held markup', () => {
    const l = setup([row(1, ''), row(2, 'a <i>b</i>')]);
    l.to([row(1, 'x'), row(2, 'plain')]);
    expect(l.labels()).toEqual(['x', 'plain']);
  });

  it('makes a changed row again when its values have no fixed place', () => {
    const l = setup([row(1), row(2)], null);
    const [n1, n2] = l.lis();
    l.to([row(1, 'new'), row(2)]);
    expect(l.labels()).toEqual(['new', 'r2']);
    expect(l.lis()[0]).not.toBe(n1);
    expect(l.lis()[1]).toBe(n2);
  });
});
