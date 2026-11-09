/** The owner decision queue: pending Questions, deferrals and reversible “no action needed” records. */
import { afterEach, expect, it } from 'vitest'
import { deferDecision, forgetDecision, ignoreDecision, readQueue, restoreDecision } from '../src/sources/workbench-queue.ts'
import { workbenchKind } from '../src/sources/workbench.ts'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const NOW = Date.parse('2026-11-09T09:00:00.000Z')
const advice = { summary: 'Apply blue', reason: 'The review chose blue', risk: 'Contrast is unverified', draft: 'Blue is applied; please review.' }

/** Enable the owner workbench; answering a Question is only allowed for its configured owner. */
async function ownerWorkbench(host: Host) {
  host.runtime.sources.register(workbenchKind)
  const settings = host.runtime.store.settings()
  host.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, workbench: { enabled: true, config: { ownerId: 'owner' } } },
    policy: { ...settings.policy, sources: { ...settings.policy.sources, workbench: { allowed: [{ id: 'owner' }], admission: {} } } } })
  return host.runtime.context(workbenchKind)
}

it('lists a pending Question with its advice, hides a deferral until it is due, and keeps “no action needed” reversible', async () => {
  h = await startRuntime()
  const source = await ownerWorkbench(h)
  const { ticket } = await h.acceptedTicket(feishu('queue1', 'Prepare the note'))
  const attention = { id: 'attention-1', question: 'Send the note now?', advice }
  h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, attention })

  const queue = readQueue(source, NOW)
  expect(queue.items).toHaveLength(1)
  expect(queue.items[0]).toMatchObject({ ticketId: ticket.id, attentionId: attention.id, title: ticket.title,
    question: attention.question, advice })
  expect(queue.counts).toEqual({ open: 1, deferred: 0, ignored: 0 })

  const until = new Date(NOW + 3_600_000).toISOString()
  deferDecision(source, ticket.id, attention.id, until, NOW)
  expect(readQueue(source, NOW).items).toHaveLength(0)
  expect(readQueue(source, NOW).deferred[0]).toMatchObject({ attentionId: attention.id, until })
  // A deferral never answers the Question; it returns when its time passes.
  expect(h.runtime.store.tickets.get(ticket.id)?.attention?.id).toBe(attention.id)
  expect(readQueue(source, Date.parse(until) + 1).items).toHaveLength(1)
  restoreDecision(source, ticket.id, attention.id)
  expect(readQueue(source, NOW).deferred).toHaveLength(0)

  const receipt = ignoreDecision(source, ticket.id, attention.id, 'Already answered in person', NOW)
  expect(receipt.saved).toBe(true)
  expect(h.runtime.store.tickets.get(ticket.id)?.attention).toBeUndefined()
  expect(h.runtime.store.tickets.get(ticket.id)?.inputs.at(-1)).toMatchObject({ kind: 'answer', attentionId: attention.id })
  const ignored = readQueue(source, NOW)
  expect(ignored.items).toHaveLength(0)
  expect(ignored.ignored[0]).toMatchObject({ ticketId: ticket.id, attentionId: attention.id, reason: 'Already answered in person' })
  // A corrected judgement returns the Ticket to the open work, not silently to the queue.
  forgetDecision(source, ticket.id, attention.id)
  expect(readQueue(source, NOW).ignored).toHaveLength(0)
})

it('refuses a stale question, an empty reason and an out-of-range deferral', async () => {
  h = await startRuntime()
  const source = await ownerWorkbench(h)
  const { ticket } = await h.acceptedTicket(feishu('queue2', 'Prepare the note'))
  h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, attention: { id: 'attention-2', question: 'Proceed?' } })
  expect(() => deferDecision(source, ticket.id, 'replaced', new Date(NOW + 3_600_000).toISOString(), NOW)).toThrow('reload the workbench')
  expect(() => deferDecision(source, ticket.id, 'attention-2', new Date(NOW - 1).toISOString(), NOW)).toThrow('future')
  expect(() => ignoreDecision(source, ticket.id, 'attention-2', '   ', NOW)).toThrow('reason')
  expect(() => ignoreDecision(source, ticket.id, 'attention-2', 'No action', NOW)).not.toThrow()
})

it('shows only the current Question of each open Ticket and ignores ended tickets', async () => {
  h = await startRuntime()
  const source = await ownerWorkbench(h)
  const first = await h.acceptedTicket(feishu('queue3', 'Prepare the note'))
  const second = await h.acceptedTicket(feishu('queue4', 'Prepare the other note'))
  const row = h.runtime.store.tickets.get(first.ticket.id)!
  h.runtime.store.tickets.save({ ...row, attention: { id: 'attention-3', question: 'Send it?' } })
  h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(second.ticket.id)!, attention: { id: 'attention-4', question: 'Publish it?' } })
  h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(second.ticket.id)!, ended: { at: new Date(NOW).toISOString(), by: 'human', outcome: 'stopped' } })
  const queue = readQueue(source, NOW)
  expect(queue.items.map(item => item.attentionId)).toEqual(['attention-3'])
})
