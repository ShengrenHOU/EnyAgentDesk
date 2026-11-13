import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { advanceConversationCursor, coverageOf, INITIAL_LOOKBACK_MS, INCREMENTAL_OVERLAP_MS, planContext,
  readConversationCursor } from '../src/app/im-conversation-cursors.ts'
let directory: string, store: Store
const identity = (conversation = 'chat', message = 'm', version = 'v1') =>
  ({ provider: 'test', account: 'owner', conversation, message, version, partial: false })
const input = (triggerId: string, at: string, conversation = 'chat') => ({ triggerId, at, identity: identity(conversation, triggerId) })
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'triage-cursor-')); store = new Store(join(directory, 'state.sqlite')) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('looks back 24h only on first sight and then reads from the covered boundary with a small overlap', () => {
  const first = planContext([input('a', '2026-11-10T09:00:00.000Z')], undefined)
  expect(first.mode).toBe('initial')
  expect(Date.parse(first.window.start)).toBe(Date.parse('2026-11-10T09:00:00.000Z') - INITIAL_LOOKBACK_MS)
  expect(first.window.end).toBe('2026-11-10T09:00:01.000Z')
  advanceConversationCursor(store, identity(), first.window.end, '2026-11-10T09:00:01.000Z')
  const second = planContext([input('b', '2026-11-10T09:30:00.000Z')], readConversationCursor(store, identity()))
  expect(second.mode).toBe('incremental')
  expect(second.previous).toBe(first.window.end)
  expect(Date.parse(second.window.start)).toBe(Date.parse(first.window.end) - INCREMENTAL_OVERLAP_MS)
  expect(Date.parse(second.window.end) - Date.parse(second.window.start)).toBeLessThan(60 * 60_000)
})

it('keeps every input inside a six-day first-seen window whose request is capped at seven days', () => {
  const initial = planContext([input('old', '2026-11-01T00:00:00.000Z'), input('new', '2026-11-07T00:00:00.000Z')], undefined)
  expect(initial.mode).toBe('initial')
  expect(Date.parse(initial.window.end) - Date.parse(initial.window.start)).toBe(7 * 86_400_000)
  expect(Date.parse('2026-11-01T00:00:00.000Z')).toBeGreaterThanOrEqual(Date.parse(initial.window.start))
  expect(Date.parse('2026-11-07T00:00:00.000Z')).toBeLessThan(Date.parse(initial.window.end))
})

it('reopens a dormant conversation with a bounded day instead of spanning an unproven gap', () => {
  advanceConversationCursor(store, identity(), '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:01.000Z')
  const reopened = planContext([input('later', '2026-11-10T12:00:00.000Z')], readConversationCursor(store, identity()))
  expect(reopened.mode).toBe('incremental')
  expect(reopened.gaps).toEqual(['incremental_gap_capped'])
  expect(Date.parse(reopened.window.end) - Date.parse(reopened.window.start)).toBe(INITIAL_LOOKBACK_MS + 1000)
  expect(reopened.window.start).toBe('2026-11-09T12:00:00.000Z')
  expect(coverageOf(reopened, identity())).toMatchObject({ planGaps: ['incremental_gap_capped'], gaps: ['incremental_gap_capped'] })
})

it('keeps one cursor per native conversation and never moves coverage backwards', () => {
  advanceConversationCursor(store, identity('one'), '2026-11-10T12:00:00.000Z', '2026-11-10T12:00:01.000Z')
  advanceConversationCursor(store, identity('two'), '2026-11-10T10:00:00.000Z', '2026-11-10T10:00:01.000Z')
  expect(readConversationCursor(store, identity('one'))!.through).toBe('2026-11-10T12:00:00.000Z')
  expect(readConversationCursor(store, identity('two'))!.through).toBe('2026-11-10T10:00:00.000Z')
  expect(readConversationCursor(store, identity('three'))).toBeUndefined()
  const current = readConversationCursor(store, identity('one'))!
  expect(advanceConversationCursor(store, identity('one'), '2026-11-10T09:00:00.000Z', '2026-11-10T12:05:00.000Z')).toEqual(current)
  const next = advanceConversationCursor(store, identity('one'), '2026-11-10T12:30:00.000Z', '2026-11-10T12:30:01.000Z',
    { messageId: 'm2', version: 'v2' })
  expect(next).toMatchObject({ through: '2026-11-10T12:30:00.000Z', revision: current.revision + 1, messageId: 'm2', version: 'v2' })
})

it('plans a behind-cursor edit as a single anchor plan without widening or rewinding coverage', () => {
  advanceConversationCursor(store, identity(), '2026-11-10T10:00:00.000Z', '2026-11-10T10:00:01.000Z')
  const change = planContext([input('edit', '2026-11-10T09:00:00.000Z')], readConversationCursor(store, identity()))
  expect(change).toMatchObject({ mode: 'change', changeTriggerIds: ['edit'], previous: '2026-11-10T10:00:00.000Z' })
  expect(Date.parse(change.window.end) - Date.parse(change.window.start)).toBe(INCREMENTAL_OVERLAP_MS + 1000)
  advanceConversationCursor(store, identity(), change.window.end, '2026-11-10T10:05:00.000Z')
  expect(readConversationCursor(store, identity())!.through).toBe('2026-11-10T10:00:00.000Z')
})

it('refuses to hide a behind-cursor message inside a newer incremental window', () => {
  advanceConversationCursor(store, identity(), '2026-11-10T10:00:00.000Z', '2026-11-10T10:00:01.000Z')
  expect(() => planContext([input('new', '2026-11-10T10:05:00.000Z'), input('old', '2026-11-10T09:00:00.000Z')],
    readConversationCursor(store, identity()))).toThrow('cannot mix')
})

it('keeps an operator window explicit instead of deriving an incremental boundary', () => {
  const plan = planContext([input('a', '2026-11-10T09:00:00.000Z')], undefined,
    { start: '2026-11-10T08:00:00.000Z', end: '2026-11-10T10:00:00.000Z' })
  expect(plan.mode).toBe('explicit'); expect(plan.previous).toBeNull()
  expect(plan.window).toEqual({ start: '2026-11-10T08:00:00.000Z', end: '2026-11-10T10:00:00.000Z' })
  expect(coverageOf(plan, identity())).toMatchObject({ conversation: 'chat', mode: 'explicit', from: plan.window.start, to: plan.window.end })
})
