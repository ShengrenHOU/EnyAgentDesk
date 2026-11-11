/** Timed work returns to its original ticket once, using the same durable input path as normal context. */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Engine, key, ticketFollowups, type Ticket } from '../src/core/index.ts'
import { Followups, FollowupRequestSchema, automationCleanups, followupReceipts, migrationIntents, type AutomationRef, type SchedulePort } from '../src/app/followups.ts'
import { Store } from '../src/app/store.ts'

let directory: string
let store: Store
let clock: number
let paused: boolean
let authorized: boolean
let schedule: SchedulePort | undefined
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
  return new Followups({ store, engine, paused: () => paused, authorized: () => authorized, masterId: 'master',
    schedule: () => schedule }, () => clock)
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ticket-followups-'))
  store = new Store(join(directory, 'state.sqlite'))
  clock = Date.parse('2026-11-04T00:00:00Z')
  paused = false; authorized = true; deliver.mockReset(); schedule = undefined
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

it('lists every pending check in time order with the same blockers as the scheduler, across restart and cancellation', () => {
  for (let index = 0; index < 12; index++) {
    const id = `task-${index}`
    store.tickets.save(ticket(id))
    followups.schedule(id, request('early', 1))
    followups.schedule(id, request('later', 3))
  }
  const held = store.tickets.get('task-0')!
  held.attention = { id: 'question', question: 'Proceed?' }; store.tickets.save(held)
  const pausedTicket = store.tickets.get('task-1')!
  pausedTicket.paused = true; store.tickets.save(pausedTicket)
  const waiting = store.tickets.get('task-2')!
  waiting.assignments = []; store.tickets.save(waiting)
  clock += 90_000
  const pending = followups.pending()
  expect(pending).toHaveLength(24)
  expect(pending.map(item => item.at)).toEqual(pending.map(item => item.at).sort())
  expect(pending.find(item => item.ticketId === held.id)).toMatchObject({ due: true, blocked: 'attention' })
  expect(pending.find(item => item.ticketId === pausedTicket.id)?.blocked).toBe('ticketPaused')
  expect(pending.find(item => item.ticketId === waiting.id)?.blocked).toBe('assignment')
  store.close(); store = new Store(join(directory, 'state.sqlite')); followups = startService()
  expect(followups.pending()).toEqual(pending)
  followups.cancel('task-0', 'early')
  expect(followups.pending()).toHaveLength(23)
  expect(followups.runDue()).toBe(9)
  expect(followups.pending().filter(item => item.due)).toHaveLength(2)
  paused = true
  expect(followups.pending().every(item => item.blocked === 'paused')).toBe(true)
  paused = false; authorized = false
  expect(followups.pending().find(item => item.ticketId === 'task-3')?.blocked).toBe('authority')
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

it('projects the latest report with each pending check', () => {
  const current = store.tickets.get('task')!
  current.assignments[0]!.report = { state: 'waiting', summary: 'Waiting for the signed receipt', at: iso() }
  store.tickets.save(current)
  followups.schedule('task', request())
  expect(followups.pending()).toEqual([expect.objectContaining({ ticketId: 'task', id: 'check-update',
    last: { state: 'waiting', summary: 'Waiting for the signed receipt', at: iso() } })])
})

it('moves a mechanical check to the host automation once, binding the main session', async () => {
  const create = vi.fn(async (sessionId: string, task: { title: string; prompt: string; at: string }) =>
    ({ id: 'auto-1', sessionId, title: task.title, scheduledAt: task.at }))
  const remove = vi.fn(async () => ({ deleted: true }))
  schedule = { create, delete: remove, catalog: async () => [{ id: 'auto-1', sessionId: 'master', title: 'check',
    scheduledAt: request().at, status: 'active', prompt: '' }] }
  followups = startService()
  const saved = followups.schedule('task', request())
  const receipt = await followups.migrate('task', saved.requestId)
  expect(receipt).toMatchObject({ status: 'migrated', automation: { id: 'auto-1', sessionId: 'master', scheduledAt: saved.at } })
  expect(create).toHaveBeenCalledWith('master', { title: expect.stringContaining('自动化检查'), prompt: expect.stringContaining('Check whether'), at: saved.at })
  expect(ticketFollowups(store.tickets.get('task')!)).toEqual([])
  expect(await followups.migrate('task', saved.requestId)).toEqual(receipt)
  expect(create).toHaveBeenCalledTimes(1)
  expect(await followups.automations()).toMatchObject({ available: true,
    items: [expect.objectContaining({ id: 'auto-1', ticketId: 'task', requestId: saved.requestId, status: 'scheduled' })] })
  clock += 60_000
  expect(followups.runDue()).toBe(0)
  expect(deliver).not.toHaveBeenCalled()
})

it('deletes a migrated automation without reviving the check', async () => {
  const remove = vi.fn(async () => ({ deleted: true }))
  schedule = { create: async (sessionId, task) => ({ id: 'auto-1', sessionId, title: task.title, scheduledAt: task.at }), delete: remove }
  followups = startService()
  const saved = followups.schedule('task', request())
  await followups.migrate('task', saved.requestId)
  expect(await followups.cancelAutomation('task', saved.requestId)).toMatchObject({ cancelled: true,
    receipt: { status: 'cancelled' } })
  expect(remove).toHaveBeenCalledWith({ sessionId: 'master', id: 'auto-1' })
  expect(store.get(followupReceipts('task', saved.requestId))).toMatchObject({ status: 'cancelled' })
  clock += 60_000
  expect(followups.runDue()).toBe(0)
  expect(ticketFollowups(store.tickets.get('task')!)).toEqual([])
})

it('removes migrated automations when their ticket ends', async () => {
  const remove = vi.fn(async () => ({ deleted: true }))
  schedule = { create: async (sessionId, task) => ({ id: 'auto-1', sessionId, title: task.title, scheduledAt: task.at }), delete: remove }
  followups = startService()
  const saved = followups.schedule('task', request())
  await followups.migrate('task', saved.requestId)
  const stopped = store.tickets.get('task')!
  stopped.ended = { by: 'human', outcome: 'stopped', at: iso() }; store.tickets.save(stopped)
  expect(await followups.cancelAutomations('task')).toBe(1)
  expect(remove).toHaveBeenCalledTimes(1)
  expect(store.get(followupReceipts('task', saved.requestId))).toMatchObject({ status: 'cancelled' })
})

it('refuses to move a check that is due or no longer authorized', async () => {
  const create = vi.fn(async (sessionId: string, task: { title: string; prompt: string; at: string }) =>
    ({ id: 'auto-1', sessionId, title: task.title, scheduledAt: task.at }))
  schedule = { create, delete: async () => ({ deleted: true }) }
  followups = startService()
  const saved = followups.schedule('task', request())
  clock += 60_000
  await expect(followups.migrate('task', saved.requestId)).rejects.toMatchObject({ code: 'followupDue' })
  clock -= 60_000; authorized = false
  await expect(followups.migrate('task', saved.requestId)).rejects.toMatchObject({ code: 'mandateRevoked' })
  expect(create).not.toHaveBeenCalled()
  expect(ticketFollowups(store.tickets.get('task')!)).toHaveLength(1)
})

it('keeps the check on its ticket when no host automation is available', async () => {
  const saved = followups.schedule('task', request())
  await expect(followups.migrate('task', saved.requestId)).rejects.toMatchObject({ code: 'automationUnavailable' })
  expect(ticketFollowups(store.tickets.get('task')!)).toHaveLength(1)
  expect(store.get(followupReceipts('task', saved.requestId))).toMatchObject({ status: 'scheduled' })
  expect(await followups.automations()).toEqual({ available: false, items: [] })
})

it('leaves no orphan automation when the check fires while the host task is being created', async () => {
  const remove = vi.fn(async () => ({ deleted: true }))
  schedule = { create: async (sessionId, task) => {
    const current = store.tickets.get('task')!
    current.followups = []; store.tickets.save(current)
    return { id: 'auto-1', sessionId, title: task.title, scheduledAt: task.at }
  }, delete: remove }
  followups = startService()
  const saved = followups.schedule('task', request())
  await expect(followups.migrate('task', saved.requestId)).rejects.toMatchObject({ code: 'followupFinished' })
  expect(remove).toHaveBeenCalledWith({ sessionId: 'master', id: 'auto-1' })
  expect(store.get(followupReceipts('task', saved.requestId))).toMatchObject({ status: 'scheduled' })
})

it('rechecks authority after creating the host task and removes the orphan', async () => {
  const remove = vi.fn(async () => ({ deleted: true }))
  schedule = { create: async (sessionId, task) => {
    authorized = false
    return { id: 'auto-1', sessionId, title: task.title, scheduledAt: task.at }
  }, delete: remove }
  followups = startService()
  const saved = followups.schedule('task', request())
  await expect(followups.migrate('task', saved.requestId)).rejects.toMatchObject({ code: 'mandateRevoked' })
  expect(remove).toHaveBeenCalledWith({ sessionId: 'master', id: 'auto-1' })
  expect(ticketFollowups(store.tickets.get('task')!)).toHaveLength(1)
  expect(store.get(migrationIntents('task', saved.requestId))).toBeUndefined()
})

it('adopts a host task left by a crash instead of creating a second one', async () => {
  const saved = followups.schedule('task', request())
  const marker = key('task', saved.requestId)
  const prompt = `Automation ${marker}`
  store.set(migrationIntents('task', saved.requestId), { ticketId: 'task', requestId: saved.requestId, sessionId: 'master',
    title: '自动化检查', prompt, at: saved.at, marker, createdAt: new Date(clock - 120_000).toISOString() })
  const remove = vi.fn(async () => ({ deleted: true }))
  const create = vi.fn()
  schedule = { create, delete: remove, catalog: async () => [{ id: 'auto-crash', sessionId: 'master', title: '自动化检查',
    prompt, scheduledAt: saved.at, status: 'active' as const }] }
  followups = startService()
  await followups.maintain()
  expect(create).not.toHaveBeenCalled()
  expect(ticketFollowups(store.tickets.get('task')!)).toEqual([])
  expect(store.get(followupReceipts('task', saved.requestId))).toMatchObject({ status: 'migrated',
    automation: { id: 'auto-crash' } })
  expect(store.get(migrationIntents('task', saved.requestId))).toBeUndefined()
})

it('retries deleting a duplicate task without cancelling the kept automation', async () => {
  const saved = followups.schedule('task', request())
  const marker = key('task', saved.requestId)
  const prompt = `Automation ${marker}`
  store.set(migrationIntents('task', saved.requestId), { ticketId: 'task', requestId: saved.requestId, sessionId: 'master',
    title: '自动化检查', prompt, at: saved.at, marker, createdAt: new Date(clock - 120_000).toISOString() })
  let failExtra = true
  const remove = vi.fn(async ({ id }: { id: string }) => {
    if (id === 'auto-b' && failExtra) throw new Error('Schedule is down')
    return { deleted: true }
  })
  const catalog = [{ id: 'auto-a', sessionId: 'master', title: '自动化检查', prompt, scheduledAt: saved.at, status: 'active' as const },
    { id: 'auto-b', sessionId: 'master', title: '自动化检查', prompt, scheduledAt: saved.at, status: 'active' as const }]
  schedule = { create: vi.fn(), delete: remove, catalog: async () => catalog }
  followups = startService()
  await followups.maintain()
  expect(store.get(followupReceipts('task', saved.requestId))).toMatchObject({ status: 'migrated',
    automation: { id: 'auto-a' } })
  expect(store.get(automationCleanups('auto-b'))).toBeDefined()
  failExtra = false
  await followups.maintain()
  expect(store.get(automationCleanups('auto-b'))).toBeUndefined()
  expect(store.get(followupReceipts('task', saved.requestId))).toMatchObject({ status: 'migrated' })
})

it('does not adopt a task while its migration is still in flight', async () => {
  let release!: (task: AutomationRef) => void
  const created = new Promise<AutomationRef>(resolve => { release = resolve })
  const remove = vi.fn(async () => ({ deleted: true }))
  schedule = { create: () => created, delete: remove, catalog: async () => {
    const intent = store.get(migrationIntents('task', 'slow'))!
    return [{ id: 'auto-1', sessionId: 'master', title: intent.title, prompt: intent.prompt, scheduledAt: intent.at, status: 'active' as const }]
  } }
  followups = startService()
  const saved = followups.schedule('task', request('slow', 5))
  const migration = followups.migrate('task', saved.requestId)
  clock += 61_000
  await followups.maintain()
  expect(ticketFollowups(store.tickets.get('task')!)).toHaveLength(1)
  release({ id: 'auto-1', sessionId: 'master', title: '自动化检查', scheduledAt: saved.at })
  await expect(migration).resolves.toMatchObject({ status: 'migrated', automation: { id: 'auto-1' } })
  expect(remove).not.toHaveBeenCalled()
})

it('retains a failed automation deletion and retries it on maintain', async () => {
  let failing = true
  const remove = vi.fn(async () => { if (failing) throw new Error('Schedule is down'); return { deleted: true } })
  schedule = { create: async (sessionId, task) => ({ id: 'auto-1', sessionId, title: task.title, scheduledAt: task.at }),
    delete: remove, catalog: async () => [{ id: 'auto-1', sessionId: 'master', title: '自动化检查', prompt: '', scheduledAt: iso(),
      status: 'active' as const }] }
  followups = startService()
  const saved = followups.schedule('task', request())
  await followups.migrate('task', saved.requestId)
  await expect(followups.cancelAutomations('task')).rejects.toThrow(/cleanup is retained/)
  expect(store.get(automationCleanups('auto-1'))).toBeDefined()
  expect(store.get(followupReceipts('task', saved.requestId))).toMatchObject({ status: 'migrated' })
  failing = false
  await followups.maintain()
  expect(store.get(automationCleanups('auto-1'))).toBeUndefined()
  expect(store.get(followupReceipts('task', saved.requestId))).toMatchObject({ status: 'cancelled' })
})

it('joins concurrent migrations of one check so the Host Schedule is written once', async () => {
  let release!: (task: AutomationRef) => void
  const created = new Promise<AutomationRef>(resolve => { release = resolve })
  const create = vi.fn(() => created)
  schedule = { create, delete: async () => ({ deleted: true }) }
  followups = startService()
  const saved = followups.schedule('task', request())
  const first = followups.migrate('task', saved.requestId), second = followups.migrate('task', saved.requestId)
  // The second caller waits on the same in-flight write instead of creating its own task.
  expect(create).toHaveBeenCalledTimes(1)
  release({ id: 'auto-1', sessionId: 'master', title: '自动化检查', scheduledAt: saved.at })
  const [a, b] = [await first, await second]
  expect(a).toMatchObject({ status: 'migrated', automation: { id: 'auto-1' } })
  expect(b).toEqual(a)
  expect(create).toHaveBeenCalledTimes(1)
  expect(ticketFollowups(store.tickets.get('task')!)).toEqual([])
})

it('keeps an unknown create result and adopts the task on retry instead of creating a duplicate', async () => {
  const tasks = new Map<string, { id: string; sessionId: string; title: string; scheduledAt: string; prompt: string; status: 'active' }>()
  let loseResponse = true
  const create = vi.fn(async (sessionId: string, task: { title: string; prompt: string; at: string }) => {
    const ref = { id: 'auto-1', sessionId, title: task.title, scheduledAt: task.at }
    tasks.set(ref.id, { ...ref, prompt: task.prompt, status: 'active' as const })
    // The Host Schedule write succeeded, but the caller cannot prove it from the rejected call.
    if (loseResponse) throw new Error('response lost')
    return ref
  })
  schedule = { create, delete: async ({ id }) => tasks.delete(id) ? { deleted: true } : { deleted: false, code: 'schedule_not_found' },
    catalog: async () => [...tasks.values()] }
  followups = startService()
  const saved = followups.schedule('task', request())
  await expect(followups.migrate('task', saved.requestId)).rejects.toThrow('response lost')
  expect(store.get(migrationIntents('task', saved.requestId))).toBeDefined()
  loseResponse = false
  // A retry reads the marker in the catalog and adopts the existing task; it must not create a second one.
  expect(await followups.migrate('task', saved.requestId)).toMatchObject({ status: 'migrated', automation: { id: 'auto-1' } })
  expect(create).toHaveBeenCalledTimes(1)
  expect(tasks.size).toBe(1)
  expect(ticketFollowups(store.tickets.get('task')!)).toEqual([])
})

it('reports an unverified migration instead of guessing when the Host Schedule has no catalog', async () => {
  schedule = { create: async () => { throw new Error('response lost') }, delete: async () => ({ deleted: true }) }
  followups = startService()
  const saved = followups.schedule('task', request())
  await expect(followups.migrate('task', saved.requestId)).rejects.toThrow('response lost')
  await expect(followups.migrate('task', saved.requestId)).rejects.toMatchObject({ code: 'automationPending' })
  expect(store.get(migrationIntents('task', saved.requestId))).toBeDefined()
  expect(ticketFollowups(store.tickets.get('task')!)).toHaveLength(1)
})

it('retains a cleanup by automation id when a created task cannot commit and its deletion fails', async () => {
  schedule = { create: async (sessionId, task) => {
    const current = store.tickets.get('task')!
    current.followups = []; store.tickets.save(current)
    return { id: 'auto-1', sessionId, title: task.title, scheduledAt: task.at }
  }, delete: async () => { throw new Error('Schedule is down') } }
  followups = startService()
  const saved = followups.schedule('task', request())
  await expect(followups.migrate('task', saved.requestId)).rejects.toMatchObject({ code: 'followupFinished' })
  expect(store.get(automationCleanups('auto-1'))).toBeDefined()
  // The known task is tracked by its cleanup record, so the intent does not keep trying to adopt it.
  expect(store.get(migrationIntents('task', saved.requestId))).toBeUndefined()
})


it('does not blindly recreate an unresolved migration when the host cannot list tasks', async () => {
  const create = vi.fn(async (): Promise<AutomationRef> => { throw new Error('Unknown create result') })
  schedule = { create, delete: vi.fn(async () => ({ deleted: true })) }
  followups = startService()
  const saved = followups.schedule('task', request())
  await expect(followups.migrate('task', saved.requestId)).rejects.toThrow('Unknown create result')
  await expect(followups.migrate('task', saved.requestId)).rejects.toMatchObject({ code: 'automationPending' })
  clock += 61_000
  await followups.maintain()
  expect(followups.runDue()).toBe(0)
  expect(create).toHaveBeenCalledTimes(1)
  expect(store.get(migrationIntents('task', saved.requestId))).toBeDefined()
})

it('does not let an explicit retry race with maintenance adopting the same intent', async () => {
  const saved = followups.schedule('task', request('recover', 5))
  const marker = key('task', saved.requestId), prompt = `Automation ${marker}`
  store.set(migrationIntents('task', saved.requestId), { ticketId: 'task', requestId: saved.requestId, sessionId: 'master',
    title: 'Check', prompt, at: saved.at, marker, createdAt: new Date(clock - 120_000).toISOString() })
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const remove = vi.fn(async () => { await blocked; return { deleted: true } })
  const create = vi.fn()
  schedule = { create, delete: remove, catalog: async () => ['a', 'b'].map(id => ({ id, sessionId: 'master', title: 'Check',
    prompt, scheduledAt: saved.at, status: 'active' as const })) }
  followups = startService()
  const maintaining = followups.maintain()
  await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
  await expect(followups.migrate('task', saved.requestId)).rejects.toMatchObject({ code: 'automationPending' })
  release(); await maintaining
  expect(create).not.toHaveBeenCalled()
  expect(store.get(followupReceipts('task', saved.requestId))).toMatchObject({ status: 'migrated', automation: { id: 'a' } })
  expect(remove).toHaveBeenCalledTimes(1)
})

it('holds the original check until all uncommitted duplicate tasks are removed', async () => {
  const saved = followups.schedule('task', request())
  const marker = key('task', saved.requestId), prompt = `Automation ${marker}`
  store.set(migrationIntents('task', saved.requestId), { ticketId: 'task', requestId: saved.requestId, sessionId: 'master',
    title: 'Check', prompt, at: saved.at, marker, createdAt: iso() })
  let failExtra = true
  const create = vi.fn()
  const remove = vi.fn(async ({ id }: { id: string }) => {
    if (id === 'b' && failExtra) throw new Error('Delete unavailable')
    return { deleted: true }
  })
  schedule = { create, delete: remove, catalog: async () => ['a', 'b'].map(id => ({ id, sessionId: 'master', title: 'Check',
    prompt, scheduledAt: saved.at, status: 'active' as const })) }
  followups = startService()
  clock += 61_000
  await followups.maintain()
  expect(store.get(migrationIntents('task', saved.requestId))).toBeUndefined()
  expect(store.get(automationCleanups('b'))).toBeDefined()
  expect(followups.pending()[0]?.blocked).toBe('migration')
  expect(followups.runDue()).toBe(0)
  failExtra = false
  await followups.maintain()
  expect(store.get(automationCleanups('b'))).toBeUndefined()
  expect(followups.runDue()).toBe(1)
  expect(create).not.toHaveBeenCalled()
})

it('never adopts a task when a crash left both its intent and compensation record', async () => {
  const saved = followups.schedule('task', request('recover', 5))
  const marker = key('task', saved.requestId), prompt = `Automation ${marker}`
  store.set(migrationIntents('task', saved.requestId), { ticketId: 'task', requestId: saved.requestId, sessionId: 'master',
    title: 'Check', prompt, at: saved.at, marker, createdAt: new Date(clock - 120_000).toISOString() })
  store.set(automationCleanups('to-delete'), { ticketId: 'task', requestId: saved.requestId,
    sessionId: 'master', automationId: 'to-delete' })
  const create = vi.fn()
  const remove = vi.fn(async () => ({ deleted: true }))
  schedule = { create, delete: remove, catalog: async () => [{ id: 'to-delete', sessionId: 'master', title: 'Check',
    prompt, scheduledAt: saved.at, status: 'active' as const }] }
  followups = startService()
  await expect(followups.migrate('task', saved.requestId)).rejects.toMatchObject({ code: 'automationPending' })
  await followups.maintain()
  expect(store.get(followupReceipts('task', saved.requestId))).toMatchObject({ status: 'scheduled' })
  expect(ticketFollowups(store.tickets.get('task')!)).toHaveLength(1)
  expect(remove).toHaveBeenCalledTimes(1)
  expect(create).not.toHaveBeenCalled()
})


it('marks a migrated automation unknown when its current schedule cannot be read', async () => {
  const at = request().at
  schedule = { create: async (sessionId, task) => ({ id: 'auto-read', sessionId, title: task.title, scheduledAt: task.at }),
    delete: async () => ({ deleted: true }), catalog: async () => { throw new Error('schedule offline') } }
  followups = startService()
  const saved = followups.schedule('task', request())
  await followups.migrate('task', saved.requestId)
  expect((await followups.automations()).items[0]).toMatchObject({ status: 'unknown', scheduledAt: at })
  schedule = undefined
  expect((await followups.automations()).items[0]).toMatchObject({ status: 'unknown' })
  schedule = { create: async () => { throw new Error('unused') }, delete: async () => ({ deleted: true }),
    catalog: async () => [{ id: 'auto-read', sessionId: 'master', title: 'check', scheduledAt: at, status: 'active', prompt: '' }] }
  expect((await followups.automations()).items[0]).toMatchObject({ status: 'scheduled' })
})
