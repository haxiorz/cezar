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
