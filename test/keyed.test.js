// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { _$lp, _$lf, _$L } from '../src/keyed.js';

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

  it('swaps two rows by moving just those two, keeping the last run as it was', () => {
    const start = Array.from({ length: 8 }, (_, i) => row(i));
    const l = setup(start);
    const nodes = l.lis();
    const ul = l.d.querySelector('ul');
    let moves = 0;
    const insert = ul.insertBefore.bind(ul);
    ul.insertBefore = (...a) => (moves++, insert(...a));
    const next = start.slice();
    [next[1], next[6]] = [row(6, 'six'), start[1]];
    l.to(next);
    expect(moves).toBe(2);
    expect(l.labels()).toEqual(['r0', 'six', 'r2', 'r3', 'r4', 'r5', 'r1', 'r7']);
    expect(l.lis()[6]).toBe(nodes[1]);
    expect(start.map((r) => r[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Swaps one inside the other, and the first and last rows
    l.to([row(7), row(6, 'six'), row(4), row(3), row(2), row(5), row(1), row(0)]);
    expect(l.labels()).toEqual(['r7', 'six', 'r4', 'r3', 'r2', 'r5', 'r1', 'r0']);
  });

  it('finds its rows after other elements and text in the same parent', () => {
    const d = document.implementation.createHTMLDocument('t');
    d.body.innerHTML = `<ul><li id="first"></li> text <li id="second"></li><!--0.0-->${[row(1), row(2), row(3), row(4)].map(tpl).join('')}<!--/--><li id="last"></li></ul>`;
    const ul = d.querySelector('ul');
    const c = [...ul.childNodes].find((n) => n.nodeType === 8);
    _$lp(d, c, [row(1), row(2), row(3), row(4)], [row(1), row(4, 'four'), row(3), row(2)], tpl, PARTS);
    expect([...ul.children].map((li) => li.id || li.querySelector('b').textContent)).toEqual(['first', 'second', 'r1', 'four', 'r3', 'r2', 'last']);
    _$lp(d, c, [row(1), row(4, 'four'), row(3), row(2)], [row(3)], tpl, PARTS);
    expect([...ul.children].map((li) => li.id || li.querySelector('b').textContent)).toEqual(['first', 'second', 'r3', 'last']);
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
    for (let round = 0; round < 200; round++) {
      const start = Array.from({ length: rand(12) }, (_, i) => row(i));
      const l = setup(start);
      const nodes = new Map(start.map((r, i) => [r[0], l.lis()[i]]));
      let next = [...start, ...Array.from({ length: rand(5) }, (_, i) => row(100 + i))].filter(() => rand(4) > 0).sort(() => rand(3) - 1);
      if (round % 3 === 0 && start.length > 2) {
        // two rows trading places, one or more times
        next = start.slice();
        for (let k = rand(3) + 1; k--; ) {
          const [i, j] = [rand(next.length), rand(next.length)];
          [next[i], next[j]] = [next[j], next[i]];
        }
      }
      l.to(next);
      expect(l.labels()).toEqual(next.map((r) => `r${r[0]}`));
      l.lis().forEach((li, i) => {
        if (nodes.has(next[i][0])) expect(li).toBe(nodes.get(next[i][0]));
      });
    }
  });

  it('ends up as the list rendered from scratch, through many random changes in a row', () => {
    let seed = 11;
    const rand = (n) => ((seed = (seed * 16807) % 2147483647) % n);
    const fresh = (rows) => {
      const d = document.implementation.createHTMLDocument('t');
      d.body.innerHTML = `<ul><li id="before"></li><!--0.0-->${rows.map(tpl).join('')}<!--/--><li id="after"></li></ul>`;
      return d.querySelector('ul').innerHTML;
    };
    let rows = Array.from({ length: 10 }, (_, i) => row(i));
    const d = document.implementation.createHTMLDocument('t');
    d.body.innerHTML = `<ul><li id="before"></li><!--0.0-->${rows.map(tpl).join('')}<!--/--><li id="after"></li></ul>`;
    const c = d.querySelector('ul').childNodes[1];
    let id = 100;
    for (let step = 0; step < 300; step++) {
      let next = rows.slice();
      const what = rand(6);
      if (what === 0 && next.length > 1) {
        const [i, j] = [rand(next.length), rand(next.length)];
        [next[i], next[j]] = [next[j], next[i]];
      } else if (what === 1) next.splice(rand(next.length + 1), 0, row(id++));
      else if (what === 2 && next.length) next.splice(rand(next.length), 1);
      else if (what === 3) next = next.map((r) => (rand(3) ? r : row(r[0], `x${rand(9)}`, rand(2) ? 'c' : null)));
      else if (what === 4) next.sort(() => rand(3) - 1);
      else if (what === 5) next = rand(4) ? next.filter(() => rand(2)) : [];
      _$lp(d, c, rows, next, tpl, PARTS);
      rows = next;
      expect(d.querySelector('ul').innerHTML).toBe(fresh(rows));
    }
  });

  it('writes text into an empty element, or one that held markup', () => {
    const l = setup([row(1, ''), row(2, 'a <i>b</i>')]);
    l.to([row(1, 'x'), row(2, 'plain')]);
    expect(l.labels()).toEqual(['x', 'plain']);
  });

  it('puts the new markup into a changed row whose values have no fixed place, keeping its nodes', () => {
    const l = setup([row(1), row(2)], null);
    const [n1, n2] = l.lis();
    const box = n1.querySelector('input');
    l.to([row(1, 'new'), row(2)]);
    expect(l.labels()).toEqual(['new', 'r2']);
    expect(l.lis()).toEqual([n1, n2]);
    expect(n1.querySelector('input')).toBe(box);
    l.to([row(2), row(1, 'moved')]); // moved and changed
    expect(l.labels()).toEqual(['r2', 'moved']);
    expect(l.lis()).toEqual([n2, n1]);
    l.to([row(2), row(1, 'moved'), row(3)]); // a new row, made from the template
    expect(l.labels()).toEqual(['r2', 'moved', 'r3']);
  });
});

describe("finding the last run's rows", () => {
  const last = (keys) => {
    const s = {};
    _$L(keys.map((k) => [k]), null, s, 'c');
    return s.c;
  };

  it('finds a row where it was, or shifted by the rows added or taken out before it', () => {
    const find = _$lf(last([1, 2, 3, 4, 5]));
    expect([find(1, 0), find(3, 1), find(4, 2), find(5, 3)].map((r) => r[0])).toEqual([1, 3, 4, 5]); // 2 taken out
    const added = _$lf(last([1, 2, 3]));
    expect([added(1, 0), added(9, 1), added(2, 2), added(3, 3)].map((r) => r?.[0])).toEqual([1, undefined, 2, 3]);
  });

  it('finds moved rows by key, and none on a first run', () => {
    const find = _$lf(last([1, 2, 3, 4]));
    expect([find(4, 0), find(2, 1), find(3, 2), find(1, 3)].map((r) => r[0])).toEqual([4, 2, 3, 1]);
    expect(_$lf(undefined)(1, 0)).toBe(undefined);
    // Many rows moved: after a few searches, a map of the keys
    const keys = Array.from({ length: 12 }, (_, i) => i);
    const many = _$lf(last(keys));
    expect(keys.toReversed().map((k, i) => many(k, i)[0])).toEqual(keys.toReversed());
    expect(many(99, 12)).toBe(undefined);
  });

  it("keeps the rows on the state as a function, which JSON leaves out", () => {
    const s = { n: 1 };
    const h = () => [];
    const rows = _$L([[1]], h, s, '_$c0');
    expect(s._$c0()).toEqual([[1]]);
    expect(s._$c0().h).toBe(undefined); // a copy without the handlers, which would keep every run before
    expect(rows.h).toBe(h);
    expect(JSON.stringify(s)).toBe('{"n":1}');
    const plain = _$L([[1]], h);
    expect([[...plain], plain.h]).toEqual([[[1]], h]); // no state to keep them on
  });
});
