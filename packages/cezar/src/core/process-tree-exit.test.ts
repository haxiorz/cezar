import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const owner = fileURLToPath(new URL('./__fixtures__/process-tree/agent-owner.mjs', import.meta.url));
const fakeAgent = fileURLToPath(new URL('./__fixtures__/process-tree/fake-agent.mjs', import.meta.url));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function until(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

/**
 * PR #925 review: every agent runs detached in its own process group, so the terminal's Ctrl-C
 * and hangup no longer reach it. Before cezar tracked its agents, stopping `cezar serve` left the
 * agent writing the worktree while the next boot `recover()`ed the same run. Real processes: the
 * bug is process semantics, and a fake would only re-assert its own model.
 */
describe.skipIf(process.platform === 'win32')('agent process groups die with cezar', () => {
  const dirs: string[] = [];
  const leaders: number[] = [];
  const owners: ChildProcess[] = [];

  afterEach(() => {
    for (const child of owners.splice(0)) child.kill('SIGKILL');
    for (const pid of leaders.splice(0)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
      }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function startOwner(mode: 'exit' | 'handled' | 'signal') {
    const dir = mkdtempSync(join(tmpdir(), 'cez-tree-exit-'));
    dirs.push(dir);
    const bin = join(dir, 'fake-agent.mjs');
    copyFileSync(fakeAgent, bin);
    chmodSync(bin, 0o755);
    const child = spawn(process.execPath, ['--import', 'tsx', owner, bin, dir, mode], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    owners.push(child);
    let out = '';
    child.stdout!.on('data', (chunk) => {
      out += String(chunk);
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    const pidsFile = join(dir, 'pids.json');
    expect(await until(() => existsSync(pidsFile) && readFileSync(pidsFile, 'utf8').length > 0, 10_000)).toBe(true);
    const pids = JSON.parse(readFileSync(pidsFile, 'utf8')) as { leader: number; tool: number };
    leaders.push(pids.leader);
    expect(alive(pids.leader) && alive(pids.tool)).toBe(true);
    return { child, pids, exited, ready: () => until(() => out.includes('ready'), 10_000) };
  }

  it('takes the agent and its tool children down when cezar exits', async () => {
    const { child, pids, exited, ready } = await startOwner('exit');
    expect(await ready()).toBe(true);
    child.kill('SIGUSR2');
    expect((await exited).code).toBe(0);
    expect(await until(() => !alive(pids.leader) && !alive(pids.tool), 3_000)).toBe(true);
  }, 20_000);

  it('still lets a command that handles SIGINT shut down first, then takes the agent down', async () => {
    const { child, pids, exited, ready } = await startOwner('handled');
    expect(await ready()).toBe(true);
    child.kill('SIGINT');
    expect((await exited).code).toBe(130);
    expect(await until(() => !alive(pids.leader) && !alive(pids.tool), 3_000)).toBe(true);
  }, 20_000);

  it('takes the agent down on an unhandled Ctrl-C or hangup, and cezar still dies of that signal', async () => {
    for (const signal of ['SIGINT', 'SIGHUP'] as const) {
      const { child, pids, exited, ready } = await startOwner('signal');
      expect(await ready()).toBe(true);
      child.kill(signal);
      expect((await exited).signal).toBe(signal);
      expect(await until(() => !alive(pids.leader) && !alive(pids.tool), 3_000)).toBe(true);
    }
  }, 30_000);
});
