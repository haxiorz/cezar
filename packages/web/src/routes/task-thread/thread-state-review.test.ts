import { describe, expect, it } from 'vitest'

import type { ApiRun, RunEvent } from '@open-mercato/cezar-api-client'

import { liveTurnStart } from './task-thread'
import { reduceThread } from './thread-state'

const start = '2026-09-23T10:00:00.000Z'
const end = '2026-09-23T10:04:00.000Z'
const line = (seq: number, type: string, rest: Record<string, unknown> = {}): RunEvent =>
  ({ seq, ts: start, type, ...rest }) as RunEvent
const message = (id: string, text: string) => ({ kind: 'message', id, role: 'assistant', text })

describe('PR #925 issue4: lazy session turn adoption', () => {
  it('opens a sessionless phase outside a failed lazy reviewer turn', () => {
    const { turns } = reduceThread([
      line(1, 'session.error', { sessionKey: 'a', stepId: 'review', message: 'Reviewer failed' }),
      line(2, 'session.ended', { sessionKey: 'a', stepId: 'review', reason: 'error' }),
      line(3, 'turn.started', { stepId: 'fix', turnId: 'fix-turn' }),
      line(4, 'item.completed', { stepId: 'fix', item: message('answer', 'Fixing') }),
    ])
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ sessionKey: 'a', stepId: 'review' })
    expect(turns[0]?.turnId).toBeUndefined()
    expect(turns[1]).toMatchObject({ turnId: 'fix-turn', stepId: 'fix' })
    expect(turns[1]?.sessionKey).toBeUndefined()
  })

  it('reuses a keyed lazy turn when turn.started arrives before v2 items', () => {
    const { turns } = reduceThread([
      line(1, 'note', { sessionKey: 'a', message: 'Reviewer loading' }),
      line(2, 'turn.started', { sessionKey: 'b', stepId: 'review', turnId: 'turn_1' }),
      line(3, 'turn.started', { sessionKey: 'a', stepId: 'review', turnId: 'turn_1' }),
      line(4, 'turn.completed', { sessionKey: 'a', stepId: 'review', turnId: 'turn_1', ts: end }),
    ])
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ id: 'turn-seq-1', sessionKey: 'a', stepId: 'review', turnId: 'turn_1', completed: { ts: end } })
  })

  it('guard: PR #925 issue4 attaches ordinary turn.started to its user message', () => {
    const { turns } = reduceThread([
      line(1, 'user-message', { text: 'Continue' }),
      line(2, 'turn.started', { turnId: 'next', ts: end }),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ id: 'turn-seq-1', turnId: 'next', startedAt: start, userMessage: { text: 'Continue' } })
  })

  it('guard: PR #925 issue4 opens a new keyed turn after a turn with v2 items', () => {
    const { turns } = reduceThread([
      line(1, 'item.completed', { sessionKey: 'a', stepId: 'review', item: message('old', 'Existing context') }),
      line(2, 'turn.started', { sessionKey: 'a', stepId: 'review', turnId: 'next' }),
    ])
    expect(turns).toHaveLength(2)
    expect(turns[0]?.turnId).toBeUndefined()
    expect(turns[1]?.turnId).toBe('next')
  })
})

describe('PR #925 round3 issue2: council metadata headings', () => {
  const stepNames = new Map([['spec', 'Specify'], ['spec-review', 'Spec review'], ['review', 'Review'], ['implement', 'Implement']])
  const markers = (events: RunEvent[]) => reduceThread(events, { stepNames }).turns
    .flatMap((turn) => turn.items).flatMap((entry) => entry.kind === 'note' && entry.marker === 'step-start' ? [entry.text] : [])

  it.each([['spec-review', 'spec-review-1', 'Spec review'], ['review', 'impl-review-1', 'Review']])(
    'ignores advisor invocation step ids during %s', (phase, advisorPhase, label) => {
      expect(markers([
        line(1, 'step-start', { stepId: 'spec' }),
        line(2, 'turn.started', { stepId: phase, sessionKey: 'a', turnId: 'review' }),
        line(3, 'harness.invocation.updated', { stepId: advisorPhase }),
        line(4, 'item.completed', { stepId: phase, sessionKey: 'a', item: message('answer', 'Review') }),
        line(5, 'harness.council.updated', { stepId: advisorPhase }),
        line(6, 'turn.completed', { stepId: phase, sessionKey: 'a', turnId: 'review' }),
        line(7, 'step-start', { stepId: 'implement' }),
      ])).toEqual([label, 'Implement'])
    },
  )

  it('does not seed the phase cursor from harness metadata', () => {
    expect(markers([
      line(1, 'harness.invocation.updated', { stepId: 'impl-review-1' }),
      line(2, 'turn.started', { stepId: 'review', sessionKey: 'a', turnId: 'review' }),
    ])).toEqual([])
  })

  it('guard: preserves real round and unknown phase headings', () => {
    expect(markers([
      line(1, 'step-start', { stepId: 'spec' }),
      line(2, 'note', { stepId: 'spec-review-1', message: 'Reviewing' }),
      line(3, 'step-start', { stepId: 'packet-PK-01' }),
    ])).toEqual(['Spec review · round 1', 'packet-PK-01'])
  })

  it('guard: ordinary runs stay divider-free across phase changes', () => {
    const events = [line(1, 'note', { stepId: 'spec', message: 'Specifying' }), line(2, 'note', { stepId: 'review', message: 'Reviewing' })]
    const thread = reduceThread(events)
    expect(thread.turns.flatMap((turn) => turn.items)).toMatchObject([
      { id: 'v1:1', text: 'Specifying' }, { id: 'v1:2', text: 'Reviewing' },
    ])
    expect(thread.turns.flatMap((turn) => turn.items).some((entry) => entry.kind === 'note' && entry.marker !== undefined)).toBe(false)
  })
})

describe('PR #925 issue5: sessionless council commentary', () => {
  it('keeps driver notes in one sessionless tail while reviewers keep streaming', () => {
    const { turns } = reduceThread([
      line(1, 'turn.started', { sessionKey: 'a', stepId: 'review', turnId: 'turn_1' }),
      line(2, 'turn.started', { sessionKey: 'b', stepId: 'review', turnId: 'turn_1' }),
      line(3, 'item.started', { sessionKey: 'b', stepId: 'review', item: message('answer', 'Review') }),
      line(4, 'note', { stepId: 'review', message: 'Reviewer A produced no review — continuing' }),
      line(5, 'item.delta', { sessionKey: 'b', stepId: 'review', itemId: 'answer', field: 'text', delta: 'ing' }),
      line(6, 'note', { stepId: 'review', message: 'Verdict coerced' }),
    ])
    expect(turns).toHaveLength(3)
    expect(turns[1]?.items).toMatchObject([{ kind: 'message', text: 'Reviewing' }])
    expect(turns[2]?.sessionKey).toBeUndefined()
    expect(turns[2]).toMatchObject({ id: 'turn-seq-4', stepId: 'review' })
    expect(turns[2]?.items.map((item) => item.kind === 'note' ? item.text : '')).toEqual([
      'Reviewer A produced no review — continuing', 'Verdict coerced',
    ])
  })

  it('keeps the council timer on its open peer beneath driver notes', () => {
    const thread = reduceThread([
      line(1, 'turn.started', { sessionKey: 'a', stepId: 'review', turnId: 'turn_1' }),
      line(2, 'note', { stepId: 'review', message: 'Salvaged another reviewer', ts: end }),
    ])
    expect(thread.turns.at(-1)?.sessionKey).toBeUndefined()
    expect(liveTurnStart({ startedAt: '2026-09-23T09:00:00.000Z' } as ApiRun, thread)).toBe(start)
  })

  it.each([false, true])('guard: PR #925 issue5 preserves sessionless events with no open peers (closed=%s)', (closed) => {
    const initial = closed ? [
      line(1, 'turn.started', { sessionKey: 'a', stepId: 'review', turnId: 'turn_1' }),
      line(2, 'turn.completed', { sessionKey: 'a', stepId: 'review', turnId: 'turn_1' }),
    ] : [line(1, 'turn.started', { stepId: 'task', turnId: 'turn_1' })]
    const { turns } = reduceThread([...initial, line(3, 'note', { stepId: closed ? 'review' : 'task', message: 'Commentary' })])
    expect(turns).toHaveLength(1)
    expect(turns[0]?.items).toMatchObject([{ kind: 'note', text: 'Commentary' }])
  })
})

describe('PR #925 issue6: first phase divider', () => {
  const stepNames = new Map([['spec', 'Specify'], ['review', 'Review']])
  const events = [
    line(1, 'step-start', { stepId: 'spec' }),
    line(2, 'note', { stepId: 'spec', message: 'Starting' }),
  ]
  const markers = (atHistoryStart: boolean, names = stepNames) => reduceThread(events, { stepNames: names, atHistoryStart }).turns
    .flatMap((turn) => turn.items).filter((item) => item.kind === 'note' && item.marker === 'step-start')

  it('labels the first phase only when the window starts at the true beginning', () => {
    expect(markers(true)).toMatchObject([{ id: 'step-start:1', text: 'Specify' }])
  })

  it('guard: PR #925 issue6 omits a partial window first divider and keeps transition keys stable', () => {
    expect(markers(false)).toEqual([])
    const tail = [line(20, 'note', { stepId: 'review', message: 'Reviewing' }), line(21, 'note', { stepId: 'spec', message: 'Retry' })]
    const ids = (lines: RunEvent[], atHistoryStart: boolean) => reduceThread(lines, { stepNames, atHistoryStart }).turns
      .flatMap((turn) => turn.items).filter((item) => item.kind === 'note' && item.marker === 'step-start').map((item) => item.id)
    expect(ids(tail, false)).toEqual(['step-start:21'])
    expect(ids([...events, ...tail], true)).toContain('step-start:21')
  })

  it('guard: PR #925 issue6 never adds dividers to an ordinary complete history', () => {
    const { turns } = reduceThread(events, { atHistoryStart: true })
    expect(turns.flatMap((turn) => turn.items)).toMatchObject([{ id: 'v1:2', text: 'Starting' }])
  })
})
