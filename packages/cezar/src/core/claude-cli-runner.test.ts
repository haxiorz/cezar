import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import { isSignalTerminationExit, prependSystemPrompt } from './agent-runner.ts';
import {
  buildClaudeArgs,
  CLAUDE_HEADLESS_GUIDANCE,
  ClaudeCliRunner,
  appendClaudeSystemPrompt,
  claudeExitMessage,
  EOF_KILL_GRACE_MS,
  EOF_TERM_GRACE_MS,
  KILL_GRACE_MS,
} from './claude-cli-runner.ts';
import type { UiEvent } from './ui-events.ts';

/** Only the escalation tests below swap the child out; every other test in this
 *  file keeps spawning its real stub binary through the untouched `spawn`. */
const spawnHook = vi.hoisted(() => ({ override: null as null | (() => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override() : actual.spawn(...args),
  };
});

/** Records tree teardowns instead of performing them, but only while a fake
 *  child is installed — the real-process tests in this file need the real
 *  teardown. See the teardown describe below for why a fake child must never
 *  reach `process.kill`. */
const treeHook = vi.hoisted(() => ({
  recording: false,
  calls: [] as Array<[unknown, number]>,
  /** Children whose group escalation timer actually fired. */
  escalations: [] as unknown[],
}));

vi.mock('./process-tree.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./process-tree.ts')>();
  return {
    ...actual,
    terminateAgentProcessTree: (child: never, graceMs: number) => {
      if (!treeHook.recording) return actual.terminateAgentProcessTree(child, graceMs);
      treeHook.calls.push([child, graceMs]);
      return setTimeout(() => treeHook.escalations.push(child), graceMs);
    },
  };
});

/**
 * The per-backend system-prompt delivery mechanism (spec §protocol v2
 * mapping table): claude gets `--append-system-prompt`, codex/opencode get
 * the prompt prepended to the opening user message (`prependSystemPrompt`,
 * shared by both runners).
 */
describe('buildClaudeArgs systemPrompt', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('emits --append-system-prompt with the exact text', () => {
    const args = buildClaudeArgs({ ...spec, systemPrompt: 'Extra rules.\n\n---\n\nContract.' });
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(appendClaudeSystemPrompt('Extra rules.\n\n---\n\nContract.'));
  });

  it('always appends Claude-local headless denial guidance', () => {
    const args = buildClaudeArgs(spec);
    const idx = args.indexOf('--append-system-prompt');
    expect(args[idx + 1]).toBe(CLAUDE_HEADLESS_GUIDANCE);
  });

  it('preserves caller instructions before the backend guidance', () => {
    expect(appendClaudeSystemPrompt('Caller rules.')).toBe(
      `Caller rules.\n\n---\n\n${CLAUDE_HEADLESS_GUIDANCE}`,
    );
  });

  it('uses the same guidance for a resumed call without changing resume args', () => {
    const initial = buildClaudeArgs({ ...spec, sessionId: 'session-1' });
    const resumed = buildClaudeArgs({ ...spec, sessionId: 'session-1', resume: true });
    expect(initial[initial.indexOf('--append-system-prompt') + 1]).toBe(CLAUDE_HEADLESS_GUIDANCE);
    expect(resumed[resumed.indexOf('--append-system-prompt') + 1]).toBe(CLAUDE_HEADLESS_GUIDANCE);
    expect(initial).toContain('--session-id');
    expect(resumed).toContain('--resume');
  });
});

describe('buildClaudeArgs output mode', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('runs in print mode, which both stream-json formats require', () => {
    expect(buildClaudeArgs(spec)).toContain('--print');
  });

  it('asks for partial messages so text streams as deltas', () => {
    expect(buildClaudeArgs(spec)).toContain('--include-partial-messages');
  });
});

describe('buildClaudeArgs approval gate', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('denies unapproved tools without prompting by default', () => {
    const args = buildClaudeArgs(spec, {});
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('dontAsk');
  });

  it('enables Claude approval prompts only when explicitly requested', () => {
    const args = buildClaudeArgs(spec, { CEZ_APPROVAL_GATE: '1' });
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('acceptEdits');
  });

  it('loads only the invocation policy for stage-only harness sessions', () => {
    const args = buildClaudeArgs({
      ...spec,
      env: { CEZ_HARNESS_CLAUDE_SETTINGS: '/tmp/harness-settings.json' },
    });
    expect(args.slice(args.indexOf('--settings'), args.indexOf('--settings') + 4)).toEqual([
      '--settings',
      '/tmp/harness-settings.json',
      '--setting-sources',
      '',
    ]);
  });
});

/**
 * #703 — a session cezar tore down itself must not settle as an agent
 * failure. Every agent CLI installs its own stop-signal handler and exits
 * `128 + signal`, so the runner sees a NON-ZERO code for a teardown it
 * asked for (goal achieved → `end()`, or a user cancel → `interrupt()`).
 */
describe('isSignalTerminationExit', () => {
  it('recognizes the 128+signal codes a signalled CLI reports', () => {
    expect(isSignalTerminationExit(130)).toBe(true); // SIGINT
    expect(isSignalTerminationExit(137)).toBe(true); // SIGKILL
    expect(isSignalTerminationExit(143)).toBe(true); // SIGTERM
  });

  it('leaves genuine failures and clean exits alone', () => {
    for (const code of [0, 1, 2, 127, null]) {
      expect(isSignalTerminationExit(code)).toBe(false);
    }
  });
});

describe('a teardown cezar initiated', () => {
  const stubBin = fileURLToPath(
    new URL('./__fixtures__/claude/stub-ignores-eof-exits-143.mjs', import.meta.url),
  );

  it('settles the session instead of failing it when the CLI exits 143', async () => {
    const runner = new ClaudeCliRunner({ bin: stubBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const uiEvents: UiEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      { userPrompt: 'do it', cwd: process.cwd() },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
      { onUiEvent: (event) => uiEvents.push(event) },
    );
    await firstText;

    // The cancel path; the EOF watchdog reaches the same `signalChild`.
    session.interrupt();
    const result = await session.result;

    expect(result.text).toBe('work done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(
      uiEvents.some((event) => event.type === 'turn.completed' && event.stopReason === 'error'),
    ).toBe(false);
    expect(uiEvents).toContainEqual({
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
    });
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(
      events.some((e) => e.type === 'note' && e.message.includes('terminated by cezar (code 143)')),
    ).toBe(true);
  }, 15_000);
});

/**
 * #844 — the watchdogs used to ask `!child.killed` before tearing down, but Node
 * sets `killed` the moment a signal is *delivered*. claude installs its own
 * SIGTERM handler, so the flag went true while the process ran on and the
 * teardown that exists for exactly that case was skipped — one leaked CLI per
 * teardown. Every watchdog now follows real termination instead.
 *
 * The teardown itself is `terminateAgentProcessTree` (group SIGTERM, then a
 * group-liveness-checked SIGKILL), and it is asserted here as a call rather than
 * as signals: the module is mocked because a fake child's made-up pid would
 * otherwise have `process.kill(-pid)` signal a real process group on the host.
 * The escalation inside it is exercised against real processes in
 * `process-tree.test.ts`.
 */
describe('teardown for a CLI that survives SIGTERM', () => {
  function signallableChild(): {
    child: ChildProcessWithoutNullStreams;
    exit: (code: number) => void;
  } {
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      // Node's semantics: delivery flips `killed`; a CLI with its own handler
      // keeps running with `exitCode` still null. Pre-set here, because that is
      // the state an earlier signal leaves behind and the one the old guard
      // silently treated as "already dead".
      killed: true,
      pid: 4242,
      kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;
    const exit = (code: number) => {
      Object.assign(child, { exitCode: code });
      emitter.emit('exit', code, null);
    };
    return { child, exit };
  }

  function withFakeChild(run: (fake: ReturnType<typeof signallableChild>) => void): void {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    treeHook.calls.length = 0;
    treeHook.recording = true;
    vi.useFakeTimers();
    try {
      run(fake);
    } finally {
      vi.useRealTimers();
      treeHook.recording = false;
      spawnHook.override = null;
    }
  }

  it('tears the tree down after end() even though Node already flagged the child as killed', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      session.end();

      vi.advanceTimersByTime(EOF_TERM_GRACE_MS);
      // Delivered, not dead — the state that used to disable the teardown.
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();
      expect(treeHook.calls).toEqual([[fake.child, EOF_KILL_GRACE_MS]]);
    });
  });

  it('keeps the group escalation armed after the leader exits on the EOF path (PR #925 review)', async () => {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    treeHook.calls.length = 0;
    treeHook.escalations.length = 0;
    treeHook.recording = true;
    vi.useFakeTimers();
    try {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      session.end();
      await vi.advanceTimersByTimeAsync(EOF_TERM_GRACE_MS);
      expect(treeHook.calls).toEqual([[fake.child, EOF_KILL_GRACE_MS]]);

      // The leader honours SIGTERM; a SIGTERM-ignoring MCP child in its group would not, and
      // only the escalation still reaches it.
      (fake.child.stdout as unknown as PassThrough).end();
      (fake.child.stderr as unknown as PassThrough).end();
      fake.exit(143);
      fake.child.emit('close', 143, null);
      await session.result;

      await vi.advanceTimersByTimeAsync(EOF_KILL_GRACE_MS);
      expect(treeHook.escalations).toEqual([fake.child]);
    } finally {
      vi.useRealTimers();
      treeHook.recording = false;
      spawnHook.override = null;
    }
  });

  it('tears the tree down on the wall-clock timeout path as well', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 20 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      vi.advanceTimersByTime(20);
      expect(treeHook.calls).toEqual([[fake.child, KILL_GRACE_MS]]);
    });
  });

  it('leaves a CLI that really exited alone', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      session.end();
      fake.exit(143);

      vi.advanceTimersByTime(EOF_TERM_GRACE_MS + EOF_KILL_GRACE_MS);
      expect(treeHook.calls).toEqual([]);
    });
  });

  it('stops accepting messages once the child has exited on its own', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      expect(session.open).toBe(true);
      fake.exit(1);

      expect(session.open).toBe(false);
      expect(session.sendMessage([{ type: 'text', text: 'are you there?' }])).toBe(false);
    });
  });
});

describe('claudeExitMessage', () => {
  it('names a hangup the CLI exited on, which cezar never sends (telemetry 046a0525)', () => {
    expect(claudeExitMessage(129, '')).toBe(
      'claude CLI exited with code 129 (SIGHUP: the terminal or console it ran under went away — cezar did not stop it)',
    );
  });

  it('names any other signal exit, and keeps the stderr tail', () => {
    expect(claudeExitMessage(137, 'a\nb')).toBe('claude CLI exited with code 137 (SIGKILL: a signal cezar did not send) — a | b');
  });

  it('leaves an ordinary failure code alone', () => {
    expect(claudeExitMessage(1, 'boom\n')).toBe('claude CLI exited with code 1 — boom');
  });
});

describe('prependSystemPrompt (codex/opencode delivery)', () => {
  it('prepends the prompt as a leading block of the first user message', () => {
    expect(prependSystemPrompt('Extra rules.', 'do it')).toBe('Extra rules.\n\n---\n\ndo it');
  });

  it('leaves the user prompt untouched when no systemPrompt is set', () => {
    expect(prependSystemPrompt(undefined, 'do it')).toBe('do it');
  });
});

/**
 * Turn-driven phase sessions (2026-07-24): with `autoEndAfterFirstTurn`
 * off, a session must survive a turn boundary, accept a follow-up message
 * (the phase nudge), run another turn, and close cleanly on `end()` — the
 * mechanics `runAgentStep` relies on to keep a phase's background subagents
 * alive across the boundary instead of killing them with the session.
 */
describe('ClaudeCliRunner turn-driven session', () => {
  it('runs a second turn from a message sent after the first turn ends', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { ClaudeCliRunner } = await import('./claude-cli-runner.js');
    const dir = await mkdtemp(join(tmpdir(), 'cez-turns-'));
    try {
      const bin = join(dir, 'echo-claude.mjs');
      await writeFile(
        bin,
        `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ type: 'system', subtype: 'init', session_id: 's-mt' });
let n = 0;
const rl = createInterface({ input: process.stdin });
rl.on('line', () => {
  n += 1;
  say({ type: 'assistant', message: { content: [{ type: 'text', text: 'turn ' + n }] } });
  say({ type: 'result', subtype: 'success', is_error: false, result: 'turn ' + n, usage: { output_tokens: 1 } });
});
rl.on('close', () => process.exit(0));
`,
        { mode: 0o755 },
      );

      const runner = new ClaudeCliRunner({ bin, timeoutMs: 60_000 });
      const events: Array<{ type: string }> = [];
      let turnEnds = 0;
      const session = runner.startSession(
        { userPrompt: 'first', cwd: dir, sessionId: 's-mt' },
        (e) => {
          events.push(e);
          if (e.type === 'turn-end') {
            turnEnds += 1;
            if (turnEnds === 1) session.sendMessage([{ type: 'text', text: 'nudge: finish now' }]);
            if (turnEnds === 2) session.end();
          }
        },
        { autoEndAfterFirstTurn: false },
      );
      const result = await session.result;

      expect(turnEnds).toBe(2);
      expect(result.text).toContain('turn 1');
      expect(result.text).toContain('turn 2');
      expect(events.map((e) => e.type)).not.toContain('error');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

/**
 * The EOF watchdog's kill must read as clean closure (2026-07-24, live
 * failure): a harness spec phase finished its turn, `end()` closed stdin, the
 * claude CLI ignored EOF (janitor-confirmed bug) and hung, the watchdog
 * SIGTERMed it — and the exit 143 failed a phase whose work had already
 * succeeded. The runner must deliver the result and note the cleanup kill,
 * never throw. Wall clock: the test rides the real EOF_TERM_GRACE_MS (8s).
 */
describe('ClaudeCliRunner EOF watchdog', () => {
  it('treats the watchdog kill of an EOF-ignoring CLI as clean closure, not a failure', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { ClaudeCliRunner } = await import('./claude-cli-runner.js');
    const dir = await mkdtemp(join(tmpdir(), 'cez-eof-'));
    try {
      const bin = join(dir, 'stuck-claude.mjs');
      await writeFile(
        bin,
        `#!/usr/bin/env node
setInterval(() => {}, 60_000);
process.on('SIGTERM', () => process.exit(143));
process.stdin.resume();
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ type: 'system', subtype: 'init', session_id: 's-eof' });
say({ type: 'assistant', message: { content: [{ type: 'text', text: 'spec finished' }] } });
say({ type: 'result', subtype: 'success', is_error: false, result: 'spec finished', session_id: 's-eof', usage: { input_tokens: 10, output_tokens: 5 } });
`,
        { mode: 0o755 },
      );

      const runner = new ClaudeCliRunner({ bin, timeoutMs: 60_000 });
      const events: Array<{ type: string; message?: unknown }> = [];
      const result = await runner.run(
        { userPrompt: 'write the spec', cwd: dir, sessionId: 's-eof' },
        (e) => events.push(e as { type: string; message?: unknown }),
      );

      expect(result.text).toContain('spec finished');
      const types = events.map((e) => e.type);
      expect(types).toContain('turn-end');
      expect(types).toContain('done');
      expect(types).not.toContain('error');
      expect(events.some((e) => e.type === 'note' && String(e.message).includes('ignored EOF'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('ClaudeCliRunner token usage', () => {
  it('counts the aggregate result usage without re-adding assistant-frame snapshots', async () => {
    const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
    const runner = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 });
    const events: AgentEvent[] = [];
    const cwd = mkdtempSync(join(tmpdir(), 'cez-claude-token-usage-'));

    try {
      const result = await runner.run(
        {
          userPrompt: 'fix the login redirect',
          cwd,
          env: {
            CEZ_HANDOFF_FILE: '',
            CEZ_MOCK_ARGS_FILE: '',
            CEZ_TODOS_FILE: '',
          },
          sessionId: '5f701b42-382a-4a6e-b831-0ab9e56eff58',
        },
        (event) => events.push(event),
      );

      // The mock emits four assistant usage snapshots before its aggregate
      // result usage (1,270 input + 185 output). Only the result is authoritative.
      expect(result.tokensUsed).toBe(1_455);
      expect(events.filter((event) => event.type === 'token-usage')).toEqual([
        { type: 'token-usage', tokensUsed: 1_455 },
      ]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});

describe('ClaudeCliRunner private MCP (spec 2026-10-07-private-project-mcp)', () => {
  it('spawns with --mcp-config pointing at a 0600 file that is gone once the session ends', async () => {
    const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
    const runner = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 });
    const cwd = mkdtempSync(join(tmpdir(), 'cez-claude-private-mcp-'));
    const argsFile = join(cwd, 'args.ndjson');
    try {
      await runner.run({
        userPrompt: 'do it',
        cwd,
        env: { CEZ_HANDOFF_FILE: '', CEZ_MOCK_ARGS_FILE: argsFile, CEZ_TODOS_FILE: '' },
        allowedTools: ['Read'],
        mcpServers: [{ name: 'tracker', transport: 'stdio', command: 'tracker-mcp', args: [], env: { TOKEN: 's3cret' }, headers: {} }],
      });
      const argv = JSON.parse(readFileSync(argsFile, 'utf8').trim().split('\n')[0]!) as string[];
      const configPath = argv[argv.indexOf('--mcp-config') + 1]!;
      expect(argv).toContain('--mcp-config');
      expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('Read,mcp__tracker');
      expect(argv.join(' ')).not.toContain('s3cret');
      expect(existsSync(configPath)).toBe(false);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});

// Spec 2026-10-24 item 9 (eb4b12dc): a gateway's OpenAI-shaped envelope read as its type and message.
describe('claude result error with a JSON envelope', () => {
  it('shows the vendor error type and message, not the raw JSON', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-envelope-'));
    const bin = join(root, 'claude.mjs');
    const result = 'API Error: 400 [400]: {"error":{"type":"invalid_request_error","message":"model gpt-5 is not available","param":null,"code":null}}';
    writeFileSync(bin, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify({ type: 'result', is_error: true, result }))});\nprocess.exit(1);\n`, { mode: 0o755 });
    try {
      const errors: string[] = [];
      await new ClaudeCliRunner({ bin, timeoutMs: 5000 })
        .run({ cwd: root, userPrompt: 'work' }, (event) => { if (event.type === 'error') errors.push(event.message); })
        .catch(() => undefined);
      expect(errors).toContain('API Error: 400 [400]: invalid_request_error: model gpt-5 is not available');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
