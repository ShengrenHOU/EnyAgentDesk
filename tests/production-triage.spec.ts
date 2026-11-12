/** Production pipeline: real durable effects, per-anchor evidence, ownership, and no business effects. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { TriageHandoffs } from '../src/app/triage-handoffs.ts'
import { readWechatImContext } from '../src/sources/activity-wechat.ts'
import type { ActivityTools } from '../src/sources/activity-types.ts'
import { productionTriageTools } from '../src/app/tools/production-triage.ts'
import { ProductionTriage, productionOverview, type ProductionBatch } from '../src/app/production-triage.ts'
import { Engine, type Policy, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import type { ImContextReader } from '../src/sources/im-context.ts'
import { ImContextReadError } from '../src/sources/im-context.ts'
import type { ImMessageHeader } from '../src/sources/kind.ts'
let directory: string, store: Store, engine: Engine, handoffs: TriageHandoffs, service: ProductionTriage, effects: Effects
let provider: string
let enabled: boolean, paused: boolean, source: boolean, configuration: string, version: string, prompt: string, now: string
let native: (id: string) => ImContextReader
const deliver = vi.fn(async (_id: string, _text: string, authorize: () => void) => { authorize(); return now })
const policy = (): Policy => ({ version, paused, evalTimeoutMs: 60000, revalidate: () => true, admitsInferred: () => true,
  gate: trigger => ({ admissible: true, strength: trigger.addressed ? 'explicit' : 'inferred', basis: { via: 'followup' } }) })
const evidence = (trigger: Trigger) => source ? { provider, account: 'owner', conversation: String(trigger.meta.chat ?? 'chat'), message: trigger.id, version: 'v1', partial: false, configuration } : undefined
const options = () => ({ repo: store, policy, now: () => now, externalAssessments: () => service?.activeCount() ?? 0,
  scope: { scope: () => ({ listened: true as const, observed: true }) }, assessor: { request: vi.fn(), release: vi.fn() },
  executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }, outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
function setup(header?: (trigger: Trigger) => ImMessageHeader) {
  engine = new Engine(options())
  effects = new Effects(store, { claim: () => ({ set: vi.fn() }) } as never)
  handoffs = new TriageHandoffs({ store, engine, enabled: () => true, evidence, policyVersion: () => version, now: () => now })
  service = new ProductionTriage({ store, engine, handoffs, effects, evidence, context: trigger => native(trigger.id), header,
    enabled: () => enabled, paused: () => paused, policy: () => version, prompt: () => prompt, now: () => now, deliver })
}
const add = (id: string, chat = 'chat', addressed = false) => engine.receive({ id, source: 'im', threads: [{ source: 'im', id: chat }],
  at: now, actor: { source: 'im', id: 'sender' }, human: true, text: `private ${id}`, meta: { chat }, ...(addressed ? { addressed: 'mention' as const } : {}) })
const start = (ids = ['a']) => {
  handoffs.adopt('owner', ids, handoffs.preview(ids).fingerprint)
  return service.start('owner', 1, { start: '2026-11-09T00:00:00.000Z', end: '2026-11-11T00:00:00.000Z' })
}
const drain = async () => { effects.start(); await effects.idle('triageAssessment') }
const consume = (batch: ProductionBatch) => {
  for (const input of batch.inputs) { let offset: number | null = 0; do { offset = service.context(batch.id, batch.generation, input.triggerId, offset).next_offset } while (offset !== null) }
}
const result = (batch: ProductionBatch, kind: 'informational' | 'suggested_action' | 'unknown' = 'informational') => ({ model: 'reported-model',
  items: batch.inputs.map(input => ({ triggerId: input.triggerId, kind, reason: 'A shared reference', context: (() => { try { const context = service.read(batch.id).contexts[input.triggerId]; return { revision: context?.revision ?? 1, hash: context?.hash ?? 'x'.repeat(64) } } catch { return { revision: 1, hash: 'x'.repeat(64) } } })(), matterIds: [] as string[] })), matters: [] })
const longContext = (id: string, text = 'context '): ImContextReader => ({ assertActive() {}, async read(request) {
  const anchor = { id, text: `private ${id}`, version: 'v1', createdAt: '2026-11-10T00:00:00.000Z' }
  return { provider: request.anchor.provider, account: request.anchor.account, conversation: request.anchor.conversation,
    start: request.start, end: request.end, consistency: 'live_paginated', gaps: [], anchor,
    messages: [0, 1, 2].map(index => ({ ...anchor, id: `${id}-history-${index}`, text: text.repeat(500) })) }
} })
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'production-triage-')); store = new Store(join(directory, 'state.sqlite'))
  provider = 'test'; enabled = true; paused = false; source = true; configuration = 'first'; version = 'policy1'; prompt = 'prompt1'; now = '2026-11-10T01:00:00.000Z'; deliver.mockClear()
  native = id => ({ assertActive() { if (!source) throw new Error('Source revoked') }, async read(request) {
    const anchor = { id, text: `private ${id}`, version: 'v1', createdAt: now }
    return { provider: request.anchor.provider, account: request.anchor.account, conversation: request.anchor.conversation,
      start: request.start, end: request.end, consistency: 'live_paginated', gaps: ['account_visible_only'], anchor, messages: [anchor] }
  } })
  setup()
})
afterEach(async () => { await effects.drain(); store.close(); rmSync(directory, { recursive: true, force: true }) })

it('exposes event time for retained batches without rewriting their binding or adding tool-output undefined values', async () => {
  add('a'); const [created] = start(); await drain()
  const before = store.get<ProductionBatch>(`triage-production:${created!.id}`)
  const live = service.read(created!.id)
  expect(live.inputs[0]?.header).toEqual({ at: now })
  expect(JSON.parse(JSON.stringify(live))).toEqual(live)
  expect(store.get(`triage-production:${created!.id}`)).toEqual(before)
  consume(created!)
  expect(service.submit(live.id, 1, live.binding!, result(created!)).state).toBe('completed')
})

it('passes Source-owned reading headers through the native production read tool', async () => {
  setup(trigger => ({ at: trigger.at, conversationLabel: 'Synthetic operations', senderType: 'app', parent: 'parent-message' }))
  add('a'); const [created] = start(); await drain()
  const tool = productionTriageTools(service).find(tool => tool.name === 'orchestrator_triage_production_read')!
  const output = await tool.execute({ id: created!.id }, new AbortController().signal)
  expect(output).toMatchObject({ inputs: [{ header: { at: now, conversationLabel: 'Synthetic operations', senderType: 'app', parent: 'parent-message' } }] })
  expect(JSON.parse(JSON.stringify(output))).toEqual(output)
})

it('finds old unresolved groups independently of recent history and preserves source access checks', () => {
  add('a', 'waiting-chat'); add('b', 'other-chat')
  const batches = start(['a', 'b'])
  const waiting = batches.find(batch => batch.inputs[0]!.triggerId === 'a')!
  const superseded = batches.find(batch => batch.inputs[0]!.triggerId === 'b')!
  store.set(`triage-production:${waiting.id}`, { ...waiting, state: 'blocked', problem: 'Retained pending judgment' })
  const disposition = store.triggers.disposition('b')!
  disposition.triage!.batchId = 'successor'; store.triggers.saveDisposition('b', disposition)
  for (let index = 0; index < 3; index++) store.set(`triage-production:history-${index}`, {
    ...waiting, id: `history-${index}`, state: 'completed', inputs: [], result: { model: 'test', items: [], matters: [] },
  })
  const header = (trigger: Trigger) => ({ at: trigger.at, conversationLabel: 'Named source', senderLabel: 'Named person' })
  const before = store.get(`triage-production:${waiting.id}`)
  expect(productionOverview(store, evidence, { limit: 1 }).groups[0]!.id).toBe('history-2')
  const pending = productionOverview(store, evidence, { limit: 1, unresolved: true }, header)
  expect(pending.total).toBe(1); expect(pending.nextBefore).toBeNull()
  expect(pending.groups).toMatchObject([{ id: waiting.id, state: 'blocked', header: { conversationLabel: 'Named source' },
    items: [{ header: { senderLabel: 'Named person' }, provider: 'test', sender: undefined }] }])
  expect(pending.groups.some(group => group.id === superseded.id)).toBe(false)
  expect(store.get(`triage-production:${waiting.id}`)).toEqual(before)
  disposition.triage!.batchId = superseded.id; store.triggers.saveDisposition('b', disposition)
  const firstPage = productionOverview(store, evidence, { limit: 1, unresolved: true }, header)
  expect(firstPage.total).toBe(2); expect(firstPage.nextBefore).not.toBeNull()
  const secondPage = productionOverview(store, evidence, { limit: 1, unresolved: true, before: firstPage.nextBefore! }, header)
  expect(new Set([...firstPage.groups, ...secondPage.groups].map(group => group.id))).toEqual(new Set([waiting.id, superseded.id]))
  expect(secondPage.nextBefore).toBeNull()
  source = false
  const hidden = productionOverview(store, evidence, { unresolved: true }, header)
  expect(hidden.groups[0]!.redacted).toBe(true)
  expect(JSON.stringify(hidden)).not.toContain('Named source')
  expect(JSON.stringify(hidden)).not.toContain('Named person')
  expect(JSON.stringify(hidden)).not.toContain('private a')
})

it('delivers a real durable production assessment and completes information without legacy Eval, Ticket, ACK or reply', async () => {
  add('a'); add('b'); const [created] = start(['a', 'b']); await drain()
  expect(deliver).toHaveBeenCalledTimes(1)
  let batch = service.read(created!.id); expect(batch.state).toBe('awaiting'); expect(service.activeCount()).toBe(1)
  expect(Object.keys(batch.contexts)).toEqual(['a', 'b']); expect(batch.contexts.a!.hash).not.toBe(batch.contexts.b!.hash)
  expect(() => service.submit(batch.id, 1, batch.binding!, result(created!))).toThrow('Read every')
  consume(created!); const value = result(created!)
  const completed = service.submit(batch.id, 1, batch.binding!, value)
  expect(service.submit(batch.id, 1, batch.binding!, value)).toEqual(completed)
  expect(() => service.submit(batch.id, 1, batch.binding!, { ...value, model: 'different' })).toThrow('already committed')
  expect(service.activeCount()).toBe(0); expect(store.triageHandoffStatus().held).toBe(0)
  expect(handoffs.read('owner').state).toBe('transferred'); expect(() => handoffs.release('owner', 1)).toThrow('Production')
  expect(() => engine.reevaluate('a')).toThrow(); expect(() => engine.decide('a', { kind: 'ignore', reason: 'bypass' })).toThrow()
  engine.evaluateDue(); expect(store.threads.get('im:chat')!.pending).toEqual([])
  for (const table of ['decision', 'ticket', 'outbox']) expect(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0)
  expect(store.triggers.disposition('a')!.acked).toBeUndefined()
  expect(productionOverview(store, evidence).groups[0]).toMatchObject({ state: 'completed', counts: { informational: 2 }, messages: 2 })
})

it('requires exact exhaustive/bidirectional coverage and exact current context binding', async () => {
  add('a'); add('b'); const [batch] = start(['a', 'b']); await drain(); consume(batch!)
  const live = service.read(batch!.id), good = result(batch!)
  expect(() => service.submit(live.id, 1, 'x'.repeat(64), good)).toThrow('binding')
  expect(() => service.submit(live.id, 1, live.binding!, { ...good, items: [good.items[0]!, good.items[0]!] })).toThrow('coverage')
  expect(() => service.submit(live.id, 1, live.binding!, { ...good, items: [good.items[0]!] })).toThrow('coverage')
  expect(() => service.submit(live.id, 1, live.binding!, { ...good, matters: [{ id: 'm', title: 'Matter', reason: 'Related', triggerIds: ['a'] }] })).toThrow('evidence')
  good.items.forEach(item => item.matterIds = ['m'])
  const completed = service.submit(live.id, 1, live.binding!, { ...good, matters: [{ id: 'm', title: 'One shared matter', reason: 'Related', triggerIds: ['a', 'b'] }] })
  expect(completed.result!.matters).toHaveLength(1)
})

it('keeps a retained batch valid after unrelated executor or source settings change', async () => {
  add('a'); const [batch] = start(); await drain(); consume(batch!)
  const live = service.read(batch!.id)
  store.saveSettings({ ...store.settings(), executor: { ...store.settings().executor, maxWorkers: 15 },
    sources: { ...store.settings().sources, unrelated: { enabled: true, config: { pollSeconds: 300 } } } })
  expect(service.read(live.id).binding).toBe(live.binding)
  expect(service.submit(live.id, 1, live.binding!, result(batch!)).state).toBe('completed')
})

it.each(['policy', 'prompt', 'source', 'configuration', 'trigger'] as const)('rejects %s changes before committing and redacts revoked content', async change => {
  add('a'); const [batch] = start(); await drain(); consume(batch!); const live = service.read(batch!.id)
  if (change === 'policy') version = 'policy2'
  if (change === 'prompt') prompt = 'prompt2'
  if (change === 'source') source = false
  if (change === 'configuration') configuration = 'other'
  if (change === 'trigger') store.triggers.save({ ...store.triggers.get('a')!, text: 'edited' })
  expect(() => service.submit(live.id, 1, live.binding!, result(batch!))).toThrow()
})

it('redacts completed semantic content when source permission/config changes', async () => {
  add('a'); const [batch] = start(); await drain(); consume(batch!); const live = service.read(batch!.id)
  service.submit(live.id, 1, live.binding!, result(batch!)); source = false
  const view = productionOverview(store, evidence)
  expect(view.groups[0]!.redacted).toBe(true); expect(JSON.stringify(view)).not.toContain('shared reference')
  expect(view.groups[0]!.conversation).toBeUndefined(); expect(() => service.read(live.id)).toThrow()
})

it.each(['informational', 'suggested_action'] as const)('accepts %s from matched partial evidence while preserving its gaps', async kind => {
  const normal = native; native = id => { const reader = normal(id); return { ...reader, async read(...args) { const page = await reader.read(...args); page.anchor!.partial = true; return page } } }
  add('a'); const [batch] = start(); await drain(); consume(batch!); const live = service.read(batch!.id)
  expect(live.contexts.a!.gaps).toContain('partial_content_or_attachment')
  const completed = service.submit(live.id, 1, live.binding!, result(batch!, kind))
  expect(completed.state).toBe('completed')
  expect(completed.contexts.a!.manifest.anchor.observed?.partial).toBe(true)
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM ticket').get()!.n).toBe(0)
})

it('retries only unknown inputs of mixed completed receipts without reopening information', async () => {
  add('a'); add('b'); const [batch] = start(['a', 'b']); await drain(); consume(batch!); const live = service.read(batch!.id), value = result(batch!)
  value.items[1]!.kind = 'unknown'; service.submit(live.id, 1, live.binding!, value)
  const retry = service.retry(live.id, 1)
  expect(retry.id).not.toBe(live.id); expect(retry.inputs.map(input => input.triggerId)).toEqual(['b'])
  expect(store.triggers.disposition('a')!.triage!.phase).toBe('triaged'); expect(retry.contexts).toEqual({})
  expect(service.retry(live.id, 1)).toEqual(retry)
  await drain(); expect(service.read(retry.id).state).toBe('awaiting')
})

it('invalidates in-flight reads on retry, parks errors once, and never automatically retries unknown', async () => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve }), normal = native
  native = id => { const reader = normal(id); return { ...reader, async read(...args) { await wait; return reader.read(...args) } } }
  add('a'); const [batch] = start(); effects.start(); await new Promise(resolve => setTimeout(resolve, 10))
  const retry = service.retry(batch!.id, 1); release(); await effects.idle('triageAssessment')
  expect(retry.generation).toBe(2); expect(() => service.context(batch!.id, 1, 'a')).toThrow('Stale')
  expect(deliver.mock.calls.every(([id]) => id.endsWith(':2'))).toBe(true)
})

it('rolls back unfinished batches with original age and leaves new arrivals intact', async () => {
  add('a'); const age = store.threads.get('im:chat')!.evalQueuedAt, [batch] = start()
  now = '2026-11-10T03:00:00.000Z'; add('new'); service.rollback(batch!.id, 1)
  expect(store.threads.get('im:chat')!.pending).toEqual(['new', 'a']); expect(store.threads.get('im:chat')!.evalQueuedAt).toBe(age)
  expect(handoffs.read('owner').state).toBe('released'); expect(handoffs.release('owner', 1).state).toBe('released')
  await drain(); expect(deliver).not.toHaveBeenCalled(); expect(() => service.submit(batch!.id, 1, 'x', result(batch!))).toThrow()
})

it('shares the four-total/three-inferred budget and leaves explicit capacity', async () => {
  add('a'); const [batch] = start(); await drain()
  for (let i = 0; i < 6; i++) add(`passive${i}`, `passive${i}`)
  add('explicit', 'explicit', true); engine.evaluateDue()
  const active = store.threads.active().flatMap(thread => thread.evaluating ? [thread.evaluating] : [])
  expect(active).toHaveLength(3); expect(active.filter(item => item.strength === 'inferred')).toHaveLength(2)
  expect(active.some(item => item.strength === 'explicit')).toBe(true); expect(service.activeCount()).toBe(1)
  expect(service.read(batch!.id).state).toBe('awaiting')
})

it('pauses, restores durable state across restart and does not duplicate judgment delivery', async () => {
  add('a'); const [batch] = start(); paused = true; await drain(); expect(deliver).not.toHaveBeenCalled()
  paused = false; await drain(); expect(deliver).toHaveBeenCalledTimes(1)
  await effects.drain(); store.close(); store = new Store(join(directory, 'state.sqlite')); setup()
  expect(service.read(batch!.id).state).toBe('awaiting'); await drain(); expect(deliver).toHaveBeenCalledTimes(1)
  consume(batch!); const live = service.read(batch!.id); expect(service.submit(live.id, 1, live.binding!, result(batch!)).state).toBe('completed')
})

it('migrates a schema11 held generated column and protects schema14 from old readers', () => {
  add('a'); start(); store.db.exec('DROP INDEX disposition_held; ALTER TABLE disposition DROP COLUMN held; ALTER TABLE disposition ADD COLUMN held TEXT AS (value ->> \'$.triage.owner\'); CREATE INDEX disposition_held ON disposition(held) WHERE held IS NOT NULL')
  store.set(KV.store.schema, 11); store.close(); store = new Store(join(directory, 'state.sqlite')); setup()
  expect(store.get(KV.store.schema)).toBe(14); expect(store.triageHandoffStatus().held).toBe(0)
  // The unchanged schema11 reader guard rejects this database before migration or state writes.
  const legacySchemaVersion = 11, persistedVersion = store.get(KV.store.schema)!
  expect(() => { if (persistedVersion > legacySchemaVersion) throw new Error(`Unsupported orchestrator database version ${persistedVersion}`) }).toThrow('version 14')
})

it('refuses partial pages and swapped input context hashes', async () => {
  const normal = native; native = id => { const reader = normal(id); return { ...reader, async read(...args) { const page = await reader.read(...args); page.messages.push({ id: 'extra', text: 'x'.repeat(7999), version: 'v1', createdAt: now }); return page } } }
  add('a'); add('b'); const [batch] = start(['a', 'b']); await drain(); const live = service.read(batch!.id), value = result(batch!)
  service.context(live.id, 1, 'a', 0); service.context(live.id, 1, 'b', 0)
  expect(() => service.submit(live.id, 1, live.binding!, value)).toThrow('Read every')
  expect(() => service.context(live.id, 1, 'a', 16000)).toThrow('in order')
  consume(batch!); value.items[0]!.context.hash = value.items[1]!.context.hash
  expect(() => service.submit(live.id, 1, live.binding!, value)).toThrow('Per-input')
})

it('blocks native read failures once and permits explicit source-configuration retry without changing immutable inputs', async () => {
  native = () => ({ assertActive() {}, async read() { throw new Error('History permission missing') } })
  add('a'); const [batch] = start(); await drain()
  expect(service.read(batch!.id).state).toBe('blocked'); expect(effects.pending('triageAssessment')).toBe(false)
  expect(service.activeCount()).toBe(0); configuration = 'changed'
  expect(service.retry(batch!.id, 1).generation).toBe(2)
  store.triggers.save({ ...store.triggers.get('a')!, text: 'mutated' })
  expect(() => service.retry(batch!.id, 2)).toThrow('Immutable')
})

it('retries a transient read through Effects and preserves the attempt limit across restart', async () => {
  const normal = native
  native = () => ({ assertActive() {}, async read() { throw new ImContextReadError(true) } })
  add('a'); const [batch] = start(); await drain()
  expect(service.read(batch!.id)).toMatchObject({ state: 'queued', automaticRetries: 1 })
  expect(effects.pending('triageAssessment', batch!.id)).toBe(true)
  await effects.drain(); store.close(); store = new Store(join(directory, 'state.sqlite')); setup()
  for (const expected of ['queued', 'blocked']) {
    store.db.prepare("UPDATE effect SET due = 0 WHERE kind = 'triageAssessment'").run()
    await drain()
    expect(service.read(batch!.id).state).toBe(expected)
  }
  expect(service.read(batch!.id).automaticRetries).toBe(2)
  expect(effects.pending('triageAssessment', batch!.id)).toBe(false)
  native = normal
  const retried = service.retry(batch!.id, 1)
  expect(retried.automaticRetries).toBeUndefined()
  await drain()
  expect(service.read(batch!.id).state).toBe('awaiting')
})

it('retries an exhausted read deadline when no native anchor was obtained', async () => {
  native = () => ({ assertActive() {}, async read(request) {
    return { provider: request.anchor.provider, account: request.anchor.account, conversation: request.anchor.conversation,
      start: request.start, end: request.end, consistency: 'live_paginated', gaps: ['time_budget'], messages: [] }
  } })
  add('a'); const [batch] = start(); await drain()
  expect(service.read(batch!.id)).toMatchObject({ state: 'queued', automaticRetries: 1 })
  expect(deliver).not.toHaveBeenCalled()
})

it('allows WeChat-style local-sync informational judgment with explicit version/history gaps, never proven none', async () => {
  const normal = native; native = id => { const reader = normal(id); return { ...reader, async read(...args) {
    const page = await reader.read(...args); delete page.anchor!.version; delete page.messages[0]!.version
    page.gaps.push('local_sync_only', 'history_unsupported', 'anchor_version_unverified'); return page
  } } }
  add('a'); const [batch] = start(); await drain(); consume(batch!); const live = service.read(batch!.id)
  expect(live.contexts.a!.anchor.status).toBe('unverified')
  expect(() => service.submit(live.id, 1, live.binding!, { ...result(batch!), items: [{ ...result(batch!).items[0]!, kind: 'none' }] })).toThrow('unknown')
  const completed = service.submit(live.id, 1, live.binding!, result(batch!))
  expect(completed.state).toBe('completed'); expect(productionOverview(store, evidence).groups[0]!.items[0]!.gaps).toContain('local_sync_only')
})

it('rolling back an unknown successor restores the prior completed fence rather than legacy pending', async () => {
  add('a'); const [batch] = start(); await drain(); consume(batch!); const live = service.read(batch!.id)
  service.submit(live.id, 1, live.binding!, result(batch!, 'unknown'))
  const retry = service.retry(live.id, 1); service.rollback(retry.id, retry.generation)
  expect(store.triggers.disposition('a')!.triage).toMatchObject({ phase: 'triaged', batchId: live.id })
  expect(store.threads.get('im:chat')!.pending).toEqual([]); expect(() => handoffs.release('owner', 1)).toThrow('Production')
})

it.each(['informational', 'suggested_action'] as const)('real WeChat native adapter → collector → production accepts bounded %s with uncertainty', async kind => {
  provider = 'wechat'
  const execute = vi.fn(async () => ({ isError: false, value: { content: [], structuredContent: {
    status: 'ok', account: 'owner', conversation: 'chat', snapshot_id: 'native-local-snapshot', count: 1, has_more: false, next_offset: null,
    records: [{ account: 'owner', conversation: 'chat', record_id: 'record-a', message_ref: 'wx1.a', timestamp: Date.parse(now) / 1000,
      time: now, text: 'private wx1.a', sender: 'sender', direction: 'incoming', local_type: 1 }],
  } } }))
  const tools = { execute, schemas: vi.fn() } as unknown as ActivityTools
  native = () => ({ assertActive() {}, read: (request, cursor, signal) => readWechatImContext(tools, { serverName: 'wechat_readonly' }, request, cursor, signal) })
  add('wx1.a'); const [batch] = start(['wx1.a']); await drain(); consume(batch!); const live = service.read(batch!.id)
  expect(live.contexts['wx1.a']!.anchor).toMatchObject({ status: 'unverified', contentMatch: true })
  const value = { ...result(batch!), items: [{ ...result(batch!).items[0]!, kind }] }
  expect(() => service.submit(live.id, 1, live.binding!, { ...value, items: [{ ...value.items[0]!, kind: 'none' }] })).toThrow('unknown')
  const receipt = service.submit(live.id, 1, live.binding!, value)
  expect(receipt.contexts['wx1.a']!.manifest).toMatchObject({ contextComplete: false, consistency: 'native_snapshot',
    gaps: expect.arrayContaining(['local_sync_only', 'native_version_unavailable', 'deletion_status_unavailable']) })
  expect(execute).toHaveBeenCalledTimes(1)
  expect((execute.mock.calls as unknown[][])[0]![0]).toMatchObject({ name: 'mcp__wechat_readonly__wechat_read_window' })
})

it('tool mutation receipts never reveal raw evidence after revocation and cancelled unknowns can retry again', async () => {
  add('a'); const [batch] = start(); await drain(); consume(batch!); const live = service.read(batch!.id)
  service.submit(live.id, 1, live.binding!, result(batch!, 'unknown')); const retry = service.retry(live.id, 1)
  const tools = productionTriageTools(service), signal = new AbortController().signal
  source = false
  const existing = await tools.find(tool => tool.name.endsWith('_retry'))!.execute({ id: live.id, generation: 1 }, signal)
  expect(JSON.stringify(existing)).not.toMatch(/private|contexts|shared reference/)
  const rolled = await tools.find(tool => tool.name.endsWith('_rollback'))!.execute({ id: retry.id, generation: retry.generation }, signal)
  expect(JSON.stringify(rolled)).not.toMatch(/private|contexts|shared reference/)
  source = true
  const next = service.retry(live.id, 1); expect(next.id).not.toBe(retry.id); expect(next.state).toBe('queued')
  expect(() => service.context(retry.id, retry.generation, 'a')).toThrow()
})

it('suspends consumed deadlines during pause and bounds automatic judgment retries', async () => {
  add('a'); const [batch] = start(); await drain()
  expect(service.read(batch!.id)).toMatchObject({ consumedAt: now, deadline: '2026-11-10T01:05:00.000Z' })
  now = '2026-11-10T01:02:00.000Z'; paused = true; service.maintain()
  now = '2026-11-10T02:02:00.000Z'; service.maintain(); paused = false; service.maintain()
  expect(service.read(batch!.id).deadline).toBe('2026-11-10T02:05:00.000Z')
  now = '2026-11-10T02:06:00.000Z'; service.maintain()
  expect(service.read(batch!.id)).toMatchObject({ state: 'queued', generation: 2, automaticRetries: 1 })
  await drain()
  now = '2026-11-10T02:12:00.000Z'; service.maintain()
  expect(service.read(batch!.id)).toMatchObject({ state: 'queued', generation: 3, automaticRetries: 2 })
  await drain()
  now = '2026-11-10T02:18:00.000Z'; service.maintain()
  expect(service.read(batch!.id)).toMatchObject({ state: 'blocked', problem: expect.stringContaining('timed out') })
  expect(service.activeCount()).toBe(0); expect(store.threads.get('im:chat')!.pending).toEqual([])
  const retried = service.retry(batch!.id, 3); expect(retried.consumedAt).toBeUndefined(); expect(retried.deadline).toBeUndefined()
})

it('preserves a preparing attempt across a pause during native reads and does not rewrite unchanged maintenance', async () => {
  const normal = native; let release!: () => void
  native = id => { const reader = normal(id); return { ...reader, async read(...args) { await new Promise<void>(resolve => { release = resolve }); return reader.read(...args) } } }
  add('a'); const [batch] = start(); effects.start(); while (!release) await new Promise(resolve => setTimeout(resolve, 1))
  paused = true; release(); await effects.idle('triageAssessment')
  const stored = () => String(store.db.prepare("SELECT value FROM kv WHERE key = ?").get(`triage-production:${batch!.id}`)!.value)
  expect(JSON.parse(stored()).state).toBe('preparing'); expect(effects.pending('triageAssessment')).toBe(true)
  paused = false; native = normal; store.db.prepare("UPDATE effect SET due = 0 WHERE kind = 'triageAssessment'").run(); await drain()
  expect(service.read(batch!.id).generation).toBe(1); expect(service.read(batch!.id).state).toBe('awaiting')
  const before = stored(); now = '2026-11-10T01:01:00.000Z'; service.maintain(); service.maintain(); expect(stored()).toBe(before)
})

it('real Runtime settings pause/resume preserves unconsumed production attempt despite settings revision changes', async () => {
  const { z } = await import('zod'), { startRuntime } = await import('./fixtures/host.ts')
  const host = await startRuntime(undefined, { triageHandoff: true, triageProduction: true })
  try {
    const runtime = host.runtime
    runtime.sources.register({ kind: 'other-im', title: { en: 'IM', zh: 'IM' }, description: { en: 'IM', zh: 'IM' }, schema: z.object({}), fields: [], health: [],
      scope: () => ({ listened: true, observed: true }), imEvidence: trigger => ({ provider: 'im', account: 'owner', conversation: 'chat', message: trigger.id, version: '1', partial: false }),
      imContext: async (_commands, request) => ({ provider: 'im', account: 'owner', conversation: 'chat', start: request.start, end: request.end,
        consistency: 'live_paginated', gaps: [], messages: [{ id: request.anchor.message, text: request.anchorText, version: '1', createdAt: request.start }] }) })
    const settings = runtime.store.settings()
    runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, 'other-im': { allowed: [{ id: 'sender' }] } } } })
    runtime.engine.receive({ id: 'runtime-a', source: 'other-im', threads: [{ source: 'other-im', id: 'chat' }], actor: { source: 'other-im', id: 'sender' }, human: true, text: 'reference', at: now, meta: {} })
    runtime.triageHandoffs.adopt('runtime-owner', ['runtime-a'], runtime.triageHandoffs.preview(['runtime-a']).fingerprint)
    const agent = host.agents.get(runtime.masterId)!; agent.status = 'running'
    const [batch] = runtime.productionTriage.start('runtime-owner', 1, { start: '2026-11-10T00:00:00Z', end: '2026-11-11T00:00:00Z' })
    await runtime.idle(); const before = runtime.productionTriage.read(batch!.id)
    expect(before.state).toBe('awaiting'); expect(before.consumedAt).toBeUndefined(); expect(agent.inbox.nextTurn).toHaveLength(1)
    await runtime.settings.pause(true, 'tool'); runtime.productionTriage.maintain(); runtime.sessions.pruneAssessments()
    expect(agent.inbox.nextTurn).toHaveLength(1); expect(runtime.productionTriage.noticeCurrent(batch!.id, 1)).toBe(true)
    await runtime.settings.pause(false, 'tool'); runtime.store.db.prepare("UPDATE effect SET due = 0 WHERE kind = 'triageAssessment'").run(); await runtime.idle()
    expect(runtime.store.get(KV.settings.revision)).toBeGreaterThan(before.settingsRevision)
    expect(runtime.productionTriage.read(batch!.id)).toMatchObject({ state: 'awaiting', generation: 1, binding: before.binding })
    expect(agent.inbox.nextTurn).toHaveLength(1)
    // Native consumption precedes a pause, before the durable effect can confirm it.
    const message = agent.inbox.nextTurn[0]!, nativeTime = Date.now() - 3_600_000
    host.ctx.emit('session/event', (agent as unknown as { session: never }).session,
      { type: 'user/message', time: nativeTime, data: message } as never)
    agent.inbox.nextTurn.length = 0
    await runtime.settings.pause(true, 'tool'); runtime.productionTriage.maintain()
    expect(runtime.store.get<ProductionBatch>(`triage-production:${batch!.id}`)!.consumedAt).toBeUndefined()
    await runtime.settings.pause(false, 'tool')
    runtime.store.db.prepare("UPDATE effect SET due = 0 WHERE kind = 'triageAssessment'").run(); await runtime.idle()
    const confirmed = runtime.productionTriage.read(batch!.id)
    expect(confirmed.consumedAt).toBe(new Date(nativeTime).toISOString())
    expect(Date.parse(confirmed.confirmedAt!)).toBeGreaterThan(nativeTime + 3_500_000)
    expect(Date.parse(confirmed.deadline!)).toBeGreaterThan(Date.now())
    runtime.productionTriage.maintain()
    expect(runtime.productionTriage.read(batch!.id)).toMatchObject({ state: 'awaiting', deadline: confirmed.deadline, confirmedAt: confirmed.confirmedAt })
  } finally { await host.stop() }
})

it('refuses a deadline-expired result even before the next periodic pass', async () => {
  add('a'); const [batch] = start(); await drain(); consume(batch!); const live = service.read(batch!.id), value = result(batch!)
  now = '2026-11-10T01:05:00.001Z'
  expect(() => service.submit(live.id, 1, live.binding!, value)).toThrow('Stale')
  expect(service.read(live.id)).toMatchObject({ state: 'queued', generation: 2 }); expect(service.activeCount()).toBe(0)
})

it('keeps completed reads across an automatic retry when the collected content is unchanged', async () => {
  native = id => longContext(id)
  add('a'); const [batch] = start(); await drain(); consume(batch!)
  now = '2026-11-10T01:06:00.000Z'; service.maintain()
  expect(service.read(batch!.id)).toMatchObject({ state: 'queued', generation: 2 })
  await drain()
  const live = service.read(batch!.id)
  expect(live.state).toBe('awaiting'); expect(live.generation).toBe(2)
  expect(live.reads!.a).toMatchObject({ generation: 2, next: null, complete: true })
  // The generator was re-collected with new read timestamps but identical content, so no page re-read is required.
  expect(service.submit(live.id, live.generation, live.binding!, result(batch!)).state).toBe('completed')
})

it('keeps completed coverage when a fully read context is read again', async () => {
  native = id => longContext(id)
  add('a'); const [batch] = start(); await drain(); consume(batch!)
  const live = service.read(batch!.id)
  expect(service.context(live.id, live.generation, 'a', 0).next_offset).toBe(8000)
  expect(service.submit(live.id, live.generation, live.binding!, result(batch!)).state).toBe('completed')
})

it('resumes partial page progress after a generation retry instead of restarting from zero', async () => {
  native = id => longContext(id)
  add('a'); const [batch] = start(); await drain()
  const first = service.read(batch!.id), page = service.context(first.id, first.generation, 'a', 0)
  expect(page.next_offset).toBe(8000)
  now = '2026-11-10T01:06:00.000Z'; service.maintain(); await drain()
  const live = service.read(batch!.id)
  expect(live.reads!.a).toMatchObject({ generation: 2, next: 8000, complete: false })
  let offset = page.next_offset
  while (offset !== null) offset = service.context(live.id, live.generation, 'a', offset).next_offset
  expect(service.submit(live.id, live.generation, live.binding!, result(batch!)).state).toBe('completed')
})

it('drops carried reads when a retried generation collects different content', async () => {
  native = id => longContext(id, 'before ')
  add('a'); const [batch] = start(); await drain(); consume(batch!)
  now = '2026-11-10T01:06:00.000Z'; service.maintain()
  native = id => longContext(id, 'after ')
  await drain()
  const live = service.read(batch!.id)
  expect(live.state).toBe('awaiting')
  expect(() => service.submit(live.id, live.generation, live.binding!, result(batch!))).toThrow('Read every')
})



it('uses the reader native anchor text instead of collected presentation text', async () => {
  const originalReader = native
  native = id => {
    const reader = originalReader(id)
    return { ...reader, anchorText: `native ${id}`, read: async (request, cursor, signal) => {
      const page = await reader.read(request, cursor, signal)
      return { ...page, ...(page.anchor ? { anchor: { ...page.anchor, text: `native ${id}` } } : {}), messages: page.messages.map(message => ({ ...message, text: `native ${id}` })) }
    } }
  }
  add('a'); const [batch] = start(); await drain()
  expect(service.read(batch!.id).contexts.a!.anchor.contentMatch).toBe(true)
})


it('shares the context-message budget across a full batch instead of rereading four pages per input', async () => {
  const ids = Array.from({ length: 8 }, (_, i) => `budget-${i}`)
  ids.forEach(id => add(id))
  const reads = vi.fn()
  native = id => ({ assertActive() {}, async read(request, cursor) {
    reads(id, cursor)
    const offset = cursor ? Number(cursor) : 0
    const anchor = { id, text: `private ${id}`, version: 'v1', createdAt: now }
    return { provider, account: 'owner', conversation: 'chat', start: request.start, end: request.end,
      messages: Array.from({ length: 50 }, (_, i) => ({ ...anchor, id: `${id}-history-${offset + i}`, text: 'context' })),
      anchor, next: String(offset + 50), consistency: 'live_paginated' as const, gaps: [] }
  } })
  const [batch] = start(ids)
  await drain()
  const saved = service.read(batch!.id)
  expect(saved.state).toBe('awaiting')
  expect(reads).toHaveBeenCalledTimes(8)
  const persisted = store.get<ProductionBatch>(`triage-production:${batch!.id}`)!
  const manifests = ids.map(id => persisted.contexts[id]!.manifest)
  expect(manifests.reduce((n, manifest) => n + manifest.messages.length, 0)).toBeLessThanOrEqual(200)
  expect(manifests.every(manifest => manifest.gaps.includes('message_budget') && manifest.covered === null)).toBe(true)
  expect(manifests.every(manifest => manifest.anchor.contentMatch)).toBe(true)
})


it('fits eight large native anchors into the batch budget with explicit truncation gaps', async () => {
  const text = 'details '.repeat(3000)
  native = id => ({ anchorText: text, assertActive() {}, async read(request) {
    return { provider: request.anchor.provider, account: request.anchor.account, conversation: request.anchor.conversation,
      start: request.start, end: request.end, consistency: 'live_paginated', gaps: [], messages: [],
      anchor: { id, text, version: 'v1', createdAt: now } }
  } })
  const ids = Array.from({ length: 8 }, (_, i) => `large-${i}`)
  ids.forEach(id => add(id)); const [created] = start(ids); await drain()
  const batch = service.read(created!.id)
  expect(batch.state).toBe('awaiting')
  const saved = store.get<ProductionBatch>(`triage-production:${batch.id}`)!
  const manifests = Object.values(saved.contexts).map(value => value.manifest)
  expect(manifests).toHaveLength(8)
  expect(manifests.reduce((sum, manifest) => sum + JSON.stringify(manifest).length, 0)).toBeLessThanOrEqual(64_000)
  for (const manifest of manifests) {
    expect(manifest.anchor.contentMatch).toBe(true)
    expect(manifest.anchor.observed?.partial).toBe(true)
    expect(manifest.gaps).toContain('batch_context_budget')
    expect(manifest.covered).toBeNull()
  }
})

it('returns lossless JSON metadata when the current anchor is missing', async () => {
  add('a')
  native = () => ({ assertActive() {}, async read(request) {
    return { provider, account: 'owner', conversation: 'chat', start: request.start, end: request.end,
      messages: [], consistency: 'live_paginated' as const, gaps: ['anchor_missing'] }
  } })
  const [batch] = start()
  await drain()
  const metadata = service.read(batch!.id)
  expect(metadata.contexts.a!.anchor.status).toBe('missing')
  expect(metadata).toStrictEqual(JSON.parse(JSON.stringify(metadata)))
})
