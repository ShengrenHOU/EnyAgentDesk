import type { Context } from '@deepseek-ai/cordis'
/** Activity intake exercises real durable Engine subscriptions, with only external readers replaced. */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Engine, key, type Ticket, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf } from '../src/app/source-context.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { ActivityConfigSchema, activityState, activityTrigger, createActivityKind, scanActivityRound, runActivity, apply, type ActivityConfig, type ActivitySourceBindings } from '../src/sources/activity.ts'
import type { ActivityEvent, ActivityReaderContext, ActivityScan, ActivityTools } from '../src/sources/activity-types.ts'
import { scanLarkMessages, scanLarkDocuments, readLarkActivityContext } from '../src/sources/activity-lark.ts'
import { scanWechatActivity, readWechatActivityContext } from '../src/sources/activity-wechat.ts'
import { imDedupKey, imMessageId, imObjectId } from '../src/sources/im-identity.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { workbenchKind } from '../src/sources/workbench.ts'
import { KV } from '../src/kv.ts'
import { queueLarkEvent, pendingLarkEvents, requestLarkReconcile, larkReconcileToken } from '../src/sources/lark-event-inbox.ts'
import { documentEventChanges } from '../src/sources/document-events.ts'

vi.mock('../src/sources/activity-lark.ts', () => ({ scanLarkMessages: vi.fn(), scanLarkDocuments: vi.fn(), readLarkActivityContext: vi.fn(),
  readLarkImContext: vi.fn(), readLarkWindow: vi.fn(), resolveLarkConversation: vi.fn() }))
vi.mock('../src/sources/activity-wechat.ts', () => ({ scanWechatActivity: vi.fn(), readWechatActivityContext: vi.fn(),
  readWechatImContext: vi.fn(), readWechatWindow: vi.fn() }))

const bindings: ActivitySourceBindings = { ownerChatId: 'oc_private', lark: { expectedUserId: 'ou_owner', configDir: '/private/user-config' }, wechat: { serverName: 'wechat_readonly' } }
const tools: ActivityTools = { schemas: vi.fn(() => []), execute: vi.fn<ActivityTools['execute']>() }
const complete: ActivityScan = { complete: true, objects: 1, records: 0 }
const thread = 'activity:monitor:monitor:monitor'
let directory: string
let store: Store
let clock: number
const iso = () => new Date(clock).toISOString()
const config = (overrides: Partial<ActivityConfig> = {}) => ActivityConfigSchema.parse({ ticketId: 'monitor', ...overrides })
const ticket = (id = 'monitor'): Ticket => ({ id, title: 'Monitor recent communications', decisionId: 'decision',
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'addressed', source: 'feishu',
    scope: { chatId: 'oc_private', direct: false }, addressed: 'mention' }, actor: { source: 'feishu', id: 'ou_owner' }, scope: 'Read and triage recent activity' },
  channels: [], assignments: [{ id: `assignment-${id}`, state: 'running', createdAt: iso() }], inputs: [], undelivered: [],
  createdAt: iso(), updatedAt: iso(), origin: { triggerId: 'owner-request', triggerIds: ['owner-request'] } })
const event = (overrides: Partial<ActivityEvent> = {}): ActivityEvent => ({ provider: 'feishu-messages', accountId: 'ou_owner',
  objectId: 'oc_business', id: 'om_update', version: 'v1', at: iso(), text: 'Please send the signed contract tomorrow', reference: 'original message om_update',
  locator: { provider: 'feishu-messages', chatId: 'oc_business', messageId: 'om_update' }, senderId: 'third-party', ...overrides })

function saveConfig(value: ActivityConfig, enabled = true) {
  store.saveSettings({ ...store.settings(), sources: { ...store.settings().sources, activity: { enabled, config: value } } })
}
function host(register = true) {
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(feishuKind)
  if (register) sources.register(createActivityKind(bindings, tools))
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: message => store.receipts.add(message), status: () => undefined, withdraw: () => {} }, now: iso })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  vi.spyOn(commands, 'withSignal').mockReturnValue(commands)
  vi.spyOn(commands, 'lark').mockResolvedValue({ users: [{ member_id: 'ou_owner' }], bots: [{ member_id: 'ou_bot', app_id: 'cli_bot' }], has_more: false, truncations: [], user_total: 1, bot_total: 1 })
  const receive = vi.fn((trigger: Trigger) => engine.receive(trigger))
  const deps = { store, engine, sources, commands, receive, deployment: testDeployment(), ready: Promise.resolve(), configured: () => true,
    outbox: { send: (message: Parameters<typeof store.receipts.add>[0]) => { store.receipts.add(message) } } }
  const context = (kind = createActivityKind(bindings, tools)) => sourceContextOf(deps, kind)
  const ctx = context()
  return { board, sources, engine, receive, context, ctx,
    scan: (signal = new AbortController().signal) => scanActivityRound(ctx, bindings, tools, signal, () => clock) }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'activity-source-'))
  store = new Store(join(directory, 'state.sqlite'))
  clock = Date.parse('2026-11-04T10:00:00Z')
  store.saveSettings(SettingsSchema.parse({ eval: { mode: 'observe' }, policy: { sources: { feishu: { allowed: [{ id: 'ou_owner' }] } } },
    sources: { feishu: { enabled: true, config: { chats: [{ chatId: 'oc_private', listen: 'mentions' }] } },
      activity: { enabled: true, config: config() } } }))
  store.tickets.save(ticket())
  store.triggers.save({ id: 'owner-request', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_private:om_owner' }],
    actor: { source: 'feishu', id: 'ou_owner' }, human: true, addressed: 'mention', at: iso(), text: 'Monitor my recent activity',
    channel: { source: 'feishu', thread: 'feishu:oc_private:om_owner', address: { chatId: 'oc_private', messageId: 'om_owner' } }, meta: {} })
  vi.mocked(scanLarkMessages).mockReset().mockResolvedValue(complete)
  vi.mocked(scanLarkDocuments).mockReset().mockResolvedValue(complete)
  vi.mocked(scanWechatActivity).mockReset().mockResolvedValue(complete)
  vi.mocked(readLarkActivityContext).mockReset()
  vi.mocked(readWechatActivityContext).mockReset()
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('keeps WeChat on its independent interval while Feishu readers continue', async () => {
  const h = host()
  saveConfig(config({ wechatPollSeconds: 1200 }))
  await h.scan()
  expect(scanWechatActivity).toHaveBeenCalledTimes(1)
  clock += 120_000
  await h.scan()
  expect(scanLarkMessages).toHaveBeenCalledTimes(2)
  expect(scanLarkDocuments).toHaveBeenCalledTimes(2)
  expect(scanWechatActivity).toHaveBeenCalledTimes(1)
  clock += 1_080_000
  await h.scan()
  expect(scanWechatActivity).toHaveBeenCalledTimes(2)
})

it('coalesces watched document notifications, validates native identity and confirms after intake', async () => {
  const h = host()
  const watched = config({ documentEvents: true, watchedDocuments: [{ token: 'doc-one', type: 'docx', url: 'https://example.feishu.cn/docx/doc-one', name: 'Project plan' }] })
  saveConfig(watched)
  for (const id of ['edit-one', 'edit-two']) queueLarkEvent(h.ctx, bindings.lark.expectedUserId, 'documents', {
    eventType: 'drive.file.edit_v1', eventId: id,
    at: '1794500000000', payload: { file_token: 'doc-one', file_type: 'docx' } })
  const run = vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_cli, args) => JSON.stringify(args[0] === 'auth'
    ? { identities: { user: { status: 'ready', openId: bindings.lark.expectedUserId } } }
    : { ok: true, identity: 'user', data: { document: { document_id: 'doc-one', revision_id: 3, content: 'Changed project plan' } } }))
  const changes = await documentEventChanges(h.ctx, bindings.lark, watched, new AbortController().signal)
  expect(changes.events).toMatchObject([{ version: key('revision:3', 'Changed project plan'), text: 'Changed project plan', label: 'Project plan' }])
  expect(run.mock.calls.filter(([, args]) => args.includes('+fetch'))).toHaveLength(1)
  expect(pendingLarkEvents(h.ctx, bindings.lark.expectedUserId, 'documents')).toHaveLength(2)
  changes.confirm()
  expect(pendingLarkEvents(h.ctx, bindings.lark.expectedUserId, 'documents')).toEqual([])
})

it('keeps the other readers running when a retained document notification cannot be read', async () => {
  const h = host()
  saveConfig(config({ documentEvents: true, watchedDocuments: [{ token: 'doc-one', type: 'docx', url: 'https://example.feishu.cn/docx/doc-one', name: 'Project plan' }] }))
  queueLarkEvent(h.ctx, bindings.lark.expectedUserId, 'documents', {
    eventType: 'drive.file.edit_v1', eventId: 'edit-one',
    at: '1794500000000', payload: { file_token: 'doc-one', file_type: 'docx' } })
  let fail = true
  vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_cli, args) => JSON.stringify(args[0] === 'auth'
    ? { identities: { user: { status: 'ready', openId: bindings.lark.expectedUserId } } }
    : fail ? { ok: false, identity: 'user', error: { code: 1061004, type: 'forbidden' } }
      : { ok: true, identity: 'user', data: { document: { document_id: 'doc-one', revision_id: 4, content: 'Changed project plan' } } }))
  await h.scan()
  expect(scanWechatActivity).toHaveBeenCalledOnce()
  expect(store.get(activityState.progress('monitor', 'monitor', 'feishu-documents')))
    .toMatchObject({ failures: 1, error: expect.stringContaining('forbidden') })
  expect(pendingLarkEvents(h.ctx, bindings.lark.expectedUserId, 'documents')).toHaveLength(1)
  fail = false
  clock += 120_000
  await h.scan()
  expect(pendingLarkEvents(h.ctx, bindings.lark.expectedUserId, 'documents')).toEqual([])
  expect(h.receive.mock.calls.some(([trigger]) => (trigger.meta.activity as { provider?: string } | undefined)?.provider === 'feishu-documents')).toBe(true)
})

it('accepts a native owner monitor and delivers reader failures to that discussion without requiring a Feishu bot audience', async () => {
  const h = host()
  h.sources.register(workbenchKind)
  store.saveSettings({ ...store.settings(), sources: { ...store.settings().sources, workbench: { enabled: true, config: { ownerId: 'native-owner' } } } })
  const monitored = ticket()
  monitored.mandate.actor = { source: 'workbench', id: 'native-owner' }
  store.tickets.save(monitored)
  const origin = store.triggers.get('owner-request')!
  store.triggers.save({ ...origin, source: 'workbench', actor: monitored.mandate.actor,
    channel: { source: 'workbench', thread: 'native-thread', address: { ownerId: 'native-owner', sessionId: 'discussion' } } })
  saveConfig(config({ failuresBeforeError: 1 }))
  vi.mocked(scanLarkMessages).mockRejectedValue(new Error('Reader unavailable'))
  await h.scan()
  expect(h.ctx.commands.lark).not.toHaveBeenCalled()
  expect(scanWechatActivity).toHaveBeenCalledOnce()
  expect(store.receipts.waiting()).toEqual(expect.arrayContaining([expect.objectContaining({
    channel: expect.objectContaining({ source: 'workbench' }),
  })]))
  const calls = vi.mocked(scanWechatActivity).mock.calls.length
  store.saveSettings({ ...store.settings(), sources: { ...store.settings().sources, workbench: { enabled: false, config: { ownerId: 'native-owner' } } } })
  clock += 130_000
  await h.scan()
  expect(scanWechatActivity).toHaveBeenCalledTimes(calls)
})

it('reconciles watched documents after reconnect without waiting for the daily deadline', async () => {
  const h = host()
  saveConfig(config({ feishuMessages: false, wechat: false, documentEvents: true }))
  await h.scan()
  await h.scan()
  expect(scanLarkDocuments).toHaveBeenCalledOnce()
  requestLarkReconcile(h.ctx, bindings.lark.expectedUserId, 'documents')
  await h.scan()
  expect(scanLarkDocuments).toHaveBeenCalledTimes(2)
  expect(larkReconcileToken(h.ctx, bindings.lark.expectedUserId, 'documents')).toBeUndefined()
})

it('retains a newer WeChat wake arriving during an incremental scan', async () => {
  const h = host()
  saveConfig(config({ feishuMessages: false, feishuDocuments: false, wechatNotifications: true, wechatPollSeconds: 1200 }))
  const wakeKey = activityState.wechatWake('monitor', 'monitor')
  store.set(wakeKey, { token: 'first', at: iso() })
  vi.mocked(scanWechatActivity).mockImplementationOnce(async () => {
    store.set(wakeKey, { token: 'newer', at: iso() })
    return complete
  })
  await h.scan()
  expect(store.get(wakeKey)?.token).toBe('newer')
  await h.scan()
  expect(scanWechatActivity).toHaveBeenCalledTimes(2)
  expect(store.get(wakeKey)).toBeUndefined()
})

it('collects without a monitoring ticket, routes independent goals, and survives unrelated project stops', async () => {
  const h = host()
  h.sources.register(workbenchKind)
  h.ctx.state.set(KV.runtime.masterId, 'owner-session')
  saveConfig(config({ ticketId: '', collectionId: 'personal-updates', routing: 'tasks' }))
  const settings = store.settings()
  store.saveSettings({ ...settings, sources: { ...settings.sources, workbench: { enabled: true, config: { ownerId: 'native-owner' } } },
    eval: { ...settings.eval, mode: 'auto' }, policy: { ...settings.policy,
    rules: [{ id: 'follow', name: 'Read-only follow-up', enabled: true, instruction: 'Track meaningful owner business evidence without external writes.' }],
    sources: { ...settings.policy.sources, activity: { allowed: [], admission: { updates: { unlistedUnaddressed: 'inferred' } } } },
  } })
  h.engine.bindThread('monitor', { source: 'activity', id: 'monitor:monitor:monitor' }, true)
  const unchanged = store.tickets.get('monitor')
  const first = event({ id: 'msg-a', threadId: 'matter-a' })
  const second = event({ id: 'msg-b', threadId: 'matter-b' })
  vi.mocked(scanLarkMessages).mockImplementation(async reader => { await reader.emit(first); await reader.emit(second); return { ...complete, records: 2 } })
  await h.scan()
  h.engine.evaluateDue()
  const received = h.receive.mock.calls.map(([value]) => value)
  expect(received).toHaveLength(2)
  expect(received[0]!.threads).not.toEqual(received[1]!.threads)
  expect(received.every(value => value.human === false && value.channel?.source === 'workbench')).toBe(true)
  expect(store.tickets.get('monitor')).toEqual(unchanged)
  const accepted = received.map((value, index) => h.engine.decide(value.id, { kind: 'accept', title: `Matter ${index}`, scope: 'Read-only follow-up', rules: ['follow'], reason: 'Owner standing rule' }))
  expect(accepted.every(value => value.kind === 'accept')).toBe(true)
  h.engine.report(accepted[0]!.ticketId!, { state: 'ready', summary: 'First matter delivered' })
  expect(store.tickets.get(accepted[0]!.ticketId!)!.ended?.outcome).toBe('completed')
  expect(store.tickets.get(accepted[1]!.ticketId!)!.ended).toBeUndefined()
  store.tickets.save({ ...ticket(), ended: { at: iso(), by: 'human', outcome: 'stopped' } })
  clock += 130_000
  await h.scan()
  expect(scanWechatActivity).toHaveBeenCalledTimes(2)
  expect(h.board.all.activity?.state).toBe('ready')
})

it('preserves event IDs, checkpoints, scope and acknowledgement identity when the old ticket namespace becomes source configuration', async () => {
  const h = host()
  h.sources.register(workbenchKind)
  h.ctx.state.set(KV.runtime.masterId, 'owner-session')
  store.saveSettings({ ...store.settings(), sources: { ...store.settings().sources,
    workbench: { enabled: true, config: { ownerId: 'native-owner' } } } })
  const old = config({ routing: 'tasks', activationId: 'generation' })
  const migrated = config({ ticketId: '', collectionId: old.ticketId, routing: 'tasks', activationId: old.activationId })
  expect(activityTrigger(event(), old).id).toBe(activityTrigger(event(), migrated).id)
  const oldEvent = activityTrigger(event(), old)
  delete oldEvent.meta.collectionId
  oldEvent.meta.monitorTicketId = old.ticketId
  expect(createActivityKind(bindings, tools).scope?.(oldEvent, migrated)?.listened).toBe(true)
  saveConfig(old)
  await h.scan()
  const consumer = vi.mocked(scanWechatActivity).mock.calls[0]![0].consumerId
  const checkpoint = h.ctx.state.get(activityState.progress('monitor', 'generation', 'wechat'))
  saveConfig(migrated)
  await h.scan()
  expect(scanWechatActivity).toHaveBeenCalledOnce()
  expect(h.ctx.state.get(activityState.progress('monitor', 'generation', 'wechat'))).toEqual(checkpoint)
  clock += 130_000
  await h.scan()
  expect(vi.mocked(scanWechatActivity).mock.calls[1]![0].consumerId).toBe(consumer)
  expect(h.board.all.activity?.state).toBe('ready')
})

it('limits discovery to recent ranges and rejects unknown credential/settings fields', () => {
  expect(config()).toMatchObject({ pollSeconds: 120, lookbackHours: 24, overlapSeconds: 120, activationId: '' })
  expect(ActivityConfigSchema.safeParse({ lookbackHours: 10000 }).success).toBe(false)
  expect(ActivityConfigSchema.safeParse({ token: 'forbidden' }).success).toBe(false)
})

it('keeps source-native versions stable without turning third-party words into a human request', () => {
  const first = activityTrigger(event(), config())
  expect(first.id).toBe(activityTrigger(event(), config()).id)
  expect(first.id).not.toBe(activityTrigger(event({ version: 'v2' }), config()).id)
  expect(first.id).not.toBe(activityTrigger(event(), config({ activationId: 'new' })).id)
  expect(first).toMatchObject({ human: false, actor: { source: 'activity', id: '' }, threads: [{ source: 'activity', id: 'monitor:monitor:monitor' }],
    meta: { activity: { senderId: 'third-party', objectId: 'oc_business' } } })
  expect(first).not.toHaveProperty('addressed')
  expect(first).not.toHaveProperty('channel')
})

it('records canonical IM identity in trigger metadata without changing the trigger identity', () => {
  const first = activityTrigger(event(), config())
  expect(first.meta.im).toEqual({ object_id: imObjectId({ provider: 'feishu-messages', conversation: 'oc_business' }),
    message_key: imMessageId({ provider: 'feishu-messages', conversation: 'oc_business' }, 'om_update'),
    dedup_key: imDedupKey({ provider: 'feishu-messages', conversation: 'oc_business' }, 'om_update', 'v1') })
  const wechat = activityTrigger(event({ provider: 'wechat', accountId: 'wx-account', objectId: 'wx-chat', id: 'wxe_event',
    locator: { provider: 'wechat', contact: 'wx-chat', messageRef: 'wx1.one', start: iso(), end: iso() } }), config())
  expect(wechat.meta.im).toEqual({ object_id: imObjectId({ provider: 'wechat', conversation: 'wx-chat' }),
    message_key: imMessageId({ provider: 'wechat', conversation: 'wx-chat' }, 'wx1.one'),
    dedup_key: imDedupKey({ provider: 'wechat', conversation: 'wx-chat' }, 'wx1.one', 'v1') })
  const document = activityTrigger(event({ provider: 'feishu-documents', objectId: 'docx:doc',
    locator: { provider: 'feishu-documents', token: 'doc', type: 'docx', url: 'https://example.com/doc' } }), config())
  expect(document.meta.im).toBeUndefined()
})

it('binds one own monitor thread and fans observations only into that ticket, without automatic source replies', async () => {
  const h = host()
  store.tickets.save(ticket('business'))
  h.engine.bindThread('business', { source: 'feishu', id: 'oc_business:om_root' }, true)
  vi.mocked(scanLarkMessages).mockImplementation(async ctx => { await ctx.emit(event()); return { ...complete, records: 1 } })
  await h.scan()
  expect(store.threads.get(thread)?.subscriptions).toEqual(['monitor'])
  expect(store.tickets.get('monitor')?.follows).toEqual([{ thread, own: true }])
  expect(store.tickets.get('monitor')?.inputs.filter(input => input.kind === 'trigger')).toHaveLength(1)
  expect(store.tickets.get('business')?.inputs).toEqual([])
  expect(store.receipts.waiting()).toEqual([])
  h.engine.report('monitor', { state: 'ready', summary: 'Useful update delivered' })
  expect(store.tickets.get('monitor')?.ended).toBeUndefined()
  expect(scanLarkMessages).toHaveBeenCalledWith(expect.anything(), bindings.lark, { start: '2026-11-03T10:00:00.000Z', end: iso() },
    { alertChats: [], severities: ['警告', '严重', '恢复'] })
  expect(h.board.all['activity:feishu-messages']?.detail).toContain('changes 1')
})

it('passes the configured alert chat and severity list to the Feishu scan', async () => {
  saveConfig(config({ alertChatId: 'oc_alerts', alertSeverities: '警告，严重' }))
  await host().scan()
  expect(scanLarkMessages).toHaveBeenCalledWith(expect.anything(), bindings.lark, expect.anything(),
    { alertChats: ['oc_alerts'], severities: ['警告', '严重'] })
})

it('retains provider watermarks and deduplicates replay through an actual Store restart', async () => {
  vi.mocked(scanLarkMessages).mockImplementation(async ctx => { await ctx.emit(event()); return { ...complete, records: 1 } })
  const first = host()
  await first.scan()
  const before = store.tickets.get('monitor')?.inputs.length
  store.close()
  store = new Store(join(directory, 'state.sqlite'))
  clock += 120_000
  await host().scan()
  expect(store.tickets.get('monitor')?.inputs).toHaveLength(before!)
  expect(scanLarkMessages).toHaveBeenLastCalledWith(expect.anything(), bindings.lark, { start: '2026-11-04T09:58:00.000Z', end: iso() },
    { alertChats: [], severities: ['警告', '严重', '恢复'] })
  expect(store.get(activityState.progress('monitor', 'monitor', 'feishu-messages'))).toMatchObject({ since: iso(), changes: 0 })
})

it('does not read or move a checkpoint while the parent is paused or manually stopped', async () => {
  const h = host()
  store.tickets.save({ ...ticket(), paused: true })
  await h.scan()
  expect(scanLarkMessages).not.toHaveBeenCalled()
  expect(store.get(activityState.bound('monitor', 'monitor'))).toBeUndefined()
  store.tickets.save(ticket())
  await h.scan()
  const progress = store.get(activityState.progress('monitor', 'monitor', 'wechat'))
  h.engine.stopTicket('monitor')
  clock += 120_000
  await h.scan()
  expect(scanWechatActivity).toHaveBeenCalledOnce()
  expect(store.get(activityState.progress('monitor', 'monitor', 'wechat'))).toEqual(progress)
  expect(h.board.all.activity).toMatchObject({ state: 'paused' })
})

it('preserves withdrawn subscriptions across restart until an explicit new generation', async () => {
  const h = host()
  await h.scan()
  h.engine.unsubscribe(thread)
  clock += 120_000
  const restored = host()
  await restored.scan()
  expect(scanLarkMessages).toHaveBeenCalledOnce()
  expect(store.threads.get(thread)?.subscriptions).toEqual([])
  saveConfig(config({ activationId: 'next' }))
  await restored.scan()
  expect(scanLarkMessages).toHaveBeenCalledTimes(2)
  expect(store.threads.get('activity:monitor:monitor:next')?.subscriptions).toEqual(['monitor'])
  expect(store.get(activityState.bound('monitor', 'next'))).toBeDefined()
})

it('holds reads for an owner mismatch and when the Source is disabled', async () => {
  const h = host()
  const wrong = ticket(); wrong.mandate.actor.id = 'ou_someone_else'; store.tickets.save(wrong)
  await h.scan()
  expect(scanLarkMessages).not.toHaveBeenCalled()
  store.tickets.save(ticket())
  saveConfig(config(), false)
  await h.scan()
  expect(scanLarkMessages).not.toHaveBeenCalled()
  expect(store.get(activityState.progress('monitor', 'monitor', 'wechat'))).toBeUndefined()
})

it('holds all source reads when the owner control chat has additional people or an incomplete member list', async () => {
  const h = host()
  vi.mocked(h.ctx.commands.lark).mockResolvedValue({ users: [{ member_id: 'ou_owner' }, { member_id: 'ou_other' }],
    bots: [{ member_id: 'ou_bot' }], has_more: false, truncations: [] })
  await h.scan()
  expect(scanLarkMessages).not.toHaveBeenCalled()
  expect(scanWechatActivity).not.toHaveBeenCalled()
  expect(store.get(activityState.bound('monitor', 'monitor'))).toBeUndefined()
  expect(h.board.all.activity).toMatchObject({ state: 'paused', detail: expect.stringContaining('audience') })
  vi.mocked(h.ctx.commands.lark).mockResolvedValue({ users: [{ member_id: 'ou_owner' }], bots: [{ member_id: 'ou_bot' }],
    has_more: false, truncations: [{ member_type: 'user' }] })
  await h.scan()
  expect(scanLarkMessages).not.toHaveBeenCalled()
})

it('refuses a monitoring ticket originating in a different chat, even if its requester is the owner', async () => {
  const h = host()
  const origin = store.triggers.get('owner-request')!
  store.triggers.save({ ...origin, channel: { ...origin.channel!, address: { chatId: 'oc_business', messageId: 'om_owner' } } })
  await h.scan()
  expect(scanLarkMessages).not.toHaveBeenCalled()
  expect(h.board.all.activity).toMatchObject({ state: 'paused', detail: expect.stringContaining('owner-only') })
})

it('rechecks the private audience at outbound delivery and does not change other chats', async () => {
  const h = host()
  const kind = h.sources.kind('activity')!
  expect(kind.threadContext!.messageId(activityTrigger(event(), config()))).toBe('om_update')
  expect(kind.threadContext!.messageId(activityTrigger(event({ provider: 'wechat', id: 'event-hash', reference: 'native-message',
    locator: { provider: 'wechat', contact: 'peer', messageRef: 'native-message', start: iso(), end: iso() } }), config()))).toBe('native-message')
  const message = { id: 'health', kind: 'notice' as const, text: 'Needs attention',
    channel: { source: 'feishu', thread: 'control', address: { chatId: 'oc_private', messageId: 'om_owner' } } }
  await kind.guardOutbound!(h.ctx.commands, message, config())
  vi.mocked(h.ctx.commands.lark).mockResolvedValue({ users: [{ member_id: 'ou_owner' }, { member_id: 'ou_other' }],
    bots: [{ member_id: 'ou_bot' }], has_more: false, truncations: [] })
  await expect(kind.guardOutbound!(h.ctx.commands, message, config())).rejects.toThrow('audience')
  const calls = vi.mocked(h.ctx.commands.lark).mock.calls.length
  await kind.guardOutbound!(h.ctx.commands, { ...message, channel: { ...message.channel, address: { chatId: 'oc_other' } } }, config())
  expect(h.ctx.commands.lark).toHaveBeenCalledTimes(calls)
})

it('retains the failed provider range while other providers advance, then retries the same range', async () => {
  const h = host()
  vi.mocked(scanLarkMessages).mockResolvedValueOnce({ complete: false, records: 2, objects: 1, detail: 'More pages remain' })
  await h.scan()
  const pending = store.get(activityState.progress('monitor', 'monitor', 'feishu-messages'))!
  expect(pending.since).toBeUndefined()
  expect(pending.pending).toEqual({ start: '2026-11-03T10:00:00.000Z', end: iso() })
  expect(store.get(activityState.progress('monitor', 'monitor', 'wechat'))?.since).toBe(iso())
  clock += 120_000
  await h.scan()
  expect(scanLarkMessages).toHaveBeenLastCalledWith(expect.anything(), bindings.lark, pending.pending,
    { alertChats: [], severities: ['警告', '严重', '恢复'] })
  expect(store.get(activityState.progress('monitor', 'monitor', 'feishu-messages'))).toMatchObject({ since: pending.pending!.end, failures: 0 })
})

it('propagates a filtered emit into provider failure and never reaches its batch acknowledgement', async () => {
  const h = host()
  const acknowledged = vi.fn()
  h.receive.mockReturnValueOnce('filtered')
  vi.mocked(scanLarkMessages).mockImplementation(async ctx => {
    await ctx.emit(event())
    ctx.assertActive(); acknowledged()
    return complete
  })
  await h.scan()
  expect(acknowledged).not.toHaveBeenCalled()
  expect(store.get(activityState.progress('monitor', 'monitor', 'feishu-messages'))).toMatchObject({ failures: 1, error: expect.stringContaining('filtered') })
  expect(store.get(activityState.progress('monitor', 'monitor', 'feishu-messages'))?.since).toBeUndefined()
})

it.each(['pause', 'disable', 'change', 'unsubscribe'] as const)('checks a %s before emitting or acknowledging an in-flight read', async action => {
  const h = host()
  const acknowledged = vi.fn()
  vi.mocked(scanLarkMessages).mockImplementation(async ctx => {
    if (action === 'pause') store.tickets.save({ ...store.tickets.get('monitor')!, paused: true })
    else if (action === 'disable') saveConfig(config(), false)
    else if (action === 'change') saveConfig(config({ activationId: 'next' }))
    else h.engine.unsubscribe(thread)
    await ctx.emit(event())
    acknowledged()
    return complete
  })
  await h.scan()
  expect(h.receive).not.toHaveBeenCalled()
  expect(acknowledged).not.toHaveBeenCalled()
  expect(store.get(activityState.progress('monitor', 'monitor', 'feishu-messages'))?.since).toBeUndefined()
  expect(scanWechatActivity).not.toHaveBeenCalled()
})

it('queues one sustained-failure notice and one recovery only to the owner control topic, while normal polls stay quiet', async () => {
  const h = host()
  vi.mocked(scanLarkMessages).mockRejectedValue(new Error('Reader connection unavailable'))
  for (let count = 0; count < 4; count++) { await h.scan(); clock += 120_000 }
  const notices = store.receipts.waiting()
  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatchObject({ ticketId: 'monitor', kind: 'notice', channel: { source: 'feishu', address: { chatId: 'oc_private', messageId: 'om_owner' } } })
  vi.mocked(scanLarkMessages).mockResolvedValue(complete)
  await h.scan(); clock += 120_000; await h.scan()
  expect(store.receipts.waiting()).toHaveLength(2)
  expect(h.board.all.activity?.state).toBe('ready')
})

it('dispatches original-context reads by their persisted locator and refuses disabled or malformed readers', async () => {
  const h = host()
  const kind = h.sources.kind('activity')!
  vi.mocked(readLarkActivityContext).mockResolvedValue({ messages: [], body: { original: true } })
  await kind.threadContext!.read(h.ctx.commands, activityTrigger(event(), config()), 'thread', undefined, config())
  expect(readLarkActivityContext).toHaveBeenCalledWith(h.ctx.commands, bindings.lark, event(), 'thread', undefined)
  await expect(kind.threadContext!.read(h.ctx.commands, activityTrigger(event(), config()), 'thread', undefined,
    config({ feishuMessages: false }))).rejects.toThrow('disabled')
  const malformed = activityTrigger(event(), config()); malformed.meta.activity = { provider: 'other' }
  await expect(kind.threadContext!.read(h.ctx.commands, malformed, 'thread', undefined, config())).rejects.toThrow()
})

it('uses the host Source lifecycle and denies model-owned consumption acknowledgements', async () => {
  const h = host(false)
  const disposers: (() => unknown)[] = []
  const guard = vi.fn<Context['tools']['guard']>().mockReturnValue(() => {})
  const runSource = vi.fn(() => async () => {})
  apply({ tools: { ...tools, guard }, orchestrator: { sources: h.sources, context: h.context, runSource },
    effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never,
  { configDir: '/private/user-config', larkCli: '', expectedOwner: 'ou_owner', ownerChatId: 'oc_private', serverName: 'wechat_readonly' })
  expect(h.sources.kind('activity')).toBeDefined()
  expect(runSource).toHaveBeenCalledOnce()
  const check = guard.mock.calls[0]![0]
  expect(check({ name: 'mcp__wechat_readonly__wechat_incremental_ack', agent: {} } as never)).toContain('Only the activity Source')
  expect(check({ name: 'mcp__wechat_readonly__wechat_incremental_ack' } as never)).toBeUndefined()
  expect(check({ name: 'mcp__wechat_readonly__wechat_read_window', agent: {} } as never)).toBeUndefined()
  for (const dispose of disposers.reverse()) await dispose()
  expect(h.sources.kind('activity')).toBeUndefined()
})

it('joins an aborted in-flight reader before the Source loop stops and retains its pending range', async () => {
  const h = host()
  const controller = new AbortController()
  let started!: () => void
  const began = new Promise<void>(resolve => { started = resolve })
  vi.mocked(scanLarkMessages).mockImplementation(async ctx => {
    started()
    await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))
    ctx.assertActive()
    return complete
  })
  const running = runActivity(h.ctx, bindings, tools, controller.signal)
  await began
  controller.abort()
  await running
  expect(scanWechatActivity).not.toHaveBeenCalled()
  expect(store.get(activityState.progress('monitor', 'monitor', 'feishu-messages'))?.pending).toBeDefined()
  expect(store.get(activityState.progress('monitor', 'monitor', 'feishu-messages'))?.since).toBeUndefined()
})

it('projects native message headers without changing evidence identity, and fences revoked sources', () => {
  const selected = config(); saveConfig(selected)
  const { sources } = host()
  const original = event({ label: 'Synthetic operations', senderLabel: 'Synthetic operator', senderType: 'app', senderIdType: 'open_id',
    contentType: 'interactive', parentId: 'om_parent', direction: 'incoming', threadId: 'om_root' })
  const trigger = activityTrigger(original, selected)
  const header = sources.imHeader(trigger)
  expect(header).toEqual({ at: original.at, conversationLabel: 'Synthetic operations', senderLabel: 'Synthetic operator',
    senderType: 'app', senderIdType: 'open_id', contentType: 'interactive', parent: 'om_parent' })
  expect(JSON.parse(JSON.stringify(header))).toEqual(header)
  const renamed = activityTrigger({ ...original, label: 'Renamed conversation' }, selected)
  expect(renamed.id).toBe(trigger.id)
  expect(sources.imEvidence(renamed)).toEqual(sources.imEvidence(trigger))
  expect(sources.imHeader(activityTrigger(event(), selected))).toEqual({ at: original.at })
  const otherOwner = createActivityKind({ ...bindings, lark: { ...bindings.lark, expectedUserId: 'ou_different_owner' } }, tools)
  expect(otherOwner.imEvidence?.(trigger, selected)).toBeUndefined()
  saveConfig(selected, false)
  expect(() => sources.imHeader(trigger)).toThrow('outside scope')
})

it('exposes native IM identity and sender for generic shadow batching without broadening Thread identity', () => {
  const selected = config({ routing: 'tasks' })
  saveConfig(selected)
  const { sources } = host()
  const feishu = activityTrigger(event({ senderId: 'ou_other', threadId: 'om_root' }), selected)
  expect(sources.imEvidence(feishu)).toMatchObject({ provider: 'feishu-messages', account: 'ou_owner',
    conversation: 'oc_business', message: 'om_update', version: 'v1', sender: 'ou_other', root: 'om_root', partial: false })
  const wechat = activityTrigger(event({ provider: 'wechat', accountId: 'wx-owner', objectId: 'wx-chat', id: 'wxe_event', senderId: 'wx-sender',
    locator: { provider: 'wechat', contact: 'wx-chat', messageRef: 'wx1.original', start: iso(), end: iso() }, contentPartial: true }), selected)
  expect(sources.imEvidence(wechat)).toMatchObject({ provider: 'wechat', account: 'wx-owner', conversation: 'wx-chat',
    message: 'wx1.original', sender: 'wx-sender', partial: true })
  const document = activityTrigger(event({ provider: 'feishu-documents', locator: { provider: 'feishu-documents', token: 'doc', type: 'docx', url: 'https://example.com/doc' } }), selected)
  expect(sources.imEvidence(document)).toBeUndefined()
  saveConfig({ ...selected, wechat: false })
  expect(sources.imEvidence(wechat)).toBeUndefined()
  saveConfig(selected, false)
  expect(sources.imEvidence(feishu)).toBeUndefined()
})
