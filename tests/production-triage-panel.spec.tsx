/** Read-only grouped projection is an actual workbench consumer, not one attention card per message. */
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ProductionJudgments } from '../src/client/production-triage.tsx'
import type { T } from '../src/client/text.ts'
const summary = { total: 1, nextBefore: null, unresolved: { groups: 0, messages: 0, queued: 0, preparing: 0, awaiting: 0, blocked: 0, unknown: 0, suggested_action: 0, oldestAt: null } }
const t = ((key: string) => key === 'lang' ? 'en' : key) as T
it('renders grouped matter review and nested coverage without action or resolved claims', () => {
  const html = renderToStaticMarkup(<ProductionJudgments t={t} view={{ ...summary, limited: false, groups: [{ id: 'receipt', owner: 'owner', generation: 1,
    state: 'completed', window: { start: '2026-11-09', end: '2026-11-10' }, at: '2026-11-10', messages: 2, redacted: false, newerKnownEvidence: false, historical: false,
    problem: undefined, conversation: 'chat', counts: { informational: 1, suggested_action: 1, unknown: 0, none: 0 },
    matters: [{ id: 'matter', title: 'Review shared plan', reason: 'Two related messages', triggerIds: ['a', 'b'] }],
    items: [{ triggerId: 'a', historical: false, kind: 'informational', reason: 'A reference', contextHash: 'abc', gaps: ['local_sync_only'] }] }] }} />)
  expect(html).toContain('Review shared plan'); expect(html).toContain('Per-message audit')
  expect(html).toContain('Judgment recorded'); expect(html).toContain('suggested follow-ups')
  expect(html).toContain('local_sync_only'); expect(html).not.toContain('<button'); expect(html).not.toContain('<input')
})
it('empty projection does not add a dashboard task or placeholder', () => {
  expect(renderToStaticMarkup(<ProductionJudgments t={t} view={{ ...summary, total: 0, limited: false, groups: [] }} />)).toBe('')
})
