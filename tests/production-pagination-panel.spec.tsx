// @vitest-environment jsdom
/** The workbench polls the selected receipt page by its own cursor instead of waiting for a changed overview. */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ProductionJudgments } from '../src/client/production-triage.tsx'
import { HISTORY_PAGE_POLL_MS } from '../src/client/api.ts'
import type { productionOverview } from '../src/app/production-triage.ts'
import type { T } from '../src/client/text.ts'
type View = ReturnType<typeof productionOverview>
const page = (id: string, nextBefore: number | null): View => ({ limited: nextBefore !== null, nextBefore, total: 51,
  unresolved: { groups: 51, messages: 51, queued: 51, preparing: 0, awaiting: 0, blocked: 0, unknown: 0, suggested_action: 0, oldestAt: '2026-10-01' },
  groups: [{ id, owner: 'owner', generation: 1, state: 'queued', window: { start: '2026-11-09', end: '2026-11-10' }, at: '2026-11-10',
    messages: 1, newerKnownEvidence: false, redacted: false, historical: false, problem: undefined, conversation: id, matters: [], counts: {}, items: [] }] })
const t = ((key: string) => key === 'lang' ? 'en' : key) as T
const button = (element: HTMLElement, text: string) => [...element.querySelectorAll('button')].find(item => item.textContent === text)!
const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0) }) }
const poll = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(HISTORY_PAGE_POLL_MS) }); await flush() }
it('offers intake recovery before any production receipt exists and reports an empty result without an error', async () => {
  const element = document.createElement('div'), root = createRoot(element)
  const empty = { ...page('unused', null), total: 0, groups: [] }
  const recover = vi.fn(async () => 'No blocked intake groups remain.')
  try {
    await act(async () => root.render(<ProductionJudgments t={t} view={empty} onRecoverIntake={recover} />))
    await act(async () => button(element, 'Recover an intake batch').click())
    expect(recover).toHaveBeenCalledOnce()
    expect(element.querySelector('[role="alert"]')).toBeNull()
    expect(element.textContent).toContain('No blocked intake groups remain.')
  } finally { await act(async () => root.unmount()) }
})
it('retries the selected generation, keeps a failure visible, and hides recovery for revoked evidence', async () => {
  const element = document.createElement('div'), root = createRoot(element)
  const blocked = page('blocked-record', null)
  blocked.groups[0] = { ...blocked.groups[0]!, state: 'blocked', generation: 7 }
  const retry = vi.fn().mockRejectedValueOnce(new Error('Source permission changed')).mockResolvedValue(undefined)
  try {
    await act(async () => root.render(<ProductionJudgments t={t} view={blocked} onRetry={retry} />))
    await act(async () => button(element, 'Retry judgment').click())
    expect(retry).toHaveBeenCalledWith('blocked-record', 7)
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('Source permission changed')
    await act(async () => button(element, 'Retry judgment').click())
    expect(element.querySelector('[role="status"]')?.textContent).toContain('Recovery received')
    const hidden: View = { ...blocked, groups: [{ ...blocked.groups[0]!, state: 'completed', redacted: true, retryable: true, counts: { unknown: 0 } }] }
    await act(async () => root.render(<ProductionJudgments t={t} view={hidden} onRetry={retry} />))
    expect(button(element, 'Retry judgment')).toBeUndefined()
    await act(async () => button(element, 'Recheck source and retry').click())
    expect(retry).toHaveBeenLastCalledWith('blocked-record', 7)
    expect(button(element, 'Discuss in main conversation')).toBeUndefined()
  } finally { await act(async () => root.unmount()) }
})
it('opens the unresolved projection and discusses the exact source group without creating work', async () => {
  vi.useFakeTimers()
  const element = document.createElement('div'), root = createRoot(element)
  const pending = page('old pending source', null)
  pending.groups[0] = { ...pending.groups[0]!, state: 'blocked', header: { at: '2026-11-12', conversationLabel: 'Named conversation' },
    problem: 'Awaiting a valid judgment', items: [{ triggerId: 'source-message', historical: false, kind: undefined, reason: undefined, contextHash: undefined, gaps: [],
      header: { at: '2026-11-12', senderLabel: 'Named sender' }, provider: 'wechat' }] }
  const loadPage = vi.fn(async () => pending), onDiscuss = vi.fn()
  try {
    await act(async () => root.render(<ProductionJudgments t={t} view={page('latest', null)} loadPage={loadPage} onDiscuss={onDiscuss} />))
    await act(async () => button(element, 'Unresolved information').click()); await flush()
    expect(loadPage).toHaveBeenCalledWith(Number.MAX_SAFE_INTEGER, true)
    expect(element.textContent).toContain('Named conversation'); expect(element.textContent).toContain('Named sender')
    expect(element.textContent).toContain('Awaiting a valid judgment')
    await act(async () => button(element, 'Discuss in main conversation').click())
    expect(onDiscuss).toHaveBeenCalledWith('old pending source', 1)
    await act(async () => button(element, 'Latest receipts').click())
    expect(element.textContent).toContain('latest'); expect(element.textContent).not.toContain('Named sender')
  } finally { await act(async () => root.unmount()); vi.useRealTimers() }
})

it('keeps the empty unresolved view navigable and hides discussion for revoked source content', async () => {
  vi.useFakeTimers()
  const element = document.createElement('div'), root = createRoot(element)
  const empty = { ...page('unused', null), groups: [], total: 0 }
  const loadPage = vi.fn(async () => empty), onDiscuss = vi.fn()
  try {
    await act(async () => root.render(<ProductionJudgments t={t} view={page('latest', null)} loadPage={loadPage} onDiscuss={onDiscuss} />))
    await act(async () => button(element, 'Unresolved information').click()); await flush()
    expect(element.textContent).toContain('No unresolved information')
    await act(async () => button(element, 'Latest receipts').click())
    const hidden = page('redacted-receipt', null)
    hidden.groups[0] = { ...hidden.groups[0]!, conversation: 'PRIVATE', redacted: true }
    await act(async () => root.render(<ProductionJudgments t={t} view={hidden} onDiscuss={onDiscuss} />))
    expect(element.textContent).not.toContain('PRIVATE')
    expect(button(element, 'Discuss in main conversation')).toBeUndefined()
  } finally { await act(async () => root.unmount()); vi.useRealTimers() }
})

it('re-reads the selected receipt page on its own schedule, applies updates and hides newly redacted content', async () => {
  vi.useFakeTimers()
  const element = document.createElement('div'), root = createRoot(element)
  const old = page('old private content', null)
  const updated = page('updated receipt conversation', null)
  updated.groups[0]!.newerKnownEvidence = true
  const redacted = page('redacted-receipt', null)
  redacted.groups[0]!.redacted = true
  redacted.groups[0]!.conversation = 'PRIVATE CONVERSATION'
  redacted.groups[0]!.matters = [{ id: 'PRIVATE-MATTER', title: 'PRIVATE MATTER TITLE', reason: 'PRIVATE REASON', triggerIds: [] }]
  redacted.groups[0]!.items = [{ triggerId: 'PRIVATE-TRIGGER', historical: false, kind: undefined, reason: 'PRIVATE AUDIT REASON', contextHash: 'PRIVATE-HASH', gaps: [] }]
  const responses = [old, updated, redacted]
  const loadPage = vi.fn(async () => responses.shift() ?? redacted)
  try {
    // The parent overview is unchanged while the selected page still revalidates itself.
    await act(async () => root.render(<ProductionJudgments t={t} view={page('latest', 52)} loadPage={loadPage} />))
    expect(element.textContent).toContain('51'); expect(element.textContent).toContain('2026-10-01'); expect(loadPage).not.toHaveBeenCalled()
    await act(async () => button(element, 'Older receipts').click())
    await flush()
    expect(loadPage).toHaveBeenCalledWith(52); expect(element.textContent).toContain('old private content')
    await poll()
    expect(loadPage).toHaveBeenCalledTimes(2)
    expect(element.textContent).toContain('updated receipt conversation'); expect(element.textContent).toContain('Newer evidence is known')
    expect(element.textContent).not.toContain('old private content')
    await poll()
    expect(loadPage).toHaveBeenCalledTimes(3)
    expect(element.textContent).toContain('Source permission or configuration changed')
    expect(element.textContent).not.toContain('PRIVATE'); expect(element.textContent).not.toContain('updated receipt conversation')
  } finally { await act(async () => root.unmount()); vi.useRealTimers() }
})
it('hides a failed receipt page and restores it after retry', async () => {
  vi.useFakeTimers()
  const element = document.createElement('div'), root = createRoot(element)
  const loadPage = vi.fn()
    .mockResolvedValueOnce(page('old receipt', null))
    .mockRejectedValueOnce(new Error('Receipt refresh failed'))
    .mockResolvedValueOnce(page('recovered receipt', null))
  try {
    await act(async () => root.render(<ProductionJudgments t={t} view={page('latest', 52)} loadPage={loadPage} />))
    await act(async () => button(element, 'Older receipts').click())
    await flush()
    expect(element.textContent).toContain('old receipt')
    await poll()
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('Receipt refresh failed')
    expect(element.textContent).toContain('Receipts could not be refreshed'); expect(element.textContent).not.toContain('old receipt')
    await act(async () => button(element, 'Retry receipts').click())
    await flush()
    expect(element.textContent).toContain('recovered receipt'); expect(element.querySelector('[role="alert"]')).toBeNull()
  } finally { await act(async () => root.unmount()); vi.useRealTimers() }
})
it('drops a late receipt after returning to latest and stops polling once unmounted', async () => {
  vi.useFakeTimers()
  const element = document.createElement('div'), root = createRoot(element)
  let resolveOlder!: (value: View) => void
  const loadPage = vi.fn(() => new Promise<View>(resolve => { resolveOlder = resolve }))
  try {
    await act(async () => root.render(<ProductionJudgments t={t} view={page('latest', 52)} loadPage={loadPage} />))
    await act(async () => button(element, 'Older receipts').click())
    expect(element.textContent).toContain('Refreshing receipts')
    await act(async () => button(element, 'Latest receipts').click())
    expect(element.textContent).toContain('latest')
    await act(async () => resolveOlder(page('LATE PRIVATE RECEIPT', null)))
    await flush()
    expect(element.textContent).not.toContain('LATE PRIVATE RECEIPT'); expect(element.textContent).toContain('latest')
    loadPage.mockImplementation(async () => page('stable older receipt', null))
    await act(async () => button(element, 'Older receipts').click())
    await flush()
    expect(element.textContent).toContain('stable older receipt')
    const settled = loadPage.mock.calls.length
    await act(async () => root.unmount())
    await act(async () => { await vi.advanceTimersByTimeAsync(HISTORY_PAGE_POLL_MS * 3) })
    expect(loadPage).toHaveBeenCalledTimes(settled)
  } finally { await act(async () => root.unmount()); vi.useRealTimers() }
})
