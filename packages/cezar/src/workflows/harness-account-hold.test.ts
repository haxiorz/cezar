import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const LIMIT = 'Codex usage limit reached. Try again in 3 hours.';

// PR #925 review: a usage-limit hold was keyed to the composer's account, so a Codex implementer's
// limit held every new Claude task while new Codex tasks walked into the closed window.
describe('a usage-limit hold belongs to the account that hit the limit', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-account-hold-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'a\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root);
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(root, { recursive: true, force: true });
  });

  const failedRun = (harness: boolean) => {
    const run = store.createRun({
      title: 't',
      workflow: harness ? 'harness-fix-issue' : 'one-step',
      task: 'x',
      steps: [{ id: 'implement', name: 'Implement', kind: 'agent' as const }],
    });
    store.updateStep(run.id, 'implement', { status: 'failed', backend: 'codex', profileId: 'work', error: LIMIT });
    store.updateRun(run.id, {
      status: 'failed',
      runner: 'claude',
      error: `phase "implement" failed: ${LIMIT}`,
      autoResumeAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
      ...(harness ? { harness: { profile: 'standard', workflow: 'harness-fix-issue', issueId: '1' } } : {}),
    });
  };

  it('holds the harness phase account, not the composer account', () => {
    failedRun(true);
    const holds = manager.accountHolds();
    expect(holds.deadline.has('codex:work')).toBe(true);
    expect(holds.deadline.has('claude:default')).toBe(false);
  });

  it('keeps the run account for an ordinary run', () => {
    failedRun(false);
    expect(manager.accountHolds().deadline.has('claude:default')).toBe(true);
  });
});
