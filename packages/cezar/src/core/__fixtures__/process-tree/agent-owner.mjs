// Plays cezar: starts an agent the way every run does, then leaves the way the test asks —
// `exit` calls process.exit on SIGUSR2; `handled` turns a SIGINT into a delayed process.exit
// (serve/run's shutdown); `signal` waits for a signal it does not handle (default death).
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const [bin, cwd, mode] = process.argv.slice(2);
if (mode === 'exit') process.on('SIGUSR2', () => process.exit(0));
if (mode === 'handled') process.on('SIGINT', () => setTimeout(() => process.exit(130), 50));
const { spawnCodexAppServer } = await import('../../codex-app-server-transport.ts');
const child = spawnCodexAppServer(bin, cwd);
child.stdout.resume();
child.stderr.resume();

const started = setInterval(() => {
  if (!existsSync(join(cwd, 'pids.json'))) return;
  clearInterval(started);
  process.stdout.write('ready\n');
}, 20);
setInterval(() => {}, 60_000);
