import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * A harness worktree is written by sandboxed models, and a linked worktree's `.git` is a pointer
 * FILE inside it. A model that repoints it at a directory it controls makes every host-side git
 * call there load that repository's config — `core.fsmonitor` runs a program — in the unsandboxed
 * host (PR #925 review). Host-side git in such a worktree therefore resolves the repository from
 * the main checkout's own `worktrees/*` records, which no sandbox can write, and never from the
 * pointer. Only cezar's own git calls are pinned: an agent's or a test suite's environment must
 * never carry `GIT_DIR`, or a test that inits a scratch repo would commit into the task branch.
 */

/** The worktree's real gitdir, resolved from the main repository only; null when unknown. */
export function resolveTrustedGitDir(repoRoot: string, workTree: string): string | null {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const target = realpathSync(workTree);
    for (const name of readdirSync(join(common, 'worktrees'))) {
      const dir = join(common, 'worktrees', name);
      try {
        const back = readFileSync(join(dir, 'gitdir'), 'utf8').trim();
        const recorded = isAbsolute(back) ? back : resolve(dir, back);
        if (realpathSync(dirname(recorded)) === target) return dir;
      } catch {
        // a stale or half-written record names no live worktree
      }
    }
  } catch {
    // not a repository, or no linked worktrees: nothing to pin
  }
  return null;
}

/** The environment that makes git use `gitDir` for `workTree` without discovering anything. */
export function gitEnvFor(gitDir: string, workTree: string): Record<string, string> {
  return { GIT_DIR: gitDir, GIT_WORK_TREE: workTree, GIT_NO_REPLACE_OBJECTS: '1' };
}

const pinned = new Map<string, string>();

/** Pin `workTree` (by real path) to its trusted gitdir for every host-side git helper. */
export function pinWorktreeGitDir(workTree: string, gitDir: string): void {
  try {
    pinned.set(realpathSync(workTree), gitDir);
  } catch {
    // a worktree that does not exist has no git calls to pin
  }
}

/** The pinned git environment for `cwd` (the worktree or a directory inside it), if any. */
export function pinnedGitEnv(cwd: string): Record<string, string> | undefined {
  if (pinned.size === 0) return undefined;
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    return undefined;
  }
  for (const [tree, gitDir] of pinned) {
    if (real === tree || real.startsWith(tree + sep)) return gitEnvFor(gitDir, tree);
  }
  return undefined;
}

/**
 * Is `<workTree>/.git` still the pointer git wrote for `gitDir`? Restores it when it is not, and
 * reports the tampering so the caller can fail closed: a phase that rewrote it was reaching for
 * the host, not editing code.
 */
export function verifyWorktreeGitPointer(workTree: string, gitDir: string): { ok: true } | { ok: false; error: string } {
  const pointer = join(workTree, '.git');
  try {
    const stat = lstatSync(pointer);
    if (stat.isFile()) {
      const line = readFileSync(pointer, 'utf8').trim();
      const match = /^gitdir:\s*(.+)$/.exec(line);
      if (match) {
        const named = isAbsolute(match[1]!) ? match[1]! : resolve(workTree, match[1]!);
        if (realpathSync(named) === realpathSync(gitDir)) return { ok: true };
      }
    }
  } catch {
    // missing, unreadable or dangling: tampered all the same
  }
  try {
    rmSync(pointer, { recursive: true, force: true });
    writeFileSync(pointer, `gitdir: ${gitDir}\n`, 'utf8');
  } catch {
    // unwritable: the run still fails closed
  }
  return { ok: false, error: `the worktree's .git pointer was rewritten (${pointer}) — restored; refusing to continue` };
}
