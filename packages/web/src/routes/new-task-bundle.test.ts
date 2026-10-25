import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function readRoute(relative: string): string {
  const path = [join(process.cwd(), 'src/routes', relative), join(process.cwd(), 'packages/web/src/routes', relative)].find(
    existsSync,
  )
  if (!path) throw new Error(`could not locate routes/${relative}`)
  return readFileSync(path, 'utf8')
}

describe('New Task bundle boundary', () => {
  it('loads the opt-in harness UI through a dynamic import', () => {
    const source = readRoute('new-task.tsx')
    expect(source).toContain("import('./new-task-harness')")
    expect(source).not.toMatch(/from\s+['"]\.\/new-task-harness['"]/)
  })
})

// PR #925 review (UI performance gate): multi-model is off by default, so no eager graph pays for it.
describe('harness bundle boundaries', () => {
  it('loads the Settings harness section through a dynamic import', () => {
    const source = readRoute('settings/registry.tsx')
    expect(source).toContain("import('./harness-section')")
    expect(source).not.toMatch(/from\s+['"]\.\/harness-section['"]/)
  })

  it('loads the thread harness surface through a dynamic import', () => {
    const source = readRoute('task-thread/task-thread.tsx')
    expect(source).toContain("import('../task-harness/thread-harness')")
    expect(source).not.toMatch(/from\s+['"]\.\.\/task-harness\/(harness-components|harness-rail|harness-status-bar|reviewer-modal|thread-harness)['"]/)
  })
})
