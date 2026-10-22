import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHarnessDriver } from '../harness/driver.ts';
import { createLedger, loadLedger, saveLedger } from '../harness/ledger.ts';
import { harnessWorkflowDefs, HARNESS_FIX_ISSUE } from '../harness/workflows.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { loadWorkflows } from './load.ts';
import { RunManager } from './run.ts';

// Exercise the real manager/worktree/settlement paths without paying for model phases.
vi.mock('../harness/driver.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harness/driver.ts')>()),
  runHarnessDriver: vi.fn(async () => null),
}));

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const workflow = harnessWorkflowDefs().find((item) => item.name === HARNESS_FIX_ISSUE)!;

describe('harness lifecycle boundaries', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;

  const config = (value: Record<string, unknown>) => {
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify(value));
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    root = mkdtempSync(join(tmpdir(), 'cez-harness-lifecycle-'));
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(root, '.gitignore'), '.ai/cezar/\n');
    git('add', '.gitignore');
    git(...GIT_ID, 'commit', '-q', '-m', 'base');
    config({ multiModel: true, skillsRepos: [], branchNaming: { enabled: false } });
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root);
    vi.mocked(runHarnessDriver).mockReset();
    vi.mocked(runHarnessDriver).mockResolvedValue(null);
  });

  afterEach(async () => {
    for (const run of store.listRuns()) manager.cancel(run.id);
    await vi.waitFor(() => expect(store.listRuns().some((run) => manager.isActive(run.id))).toBe(false));
    manager.dispose();
    store.flush();
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('keeps harness changes isolated and staged in an auto-landing trunk project', async () => {
    config({ multiModel: true, taskWorkspace: 'in-place', landing: 'auto', skillsRepos: [] });
    vi.mocked(runHarnessDriver).mockImplementation(async (host) => {
      writeFileSync(join(host.cwd, 'feature.txt'), 'ready for review\n');
      execFileSync('git', ['add', 'feature.txt'], { cwd: host.cwd });
      return null;
    });
    const before = git('rev-parse', 'HEAD');
    const run = manager.startRun(workflow, { task: 'Fix issue #642', autonomous: true });
    await vi.waitFor(() => expect(['review', 'failed', 'done']).toContain(store.getRun(run.id)?.status), { timeout: 10_000 });
    const result = store.getRun(run.id)!;
    expect(result.status, result.error).toBe('review');
    expect(result.worktree).not.toBe(false);
    expect(result.worktreePath).toBeTruthy();
    expect(result.landing).toBeUndefined();
    expect(result.systemPrompt ?? '').not.toContain('AUTO-LAND');
    expect(git('rev-parse', 'HEAD')).toBe(before);
    expect(existsSync(join(root, 'feature.txt'))).toBe(false);
    expect(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: result.worktreePath, encoding: 'utf8' }).trim()).toBe('feature.txt');
  }, 15_000);

  it('never gives a recorded harness run permission to land in the checkout', async () => {
    config({ multiModel: true, taskWorkspace: 'in-place', landing: 'auto' });
    const run = store.createRun({ title: 't', workflow: workflow.name, task: 'Fix issue #642', steps: [] });
    store.updateRun(run.id, {
      worktree: false, status: 'review',
      harness: { profile: 'standard', workflow: workflow.name, issueId: '642' },
    });
    writeFileSync(join(root, 'unreviewed.txt'), 'must remain uncommitted\n');
    const before = git('rev-parse', 'HEAD');
    expect(await manager.land(run.id)).toMatchObject({ outcome: 'unavailable' });
    expect(git('rev-parse', 'HEAD')).toBe(before);
    expect(store.getRun(run.id)?.status).toBe('review');
  });

  it('fails before the driver can write when no isolated worktree can exist', async () => {
    rmSync(join(root, '.git'), { recursive: true, force: true });
    const run = manager.startRun(workflow, { task: 'Fix issue #642' });
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('failed'));
    expect(store.getRun(run.id)?.error).toContain('isolated git worktree');
    expect(runHarnessDriver).not.toHaveBeenCalled();
  });

  it('rejects read-only harness starts before creating a run', () => {
    expect(() => manager.startRun(workflow, { task: 'Fix issue #642', readOnly: true })).toThrow(/isolated git worktree|read-only/);
    expect(store.listRuns()).toEqual([]);
    expect(runHarnessDriver).not.toHaveBeenCalled();
  });

  it.each([{}, { multiModel: false }, { multiModel: 'true' }])('blocks new harness starts unless explicitly enabled (%j)', (value) => {
    config(value);
    expect(() => manager.startRun(workflow, { task: 'Fix issue #642' })).toThrow(/multiModel/);
    expect(store.listRuns()).toEqual([]);
  });

  it('hides user workflow files with reserved harness names when disabled', async () => {
    config({ multiModel: false });
    mkdirSync(join(root, '.ai/cezar/workflows'), { recursive: true });
    writeFileSync(join(root, '.ai/cezar/workflows/custom.yaml'), `name: ${HARNESS_FIX_ISSUE}\nsteps:\n  - id: run\n    prompt: '{{task}}'\n`);
    const catalog = await loadWorkflows(root);
    expect(catalog.workflows.map((item) => item.name)).not.toContain(HARNESS_FIX_ISSUE);
  });

  it('recovers a disabled harness with its private runtime and required companion skills', async () => {
    config({ multiModel: false, skillsRepos: [] });
    const run = store.createRun({ title: 't', workflow: workflow.name, task: 'Fix issue #642', steps: [] });
    store.updateRun(run.id, { status: 'failed', workflowDef: workflow, harness: { profile: 'standard', workflow: workflow.name, issueId: '642' } });
    let installed = false;
    vi.mocked(runHarnessDriver).mockImplementation(async (host) => {
      installed = await host.ensureSkill('cez-setup-harness');
      expect(existsSync(join(host.cwd, '.claude/skills/cez-setup-harness/SKILL.md'))).toBe(true);
      expect(existsSync(join(host.cwd, '.claude/skills/cez-harness/scripts/harness.mjs'))).toBe(true);
      return null;
    });

    expect(manager.continueRun(run.id)).toEqual({ ok: true });
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('done'), { timeout: 10_000 });
    expect(installed).toBe(true);
    expect(runHarnessDriver).toHaveBeenCalledOnce();
  }, 15_000);

  it('refuses to reopen completed packet leases as an unrestricted model session', () => {
    const run = store.createRun({ title: 't', workflow: workflow.name, task: 'Fix issue #642', steps: [] });
    store.updateRun(run.id, { status: 'review', workflowDef: workflow, harness: { profile: 'high-assurance', workflow: workflow.name } });
    const ledger = createLedger({ workflow: workflow.name, requestedProfile: 'high-assurance', subject: { kind: 'issue', id: '642', text: 'Fix issue #642' } });
    ledger.stage.status = 'staged';
    ledger.outcome = { status: 'ready', blockingReasons: [] };
    saveLedger(join(root, '.ai/cezar'), run.id, ledger);
    expect(manager.continueRun(run.id, { text: 'Change the accepted work.' })).toMatchObject({ ok: false, error: expect.stringContaining('new task') });
    expect(store.getRun(run.id)?.status).toBe('review');
    expect(store.getRun(run.id)?.steps).toEqual([]);
  });

  it('reconsiders high-assurance no-action outcomes before packet leases exist', () => {
    manager.dispose();
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    const run = store.createRun({ title: 't', workflow: workflow.name, task: 'Fix issue #642', steps: [] });
    store.updateRun(run.id, { status: 'done', workflowDef: workflow, harness: { profile: 'high-assurance', workflow: workflow.name } });
    const ledger = createLedger({ workflow: workflow.name, requestedProfile: 'high-assurance', subject: { kind: 'issue', id: '642', text: 'Fix issue #642' } });
    ledger.outcome = { status: 'no-action', blockingReasons: [] };
    saveLedger(join(root, '.ai/cezar'), run.id, ledger);

    expect(manager.continueRun(run.id, { text: 'New evidence reproduces the defect.' })).toEqual({ ok: true });

    expect(store.getRun(run.id)?.status).toBe('queued');
    expect(loadLedger(join(root, '.ai/cezar'), run.id)?.pendingMessages).toEqual([
      expect.objectContaining({ text: 'New evidence reproduces the defect.' }),
    ]);
    expect(store.getRun(run.id)?.steps).toEqual([]);
  });

  it.each(['failed', 'cancelled', 'review', 'done'] as const)('resumes a %s harness through its ledger while disabled', (status) => {
    manager.dispose();
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    config({ multiModel: false });
    const run = store.createRun({ title: 't', workflow: workflow.name, task: 'Fix issue #642', steps: [{ id: 'implement', kind: 'agent', name: 'Implement' }] });
    store.updateRun(run.id, { status, workflowDef: workflow, harness: { profile: 'standard', workflow: workflow.name, issueId: '642' } });
    store.updateStep(run.id, 'implement', { status: status === 'review' ? 'done' : status, sessionId: 'must-not-resume-model' });
    expect(manager.continueRun(run.id, { text: 'Complete the verified handoff.' })).toEqual({ ok: true });
    expect(store.getRun(run.id)?.status).toBe('queued');
    expect(store.getRun(run.id)?.steps.find((step) => step.id === 'implement')?.status).toBe(status === 'failed' || status === 'cancelled' ? 'pending' : 'done');
    expect(store.getRun(run.id)?.steps.some((step) => step.id.startsWith('continue-'))).toBe(false);
  });
});
