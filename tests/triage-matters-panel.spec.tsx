// @vitest-environment jsdom
/** Synthetic projections exercise display only, without creating real obligations or receipts. */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { CanonicalMatters } from '../src/client/triage-matters.tsx'
import { HISTORY_PAGE_POLL_MS } from '../src/client/api.ts'
import type { ApiResponse } from '../src/app/api.ts'
import type { T } from '../src/client/text.ts'
type View = ApiResponse<'GET triage-matters'>
const t = ((key: string) => key === 'lang' ? 'en' : key) as T
const page = (title = 'A shared matter', nextBefore: number | null = null): View => ({ total: 51, oldestAt: '2026-10-01', nextBefore, unresolved: { total: 7, oldestAt: '2026-10-02' },
  groups: [{ id: 'canonical', revision: 2, redacted: false, stale: true, createdAt: '2026-10-01', updatedAt: '2026-11-10', title,
    reason: 'Read together across two receipts', assessment: 'no_further_action_suggested', conversation: 'conversation', related: undefined,
    memberCount: 2, membersLimited: false, warning: 'Evidence-based suggestion only.',
    members: [{ contexts: [], local: { id: 'local-1', title: 'Local receipt title', reason: 'Local receipt reason', triggerIds: ['trigger-1'] }, id: 'member-1', batchId: 'receipt-1', generation: 1, localMatterId: 'local-1', matterId: 'canonical', originId: 'canonical' },
      { contexts: [], local: undefined, id: 'member-2', batchId: 'receipt-2', generation: 1, localMatterId: 'local-2', matterId: 'canonical', originId: 'canonical' }] }] })
const button = (element: HTMLElement, text: string) => [...element.querySelectorAll('button')].find(item => item.textContent === text)!
const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0) }) }
const poll = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(HISTORY_PAGE_POLL_MS) }); await flush() }

it('renders cross-receipt grouping, bounded no-action advice, and conservative freshness without business controls', () => {
  const html = renderToStaticMarkup(<CanonicalMatters t={t} view={page()} />)
  for (const text of ['A shared matter', 'receipt-1', 'receipt-2', 'Local receipt title', 'Local receipt reason', 'bounded observed evidence only', 'existing Ticket authorization',
    'not verified as current', 'Model no longer suggests action based on these citations', 'Active suggestions awaiting review', '7', '2026-10-02', '51', '2026-10-01']) expect(html).toContain(text)
  expect(html).not.toContain('<button'); expect(html).not.toContain('<input')
})
it('suppresses every source field even if a redacted fixture still contains them', () => {
  const view = page('PRIVATE TITLE'); Object.assign(view.groups[0]!, { redacted: true, reason: 'PRIVATE REASON', conversation: 'PRIVATE CONVERSATION', related: 'PRIVATE RELATED',
    handoff: { kind: 'ticket', id: 'PRIVATE-TICKET', title: 'PRIVATE TARGET', at: '2026-11-11', reason: 'PRIVATE LINK' } })
  const html = renderToStaticMarkup(<CanonicalMatters t={t} view={view} />)
  expect(html).toContain('Content hidden'); expect(html).not.toContain('PRIVATE'); expect(html).not.toContain('receipt-1')
  expect(html).not.toContain('no_further_action_suggested'); expect(html).not.toContain('Local receipt title'); expect(html).not.toContain('Local receipt reason')
})
it('adds no empty dashboard placeholder', () => {
  expect(renderToStaticMarkup(<CanonicalMatters t={t} view={{ total: 0, oldestAt: null, nextBefore: null, groups: [], unresolved: { total: 0, oldestAt: null } }} />)).toBe('')
})

it('opens associated work while describing only the saved context receipt', async () => {
  const element = document.createElement('div'), root = createRoot(element), openWork = vi.fn()
  const view = page()
  view.groups[0]!.handoff = { kind: 'ticket', id: 'ticket-one', title: 'Deployment review', at: '2026-11-11', reason: 'Same goal', inputId: 'note-one' }
  try {
    await act(async () => root.render(<CanonicalMatters t={t} view={view} openWork={openWork} />))
    await act(async () => element.querySelector<HTMLButtonElement>('.pw-title-button')!.click())
    expect(openWork).toHaveBeenCalledWith('ticket', 'ticket-one')
    expect(element.textContent).toContain('Saved in Ticket context')
  } finally { await act(async () => root.unmount()) }
})

it('re-reads the selected page on its own bounded schedule and replaces old evidence, links, revisions or redacted content', async () => {
  vi.useFakeTimers()
  const element = document.createElement('div'), root = createRoot(element)
  const old = page('Old matter title')
  const updated = page('Updated matter title')
  updated.groups[0]!.revision = 3
  updated.groups[0]!.handoff = { kind: 'ticket', id: 'ticket-two', title: 'Updated linked work', at: '2026-11-11', reason: 'Same goal' }
  const redacted = page('PRIVATE OLD SOURCE')
  Object.assign(redacted.groups[0]!, { redacted: true, title: 'PRIVATE TITLE', reason: 'PRIVATE REASON',
    conversation: 'PRIVATE CONVERSATION', related: 'PRIVATE RELATED',
    handoff: { kind: 'ticket', id: 'PRIVATE-TICKET', title: 'PRIVATE TARGET', at: '2026-11-11', reason: 'PRIVATE LINK' } })
  const responses = [old, updated, redacted]
  const loadPage = vi.fn(async () => responses.shift() ?? redacted)
  try {
    // The parent overview stays byte-identical while it keeps polling successfully.
    await act(async () => root.render(<CanonicalMatters t={t} view={page('Latest title', 52)} loadPage={loadPage} />))
    expect(loadPage).not.toHaveBeenCalled()
    await act(async () => button(element, 'Older matters').click())
    await flush()
    expect(loadPage).toHaveBeenCalledWith(52); expect(element.textContent).toContain('Old matter title')
    await poll()
    expect(loadPage).toHaveBeenCalledTimes(2)
    expect(element.textContent).toContain('Updated matter title'); expect(element.textContent).toContain('Revision: 3')
    expect(element.textContent).toContain('Updated linked work'); expect(element.textContent).not.toContain('Old matter title')
    await poll()
    expect(loadPage).toHaveBeenCalledTimes(3)
    expect(element.textContent).toContain('Content hidden')
    expect(element.textContent).not.toContain('PRIVATE'); expect(element.textContent).not.toContain('Updated matter title')
  } finally { await act(async () => root.unmount()); vi.useRealTimers() }
})

it('hides a failed selected page and restores it after an explicit retry', async () => {
  vi.useFakeTimers()
  const element = document.createElement('div'), root = createRoot(element)
  const loadPage = vi.fn()
    .mockResolvedValueOnce(page('Old source title'))
    .mockRejectedValueOnce(new Error('Refresh failed'))
    .mockResolvedValueOnce(page('Recovered title'))
  try {
    await act(async () => root.render(<CanonicalMatters t={t} view={page('Latest title', 52)} loadPage={loadPage} />))
    await act(async () => button(element, 'Older matters').click())
    await flush()
    expect(element.textContent).toContain('Old source title')
    await poll()
    expect(loadPage).toHaveBeenCalledTimes(2)
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('Refresh failed')
    expect(element.textContent).toContain('Matters could not be refreshed')
    expect(element.textContent).not.toContain('Old source title')
    await act(async () => button(element, 'Retry matters').click())
    await flush()
    expect(element.textContent).toContain('Recovered title')
    expect(element.querySelector('[role="alert"]')).toBeNull()
  } finally { await act(async () => root.unmount()); vi.useRealTimers() }
})

it('drops a late page after switching cursors and stops polling once unmounted', async () => {
  vi.useFakeTimers()
  const element = document.createElement('div'), root = createRoot(element)
  let resolveOlder!: (value: View) => void
  const loadPage = vi.fn(() => new Promise<View>(resolve => { resolveOlder = resolve }))
  try {
    await act(async () => root.render(<CanonicalMatters t={t} view={page('Latest title', 52)} loadPage={loadPage} />))
    await act(async () => button(element, 'Older matters').click())
    expect(element.textContent).toContain('Refreshing matters')
    await act(async () => button(element, 'Latest matters').click())
    expect(element.textContent).toContain('Latest title')
    await act(async () => resolveOlder(page('LATE PRIVATE TITLE')))
    await flush()
    expect(element.textContent).not.toContain('LATE PRIVATE TITLE'); expect(element.textContent).toContain('Latest title')
    loadPage.mockImplementation(async () => page('Stable older title'))
    await act(async () => button(element, 'Older matters').click())
    await flush()
    expect(element.textContent).toContain('Stable older title')
    const settled = loadPage.mock.calls.length
    await act(async () => root.unmount())
    await act(async () => { await vi.advanceTimersByTimeAsync(HISTORY_PAGE_POLL_MS * 3) })
    expect(loadPage).toHaveBeenCalledTimes(settled)
  } finally { await act(async () => root.unmount()); vi.useRealTimers() }
})

it('bounds selected-page polling while hidden and refreshes when the page is shown again', async () => {
  vi.useFakeTimers()
  const element = document.createElement('div'), root = createRoot(element)
  const loadPage = vi.fn(async () => page('Older title'))
  try {
    await act(async () => root.render(<CanonicalMatters t={t} view={page('Latest title', 52)} loadPage={loadPage} />))
    await act(async () => button(element, 'Older matters').click())
    await flush()
    expect(loadPage).toHaveBeenCalledTimes(1)
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await poll()
    expect(loadPage).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(HISTORY_PAGE_POLL_MS * 6 - 1) })
    expect(loadPage).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    await flush()
    expect(loadPage).toHaveBeenCalledTimes(3)
    hidden.mockRestore()
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush()
    expect(loadPage).toHaveBeenCalledTimes(4)
  } finally { vi.restoreAllMocks(); await act(async () => root.unmount()); vi.useRealTimers() }
})

it('shows bounded context gaps and missing native-version uncertainty without leaking them when redacted', () => {
  const view = page()
  view.groups[0]!.members[0]!.contexts = [{ triggerId: 'trigger-1', revision: 3, hash: 'context-hash', gaps: ['local_sync_only', 'truncated'],
    anchorStatus: 'matched', versionBasis: 'source_digest', nativeVersion: undefined, contextComplete: false }]
  const html = renderToStaticMarkup(<CanonicalMatters t={t} view={view} />)
  for (const text of ['local_sync_only', 'truncated', 'source_digest', 'Native version unavailable', 'ordering is uncertain',
    'not established as complete', 'does not identify the owner or confer authority']) expect(html).toContain(text)
  view.groups[0]!.redacted = true
  const hidden = renderToStaticMarkup(<CanonicalMatters t={t} view={view} />)
  for (const text of ['local_sync_only', 'truncated', 'context-hash', 'source_digest']) expect(hidden).not.toContain(text)
})
