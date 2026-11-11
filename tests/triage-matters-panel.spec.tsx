// @vitest-environment jsdom
/** Synthetic projections exercise display only, without creating real obligations or receipts. */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { CanonicalMatters } from '../src/client/triage-matters.tsx'
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
it('uses Older/Latest cursors and hides cached pages while refresh is pending or fails', async () => {
  const element = document.createElement('div'), root = createRoot(element)
  const latest = page('Latest title', 52), loadPage = vi.fn(async (_before: number) => page('Old private title'))
  try {
    await act(async () => root.render(<CanonicalMatters t={t} view={latest} loadPage={loadPage} />))
    await act(async () => element.querySelector('button')!.click())
    expect(loadPage).toHaveBeenCalledWith(52); expect(element.textContent).toContain('Old private title')
    expect(element.textContent).not.toContain('Older matters')
    await act(async () => element.querySelector('button')!.click())
    expect(element.textContent).toContain('Latest title'); expect(element.textContent).not.toContain('Old private title')
    await act(async () => element.querySelector('button')!.click())
    let reject!: (error: Error) => void
    loadPage.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    await act(async () => root.render(<CanonicalMatters t={t} view={page('Refreshed title', 52)} loadPage={loadPage} />))
    expect(element.textContent).not.toContain('Old private title'); expect(element.textContent).toContain('Refreshing matters')
    await act(async () => reject(new Error('Refresh failed')))
    expect(element.textContent).not.toContain('Old private title'); expect(element.querySelector('[role="alert"]')?.textContent).toContain('Refresh failed')
    await act(async () => element.querySelector('button')!.click())
    expect(element.textContent).toContain('Refreshed title')
  } finally { await act(async () => root.unmount()) }
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
