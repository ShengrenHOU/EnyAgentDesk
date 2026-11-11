/** Controlled handoff is atomic, reversible, and independently fenced by the core. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { TriageHandoffs } from '../src/app/triage-handoffs.ts'
import { triageHandoffTools } from '../src/app/tools/triage-handoffs.ts'
import { Engine, MemoryRepositories, type Policy, type Trigger, type Ticket } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'

let directory: string, store: Store, engine: Engine, service: TriageHandoffs
let paused: boolean, enabled: boolean, source: boolean, configuration: string, version: string, now: string
const policy = (): Policy => ({ version, paused, evalTimeoutMs: 60000, revalidate: () => true, admitsInferred: () => true,
  gate: trigger => ({ admissible: true, strength: trigger.addressed ? 'explicit' : 'inferred', basis: { via: 'followup' } }) })
const options = () => ({ repo: store, policy, now: () => now, scope: { scope: () => ({ listened: true as const, observed: true }) },
  assessor: { request: vi.fn(), release: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
  outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
function start() {
  engine = new Engine(options())
  service = new TriageHandoffs({ store, engine, enabled: () => enabled, now: () => now, policyVersion: () => version,
    evidence: trigger => source ? { provider: 'test-im', account: 'owner', conversation: 'chat', message: trigger.id, version: 'v1', partial: false, configuration } : undefined })
}
const add = (id: string, extra: Partial<Trigger> = {}) => engine.receive({ id, source: 'im', threads: [{ source: 'im', id: 'chat' }],
  at: now, actor: { source: 'im', id: 'sender' }, human: true, text: 'private message', meta: {}, ...extra })
const adopt = (ids = ['a'], owner = 'test-owner') => service.adopt(owner, ids, service.preview(ids).fingerprint)
const pending = () => store.threads.get('im:chat')!.pending
const rows = () => Object.fromEntries(['trigger', 'thread', 'disposition', 'decision', 'ticket', 'outbox', 'effect', 'kv']
  .map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'triage-handoffs-')); store = new Store(join(directory, 'state.sqlite'))
  paused = false; enabled = true; source = true; configuration = 'first'; version = 'v1'; now = '2026-11-10T01:00:00.000Z'; start()
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('holds without Decisions, source ACK, Ticket, outbox or trigger changes; releases IDs and oldest age beside new arrivals', () => {
  add('a'); add('b'); const original = store.triggers.get('a'), age = store.threads.get('im:chat')!.evalQueuedAt
  const receipt = adopt(['a', 'b']); expect(pending()).toEqual([])
  expect(store.triageHandoffStatus()).toMatchObject({ held: 2, owners: ['test-owner'], contextComplete: false })
  now = '2026-11-10T03:00:00.000Z'; add('new'); expect(pending()).toEqual(['new'])
  service.release(receipt.owner, receipt.generation)
  expect(pending()).toEqual(['new', 'a', 'b']); expect(store.threads.get('im:chat')!.evalQueuedAt).toBe(age)
  expect(store.triggers.get('a')).toEqual(original)
  for (const table of ['decision', 'ticket', 'outbox', 'effect']) expect(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0)
  expect(store.triageHandoffStatus().held).toBe(0)
})

it('refuses mixed explicit, active, previously decided, subscribed, and ticket-input evidence without partial adoption', () => {
  add('a'); add('explicit', { addressed: 'mention' })
  const before = rows(); expect(() => adopt(['a', 'explicit'])).toThrow('entirely eligible'); expect(rows()).toEqual(before)
  engine.evaluateDue(); expect(service.preview(['a']).entries[0]!.reason).toBe('not_pending')
  expect(() => adopt()).toThrow('entirely eligible')
})

it('refuses active work even if corrupt duplicate pending still contains the evidence', () => {
  add('a'); engine.evaluateDue(); const thread = store.threads.get('im:chat')!; thread.pending.push('a'); store.threads.save(thread)
  expect(service.preview(['a']).entries[0]!.reason).toBe('active_eval'); expect(() => adopt()).toThrow()
})

it.each(['trigger', 'resumed'] as const)('refuses historical %s input references even when disposition and subscriptions omit them', kind => {
  add('a')
  store.tickets.save({ id: 'historical', origin: { triggerId: 'other', triggerIds: ['other'] }, inputs: [{ kind, triggerId: 'a' }] } as Ticket)
  expect(service.preview(['a']).entries[0]!.reason).toBe('prior_owner'); expect(() => adopt()).toThrow()
})

it('refuses prior Decision and context subscriptions rather than stealing previous ownership', () => {
  add('a'); engine.decide('a', { kind: 'ignore', reason: 'previous' }); engine.reevaluate('a')
  expect(service.preview(['a']).entries[0]!.reason).toBe('prior_decision')
  add('b'); const thread = store.threads.get('im:chat')!; thread.context = ['context-reader']; store.threads.save(thread)
  expect(service.preview(['b']).entries[0]!.reason).toBe('subscribed')
})

it.each(['source', 'configuration', 'settings', 'policy', 'trigger'] as const)('compares exact %s identity between preview and adoption', change => {
  add('a'); const { fingerprint } = service.preview(['a'])
  if (change === 'source') source = false
  if (change === 'configuration') configuration = 'second'
  if (change === 'settings') store.set(KV.settings.revision, 2)
  if (change === 'policy') version = 'v2'
  if (change === 'trigger') store.triggers.save({ ...store.triggers.get('a')!, text: 'edited' })
  const before = rows(); expect(() => service.adopt('owner', ['a'], fingerprint)).toThrow('changed'); expect(rows()).toEqual(before)
})

it('rolls ownership, pending and manifest back together when receipt persistence fails', () => {
  add('a'); add('b'); const { fingerprint } = service.preview(['a', 'b']), before = rows()
  const save = vi.spyOn(store, 'set').mockImplementation(() => { throw new Error('disk failure') })
  expect(() => service.adopt('owner', ['a', 'b'], fingerprint)).toThrow('disk failure'); save.mockRestore()
  expect(rows()).toEqual(before)
  adopt(['a', 'b']); const held = rows()
  const failRelease = vi.spyOn(store, 'set').mockImplementation(() => { throw new Error('disk failure') })
  expect(() => service.release('test-owner', 1)).toThrow('disk failure'); failRelease.mockRestore(); expect(rows()).toEqual(held)
})

it('preserves idempotent receipts and rejects wrong owner/generation including after restart', () => {
  add('a'); const receipt = adopt(), held = rows()
  expect(service.adopt(receipt.owner, ['a'], receipt.fingerprint)).toEqual(receipt); expect(rows()).toEqual(held)
  expect(() => service.adopt(receipt.owner, ['b'], receipt.fingerprint)).toThrow('different selection')
  expect(() => service.release('other', 1)).toThrow(); expect(() => service.release(receipt.owner, 2)).toThrow()
  store.close(); store = new Store(join(directory, 'state.sqlite')); start()
  expect(service.read(receipt.owner)).toEqual(receipt); expect(() => engine.reevaluate('a')).toThrow('held')
  const released = service.release(receipt.owner, 1)
  expect(service.release(receipt.owner, 1)).toEqual(released)
  expect(service.adopt(receipt.owner, ['a'], receipt.fingerprint)).toEqual(released)
})

it('fences direct decide, accept, attach, replay, stale Eval and periodic queues independently of flag/source state', () => {
  add('a'); adopt(); enabled = false; source = false
  expect(() => engine.decide('a', { kind: 'ignore', reason: 'bypass' })).toThrow('held')
  expect(() => engine.decide('a', { kind: 'accept', title: 'bypass', scope: 'none', reason: 'bypass' })).toThrow('held')
  expect(() => engine.attach('any', 'a')).toThrow('held'); expect(() => engine.reevaluate('a')).toThrow('held')
  expect(() => service.release('test-owner', 1)).toThrow('Enable triageHandoff')
  const thread = store.threads.get('im:chat')!; thread.pending.push('a'); store.threads.save(thread)
  engine.evaluateDue(); expect(pending()).toEqual([])
  expect(engine.receive(store.triggers.get('a')!)).toBe('duplicate'); expect(pending()).toEqual([])
  expect(store.triageHandoffStatus().held).toBe(1)
  enabled = true; service.release('test-owner', 1); expect(pending()).toEqual(['a'])
})

it('rejects stale Eval covering a held input even when a different trigger submits its outcome', () => {
  add('a'); adopt(); add('b'); engine.evaluateDue()
  const thread = store.threads.get('im:chat')!; thread.evaluating!.triggerIds.push('a'); store.threads.save(thread)
  expect(() => engine.decide('b', { kind: 'ignore', reason: 'stale' })).toThrow('held')
  expect(() => engine.candidate('b')).toThrow('held'); expect(() => engine.policyChanged('v1', 'v2')).toThrow('held')
  expect(() => engine.evaluateDue()).toThrow('held'); expect(store.decisions.byThread(thread.key)).toEqual([])
})

it('compares every release marker before mutating and never overwrites another owner', () => {
  add('a'); add('b'); adopt(['a', 'b'])
  const disposition = store.triggers.disposition('b')!; disposition.triage!.generation = 2; store.triggers.saveDisposition('b', disposition)
  const before = rows(); expect(() => service.release('test-owner', 1)).toThrow('generation'); expect(rows()).toEqual(before)
})

it('bounds selection, returns no private text, and refuses a separate core repository', async () => {
  add('a'); expect(() => service.preview([])).toThrow(); expect(() => service.preview(['a', 'a'])).toThrow()
  expect(() => service.preview(Array.from({ length: 201 }, (_, i) => `${i}`))).toThrow()
  const tools = triageHandoffTools(service), preview = tools.find(tool => tool.name.endsWith('_preview'))!
  const result = await preview.execute({ trigger_ids: ['a'] }, new AbortController().signal)
  expect(JSON.stringify(result)).not.toContain('private message')
  expect(() => new TriageHandoffs({ store, engine: new Engine({ ...options(), repo: new MemoryRepositories() }),
    enabled: () => true, policyVersion: () => version, evidence: () => undefined })).toThrow('share one Store')
})

it('allows controlled adopt and rollback while processing is paused without starting work', () => {
  paused = true; add('a'); adopt(); engine.evaluateDue(); expect(pending()).toEqual([])
  service.release('test-owner', 1); engine.evaluateDue(); expect(pending()).toEqual(['a'])
  paused = false; engine.evaluateDue(); expect(store.threads.get('im:chat')!.evaluating!.triggerIds).toEqual(['a'])
})

it('refuses reference scans beyond the explicit historical-ticket budget', () => {
  add('a')
  store.atomic(() => { for (let i = 0; i < 5001; i++) store.db.prepare('INSERT INTO ticket VALUES (?,?)').run(`t${i}`, '{}') })
  expect(() => service.preview(['a'])).toThrow('budget exceeded'); expect(pending()).toEqual(['a'])
})

it('uses actual Runtime main tools, excludes workers/default sessions, and projects held status with controls off', async () => {
  const { z } = await import('zod')
  const { startRuntime, feishu } = await import('./fixtures/host.ts')
  const normal = await startRuntime()
  try { expect(normal.tools.get(normal.runtime.masterId)?.has('orchestrator_triage_handoff_adopt')).toBe(false) }
  finally { await normal.stop() }
  const opted = await startRuntime(undefined, { triageHandoff: true })
  try {
    const runtime = opted.runtime
    const worker = await opted.acceptedTicket(feishu('994', 'Fix a test'))
    expect(opted.tools.get(worker.sessionId)?.has('orchestrator_triage_handoff_adopt')).toBe(false)
    runtime.sources.register({ kind: 'other-im', title: { en: 'IM', zh: 'IM' }, description: { en: 'IM', zh: 'IM' }, schema: z.object({}), fields: [], health: [],
      scope: () => ({ listened: true, observed: true }), imEvidence: trigger => ({ provider: 'im', account: 'owner', conversation: 'chat', message: trigger.id, version: '1', partial: false }) })
    const settings = runtime.store.settings()
    runtime.store.saveSettings({ ...settings, paused: true, policy: { ...settings.policy, sources: { ...settings.policy.sources, 'other-im': { allowed: [{ id: 'sender' }] } } } })
    runtime.engine.receive({ id: 'runtime-held', source: 'other-im', threads: [{ source: 'other-im', id: 'chat' }], actor: { source: 'other-im', id: 'sender' },
      human: true, text: 'private retained evidence', at: now, meta: {} })
    const preview = await opted.runTool(runtime.masterId, 'orchestrator_triage_handoff_preview', { trigger_ids: ['runtime-held'] })
    expect(preview).toMatchObject({ entries: [{ eligible: true }] })
    await opted.runTool(runtime.masterId, 'orchestrator_triage_handoff_adopt', { owner: 'runtime-owner', trigger_ids: ['runtime-held'], fingerprint: preview.fingerprint })
    runtime.machine.triageHandoff = false
    expect(runtime.health.triageHandoff!.detail).toContain('1 IM evidence held awaiting')
    expect((await opted.api('GET', 'state')).body.triageHandoff).toMatchObject({ held: 1 })
    expect((await opted.api('GET', 'overview')).body.problems).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'triageHandoff', detail: expect.stringContaining('not processed') })]))
    expect(() => runtime.engine.reevaluate('runtime-held')).toThrow('held')
    runtime.machine.triageHandoff = true
    const current = runtime.store.settings()
    runtime.store.saveSettings({ ...current, sources: { ...current.sources, 'other-im': { enabled: false, config: {} } } })
    const released = await opted.runTool(runtime.masterId, 'orchestrator_triage_handoff_release', { owner: 'runtime-owner', generation: 1 })
    expect(released.state).toBe('released'); expect(JSON.stringify(released)).not.toContain('private retained evidence')
    runtime.store.saveSettings({ ...runtime.store.settings(), paused: false })
    runtime.engine.evaluateDue()
    expect(runtime.store.decisions.byThread('other-im:chat')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'ignore', triggerIds: ['runtime-held'] })]))
    expect(runtime.store.triggers.get('runtime-held')).toBeDefined()
    expect(runtime.store.tickets.list()).toHaveLength(1)
  } finally { await opted.stop() }
})

it('core rejects malformed owner/generation/membership and wrong primary thread even outside tool schemas', () => {
  add('a')
  expect(() => engine.holdForTriage(['a'], '', 1)).toThrow('Invalid')
  expect(() => engine.holdForTriage(['a'], 'owner', 0)).toThrow('Invalid')
  const receipt = adopt()
  expect(() => engine.releaseFromTriage([], receipt.owner, 1)).toThrow('distinct')
  expect(() => engine.releaseFromTriage([...receipt.inputs, ...receipt.inputs], receipt.owner, 1)).toThrow('distinct')
  add('other', { threads: [{ source: 'im', id: 'elsewhere' }] })
  expect(() => engine.releaseFromTriage([{ ...receipt.inputs[0]!, thread: 'im:elsewhere' }], receipt.owner, 1)).toThrow('identity')
  expect(() => engine.releaseFromTriage(receipt.inputs, receipt.owner, NaN)).toThrow('Invalid')
  expect(store.triageHandoffStatus().held).toBe(1)
})
