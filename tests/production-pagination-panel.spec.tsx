// @vitest-environment jsdom
/** The workbench consumes the keyset cursor and never keeps a stale page after overview refresh. */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ProductionJudgments } from '../src/client/production-triage.tsx'
import type { productionOverview } from '../src/app/production-triage.ts'
import type { T } from '../src/client/text.ts'
type View = ReturnType<typeof productionOverview>
const page = (id: string, nextBefore: number | null): View => ({ limited: nextBefore !== null, nextBefore, total: 51,
  unresolved: { groups: 51, messages: 51, queued: 51, preparing: 0, awaiting: 0, blocked: 0, unknown: 0, suggested_action: 0, oldestAt: '2026-10-01' },
  groups: [{ id, owner: 'owner', generation: 1, state: 'queued', window: { start: '2026-11-09', end: '2026-11-10' }, at: '2026-11-10',
    messages: 1, newerKnownEvidence: false, redacted: false, historical: false, problem: undefined, conversation: id, matters: [], counts: {}, items: [] }] })
const t = ((key: string) => key === 'lang' ? 'en' : key) as T
it('loads older receipts through the returned cursor, returns latest and clears cached evidence on refresh', async () => {
  const element = document.createElement('div'), root = createRoot(element)
  const latest = page('latest', 52), loadPage = vi.fn(async () => page('old private content', null))
  try {
    await act(async () => root.render(<ProductionJudgments t={t} view={latest} loadPage={loadPage} />))
    expect(element.textContent).toContain('51'); expect(element.textContent).toContain('2026-10-01')
    await act(async () => element.querySelector('button')!.click())
    expect(loadPage).toHaveBeenCalledWith(52); expect(element.textContent).toContain('old private content')
    expect(element.textContent).not.toContain('Older receipts')
    await act(async () => element.querySelector('button')!.click())
    expect(element.textContent).toContain('latest'); expect(element.textContent).not.toContain('old private content')
    await act(async () => element.querySelector('button')!.click())
    loadPage.mockResolvedValueOnce(page('redacted refreshed receipt', null))
    await act(async () => root.render(<ProductionJudgments t={t} view={page('refreshed', 52)} loadPage={loadPage} />))
    expect(element.textContent).not.toContain('old private content')
  } finally { await act(async () => root.unmount()) }
})
