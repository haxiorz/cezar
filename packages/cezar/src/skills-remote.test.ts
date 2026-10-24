import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bareDirFor, excludeFromGit, isPinnedSha, shouldPassiveFetch } from './skills-remote.ts';

const TTL = 6 * 60 * 60 * 1_000;

describe('shouldPassiveFetch', () => {
  it('fetches on the first passive touch this process', () => {
    // A clone left by an earlier run must be refreshed on first read, else a
    // long-running server serves whatever ref that old clone happened to have.
    expect(shouldPassiveFetch({ attempted: false, fetchedAt: 0, now: 1_000, ttlMs: TTL })).toBe(true);
  });

  it('does not re-fetch within the TTL once touched', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ attempted: true, fetchedAt: now - 60_000, now, ttlMs: TTL })).toBe(false);
  });

  it('re-fetches once the last fetch is older than the TTL', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ attempted: true, fetchedAt: now - TTL - 1, now, ttlMs: TTL })).toBe(true);
  });

  it('treats exactly-TTL as still fresh (strictly greater re-fetches)', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ attempted: true, fetchedAt: now - TTL, now, ttlMs: TTL })).toBe(false);
  });
});

describe('bareDirFor', () => {
  it('keys the global cache on owner__name regardless of URL shape', () => {
    const expected = bareDirFor('open-mercato/skills');
    expect(bareDirFor('https://github.com/open-mercato/skills.git')).toBe(expected);
    expect(bareDirFor('git@github.com:open-mercato/skills')).toBe(expected);
    expect(expected.endsWith('open-mercato__skills')).toBe(true);
  });
});

describe('isPinnedSha', () => {
  it('accepts 40- and 64-hex, rejects branch names', () => {
    expect(isPinnedSha('a'.repeat(40))).toBe(true);
    expect(isPinnedSha('b'.repeat(64))).toBe(true);
    expect(isPinnedSha('main')).toBe(false);
  });
});

// PR #925 review: the materializer stopped reaching this bail-out, so its old test passed either way.
describe('excludeFromGit', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-exclude-'));
    dirs.push(dir);
    return dir;
  };

  it('never fabricates a .git in a folder that is not a repository', async () => {
    const plain = tmp();
    await excludeFromGit(plain, '.claude/skills/x/');
    expect(existsSync(join(plain, '.git'))).toBe(false);
  });

  it('writes the shared info/exclude of a real repository', async () => {
    const repo = tmp();
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await excludeFromGit(repo, '.claude/skills/x/');
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.claude/skills/x/');
  });
});
