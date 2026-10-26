import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinWorktreeGitDir } from '../git-pin.js';
import { harnessDiff, preserveAndRestorePacket, resetIndexToHead } from './driver.js';

const script = new URL('../../vendor/skills/cez-harness/scripts/harness.mjs', import.meta.url).pathname;

describe('PR #925 review: Git recovery boundaries', () => {
  let root: string;
  let cwd: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'cez-driver-review-'));
    cwd = join(root, 'repo');
    fs.mkdirSync(cwd);
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'test');
    fs.mkdirSync(join(cwd, 'src'));
    fs.writeFileSync(join(cwd, 'src/a.txt'), 'base\n');
    fs.writeFileSync(join(cwd, 'untouched.txt'), 'untouched\n');
    git('add', '.');
    git('commit', '-qm', 'base');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const pin = () => pinWorktreeGitDir(cwd, join(cwd, '.git'));

  it('[round2-4] preserves new bytes in a numbered artifact when a partial patch already exists', async () => {
    pin();
    const patch = join(root, 'failed.patch');
    fs.writeFileSync(patch, 'partial old patch');
    fs.writeFileSync(`${patch}.1`, 'another prior recovery');
    fs.writeFileSync(join(cwd, 'src/a.txt'), 'bytes never saved before\n');
    const saved = await preserveAndRestorePacket(cwd, ['src'], patch);
    expect(saved).toBe(`${patch}.2`);
    expect(fs.readFileSync(saved ?? patch, 'utf8')).toContain('+bytes never saved before');
    expect(fs.readFileSync(patch, 'utf8')).toBe('partial old patch');
    expect(fs.readFileSync(`${patch}.1`, 'utf8')).toBe('another prior recovery');
    expect(git('diff', 'HEAD')).toBe('');
  });

  it('[round2-4] publishes a complete temporary patch by rename before restoring', async () => {
    pin();
    fs.writeFileSync(join(cwd, 'src/a.txt'), 'complete snapshot\n');
    const patch = join(root, 'failed.patch');
    const rename = fs.renameSync;
    const publish = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      expect(fs.readFileSync(from, 'utf8')).toContain('+complete snapshot');
      expect(fs.readFileSync(join(cwd, 'src/a.txt'), 'utf8')).toBe('complete snapshot\n');
      rename(from, to);
    });
    syncBuiltinESMExports();
    await preserveAndRestorePacket(cwd, ['src'], patch);
    expect(publish).toHaveBeenCalledOnce();
    expect(fs.readdirSync(root).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('guard: recovery preserves binary and new files, and leaves unrelated edits', async () => {
    pin();
    fs.writeFileSync(join(cwd, 'src/a.txt'), Buffer.from([0, 1, 2, 3]));
    fs.writeFileSync(join(cwd, 'src/new.txt'), 'new worker file\n');
    fs.writeFileSync(join(cwd, 'untouched.txt'), 'operator edit\n');
    const outside = join(root, 'outside');
    const patch = join(root, 'failed.patch');
    fs.writeFileSync(outside, 'keep');
    const saved = await preserveAndRestorePacket(cwd, ['src'], patch);
    expect(fs.readFileSync(saved ?? patch, 'utf8')).toContain('GIT binary patch');
    expect(fs.readFileSync(saved ?? patch, 'utf8')).toContain('+new worker file');
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
    expect(fs.readFileSync(join(cwd, 'src/a.txt'), 'utf8')).toBe('base\n');
    expect(fs.existsSync(join(cwd, 'src/new.txt'))).toBe(false);
    expect(fs.readFileSync(join(cwd, 'untouched.txt'), 'utf8')).toBe('operator edit\n');
  });

  it('[round2-8] sizes the subject asynchronously from the real index stat cache', async () => {
    pin();
    const trace = join(root, 'git.trace');
    vi.stubEnv('GIT_TRACE', trace);
    fs.writeFileSync(join(cwd, 'src/a.txt'), 'changed\n');
    const index = fs.readFileSync(join(cwd, '.git/index'));
    let yielded = false;
    setImmediate(() => { yielded = true; });
    const diff = await harnessDiff(cwd, [], join(root, 'scratch-index'));
    expect(diff.toString()).toContain('+changed');
    expect(yielded).toBe(true);
    expect(fs.readFileSync(trace, 'utf8')).not.toContain('read-tree HEAD');
    expect(fs.readFileSync(join(cwd, '.git/index'))).toEqual(index);
    expect(fs.existsSync(join(root, 'scratch-index'))).toBe(false);
  });

  it('guard: subject sizing includes staged, unstaged, deleted and intent-to-add paths without changing the real index', async () => {
    pin();
    fs.writeFileSync(join(cwd, 'src/a.txt'), 'staged\n');
    git('add', 'src/a.txt');
    fs.writeFileSync(join(cwd, 'src/a.txt'), 'unstaged final\n');
    fs.rmSync(join(cwd, 'untouched.txt'));
    fs.writeFileSync(join(cwd, 'new.txt'), 'untracked\n');
    git('add', '-N', 'new.txt');
    const index = fs.readFileSync(join(cwd, '.git/index'));
    const diff = (await harnessDiff(cwd, [], join(root, 'scratch-index'))).toString();
    expect(diff).toContain('+unstaged final');
    expect(diff).toContain('-untouched');
    expect(diff).toContain('+untracked');
    expect(diff).not.toContain('+staged\n');
    expect(fs.readFileSync(join(cwd, '.git/index'))).toEqual(index);
  });

  it('[round2-9] retains unchanged index stat entries while clearing superseded staging', () => {
    pin();
    const before = git('ls-files', '--debug', '--', 'untouched.txt');
    expect(before).not.toContain('mtime: 0:0');
    fs.writeFileSync(join(cwd, 'src/a.txt'), 'staged\n');
    git('add', 'src/a.txt');
    resetIndexToHead(cwd);
    expect(git('diff', '--cached')).toBe('');
    expect(git('ls-files', '--debug', '--', 'untouched.txt')).toBe(before);
  });

  it('guard: unmerged index fallback still passes real runtime verify and stage without reflog drift', () => {
    pin();
    const runtime = (op: string, ...args: string[]) => execFileSync(process.execPath, [script, op, '--worktree', cwd, ...args], { encoding: 'utf8' });
    const start = join(root, 'start.json');
    runtime('capture', '--output', start);
    const blob = git('rev-parse', 'HEAD:src/a.txt').trim();
    git('update-index', '--force-remove', 'src/a.txt');
    execFileSync('git', ['update-index', '--index-info'], {
      cwd, input: [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\tsrc/a.txt\n`).join(''),
    });
    expect(git('ls-files', '--unmerged')).not.toBe('');
    resetIndexToHead(cwd);
    expect(git('ls-files', '--unmerged')).toBe('');
    expect(JSON.parse(runtime('verify', '--start-state', start))).toMatchObject({ status: 'clean', drift: [] });
    fs.writeFileSync(join(cwd, 'src/a.txt'), 'handoff\n');
    const paths = join(root, 'paths.txt');
    fs.writeFileSync(paths, 'src/a.txt\n');
    expect(JSON.parse(runtime('stage', '--start-state', start, '--paths-file', paths))).toMatchObject({ status: 'ready', stagedPaths: ['src/a.txt'] });
  });

  it('[round2-11] refuses an unpinned diff before git can add worktree files', async () => {
    fs.writeFileSync(join(cwd, 'src/a.txt'), 'untrusted\n');
    const index = fs.readFileSync(join(cwd, '.git/index'));
    await expect(harnessDiff(cwd, [], join(root, 'scratch-index'))).rejects.toThrow('no pinned Git directory');
    expect(fs.readFileSync(join(cwd, '.git/index'))).toEqual(index);
    expect(fs.existsSync(join(root, 'scratch-index'))).toBe(false);
  });

  it('[round2-11] rejects a dangling symlink parent before preservation or restoration', async () => {
    pin();
    fs.rmSync(join(cwd, 'src'), { recursive: true });
    fs.symlinkSync(join(root, 'not-created'), join(cwd, 'src'));
    const patch = join(root, 'failed.patch');
    await expect(preserveAndRestorePacket(cwd, ['src/a.txt'], patch)).rejects.toThrow('symlink parent');
    expect(fs.lstatSync(join(cwd, 'src')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(patch)).toBe(false);
  });

  it('guard: an unpinned index reset leaves ordinary repository staging untouched', () => {
    fs.writeFileSync(join(cwd, 'src/a.txt'), 'ordinary staged edit\n');
    git('add', 'src/a.txt');
    const index = fs.readFileSync(join(cwd, '.git/index'));
    resetIndexToHead(cwd);
    expect(fs.readFileSync(join(cwd, '.git/index'))).toEqual(index);
  });
});
