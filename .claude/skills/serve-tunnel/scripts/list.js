'use strict';
// Human-readable dump of the tunnel state file.
const { readState, statePath } = require('./state-lib');

const entries = readState();
if (!entries.length) {
  process.stdout.write(`(no tunnels) ${statePath()}\n`);
  process.exit(0);
}
for (const e of entries) {
  const alive = e.pid ? (() => { try { process.kill(e.pid, 0); return 'up'; } catch { return 'dead'; } })() : '-';
  process.stdout.write(
    `${(e.slug || '?').padEnd(20)} ${String(e.status).padEnd(8)} ` +
      `port ${e.metroPort ?? '-'}  pid ${e.pid ?? '-'} (${alive})  ${e.expUrl ?? ''}\n`
  );
}
