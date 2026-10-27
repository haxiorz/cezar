import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { ApiRun, RunEvent } from '@open-mercato/cezar-api-client'
import { mergeRunHistoryEvents } from '@/api/run-history'
import { readRunHistoryPage } from '../../../../cezar/src/runs/event-history'

import { buildTranscriptRows, mainTranscriptSections } from './session-transcript'
import { reduceThread } from './thread-state'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('PR #925 review: council history row stability', () => {
  it('keeps the next phase identity across every prepended council history window', async () => {
    const events: RunEvent[] = []
    const push = (type: string, rest: Record<string, unknown> = {}) => {
      const seq = events.length + 1
      events.push({ seq, ts: new Date(Date.UTC(2026, 8, 23, 10, 0, seq)).toISOString(), type, ...rest })
    }
    const phase = (stepId: string, status = 'running') => push('harness.phase.updated', { stepId, phase: { id: stepId, status } })
    phase('review')
    for (const sessionKey of ['a', 'b']) push('turn.started', { stepId: 'review', sessionKey, turnId: 'turn_1' })
    for (let index = 0; index < 160; index += 1) {
      if (index === 50) push('user-message', { text: 'Also check tests' })
      if (index === 70) push('note', { stepId: 'review', origin: 'driver', message: 'Still reviewing' })
      push('item.completed', { stepId: 'review', sessionKey: index % 2 === 0 ? 'a' : 'b',
        item: { kind: 'message', id: `review-${index}`, role: 'assistant', text: `Finding ${index}` } })
    }
    for (const sessionKey of ['a', 'b']) push('turn.completed', { stepId: 'review', sessionKey, turnId: 'turn_1' })
    phase('review', 'done')
    push('note', { stepId: 'review', origin: 'driver', message: 'Council found blocking issues' })
    phase('fix-2')
    push('session.started', { stepId: 'fix-2', backend: 'claude' })
    push('turn.started', { stepId: 'fix-2', turnId: 'fix-turn' })
    for (let index = 0; index < 125; index += 1) push('item.completed', { stepId: 'fix-2',
      item: { kind: 'message', id: `fix-${index}`, role: 'assistant', text: `Fix ${index}` } })
    push('turn.completed', { stepId: 'fix-2', turnId: 'fix-turn' })
    const stepNames = new Map([['review', 'Review'], ['fix-2', 'Fixes']])
    const reduce = (lines: RunEvent[], hasOlder: boolean) => reduceThread(lines, { stepNames, atHistoryStart: !hasOlder })
    const full = reduce(events, false)
    const expected = full.turns.find((turn) => turn.turnId === 'fix-turn')!
    expect(expected.userMessage).toBeUndefined()
    const rows = (thread: ReturnType<typeof reduceThread>) => buildTranscriptRows(mainTranscriptSections({ task: '' } as ApiRun, thread), 'run')
    const expectedRows = rows(full)
    const dir = mkdtempSync(join(tmpdir(), 'cez-phase-page-'))
    dirs.push(dir)
    const file = join(dir, 'run.ndjson')
    writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
    let page = await readRunHistoryPage(file)
    let window = page.events
    let windows = 0
    for (;;) {
      windows += 1
      const thread = reduce(window, page.hasOlder)
      const actual = thread.turns.find((turn) => turn.turnId === 'fix-turn')!
      expect({ id: actual.id, startedAt: actual.startedAt, userMessage: actual.userMessage }).toEqual({
        id: expected.id, startedAt: expected.startedAt, userMessage: undefined,
      })
      const visible = new Set(window.filter((event) => event.stepId === 'fix-2' && event.type === 'item.completed')
        .map((event) => (event.item as { id: string }).id))
      const visibleNotes = new Set(window.filter((event) => event.type === 'note' && event.stepId === 'review').map((event) => `v1:${event.seq}`))
      const visibleHeadings = new Set(window.filter((event) => event.type === 'harness.phase.updated' && event.stepId === 'fix-2').map((event) => `step-start:${event.seq}`))
      const phaseRows = (entries: typeof expectedRows) => entries.filter((row) => row.content.kind === 'block' &&
        row.content.block.kind === 'entry' && (visible.has(row.content.block.entry.id) || visibleNotes.has(row.content.block.entry.id) ||
          visibleHeadings.has(row.content.block.entry.id))).map((row) => row.key)
      expect(phaseRows(rows(thread))).toEqual(phaseRows(expectedRows))
      if (!page.olderCursor) break
      page = await readRunHistoryPage(file, page.olderCursor)
      window = mergeRunHistoryEvents(page.events, window)
    }
    expect(windows).toBeGreaterThan(2)
  })

  it.each([undefined, 'fix-2'])('guard: harness messages still adopt a matching or unset phase (step=%s)', (stepId) => {
    const ts = '2026-09-23T10:00:00.000Z'
    const { turns } = reduceThread([
      { seq: 1, ts, type: 'user-message', text: 'Continue' },
      ...(stepId ? [{ seq: 2, ts, type: 'note', stepId, message: 'Preparing' }] : []),
      { seq: 3, ts, type: 'turn.started', stepId: 'fix-2', turnId: 'next' },
    ], { stepNames: new Map([['fix-2', 'Fixes']]) })
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ id: 'turn-seq-1', turnId: 'next', stepId: 'fix-2', startedAt: ts, userMessage: { text: 'Continue' } })
  })

  it('guard: ordinary phases still attach to their message even when its step differs', () => {
    const ts = '2026-09-23T10:00:00.000Z'
    const thread = reduceThread([
      { seq: 1, ts, type: 'user-message', text: 'Continue' },
      { seq: 2, ts, type: 'note', stepId: 'old-step', message: 'Preparing' },
      { seq: 3, ts, type: 'turn.started', stepId: 'next-step', turnId: 'next' },
      { seq: 4, ts, type: 'item.completed', stepId: 'next-step', item: { kind: 'message', id: 'answer', role: 'assistant', text: 'Working' } },
    ])
    expect(thread).toEqual({ turns: [{
      id: 'turn-seq-1', stepId: 'old-step', turnId: 'next', startedAt: ts,
      userMessage: { text: 'Continue', imageCount: 0, images: [], ts },
      items: [
        { kind: 'note', id: 'v1:2', text: 'Preparing', tone: 'dim' },
        { kind: 'message', id: 'answer', sourceKey: 'next-step:answer', role: 'assistant', text: 'Working' },
      ],
    }], lastEventAt: ts })
  })

  it.each(['newest', 'forward'])('keeps reviewer row keys and order after Load earlier from the %s page', async (direction) => {
    const ts = '2026-09-23T10:00:00.000Z'
    const events: RunEvent[] = [
      { seq: 1, ts, type: 'turn.started', stepId: 'review', sessionKey: 'a', turnId: 'turn_1' },
      { seq: 2, ts, type: 'item.completed', stepId: 'review', sessionKey: 'a', item: { kind: 'message', id: 'a-intro', role: 'assistant', text: 'Starting review' } },
      { seq: 3, ts, type: 'turn.started', stepId: 'review', sessionKey: 'b', turnId: 'turn_1' },
      { seq: 4, ts, type: 'user-message', text: 'Please also review the tests' },
      ...Array.from({ length: 151 }, (_, index) => ({
        seq: index + 5, ts, type: 'item.completed', stepId: 'review', sessionKey: index % 2 === 0 ? 'a' : 'b',
        item: { kind: 'message', id: `answer-${index}`, role: 'assistant', text: `Review ${index}` },
      })),
    ]
    const dir = mkdtempSync(join(tmpdir(), 'cez-council-page-'))
    dirs.push(dir)
    const file = join(dir, 'run.ndjson')
    writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
    const newest = await readRunHistoryPage(file)
    expect(newest.hasOlder).toBe(true)
    const older = await readRunHistoryPage(file, newest.olderCursor)
    const page = direction === 'newest' ? newest : await readRunHistoryPage(file, older.newerCursor)
    const visibleItems = new Set(page.events.filter((event) => event.type === 'item.completed').map((event) => (event.item as { id: string }).id))
    const rowKeys = (lines: RunEvent[]) => buildTranscriptRows(mainTranscriptSections(
      { task: '' } as ApiRun, reduceThread(lines),
    ), 'run').flatMap((row) =>
      row.content.kind === 'block' && row.content.block.kind === 'entry' && row.content.block.entry.kind === 'message' && visibleItems.has(row.content.block.entry.id)
        ? [row.key] : [],
    )
    const before = rowKeys(page.events)
    const after = rowKeys(mergeRunHistoryEvents(older.events, page.events))
    expect(visibleItems.size).toBeGreaterThan(0)
    expect(before).toHaveLength(visibleItems.size)
    expect(before).toEqual(after)
    expect(reduceThread(page.events).turns.filter((turn) => turn.sessionKey !== undefined).map((turn) => [turn.id, turn.sessionKey])).toEqual([
      ['turn-seq-1', 'a'], ['turn-seq-3', 'b'],
    ])
  })
})
