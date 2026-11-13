import { afterEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { feishuRead, readFeishu, feishuReferences, readFeishuLink } from '../src/sources/feishu-read.ts'
import type { FeishuRef } from '../src/sources/feishu-read.ts'
import { receiveSharedFeishu, backfillChat } from '../src/sources/feishu-loops.ts'
import { KV } from '../src/kv.ts'
import type { SourceContext } from '../src/sources/host.ts'
const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
const event: FeishuRef = { triggerId: 'source', chatId: 'oc_chat', messageId: 'om_source' }
const source = { message_id: 'om_source', chat_id: 'oc_chat', parent_id: 'om_parent', root_id: 'om_root', thread_id: 'omt_thread' }
const message = { message_id: 'om_root', chat_id: 'oc_chat', msg_type: 'merge_forward', content: '<forwarded_messages>Earlier discussion ![Image](img_one)</forwarded_messages>', sender: { id: 'ou_user', name: 'User', sender_type: 'user' }, create_time: '2026-09-11 12:00' }
afterEach(() => vi.restoreAllMocks())
it.each([['p2p', true], ['group', false]])('retains %s recovery identity from the shared SDK receive path', async (chatType, direct) => {
  const values = new Map(), receive = vi.fn(async () => 'stored' as const)
  const ctx = { config: () => ({ sharedEvents: true }), deployment: testDeployment(), receive,
    state: { get: (id: string) => values.get(id), set: (id: string, value: unknown) => values.set(id, value) },
    threads: { describe: vi.fn() } } as unknown as SourceContext
  await receiveSharedFeishu(ctx, { sender: { sender_id: { open_id: 'ou_member' }, sender_type: 'user' },
    message: { message_id: 'om_new', chat_id: 'oc_new', chat_type: chatType, create_time: '1794500000000',
      message_type: 'text', content: '{"text":"Native event recovery fixture"}' } })
  expect(values.get(KV.feishu.chats)).toEqual({ oc_new: direct })
  expect(receive).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ direct, chatId: 'oc_new' }) }))
})
it('does not let a buffered group-classified poll overwrite a live direct-chat identity', async () => {
  const values = new Map(), receive = vi.fn(async () => 'stored' as const)
  const ctx = { config: () => ({ sharedEvents: true }), deployment: testDeployment(), receive, commands,
    state: { get: (id: string) => values.get(id), set: (id: string, value: unknown) => values.set(id, value) },
    threads: { describe: vi.fn(), subscribed: () => [] } } as unknown as SourceContext
  vi.spyOn(Commands.prototype, 'lark').mockImplementationOnce(async () => {
    await receiveSharedFeishu(ctx, { sender: { sender_id: { open_id: 'ou_member' }, sender_type: 'user' },
      message: { message_id: 'om_live', chat_id: 'oc_new', chat_type: 'p2p', create_time: '1794500000000',
        message_type: 'text', content: '{"text":"Live identity"}' } })
    return { items: [{ message_id: 'om_polled', chat_id: 'oc_new', msg_type: 'text', create_time: '1794500000000',
      body: { content: '{"text":"Buffered poll"}' }, sender: { id: 'ou_member', sender_type: 'user' } }], has_more: false }
  })
  await backfillChat(ctx, 'oc_new', false, '2026-11-12T00:00:00Z', '2026-11-14T00:00:00Z', new AbortController().signal)
  expect(values.get(KV.feishu.chats)).toEqual({ oc_new: true })
  expect(receive).toHaveBeenCalledTimes(2)
})

it('resolves legacy source metadata and reads merged forwards without embedding automatic thread expansion', async () => {
  const lark = vi.spyOn(commands, 'lark').mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ messages: [{ ...message, thread_replies: [{ content: 'Automatic expansion omitted' }] }] })
  const result = await readFeishu(commands, event, 'feishu/source/root', 20)
  expect(result).toMatchObject({ status: 'available', message: { content: message.content } })
  // The read response states no limitations of its own; the skill states them once.
  expect(result).not.toHaveProperty('limitations')
  expect(JSON.stringify(result)).not.toContain('Automatic expansion omitted')
  expect(lark.mock.calls[1]![0]).toEqual(['im', '+messages-mget', '--message-ids', 'om_root', '--no-reactions'])
})
it('paginates source thread messages with opaque cursors and retains authors and edited timestamps', async () => {
  const lark = vi.spyOn(commands, 'lark').mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ thread_id: 'omt_thread', has_more: true, page_token: 'a/b+next=', messages: [{ ...message, message_id: 'om_reply', thread_id: 'omt_thread', updated: true, update_time: '2026-09-11 12:01' }] })
  const first = await readFeishu(commands, event, 'feishu/source/thread', 2)
  expect(first).toMatchObject({ next_resource: 'feishu/source/thread/a%2Fb%2Bnext%3D', messages: [{ sender: message.sender, updated: true }] })
  lark.mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ thread_id: 'omt_thread', has_more: false, messages: [] })
  await readFeishu(commands, event, 'feishu/source/thread/a%2Fb%2Bnext%3D', 2)
  expect(lark.mock.lastCall![0]).toContain('a/b+next=')
})
it('skips and counts a topic message it cannot read, and reads the others', async () => {
  vi.spyOn(commands, 'lark').mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ thread_id: 'omt_thread', has_more: false,
    messages: [{ ...message, message_id: 'om_reply', thread_id: 'omt_thread' }, { ...message, message_id: 'om_odd',
      sender: { sender_type: 'app' } }] })
  const page = await readFeishu(commands, event, 'feishu/source/thread', 20)
  expect(page).toMatchObject({ skipped: 1, messages: [{ message_id: 'om_reply' }] })
})
it('rejects unrelated paths, missing sources, cross-chat results, and incomplete pagination', async () => {
  const lark = vi.spyOn(commands, 'lark')
  await expect(readFeishu(commands, event, 'feishu/other/thread', 20)).rejects.toThrow('source trigger')
  await expect(readFeishu(commands, event, 'feishu/source/root/cursor', 20)).rejects.toThrow('Use feishu')
  expect(lark).not.toHaveBeenCalled()
  lark.mockResolvedValueOnce({ items: [] })
  await expect(readFeishu(commands, event, 'feishu/source/message', 20)).rejects.toThrow('unavailable')
  lark.mockResolvedValueOnce({ items: [{ ...source, chat_id: 'oc_elsewhere' }] })
  await expect(readFeishu(commands, event, 'feishu/source/root', 20)).rejects.toThrow('chat does not match')
  lark.mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ thread_id: 'omt_thread', has_more: true, messages: [] })
  await expect(readFeishu(commands, event, 'feishu/source/thread', 20)).rejects.toThrow('did not advance')
})
it('reports absent parent/thread and deleted content explicitly', async () => {
  const lark = vi.spyOn(commands, 'lark').mockResolvedValue({ items: [{ message_id: 'om_source', chat_id: 'oc_chat' }] })
  expect(await readFeishu(commands, event, 'feishu/source/thread', 20)).toMatchObject({ status: 'no_thread', next_resource: null })
  expect(await readFeishu(commands, event, 'feishu/source/parent', 20)).toMatchObject({ status: 'no_parent', message: null })
  lark.mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ messages: [{ ...message, deleted: true }] })
  expect(await readFeishu(commands, event, 'feishu/source/root', 20)).toMatchObject({ status: 'deleted' })
})

it('reads only the source message link and rejects absent, deleted or cross-chat results', async () => {
  const linked = { message_id: 'om_source', chat_id: 'oc_chat', message_app_link: 'https://applink.feishu.cn/client/message/link/open?token=source' }
  const lark = vi.spyOn(commands, 'lark').mockResolvedValue({ messages: [{ ...linked, message_id: 'om_other', message_app_link: 'https://example.com/other' }, linked] })
  await expect(readFeishuLink(commands, event)).resolves.toBe(linked.message_app_link)
  expect(lark).toHaveBeenCalledWith(['im', '+messages-mget', '--message-ids', 'om_source', '--no-reactions'])
  for (const row of [{ ...linked, deleted: true }, { ...linked, chat_id: 'oc_elsewhere' }, { ...linked, message_app_link: undefined }, { ...linked, message_id: 'om_other' }]) {
    lark.mockResolvedValueOnce({ messages: [row] })
    await expect(readFeishuLink(commands, event)).rejects.toThrow('unavailable')
  }
})
it('reads a topic page as messages a model reads: id, author, ISO time, text and the message each answers', async () => {
  vi.spyOn(commands, 'lark').mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ thread_id: 'omt_thread', has_more: false,
    messages: [{ ...message, message_id: 'om_reply', thread_id: 'omt_thread', parent_id: 'om_root', message_app_link: 'https://applink.feishu.cn/x' },
      { ...message, message_id: 'om_bot', sender: { id: 'cli_bot', name: 'Bot', sender_type: 'app' } }] })
  expect(await feishuRead(commands, event, 'feishu/source/thread', 20)).toEqual({ status: 'available', thread_id: 'omt_thread', next_resource: null,
    messages: [{ id: 'om_reply', from: 'User', at: new Date('2026-09-11 12:00').toISOString(), text: message.content, reply_to: 'om_root',
      url: 'https://applink.feishu.cn/x' }, { id: 'om_bot', from: 'Bot', at: new Date('2026-09-11 12:00').toISOString(), text: message.content, bot: true }] })
})
it('reads the chat around a message by time: five before it, the message and five after, then earlier pages', async () => {
  const at = Date.parse('2026-09-11T12:00:00Z')
  const item = (n: number) => ({ message_id: `om_${n}`, chat_id: 'oc_chat', create_time: String(at + n * 1000), sender: { id: 'ou_user', sender_type: 'user' },
    body: { content: JSON.stringify({ text: `message ${n}` }) } })
  const lark = vi.spyOn(commands, 'lark').mockResolvedValueOnce({ items: [source] })
    .mockResolvedValueOnce({ items: [0, -1, -2, -3, -4, -5].map(item), has_more: true, page_token: 'older' })
    .mockResolvedValueOnce({ items: [0, 1, 2].map(item), has_more: false })
  const ref = { ...event, at: new Date(at).toISOString() }
  const around = await feishuRead(commands, ref, 'feishu/source/around', 20)
  expect(around).toMatchObject({ status: 'available', next_resource: 'feishu/source/around/older' })
  expect('messages' in around && around.messages.map(message => [message.id, message.text]))
    .toEqual([-5, -4, -3, -2, -1, 0, 1, 2].map(n => [`om_${n}`, `message ${n}`]))
  const params = (call: number) => JSON.parse(lark.mock.calls[call]![0].at(-1)!) as Record<string, unknown>
  expect(params(1)).toMatchObject({ container_id: 'oc_chat', sort_type: 'ByCreateTimeDesc', end_time: String(at / 1000), page_size: 6 })
  expect(params(2)).toMatchObject({ sort_type: 'ByCreateTimeAsc', start_time: String(at / 1000), page_size: 6 })
  lark.mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ items: [-6, -7].map(item), has_more: false })
  const earlier = await feishuRead(commands, ref, 'feishu/source/around/older', 20)
  expect('messages' in earlier && earlier.messages.map(message => message.id)).toEqual(['om_-7', 'om_-6'])
  expect(params(4)).toMatchObject({ page_token: 'older', page_size: 10 })
})
