import { expect, it, vi } from 'vitest'
import { scanWechatActivity, readWechatActivityContext } from '../src/sources/activity-wechat.ts'
import { ActivityConfigSchema, activityTrigger, createActivityKind } from '../src/sources/activity.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Commands } from '../src/infra/commands.ts'
import type { ActivityReaderContext, ActivityTools } from '../src/sources/activity-types.ts'

it('calls the selected MCP tool without projecting unrelated plugin schemas', async () => {
  const schemas = vi.fn(() => { throw new Error('Unrelated workbench schema cannot be projected') })
  const execute = vi.fn(async () => ({ isError: true, error: { message: 'Selected MCP unavailable' } }))
  const tools = { schemas, execute } as unknown as ActivityTools
  const ctx = { signal: new AbortController().signal, assertActive: () => {}, consumerId: 'test' } as ActivityReaderContext
  await expect(scanWechatActivity(ctx, tools, { serverName: 'wechat_readonly' },
    { start: '2026-11-01T00:00:00Z', end: '2026-11-02T00:00:00Z' })).rejects.toThrow('Selected MCP unavailable')
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'mcp__wechat_readonly__wechat_list_chats' }))
  expect(schemas).not.toHaveBeenCalled()
})

it.each(['incoming', 'outgoing', 'unknown-native-value', ''])('preserves native direction %j from ingestion to source evidence and legacy context without authority', async direction => {
  const range = { start: '2026-11-01T00:00:00.000Z', end: '2026-11-01T00:00:01.000Z' }
  const original = { account: 'test-account', conversation: 'test-chat', record_id: 'test-record', message_ref: 'wx1.test',
    timestamp: Date.parse(range.start) / 1000, time: range.start, text: 'Already handled', sender: null, direction, local_type: 1 }
  const eventId = `wxe_${'a'.repeat(64)}`, fingerprint = 'b'.repeat(64), batchId = 'c'.repeat(32)
  let delivered = false
  const execute = vi.fn(async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
    const value = name.endsWith('wechat_list_chats') ? { status: 'ok', account: original.account,
      chats: [{ wxid: original.conversation, display: 'Synthetic chat', lastMessageAt: range.start }],
      count: 1, total: 1, offset: 0, next_offset: null, has_more: false, snapshot_id: 'test-snapshot',
      start_inclusive: range.start, end_exclusive: range.end }
      : name.endsWith('wechat_incremental_ack') ? { status: 'acknowledged', batch_id: batchId, count: 1 }
        : name.endsWith('wechat_read_window') ? { status: 'ok', conversation: original.conversation, records: [original],
          count: 1, has_more: false, next_offset: null, snapshot_id: 'test-snapshot' }
          : { status: 'ok', scope_id: args.scope_id, account: original.account, conversation: original.conversation,
            start_inclusive: original.timestamp, end_exclusive: original.timestamp + 1,
            records: delivered ? [] : [{ event_id: eventId, fingerprint, original }], count: delivered ? 0 : 1,
            has_more: false, batch_id: delivered ? '' : batchId, delivery_state: delivered ? 'no_changes' : 'pending_ack' }
    return { isError: false, value: { structuredContent: value, content: [] } }
  })
  const tools = { execute, schemas: vi.fn() } as unknown as ActivityTools
  const state = new Map<string, unknown>()
  const emit = vi.fn<ActivityReaderContext['emit']>(async () => { delivered = true; return 'stored' as const })
  const ctx = { signal: new AbortController().signal, assertActive() {}, consumerId: 'test-consumer', emit,
    source: { state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => state.set(key, value), keys: () => [] } } } as unknown as ActivityReaderContext
  const binding = { serverName: 'wechat_readonly' }
  await scanWechatActivity(ctx, tools, binding, range)
  const event = emit.mock.calls[0]![0]
  expect(event).toMatchObject({ id: eventId, version: fingerprint, senderId: '', direction })
  const config = ActivityConfigSchema.parse({ routing: 'tasks', collectionId: 'test' })
  const trigger = activityTrigger(event, config)
  const registry = new SourceRegistry(() => SettingsSchema.parse({ sources: { activity: { enabled: true, config } } }))
  registry.register(createActivityKind({ ownerChatId: 'test-owner-chat', lark: { expectedUserId: 'test-owner' }, wechat: binding }, tools))
  expect(registry.imEvidence(trigger)).toMatchObject({ message: original.message_ref, version: fingerprint, direction })
  expect(registry.imEvidence(trigger)).not.toHaveProperty('sender')
  expect(trigger).toMatchObject({ actor: { source: 'activity', id: '' }, human: false })
  expect(trigger).not.toHaveProperty('addressed')
  // Existing records do not gain invented metadata or a different trigger identity.
  const { direction: _direction, ...legacy } = event
  const legacyTrigger = activityTrigger(legacy, config)
  expect(legacyTrigger.id).toBe(trigger.id)
  expect(registry.imEvidence(legacyTrigger)).not.toHaveProperty('direction')
  const context = await readWechatActivityContext(tools, binding, {} as Commands, event, 'thread')
  expect(context.messages[0]).toMatchObject({ id: original.message_ref, from: '', direction })
  expect(context.status).toBe('partial')
})
