import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Assignment, AssessmentOutcome, ExecutionHandoff, Ticket } from '../src/core/index.ts'
import type { CodexHost } from '../src/executor/codex.ts'
import { Effects } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testMachine } from './fixtures/deployment.ts'
import { KV } from '../src/kv.ts'

const runs = vi.hoisted(() => ({ started: [] as { ticketId: string; kind: string }[], hosts: [] as CodexHost[],
  active: new Map<string, Set<string>>(), released: [] as { ticketId: string; kind: string }[],
  onRelease: undefined as undefined | ((id: string) => Promise<void>) }))

/** Keep real durable Effects and WorkerSlots while substituting the two external execution transports. */
function transport(host: CodexHost, kind: 'codex' | 'dsh') {
  const active = new Set<string>()
  runs.active.set(kind, active); runs.hosts.push(host)
  const launch = kind === 'dsh' ? 'dshLaunch' : 'launch'
  host.effects.handle(launch, async ({ ticketId, assignmentId }) => {
    const ticket = host.store.tickets.get(ticketId)
    if (!ticket) return
    host.beforeLaunch?.(ticketId)
    host.slots!.reserve(ticketId, 'launch')
    active.add(ticketId)
    runs.started.push({ ticketId, kind })
    store.tickets.save({ ...ticket, assignments: ticket.assignments.map(item => item.id === assignmentId
      ? { ...item, state: 'running' } : item) })
    host.slots!.free(ticketId)
  }, { limit: () => host.paused() ? 0 : host.slots!.launches(), retry: [1, 1] })
  return {
    prepare: (ticket: Ticket, _outcome: AssessmentOutcome) => ({ ...ticket,
      execution: { name: ticket.id, directory: `/work/${ticket.id}`, assignment: '' } }),
    start: (ticket: Ticket, assignment: Assignment) => host.effects.enqueue(launch, assignment.id,
      { ticketId: ticket.id, assignmentId: assignment.id }),
    activeTicketIds: () => [...active], install: () => {}, resume: () => {}, stop: () => {}, deliver: () => {},
    releaseTicket: async (ticketId: string) => { runs.released.push({ ticketId, kind }); await runs.onRelease?.(ticketId) },
    shutdown: async () => {}, dispose: () => {},
  }
}

vi.mock('../src/executor/codex.ts', () => ({ CodexExecutor: function(host: CodexHost) { return transport(host, 'codex') } }))
vi.mock('../src/executor/dsh.ts', async importOriginal => ({ ...await importOriginal<object>(),
  DshExecutor: function(host: CodexHost) { return transport(host, 'dsh') } }))

import { ExecutorRouter } from '../src/executor/router.ts'

let directory: string, store: Store, effects: Effects, clock: number
let router: ExecutorRouter
beforeEach(() => {
  runs.started.length = 0; runs.hosts.length = 0; runs.active.clear(); runs.released.length = 0; runs.onRelease = undefined
  directory = mkdtempSync(join(tmpdir(), 'executor-router-'))
  store = new Store(join(directory, 'state.sqlite'))
  store.saveSettings({ ...store.settings(), executor: { ...store.settings().executor, maxWorkers: 1 } })
  clock = Date.now()
  effects = new Effects(store, new HealthBoard(), () => clock)
})
afterEach(async () => { await effects.drain(); router?.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }) })
const pending = (id: string, kind: 'codex' | 'dsh', fields: Partial<Ticket> = {}): Ticket => ({ id, title: id, decisionId: 'd', channels: [],
  undelivered: [], createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z',
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'owner' }, scope: '' },
  origin: { triggerId: id, triggerIds: [id] }, assignments: [{ id: `a-${id}`, state: 'pending', createdAt: '2026-11-04T00:00:00Z' }],
  inputs: [], execution: { executor: kind, name: id, directory: `/work/${id}`, assignment: '' }, ...fields })
function startRouter() {
  const engine = { assignExecutor: (ticketId: string, executor: 'codex' | 'dsh', handoff?: ExecutionHandoff) => {
    const ticket = store.tickets.get(ticketId)!
    store.tickets.save({ ...ticket, execution: { ...ticket.execution!, executor,
      ...handoff ? { handoffs: [...ticket.execution!.handoffs ?? [], handoff] } : {} } })
  } }
  const host = { store, effects, machine: testMachine(), paused: () => false, ticketPaused: (id: string) => !!store.tickets.get(id)?.paused,
    launchReady: (id: string) => effects.launchReady(id), closing: () => false, engine, codex: { command: 'unused' } } as unknown as CodexHost
  router = new ExecutorRouter(host)
  router.migrateLegacyBindings()
  return router
}

it('dispatches urgent work across executor queues before normal work and keeps one shared slot', async () => {
  store.tickets.save(pending('normal', 'codex'))
  store.tickets.save(pending('urgent', 'dsh', { priority: 'urgent' }))
  startRouter()
  router.start(store.tickets.get('normal')!, store.tickets.get('normal')!.assignments[0]!)
  effects.start(); await effects.idle()
  expect(runs.started).toEqual([{ ticketId: 'urgent', kind: 'dsh' }])
  expect(router.activeCount()).toBe(1)
  expect(effects.pending('launch')).toBe(true)
  runs.active.get('dsh')!.clear(); clock += 2
  await effects.idle()
  expect(runs.started).toEqual([{ ticketId: 'urgent', kind: 'dsh' }, { ticketId: 'normal', kind: 'codex' }])
  expect(router.activeCount()).toBe(1)
})

it('does not let blocked high-priority work starve an independent runnable task', async () => {
  store.tickets.save(pending('blocked', 'dsh', { priority: 'urgent', attention: { id: 'q', question: 'Need a real decision' },
    assignments: [{ id: 'a-blocked', state: 'pending', createdAt: '2026-11-04T00:00:00Z',
      report: { state: 'failed', summary: 'Preparation needs a person', at: '2026-11-04T00:01:00Z' } }] }))
  store.tickets.save(pending('normal', 'codex'))
  startRouter()
  router.start(store.tickets.get('normal')!, store.tickets.get('normal')!.assignments[0]!)
  effects.start(); await effects.idle()
  expect(runs.started).toContainEqual({ ticketId: 'normal', kind: 'codex' })
})

it('preserves old Codex bindings and scopes each executor to its own persistent tickets', () => {
  const old = pending('legacy', 'codex'); delete old.execution!.executor
  const oldDsh = pending('dsh', 'dsh'); delete oldDsh.execution!.executor
  store.tickets.save(old); store.tickets.save(oldDsh)
  store.set(KV.codex.binding('legacy'), { threadId: 'existing-codex', assignmentId: 'a-legacy' })
  store.set(KV.sessions.prompts('worker-legacy'), [0])
  store.set(KV.sessions.prompts('worker-dsh'), [0])
  startRouter()
  expect(store.tickets.get('legacy')!.execution!.executor).toBe('codex')
  expect(runs.hosts[0]!.store.tickets.list().map(ticket => ticket.id)).toEqual(['legacy'])
  expect(runs.hosts[1]!.store.tickets.list().map(ticket => ticket.id)).toEqual(['dsh'])
  expect(runs.hosts[0]!.store.tickets.get('dsh')).toBeUndefined()
  expect(runs.hosts[1]!.store.tickets.get('legacy')).toBeUndefined()
  expect(() => runs.hosts[0]!.store.atomic(() => runs.hosts[0]!.store.settings())).not.toThrow()
  expect(runs.hosts[0]!.slots).toBe(runs.hosts[1]!.slots)
})

it('continues independent work while a high-priority task is in launch backoff', async () => {
  store.tickets.save(pending('backoff', 'dsh', { priority: 'urgent' }))
  store.tickets.save(pending('normal', 'codex'))
  startRouter()
  store.db.prepare("UPDATE effect SET due = ? WHERE kind = 'dshLaunch'").run(clock + 1000)
  router.start(store.tickets.get('normal')!, store.tickets.get('normal')!.assignments[0]!)
  effects.start(); await effects.idle()
  expect(runs.started).toEqual([{ ticketId: 'normal', kind: 'codex' }])
})

it('holds a paused ticket without blocking other work and launches it after resume', async () => {
  store.tickets.save(pending('paused', 'dsh', { priority: 'urgent', paused: true }))
  store.tickets.save(pending('normal', 'codex'))
  startRouter()
  router.start(store.tickets.get('normal')!, store.tickets.get('normal')!.assignments[0]!)
  effects.start(); await effects.idle()
  expect(runs.started).toEqual([{ ticketId: 'normal', kind: 'codex' }])
  store.tickets.save({ ...store.tickets.get('paused')!, paused: false })
  runs.active.get('codex')!.clear(); clock += 2
  await effects.idle()
  expect(runs.started).toContainEqual({ ticketId: 'paused', kind: 'dsh' })
})

it('binds new work to the selected executor with Codex as the default', () => {
  startRouter()
  const outcome = { kind: 'accept' as const, title: 'Task', scope: 'Task', reason: 'Explicit' }
  expect(router.prepare(pending('a', 'codex'), outcome).execution?.executor).toBe('codex')
  expect(router.prepare(pending('b', 'codex'), { ...outcome, executor: 'dsh' }).execution?.executor).toBe('dsh')
})

const handoff = { purpose: 'Continue the same research', decisions: 'Use the accepted scope', results: 'Source read',
  evidence: 'Document and prior report', remaining: 'Organize the final note' }
const idle = (id: string, kind: 'codex' | 'dsh', fields: Partial<Ticket> = {}) => pending(id, kind, {
  assignments: [{ id: `a-${id}`, state: 'running', createdAt: '2026-11-04T00:00:00Z', idleAt: '2026-11-04T00:01:00Z' }], ...fields })

it('releases the idle owner, persists a complete handoff and retains both contexts for a return', async () => {
  store.tickets.save(idle('task', 'codex'))
  store.set(KV.codex.binding('task'), { threadId: 'native-context' })
  store.set(KV.sessions.prompts('worker-task'), [1])
  startRouter()
  const note = vi.fn((id: string, text: string) => {
    expect(store.tickets.get(id)!.execution!.executor).toBe('dsh')
    for (const value of Object.values(handoff)) expect(text).toContain(value)
  })
  expect(await router.transfer('task', 'dsh', handoff, note)).toEqual({ changed: true, executor: 'dsh' })
  expect(runs.released).toEqual([{ ticketId: 'task', kind: 'codex' }])
  expect(store.tickets.get('task')!.execution!.handoffs).toEqual([{ from: 'codex', to: 'dsh', at: expect.any(String), handoff }])
  expect(store.get(KV.codex.binding('task'))).toEqual({ threadId: 'native-context' })
  expect(store.get(KV.sessions.prompts('worker-task'))).toEqual([1])
  expect(await router.transfer('task', 'dsh', handoff, note)).toEqual({ changed: false, executor: 'dsh' })
  expect(note).toHaveBeenCalledTimes(1)
  expect(await router.transfer('task', 'codex', handoff, () => {})).toEqual({ changed: true, executor: 'codex' })
  expect(store.tickets.get('task')!.execution!.handoffs).toHaveLength(2)
})

it('holds both execution paths while releasing, rejecting a concurrent transfer or incoming-input race', async () => {
  store.tickets.save(idle('task', 'codex'))
  startRouter()
  const released = Promise.withResolvers<void>()
  runs.onRelease = async () => released.promise
  const note = vi.fn()
  const transfer = router.transfer('task', 'dsh', handoff, note)
  expect(runs.hosts.every(host => host.ticketPaused!('task'))).toBe(true)
  await expect(router.transfer('task', 'dsh', handoff, note)).rejects.toThrow('already in progress')
  store.tickets.save({ ...store.tickets.get('task')!, inputs: [{ id: 'new', kind: 'text', at: '2026-11-04T00:02:00Z', text: 'New instruction' }], undelivered: ['new'] })
  released.resolve()
  await expect(transfer).rejects.toThrow('pending question or input')
  expect(store.tickets.get('task')!.execution!.executor).toBe('codex')
  expect(note).not.toHaveBeenCalled()
  expect(runs.hosts.every(host => !host.ticketPaused!('task'))).toBe(true)
})

it('refuses invalid, active, paused, attention and unresolved source-turn transfers without releasing the owner', async () => {
  store.tickets.save(idle('active', 'codex')); store.tickets.save(idle('paused', 'dsh', { paused: true }))
  store.tickets.save(idle('question', 'dsh', { attention: { id: 'q', question: 'Important decision' } }))
  store.tickets.save(idle('uncertain', 'codex'))
  store.set(KV.codex.binding('uncertain'), { threadId: 'native', pending: { marker: 'uncertain', inputIds: [] } })
  startRouter(); runs.active.get('codex')!.add('active')
  for (const id of ['active', 'paused', 'question', 'uncertain']) {
    await expect(router.transfer(id, id === 'paused' || id === 'question' ? 'codex' : 'dsh', handoff, () => {})).rejects.toThrow()
  }
  await expect(router.transfer('question', 'other' as never, handoff, () => {})).rejects.toThrow()
  await expect(router.transfer('question', 'codex', { ...handoff, evidence: '' }, () => {})).rejects.toThrow()
  expect(runs.released).toEqual([])
})

it.each(['blocked', 'failed'] as const)('preserves an idle owner whose %s report still needs a person', async state => {
  const ticket = idle('held', 'dsh')
  ticket.assignments[0]!.report = { state, summary: 'Needs intervention', at: '2026-11-04T00:05:00Z' }
  store.tickets.save(ticket)
  startRouter()
  await expect(router.transfer(ticket.id, 'codex', handoff, () => {})).rejects.toThrow()
  expect(runs.released).toEqual([])
  expect(store.tickets.get(ticket.id)!.execution!.executor).toBe('dsh')
})

it('retains the source owner when its version changes during release or handoff input cannot be saved', async () => {
  store.tickets.save(idle('task', 'codex'))
  startRouter()
  runs.onRelease = async () => { store.tickets.save({ ...store.tickets.get('task')!, priority: 'urgent' }) }
  await expect(router.transfer('task', 'dsh', handoff, () => {})).rejects.toThrow('changed during executor release')
  expect(store.tickets.get('task')!.execution!.executor).toBe('codex')
  runs.onRelease = undefined
  await expect(router.transfer('task', 'dsh', handoff, () => { throw new Error('Handoff storage failed') })).rejects.toThrow('Handoff storage failed')
  expect(store.tickets.get('task')!.execution!.executor).toBe('codex')
  expect(store.tickets.get('task')!.execution!.handoffs).toBeUndefined()
})

it('initializes a first DSH-to-Codex documentation stage and preserves prior model evidence on later transfers', async () => {
  store.tickets.save(idle('first', 'dsh'))
  store.tickets.save(idle('returning', 'dsh'))
  const history = [{ stage: 'research' as const, model: 'gpt-6-astra', at: '2026-11-03T00:00:00Z' }]
  const turns = [{ turnId: 'previous', requestedModel: 'gpt-6-astra', actualModel: 'gpt-6-astra', evidence: 'rollout turn_context' }]
  store.set(KV.codex.stages('returning'), { current: 'research', history, turns })
  startRouter()
  await router.transfer('first', 'codex', handoff, () => {}, 'documentation')
  expect(store.get(KV.codex.stages('first'))).toMatchObject({ current: 'documentation',
    history: [{ stage: 'documentation', model: 'gpt-6.1-terra', handoff }], turns: [] })
  await router.transfer('returning', 'codex', handoff, () => {}, 'implementation')
  expect(store.get(KV.codex.stages('returning'))).toMatchObject({ current: 'implementation',
    history: [history[0], { stage: 'implementation', model: 'gpt-6.1-sol', handoff }], turns })
})

it('rejects malformed or DSH stages and keeps explicit Codex instance model semantics', async () => {
  store.tickets.save(idle('source', 'codex')); store.tickets.save(idle('fixed', 'dsh'))
  startRouter()
  await expect(router.transfer('source', 'dsh', handoff, () => {}, 'documentation')).rejects.toThrow('Codex stages require')
  await expect(router.transfer('fixed', 'codex', handoff, () => {}, 'invalid' as never)).rejects.toThrow()
  expect(runs.released).toEqual([])
  expect(store.get(KV.codex.stages('source'))).toBeUndefined()
  expect(store.tickets.get('source')!.execution!.executor).toBe('codex')
  runs.hosts[0]!.codex.model = 'explicit-model'
  await router.transfer('fixed', 'codex', handoff, () => {}, 'documentation')
  expect(store.get(KV.codex.stages('fixed'))).toBeUndefined()
})
