// node bench/virtual.mjs [--quick] [--cycles 8] [--json results.json]
//
// Measures examples/virtual, a virtual list of 100,000 rows whose structure differs from row to row,
// in headless Chrome:
//   speed:  for small scroll steps, random jumps and updates, how long goal.js takes from the event
//           to the patched DOM, and the CPU Chrome spends per operation (script, style, layout);
//   memory: repeated cycles of all three, with a garbage collection after each, watching the JS heap,
//           the DOM nodes and the event listeners. A leak shows as growth from cycle to cycle.
//
// Chrome is driven over the DevTools protocol with Node's own WebSocket, so there is no extra
// dependency. Set CHROME to the browser's path if it isn't the standard macOS one.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, serve } from '../src/build.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'examples/virtual');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROW = 32; // as in VirtualList.goal
const VIEW = 640;
const EXTRA = 4;
const COUNT = 100000;
const MAX = COUNT * ROW - VIEW;

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const QUICK = args.includes('--quick');
const CYCLES = Number(arg('--cycles') ?? (QUICK ? 3 : 8));
const SIZES = QUICK ? { steps: 100, jumps: 100, updates: 30 } : { steps: 600, jumps: 400, updates: 150 };

// ---------------------------------------------------------------------------------------------
// Chrome over the DevTools protocol.

function connect(url) {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(url);
    const waiting = new Map();
    const handlers = new Map();
    let id = 0;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.error) w.reject(new Error(`${w.method}: ${m.error.message}`));
        else w.resolve(m.result);
      } else for (const f of handlers.get(m.method) ?? []) f(m.params);
    };
    ws.onerror = () => fail(new Error(`can't connect to ${url}`));
    ws.onopen = () =>
      ok({
        send: (method, params = {}) =>
          new Promise((resolve, reject) => {
            waiting.set(++id, { resolve, reject, method });
            ws.send(JSON.stringify({ id, method, params }));
          }),
        on: (method, f) => handlers.set(method, [...(handlers.get(method) ?? []), f]),
        close: () => ws.close(),
      });
  });
}

async function launch() {
  const dir = mkdtempSync(join(tmpdir(), 'goal-bench-'));
  const proc = spawn(
    CHROME,
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1000,900', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const exited = new Promise((ok) => proc.on('exit', ok));
  const browserUrl = await new Promise((ok, fail) => {
    let err = '';
    proc.stderr.on('data', (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) ok(m[1]);
    });
    proc.on('error', (e) => fail(new Error(`can't start Chrome at ${CHROME} (set CHROME): ${e.message}`)));
    exited.then((code) => fail(new Error(`Chrome exited (${code}): ${err.slice(-400)}`)));
    setTimeout(() => fail(new Error('Chrome did not start within 20 s')), 20000).unref();
  });
  const port = new URL(browserUrl).port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const cdp = await connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  const version = (await cdp.send('Browser.getVersion')).product;
  return {
    cdp,
    version,
    async close() {
      cdp.close();
      proc.kill();
      await exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// What runs in the page: one operation is a scroll to y, or a click on Update (y < 0). It returns
// the time from the event to the end of goal.js's patch (the first DOM change, observed when the
// patch's synchronous run ends), after waiting for the frame that shows it.

const IN_PAGE = `window.__vl = (() => {
  const vp = document.getElementById('viewport');
  const frame = () => new Promise(requestAnimationFrame);
  const ids = () => {
    const r = document.querySelector('.rows');
    return r.firstElementChild?.dataset.id + '-' + r.lastElementChild?.dataset.id;
  };
  async function op(y) {
    let start = 0;
    let end = 0;
    const mo = new MutationObserver(() => { if (!end) end = performance.now(); });
    mo.observe(vp, { subtree: true, childList: true, characterData: true, attributes: true });
    const onScroll = () => { if (!start) start = performance.now(); };
    addEventListener('scroll', onScroll, true);
    const t0 = performance.now();
    let want;
    if (y < 0) document.getElementById('update').click();
    else {
      const was = ids();
      vp.scrollTop = y;
      const t = vp.scrollTop;
      want = Math.max(0, Math.floor(t / ${ROW}) - ${EXTRA}) + '-' + (Math.min(${COUNT}, Math.ceil((t + ${VIEW}) / ${ROW}) + ${EXTRA}) - 1);
      if (want === was) {
        mo.disconnect();
        removeEventListener('scroll', onScroll, true);
        await frame();
        return null; // the same rows: nothing to patch, nothing measured
      }
    }
    try {
      while (y < 0 ? !end : ids() !== want || !end) {
        await frame();
        if (performance.now() - t0 > 5000) throw new Error('no patch within 5 s for ' + (y < 0 ? 'Update' : 'scrollTop ' + y));
      }
      await frame();
    } finally {
      mo.disconnect();
      removeEventListener('scroll', onScroll, true);
    }
    return end - (start || t0);
  }
  return {
    async run(ops) {
      const out = [];
      for (const y of ops) out.push(await op(y));
      return out.filter((t) => t !== null);
    },
  };
})(); true`;

// ---------------------------------------------------------------------------------------------
// Operations, the same on every run.

function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scroll positions three rows apart, down from y and back up at the end. */
function steps(n, y) {
  const out = [];
  let dir = 1;
  for (let i = 0; i < n; i++) {
    if (y + dir * 3 * ROW > MAX || y + dir * 3 * ROW < 0) dir = -dir;
    y += dir * 3 * ROW;
    out.push(y);
  }
  return out;
}

/** Random positions, each far enough from the last to replace every row. */
function jumps(n, rnd, from) {
  const out = [];
  let y = from;
  for (let i = 0; i < n; i++) {
    let next;
    do next = Math.floor((rnd() * MAX) / ROW) * ROW;
    while (Math.abs(next - y) < VIEW * 2);
    out.push((y = next));
  }
  return out;
}

const updates = (n) => Array(n).fill(-1);
// A row's structure repeats every 12 updates (its badge every 3, its tags every 4), so a cycle of 12
// ends with the same rows built the same way, and the same DOM node count.
const UPDATES = 12;

// ---------------------------------------------------------------------------------------------

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { count: s.length, median: at(0.5), p95: at(0.95), max: s.at(-1) };
};
const ms = (x) => (x < 10 ? x.toFixed(2) : x.toFixed(1));
const ms1 = (x) => x.toFixed(1); // in-page times: Chrome's timer has 0.1 ms resolution here
const kb = (b) => `${(b / 1024).toFixed(1)} kB`;
const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;

async function main() {
  const built = await build(APP);
  const server = await serve(APP, { port: 0, log: () => {} });
  const url = `http://localhost:${server.address().port}/`;
  const chrome = await launch();
  const { cdp } = chrome;
  const problems = [];
  try {
    await Promise.all(['Page.enable', 'Runtime.enable', 'Log.enable', 'Performance.enable', 'HeapProfiler.enable'].map((m) => cdp.send(m)));
    cdp.on('Runtime.exceptionThrown', (p) => problems.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text));
    cdp.on('Runtime.consoleAPICalled', (p) => p.type === 'error' && problems.push(p.args.map((a) => a.value ?? a.description).join(' ')));
    cdp.on('Log.entryAdded', (p) => p.entry.level === 'error' && !p.entry.url?.endsWith('/favicon.ico') && problems.push(`${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ''}`));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });

    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const gc = async () => {
      for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
      return metrics();
    };
    const run = (ops) => evaluate(`__vl.run(${JSON.stringify(ops)})`);

    // Load, and the first event, which loads the component's code.
    const loaded = new Promise((ok) => cdp.on('Page.loadEventFired', ok));
    await cdp.send('Page.navigate', { url });
    await loaded;
    await evaluate(IN_PAGE);
    const atLoad = await metrics();
    const page = await evaluate(`new Promise((ok) => {
      const html = performance.getEntriesByType('navigation')[0].transferSize;
      const done = (paint) => ok({ html, paint });
      new PerformanceObserver((l) => { const p = l.getEntries().find((e) => e.name === 'first-contentful-paint'); if (p) done(p.startTime); }).observe({ type: 'paint', buffered: true });
      setTimeout(() => done(null), 3000);
    })`);
    const [firstPatch] = await run([3 * ROW]);
    const js = await evaluate(`performance.getEntriesByType('resource').filter((r) => r.name.endsWith('.js')).map((r) => ({ url: new URL(r.name).pathname, bytes: r.encodedBodySize }))`);

    // Speed.
    const rnd = random(7);
    let y = 3 * ROW;
    const phases = [];
    for (const [name, ops] of [
      ['scroll step', steps(SIZES.steps, y)],
      ['jump', jumps(SIZES.jumps, rnd, y)],
      ['update', updates(SIZES.updates)],
    ]) {
      const before = await metrics();
      const times = await run(ops);
      const after = await metrics();
      const per = (k) => ((after[k] - before[k]) * 1000) / ops.length;
      phases.push({ name, patch: stats(times), cpu: { style: per('RecalcStyleDuration'), layout: per('LayoutDuration'), task: per('TaskDuration') } });
      if (ops.at(-1) >= 0) y = ops.at(-1);
    }

    // Memory: the same mix, cycle after cycle, measured after a garbage collection.
    const mem = [];
    const sample = (cycle, m) => mem.push({ cycle, heap: m.JSHeapUsedSize, nodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents });
    sample(0, await gc());
    for (let c = 1; c <= CYCLES; c++) {
      const j = jumps(Math.round(SIZES.jumps / 2), rnd, y);
      const s = steps(Math.round(SIZES.steps / 2), j.at(-1));
      await run([...j, ...updates(UPDATES), ...s, 0]);
      y = 0;
      sample(c, await gc());
    }

    // Report.
    const total = built.chunks.filter((c) => js.some((r) => r.url === c.url)).reduce((n, c) => n + c.gzip, 0);
    console.log(`goal.js virtual list: ${COUNT.toLocaleString('en')} rows, ${chrome.version}, headless${QUICK ? ', quick run' : ''}\n`);
    console.log(`Page: ${kb(page.html)} of HTML, first contentful paint ${page.paint == null ? 'not reported' : `${ms(page.paint)} ms`}, ${atLoad.Nodes} DOM nodes`);
    console.log(`First scroll: ${ms1(firstPatch)} ms to the patch, loading ${js.map((r) => r.url).join(' + ')} (${kb(total)} gzipped, loader inline)\n`);
    console.log('                       event to patched DOM (ms)       main thread per operation (ms)');
    console.log('operation      count   median    p95      max          style   layout   all tasks');
    for (const p of phases)
      console.log(
        `${p.name.padEnd(13)}${String(p.patch.count).padStart(6)}   ${ms1(p.patch.median).padStart(6)}  ${ms1(p.patch.p95).padStart(6)}  ${ms1(p.patch.max).padStart(7)}        ${ms(p.cpu.style).padStart(5)}  ${ms(p.cpu.layout).padStart(7)}   ${ms(p.cpu.task).padStart(9)}`,
      );
    console.log(`\nMemory after a garbage collection, each cycle ${Math.round(SIZES.jumps / 2)} jumps, ${UPDATES} updates and ${Math.round(SIZES.steps / 2)} scroll steps, ending at the top:`);
    console.log('cycle   JS heap      DOM nodes   listeners');
    for (const m of mem) console.log(`${String(m.cycle).padStart(5)}   ${mb(m.heap).padStart(9)}   ${String(m.nodes).padStart(9)}   ${String(m.listeners).padStart(9)}`);
    const [a, b] = [mem[1], mem.at(-1)];
    const late = mem.slice(Math.max(1, Math.ceil(mem.length / 2))); // the second half: past the warm-up
    const xs = late.map((m) => m.cycle);
    const ys = late.map((m) => m.heap);
    const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
    const my = ys.reduce((s, x) => s + x, 0) / ys.length;
    const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / (xs.reduce((s, x) => s + (x - mx) ** 2, 0) || 1);
    const grows = slope > a.heap * 0.01 || b.nodes > a.nodes || b.listeners > a.listeners;
    console.log(
      `\nFrom cycle 1 to ${b.cycle}: JS heap ${b.heap >= a.heap ? '+' : ''}${kb(b.heap - a.heap)} (${(((b.heap - a.heap) / a.heap) * 100).toFixed(1)}%), and a trend of ${kb(slope)} per cycle over cycles ${xs[0]} to ${b.cycle}; DOM nodes ${a.nodes} to ${b.nodes}; listeners ${a.listeners} to ${b.listeners}.`,
    );
    console.log(grows ? 'Memory grows from cycle to cycle: a possible leak.' : 'No growth from cycle to cycle: no leak seen.');
    if (problems.length) console.log(`\nErrors in the page:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    else console.log('\nNo errors in the page (the strict CSP is on).');

    const out = arg('--json');
    if (out) writeFileSync(out, JSON.stringify({ chrome: chrome.version, quick: QUICK, page, firstPatch, js, phases, memory: mem, problems }, null, 2));
  } finally {
    await chrome.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
