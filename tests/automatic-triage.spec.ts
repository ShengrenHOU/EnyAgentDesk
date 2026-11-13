/** Synthetic end-to-end intake, finite migration, fair accumulation and consumption. No real sources. */
import { mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Engine, type Policy, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { TriageHandoffs } from '../src/app/triage-handoffs.ts'
import { AutomaticTriage } from '../src/app/automatic-triage.ts'
import { ProductionTriage, productionOverview, type ProductionBatch } from '../src/app/production-triage.ts'
import { automaticTriageTools } from '../src/app/tools/automatic-triage.ts'
import { evidenceRevision, newerKnownEvidence } from '../src/app/im-evidence-revisions.ts'
import { readConversationCursor } from '../src/app/im-conversation-cursors.ts'
let directory: string, store: Store, engine: Engine, effects: Effects, handoffs: TriageHandoffs, production: ProductionTriage, automatic: AutomaticTriage
let enabled: boolean, historical: boolean, paused: boolean, source: boolean, configuration: string, policyVersion: string, now: string
const request = vi.fn(), deliver = vi.fn(async (_id: string, _text: string, authorize: () => void) => { authorize(); return now })
const policy = (): Policy => ({ version: policyVersion, paused, evalTimeoutMs: 60_000, revalidate: () => true, admitsInferred: () => true,
  gate: trigger => ({ admissible: true, strength: trigger.addressed ? 'explicit' : 'inferred', basis: { via: 'followup' } }) })
const evidence = (trigger: Trigger) => source && trigger.source === 'im' ? { provider: 'test', account: String(trigger.meta.account ?? 'account'), conversation: String(trigger.meta.chat), message: String(trigger.meta.message ?? trigger.id), version: String(trigger.meta.version ?? 'v1'), partial: false, configuration } : undefined
const make = (id: string, chat = 'chat', extra: Partial<Trigger> = {}): Trigger => ({ id, source: 'im', threads: [{ source: 'im', id: chat }], at: now, actor: { source: 'im', id: 'sender' }, human: true, text: `private ${id}`, meta: { chat }, ...extra })
function setup() {
  engine = new Engine({ repo: store, policy, now: () => now, externalAssessments: () => production?.activeCount() ?? 0, deferEvaluation: trigger => automatic?.defer(trigger) ?? false,
    scope: { scope: () => ({ listened: true as const, observed: true }) }, assessor: { request, release: vi.fn() },
    executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }, outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  effects = new Effects(store, { claim: () => ({ set: vi.fn() }) } as never)
  handoffs = new TriageHandoffs({ store, engine, evidence, enabled: () => true, policyVersion: () => policyVersion, now: () => now })
  production = new ProductionTriage({ store, engine, effects, handoffs, evidence, enabled: () => true, automaticEnabled: () => enabled, paused: () => paused, policy: () => policyVersion, prompt: () => 'prompt', now: () => now, deliver,
    context: trigger => ({ assertActive() { if (!source) throw new Error('Source revoked') }, async read(input) { const anchor = { id: input.anchor.message, version: input.anchor.version, text: trigger.text, createdAt: trigger.at }; return { start: input.start, end: input.end, provider: input.anchor.provider, account: input.anchor.account, conversation: input.anchor.conversation, consistency: 'live_paginated' as const, gaps: ['account_visible_only'], anchor, messages: [anchor] } } }) })
  restartAutomatic()
}
function restartAutomatic() { automatic = new AutomaticTriage({ store, engine, handoffs, production, evidence, enabled: () => enabled, historical: () => historical, paused: () => paused, policy: () => policyVersion, prompt: () => 'prompt', now: () => now }) }
const rows = () => store.db.prepare("SELECT value FROM kv WHERE key LIKE 'triage-production:%' ORDER BY rowid").all().map(row => JSON.parse(String(row.value)) as ProductionBatch)
const advance = (ms = 3000) => { now = new Date(Date.parse(now) + ms).toISOString() }
async function drain() { effects.start(); await effects.idle('triageAssessment') }
function submit(batch: ProductionBatch, kind: 'informational' | 'unknown' = 'informational') {
  expect(batch.state, batch.problem).toBe('awaiting')
  for (const input of batch.inputs) { let offset: number | null = 0; do { offset = production.context(batch.id, batch.generation, input.triggerId, offset).next_offset } while (offset !== null) }
  const read = production.read(batch.id)
  return production.submit(batch.id, batch.generation, read.binding!, { model: 'synthetic', matters: [], items: batch.inputs.map(input => ({ triggerId: input.triggerId, kind, reason: 'Synthetic contextual judgment', matterIds: [], context: { revision: read.contexts[input.triggerId]!.revision, hash: read.contexts[input.triggerId]!.hash } })) })
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'auto-intake-')); store = new Store(join(directory, 'state.sqlite'))
  enabled = true; historical = true; paused = false; source = true; configuration = 'config'; policyVersion = 'policy'; now = '2026-11-10T12:00:00.000Z'; request.mockClear(); deliver.mockClear(); setup()
})
afterEach(async () => { await effects.drain(); store.close(); rmSync(directory, { recursive: true, force: true }) })

it('captures 500 fragments once, consumes 63 bounded judgments, and reserves explicit intake', async () => {
  // Same receive/maintain/evaluate sequence and assertions; one outer transaction avoids 500 synchronous commits on the slower runner.
  store.atomic(() => { for (let n = 0; n < 500; n++) { automatic.receive(make(`m${n}`)); automatic.maintain(); engine.evaluateDue() } })
  expect(rows()).toHaveLength(1); expect(request).not.toHaveBeenCalled()
  automatic.receive(make('urgent', 'chat', { addressed: 'mention' })); engine.evaluateDue()
  expect(request).toHaveBeenCalledTimes(1); expect(engine.candidate('urgent')!.triggers.map(item => item.id)).toEqual(['urgent'])
  expect(automatic.receive(make('m0'))).toBe('duplicate')
  advance()
  for (let n = 0; n < 65; n++) {
    automatic.maintain(); await drain()
    // Batch each round's context reads and submission, keeping the same reads, assertions and timeouts.
    store.atomic(() => { for (const batch of rows().filter(row => row.state === 'awaiting')) submit(batch) })
  }
  expect(rows()).toHaveLength(63); expect(deliver).toHaveBeenCalledTimes(63)
  const ids = rows().flatMap(row => row.inputs.map(input => input.triggerId))
  expect(ids).toHaveLength(500); expect(new Set(ids).size).toBe(500)
  expect(rows().every(row => row.inputs.length <= 8 && row.state === 'completed')).toBe(true)
  for (const table of ['ticket', 'decision', 'outbox']) expect(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0)
}, 30_000)

it('holds debounce until quiet or maxwait, survives restart, and honors UTF8 budget', () => {
  automatic.receive(make('a')); advance(1000); automatic.receive(make('b')); automatic.maintain(); expect(rows()).toHaveLength(0)
  restartAutomatic(); advance(2000); automatic.maintain(); expect(rows()[0]!.inputs.map(input => input.triggerId)).toEqual(['a', 'b'])
  const text = '😀'.repeat(2000)
  for (let n = 0; n < 5; n++) automatic.receive(make(`unicode${n}`, 'unicode', { text }))
  expect(automatic.status().owners.filter(owner => owner.messages === 4)).toHaveLength(1)
  expect(automatic.status().owners.filter(owner => owner.messages === 1)).toHaveLength(1)
})

it('keeps accumulating passive messages across unrelated settings changes', async () => {
  automatic.receive(make('a'))
  store.saveSettings({ ...store.settings(), executor: { ...store.settings().executor, maxWorkers: 7 },
    sources: { ...store.settings().sources, unrelated: { enabled: true, config: { pollSeconds: 300 } } } })
  automatic.receive(make('b')); advance(); automatic.maintain(); await drain()
  expect(rows()).toHaveLength(1)
  expect(rows()[0]!.inputs.map(input => input.triggerId)).toEqual(['a', 'b'])
  expect(rows()[0]!.state).toBe('awaiting')
})

it('continues a legacy full-settings group and upgrades its fingerprint when appending', async () => {
  automatic.receive(make('a'))
  const owner = automatic.status().owners[0]!.owner, groupKey = `automatic-triage-group:${owner}`
  const group = store.get<{ ids: string[]; fingerprint: string; fingerprintVersion?: 2 }>(groupKey)!
  delete group.fingerprintVersion
  group.fingerprint = createHash('sha256').update(JSON.stringify({ settings: { ...store.settings(), paused: false },
    policy: policyVersion, prompt: 'prompt', inputs: group.ids.map(id => {
      const trigger = store.triggers.get(id)!; return { trigger, evidence: evidence(trigger) }
    }) })).digest('hex')
  store.set(groupKey, group)
  store.saveSettings({ ...store.settings(), executor: { ...store.settings().executor, maxWorkers: 7 } })
  restartAutomatic()
  automatic.receive(make('b'))
  expect(store.get<{ fingerprintVersion: number }>(groupKey)!.fingerprintVersion).toBe(2)
  store.saveSettings({ ...store.settings(), executor: { ...store.settings().executor, maxWorkers: 7 } })
  advance(); automatic.maintain(); await drain()
  expect(rows()[0]!.inputs.map(input => input.triggerId)).toEqual(['a', 'b'])
})

it('age bound seals continuing low-volume chatter and out-of-order windows stay valid', async () => {
  for (let n = 0; n < 7; n++) { automatic.receive(make(`slow${n}`)); advance(1600); automatic.maintain() }
  expect(rows()).toHaveLength(1); expect(rows()[0]!.inputs).toHaveLength(7)
  await drain(); submit(rows()[0]!)
  automatic.receive(make('d0', 'late', { at: '2026-11-01T00:00:00.000Z' }))
  automatic.receive(make('d6', 'late', { at: '2026-11-07T00:00:00.000Z' }))
  automatic.receive(make('dm1', 'late', { at: '2026-10-31T00:00:00.000Z' }))
  advance(); expect(() => automatic.maintain()).not.toThrow()
  expect(automatic.status().owners.some(owner => owner.messages === 2)).toBe(true)
  expect(Date.parse(rows()[1]!.window.end) - Date.parse(rows()[1]!.window.start)).toBeLessThanOrEqual(7 * 86400000)
})

it('scans only bounded startup legacy pages, leaves exclusions untouched, and does not defer same-thread explicit work', () => {
  enabled = false
  for (let n = 0; n < 90; n++) engine.receive(make(`old${n}`, `old${n}`))
  engine.receive(make('explicit', 'old89', { addressed: 'mention' }))
  engine.receive(make('decided', 'decided')); store.triggers.saveDisposition('decided', { at: now, fanout: [], decisionId: 'prior-unavailable' })
  engine.receive(make('fanout', 'fanout')); store.triggers.saveDisposition('fanout', { at: now, fanout: ['ticket'] })
  engine.receive(make('evaluating', 'evaluating')); const thread = store.threads.get('im:evaluating')!; thread.evaluating = { id: 'existing', triggerIds: ['evaluating'], primary: 'evaluating', actor: { source: 'im', id: 'sender' }, strength: 'inferred', basis: { via: 'followup' }, threadKey: thread.key, policyVersion, startedAt: now, deadline: '2026-11-11T00:00:00.000Z' }; store.threads.save(thread)
  enabled = true; restartAutomatic(); automatic.maintain()
  expect(automatic.status().scan!.scanned).toBeGreaterThan(0); expect(automatic.status().scan!.scanned).toBeLessThanOrEqual(32)
  engine.evaluateDue(); expect(engine.candidate('explicit')!.triggers.map(item => item.id)).toEqual(['explicit'])
  expect(store.triggers.disposition('old89')!.evalId).toBeUndefined()
  for (let n = 0; n < 20 && !automatic.status().scan!.completedAt; n++) automatic.maintain()
  expect(automatic.status().scan!.completedAt).toBeTruthy()
  expect(store.triggers.disposition('old89')!.triage).toBeDefined()
  for (const id of ['decided', 'fanout', 'evaluating', 'explicit']) expect(store.triggers.disposition(id)!.triage).toBeUndefined()
  expect(automatic.status().scan!.highwater).toBe(94)
})

it('round-robins source/conversation and live/history without waiting for native context', async () => {
  for (const [chat, account, lane] of [['a','one','live'], ['b','one','live'], ['c','two','live'], ['d','two','historical']] as const) for (let n=0;n<16;n++) automatic.receive(make(`${chat}${n}`, chat, { meta: { chat, account }, ...(lane==='historical' ? { at:'2026-11-09T00:00:00.000Z' } : {}) }))
  const order: string[] = []
  for(let n=0;n<4;n++) { automatic.maintain(); const batch=rows().at(-1)!; order.push(batch.inputs[0]!.identity.conversation); await drain(); submit(rows().find(row => row.id === batch.id)!) }
  expect(new Set(order).size).toBeGreaterThanOrEqual(3); expect(order).toContain('d'); expect(order).toContain('c')
})

it('retains finite receipts and reports new late evidence, deduping native object/version replays', async () => {
  automatic.receive(make('a')); advance(); automatic.maintain(); await drain(); const batch=rows()[0]!
  const before=evidenceRevision(store,evidence(make('a'))!)
  automatic.receive(make('same-native','chat',{meta:{chat:'chat',message:'a',version:'v1'}}))
  expect(evidenceRevision(store,evidence(make('a'))!)).toBe(before)
  automatic.receive(make('late','chat',{at:'2026-11-01T00:00:00.000Z'}))
  expect(newerKnownEvidence(store,batch)).toBe(true)
  expect(submit(batch).state).toBe('completed'); expect(productionOverview(store,evidence).groups[0]!.newerKnownEvidence).toBe(true)
})

it('does not recapture or indefinitely defer explicit release/rollback after migration sweep', async () => {
  automatic.receive(make('released')); const owner=automatic.status().owners[0]!.owner; handoffs.release(owner,1)
  advance(61000); restartAutomatic(); automatic.maintain(); engine.evaluateDue()
  expect(store.triggers.disposition('released')!.triage).toBeUndefined(); expect(engine.candidate('released')).toBeDefined()
  automatic.receive(make('rollback','other')); advance(); automatic.maintain()
  const batch=rows()[0]!; production.rollback(batch.id,batch.generation)
  advance(61000); restartAutomatic(); automatic.maintain(); engine.evaluateDue()
  expect(store.triggers.disposition('rollback')!.triage).toBeUndefined(); expect(engine.candidate('rollback')).toBeDefined()
})

it('parks changed configuration with paginated recoverable owners, while pause alone preserves accumulation', async () => {
  automatic.receive(make('a')); store.saveSettings({...store.settings(),paused:true}); paused=true; advance(); automatic.maintain(); expect(rows()).toHaveLength(0)
  store.saveSettings({...store.settings(),paused:false}); paused=false; automatic.maintain(); expect(rows()).toHaveLength(1)
  await drain(); submit(rows()[0]!)
  automatic.receive(make('changed','changed')); configuration='other'; advance(); automatic.maintain()
  const status=automatic.status(); expect(status.owners[0]).toMatchObject({state:'blocked',messages:1})
  const tool=automaticTriageTools(automatic)[0]!; expect(JSON.stringify(tool)).not.toContain('private changed')
  expect(store.triggers.disposition('changed')!.triage).toBeDefined()
})

it('automatic opt-out fences queued production without affecting manually started production', async () => {
  automatic.receive(make('a')); advance(); automatic.maintain(); enabled=false; await drain()
  expect(deliver).not.toHaveBeenCalled(); expect(rows()[0]!.state).toBe('queued')
  expect(production.activeCount()).toBe(0); enabled=true; advance(10000); await effects.kick(); await effects.idle('triageAssessment')
  // Runtime Effects clock is real; explicit read still shows queued until due, with exclusive ownership preserved.
  expect(store.triggers.disposition('a')!.triage!.phase).toBe('production')
})

it('keeps an unfinished highwater immutable and protects disabled-period rows in the next epoch', () => {
  enabled=false; for(let n=0;n<80;n++) engine.receive(make(`old${n}`, `old${n}`))
  enabled=true; restartAutomatic(); automatic.maintain(); const initial=automatic.status().scan!
  expect(initial.cursor).toBeLessThan(initial.highwater)
  enabled=false; engine.receive(make('during-off','new')); enabled=true; restartAutomatic()
  expect(automatic.status().scan!.highwater).toBe(initial.highwater)
  expect(automatic.status().scan!.nextHighwater).toBe(initial.highwater+1)
  engine.evaluateDue(); expect(engine.candidate('during-off')).toBeUndefined()
  for(let n=0;n<30 && !store.triggers.disposition('during-off')!.triage;n++) automatic.maintain()
  expect(store.triggers.disposition('during-off')!.triage).toBeDefined()
})

it('leaves already decided and inactive evidence untouched across every migration sweep', () => {
  enabled=false
  for(const kind of ['ignore','unavailable'] as const) { const t=make(kind,kind); engine.receive(t); engine.decide(kind,{kind,reason:'Previous review'}) }
  engine.receive(make('prior-eval','prior-eval')); store.triggers.saveDisposition('prior-eval',{fanout:[],at:now,evalId:'formerly-owned'})
  enabled=true; restartAutomatic(); automatic.maintain(); advance(61000); automatic.maintain()
  for(const id of ['ignore','unavailable','prior-eval']) expect(store.triggers.disposition(id)!.triage).toBeUndefined()
  expect(automatic.status().scan!.captured).toBe(0)
})

it('exposes all blocked recovery owners through the actual status tool, including after opt-out', async () => {
  for(let n=0;n<55;n++) automatic.receive(make(`m${n}`,`chat${n}`))
  configuration='changed'; advance(); for(let n=0;n<55;n++) automatic.maintain()
  enabled=false
  const tool=automaticTriageTools(automatic)[0]!, signal=new AbortController().signal
  const first=await tool.execute({after:0},signal) as ReturnType<AutomaticTriage['status']>
  const next=await tool.execute({after:first.next!},signal) as ReturnType<AutomaticTriage['status']>
  expect(first.owners).toHaveLength(50); expect(next.owners).toHaveLength(5); expect(next.next).toBeNull()
  expect([...first.owners,...next.owners].every(owner=>owner.state==='blocked')).toBe(true)
  const released=handoffs.release(next.owners[0]!.owner,1); expect(store.triggers.disposition(released.inputs[0]!.triggerId)!.triage).toBeUndefined()
})

it('actual Runtime receive owns the first passive fragment before synchronous Passes evaluation', async () => {
  const { z } = await import('zod')
  const { startRuntime } = await import('./fixtures/host.ts')
  const h=await startRuntime(undefined,{triageAutomatic:true,triageHistorical:true,triageHandoff:true,triageProduction:true})
  try {
    const runtime=h.runtime
    runtime.sources.register({kind:'other-im',title:{en:'IM',zh:'IM'},description:{en:'IM',zh:'IM'},schema:z.object({}),fields:[],health:[],scope:()=>({listened:true,observed:true}),imEvidence:trigger=>({provider:'im',account:'owner',conversation:'chat',message:trigger.id,version:'1',partial:false})})
    const settings=runtime.store.settings()
    runtime.store.saveSettings({...settings,policy:{...settings.policy,sources:{...settings.policy.sources,'other-im':{allowed:[{id:'sender'}]}}}})
    const input:Trigger={id:'runtime-auto',source:'other-im',threads:[{source:'other-im',id:'chat'}],actor:{source:'other-im',id:'sender'},human:true,text:'private runtime evidence',at:new Date().toISOString(),meta:{}}
    expect(runtime.receive(input)).toBe('stored')
    expect(runtime.store.triggers.disposition(input.id)!.triage?.owner).toMatch(/^auto_/)
    expect(runtime.store.triggers.disposition(input.id)!.evalId).toBeUndefined()
    expect(runtime.engine.candidate(input.id)).toBeUndefined()
    const status=await h.runTool(runtime.masterId,'orchestrator_triage_automatic_status',{after:0})
    expect(status).toMatchObject({owners:[{messages:1,state:'open'}]})
    runtime.machine.triageAutomatic=false
    const disabled=await h.runTool(runtime.masterId,'orchestrator_triage_automatic_status',{after:0})
    expect(disabled.enabled).toBe(false)
    expect(JSON.stringify(disabled)).not.toContain('private runtime evidence')
  } finally {await h.stop()}
})

it('retains the active production reservation through opt-out so re-enable cannot exceed one active batch', async () => {
  automatic.receive(make('a')); advance(); automatic.maintain(); await drain(); const first=rows()[0]!
  enabled=false; production.maintain(); expect(production.activeCount()).toBe(1)
  engine.receive(make('manual','other')); const p=handoffs.preview(['manual']); handoffs.adopt('manual',['manual'],p.fingerprint)
  production.start('manual',1,{start:'2026-11-09T00:00:00.000Z',end:'2026-11-11T00:00:00.000Z'})
  await drain(); expect(rows().find(row=>row.owner==='manual')!.state).toBe('queued')
  expect(()=>production.read(first.id)).toThrow('disabled')
  enabled=true; production.maintain(); expect(production.activeCount()).toBe(1); submit(rows().find(row=>row.id===first.id)!)
})

it('reads a first-seen conversation with 24h lookback and later batches from its covered cursor', async () => {
  automatic.receive(make('a0', 'chatA', { at: '2026-11-10T11:00:00.000Z' }))
  advance(11_000); automatic.maintain(); await drain()
  const first = rows()[0]!
  expect(first.coverage).toMatchObject({ mode: 'initial', conversation: 'chatA' })
  expect(Date.parse(first.window.end) - Date.parse(first.window.start)).toBe(24 * 3_600_000 + 1000)
  submit(first)
  expect(readConversationCursor(store, evidence(make('a0', 'chatA'))!)!.through).toBe(first.coverage!.to)
  advance(30 * 60_000)
  automatic.receive(make('a1', 'chatA', { at: now }))
  advance(11_000); automatic.maintain(); await drain()
  const second = rows().find(row => row.inputs.some(input => input.triggerId === 'a1'))!
  expect(second.coverage).toMatchObject({ mode: 'incremental', previous: first.coverage!.to })
  expect(Date.parse(second.window.start)).toBe(Date.parse(first.coverage!.to) - 120_000)
  expect(Date.parse(second.window.end) - Date.parse(second.window.start)).toBeLessThan(2 * 60 * 60_000)
  submit(second)
  expect(readConversationCursor(store, evidence(make('a1', 'chatA'))!)!.through).toBe(second.coverage!.to)
})

it('does not advance coverage on rollback and re-reads a covered-message edit as one anchor', async () => {
  automatic.receive(make('a0', 'chatA', { at: '2026-11-10T11:00:00.000Z' }))
  advance(11_000); automatic.maintain(); await drain()
  const first = rows()[0]!
  production.rollback(first.id, first.generation)
  expect(readConversationCursor(store, evidence(make('a0', 'chatA'))!)).toBeUndefined()
  automatic.receive(make('a1', 'chatA', { at: now }))
  advance(11_000); automatic.maintain(); await drain()
  const second = rows().find(row => row.state === 'awaiting')!
  expect(second.coverage).toMatchObject({ mode: 'initial' })
  submit(second)
  const covered = readConversationCursor(store, evidence(make('a1', 'chatA'))!)!.through
  automatic.receive(make('a0-edit', 'chatA', { at: '2026-11-10T10:59:00.000Z',
    meta: { chat: 'chatA', message: 'a0', version: 'v2' } }))
  advance(11_000); automatic.maintain(); await drain()
  const change = rows().find(row => row.inputs.some(input => input.triggerId === 'a0-edit'))!
  expect(change.coverage).toMatchObject({ mode: 'change', changeTriggerIds: ['a0-edit'] })
  expect(Date.parse(change.window.end) - Date.parse(change.window.start)).toBe(120_000 + 1000)
  submit(change)
  expect(readConversationCursor(store, evidence(make('a1', 'chatA'))!)!.through).toBe(covered)
})

it('splits newer inputs so a capped incremental window still contains every member', async () => {
  now = '2026-11-01T12:00:00.000Z'
  automatic.receive(make('a0', 'chatA', { at: '2026-11-01T11:00:00.000Z' }))
  advance(11_000); automatic.maintain(); await drain()
  submit(rows()[0]!)
  now = '2026-11-06T12:00:00.000Z'
  automatic.receive(make('n2', 'chatA', { at: '2026-11-02T00:00:00.000Z' }))
  automatic.receive(make('n5', 'chatA', { at: '2026-11-05T00:00:00.000Z' }))
  advance(11_000); automatic.maintain()
  const split = rows().filter(row => row.inputs.some(input => ['n2', 'n5'].includes(input.triggerId)))
  expect(split).toHaveLength(2)
  for (const batch of split) {
    expect(batch.inputs).toHaveLength(1)
    const input = batch.inputs[0]!, at = Date.parse(store.triggers.get(input.triggerId)!.at)
    expect(at).toBeGreaterThanOrEqual(Date.parse(batch.window.start))
    expect(at).toBeLessThan(Date.parse(batch.window.end))
  }
})

it('keeps behind-cursor plans bounded instead of spanning the whole late backlog', async () => {
  automatic.receive(make('a0', 'chatA', { at: '2026-11-06T11:00:00.000Z' }))
  advance(11_000); automatic.maintain(); await drain()
  submit(rows()[0]!)
  automatic.receive(make('b2', 'chatA', { at: '2026-11-02T00:00:00.000Z' }))
  automatic.receive(make('b5', 'chatA', { at: '2026-11-05T00:00:00.000Z' }))
  advance(11_000); automatic.maintain()
  const changes = rows().filter(row => row.inputs.some(input => ['b2', 'b5'].includes(input.triggerId)))
  expect(changes).toHaveLength(2)
  expect(changes.every(batch => batch.inputs.length === 1 && batch.coverage!.mode === 'change')).toBe(true)
  for (const batch of changes) expect(Date.parse(batch.window.end) - Date.parse(batch.window.start)).toBe(120_000 + 1000)
})

it('recovers bounded blocked groups through explicit main tool with all-or-nothing generation fencing', async () => {
  automatic.receive(make('a','a')); automatic.receive(make('b','b')); configuration='changed'; advance(); automatic.maintain(); automatic.maintain()
  const owners=automatic.status().owners.map(({owner,generation})=>({owner,generation}))
  const tool=automaticTriageTools(automatic).find(item=>item.name.endsWith('_recover'))!, signal=new AbortController().signal
  await expect(tool.execute({owners:[owners[0]!,{...owners[1]!,generation:2}],action:'release'},signal)).rejects.toThrow('Owner')
  expect(store.triggers.disposition('a')!.triage).toBeDefined()
  await tool.execute({owners,action:'retry'},signal); expect(automatic.status().owners.every(owner=>owner.state==='sealed')).toBe(true)
  automatic.maintain(); await drain(); expect(rows()[0]!.state).toBe('awaiting')
})
