import { ChildProcess, spawn } from 'node:child_process';

/** Agent backends are process-tree owners: every Unix runner is a process
 * group leader and Windows termination uses taskkill /t. */
export const AGENT_PROCESS_DETACHED = process.platform !== 'win32';

export function signalAgentProcessTree(
  child: ChildProcess,
  signal: 'SIGTERM' | 'SIGKILL',
): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // Always `/f` (PR #925 review): windowless console CLIs refuse a plain taskkill, so the
    // "graceful" step only waited out the grace window. main's `child.kill` was immediate too.
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    // An unhandled spawn 'error' (ENOENT) is an uncaught exception that takes the server down.
    killer.once('error', () => {
      try {
        child.kill(signal);
      } catch {
      }
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      try {
        process.kill(child.pid, signal);
      } catch {
      }
    }
  }
}

/** Is any process still alive in the child's group? Signal 0 only checks for
 * existence and permission — it delivers nothing. A surviving group member is
 * why escalation cannot be tied to the leader's own exit (2026-07-27). */
function groupStillAlive(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * SIGTERM the whole process group, then escalate to SIGKILL if anything in it
 * outlives the grace window.
 *
 * The escalation used to be gated on the LEADER's `exitCode`/`signalCode` and
 * cancelled outright on its `close`. That is the wrong liveness question: the
 * group SIGTERM does reach every member, but a member that masks or outlasts it
 * — `opencode serve` draining an in-flight turn is the case in practice — then
 * survives, because the leader's exit both fails the guard and clears the timer.
 * Escalation now asks whether the GROUP is still alive.
 *
 * The original guard existed to stop PID reuse turning a watchdog into an
 * unrelated kill, and that risk is real, so the group is re-checked at fire time
 * and the timer is still cleared once the group is genuinely empty.
 */
export function terminateAgentProcessTree(
  child: ChildProcess,
  graceMs: number,
): NodeJS.Timeout {
  const pid = child.pid;
  signalAgentProcessTree(child, 'SIGTERM');
  const timer = setTimeout(() => {
    if (pid === undefined) return;
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null) {
        signalAgentProcessTree(child, 'SIGKILL');
      }
      return;
    }
    if (groupStillAlive(pid)) signalAgentProcessTree(child, 'SIGKILL');
  }, graceMs);
  child.once('close', () => {
    if (pid === undefined || !groupStillAlive(pid)) clearTimeout(timer);
  });
  timer.unref?.();
  return timer;
}

const liveTrees = new Set<ChildProcess>();
let exitHooksInstalled = false;

/**
 * Register a detached agent so cezar's own exit takes its process group down.
 * A detached agent leaves the terminal's process group, so Ctrl-C or a closed
 * terminal no longer reaches it, and the next boot would `recover()` the run
 * while the orphan kept writing the worktree (PR #925 review). Only a real
 * `ChildProcess` is tracked: a test double's made-up pid must never be signalled.
 */
export function trackAgentProcessTree(child: ChildProcess): void {
  if (!AGENT_PROCESS_DETACHED || !(child instanceof ChildProcess) || child.pid === undefined) return;
  liveTrees.add(child);
  child.once('exit', () => liveTrees.delete(child));
  installExitHooks();
}

/** SIGTERM every tracked agent group still running. Synchronous: it runs from `exit`. */
export function terminateLiveAgentProcessTrees(): void {
  for (const child of liveTrees) signalAgentProcessTree(child, 'SIGTERM');
  liveTrees.clear();
}

function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  // After `serve`/`run` flushed their state, so the next boot still resumes the run.
  process.once('exit', terminateLiveAgentProcessTrees);
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
    const onSignal = (): void => {
      // A command with its own handler owns shutdown; its `process.exit` reaches the hook above.
      if (process.listenerCount(signal) > 1) return;
      terminateLiveAgentProcessTrees();
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    };
    process.on(signal, onSignal);
  }
}
