import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Engine } from '../src/core/index.ts'
import type { Ticket } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { compareTickets, ManagementPatchSchema, updateTicketManagement } from '../src/app/management.ts'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-management-'))
  store = new Store(join(directory, 'state.sqlite'))
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const engine = () => new Engine({ repo: store, scope: { scope: () => ({ listened: true, observed: false }) },
  policy: () => ({ version: 'v', paused: false, gate: () => ({ admissible: false, reason: 'test' }), revalidate: () => true,
    admitsInferred: () => false, evalTimeoutMs: 1000 }),
  assessor: { request: () => {} }, executor: { start: () => {}, deliver: () => {}, stop: () => {} },
  outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
const ticket = (id: string, fields: Partial<Ticket> = {}): Ticket => ({ id, title: id, decisionId: 'd', channels: [], undelivered: [],
  createdAt: '2026-11-04T01:00:00.000Z', updatedAt: '2026-11-04T01:00:00.000Z',
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'owner' }, scope: '' },
  origin: { triggerId: 'request', triggerIds: ['request'] }, assignments: [], inputs: [], ...fields })

it('persists management changes without overwriting current work and clears an explicitly removed deadline', () => {
  store.tickets.save(ticket('t1', { title: 'Latest title', inputs: [{ id: 'new', kind: 'note', text: 'Latest fact', at: 'now' }] }))
  expect(updateTicketManagement(engine(), 't1', ManagementPatchSchema.parse({ priority: 'high', dueAt: '2026-11-05T10:00:00+08:00' })))
    .toEqual({ saved: true, priority: 'high', dueAt: '2026-11-05T02:00:00.000Z', paused: false })
  store.close(); store = new Store(join(directory, 'state.sqlite'))
  expect(store.tickets.get('t1')).toMatchObject({ title: 'Latest title', priority: 'high', dueAt: '2026-11-05T02:00:00.000Z',
    inputs: [{ id: 'new', text: 'Latest fact' }] })
  updateTicketManagement(engine(), 't1', { dueAt: null })
  expect(store.tickets.get('t1')!.priority).toBe('high')
  expect(store.tickets.get('t1')!.dueAt).toBeUndefined()
  updateTicketManagement(engine(), 't1', { paused: true })
  store.close(); store = new Store(join(directory, 'state.sqlite'))
  expect(store.tickets.get('t1')!.paused).toBe(true)
  updateTicketManagement(engine(), 't1', { paused: false })
  expect(store.tickets.get('t1')!.paused).toBe(false)
})

it('rejects malformed management input and changes to ended or missing work', () => {
  for (const patch of [{}, { priority: 'critical' }, { dueAt: 'tomorrow' }, { dueAt: '2026-02-30T00:00:00Z' }, { title: 'other' }]) {
    expect(ManagementPatchSchema.safeParse(patch).success).toBe(false)
  }
  store.tickets.save(ticket('done', { ended: { at: 'now', by: 'executor', outcome: 'completed' } }))
  expect(() => updateTicketManagement(engine(), 'done', { priority: 'high' })).toThrow('Ticket has ended')
  expect(() => updateTicketManagement(engine(), 'missing', { priority: 'high' })).toThrow('Unknown ticket')
})

it('orders priority before deadline and preserves oldest-first fairness within the same priority and deadline', () => {
  const tasks = [ticket('plain-new', { createdAt: '2026-11-04T02:00:00Z' }), ticket('due-later', { dueAt: '2026-11-08T00:00:00Z' }),
    ticket('urgent', { priority: 'urgent' }), ticket('plain-old'), ticket('due-sooner', { dueAt: '2026-11-06T00:00:00Z' }),
    ticket('low', { priority: 'low', dueAt: '2026-11-01T00:00:00Z' })]
  expect(tasks.sort(compareTickets).map(task => task.id)).toEqual(['urgent', 'due-sooner', 'due-later', 'plain-old', 'plain-new', 'low'])
})
