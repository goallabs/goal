// goal build [app] | goal start [app] [--port N] | goal dev [app] [--port N] | goal check [app]
// | goal add [tool] [app]

import { build, serve, dev, check } from './build.js';
import { add } from './add.js';

const USAGE = 'usage: goal build|start|dev|check [app folder] [--port 3000]\n       goal add [tool] [app folder]';

/** The command, the app's folder (the current one by default), the port (3000 by default), and goal add's tool. */
export function args(argv) {
  const [cmd, ...rest] = argv;
  const i = rest.indexOf('--port');
  const port = i < 0 ? 3000 : Number(rest.splice(i, 2)[1]);
  const tool = cmd === 'add' ? rest.shift() : undefined;
  return { cmd, app: rest[0] ?? '.', port, tool };
}

export async function main(argv, log = console.log, opts = {}) {
  const { cmd, app, port, tool } = args(argv);
  if (cmd === 'add') {
    try {
      await add(app, tool, { log, ...opts });
      return 0;
    } catch (e) {
      log(e.message);
      return 1;
    }
  }
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
  if (cmd === 'check') {
    try {
      const errors = check(app);
      for (const e of errors) log(e);
      log(errors.length ? `${errors.length} file${errors.length === 1 ? '' : 's'} with errors` : 'no errors');
      return errors.length ? 1 : 0;
    } catch (e) {
      log(e.message); // a file that doesn't parse
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
