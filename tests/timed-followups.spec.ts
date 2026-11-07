/** Timed work returns to its original ticket once, using the same durable input path as normal context. */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Engine, ticketFollowups, type Ticket } from '../src/core/index.ts'
import { Followups, FollowupRequestSchema, followupReceipts } from '../src/app/followups.ts'
import { Store } from '../src/app/store.ts'

let directory: string
let store: Store
let clock: number
let paused: boolean
let authorized: boolean
let followups: Followups
let engine: Engine
const deliver = vi.fn()
const iso = () => new Date(clock).toISOString()
const ticket = (id = 'task'): Ticket => ({ id, title: 'Read the project update', decisionId: 'decision',
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'owner' }, scope: 'Follow this project' },
  channels: [], assignments: [{ id: `assignment-${id}`, state: 'running', createdAt: iso() }], inputs: [], undelivered: [],
  createdAt: iso(), updatedAt: iso(), origin: { triggerId: 'request', triggerIds: ['request'] } })
const request = (request_id = 'check-update', minutes = 1) => ({ request_id,
  at: new Date(clock + minutes * 60_000).toISOString(), reason: 'Check whether the requested document is available' })

function startService(): Followups {
  engine = new Engine({ repo: store, policy: () => ({ version: 'v', paused, gate: () => ({ admissible: false, reason: 'test' }),
    revalidate: () => authorized, admitsInferred: () => false, evalTimeoutMs: 1000 }),
  scope: { scope: () => ({ listened: true, observed: false }) }, assessor: { request: () => {} },
  executor: { start: () => {}, deliver, stop: () => {} }, outbox: { send: () => {}, status: () => undefined, withdraw: () => {} }, now: iso })
  return new Followups({ store, engine, paused: () => paused, authorized: () => authorized }, () => clock)
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ticket-followups-'))
  store = new Store(join(directory, 'state.sqlite'))
  clock = Date.parse('2026-11-04T00:00:00Z')
  paused = false; authorized = true; deliver.mockReset()
  followups = startService()
  store.tickets.save(ticket())
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('normalizes the supplied time and wakes the original assignment once after a service restart', () => {
  const input = { ...request(), at: '2026-11-04T08:01:00+08:00' }
  const saved = followups.schedule('task', FollowupRequestSchema.parse(input))
  expect(saved.at).toBe('2026-11-04T00:01:00.000Z')
  expect(ticketFollowups(store.tickets.get('task')!)[0]).toMatchObject({ id: input.request_id, at: saved.at, reason: input.reason })
  expect(followups.runDue()).toBe(0)
  clock += 60_000
  store.close(); store = new Store(join(directory, 'state.sqlite')); followups = startService()
  expect(followups.runDue()).toBe(1)
  store.close(); store = new Store(join(directory, 'state.sqlite')); followups = startService()
  expect(followups.runDue()).toBe(0)
  expect(deliver).toHaveBeenCalledTimes(1)
  const current = store.tickets.get('task')!
  expect(ticketFollowups(current)).toEqual([])
  expect(current.inputs).toEqual([expect.objectContaining({ kind: 'note', text: expect.stringContaining(input.reason) })])
  expect(current.undelivered).toHaveLength(1)
  expect(followups.schedule('task', FollowupRequestSchema.parse(input))).toMatchObject({ status: 'fired' })
  expect(current.assignments[0]!.id).toBe('assignment-task')
})

it('keeps a due follow-up while paused, waiting for a person or lacking current authority', () => {
  followups.schedule('task', request())
  clock += 60_000
  paused = true
  expect(followups.runDue()).toBe(0)
  paused = false; authorized = false
  expect(followups.runDue()).toBe(0)
  authorized = true
  const current = store.tickets.get('task')!
  current.paused = true; store.tickets.save(current)
  expect(followups.runDue()).toBe(0)
  delete current.paused
  current.attention = { id: 'question', question: 'Which project?' }; store.tickets.save(current)
  expect(followups.runDue()).toBe(0)
  delete current.attention
  current.assignments[0]!.report = { state: 'blocked', summary: 'Waiting for owner', at: iso() }; store.tickets.save(current)
  expect(followups.runDue()).toBe(0)
  current.assignments[0]!.report = { state: 'waiting', summary: 'Owner answered, wait for date', at: iso() }; store.tickets.save(current)
  expect(followups.runDue()).toBe(1)
})

it('keeps the schedule until an assignment is running instead of losing a wake during launch', () => {
  followups.schedule('task', request())
  const current = store.tickets.get('task')!
  current.assignments[0]!.state = 'pending'; store.tickets.save(current)
  clock += 60_000
  expect(followups.runDue()).toBe(0)
  expect(ticketFollowups(store.tickets.get('task')!)).toHaveLength(1)
  current.assignments[0]!.state = 'running'; store.tickets.save(current)
  expect(followups.runDue()).toBe(1)
})

it('keeps independent checks across restart and cancels one without reviving it on retry', () => {
  const first = request('first'), second = request('second', 2)
  followups.schedule('task', first)
  const legacy = store.tickets.get('task')!
  legacy.followup = legacy.followups![0]
  delete legacy.followups
  store.tickets.save(legacy)
  followups.schedule('task', second)
  store.close(); store = new Store(join(directory, 'state.sqlite')); followups = startService()
  expect(ticketFollowups(store.tickets.get('task')!).map(item => item.id)).toEqual(['first', 'second'])
  expect(followups.cancel('task', 'first')).toMatchObject({ cancelled: true, receipt: { requestId: 'first', status: 'cancelled' } })
  expect(followups.cancel('task', 'first')).toEqual({ cancelled: false })
  expect(followups.schedule('task', first).status).toBe('cancelled')
  clock += 120_000
  expect(followups.runDue()).toBe(1)
  expect(store.get(followupReceipts('task', 'second'))!.status).toBe('fired')
  expect(ticketFollowups(store.tickets.get('task')!)).toEqual([])
})

it('cancels all pending checks when a project is ended', () => {
  followups.schedule('task', request('first'))
  followups.schedule('task', request('second', 2))
  const stopped = store.tickets.get('task')!
  stopped.ended = { by: 'human', outcome: 'stopped', at: iso() }; store.tickets.save(stopped)
  expect(followups.cancel('task').receipts).toHaveLength(2)
  expect(ticketFollowups(store.tickets.get('task')!)).toEqual([])
  clock += 120_000
  expect(followups.runDue()).toBe(0)
})

it('delivers two checks for the same ticket once each, even after restart', () => {
  followups.schedule('task', request('first'))
  followups.schedule('task', { ...request('second'), reason: 'Check the payment' })
  clock += 60_000
  expect(followups.runDue()).toBe(2)
  store.close(); store = new Store(join(directory, 'state.sqlite')); followups = startService()
  expect(followups.runDue()).toBe(0)
  const current = store.tickets.get('task')!
  expect(current.inputs.filter(item => item.kind === 'note')).toHaveLength(2)
  expect(ticketFollowups(current)).toEqual([])
  expect(store.get(followupReceipts('task', 'first'))!.status).toBe('fired')
  expect(store.get(followupReceipts('task', 'second'))!.status).toBe('fired')
})

it('never resumes a completed or manually stopped ticket and lets its ended event clear the timer', () => {
  followups.schedule('task', request())
  const current = store.tickets.get('task')!
  current.ended = { by: 'human', outcome: 'stopped', at: iso() }; store.tickets.save(current)
  clock += 60_000
  expect(followups.runDue()).toBe(0)
  expect(deliver).not.toHaveBeenCalled()
  expect(followups.cancel('task')).toMatchObject({ receipt: { status: 'cancelled' } })
  expect(() => followups.schedule('task', request('new'))).toThrow('Ticket ended')
})

it('rolls the fired receipt and timer deletion back together if input enqueue fails', () => {
  const saved = request()
  followups.schedule('task', saved)
  clock += 60_000
  deliver.mockImplementationOnce(() => { throw new Error('enqueue failed') })
  expect(() => followups.runDue()).toThrow('enqueue failed')
  expect(ticketFollowups(store.tickets.get('task')!)[0]!.id).toBe(saved.request_id)
  expect(store.tickets.get('task')!.inputs).toEqual([])
  expect(store.get(followupReceipts('task', saved.request_id))!.status).toBe('scheduled')
  expect(followups.runDue()).toBe(1)
  expect(store.tickets.get('task')!.inputs).toHaveLength(1)
})

it('rejects past times and conflicting reuse of a request id without changing the current schedule', () => {
  expect(() => followups.schedule('task', { ...request(), at: iso() })).toThrow('future')
  const saved = request()
  followups.schedule('task', saved)
  expect(() => followups.schedule('task', { ...saved, reason: 'different instruction' })).toThrow('different content')
  expect(ticketFollowups(store.tickets.get('task')!)[0]!.reason).toBe(saved.reason)
  expect(() => FollowupRequestSchema.parse({ ...saved, at: 'tomorrow morning' })).toThrow()
  expect(() => FollowupRequestSchema.parse({ ...saved, reason: ' ' })).toThrow()
})

it('does not let blocked earlier timers starve eligible work and bounds each pass', () => {
  const waiting = ticket('waiting')
  waiting.attention = { id: 'q', question: 'Need a decision' }; store.tickets.save(waiting)
  followups.schedule('waiting', request('wait'))
  for (let index = 0; index < 33; index++) {
    const id = `task-${index}`
    store.tickets.save(ticket(id)); followups.schedule(id, request(id))
  }
  clock += 60_000
  expect(followups.runDue()).toBe(32)
  expect(followups.runDue()).toBe(1)
  expect(ticketFollowups(store.tickets.get('waiting')!)).toHaveLength(1)
})
