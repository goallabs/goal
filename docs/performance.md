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

## A 100,000-row virtual list

The repository's `examples/virtual` is a virtual list of 100,000 rows whose structure differs from row
to row: a badge that comes and goes, tags of any length, a meter. Only the rows in view, and a few
around them, are in the page. In the same headless Chrome:

| Operation | Event to patched DOM, median (p95) |
|---|---|
| Scroll by 3 rows | 0.2 ms (0.3 ms) |
| Jump to a random place, replacing every row | 0.3 ms (0.4 ms) |
| Update every row's values and some rows' structure | 0.2 ms (0.3 ms) |

Over 8 cycles of 200 jumps, 12 updates and 300 scroll steps each, the JS heap stayed between 0.84 and
0.85 MB after a garbage collection, with the same 291 DOM nodes and 4 event listeners every time: no
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
patched DOM and the main thread's time per operation. For memory it repeats all three in cycles and
compares the JS heap, DOM nodes and event listeners after a garbage collection: growth from cycle to
cycle is a leak.

- `--cycles 12` runs more memory cycles.
- `--json results.json` also saves the numbers.
- `CHROME=/path/to/chrome` sets the browser if it isn't in `/Applications`.
