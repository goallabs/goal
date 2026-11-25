// goal build [app] | goal start [app] [--port N] | goal dev [app] [--port N]

import { build, serve, dev } from './build.js';

const USAGE = 'usage: goal build|start|dev [app folder] [--port 3000]';

export async function main(argv, log = console.log) {
  const [cmd, ...rest] = argv;
  const i = rest.indexOf('--port');
  const port = i < 0 ? 3000 : Number(rest.splice(i, 2)[1]);
  const app = rest[0] ?? '.';
  if (cmd === 'build') {
    try {
      const r = await build(app);
      for (const route of r.routes) log(route);
      for (const c of r.chunks) log(`${c.url}  ${c.bytes} B, ${c.gzip} B gzipped`);
      log(`loader  ${r.loader} B gzipped, inline`);
      return 0;
    } catch (e) {
      log(e.message);
      return 1;
    }
  }
  if (cmd === 'start' || cmd === 'dev') {
    const server = await (cmd === 'dev' ? dev(app, { port, log }) : serve(app, { port }));
    log(`http://localhost:${server.address().port}`);
    return server;
  }
  log(USAGE);
  return 1;
}
