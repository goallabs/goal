---
title: Performance
nav_order: 9
---

# Performance

## js-framework-benchmark

goal.js has a keyed implementation of [js-framework-benchmark](https://github.com/krausest/js-framework-benchmark),
which passes the benchmark's keyed check. On one Mac, in headless Chrome, with all seven frameworks run
together on 25 November 2026, the geometric mean of the nine timed operations, as a ratio to vanillajs
(lower is faster), was:

| Framework | Ratio to vanillajs |
|---|---|
| vanillajs | 1.00 |
| **goal.js 0.1** | **1.07** |
| solid 1.9.3 | 1.12 |
| svelte 5.42.1 | 1.16 |
| vue 3.5.39 | 1.21 |
| react 19.2 (hooks) | 1.69 |
| qwik 1.20.2 | 3.60 |

goal.js was faster than vanillajs at removing a row (0.88), creating 10,000 rows (0.97) and selecting
a row (0.98). Its weakest result was the partial update (1.50). This is one run on one machine; the
benchmark's official results are run on other hardware.

### goal.js 0.8 against 0.1

Ratios move from run to run with the machine's load, so versions are compared in the same run. On 26
November 2026, with goal.js 0.1, goal.js 0.8 and vanillajs run together on an Apple M5 at a load
average of about 2:

| Operation | goal.js 0.1 | goal.js 0.8 |
|---|---|---|
| Create 1,000 rows | 1.07 | 1.07 |
| Replace all rows | 1.07 | 1.08 |
| Partial update | 1.16 | 1.18 |
| Select a row | 1.36 | 1.25 |
| Swap rows | 1.21 | 1.18 |
| Remove a row | 1.07 | 1.09 |
| Create 10,000 rows | 1.09 | 1.08 |
| Append 1,000 rows | 1.08 | 1.07 |
| Clear rows | 1.47 | 1.22 |
| **Geometric mean** | **1.17** | **1.13** |

Each figure is the ratio to vanillajs in that run. 0.8 clears and selects rows faster, and the rest is
the same within the run's noise. Its JavaScript is 4.0 kB compressed (3.3 kB in 0.1), for the features
added since: types, components rendered in the browser, scoped styles.

## A 100,000-row virtual list

The repository's `examples/virtual` is a virtual list of 100,000 rows whose structure differs from row
to row: a badge that comes and goes, tags of any length, a meter. Only the rows in view, and a few
around them, are in the page. In the same headless Chrome:

| Operation | goal.js's script, per operation | Event to patched DOM, median (p95) |
|---|---|---|
| Scroll by 3 rows | 0.066 ms | 0.6 ms (0.8 ms) |
| Jump to a random place, replacing every row | 0.062 ms | 1.3 ms (1.6 ms) |
| Update every row's values and some rows' structure | 0.064 ms | 1.0 ms (1.3 ms) |

These are goal.js 0.8 on 26 November 2026, the median of three runs, each within 5% of the others.
goal.js's own script is a few hundredths of a millisecond per operation; the rest of the time is
Chrome's style and layout. Against goal.js 0.1 in the same rounds, the script is about 10% more per
operation (0.056 to 0.062 ms there) and the whole operation the same within noise.

Over the memory cycles of 200 jumps, 12 updates and 300 scroll steps each, the JS heap stays at about
0.93 MB after a garbage collection, with the same 291 DOM nodes and 5 event listeners every time: no
memory leak.

## Measuring it yourself

In a clone of the repository:

```bash
npm install
npm run bench:virtual             # about 3 to 4 minutes
npm run bench:virtual -- --quick  # under a minute
```

It builds `examples/virtual`, serves it, and drives headless Chrome over the DevTools protocol, with no
extra dependency. For scroll steps, random jumps and updates it reports the time from the event to the
patched DOM and the main thread's CPU time per operation: script, style, layout and all tasks. CPU
time leaves out what other programs on the machine take, though a busy machine still slows Chrome
down: compare versions in the same session, one after the other, and more than once. For memory it repeats all three in cycles and
compares the JS heap, DOM nodes and event listeners after a garbage collection: growth from cycle to
cycle is a leak.

- `--cycles 12` runs more memory cycles.
- `--json results.json` also saves the numbers.
- `CHROME=/path/to/chrome` sets the browser if it isn't in `/Applications`.
