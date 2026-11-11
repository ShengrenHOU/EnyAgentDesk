/** Shadow batching preserves native identity and exhaustive coverage without consuming business work. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { z } from 'zod'
import { Store } from '../src/app/store.ts'
import { ShadowTriage, type TriageBatch } from '../src/app/triage.ts'
import { triageTools } from '../src/app/tools/triage.ts'
import { KV } from '../src/kv.ts'
import type { Trigger } from '../src/core/index.ts'
import { SourceRegistry } from '../src/sources/registry.ts'

let directory: string, store: Store, triage: ShadowTriage
let now: number, paused: boolean, enabled: boolean, configuration: string
const trigger = (id: string, conversation = 'chat', text = 'evidence', extra: Record<string, unknown> = {}): Trigger => ({
  id, source: 'other-im', at: new Date(now).toISOString(), threads: [{ source: 'other-im', id }], actor: { source: 'other-im', id: 'sender' },
  human: false, text, meta: { conversation, ...extra },
})
function service() {
  return new ShadowTriage({ store, now: () => now, paused: () => paused, evidence: item => enabled ? ({
    provider: String(item.meta.provider ?? 'im'), account: String(item.meta.account ?? 'owner'), conversation: String(item.meta.conversation),
    message: item.id, version: '1', partial: item.meta.partial === true, configuration,
  }) : undefined })
}
const add = (...items: Trigger[]) => { for (const item of items) store.triggers.save(item); return items.map(item => item.id) }
const result = (batch: TriageBatch) => ({ model: 'test-model', items: batch.inputs.map(input => ({
  triggerId: input.triggerId, bucket: 'none' as const, reason: 'No unresolved action in selected evidence', matterIds: [] as string[],
})), matters: [] as { id: string; title: string; reason: string; triggerIds: string[] }[] })
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'im-triage-')); store = new Store(join(directory, 'state.sqlite'))
  now = Date.parse('2026-11-10T01:00:00Z'); paused = false; enabled = true; configuration = 'v1'; triage = service()
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('groups fragments across original Threads, permits multiple goals, and never mutates business records', () => {
  const ids = add(trigger('a', 'chat', 'Please prepare the deck'), trigger('b', 'chat', 'for Friday; also renew the certificate'))
  const before = store.db.prepare('SELECT * FROM trigger ORDER BY id').all()
  const { batches } = triage.claim(ids)
  expect(batches).toHaveLength(1); expect(batches[0]!.inputs).toHaveLength(2)
  const batch = batches[0]!, value = result(batch)
  value.matters = [{ id: 'deck', title: 'Deck', reason: 'Two fragments of one request', triggerIds: ids },
    { id: 'certificate', title: 'Certificate', reason: 'Separate goal in the second message', triggerIds: ['b'] }]
  value.items[0]!.matterIds = ['deck']; value.items[1]!.matterIds = ['deck', 'certificate']
  const saved = triage.submit(batch.id, batch.generation, value)
  expect(saved.state).toBe('completed'); expect(saved.result!.matters).toHaveLength(2)
  expect(triage.submit(batch.id, batch.generation, value)).toEqual(saved)
  expect(triage.claim(ids)).toMatchObject({ batches: [], completed: [batch.id], deferred: [] })
  expect(store.db.prepare('SELECT * FROM trigger ORDER BY id').all()).toEqual(before)
  for (const table of ['thread', 'decision', 'disposition', 'ticket', 'outbox', 'effect']) {
    expect(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0)
  }
})

it('separates provider, account and conversation instead of merging identical text', () => {
  const ids = add(trigger('a', 'one'), trigger('b', 'two'), trigger('c', 'one', 'evidence', { account: 'other' }),
    trigger('d', 'one', 'evidence', { provider: 'another' }))
  expect(triage.claim(ids).batches.map(batch => batch.inputs.length)).toEqual([1, 1, 1, 1])
})

it('bounds message count, characters, active claims and windows, retaining unclaimed IDs for the next call', () => {
  const ids = add(...Array.from({ length: 200 }, (_, i) => trigger(String(i).padStart(3, '0'))))
  const first = triage.claim(ids)
  expect(first.batches).toHaveLength(4); expect(first.batches.every(batch => batch.inputs.length === 32)).toBe(true)
  expect(first.deferred).toHaveLength(72)
  expect(triage.claim(first.deferred).batches).toHaveLength(0)
  for (const batch of first.batches) triage.submit(batch.id, batch.generation, result(batch))
  const next = triage.claim(first.deferred)
  expect(next.batches.map(batch => batch.inputs.length)).toEqual([32, 32, 8]); expect(next.deferred).toEqual([])
})

it('keeps a long or partial message unknown and never silently drops or treats truncation as none', () => {
  const ids = add(trigger('long', 'chat', 'x'.repeat(9000)), trigger('partial', 'chat', 'attachment unavailable', { partial: true }))
  const batch = triage.claim(ids).batches[0]!
  expect(batch.inputs.find(input => input.triggerId === 'long')!.text).toHaveLength(8000)
  expect(() => triage.submit(batch.id, 1, result(batch))).toThrow('Partial evidence')
  const value = { ...result(batch), items: result(batch).items.map(item => ({ ...item, bucket: 'unknown' as const })) }
  expect(triage.submit(batch.id, 1, value).state).toBe('completed')
})

it('rejects missing, duplicate, foreign and inconsistent coverage atomically', () => {
  const batch = triage.claim(add(trigger('a'), trigger('b'))).batches[0]!
  const valid = result(batch)
  const invalid = [
    { ...valid, items: valid.items.slice(0, 1) },
    { ...valid, items: [valid.items[0]!, valid.items[0]!] },
    { ...valid, items: [valid.items[0]!, { ...valid.items[1]!, triggerId: 'foreign' }] },
    { ...valid, items: valid.items.map(item => ({ ...item, matterIds: ['missing'] })) },
    { ...valid, matters: [{ id: 'm', title: 'Goal', reason: 'evidence', triggerIds: ['foreign'] }] },
  ]
  for (const value of invalid) {
    expect(() => triage.submit(batch.id, 1, value)).toThrow()
    expect(triage.read(batch.id).state).toBe('claimed')
  }
  triage.submit(batch.id, 1, valid)
  expect(() => triage.submit(batch.id, 1, { ...valid, model: 'overwrite' })).toThrow('already committed')
})

it('recovers SQLite membership after restart, renews expired leases and refuses late generation results', () => {
  const batch = triage.claim(add(trigger('a'), trigger('b'))).batches[0]!
  store.close(); store = new Store(join(directory, 'state.sqlite')); triage = service()
  expect(triage.claim(['a']).batches[0]).toEqual(batch)
  now += 300_001
  expect(() => triage.submit(batch.id, 1, result(batch))).toThrow('expired')
  const renewed = triage.claim(['b']).batches[0]!
  expect(renewed.inputs.map(input => input.triggerId)).toEqual(['a', 'b']); expect(renewed.generation).toBe(2)
  expect(() => triage.submit(batch.id, 1, result(batch))).toThrow('Stale')
  expect(triage.submit(batch.id, 2, result(renewed)).state).toBe('completed')
})

it('rechecks pause, source access, input and settings revisions at commit', () => {
  const batch = triage.claim(add(trigger('a'))).batches[0]!
  paused = true; expect(() => triage.submit(batch.id, 1, result(batch))).toThrow('paused'); paused = false
  enabled = false; expect(() => triage.read(batch.id)).toThrow('unavailable'); enabled = true
  configuration = 'changed'; expect(() => triage.submit(batch.id, 1, result(batch))).toThrow('configuration changed'); configuration = 'v1'
  store.set(KV.settings.revision, 1); expect(() => triage.submit(batch.id, 1, result(batch))).toThrow('Settings changed')
  store.set(KV.settings.revision, 0)
  store.triggers.save({ ...store.triggers.get('a')!, text: 'changed' })
  expect(() => triage.submit(batch.id, 1, result(batch))).toThrow('immutable evidence')
})

it('does not partially claim a request containing unavailable or duplicate evidence', () => {
  add(trigger('a'))
  expect(() => triage.claim(['a', 'unknown'])).toThrow('unavailable')
  expect(() => triage.claim(['a', 'a'])).toThrow('distinct')
  expect(store.keys('triage-shadow-')).toEqual([])
})

it('splits distant time windows and character-heavy chunks deterministically', () => {
  const ids = add(...Array.from({ length: 5 }, (_, i) => trigger(String(i), 'chat', 'x'.repeat(8000))))
  now += 900_001; ids.push(...add(trigger('later')))
  const claimed = triage.claim(ids)
  expect(claimed.batches.map(batch => batch.inputs.length)).toEqual([4, 1, 1])
})

it('supports a non-activity IM plugin and refuses its evidence when disabled or out of scope', () => {
  let settings = store.settings()
  const sources = new SourceRegistry(() => settings)
  sources.register({ kind: 'other-im', title: { en: 'IM', zh: 'IM' }, description: { en: 'IM', zh: 'IM' },
    schema: z.object({}), fields: [], health: [], scope: ({ meta }) => meta.allowed === false
      ? { listened: false, reason: 'scope' } : { listened: true, observed: true },
    imEvidence: item => ({ provider: 'other-im', account: 'owner', conversation: String(item.meta.conversation), message: item.id, version: 'v1', partial: false }) })
  const service = new ShadowTriage({ store, evidence: item => sources.imEvidence(item), paused: () => false, now: () => now })
  const batch = service.claim(add(trigger('a'), trigger('b'))).batches[0]!
  expect(batch.inputs).toHaveLength(2)
  settings = { ...settings, sources: { ...settings.sources, 'other-im': { enabled: false, config: {} } } }
  expect(() => service.read(batch.id)).toThrow('unavailable')
})

it('exposes a real schema-validated tool consumer, with semantic results only in the shadow ledger', async () => {
  const tools = triageTools(triage), signal = new AbortController().signal
  const call = async (name: string, args: unknown) => {
    const tool = tools.find(item => item.name === name)!
    return tool.execute(tool.schema.parse(args), signal)
  }
  const claimed = await call('orchestrator_triage_shadow_claim', { trigger_ids: add(trigger('a'), trigger('b')) }) as { batches: TriageBatch[] }
  const batch = claimed.batches[0]!
  await call('orchestrator_triage_shadow_submit', { batch_id: batch.id, generation: 1, result: result(batch) })
  expect(await call('orchestrator_triage_shadow_read', { batch_id: batch.id })).toMatchObject({ state: 'completed' })
})

it('renews configuration/settings versions only after expiry, retaining exact original message membership', () => {
  const batch = triage.claim(add(trigger('a'), trigger('b'))).batches[0]!
  configuration = 'v2'; store.set(KV.settings.revision, 7)
  expect(triage.read(batch.id).inputs).toHaveLength(2)
  expect(() => triage.claim(['a'])).toThrow('configuration changed')
  now += 300_001
  const renewed = triage.claim(['a']).batches[0]!
  expect(renewed.generation).toBe(2); expect(renewed.settingsRevision).toBe(7)
  expect(triage.submit(renewed.id, 2, result(renewed)).state).toBe('completed')
})

it('registers shadow tools only on the opted-in main Session, never workers or the default profile', async () => {
  const { startRuntime, feishu } = await import('./fixtures/host.ts')
  const normal = await startRuntime()
  try {
    expect(normal.tools.get(normal.runtime.masterId)?.has('orchestrator_triage_shadow_claim')).toBe(false)
    expect(normal.tools.get(normal.runtime.masterId)?.has('orchestrator_triage_shadow_context')).toBe(false)
  }
  finally { await normal.stop() }
  const opted = await startRuntime(undefined, { triageShadow: true })
  try {
    expect(opted.tools.get(opted.runtime.masterId)?.has('orchestrator_triage_shadow_claim')).toBe(true)
    const worker = await opted.acceptedTicket(feishu('983', 'Fix a test'))
    expect(opted.tools.get(worker.sessionId)?.has('orchestrator_triage_shadow_claim')).toBe(false)
    expect(opted.tools.get(worker.sessionId)?.has('orchestrator_triage_shadow_context')).toBe(false)
    opted.runtime.sources.register({ kind: 'other-im', title: { en: 'IM', zh: 'IM' }, description: { en: 'IM', zh: 'IM' },
      schema: z.object({}), fields: [], health: [], imEvidence: item => ({ provider: 'im', account: 'owner',
        conversation: 'chat', message: item.id, version: 'v1', partial: false }),
      imContext: async (_commands, request) => ({ provider: request.anchor.provider, account: request.anchor.account,
        conversation: request.anchor.conversation, start: request.start, end: request.end, consistency: 'live_paginated', gaps: [],
        messages: [{ id: request.anchor.message, text: 'evidence', version: 'v1', createdAt: request.start },
          { id: 'later-owner-reply', sender: 'owner', text: 'Cancel that request', createdAt: request.start }] }) })
    opted.runtime.store.triggers.save(trigger('runtime-a')); opted.runtime.store.triggers.save(trigger('runtime-b'))
    const claimed = await opted.runTool(opted.runtime.masterId, 'orchestrator_triage_shadow_claim',
      { trigger_ids: ['runtime-a', 'runtime-b'] }) as unknown as { batches: TriageBatch[] }
    expect(claimed.batches).toHaveLength(1)
    const batch = claimed.batches[0]!
    const prepared = await opted.runTool(opted.runtime.masterId, 'orchestrator_triage_shadow_context',
      { batch_id: batch.id, generation: 1, anchor_trigger_id: 'runtime-a',
        window: { start: new Date(now).toISOString(), end: new Date(now + 60_000).toISOString() } }) as unknown as TriageBatch
    expect(prepared.context?.manifest.messages.map(message => message.id)).toEqual(['runtime-a', 'later-owner-reply'])
    expect(prepared.contextComplete).toBe(false)
    expect(await opted.runTool(opted.runtime.masterId, 'orchestrator_triage_shadow_submit',
      { batch_id: batch.id, generation: 1, result: result(batch) })).toMatchObject({ state: 'completed' })
    expect(opted.runtime.store.tickets.list()).toHaveLength(1)
  } finally { await opted.stop() }
})
