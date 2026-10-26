import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec, RunnerId } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import * as profiles from '../workspace/agent-profiles.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const sessions = vi.hoisted(() => [] as { backend: RunnerId; prompt: string; emit: (event: AgentEvent) => void }[]);
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: (backend: RunnerId) => ({
    startSession: (spec: AgentRunSpec, onEvent: (event: AgentEvent) => void) => {
      if (spec.userPrompt === 'throw') throw new Error('launch failed');
      let finish: () => void = () => {};
      let open = true;
      const result = new Promise<AgentRunResult>((resolve) => {
        finish = () => { open = false; resolve({ text: '', toolCalls: [], tokensUsed: 0 }); };
      });
      sessions.push({ backend, prompt: spec.userPrompt, emit: onEvent });
      return { result, get open() { return open; }, sendMessage: () => true, end: finish, interrupt: finish };
    },
  }),
}));

const TASK: WorkflowDef = { name: 'one-step', source: 'file', steps: [{ id: 'work', prompt: '{{task}}' }] };
const LIMIT = 'Codex usage limit reached. Try again in 3 hours.';

describe('council session ownership (PR #925 review)', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let runId: string;
  type State = { currentStepId?: string; usageLimitedAccount?: string };
  let internals: {
    active: Map<string, State>;
    runAgentStep: (...args: unknown[]) => Promise<string | null>;
    scheduleAutoResumeIfLimited: (id: string, account?: string) => void;
  };
  let state: State;

  beforeEach(async () => {
    sessions.length = 0;
    root = mkdtempSync(join(tmpdir(), 'cez-council-accounts-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'a\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root);
    runId = manager.startRun(TASK, { task: 'hold', runner: 'claude', worktree: false }).id;
    await expect.poll(() => sessions.length).toBe(1);
    internals = manager as unknown as typeof internals;
    state = internals.active.get(runId)!;
    store.updateRun(runId, { harness: { workflow: 'harness-fix-issue', profile: 'multi', issueId: '1' } });
    store.addStep(runId, { id: 'council', name: 'Council', kind: 'agent' });
    vi.spyOn(profiles, 'resolveProfileEnvForRoot').mockImplementation(async (_, provider) => ({
      profile: { ...profiles.defaultAgentProfile(provider), id: 'resolved-work' }, env: {},
    }));
  });

  afterEach(async () => {
    manager.cancel(runId);
    await expect.poll(() => manager.isActive(runId)).toBe(false);
    manager.dispose();
    vi.restoreAllMocks();
    store.flush();
    rmSync(root, { recursive: true, force: true });
  });

  function phase(backend: RunnerId, prompt: string = backend) {
    const resultPath = join(root, `${backend}.json`);
    writeFileSync(resultPath, '{}');
    return internals.runAgentStep(runId, state, { id: 'council', prompt, runner: backend },
      { task: 'x', worktree: false }, [], null, false,
      (event: { type: string; [key: string]: unknown }) => store.appendEvent(runId, event),
      undefined, 'claude', undefined, undefined, [], undefined,
      { concurrent: true, resultPath, timeoutMs: 20_000 });
  }

  it('holds the first reviewer account when a different backend spawned last', async () => {
    const codex = phase('codex');
    await expect.poll(() => sessions.length).toBe(2);
    const claude = phase('claude');
    await expect.poll(() => sessions.length).toBe(3);
    expect(store.getRun(runId)?.steps.find((s) => s.id === 'council')?.backend).toBe('claude');

    sessions[1]!.emit({ type: 'error', message: LIMIT });
    expect(await codex).toBe(LIMIT);
    sessions[2]!.emit({ type: 'turn-end' });
    await claude;
    store.updateStep(runId, 'council', { status: 'failed', error: `quorum failed: ${LIMIT}` });
    store.updateRun(runId, { status: 'failed', error: `quorum failed: ${LIMIT}` });
    internals.scheduleAutoResumeIfLimited(runId, state.usageLimitedAccount);

    expect(store.getRun(runId)?.autoResumeAccount).toBe('codex:default');
    expect(manager.accountHolds().deadline).toEqual(new Set(['codex:default']));
  });

  it('does not retire a limit when another reviewer completes a turn', async () => {
    const claude = phase('claude');
    await expect.poll(() => sessions.length).toBe(2);
    const codex = phase('codex');
    await expect.poll(() => sessions.length).toBe(3);
    store.updateRun(runId, { autoResumeAccount: 'codex:default', autoResumeAttempts: 1 });

    sessions[1]!.emit({ type: 'turn-end' });
    await claude;
    expect(store.getRun(runId)?.autoResumeAttempts).toBe(1);
    expect(manager.accountHolds().inFlight).toEqual(new Set(['codex:default']));
    sessions[2]!.emit({ type: 'turn-end' });
    await codex;
    expect(store.getRun(runId)?.autoResumeAttempts).toBeUndefined();
  });

  it('schedules an advisor-only limit without attributing an account', () => {
    store.updateStep(runId, 'council', { status: 'failed', backend: 'claude', profileId: 'resolved-work', error: LIMIT });
    store.updateRun(runId, { status: 'failed', error: `advisor failed: ${LIMIT}` });
    internals.scheduleAutoResumeIfLimited(runId);
    expect(store.getRun(runId)?.autoResumeAt).toBeDefined();
    expect(store.getRun(runId)?.autoResumeAccount).toBeUndefined();
    expect(manager.accountHolds().deadline.size).toBe(0);
    store.updateRun(runId, { status: 'queued', autoResumeAt: undefined, autoResumeAttempts: 1 });
    expect(manager.accountHolds().inFlight.size).toBe(0);
  });

  it.each([
    { runner: 'codex' as const, override: undefined, key: 'codex:default' },
    { runner: 'codex' as const, override: 'personal', key: 'codex:personal' },
    { runner: 'claude' as const, override: 'personal', key: 'codex:default' },
  ])('normalizes a phase limit and its proof to the ordinary scheme ($runner/$override)', async ({ runner, override, key }) => {
    store.updateRun(runId, { runner, agentProfile: override });
    const limited = phase('codex');
    await expect.poll(() => sessions.length).toBe(2);
    sessions[1]!.emit({ type: 'error', message: LIMIT });
    await limited;
    expect(store.getRun(runId)?.steps.find((step) => step.id === 'council')?.profileId).toBe('resolved-work');
    expect(state.usageLimitedAccount).toBe(key);
    expect(store.getRun(runId)?.autoResumeAccount).toBe(key);
    store.updateRun(runId, { autoResumeAttempts: 1 });
    const proof = phase('codex');
    await expect.poll(() => sessions.length).toBe(3);
    sessions[2]!.emit({ type: 'turn-end' });
    await proof;
    expect(store.getRun(runId)?.autoResumeAttempts).toBeUndefined();
    expect(store.getRun(runId)?.autoResumeAccount).toBeUndefined();
  });

  it('forgets a prior session limit once that account proves its window before an advisor fails', async () => {
    const limited = phase('codex');
    await expect.poll(() => sessions.length).toBe(2);
    sessions[1]!.emit({ type: 'error', message: LIMIT });
    await limited;
    expect(state.usageLimitedAccount).toBe('codex:default');
    const retry = phase('codex');
    await expect.poll(() => sessions.length).toBe(3);
    sessions[2]!.emit({ type: 'turn-end' });
    await retry;
    expect(state.usageLimitedAccount).toBeUndefined();
    expect(store.getRun(runId)?.autoResumeAccount).toBeUndefined();
    store.updateRun(runId, { status: 'failed', error: `advisor failed: ${LIMIT}` });
    internals.scheduleAutoResumeIfLimited(runId, state.usageLimitedAccount);
    expect(store.getRun(runId)?.autoResumeAt).toBeDefined();
    expect(store.getRun(runId)?.autoResumeAccount).toBeUndefined();
    expect(manager.accountHolds().deadline.size).toBe(0);
  });

  it('keeps the run current step owned by the non-concurrent session', async () => {
    expect(state.currentStepId).toBe('work');
    const reviewer = phase('codex');
    await expect.poll(() => sessions.length).toBe(2);
    expect(state.currentStepId).toBe('work');
    sessions[1]!.emit({ type: 'turn-end' });
    await reviewer;
    expect(state.currentStepId).toBe('work');
  });

  it('preserves the current step when a concurrent launch fails', async () => {
    expect(await phase('codex', 'throw')).toBe('launch failed');
    expect(state.currentStepId).toBe('work');
  });
});
