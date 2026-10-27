import { describe, expect, it } from 'vitest'

import type { ApiRun, RunEvent } from '@open-mercato/cezar-api-client'

import { liveTurnStart } from './task-thread'
import { reduceThread } from './thread-state'

const run = { startedAt: '2026-09-23T09:00:00.000Z' } as ApiRun
const event = (seq: number, type: string, sessionKey: string, ts: string): RunEvent =>
  ({ seq, type, sessionKey, ts, turnId: 'turn_1', stepId: 'review' }) as RunEvent
const aStart = '2026-09-23T10:00:00.000Z'
const bStart = '2026-09-23T10:01:00.000Z'
const bEnd = '2026-09-23T10:02:00.000Z'
const aEnd = '2026-09-23T10:03:00.000Z'
const started = [event(1, 'turn.started', 'a', aStart), event(2, 'turn.started', 'b', bStart)]

describe('liveTurnStart — concurrent reviewers', () => {
  it('counts from the earliest reviewer still working', () => {
    expect(liveTurnStart(run, reduceThread(started))).toBe(aStart)
    expect(liveTurnStart(run, reduceThread([...started, event(3, 'turn.completed', 'a', aEnd)]))).toBe(bStart)
  })

  it('keeps counting the open reviewer when the last-started reviewer finishes first', () => {
    expect(liveTurnStart(run, reduceThread([...started, event(3, 'turn.completed', 'b', bEnd)]))).toBe(aStart)
  })

  it('between councils, counts from the latest completion in wall-clock order', () => {
    expect(liveTurnStart(run, reduceThread([
      ...started,
      event(3, 'turn.completed', 'b', bEnd),
      event(4, 'turn.completed', 'a', aEnd),
    ]))).toBe(aEnd)
  })

  it('guard: starts the next unkeyed phase at its own open turn', () => {
    const thread = reduceThread([...started, event(3, 'turn.completed', 'b', bEnd)])
    thread.turns.push({ id: 'next', items: [], startedAt: aEnd })
    expect(liveTurnStart(run, thread)).toBe(aEnd)
  })

  it('guard: ignores an unfinished reviewer from an earlier council phase', () => {
    const thread = reduceThread([...started, event(3, 'turn.completed', 'b', bEnd)])
    thread.turns.push({ id: 'next', items: [], stepId: 'next-review', sessionKey: 'c', startedAt: aEnd })
    expect(liveTurnStart(run, thread)).toBe(aEnd)
  })

  it('guard: keeps the latest-turn rule for an ordinary unkeyed transcript', () => {
    expect(liveTurnStart(run, {
      turns: [
        { id: 'older', items: [], startedAt: aStart },
        { id: 'latest', items: [], startedAt: bStart, completed: { stopReason: 'end_turn', ts: bEnd } },
      ],
    })).toBe(bEnd)
  })
})

describe('PR #925 round3 issue3: restart boundaries', () => {
  const resumedAt = '2026-09-23T11:00:00.000Z'
  const userMessage: RunEvent = { seq: 3, type: 'user-message', text: 'Continue after restart', ts: resumedAt }

  it.each([false, true])('guard: ignores an unclosed pre-crash reviewer (driver tail=%s)', (driverTail) => {
    const thread = reduceThread([
      ...started,
      userMessage,
      event(4, 'turn.started', 'resumed', resumedAt),
      ...(driverTail ? [{ seq: 5, type: 'note', stepId: 'review', message: 'Council resumed', ts: resumedAt } as RunEvent] : []),
    ])
    expect(thread.turns[0]?.completed).toBeUndefined()
    expect(thread.turns[0]?.sessionEnded).toBeUndefined()
    expect(liveTurnStart(run, thread)).toBe(resumedAt)
  })

  it('guard: keeps a live reviewer clock across commentary without a resume', () => {
    const thread = reduceThread([
      ...started,
      { seq: 3, type: 'note', stepId: 'review', message: 'Still reviewing', ts: bEnd },
    ])
    expect(liveTurnStart(run, thread)).toBe(aStart)
  })

  it('guard: ordinary user resumes retain the user-message start', () => {
    const thread = reduceThread([
      { seq: 1, type: 'turn.started', turnId: 'old', ts: aStart },
      userMessage,
      { seq: 4, type: 'turn.started', turnId: 'new', ts: '2026-09-23T11:01:00.000Z' },
    ])
    expect(liveTurnStart(run, thread)).toBe(resumedAt)
  })
})

describe('PR #925 review: mid-council messages', () => {
  it.each([false, true])('keeps a queued-message council clock with or without a driver note (note=%s)', (driverNote) => {
    const thread = reduceThread([
      ...started,
      { seq: 3, type: 'user-message', text: 'Also check tests', ts: bEnd },
      { seq: 4, type: 'item.completed', stepId: 'review', sessionKey: 'b', ts: aEnd,
        item: { kind: 'message', id: 'finding', role: 'assistant', text: 'Checking tests' } },
      ...(driverNote ? [{ seq: 5, type: 'note', stepId: 'review', message: 'Still reviewing', ts: aEnd }] : []),
    ])
    expect(liveTurnStart(run, thread)).toBe(aStart)
  })

  it.each([false, true])('starts at Continue during durable-ledger reuse notes before a resumed reviewer opens (earlier phase note=%s)', (earlierPhaseNote) => {
    const resumedAt = '2026-09-23T11:00:00.000Z'
    const thread = reduceThread([
      ...started,
      event(3, 'turn.completed', 'a', aEnd),
      { seq: 4, type: 'lifecycle', message: 'cezar restarted', ts: '2026-09-23T10:30:00.000Z' },
      { seq: 5, type: 'user-message', text: 'Continue', ts: resumedAt },
      { seq: 6, type: 'lifecycle', message: 'Harness resumed', ts: resumedAt },
      ...(earlierPhaseNote ? [{ seq: 7, type: 'note', stepId: 'implement', message: 'Reused completed implementer from the durable ledger', ts: resumedAt }] : []),
      { seq: 8, type: 'harness.phase.updated', stepId: 'review', phase: { id: 'review', status: 'running' }, ts: resumedAt },
      { seq: 9, type: 'note', stepId: 'review', message: 'Reused completed reviewer A from the durable ledger', ts: resumedAt },
    ], { stepNames: new Map([['implement', 'Implement'], ['review', 'Review']]) })
    expect(thread.turns.find((turn) => turn.sessionKey === 'b')?.lastActivityAt).toBe(bStart)
    expect(liveTurnStart(run, thread)).toBe(resumedAt)
  })

  it.each(['item.updated', 'item.completed', 'item.delta', 'usage.updated', 'plan.updated'])('uses %s activity on an existing reviewer after a queued message', (type) => {
    const item = { kind: 'message', id: 'finding', role: 'assistant', text: 'Checking' }
    const thread = reduceThread([
      ...started,
      { seq: 3, type: 'item.started', stepId: 'review', sessionKey: 'a', ts: bStart, item },
      { seq: 4, type: 'user-message', text: 'Also check tests', ts: bEnd },
      { seq: 5, type, stepId: 'review', sessionKey: 'a', ts: aEnd, item, itemId: 'finding', field: 'text', delta: ' tests', entries: [], usage: { total: 100 } },
    ])
    expect(thread.turns[0]?.lastActivityAt).toBe(aEnd)
    expect(liveTurnStart(run, thread)).toBe(aStart)
  })

  it('guard: a queued message after a closed council keeps its own clock', () => {
    const messageAt = '2026-09-23T11:00:00.000Z'
    const thread = reduceThread([
      ...started, event(3, 'turn.completed', 'a', aEnd), event(4, 'turn.completed', 'b', bEnd),
      { seq: 5, type: 'user-message', text: 'Continue', ts: messageAt },
    ])
    expect(liveTurnStart(run, thread)).toBe(messageAt)
  })

  it('guard: ordinary queued messages retain identical turns and their message clock', () => {
    const thread = reduceThread([
      { seq: 1, type: 'turn.started', turnId: 'ordinary', ts: aStart },
      { seq: 2, type: 'user-message', text: 'Follow up', ts: bStart },
      { seq: 3, type: 'note', message: 'Queued', ts: bEnd },
    ])
    expect(thread).toEqual({
      turns: [
        { id: 'turn-seq-1', turnId: 'ordinary', startedAt: aStart, items: [] },
        { id: 'turn-seq-2', startedAt: bStart, userMessage: { text: 'Follow up', imageCount: 0, images: [], ts: bStart },
          items: [{ kind: 'note', id: 'v1:3', text: 'Queued', tone: 'dim' }] },
      ],
      lastEventAt: bEnd,
    })
    expect(liveTurnStart(run, thread)).toBe(bStart)
  })

  it('guard: keeps the surviving reviewer clock under commentary without a queued message', () => {
    const thread = reduceThread([
      ...started,
      { ...event(3, 'session.ended', 'a', aEnd), reason: 'error' },
      { seq: 4, type: 'note', stepId: 'review', message: 'Reviewer A failed; B is still reviewing', ts: aEnd },
    ])
    expect(liveTurnStart(run, thread)).toBe(bStart)
  })

  it('keeps the surviving reviewer clock after a queued message and driver note', () => {
    const aStartedAt = '2026-09-23T10:22:00.000Z'
    const bStartedAt = '2026-09-23T10:23:00.000Z'
    const thread = reduceThread([
      event(1, 'turn.started', 'a', aStartedAt),
      event(2, 'turn.started', 'b', bStartedAt),
      { seq: 3, type: 'user-message', text: 'Please also check the tests', ts: '2026-09-23T10:40:00.000Z' },
      { ...event(4, 'session.ended', 'a', '2026-09-23T10:45:00.000Z'), reason: 'error' },
      { seq: 5, type: 'note', stepId: 'review', message: 'Reviewer A failed; B is still reviewing', ts: '2026-09-23T10:45:00.000Z' },
    ])
    expect(liveTurnStart({ startedAt: '2026-09-23T10:00:00.000Z' } as ApiRun, thread)).toBe(bStartedAt)
  })
})

describe('PR #925 round3 issue4: compact council fallback', () => {
  it('uses a finished peer start when compact context leaves open peers without starts', () => {
    const thread = reduceThread([
      event(1, 'turn.started', 'b', bStart),
      event(2, 'turn.completed', 'b', bEnd),
      { seq: 3, type: 'item.completed', sessionKey: 'a', stepId: 'review', ts: aEnd, item: { kind: 'message', id: 'answer', role: 'assistant', text: 'A is still reviewing' } },
      { seq: 4, type: 'session.error', sessionKey: 'c', stepId: 'review', ts: aEnd, message: 'Retrying C' },
    ])
    expect(thread.turns.slice(1).map((turn) => turn.startedAt)).toEqual([undefined, undefined])
    expect(liveTurnStart(run, thread)).toBe(bStart)
  })

  it('uses a peer start when every closure lacks a timestamp', () => {
    expect(liveTurnStart(run, { turns: [{
      id: 'b', items: [], sessionKey: 'b', stepId: 'review', startedAt: bStart,
      completed: { stopReason: 'end_turn' },
    }] })).toBe(bStart)
  })

  it('guard: a defined open-peer start wins over an earlier closed peer', () => {
    expect(liveTurnStart(run, reduceThread([
      ...started, event(3, 'turn.completed', 'a', aEnd),
    ]))).toBe(bStart)
  })

  it('guard: a fully closed council still uses its latest completion', () => {
    expect(liveTurnStart(run, reduceThread([
      ...started, event(3, 'turn.completed', 'a', aEnd), event(4, 'turn.completed', 'b', bEnd),
    ]))).toBe(aEnd)
  })

  it('guard: ordinary compact turns still fall back to the run start', () => {
    expect(liveTurnStart(run, { turns: [{ id: 'lazy', items: [] }] })).toBe(run.startedAt)
  })
})

describe('PR #925 issue3: compact council clocks and session closure', () => {
  it('uses the earliest defined open-peer start after reloading compact context', () => {
    const thread = reduceThread([
      { seq: 1, ts: aStart, type: 'item.completed', stepId: 'review', sessionKey: 'a', item: { kind: 'message', id: 'm', role: 'assistant', text: 'A' } },
      event(2, 'turn.started', 'b', bStart),
      { seq: 3, ts: aEnd, type: 'session.error', stepId: 'review', sessionKey: 'c', message: 'C failed' },
    ] as RunEvent[])
    expect(thread.turns[0]?.startedAt).toBeUndefined()
    expect(liveTurnStart(run, thread)).toBe(bStart)
  })

  it('closes a dead reviewer on session.ended without inventing a reply', () => {
    const thread = reduceThread([
      ...started,
      event(3, 'turn.completed', 'b', bEnd),
      { ...event(4, 'session.ended', 'a', aEnd), reason: 'error' },
    ])
    expect(liveTurnStart(run, thread)).toBe(aEnd)
    expect(thread.turns[0]?.sessionEnded).toMatchObject({ reason: 'error', ts: aEnd })
    expect(thread.turns[0]?.completed).toBeUndefined()
  })

  it('guard: PR #925 issue3 leaves sessionless session.ended on the ordinary latest-turn clock', () => {
    const thread = reduceThread([
      { seq: 1, type: 'turn.started', ts: aStart, turnId: 'ordinary' },
      { seq: 2, type: 'session.ended', ts: aEnd, reason: 'error' },
    ])
    expect(liveTurnStart(run, thread)).toBe(aStart)
    expect(thread.turns[0]?.sessionEnded).toBeUndefined()
    expect(thread.sessionEnded).toEqual({ reason: 'error' })
  })
})
