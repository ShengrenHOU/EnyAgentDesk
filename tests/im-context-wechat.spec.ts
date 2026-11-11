import { expect, it, vi } from 'vitest'
import { readWechatImContext } from '../src/sources/activity-wechat.ts'
import type { ActivityTools } from '../src/sources/activity-types.ts'
import { collectImContext, type ImContextRequest } from '../src/sources/im-context.ts'
import { ActivityConfigSchema, activityTrigger, createActivityKind } from '../src/sources/activity.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Commands } from '../src/infra/commands.ts'

const binding = { serverName: 'wechat_readonly' }
const request: ImContextRequest = { anchor: { provider: 'wechat', account: 'test-account', conversation: 'test-chat',
  message: 'wx1.anchor', version: 'observed-version', partial: false }, anchorText: 'Please handle this',
start: '2026-11-01T00:00:00.000Z', end: '2026-11-01T01:00:00.000Z' }
const signal = () => new AbortController().signal
function original(id = 'anchor', seconds = 0, extra: object = {}) {
  const timestamp = Date.parse(request.start) / 1000 + seconds
  return { account: request.anchor.account, conversation: request.anchor.conversation, record_id: `record-${id}`,
    message_ref: `wx1.${id}`, timestamp, time: new Date(timestamp * 1000).toISOString(), text: id,
    sender: 'test-sender', direction: 'incoming', local_type: 1, ...extra }
}
function page(records = [original()], extra: object = {}) {
  return { status: 'ok', conversation: request.anchor.conversation, records, count: records.length,
    has_more: false, next_offset: null, snapshot_id: 'snapshot-one', start_inclusive: request.start, end_exclusive: request.end, ...extra }
}
function mock(...pages: object[]) {
  const execute = vi.fn()
  for (const item of pages) execute.mockResolvedValueOnce({ isError: false, value: { structuredContent: item, content: [] } })
  const schemas = vi.fn(() => { throw new Error('must not enumerate unrelated tools') })
  return { execute, schemas, tools: { execute, schemas } as unknown as ActivityTools }
}

it('reads later replies and outgoing messages in a fixed snapshot without incremental reads or ACKs', async () => {
  const native = mock(page([original()], { has_more: true, next_offset: 1 }),
    page([original('later-reply', 1800, { direction: 'outgoing', sender: 'owner' })]))
  const first = await readWechatImContext(native.tools, binding, request, undefined, signal())
  const second = await readWechatImContext(native.tools, binding, request, first.next, signal())
  expect(second.messages).toEqual([{ id: 'wx1.later-reply', text: 'later-reply', sender: 'owner', direction: 'outgoing', createdAt: '2026-11-01T00:30:00.000Z' }])
  expect(first.messages[0]).not.toHaveProperty('version')
  expect(second.next).toBeUndefined()
  expect(second).toMatchObject({ consistency: 'native_snapshot', snapshot: 'snapshot-one',
    gaps: ['local_sync_only', 'native_version_unavailable', 'deletion_status_unavailable'] })
  for (const [call] of native.execute.mock.calls) {
    expect(call.name).toBe('mcp__wechat_readonly__wechat_read_window')
    expect(call.arguments).toMatchObject({ contact: 'test-chat', start: request.start, end: request.end, limit: 100 })
  }
  expect(native.execute.mock.calls[1]![0].arguments).toMatchObject({ offset: 1, snapshot_id: 'snapshot-one' })
  expect(native.schemas).not.toHaveBeenCalled()
})

it('marks an unavailable native read transport for bounded retry without exposing diagnostics', async () => {
  const native = mock()
  native.execute.mockRejectedValueOnce(new Error('PRIVATE_RPC_DIAGNOSTICS'))
  await expect(readWechatImContext(native.tools, binding, request, undefined, signal()))
    .rejects.toMatchObject({ retryable: true, message: 'IM context read failed or permission is unavailable; no context was attached' })
  expect(native.execute).toHaveBeenCalledTimes(1)
})

it.each([['Selected MCP unavailable', true], ['Request timed out', true], ['HTTP 503', true],
  ['Permission unavailable', false], ['Forbidden (403)', false], ['Invalid input', false]])('classifies native error-valued reads: %s', async (message, retryable) => {
  const native = mock()
  native.execute.mockResolvedValueOnce({ isError: true, error: { message } })
  await expect(readWechatImContext(native.tools, binding, request, undefined, signal()))
    .rejects.toMatchObject({ retryable, message: 'IM context read failed or permission is unavailable; no context was attached' })
})

it.each(['incoming', 'outgoing', 'unknown-native-value', ''])('retains native direction %j with an unknown sender through the host collector', async direction => {
  const native = mock(page([original('anchor', 0, { sender: null, direction, text: request.anchorText })]))
  const result = await collectImContext({ assertActive() {},
    read: (selected, cursor, abort) => readWechatImContext(native.tools, binding, selected, cursor, abort) }, request)
  expect(result.messages[0]).toMatchObject({ id: 'wx1.anchor', sender: '', direction })
  expect(result.anchor.observed).toMatchObject({ sender: '', direction })
  expect(result.anchor.status).toBe('unverified')
  expect(result.contextComplete).toBe(false)
})

it.each([
  ['wrong record account', () => page([original('anchor', 0, { account: 'other-account' })])],
  ['wrong record conversation', () => page([original('anchor', 0, { conversation: 'other-chat' })])],
  ['wrong page conversation', () => page([], { conversation: 'other-chat' })],
  ['wrong page account', () => page([], { account: 'other-account' })],
  ['wrong bounds', () => page([], { end_exclusive: 1 })],
  ['outside window', () => page([original('outside', 3600)])],
  ['inconsistent time', () => page([original('anchor', 0, { time: request.end })])],
  ['duplicate record ids', () => page([original(), original('reply', 1, { record_id: 'record-anchor' })])],
  ['duplicate message ids', () => page([original(), original('reply', 1, { message_ref: 'wx1.anchor' })])],
  ['count mismatch', () => page([], { count: 1 })],
  ['nonadvancing offset', () => page([original()], { has_more: true, next_offset: 0 })],
  ['skipped offset', () => page([original()], { has_more: true, next_offset: 2 })],
  ['empty continuation', () => page([], { has_more: true, next_offset: 1 })],
  ['terminal offset', () => page([], { next_offset: 1 })],
  ['oversized native page', () => page(Array.from({ length: 101 }, (_, i) => original(String(i), i)))],
] as const)('rejects %s', async (_label, value) => {
  const native = mock(value())
  await expect(readWechatImContext(native.tools, binding, request, undefined, signal())).rejects.toThrow()
  expect(native.execute).toHaveBeenCalledTimes(1)
})

it('rejects snapshot drift', async () => {
  const native = mock(page([original()], { has_more: true, next_offset: 1 }), page([], { snapshot_id: 'snapshot-two' }))
  const first = await readWechatImContext(native.tools, binding, request, undefined, signal())
  await expect(readWechatImContext(native.tools, binding, request, first.next, signal())).rejects.toThrow('snapshot')
})

it('binds cursors to the server, account, conversation, anchor and exact window', async () => {
  const native = mock(page([original()], { has_more: true, next_offset: 1 }))
  const first = await readWechatImContext(native.tools, binding, request, undefined, signal())
  const variants = [
    { ...request, start: '2026-10-31T23:00:00.000Z' },
    { ...request, end: '2026-11-01T02:00:00.000Z' },
    ...['account', 'conversation', 'message', 'version'].map(key => ({ ...request,
      anchor: { ...request.anchor, [key]: key === 'message' ? 'wx1.other' : 'other' } })),
  ]
  for (const changed of variants) await expect(readWechatImContext(native.tools, binding, changed, first.next, signal())).rejects.toThrow('cursor')
  await expect(readWechatImContext(native.tools, { serverName: 'other' }, request, first.next, signal())).rejects.toThrow('cursor')
  expect(native.execute).toHaveBeenCalledTimes(1)
})

it('normalizes subsecond windows to the same integer timestamp set and validates native ISO bounds', async () => {
  const selected = { ...request, start: '2026-11-01T00:00:00.001Z', end: '2026-11-01T00:00:01.779Z' }
  const native = mock(page([original('reply', 1)], { start_inclusive: '2026-11-01T08:00:01+08:00', end_exclusive: '2026-11-01T08:00:02+08:00' }))
  const result = await readWechatImContext(native.tools, binding, selected, undefined, signal())
  expect(native.execute.mock.calls[0]![0].arguments).toMatchObject({ start: '2026-11-01T00:00:01.000Z', end: '2026-11-01T00:00:02.000Z' })
  expect(result).toMatchObject({ start: selected.start, end: selected.end, messages: [{ id: 'wx1.reply' }] })
  const escaped = mock(page([original('outside', 0)], { start_inclusive: '2026-11-01T08:00:01+08:00', end_exclusive: '2026-11-01T08:00:02+08:00' }))
  await expect(readWechatImContext(escaped.tools, binding, selected, undefined, signal())).rejects.toThrow('escaped')
})

it('marks attachments partial without fabricating native versions', async () => {
  const native = mock(page([original('image', 0, { local_type: 3 }), original('attachment', 1, { attachment: {} })]))
  const result = await readWechatImContext(native.tools, binding, request, undefined, signal())
  expect(result.messages.every(message => message.partial && message.version === undefined)).toBe(true)
})


it('does not claim account verification for an empty native window without account metadata', async () => {
  const native = mock(page([]))
  const result = await readWechatImContext(native.tools, binding, request, undefined, signal())
  expect(result.gaps).toContain('account_unverified_empty_window')
  expect(result.gaps).toContain('deletion_status_unavailable')
  expect(result.messages).toEqual([])
})

it('accepts explicit matching account metadata for an empty window', async () => {
  const native = mock(page([], { account: request.anchor.account }))
  const result = await readWechatImContext(native.tools, binding, request, undefined, signal())
  expect(result.gaps).not.toContain('account_unverified_empty_window')
})

it('does not infer deletion status from present local records', async () => {
  const native = mock(page())
  const result = await readWechatImContext(native.tools, binding, request, undefined, signal())
  expect(result.gaps).toContain('deletion_status_unavailable')
  expect(result.gaps).not.toContain('account_unverified_empty_window')
  expect(result.messages[0]).not.toHaveProperty('deleted')
})

it('honors cancellation before dispatch and after a native response', async () => {
  const native = mock()
  const before = new AbortController()
  before.abort(new Error('cancelled before dispatch'))
  await expect(readWechatImContext(native.tools, binding, request, undefined, before.signal)).rejects.toThrow('cancelled before dispatch')
  expect(native.execute).not.toHaveBeenCalled()
  const during = new AbortController()
  native.execute.mockImplementationOnce(async () => {
    during.abort(new Error('cancelled during response'))
    return { isError: false, value: { structuredContent: page(), content: [] } }
  })
  await expect(readWechatImContext(native.tools, binding, request, undefined, during.signal)).rejects.toThrow('cancelled during response')
})


it('returns an explicitly unverified empty context when no whole-second timestamp fits the request', async () => {
  const native = mock()
  const result = await readWechatImContext(native.tools, binding, { ...request, start: '2026-11-01T00:00:00.001Z', end: '2026-11-01T00:00:00.999Z' }, undefined, signal())
  expect(result.messages).toEqual([])
  expect(result.gaps).toContain('account_unverified_empty_window')
  expect(result.snapshot).toBeUndefined()
  expect(native.execute).not.toHaveBeenCalled()
})


it.each([['Please handle this', true], ['The message really changed', false]] as const)(
  'compares native activity content through the Source registry and collector (%s)', async (text, matches) => {
    const config = ActivityConfigSchema.parse({ routing: 'tasks', collectionId: 'test' })
    const trigger = activityTrigger({ provider: 'wechat', accountId: 'test-account', objectId: 'test-chat', id: 'event-one',
      version: 'version-one', at: request.start, text: 'Please handle this', reference: 'wx1.anchor',
      locator: { provider: 'wechat', contact: 'test-chat', messageRef: 'wx1.anchor', start: request.start, end: request.end } }, config)
    const settings = SettingsSchema.parse({ sources: { activity: { enabled: true, config } } })
    const registry = new SourceRegistry(() => settings)
    const native = mock(page([original('anchor', 0, { text })]))
    registry.register(createActivityKind({ ownerChatId: 'private', lark: { expectedUserId: 'owner', configDir: '/private' }, wechat: binding }, native.tools))
    const evidence = registry.imEvidence(trigger)!
    const { configuration: _configuration, ...anchor } = evidence
    const commands = { withSignal: () => commands } as unknown as Commands
    const reader = registry.imContext(trigger, commands)
    expect(trigger.text).toContain('[Read-only wechat activity;')
    expect(reader.anchorText).toBe('Please handle this')
    const result = await collectImContext(reader, { anchor, anchorText: reader.anchorText!, start: request.start, end: request.end })
    expect(result.anchor.contentMatch).toBe(matches)
  },
)
