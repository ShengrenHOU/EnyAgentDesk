/** Feishu window reads use the bound user identity, exact name resolution and native message identity. */
import { afterEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { ActivityConfigSchema, createActivityKind } from '../src/sources/activity.ts'
import type { ActivityTools } from '../src/sources/activity-types.ts'
import type { ImReadRequest } from '../src/sources/im-context.ts'
import { testDeployment } from './fixtures/deployment.ts'

const binding = { expectedUserId: 'ou_reader', cli: 'synthetic-lark', configDir: 'synthetic-user-config' }
const config = ActivityConfigSchema.parse({ collectionId: 'read-gateway', feishuMessages: true, wechat: false })
const request: ImReadRequest = { provider: 'feishu-messages', conversation: 'Project Alpha', start: '2026-11-01T10:00:00.123Z', end: '2026-11-01T11:00:00.456Z' }
const envelope = (data: unknown) => ({ ok: true, identity: 'user', data })
const original = (fields: object = {}) => ({ message_id: 'om_one', chat_id: 'oc_group', msg_type: 'text',
  create_time: String(Date.parse('2026-11-01T10:01:00Z')), update_time: String(Date.parse('2026-11-01T10:01:00Z')),
  body: { content: '{"text":"Project update"}' }, sender: { id: 'ou_sender', sender_type: 'user', id_type: 'open_id' }, ...fields })
function fixture(handler: (args: string[]) => unknown | Promise<unknown>) {
  const run = vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_cli, args) => JSON.stringify(args[0] === 'auth'
    ? { identities: { user: { status: 'ready', openId: binding.expectedUserId } } } : envelope(await handler(args))))
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const tools = { schemas: vi.fn(), execute: vi.fn() } as unknown as ActivityTools
  const kind = createActivityKind({ ownerChatId: 'oc_owner', lark: binding, wechat: { serverName: 'wechat_readonly' } }, tools)
  const signal = new AbortController().signal
  return { run, tools, signal, read: (selected: ImReadRequest = request, cursor?: string) => kind.imRead!.read(commands, selected, cursor, config, signal) }
}
afterEach(() => vi.restoreAllMocks())
const messagesCall = (args: string[]) => args.includes('/open-apis/im/v1/messages')
const params = (args: string[]) => JSON.parse(args[args.indexOf('--params') + 1]!) as Record<string, unknown>

it('resolves one exact group name and reads its native window in ascending order', async () => {
  const f = fixture(args => args.includes('+chat-search')
    ? { chats: [{ chat_id: 'oc_group', name: 'Project Alpha' }], has_more: false }
    : args.includes('+chat-list') ? { chats: [], has_more: false } : { items: [original()], has_more: false })
  const page = await f.read()
  expect(page.resolved).toEqual({ id: 'oc_group', label: 'Project Alpha' })
  expect(page.resolution).toBe('exact_name')
  expect(page.messages[0]).toMatchObject({ id: 'om_one', sender: 'ou_sender', senderIdType: 'open_id',
    versionBasis: 'source_digest', text: 'Project update' })
  expect(page.account).toBe('ou_reader')
  expect(page.gaps).toEqual(expect.arrayContaining(['live_pagination', 'thread_replies_not_covered', 'window_bounds_whole_seconds']))
  expect(f.run.mock.calls.some(([, args]) => args.includes('+chat-list'))).toBe(true)
  const call = f.run.mock.calls.find(([, args]) => messagesCall(args))![1]
  expect(params(call)).toMatchObject({ container_id_type: 'chat', container_id: 'oc_group', sort_type: 'ByCreateTimeAsc',
    start_time: String(Math.floor(Date.parse(request.start) / 1000)), end_time: String(Math.ceil(Date.parse(request.end) / 1000)) })
  expect(call.slice(-4)).toEqual(['--as', 'user', '--format', 'json'])
})

it('returns ambiguous exact names as candidates and reads no messages', async () => {
  const f = fixture(args => {
    if (args.includes('+chat-search')) return { chats: [{ chat_id: 'oc_one', name: 'Alpha' }, { chat_id: 'oc_two', name: 'alpha' }], has_more: false }
    if (args.includes('+chat-list')) return { chats: [], has_more: false }
    return { items: [original()], has_more: false }
  })
  const page = await f.read({ ...request, conversation: 'Alpha' })
  expect(page.messages).toEqual([])
  expect(page.candidates).toEqual([{ id: 'oc_one', label: 'Alpha' }, { id: 'oc_two', label: 'alpha' }])
  expect(page.gaps).toContain('conversation_ambiguous')
  expect(f.run.mock.calls.filter(([, args]) => messagesCall(args))).toHaveLength(0)
})

it('treats one group and one private conversation with the same name as ambiguous', async () => {
  const f = fixture(args => {
    if (args.includes('+chat-search')) return { chats: [{ chat_id: 'oc_group', name: 'Alpha' }], has_more: false }
    if (args.includes('+chat-list')) return { chats: [{ chat_id: 'oc_p2p', name: 'Alpha', chat_mode: 'p2p' }], has_more: false }
    return { items: [original()], has_more: false }
  })
  const page = await f.read({ ...request, conversation: 'Alpha' })
  expect(page.messages).toEqual([])
  expect(page.candidates).toEqual([{ id: 'oc_group', label: 'Alpha' }, { id: 'oc_p2p', label: 'Alpha' }])
  expect(f.run.mock.calls.filter(([, args]) => messagesCall(args))).toHaveLength(0)
})

it('returns candidates when a name search stopped before proving uniqueness', async () => {
  const f = fixture(args => {
    if (args.includes('+chat-search')) return { chats: [{ chat_id: 'oc_group', name: 'Alpha' }], has_more: true }
    if (args.includes('+chat-list')) return { chats: [], has_more: false }
    return { items: [original()], has_more: false }
  })
  const page = await f.read({ ...request, conversation: 'Alpha' })
  expect(page.messages).toEqual([])
  expect(page.candidates).toEqual([{ id: 'oc_group', label: 'Alpha' }])
  expect(f.run.mock.calls.filter(([, args]) => messagesCall(args))).toHaveLength(0)
  const search = f.run.mock.calls.find(([, args]) => args.includes('+chat-search'))![1]
  expect(search).toEqual(expect.arrayContaining(['--page-all', '--page-limit', '5']))
})

it('resolves a private conversation name through the active-chat listing after group search misses', async () => {
  const f = fixture(args => {
    if (args.includes('+chat-search')) return { chats: [], has_more: false }
    if (args.includes('+chat-list')) return { chats: [{ chat_id: 'oc_p2p', name: '董家琪', chat_mode: 'p2p' }], has_more: false }
    return { items: [original({ chat_id: 'oc_p2p' })], has_more: false }
  })
  const page = await f.read({ ...request, conversation: '董家琪' })
  expect(page.resolved).toEqual({ id: 'oc_p2p', label: '董家琪' })
  expect(page.messages).toHaveLength(1)
  const list = f.run.mock.calls.find(([, args]) => args.includes('+chat-list'))![1]
  expect(list).toEqual(expect.arrayContaining(['--types', 'p2p', '--page-all']))
})

it('uses a native chat ID without a name lookup and continues with its page token', async () => {
  const f = fixture(args => {
    if (args.includes('+chat-search') || args.includes('+chat-list')) throw new Error('A native ID must not be resolved')
    return params(args).page_token
      ? { items: [original({ message_id: 'om_two' })], has_more: false }
      : { items: [original()], has_more: true, page_token: 'next-page' }
  })
  const first = await f.read({ ...request, conversation: 'oc_group' })
  expect(first.resolved).toEqual({ id: 'oc_group' })
  expect(first.resolution).toBe('native_id')
  expect(first.next).toBe('next-page')
  const second = await f.read({ ...request, conversation: 'oc_group' }, first.next)
  expect(second.messages[0]?.id).toBe('om_two')
  expect(params(f.run.mock.calls.filter(([, args]) => messagesCall(args))[1]![1]).page_token).toBe('next-page')
})

it('filters a native window by keyword locally and preserves attachment gaps', async () => {
  const f = fixture(args => {
    if (!messagesCall(args)) throw new Error('Unexpected lookup')
    return { items: [original({ msg_type: 'file', body: { content: '{"file_key":"k","file_name":"Project file"}' } }),
      original({ message_id: 'om_other', body: { content: '{"text":"unrelated"}' } })], has_more: false }
  })
  const page = await f.read({ ...request, conversation: 'oc_group', keyword: 'project' })
  expect(page.messages.map(message => message.id)).toEqual(['om_one'])
  expect(page.messages[0]?.partial).toBe(true)
  expect(page.gaps).toEqual(expect.arrayContaining(['keyword_local_filter', 'attachments_not_read']))
})

it('rejects foreign records and pagination that does not advance', async () => {
  const foreign = fixture(args => {
    if (args.includes('+chat-search')) return { chats: [{ chat_id: 'oc_group', name: 'Project Alpha' }], has_more: false }
    if (args.includes('+chat-list')) return { chats: [], has_more: false }
    return { items: [original({ chat_id: 'oc_foreign' })], has_more: false }
  })
  await expect(foreign.read()).rejects.toThrow('outside the requested conversation')
  const stuck = fixture(args => {
    if (args.includes('+chat-search')) return { chats: [{ chat_id: 'oc_group', name: 'Project Alpha' }], has_more: false }
    if (args.includes('+chat-list')) return { chats: [], has_more: false }
    return { items: [original()], has_more: true, page_token: 'same' }
  })
  const first = await stuck.read()
  await expect(stuck.read({ ...request, conversation: 'oc_group' }, first.next)).rejects.toThrow('did not advance')
})

it('matches a keyword beyond the display limit before truncating the message', async () => {
  const text = `${'x'.repeat(20_000)}needle`
  const f = fixture(args => {
    if (!messagesCall(args)) throw new Error('Unexpected lookup')
    return { items: [original({ body: { content: JSON.stringify({ text }) } })], has_more: false }
  })
  const page = await f.read({ ...request, conversation: 'oc_group', keyword: 'needle' })
  expect(page.messages.map(message => message.id)).toEqual(['om_one'])
  expect(page.messages[0]?.text.length).toBe(20_000)
  expect(page.messages[0]?.partial).toBe(true)
  expect(page.gaps).toContain('content_partial')
})

it('returns unknown names as an empty unresolved page without guessing', async () => {
  const f = fixture(args => args.includes('+chat-search') || args.includes('+chat-list') ? { chats: [], has_more: false } : { items: [], has_more: false })
  const page = await f.read({ ...request, conversation: 'Nobody' })
  expect(page.messages).toEqual([])
  expect(page.candidates).toEqual([])
  expect(page.gaps).toContain('conversation_not_found')
  expect(f.run.mock.calls.filter(([, args]) => messagesCall(args))).toHaveLength(0)
})

it('does not read when the activity Source disabled this provider', async () => {
  const disabled = ActivityConfigSchema.parse({ collectionId: 'read-gateway', feishuMessages: false, wechat: false })
  await expect(fixtureKinds().imRead!.read(fixtureCommands(), request, undefined, disabled, new AbortController().signal))
    .rejects.toThrow('disabled')
})
function fixtureKinds() {
  const tools = { schemas: vi.fn(), execute: vi.fn() } as unknown as ActivityTools
  return createActivityKind({ ownerChatId: 'oc_owner', lark: binding, wechat: { serverName: 'wechat_readonly' } }, tools)
}
function fixtureCommands() {
  return new Commands(() => testDeployment(), {}, new AbortController().signal)
}
