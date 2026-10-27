import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pinWorktreeGitDir, pinnedGitEnv } from '../git-pin.js';
import { readHarnessFsEntry } from './fs-read.js';
import { harnessDiff, normalizeHarnessIndex, preserveAndRestorePacket, resetIndexToHead, snapshotHarnessReviewSubject, snapshotHarnessStageSubject } from './driver.js';

const script = new URL('../../vendor/skills/cez-harness/scripts/harness.mjs', import.meta.url).pathname;

// Real Git is required to reproduce rename and gitlink inference (PR #925 review).
describe('PR #925 review: round 9 path sets', { timeout: 60_000 }, () => {
  let root: string;
  let cwd: string;
  let gitDir: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 << 20 });
  const write = (path: string, content: string) => {
    fs.mkdirSync(join(cwd, path, '..'), { recursive: true }); fs.writeFileSync(join(cwd, path), content);
  };
  const runtime = (op: string, ...args: string[]) => spawnSync(process.execPath, [script, op, '--worktree', cwd, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, CEZ_HARNESS_GIT_DIR: gitDir, CEZ_HARNESS_GIT_WORK_TREE: cwd }, maxBuffer: 256 << 20,
  });
  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'cez-round9-')); cwd = join(root, 'repo'); fs.mkdirSync(cwd);
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@local');
    git('config', 'gc.auto', '0'); git('config', 'maintenance.auto', 'false');
    for (const path of ['src/a.txt', 'src/x', 'src/unchanged', 'outside/a', 'outside/b']) write(path, 'base\n');
    write('.gitignore', '.ai/\n'); git('add', '.'); git('commit', '-qm', 'base');
    const task = join(root, 'task'); git('worktree', 'add', '-q', '-b', 'task', task); cwd = task;
    gitDir = git('rev-parse', '--absolute-git-dir').trim(); pinWorktreeGitDir(cwd, gitDir);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const nested = (tracked = false) => {
    const path = join(cwd, 'sub'); fs.mkdirSync(path);
    const subgit = (...args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    subgit('init', '-q'); subgit('config', 'user.name', 'test'); subgit('config', 'user.email', 'test@local');
    const commit = (content: string) => { fs.writeFileSync(join(path, 'f'), content); subgit('add', '.'); subgit('commit', '-qm', content); return subgit('rev-parse', 'HEAD').trim(); };
    const first = commit('first\n');
    if (tracked) {
      write('.gitmodules', '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n');
      git('add', '.gitmodules', 'sub'); git('commit', '-qm', 'gitlink base');
      git('submodule', 'absorbgitdirs', 'sub');
      expect(fs.lstatSync(join(path, '.git')).isFile()).toBe(true);
    }
    return { subgit, commit, first };
  };

  const packet = (body: string, allowedPaths = ['src']) => {
    const worker = join(root, 'codex');
    fs.writeFileSync(worker, `#!${process.execPath}\nconst fs = require('node:fs'); const cp = require('node:child_process');\n${body}\n`, { mode: 0o755 });
    const risks = { low: 1, medium: 1, high: 1, critical: 1 };
    const config = join(root, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ agentHarness: {
      version: 1, delivery: { mode: 'stage-only' }, models: {
        worker: { family: 'openai', model: 'test', adapter: 'command', reasoningEffort: 'high', roles: ['worker'],
          workerSecurity: { network: 'disabled', remoteWrites: 'disabled', refWrites: 'disabled', enforcedBy: 'codex-workspace-write-sandbox' },
          commands: { worker: [worker, 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--config', 'model_reasoning_effort={reasoningEffort}', '--sandbox', 'workspace-write', '--cd', '{worktree}', '--model', '{model}', '-'] } },
        reviewer: { family: 'deepseek', model: 'test', adapter: 'command', roles: ['reviewer'],
          commands: { review: [process.execPath, '-e', 'process.stdout.write(JSON.stringify({verdict:"approve",findings:[],notes:[]}))'] } },
      }, profiles: { test: { workers: ['worker'], reviewers: ['reviewer'], reviewPolicy: { mode: 'all-required' }, packetPolicy: {
        mode: 'adversarial', reviewersByRisk: risks, minimumFamiliesByRisk: risks, verificationReviewers: 1,
        lenses: ['correctness'], separateFixer: true, maxFixCycles: 1, blockingSeverities: ['blocker', 'major'],
        budgets: { maxWorkerInvocations: 1, maxReviewerInvocations: 2, maxFixerInvocations: 1, maxReviewInputBytes: 1_000_000 },
      } } },
    } }));
    const manifest = join(root, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ version: 1, id: 'scope', title: 'scope', objective: 'edit src only', risk: 'low', allowedPaths,
      invariants: ['preserve other paths'], acceptanceCriteria: ['scope respected'] }));
    const result = runtime('packet-run', '--config', config, '--profile', 'test', '--manifest', manifest, '--run-dir', join(cwd, '.ai/packet'));
    expect(result.stdout, result.stderr).not.toBe('');
    return JSON.parse(result.stdout) as { status: string; error?: string };
  };

  it.each(['staged', 'intent-to-add'] as const)('[r9-scope] packet detects a %s move from outside into its allowed directory', (kind) => {
    const result = packet(`cp.execFileSync('git', ['mv', 'outside/a', 'src/moved']);
${kind === 'intent-to-add' ? "cp.execFileSync('git', ['reset', '-q', 'HEAD', '--', 'outside/a', 'src/moved']); cp.execFileSync('git', ['add', '-N', 'src/moved']);" : ''}`);
    expect(result.status).toBe('blocked');
    expect(result.error).toContain('changed paths outside its lease: outside/a');
  });

  it('guard: [r9-scope] an in-scope move still reaches validation', () => {
    expect(packet("cp.execFileSync('git', ['mv', 'src/x', 'src/moved']);")).toMatchObject({ status: 'awaiting_validation' });
  });

  it('[r9-stage-scope] the real runtime refuses a rename whose source is outside the stage allowlist', () => {
    const start = join(root, 'start.json'); expect(runtime('capture', '--output', start).status).toBe(0);
    git('mv', 'outside/a', 'src/moved');
    const paths = join(root, 'paths'); fs.writeFileSync(paths, 'src/moved\n');
    const result = runtime('stage', '--start-state', start, '--paths-file', paths);
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('Staged paths outside allowlist: outside/a');
  });

  it('guard: [r9-rename-bytes] reviewer diffs retain rename headers and equal the staged bytes', async () => {
    const start = join(root, 'start.json'); expect(runtime('capture', '--output', start).status).toBe(0);
    git('mv', 'src/x', 'src/y');
    const paths = join(root, 'paths'); fs.writeFileSync(paths, 'src/x\nsrc/y\n');
    const config = join(root, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ agentHarness: { version: 1, delivery: { mode: 'stage-only' }, models: {}, profiles: {} } }));
    const reviewed = await harnessDiff(cwd, ['src/x', 'src/y'], join(root, 'subject.index'));
    expect(reviewed.toString()).toContain('rename from src/x\nrename to src/y');
    const prepared = runtime('prepare-review', '--config', config, '--kind', 'spec', '--paths-file', paths, '--output', join(root, 'review.json'));
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(JSON.parse(prepared.stdout).subjectSha256).toBe(createHash('sha256').update(reviewed).digest('hex'));
    expect(runtime('stage', '--start-state', start, '--paths-file', paths).status).toBe(0);
    expect(Buffer.from(git('diff', '--cached', '--no-ext-diff', '--binary', 'HEAD', '--'))).toEqual(reviewed);
  });

  it.each([false, true])('[r9-packet-gitlink] packet detects commit movement in an outside gitlink (tracked=%s)', (tracked) => {
    const sub = nested(tracked); const before = tracked ? sub.commit('second\n') : sub.first;
    const after = sub.commit('third\n'); sub.subgit('reset', '--hard', before);
    const result = packet(`cp.execFileSync('git', ['-C', 'sub', 'reset', '--hard', ${JSON.stringify(after)}]); fs.writeFileSync('src/x', 'edit\\n');`);
    expect(result.status).toBe('blocked'); expect(result.error).toContain('changed paths outside its lease: sub');
  });

  it.each([false, true])('guard: [r9-packet-gitlink] an unchanged outside gitlink permits an in-scope edit (tracked=%s)', (tracked) => {
    const sub = nested(tracked); if (tracked) sub.commit('second\n');
    expect(packet("fs.writeFileSync('src/x', 'edit\\n');")).toMatchObject({ status: 'awaiting_validation' });
  });

  it.each(['spanning', 'only outside', 'sparse-index'])('[r9-restore] restores a packet with absent skip-worktree entries: %s', async (kind) => {
    git('sparse-checkout', 'set', '--cone', ...(kind === 'sparse-index' ? ['--sparse-index'] : []), 'src');
    const paths = kind === 'only outside' ? ['outside'] : ['src', 'outside'];
    if (kind !== 'only outside') write('src/a.txt', 'inside edit\n');
    write('outside/new', 'packet addition\n');
    const artifact = join(root, 'packet.patch');
    expect(await preserveAndRestorePacket(cwd, paths, artifact)).toBe(artifact);
    expect(fs.readFileSync(artifact, 'utf8')).toContain('packet addition');
    expect(fs.readFileSync(join(cwd, 'src/a.txt'), 'utf8')).toBe('base\n');
    expect(fs.existsSync(join(cwd, 'outside/new'))).toBe(false);
    for (const path of ['outside/a', 'outside/b']) expect(fs.existsSync(join(cwd, path))).toBe(false);
    expect(git('status', '--porcelain')).toBe('');
  });

  it.each(['full', 'sparse materialized'])('guard: [r9-restore] restores existing entries and removes packet additions: %s', async (kind) => {
    if (kind === 'sparse materialized') git('sparse-checkout', 'set', '--cone', 'src');
    write('outside/a', 'edit\n'); write('outside/new', 'packet addition\n');
    if (kind === 'sparse materialized') write('outside/b', 'base\n');
    expect(await preserveAndRestorePacket(cwd, ['outside'], join(root, 'packet.patch'))).toBe(join(root, 'packet.patch'));
    expect(fs.readFileSync(join(cwd, 'outside/a'), 'utf8')).toBe('base\n');
    expect(fs.existsSync(join(cwd, 'outside/new'))).toBe(false);
  });

  it('guard: [r9-restore] an in-cone packet leaves out-of-cone files absent', async () => {
    git('sparse-checkout', 'set', '--cone', 'src'); write('src/a.txt', 'edit\n'); write('src/new', 'addition\n');
    await preserveAndRestorePacket(cwd, ['src'], join(root, 'packet.patch'));
    expect(fs.readFileSync(join(cwd, 'src/a.txt'), 'utf8')).toBe('base\n');
    expect(fs.existsSync(join(cwd, 'src/new'))).toBe(false);
    for (const path of ['outside/a', 'outside/b']) expect(fs.existsSync(join(cwd, path))).toBe(false);
  });

  it.each([false, true])('[r9-gitlink] snapshots change when the nested commit moves (tracked=%s)', async (tracked) => {
    const sub = nested(tracked); if (tracked) sub.commit('second\n');
    const index = fs.readFileSync(join(gitDir, 'index'));
    const before = [await snapshotHarnessStageSubject(cwd), await snapshotHarnessReviewSubject(cwd)];
    sub.commit('third\n');
    const after = [await snapshotHarnessStageSubject(cwd), await snapshotHarnessReviewSubject(cwd)];
    expect.soft(after[0], 'stage snapshot must bind the gitlink commit').not.toBe(before[0]);
    expect.soft(after[1], 'review snapshot must bind the gitlink commit').not.toBe(before[1]);
    expect(fs.readFileSync(join(gitDir, 'index'))).toEqual(index);
  });

  it.each([false, true])('guard: [r9-gitlink] unchanged nested commits hash identically twice (tracked=%s)', async (tracked) => {
    const sub = nested(tracked); if (tracked) sub.commit('second\n');
    expect(await snapshotHarnessStageSubject(cwd)).toBe(await snapshotHarnessStageSubject(cwd));
    expect(await snapshotHarnessReviewSubject(cwd)).toBe(await snapshotHarnessReviewSubject(cwd));
  });

  // Pin the a01241ec serialization independently of the new gitlink hash (PR #925 review).
  const baselineHash = (review: boolean) => {
    const hash = createHash('sha256');
    const baselineGit = (args: string[], env?: Record<string, string>) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...pinnedGitEnv(cwd), ...env }, maxBuffer: 256 << 20,
    });
    hash.update('\0head\0'); hash.update(baselineGit(['rev-parse', 'HEAD']));
    const temporary = fs.mkdtempSync(join(gitDir, 'baseline-index-')); let status: Buffer;
    try {
      const index = join(temporary, 'index'); const realIndex = join(gitDir, 'index'); const { atime, mtime } = fs.statSync(realIndex);
      fs.copyFileSync(realIndex, index); fs.utimesSync(index, atime, mtime);
      const privateGit = (args: string[]) => baselineGit(['-c', 'core.splitIndex=false', '-c', 'advice.sparseIndexExpanded=false', ...args], { GIT_INDEX_FILE: index });
      normalizeHarnessIndex(cwd, privateGit);
      status = privateGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    for (const path of status.toString('utf8').split('\0').filter(Boolean).map((entry) => entry.slice(3)).sort()) {
      hash.update('\0'); hash.update(path); hash.update('\0');
      try {
        const entry = readHarnessFsEntry(join(cwd, path));
        if (entry.kind === 'symlink') hash.update(`symlink:${entry.target}`);
        else if (entry.kind === 'file') { hash.update(`file:${entry.stat.mode & 0o111 ? 'executable' : 'regular'}\0`); hash.update(entry.content!); }
        else hash.update(`mode:${entry.stat.mode}`);
      } catch { hash.update('absent'); }
    }
    if (review) { hash.update('\0head-reflog\0'); hash.update(baselineGit(['reflog', 'show', 'HEAD', '--format=%H%x09%gs'])); }
    return hash.digest('hex');
  };

  const states = [
    'plain edit', 'MM', 'touched staged', 'intent-to-add', 'staged new edited',
    'assume-unchanged edited', 'assume-unchanged deleted', 'assume-unchanged dangling symlink',
    'skip-worktree edited non-sparse', 'skip-worktree deleted non-sparse',
    'sparse edit', 'sparse MM', 'sparse MM second Continue', 'sparse dangling symlink', 'sparse assume-unchanged dangling symlink',
  ];
  it.each(states)('guard: [r9-hash] non-gitlink hashes equal a01241ec: %s', async (state) => {
    const sparse = state.startsWith('sparse');
    if (sparse) git('sparse-checkout', 'set', '--cone', 'src');
    write('src/x', 'visible edit\n');
    const target = ['intent-to-add', 'staged new edited'].includes(state) ? 'src/new' : 'src/a.txt';
    if (state.includes('assume-unchanged')) git('update-index', '--assume-unchanged', target);
    if (state.includes('skip-worktree')) git('update-index', '--skip-worktree', target);
    write(target, 'final edit\n');
    if (state.includes('MM') || ['touched staged', 'staged new edited'].includes(state)) {
      git('add', target);
      if (state === 'touched staged') { const future = new Date(Date.now() + 10_000); fs.utimesSync(join(cwd, target), future, future); }
      else write(target, 'edited after staging\n');
    }
    if (state === 'intent-to-add') git('add', '-N', target);
    if (state.includes('deleted')) fs.rmSync(join(cwd, target));
    if (state.includes('dangling symlink')) {
      fs.rmSync(join(cwd, target)); fs.symlinkSync('missing-target', join(cwd, target));
      if (sparse) git('update-index', '--skip-worktree', target);
    }
    for (let attempt = 0; attempt < (state.includes('second Continue') ? 2 : 1); attempt += 1) {
      expect(await snapshotHarnessStageSubject(cwd)).toBe(baselineHash(false));
      expect(await snapshotHarnessReviewSubject(cwd)).toBe(baselineHash(true));
      expect(resetIndexToHead(cwd)).toBeUndefined();
    }
  });

  it('guard: [r9-stage] edits, adds and deletes retain their staged paths and subject hashes', async () => {
    const start = join(root, 'start.json'); expect(runtime('capture', '--output', start).status).toBe(0);
    write('src/a.txt', 'edited\n'); write('src/new', 'new\n'); fs.rmSync(join(cwd, 'src/x'));
    const before = await snapshotHarnessStageSubject(cwd); expect(before).toBe(baselineHash(false));
    const paths = join(root, 'paths'); fs.writeFileSync(paths, 'src/a.txt\nsrc/new\nsrc/x\n');
    const result = runtime('stage', '--start-state', start, '--paths-file', paths);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'ready', stagedPaths: ['src/a.txt', 'src/new', 'src/x'] });
    expect(await snapshotHarnessStageSubject(cwd)).toBe(before);
  });
});
