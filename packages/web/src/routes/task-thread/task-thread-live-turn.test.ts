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
