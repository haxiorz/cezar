import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHarnessDriver } from '../harness/driver.ts';
import { acquireIssueClaim } from '../harness/issue-claim.ts';
import { createLedger, loadLedger, saveLedger } from '../harness/ledger.ts';
import { harnessWorkflowDefs, HARNESS_FIX_ISSUE } from '../harness/workflows.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';

vi.mock('../harness/driver.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harness/driver.ts')>()),
  runHarnessDriver: vi.fn(async () => null),
}));

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const workflow = harnessWorkflowDefs().find((item) => item.name === HARNESS_FIX_ISSUE)!;

// PR #925 review: an ending that never reaches the driver skipped its claim release, so a run
// recovered after a crash and cancelled from the queue kept the issue blocked for good.
describe('a harness run that ends without its driver', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  const dataDir = () => join(root, '.ai/cezar');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    root = mkdtempSync(join(tmpdir(), 'cez-claim-endings-'));
    mkdirSync(dataDir(), { recursive: true });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(root, '.gitignore'), '.ai/cezar/\n');
    git('add', '.gitignore');
    git(...GIT_ID, 'commit', '-q', '-m', 'base');
    writeFileSync(join(dataDir(), 'config.json'), JSON.stringify({ multiModel: true, skillsRepos: [], branchNaming: { enabled: false } }));
    store = RunStore.open(dataDir());
    // No free slot: a queued run stays queued, so the cancel lands on the queue branch.
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    vi.mocked(runHarnessDriver).mockReset();
    vi.mocked(runHarnessDriver).mockResolvedValue(null);
  });

  afterEach(() => {
    for (const run of store.listRuns()) manager.cancel(run.id);
    manager.dispose();
    store.flush();
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const claimedRun = (stage: 'pending' | 'staged') => {
    const run = store.createRun({ title: 't', workflow: workflow.name, task: 'Fix issue #642', steps: [] });
    store.updateRun(run.id, {
      status: 'running',
      workflowDef: workflow,
      harness: { profile: 'standard', workflow: workflow.name, issueId: '642' },
    });
    const ledger = createLedger({ workflow: workflow.name, requestedProfile: 'standard', subject: { kind: 'issue', id: '642', text: 'Fix issue #642' } });
    const claimed = acquireIssueClaim(root, run.id, '642', { dataDir: dataDir(), runExists: () => true });
    if (!claimed.ok) throw new Error(claimed.error);
    ledger.claim = { held: true, issueId: '642', path: claimed.claim.path };
    ledger.stage = stage === 'staged' ? { status: 'staged', prBody: 'body' } : { status: 'pending' };
    saveLedger(dataDir(), run.id, ledger);
    return { run, claimPath: claimed.claim.path };
  };

  it('releases the claim when a recovered run is cancelled from the queue', async () => {
    const { run, claimPath } = claimedRun('pending');
    await manager.recover();
    expect(store.getRun(run.id)?.status).toBe('queued');

    expect(manager.cancel(run.id)).toBe(true);

    expect(loadLedger(dataDir(), run.id)?.claim?.held).toBe(false);
    expect(existsSync(claimPath)).toBe(false);
    expect(acquireIssueClaim(root, 'fresh-run', '642', { dataDir: dataDir(), runExists: (id) => id === run.id }).ok).toBe(true);
  });

  it('keeps the claim of a run parked on its staged handoff', async () => {
    const { run, claimPath } = claimedRun('staged');
    await manager.recover();
    expect(manager.cancel(run.id)).toBe(true);
    expect(loadLedger(dataDir(), run.id)?.claim?.held).toBe(true);
    expect(existsSync(claimPath)).toBe(true);
  });
});
