// Plays cezar: starts an agent the way every run does, then leaves the way the test asks —
// `exit` calls process.exit on SIGUSR2; `handled` owns shutdown like serve/run, turning SIGINT or
// SIGHUP into a delayed process.exit; `signal` waits for a signal it does not handle (default death).
// `harness` starts the agent through the harness's own detached spawn instead of a runner's.
// proper-lockfile is loaded as serve/run load it: its signal-exit adds listeners that own nothing.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import 'proper-lockfile';

const [bin, cwd, mode, spawner = 'agent'] = process.argv.slice(2);
if (mode === 'exit') process.on('SIGUSR2', () => process.exit(0));
if (mode === 'handled') {
  const { ownProcessShutdown } = await import('../../process-tree.ts');
  ownProcessShutdown();
  process.on('SIGINT', () => setTimeout(() => process.exit(130), 50));
  process.on('SIGHUP', () => setTimeout(() => process.exit(129), 50));
}
if (spawner === 'harness') {
  // A harness spawn (validation gate, probe, runtime op): detached by its own code, not a runner's.
  const { runValidationCommands } = await import('../../../harness/runtime.ts');
  void runValidationCommands([bin], cwd);
} else {
  const { spawnCodexAppServer } = await import('../../codex-app-server-transport.ts');
  const child = spawnCodexAppServer(bin, cwd);
  child.stdout.resume();
  child.stderr.resume();
}

const started = setInterval(() => {
  if (!existsSync(join(cwd, 'pids.json'))) return;
  clearInterval(started);
  process.stdout.write('ready\n');
}, 20);
setInterval(() => {}, 60_000);
