/** WeChat window reads resolve names exactly, preserve native direction and never join the monitor's ACK protocol. */
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { Commands } from '../src/infra/commands.ts'
import { ActivityConfigSchema, createActivityKind } from '../src/sources/activity.ts'
import type { ActivityTools } from '../src/sources/activity-types.ts'
import type { ImReadRequest } from '../src/sources/im-context.ts'

const config = ActivityConfigSchema.parse({ collectionId: 'read-gateway', feishuMessages: false, wechat: true })
const request: ImReadRequest = { provider: 'wechat', conversation: '董家琪', start: '2026-11-01T10:00:00.123Z', end: '2026-11-01T11:00:00.456Z' }
const nativeStart = Math.ceil(Date.parse(request.start) / 1000) * 1000
const nativeEnd = Math.ceil(Date.parse(request.end) / 1000) * 1000
const original = (fields: object = {}) => ({ account: 'test-account', conversation: 'wxid_chat', record_id: 'wxm_one',
  message_ref: 'wx1.one', timestamp: nativeStart / 1000, time: new Date(nativeStart).toISOString(), text: 'Contract update',
  sender: 'wxid_sender', direction: 'incoming', contact: '董家琪', local_type: 1, ...fields })
const chat = (fields: object = {}) => ({ wxid: 'wxid_chat', display: '董家琪', lastMessageAt: new Date(nativeStart).toISOString(), ...fields })
const listPage = (chats: object[], extra: object = {}) => ({ status: 'ok', account: 'test-account', chats,
  count: chats.length, total: chats.length, offset: 0, next_offset: null, has_more: false, snapshot_id: 'chat-snapshot',
  start_inclusive: new Date(nativeStart).toISOString(), end_exclusive: new Date(nativeEnd).toISOString(), ...extra })
const windowPage = (records: object[], extra: object = {}) => ({ status: 'ok', conversation: 'wxid_chat', records,
  count: records.length, has_more: false, next_offset: null, snapshot_id: 'window-snapshot',
  start_inclusive: new Date(nativeStart).toISOString(), end_exclusive: new Date(nativeEnd).toISOString(), ...extra })
function fixture(handler: (name: string, args: Record<string, unknown>) => unknown) {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const execute = vi.fn(async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
    calls.push({ name, args })
    return { isError: false, value: { structuredContent: handler(name, args), content: [] } }
  })
  const tools = { schemas: vi.fn(), execute } as unknown as ActivityTools
  const kind = createActivityKind({ ownerChatId: 'oc_owner', lark: { expectedUserId: 'ou_owner' },
    wechat: { serverName: 'wechat_readonly' } }, tools)
  const signal = new AbortController().signal
  return { calls, execute, read: (selected: ImReadRequest = request, cursor?: string) =>
    kind.imRead!.read({} as Commands, selected, cursor, config, signal) }
}

it('resolves one exact display name, reads the native window with its keyword, and never acknowledges', async () => {
  const f = fixture((name, args) => {
    if (name.endsWith('wechat_list_chats')) return listPage([chat()])
    if (name.endsWith('wechat_read_window')) return windowPage([original()])
    throw new Error(`Unexpected tool ${name}`)
  })
  const page = await f.read({ ...request, keyword: 'contract' })
  expect(page.resolved).toEqual({ id: 'wxid_chat', label: '董家琪' })
  expect(page.resolution).toBe('exact_name')
  expect(page.account).toBe('test-account')
  expect(page.messages[0]).toMatchObject({ id: 'wx1.one', sender: 'wxid_sender', direction: 'incoming', text: 'Contract update' })
  expect(page.messages[0]?.version).toMatch(/^[a-f0-9]{64}$/)
  expect(page.messages[0]?.versionBasis).toBe('source_digest')
  // The reader reproduces the native collector's fingerprint over its sorted fields, not a separate message digest.
  const fingerprint = createHash('sha256').update(JSON.stringify({ direction: 'incoming', local_type: 1,
    sender: 'wxid_sender', text: 'Contract update', timestamp: nativeStart / 1000 })).digest('hex')
  expect(page.messages[0]?.version).toBe(fingerprint)
  const read = f.calls.find(call => call.name.endsWith('wechat_read_window'))!
  expect(read.args).toMatchObject({ contact: 'wxid_chat', keyword: 'contract', offset: 0, snapshot_id: '',
    start: new Date(nativeStart).toISOString(), end: new Date(nativeEnd).toISOString() })
  expect(f.calls.some(call => call.name.endsWith('wechat_incremental_ack'))).toBe(false)
  expect(f.calls.some(call => call.name.endsWith('wechat_incremental_read'))).toBe(false)
})

it('returns ambiguous exact names as candidates and reads no window', async () => {
  const f = fixture(name => name.endsWith('wechat_list_chats')
    ? listPage([chat({ wxid: 'wxid_one' }), chat({ wxid: 'wxid_two' })])
    : windowPage([]))
  const page = await f.read()
  expect(page.messages).toEqual([])
  expect(page.candidates).toEqual([{ id: 'wxid_one', label: '董家琪' }, { id: 'wxid_two', label: '董家琪' }])
  expect(page.gaps).toContain('conversation_ambiguous')
  expect(f.calls.some(call => call.name.endsWith('wechat_read_window'))).toBe(false)
})

it('accepts a native wxid without listing chats and rejects a foreign conversation', async () => {
  const f = fixture(name => name.endsWith('wechat_read_window')
    ? windowPage([original({ conversation: 'wxid_other' })])
    : windowPage([]))
  await expect(f.read({ ...request, conversation: 'wxid_chat' })).rejects.toThrow('escaped its conversation')
  expect(f.calls.some(call => call.name.endsWith('wechat_list_chats'))).toBe(false)
})

it('continues with the native offset and snapshot and rejects a changed snapshot', async () => {
  let page = 0
  const f = fixture(name => {
    if (!name.endsWith('wechat_read_window')) throw new Error('Unexpected lookup')
    page++
    return page === 1
      ? windowPage([original()], { has_more: true, next_offset: 1 })
      : windowPage([original({ record_id: 'wxm_two', message_ref: 'wx1.two', timestamp: nativeStart / 1000 + 1,
        time: new Date(nativeStart + 1000).toISOString() })])
  })
  const first = await f.read({ ...request, conversation: 'wxid_chat' })
  expect(first.next).toBeTruthy()
  const second = await f.read({ ...request, conversation: 'wxid_chat' }, first.next)
  expect(second.messages.map(message => message.id)).toEqual(['wx1.two'])
  expect(f.calls.filter(call => call.name.endsWith('wechat_read_window'))[1]?.args).toMatchObject({ offset: 1, snapshot_id: 'window-snapshot' })
  const changed = fixture(() => ({ status: 'snapshot_changed', snapshot_id: 'new', records: [], message: 'changed' }))
  await expect(changed.read({ ...request, conversation: 'wxid_chat' })).rejects.toThrow('restart')
})

it('matches the native fingerprint for a shared link with nested app fields', async () => {
  const app = { kind: 'link', label: 'L', title: 'T', description: 'D', source: 'S', url: 'U' }
  const f = fixture(name => name.endsWith('wechat_read_window') ? windowPage([original({ local_type: 49, app })]) : windowPage([]))
  const page = await f.read({ ...request, conversation: 'wxid_chat' })
  const expected = createHash('sha256').update(JSON.stringify({ app: { description: 'D', kind: 'link', label: 'L',
    source: 'S', title: 'T', url: 'U' }, direction: 'incoming', local_type: 49, sender: 'wxid_sender',
  text: 'Contract update', timestamp: nativeStart / 1000 })).digest('hex')
  expect(page.messages[0]?.version).toBe(expected)
})

it('rejects an otherwise successful continuation page with a different snapshot', async () => {
  let page = 0
  const f = fixture(name => {
    if (!name.endsWith('wechat_read_window')) throw new Error('Unexpected lookup')
    page++
    return page === 1 ? windowPage([original()], { has_more: true, next_offset: 1 })
      : windowPage([original({ record_id: 'wxm_two', message_ref: 'wx1.two', timestamp: nativeStart / 1000 + 1,
        time: new Date(nativeStart + 1000).toISOString() })], { snapshot_id: 'other-snapshot' })
  })
  const first = await f.read({ ...request, conversation: 'wxid_chat' })
  await expect(f.read({ ...request, conversation: 'wxid_chat' }, first.next)).rejects.toThrow('snapshot')
})

it('returns an empty bounded page when the window is shorter than a native second', async () => {
  const f = fixture(() => { throw new Error('No native read is expected') })
  const page = await f.read({ ...request, conversation: 'wxid_chat', start: '2026-11-01T10:00:00.100Z', end: '2026-11-01T10:00:00.900Z' })
  expect(page.messages).toEqual([])
  expect(page.gaps).toContain('window_below_native_resolution')
  expect(f.calls).toEqual([])
})
