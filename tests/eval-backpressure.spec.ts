import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Engine, MemoryRepositories, type Candidate, type Policy, type Repositories, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'

function harness(repo: Repositories = new MemoryRepositories()) {
  let time = Date.parse('2026-11-10T00:00:00Z')
  const requests: Candidate[] = []
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 1000,
    gate: trigger => trigger.meta.reject ? { admissible: false, reason: 'rejected' }
      : { admissible: true, strength: trigger.meta.explicit ? 'explicit' : 'inferred', basis: { via: 'listed' } },
    revalidate: () => true, admitsInferred: () => true }
  const engine = new Engine({ repo, policy: () => policy, scope: { scope: () => ({ listened: true, observed: true }) },
    assessor: { request: candidate => { requests.push(candidate) } }, executor: { start() {}, deliver() {}, stop() {} },
    outbox: { send() {}, status: () => undefined, withdraw() {} }, now: () => new Date(time).toISOString() })
  const receive = (id: string, explicit = false, thread = id, meta = {}) => {
    const trigger: Trigger = { id, source: 'activity', threads: [{ source: 'activity', id: thread }],
      actor: { source: 'activity', id: 'owner' }, human: true, at: '2020-01-01T00:00:00Z', text: id, meta: { explicit, ...meta } }
    engine.receive(trigger)
  }
  const finish = (candidate: Candidate) => engine.decide(candidate.triggers[0]!.id, { evalId: candidate.evalId, kind: 'ignore', reason: 'assessed' })
  return { repo, engine, requests, policy, receive, finish, tick: () => { time += 2000 },
    active: () => repo.threads.active().filter(thread => thread.evaluating) }
}

it('bounds 500 backfilled threads, keeps evidence and admits fresh explicit work without starting pending timeouts', () => {
  const h = harness()
  for (let i = 0; i < 500; i++) h.receive(`message-${i}`)
  h.engine.evaluateDue()
  expect(h.active()).toHaveLength(3)
  expect(h.repo.threads.active().reduce((sum, t) => sum + t.pending.length, 0)).toBe(497)
  h.tick(); h.receive('explicit', true); h.engine.evaluateDue()
  expect(h.active()).toHaveLength(4)
  expect(h.engine.candidate('explicit')?.strength).toBe('explicit')
  for (let i = 0; i < 10; i++) { h.tick(); h.engine.evaluateDue() }
  expect(h.requests).toHaveLength(4) // undelivered candidates never expire
  expect(h.repo.threads.list().flatMap(t => h.repo.decisions.byThread(t.key))).toEqual([])
  for (let pass = 0; pass < 501 && h.repo.threads.active().length; pass++) {
    for (const thread of h.active()) h.finish(h.engine.candidate(thread.evaluating!.triggerIds[0]!)!)
    h.engine.evaluateDue()
  }
  expect(h.repo.threads.active()).toEqual([])
  const decided = h.repo.threads.list().flatMap(t => h.repo.decisions.byThread(t.key)).flatMap(d => d.triggerIds)
  expect(decided).toHaveLength(501)
  expect(new Set(decided).size).toBe(501)
  for (let i = 0; i < 500; i++) expect(h.repo.triggers.get(`message-${i}`)).toBeDefined()
}, 30_000)

it('reserves ordinary progress under sustained explicit traffic', () => {
  const h = harness()
  for (let i = 0; i < 10; i++) h.receive(`explicit-${i}`, true)
  h.engine.evaluateDue(); expect(h.active()).toHaveLength(3)
  h.tick(); h.receive('ordinary'); h.engine.evaluateDue()
  expect(h.engine.candidate('ordinary')).toBeDefined()
  h.finish(h.engine.candidate('ordinary')!); h.receive('next-ordinary'); h.engine.evaluateDue()
  expect(h.engine.candidate('next-ordinary')).toBeDefined()
  expect(h.active()).toHaveLength(4)
})

it('preserves queue age on new evidence and gives waiting threads capacity before timeout retries', () => {
  const h = harness()
  for (let i = 0; i < 6; i++) { h.receive(`${i}`); h.tick() }
  h.engine.evaluateDue()
  const age = h.repo.threads.get('activity:3')!.evalQueuedAt
  expect(age).toBeDefined()
  h.receive('extra', false, '3')
  expect(h.repo.threads.get('activity:3')!.evalQueuedAt).toBe(age)
  for (const c of h.requests) h.engine.candidateDelivered(c.evalId)
  h.tick(); h.engine.evaluateDue()
  expect(h.requests.slice(3).map(c => c.thread.ref.id)).toEqual(['3', '4', '5'])
  expect(h.requests[3]!.triggers.map(t => t.id)).toEqual(['3', 'extra'])
  expect(h.repo.threads.get('activity:0')!.pending).toEqual(['0'])
})

it('preserves queued age and ordering across pause and a SQLite restart, including legacy queues', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eval-backpressure-')), path = join(directory, 'store.sqlite')
  let store = new Store(path)
  try {
    const h = harness(store)
    h.policy.paused = true
    for (const id of ['z', 'y', 'x', 'w']) { h.receive(id); h.tick() }
    const legacy = store.threads.get('activity:z')!; delete legacy.evalQueuedAt; store.threads.save(legacy)
    h.engine.evaluateDue(); expect(h.requests).toHaveLength(0)
    const saved = store.threads.list()
    store.close(); store = new Store(path)
    expect(store.threads.list()).toEqual(saved)
    const restarted = harness(store); restarted.engine.evaluateDue()
    expect(restarted.requests.map(c => c.thread.ref.id)).toEqual(['z', 'y', 'x'])
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

it('drains legacy excess in-flight work without cancellation or admitting more', () => {
  const h = harness()
  // Seed a legacy snapshot from independently admitted Evals.
  for (let i = 0; i < 7; i++) {
    const prior = harness(); prior.receive(`${i}`); prior.engine.evaluateDue()
    h.repo.triggers.save(prior.repo.triggers.get(`${i}`)!)
    h.repo.threads.save(prior.repo.threads.get(`activity:${i}`)!)
  }
  h.receive('waiting', true); h.engine.evaluateDue()
  expect(h.active()).toHaveLength(7); expect(h.requests).toHaveLength(0)
  for (let i = 0; i < 4; i++) h.finish(h.engine.candidate(`${i}`)!)
  h.engine.evaluateDue()
  expect(h.active()).toHaveLength(4); expect(h.engine.candidate('waiting')).toBeDefined()
})

it('cleans rejected pending work even at capacity without taking a slot', () => {
  const h = harness()
  for (let i = 0; i < 3; i++) h.receive(`${i}`)
  h.engine.evaluateDue(); h.receive('rejected', false, 'rejected', { reject: true }); h.engine.evaluateDue()
  expect(h.requests).toHaveLength(3)
  expect(h.repo.threads.get('activity:rejected')!.pending).toEqual([])
  expect(h.repo.threads.get('activity:rejected')!.evalQueuedAt).toBeUndefined()
})

it('retains the age of evidence arriving during an Eval when that Eval finishes', () => {
  const h = harness(); h.receive('first'); h.engine.evaluateDue(); h.tick()
  h.receive('second', false, 'first')
  const age = h.repo.threads.get('activity:first')!.evalQueuedAt
  expect(age).toBeDefined()
  h.tick(); h.finish(h.requests[0]!)
  expect(h.repo.threads.get('activity:first')!.evalQueuedAt).toBe(age)
  h.engine.evaluateDue(); expect(h.requests[1]!.triggers.map(t => t.id)).toEqual(['second'])
})
