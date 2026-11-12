/** Production pipeline: real durable effects, per-anchor evidence, ownership, and no business effects. */
import { createHash } from 'node:crypto'
import { TriageMatters } from '../src/app/triage-matters.ts'
import { open as openLine, attach } from '../src/app/lines.ts'
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
import { observeImEvidence } from '../src/app/im-evidence-revisions.ts'
import type { ImContextReader } from '../src/sources/im-context.ts'
let directory: string, store: Store, engine: Engine, handoffs: TriageHandoffs, service: ProductionTriage, effects: Effects
let provider: string
let enabled: boolean, paused: boolean, source: boolean, configuration: string, version: string, prompt: string, now: string
let native: (id: string) => ImContextReader
const deliver = vi.fn(async (_id: string, _text: string, authorize: () => void) => { authorize(); return now })
const policy = (): Policy => ({ version, paused, evalTimeoutMs: 60000, revalidate: () => true, admitsInferred: () => true,
  gate: trigger => ({ admissible: true, strength: trigger.addressed ? 'explicit' : 'inferred', basis: { via: 'followup' } }) })
const evidence = (trigger: Trigger) => source ? { provider: String(trigger.meta.provider ?? provider), account: 'owner', conversation: String(trigger.meta.chat ?? 'chat'), message: trigger.id, version: 'v1', partial: false, configuration } : undefined
const options = () => ({ repo: store, policy, now: () => now, externalAssessments: () => service?.activeCount() ?? 0,
  scope: { scope: () => ({ listened: true as const, observed: true }) }, assessor: { request: vi.fn(), release: vi.fn() },
  executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }, outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
function setup() {
  engine = new Engine(options())
  effects = new Effects(store, { claim: () => ({ set: vi.fn() }) } as never)
  handoffs = new TriageHandoffs({ store, engine, enabled: () => true, evidence, policyVersion: () => version, now: () => now })
  service = new ProductionTriage({ store, engine, handoffs, effects, evidence, context: trigger => native(trigger.id),
    enabled: () => enabled, paused: () => paused, policy: () => version, prompt: () => prompt, now: () => now, deliver })
}
const add = (id: string, chat = 'chat', addressed = false, nativeProvider?: string) => engine.receive({ id, source: 'im', threads: [{ source: 'im', id: chat }],
  at: now, actor: { source: 'im', id: 'sender' }, human: true, text: `private ${id}`, meta: { chat, ...(nativeProvider ? { provider: nativeProvider } : {}) }, ...(addressed ? { addressed: 'mention' as const } : {}) })
const start = (ids = ['a']) => {
  handoffs.adopt('owner', ids, handoffs.preview(ids).fingerprint)
  return service.start('owner', 1, { start: '2026-11-09T00:00:00.000Z', end: '2026-11-11T00:00:00.000Z' })
}
const drain = async () => { effects.start(); await effects.idle('triageAssessment') }
const consume = (batch: ProductionBatch) => {
  for (const input of batch.inputs) { let offset: number | null = 0; do { offset = service.context(batch.id, batch.generation, input.triggerId, offset).next_offset } while (offset !== null) }
}
const result = (batch: ProductionBatch, kind: 'informational' | 'unknown' = 'informational') => ({ model: 'reported-model',
  items: batch.inputs.map(input => ({ triggerId: input.triggerId, kind, reason: 'A shared reference', context: (() => { try { const context = service.read(batch.id).contexts[input.triggerId]; return { revision: context?.revision ?? 1, hash: context?.hash ?? 'x'.repeat(64) } } catch { return { revision: 1, hash: 'x'.repeat(64) } } })(), matterIds: [] as string[] })), matters: [] })
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

async function next(id: string, text = 'A concrete goal', chat = 'chat', nativeProvider?: string) {
  add(id, chat, false, nativeProvider); observeImEvidence(store, evidence(store.triggers.get(id)!)!)
  const ids = [id], owner = `owner-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`; handoffs.adopt(owner, ids, handoffs.preview(ids).fingerprint)
  const [batch] = service.start(owner, 1, { start: '2026-11-09T00:00:00.000Z', end: '2026-11-11T00:00:00.000Z' }); await drain(); consume(batch!)
  const live = service.read(batch!.id), value = { ...result(batch!), matters: [{ id: 'local', title: text, reason: 'Cited observation', triggerIds: ids }] }
  value.items[0]!.matterIds = ['local']
  return { batch: live, value }
}
function commit(current: Awaited<ReturnType<typeof next>>, proposals?: unknown[]) {
  return service.submit(current.batch.id, current.batch.generation, current.batch.binding!, { ...current.value, ...(proposals ? { proposals } : {}) } as never)
}
function cite(batch: Pick<ProductionBatch, 'id' | 'generation' | 'inputs'>, triggerId = batch.inputs[0]!.triggerId) {
  return { kind: 'trigger' as const, batchId: batch.id, generation: batch.generation, triggerId, version: batch.inputs.find(input => input.triggerId === triggerId)!.identity.version }
}
function prior(current: Pick<ProductionBatch, 'id' | 'generation'>, old: ProductionBatch) {
  let offset: number | null = 0
  do { offset = service.matterContext(current.id, current.generation, old.id, old.inputs[0]!.triggerId, offset).next_offset } while (offset !== null)
}
function link(current: Awaited<ReturnType<typeof next>>, old: ProductionBatch, relation = 'continue') {
  const candidate = service.matterCandidates(current.batch.id, 1).groups.find(group => group.members.some(member => member.batchId === old.id))!
  return { localMatterId: 'local', relation, targetId: candidate.id, expectedRevision: candidate.revision, assessment: 'suggested_action', reason: 'Same observed goal', evidence: [cite(current.batch), cite(old)] }
}
it('associates two native channels with existing work and revalidates each receipt independently', async () => {
  const first = await next('a', 'Deployment update', 'feishu-chat', 'feishu'); commit(first)
  const second = await next('b', 'Deployment feedback', 'wechat-chat', 'wechat'); commit(second)
  add('owner', 'owner-chat', true)
  const accepted = engine.decide('owner', { kind: 'accept', title: 'Deployment review', scope: 'Read deployment evidence', name: 'deployment-review', reason: 'Owner request', acknowledgement: 'Received' })
  const ticketId = accepted.ticketId!, target = { kind: 'ticket' as const, id: ticketId }
  const line = openLine(store, { title: 'Deployment', evidence: 'Owner deployment goal' }).line
  attach(store, { lineId: line.id, ticketId, evidence: 'Same goal' })
  const groups = service.matters.overview().groups
  const feishu = groups.find(group => group.conversation === 'feishu-chat')!, wechat = groups.find(group => group.conversation === 'wechat-chat')!
  const delivery = vi.fn(() => engine.note(ticketId, 'Read associated evidence').inputs.at(-1)!.id)
  const linked = service.matters.handoff(feishu.id, feishu.revision, target, 'Same deployment', delivery)
  expect(linked.inputId).toBeDefined()
  expect(service.matters.handoff(feishu.id, feishu.revision, target, 'Same deployment', delivery).reused).toBe(true)
  expect(delivery).toHaveBeenCalledTimes(1)
  service.matters.handoff(wechat.id, wechat.revision, { kind: 'line', id: line.id }, 'Same deployment')
  const page = service.matters.workEvidence(target)
  expect(page.items).toHaveLength(2)
  expect(service.matters.workEvidence({ kind: 'line', id: line.id }).items).toHaveLength(2)
  expect(page.items.map(item => service.matters.readEvidence(item.reference, target).inputs[0]!.identity.provider).sort()).toEqual(['feishu', 'wechat'])
  const one = service.matters.workEvidence(target, undefined, 1)
  expect(service.matters.workEvidence(target, one.next_offset!, 1).items[0]!.reference).not.toBe(one.items[0]!.reference)
  expect(() => service.matters.readEvidence(page.items[0]!.reference, { kind: 'ticket', id: 'another-task' })).toThrow('not associated')
  const restricted = new TriageMatters(store, trigger => trigger.meta.provider === 'feishu' ? undefined : evidence(trigger))
  const restrictedPage = restricted.workEvidence(target)
  expect(restrictedPage.items.filter(item => item.redacted)).toHaveLength(1)
  expect(() => restricted.readEvidence(restrictedPage.items.find(item => item.redacted)!.reference, target)).toThrow('access changed')
  expect(JSON.parse(JSON.stringify(page))).toEqual(page)
})

it('rolls back the association and context note together when delivery fails', async () => {
  commit(await next('a'))
  add('owner', 'owner-chat', true)
  const ticketId = engine.decide('owner', { kind: 'accept', title: 'Review', scope: 'Read evidence', name: 'review', reason: 'Owner request', acknowledgement: 'Received' }).ticketId!
  const matter = service.matters.overview().groups[0]!, before = structuredClone(store.tickets.get(ticketId))
  expect(() => service.matters.handoff(matter.id, matter.revision, { kind: 'ticket', id: ticketId }, 'Evidence', () => {
    engine.note(ticketId, 'Context'); throw new Error('Interrupted')
  })).toThrow('Interrupted')
  expect(store.tickets.get(ticketId)).toEqual(before)
  expect(service.matters.overview().groups[0]).toMatchObject({ revision: matter.revision })
  expect(service.matters.overview().groups[0]!.handoff).toBeUndefined()
})

it('can cite readable partial evidence for continuation while keeping no-further-action evidence complete', async () => {
  const first = commit(await next('a'))
  const normal = native
  native = id => { const reader = normal(id); return { ...reader, async read(...args) {
    const page = await reader.read(...args); page.anchor!.partial = true; return page
  } } }
  const update = await next('b'); prior(update.batch, first)
  const proposal = link(update, first)
  expect(() => commit(update, [{ ...proposal, assessment: 'no_further_action_suggested' }])).toThrow()
  expect(commit(update, [{ ...proposal, assessment: 'informational' }]).state).toBe('completed')
  expect(service.matters.overview().groups[0]!.memberCount).toBe(2)
})

it('uses actual main production consumer to continue same goal across batches with immutable receipts and no business effects', async () => {
  const a = await next('a'); const first = commit(a), receipt = JSON.stringify(first)
  const b = await next('b'); expect(b.batch.priorMatters.groups[0]?.memberCount).toBe(1); const proposal = link(b, first)
  expect(() => commit(b, [proposal])).toThrow('Read exact')
  prior(b.batch, first); const completed = commit(b, [proposal])
  expect(commit(b, [proposal])).toEqual(completed)
  expect(JSON.stringify(store.get(`triage-production:${first.id}`))).toBe(receipt)
  const groups = service.matters.overview().groups
  expect(groups).toHaveLength(1); expect(groups[0]).toMatchObject({ revision: 2, memberCount: 2, stale: true, assessment: 'suggested_action' })
  for (const table of ['ticket', 'decision', 'outbox']) expect(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0)
  expect(store.triggers.disposition('b')!.acked).toBeUndefined()
})
it('keeps unrelated goals and related navigation separate, with undo and idempotent replay', async () => {
  const a = await next('a'); const first = commit(a)
  const b = await next('b', 'Another goal'); commit(b)
  const c = await next('c', 'Related but distinct'); prior(c.batch, first); const proposal = link(c, first, 'related'); commit(c, [proposal])
  const groups = service.matterCandidates(c.batch.id, 1).groups
  expect(groups).toHaveLength(3)
  const related = groups.find(group => group.related)!
  expect(related.memberCount).toBe(1)
  const removed = service.matterRetractRelated(c.batch.id, 1, related.id, related.revision, 'Not actually related')
  expect(removed.related).toBeUndefined()
  expect(service.matterRetractRelated(c.batch.id, 1, related.id, related.revision, 'Not actually related')).toEqual(removed)
})
it('splits a mistaken membership with audit, CAS, source receipts preserved and restart idempotency', async () => {
  const a = await next('a'); const first = commit(a), b = await next('b'); prior(b.batch, first); commit(b, [link(b, first)])
  const target = service.matterCandidates(b.batch.id, 1).groups[0]!, member = target.members.find(member => member.batchId === b.batch.id)!
  const before = store.get(`triage-production:${b.batch.id}`)
  const split = service.matterSplit(b.batch.id, 1, target.id, target.revision, member.id, 'Different goals')
  expect(split.original).toMatchObject({ memberCount: 1, assessment: 'unknown', stale: true })
  expect(split.separated).toMatchObject({ memberCount: 1, assessment: 'unknown', stale: true })
  expect(store.get(`triage-production:${b.batch.id}`)).toEqual(before)
  await effects.drain(); setup()
  expect(service.matterSplit(b.batch.id, 1, target.id, target.revision, member.id, 'Different goals')).toEqual(split)
  expect(service.matterDetail(b.batch.id, 1, target.id).events.some(event => event.kind === 'split')).toBe(true)
})
it('rejects stale target revisions atomically without completing coverage or overwriting projection', async () => {
  const a = await next('a'); const first = commit(a), b = await next('b'); prior(b.batch, first); const proposal = link(b, first)
  const key = `triage-matter:${proposal.targetId}`, target = store.get<Record<string, unknown>>(key)!; target.revision = 2; store.set(key, target)
  expect(() => commit(b, [proposal])).toThrow('current target revision')
  expect(store.get<ProductionBatch>(`triage-production:${b.batch.id}`)!.state).toBe('awaiting')
  expect(service.matters.overview().groups[0]!.memberCount).toBe(1)
})
it('does not merge across native conversations and one message can belong to multiple matters', async () => {
  const a = await next('a'); const first = commit(a)
  const b = await next('b', 'Elsewhere', 'other')
  expect(() => prior(b.batch, first)).toThrow('native scope')
  b.value.matters.push({ id: 'second', title: 'Independent goal', reason: 'Also in this message', triggerIds: ['b'] }); b.value.items[0]!.matterIds.push('second')
  commit(b); expect(service.matters.overview().groups).toHaveLength(3)
})
it('accepts context-only positive cancellation evidence as a bounded suggestion, never closes obligations or clears stale', async () => {
  const a = await next('a'); const first = commit(a)
  native = id => ({ assertActive() { if (!source) throw new Error('revoked') }, async read(request) {
    const anchor = { id, text: `private ${id}`, version: 'v1', createdAt: now }
    return { provider, account: 'owner', conversation: 'chat', start: request.start, end: request.end, consistency: 'live_paginated', gaps: ['sender_authority_unverified'], anchor,
      messages: [anchor, { id: 'context-only', text: 'Cancel the earlier request; here is a separate new request.', version: 'cancel-v1', sender: 'unverified', createdAt: now }] }
  } })
  const b = await next('b', 'Updated bounded suggestion'); prior(b.batch, first); const proposal = link(b, first), context = service.read(b.batch.id).contexts.b!
  const citation = { kind: 'context', batchId: b.batch.id, generation: 1, triggerId: 'b', revision: context.revision, hash: context.hash, messageId: 'context-only', version: 'cancel-v1' }
  const value = { ...proposal, assessment: 'no_further_action_suggested', evidence: [...proposal.evidence, citation] }
  expect(() => commit(b, [{ ...value, evidence: proposal.evidence }])).toThrow('positive current')
  commit(b, [value]); expect(service.matters.overview().groups[0]).toMatchObject({ assessment: 'no_further_action_suggested', stale: true })
  expect(store.triggers.get('context-only')).toBeUndefined(); expect(store.triggers.disposition('b')!.acked).toBeUndefined()
})
it('rejects forged/deleted/partial context citations and late source revocation without partial writes', async () => {
  const a = await next('a'); const first = commit(a), b = await next('b'); prior(b.batch, first); const proposal = link(b, first)
  const context = service.read(b.batch.id).contexts.b!
  const forged = { kind: 'context', batchId: b.batch.id, generation: 1, triggerId: 'b', revision: context.revision, hash: context.hash, messageId: 'missing', version: 'v2' }
  expect(() => commit(b, [{ ...proposal, evidence: [...proposal.evidence, forged] }])).toThrow('exact readable')
  source = false; expect(() => commit(b, [proposal])).toThrow()
  const view = JSON.stringify(service.matters.overview()); expect(view).not.toContain('A concrete goal'); expect(view).not.toContain('Cited observation'); expect(service.matters.overview().groups[0]!.redacted).toBe(true)
})
it('does not clear older matter freshness on new unrelated batches or duplicate replay', async () => {
  const a = await next('a'); commit(a); const original = service.matters.overview().groups[0]!
  observeImEvidence(store, evidence(store.triggers.get('a')!)!); expect(service.matters.overview().groups[0]!.stale).toBe(false)
  const b = await next('b', 'Independent'); commit(b)
  expect(service.matters.overview().groups.find(group => group.id === original.id)!.stale).toBe(true)
})
it('paginates more than 50 legacy groups without rewriting receipts or falsely linking imports', async () => {
  const a = await next('a'); const first = commit(a)
  for (let i = 0; i < 63; i++) {
    const batch = { ...first, id: `legacy-${i}`, createdAt: `2020-${String(i).padStart(2, '0')}`, evidenceRevision: undefined }
    store.set(`triage-production:${batch.id}`, batch)
  }
  let page = service.matterCandidates(a.batch.id, 1), rounds = 0
  expect(service.matters.overview().total).toBeLessThanOrEqual(26)
  while (page.legacyRemaining) { page = service.matterCandidates(a.batch.id, 1); rounds++ }
  expect(rounds).toBeGreaterThan(0); expect(service.matters.overview().total).toBe(64)
  const ids: string[] = []; let before: number | undefined
  do { const page = service.matters.overview({ before, limit: 13 }); ids.push(...page.groups.map(group => group.id)); before = page.nextBefore ?? undefined } while (before)
  expect(new Set(ids).size).toBe(64)
  expect(service.matters.overview().oldestAt).toMatch(/^2020/)
})
it('retains staleness for arrivals concurrent with judgment and for out-of-order native edits/deletes', async () => {
  const a = await next('a'); commit(a)
  const b = await next('b'); const aReceipt = store.get<ProductionBatch>(`triage-production:${a.batch.id}`)!; prior(b.batch, aReceipt); const proposal = link(b, aReceipt)
  observeImEvidence(store, { ...evidence(store.triggers.get('a')!)!, version: 'older-edit-arrived-late' })
  observeImEvidence(store, { ...evidence(store.triggers.get('a')!)!, version: 'deleted-v3' })
  commit(b, [proposal]); expect(service.matters.overview().groups[0]!.stale).toBe(true)
  observeImEvidence(store, { ...evidence(store.triggers.get('a')!)!, version: 'deleted-v3' })
  expect(service.matters.overview().groups[0]!.stale).toBe(true)
})
it('keeps changed or missing anchor uncertainty from being upgraded by a matter proposal', async () => {
  const a = await next('a'); const value = a.value
  value.items[0]!.kind = 'unknown'
  expect(() => commit(a, [{ localMatterId: 'local', relation: 'new', assessment: 'suggested_action', reason: 'Try to upgrade', evidence: [cite(a.batch)] }])).toThrow('Unknown local evidence')
})
it('redacts proposal reasons and historical evidence after configuration revocation', async () => {
  const a = await next('a'); const first = commit(a), b = await next('b'); prior(b.batch, first); commit(b, [link(b, first)])
  const target = service.matters.overview().groups[0]!
  configuration = 'revoked-old-configuration'
  const serialized = JSON.stringify(service.matters.overview())
  expect(serialized).not.toContain('Same observed goal'); expect(serialized).not.toContain('Cited observation'); expect(serialized).not.toContain('private a')
  expect(() => service.matterContext(b.batch.id, 1, first.id, 'a')).toThrow()
  expect(target.memberCount).toBe(2)
})
it('redacts original receipt derived prose when only an earlier cited input becomes unreadable', async () => {
  const a = await next('a'); const first = commit(a), b = await next('b'); prior(b.batch, first); commit(b, [link(b, first)])
  const old = store.triggers.get('a')!; old.text = 'Changed immutable prior input'
  store.db.prepare('UPDATE trigger SET value = ? WHERE id = ?').run(JSON.stringify(old), 'a')
  expect(() => service.read(b.batch.id)).toThrow('Derived receipt')
  const view = productionOverview(store, evidence), current = view.groups.find(group => group.id === b.batch.id)!
  expect(current.redacted).toBe(true); expect(JSON.stringify(current)).not.toContain('Same observed goal')
  expect(service.matters.overview().groups[0]!.redacted).toBe(true)
})
it.each(['deleted', 'partial'] as const)('rejects %s context-only evidence as positive cancellation support', async flag => {
  native = id => ({ assertActive() {}, async read(request) {
    const anchor = { id, text: `private ${id}`, version: 'v1', createdAt: now }
    return { provider, account: 'owner', conversation: 'chat', start: request.start, end: request.end, consistency: 'live_paginated', gaps: [], anchor,
      messages: [anchor, { id: 'support', text: 'Cancellation fragment', version: 'v2', createdAt: now, [flag]: true }] }
  } })
  const a = await next('a'), context = service.read(a.batch.id).contexts.a!
  expect(() => commit(a, [{ localMatterId: 'local', relation: 'new', assessment: 'no_further_action_suggested', reason: 'Bad support', evidence: [cite(a.batch),
    { kind: 'context', batchId: a.batch.id, generation: 1, triggerId: 'a', revision: context.revision, hash: context.hash, messageId: 'support', version: 'v2' }] }])).toThrow('exact readable positive')
  expect(service.matters.overview().total).toBe(0)
})
it.each(['continue', 'related'] as const)('real WeChat native adapter → collector permits %s via stable input citations while preserving native-version gaps', async relation => {
  provider = 'wechat'
  const execute = vi.fn(async () => ({ isError: false, value: { content: [], structuredContent: {
    status: 'ok', account: 'owner', conversation: 'chat', snapshot_id: 'native-local-snapshot', count: 2, has_more: false, next_offset: null,
    records: ['wx1.a', 'wx1.b'].map(id => ({ account: 'owner', conversation: 'chat', record_id: `record-${id}`, message_ref: id, timestamp: Date.parse(now) / 1000,
      time: now, text: `private ${id}`, sender: 'sender', direction: 'incoming', local_type: 1 })),
  } } }))
  const tools = { execute, schemas: vi.fn() } as unknown as ActivityTools
  native = () => ({ assertActive() {}, read: (request, cursor, signal) => readWechatImContext(tools, { serverName: 'wechat_readonly' }, request, cursor, signal) })
  const a = await next('wx1.a'); const first = commit(a), b = await next('wx1.b'); prior(b.batch, first)
  expect(b.batch.contexts['wx1.b']!.anchor).toMatchObject({ status: 'unverified', contentMatch: true })
  commit(b, [link(b, first, relation)])
  const groups = service.matters.overview().groups
  expect(groups).toHaveLength(relation === 'continue' ? 1 : 2)
  const member = groups.flatMap(group => group.members).find(member => member.batchId === b.batch.id)!
  expect(member.contexts[0]).toMatchObject({ anchorStatus: 'unverified', contextComplete: false,
    gaps: expect.arrayContaining(['local_sync_only', 'native_version_unavailable', 'deletion_status_unavailable']) })
  expect(member.contexts[0]!.nativeVersion).toBeUndefined()
  expect(store.triggers.disposition('wx1.b')!.acked).toBeUndefined()
  expect(execute).toHaveBeenCalledTimes(2)
})
it('upgrades schema13 without rewriting receipts and fences pre-provenance schema13 readers', async () => {
  const a = await next('a'); const first = commit(a), receipt = JSON.stringify(store.get(`triage-production:${first.id}`))
  await effects.drain(); store.set(KV.store.schema, 13); store.close(); store = new Store(join(directory, 'state.sqlite')); setup()
  expect(store.get(KV.store.schema)).toBe(14); expect(JSON.stringify(store.get(`triage-production:${first.id}`))).toBe(receipt)
  const oldSchema13Guard = () => { const version = store.get(KV.store.schema)!; if (version > 13) throw new Error(`Unsupported orchestrator database version ${version}`) }
  expect(oldSchema13Guard).toThrow('version 14')
})
it('rejects duplicate continue targets clearly before mutating a projection or receipt', async () => {
  const a = await next('a'); const first = commit(a), b = await next('b'); prior(b.batch, first); const proposal = link(b, first)
  b.value.matters.push({ ...b.value.matters[0]!, id: 'second' }); b.value.items[0]!.matterIds.push('second')
  expect(() => commit(b, [proposal, { ...proposal, localMatterId: 'second' }])).toThrow('One continue proposal per target')
  expect(service.matters.overview().groups[0]!.revision).toBe(1)
  expect(store.get<ProductionBatch>(`triage-production:${b.batch.id}`)!.state).toBe('awaiting')
})
it.each([63, 500])('validates a %i-receipt continuation chain in linear source reads and drops cache before next request', count => {
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  // Fixture creation is outside the read-complexity assertions and needs only one disk commit.
  store.atomic(() => {
    for (let i = 0; i < count; i++) {
      const id = `perf-${i}`, trigger: Trigger = { id, source: 'im', threads: [], at: now, actor: { source: 'im', id: 'sender' }, human: true, text: id, meta: {} }
      store.triggers.save(trigger); const resolved = evidence(trigger)!, { configuration: _configuration, ...identity } = resolved
      const ref = { kind: 'trigger', batchId: id, generation: 1, triggerId: id, version: 'v1' }
      const refs = i ? [ref, { ...ref, batchId: `perf-${i - 1}`, triggerId: `perf-${i - 1}` }] : [ref]
      store.set(`triage-production:${id}`, { id, generation: 1, state: 'completed', matterProvenance: Array.from({ length: i }, (_, j) => `perf-${j}`), inputs: [{ triggerId: id, identity, fingerprint: hash({ trigger, evidence: resolved }) }], contexts: {},
        result: { matters: [{ id: 'local', title: 'Private goal', reason: 'Private basis', triggerIds: [id] }], proposals: i ? [{ evidence: refs }] : [] } })
      store.set(`triage-matter-member:${id}`, { id, batchId: id, generation: 1, localMatterId: 'local', matterId: 'chain', originId: id })
      store.set(`triage-matter-event:${id}`, { id, matterId: 'chain', revision: i + 1, memberId: id, evidence: refs })
    }
  })
  store.set('triage-matter:chain', { id: 'chain', scope: 'scope', revision: count, title: 'Private goal', reason: 'Private basis', assessment: 'suggested_action', anchorBatchId: 'perf-0', observedRevision: 0, createdAt: now, updatedAt: now })
  const resolve = vi.fn(evidence), projection = new TriageMatters(store, resolve), get = vi.spyOn(store, 'get')
  expect(projection.overview().groups[0]!.redacted).toBe(false)
  expect(resolve.mock.calls.length).toBeLessThanOrEqual(count)
  expect(get.mock.calls.length).toBeLessThan(10 * count + 100)
  get.mockClear(); resolve.mockClear()
  expect(projection.receiptReadable(store.get<ProductionBatch>(`triage-production:perf-${count - 1}`)!)).toBe(true)
  expect(resolve.mock.calls.length).toBeLessThanOrEqual(count)
  expect(get.mock.calls.length).toBeLessThanOrEqual(count + 1)
  get.mockRestore(); source = false
  const revoked = projection.overview()
  expect(revoked.groups[0]!.redacted).toBe(true); expect(JSON.stringify(revoked)).not.toContain('Private goal')
}, 60_000)
it('retains host-owned provenance for read summaries even when the model submits new without linking', async () => {
  const a = await next('a'); commit(a)
  const b = await next('b', 'Possibly derived from a candidate'); commit(b)
  expect(store.get<ProductionBatch>(`triage-production:${b.batch.id}`)!.matterProvenance).toContain(a.batch.id)
  const old = store.triggers.get('a')!; old.text = 'Revoked historical input'; store.db.prepare('UPDATE trigger SET value = ? WHERE id = ?').run(JSON.stringify(old), 'a')
  expect(() => service.read(b.batch.id)).toThrow('Derived receipt')
  expect(service.matters.overview().groups.every(group => group.redacted)).toBe(true)
})
it('rejects late revocation of an unlinked candidate read before committing coverage', async () => {
  const a = await next('a'); commit(a); const b = await next('b')
  const old = store.triggers.get('a')!; old.text = 'Changed after candidate read'; store.db.prepare('UPDATE trigger SET value = ? WHERE id = ?').run(JSON.stringify(old), 'a')
  expect(() => commit(b)).toThrow('source permission')
  expect(store.get<ProductionBatch>(`triage-production:${b.batch.id}`)!.state).toBe('awaiting')
})
it('persists correction reason provenance even for a separately read unlinked candidate', async () => {
  const a = await next('a'); const first = commit(a), b = await next('b'); prior(b.batch, first); commit(b, [link(b, first)])
  const c = await next('c', 'Separate private source'); commit(c)
  const d = await next('d'); const groups = service.matterCandidates(d.batch.id, 1).groups
  const target = groups.find(group => group.memberCount === 2)!, member = target.members.find(member => member.batchId === b.batch.id)!
  const corrected = service.matterSplit(d.batch.id, 1, target.id, target.revision, member.id, 'Reason may use separate candidate')
  const old = store.triggers.get('c')!; old.text = 'Revoked candidate'; store.db.prepare('UPDATE trigger SET value = ? WHERE id = ?').run(JSON.stringify(old), 'c')
  const projection = service.matters.overview()
  expect(projection.groups.find(group => group.id === corrected.separated.id)!.redacted).toBe(true)
  expect(projection.groups.find(group => group.id === target.id)!.redacted).toBe(true)
})
it('records direct history/detail reads as provenance without requiring a candidate page in that attempt', async () => {
  const a = await next('a'); commit(a); const target = service.matters.overview().groups[0]!, b = await next('b')
  // Simulate a directly supplied known matter ID rather than a candidate page read.
  store.db.prepare('DELETE FROM kv WHERE key = ?').run(`triage-matter-read:${b.batch.id}:1`)
  service.matterDetail(b.batch.id, 1, target.id)
  const completed = commit(b); expect(completed.matterProvenance).toContain(a.batch.id)
  const old = store.triggers.get('a')!; old.text = 'Revoked detail source'; store.db.prepare('UPDATE trigger SET value = ? WHERE id = ?').run(JSON.stringify(old), 'a')
  expect(() => service.read(b.batch.id)).toThrow('Derived receipt')
})
it('revalidates newly read correction dependencies before mutating an otherwise readable target', async () => {
  const a = await next('a'); const first = commit(a), b = await next('b'); prior(b.batch, first); commit(b, [link(b, first)])
  const c = await next('c', 'Unlinked candidate'); commit(c)
  const target = service.matterCandidates(b.batch.id, 1).groups.find(group => group.memberCount === 2)!, member = target.members.find(member => member.batchId === b.batch.id)!
  const old = store.triggers.get('c')!; old.text = 'Revoked after read'; store.db.prepare('UPDATE trigger SET value = ? WHERE id = ?').run(JSON.stringify(old), 'c')
  expect(() => service.matterSplit(b.batch.id, 1, target.id, target.revision, member.id, 'Correction using new candidate')).toThrow('source permission')
  expect(service.matters.overview().groups.find(group => group.id === target.id)!.revision).toBe(target.revision)
})
it('stores direct provenance roots instead of copying a continuation chain transitive closure', async () => {
  const a = await next('a'); const first = commit(a), b = await next('b'); prior(b.batch, first); const second = commit(b, [link(b, first)])
  const c = await next('c'); const third = commit(c)
  expect(second.matterProvenance).toEqual([first.id]); expect(third.matterProvenance).toEqual([second.id])
})


it('returns lossless metadata with prior matters, unavailable native versions and redacted sources', async () => {
  const first = await next('json-first')
  commit(first)
  const second = await next('json-second')
  const metadata = service.read(second.batch.id)
  expect(metadata.priorMatters.groups).toHaveLength(1)
  expect(metadata).toStrictEqual(JSON.parse(JSON.stringify(metadata)))
  const candidates = service.matterCandidates(second.batch.id, second.batch.generation)
  expect(candidates).toStrictEqual(JSON.parse(JSON.stringify(candidates)))
  source = false
  const hidden = service.matters.overview()
  expect(hidden.groups[0]!.redacted).toBe(true)
  expect(hidden).toStrictEqual(JSON.parse(JSON.stringify(hidden)))
})
