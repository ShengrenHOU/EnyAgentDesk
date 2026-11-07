import { afterEach, expect, it } from 'vitest'
import { FocusSchema, focusContext, publishFocus, readFocus } from '../src/sources/workbench-focus.ts'
import { WorkbenchConfigSchema, workbenchKind } from '../src/sources/workbench.ts'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

it('keeps domain definitions configurable and validates model classification against active domains', async () => {
  expect(WorkbenchConfigSchema.parse({ ownerId: 'owner' }).domains).toEqual([])
  const domain = { id: 'mle', name: 'MLE', scope: '模型和预测', state: 'active' as const }
  expect(WorkbenchConfigSchema.safeParse({ domains: [domain, domain] }).success).toBe(false)
  h = await startRuntime()
  h.runtime.sources.register(workbenchKind)
  await h.runtime.settings.save('source:workbench', { enabled: true, config: { ownerId: 'owner', domains: [domain] } }, 0, 'panel')
  const { ticket } = await h.acceptedTicket(feishu('domain-focus', 'Read the model report'))
  const source = h.runtime.context(workbenchKind)
  expect(focusContext(source).domains).toEqual([domain])
  const focus = { headline: 'Research focus', items: [{ title: 'Read model evidence', reason: 'Research report available', nextAction: 'Check its inputs', ticketId: ticket.id, evidenceAt: ticket.updatedAt, domainId: 'mle' }] }
  expect(() => publishFocus(source, { ...focus, items: [{ ...focus.items[0]!, domainId: 'missing' }] }, new Date().toISOString())).toThrow('domain')
  publishFocus(source, focus, new Date().toISOString())
  expect(readFocus(source).focus?.items[0]?.domainId).toBe('mle')
})

it('requires real evidence, preserves model recommendations separately, and marks changed source state', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('focus1', 'Prepare a reading note'))
  const source = h.runtime.context(workbenchKind)
  expect(focusContext(source).tickets[0]).toMatchObject({ ticketId: ticket.id, evidenceAt: ticket.updatedAt })
  expect(focusContext(source).threads[0]?.latest).toContain('Prepare a reading note')
  const item = { title: 'Review the note', reason: 'The delegated note is the current work', nextAction: 'Read its report', ticketId: ticket.id, evidenceAt: ticket.updatedAt }
  expect(FocusSchema.safeParse({ headline: 'Focus', items: [{ ...item, ticketId: undefined }] }).success).toBe(false)
  expect(() => publishFocus(source, { headline: 'Focus', items: [{ ...item, ticketId: 'missing' }] }, '2026-11-05T00:00:00Z')).toThrow('unknown Ticket')
  const before = h.runtime.store.tickets.get(ticket.id)!
  publishFocus(source, { headline: 'A reading suggestion', items: [item] }, '2026-11-05T00:00:00Z')
  expect(readFocus(source).focus?.items[0]).toMatchObject({ title: item.title, stale: false, evidence: ticket.title })
  expect(h.runtime.store.tickets.get(ticket.id)).toEqual(before)
  h.runtime.store.tickets.save({ ...before, updatedAt: '2026-11-06T00:00:00Z' })
  expect(readFocus(source).focus?.items[0]?.stale).toBe(true)
  publishFocus(source, { headline: 'Judgment based on the read version', items: [item] }, '2026-11-06T00:00:01Z')
  expect(readFocus(source).focus?.items[0]).toMatchObject({ evidenceAt: item.evidenceAt, stale: true })
})

it('tracks both cited versions independently and supplies actual runtime and prioritization facts', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('dual-reference', 'Review current evidence'))
  h.runtime.store.tickets.save({ ...ticket, priority: 'high', dueAt: '2026-11-06T00:00:00Z' })
  const source = h.runtime.context(workbenchKind)
  const context = focusContext(source)
  expect(context.runtime.packageVersion).toMatch(/^\d+\.\d+\.\d+/)
  expect(context.tickets[0]).toMatchObject({ priority: 'high', dueAt: '2026-11-06T00:00:00Z' })
  const reference = context.threads[0]!
  const item = { title: 'Check both', reason: 'Ticket and source matter', nextAction: 'Read the current source', ticketId: ticket.id,
    threadKey: reference.threadKey, evidenceAt: ticket.updatedAt, threadEvidenceAt: reference.evidenceAt }
  expect(FocusSchema.safeParse({ headline: 'Both', items: [{ ...item, threadEvidenceAt: undefined }] }).success).toBe(false)
  publishFocus(source, { headline: 'Both', items: [item] }, new Date().toISOString())
  expect(readFocus(source).focus?.items[0]?.stale).toBe(false)
  const thread = h.runtime.store.threads.get(reference.threadKey)!
  h.runtime.store.threads.save({ ...thread, lastAt: '2026-11-05T10:00:00Z' })
  expect(readFocus(source).focus?.items[0]?.stale).toBe(true)
})

it('returns lossless JSON when optional ticket fields are absent or partial', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('focus-json-open', 'Review the open ticket'))
  const source = h.runtime.context(workbenchKind)
  const open = h.runtime.store.tickets.get(ticket.id)!
  h.runtime.store.tickets.save({ ...open, attention: { id: 'attention-1', question: 'Proceed?' } })
  const ended = await h.acceptedTicket(feishu('focus-json-ended', 'Review the ended ticket'))
  const closing = h.runtime.store.tickets.get(ended.ticket.id)!
  h.runtime.store.tickets.save({ ...closing, ended: { at: '2026-11-05T00:00:00Z', by: 'executor', outcome: 'completed' } })
  const openProjection = focusContext(source)
  const endedProjection = focusContext(source, ended.ticket.id)
  for (const projection of [openProjection, endedProjection]) {
    // DSH rejects a tool result carrying an own `undefined` property, like an absent follow-up or end reason.
    expect(JSON.parse(JSON.stringify(projection))).toStrictEqual(projection)
  }
  // Present optional fields survive; absent nested values are omitted rather than replaced.
  expect(openProjection.tickets[0]).toMatchObject({ attention: { id: 'attention-1', question: 'Proceed?' } })
  expect('followup' in openProjection.tickets[0]!).toBe(false)
  expect('ended' in openProjection.tickets[0]!).toBe(false)
  expect('label' in openProjection.threads[0]!).toBe(false)
  expect(endedProjection.tickets[0]).toMatchObject({ ended: { at: '2026-11-05T00:00:00Z', by: 'executor', outcome: 'completed' } })
  expect('reason' in endedProjection.tickets[0]!.ended!).toBe(false)
})

