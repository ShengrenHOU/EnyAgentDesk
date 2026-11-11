/** Synthetic native-command contract tests; no private account reads. */
import { afterEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { key } from '../src/core/index.ts'
import { readLarkImContext } from '../src/sources/activity-lark.ts'
import { testDeployment } from './fixtures/deployment.ts'

const binding = { expectedUserId: 'ou_reader', cli: 'synthetic-lark', configDir: 'synthetic-user-config' }
const request = { anchor: { provider: 'feishu-messages', account: 'ou_reader', conversation: 'oc_one', message: 'om_one', version: 'old', partial: false },
  start: '2026-11-01T10:00:00.123Z', end: '2026-11-01T11:00:00.456Z', anchorText: 'Old request' }
const original = (fields: object = {}) => ({ message_id: 'om_one', chat_id: 'oc_one', msg_type: 'text',
  create_time: String(Date.parse('2026-11-01T10:01:00Z')), body: { content: '{"text":"Old request"}' },
  sender: { id: 'ou_sender', sender_type: 'user', id_type: 'open_id' }, ...fields })
const envelope = (data: unknown) => ({ ok: true, identity: 'user', data })
function fixture(handler: (args: string[]) => unknown | Promise<unknown>) {
  let user = binding.expectedUserId
  const run = vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_cli, args) => JSON.stringify(args[0] === 'auth'
    ? { identities: { user: { status: 'ready', openId: user } } } : envelope(await handler(args))))
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const abort = new AbortController()
  return { run, abort, setUser: (id: string) => { user = id }, read: (cursor?: string) => readLarkImContext(commands, binding, request, cursor, abort.signal) }
}
afterEach(() => vi.restoreAllMocks())
const mget = (args: string[]) => args.includes('/open-apis/im/v1/messages/mget')

it('reads later replies and cancellations in bounded same-chat pages without inventing a thread or snapshot', async () => {
  const f = fixture(args => mget(args) ? { items: [original()] } : JSON.parse(args[args.indexOf('--params') + 1]!).page_token
    ? { items: [original({ message_id: 'om_cancel', body: { content: '{"text":"Cancelled"}' } })], has_more: false }
    : { items: [original({ message_id: 'om_reply', parent_id: 'om_one', root_id: 'om_one', body: { content: '{"text":"Later reply"}' } })], has_more: true, page_token: 'next' })
  const first = await f.read(), second = await f.read(first.next)
  expect(first.messages[0]).toMatchObject({ id: 'om_reply', parent: 'om_one', root: 'om_one', sender: 'ou_sender', senderIdType: 'open_id' })
  expect(second.messages[0]).toMatchObject({ id: 'om_cancel', text: 'Cancelled' })
  expect(second.messages[0]).not.toHaveProperty('root')
  expect(first.consistency).toBe('live_paginated'); expect(first).not.toHaveProperty('snapshot')
  expect(first.gaps).toContain('thread_replies_not_covered')
  expect(f.run.mock.calls.filter(([, args]) => args[0] === 'auth')).toHaveLength(4)
  expect(f.run.mock.calls.filter(([, args]) => mget(args))).toHaveLength(2)
  for (const [, args] of f.run.mock.calls.filter(([, args]) => args.includes('/open-apis/im/v1/messages'))) {
    expect(JSON.parse(args[args.indexOf('--params') + 1]!)).toMatchObject({ container_id_type: 'chat', container_id: 'oc_one',
      start_time: String(Math.floor(Date.parse(request.start) / 1000)), end_time: String(Math.ceil(Date.parse(request.end) / 1000)),
      only_thread_root_messages: false, sort_type: 'ByCreateTimeDesc', page_size: 50 })
    expect(args.slice(-4)).toEqual(['--as', 'user', '--format', 'json'])
  }
})
it.each([false, true])('rereads edited/deleted anchors independently of stale history (%s)', async deleted => {
  const edited = original({ deleted, update_time: '1793531000999', body: { content: '{"text":"Edited request"}' } })
  const f = fixture(args => mget(args) ? { items: [edited] } : { items: [original()], has_more: false })
  const page = await f.read(), text = deleted ? '[Message deleted]' : 'Edited request'
  expect(page.anchor).toMatchObject({ text, version: key('1793531000999', 'text', String(deleted), text), versionBasis: 'source_digest', nativeVersion: '1793531000999' })
  if (deleted) expect(page.gaps).toContain('anchor_deleted')
})
it.each(['history', 'anchor'])('rejects foreign records in %s', async where => {
  const f = fixture(args => mget(args) ? { items: [original(where === 'anchor' ? { chat_id: 'oc_foreign' } : {})] }
    : { items: [original(where === 'history' ? { chat_id: 'oc_foreign' } : {})], has_more: false })
  await expect(f.read()).rejects.toThrow('outside the source conversation')
})
it('rechecks configured account on continuation', async () => {
  const f = fixture(args => mget(args) ? { items: [original()] } : { items: [], has_more: true, page_token: 'next' })
  await f.read(); f.setUser('ou_changed')
  await expect(f.read('next')).rejects.toThrow('does not match')
  expect(f.run.mock.calls.filter(([, args]) => args.includes('/open-apis/im/v1/messages'))).toHaveLength(1)
})
it.each([{ items: [] }, { items: [original({ body: undefined })] }])('reports missing/unreadable anchor rather than accepting retained text', async ({ items }) => {
  const f = fixture(args => mget(args) ? { items } : { items: [], has_more: false })
  const page = await f.read()
  expect(page.anchor).toBeUndefined(); expect(page.gaps).toContain(items.length ? 'anchor_unreadable' : 'anchor_missing')
})
it('propagates cancellation after a pending native read', async () => {
  const f = fixture(() => { f.abort.abort(); return { items: [], has_more: false } })
  await expect(f.read()).rejects.toThrow()
  expect(f.run.mock.calls.filter(([, args]) => mget(args))).toHaveLength(0)
})
it('reports attachments and discards records outside exact millisecond bounds', async () => {
  const f = fixture(args => mget(args) ? { items: [original()] } : { items: [original({ message_id: 'old', create_time: '1' }), original({ message_id: 'at-end', create_time: String(Date.parse(request.end)) }),
    original({ message_id: 'file', msg_type: 'file', body: { content: '{"file_key":"synthetic","file_name":"attachment.txt"}' } })], has_more: false })
  const page = await f.read()
  expect(page.messages.map(item => item.id)).toEqual(['file']); expect(page.messages[0]?.partial).toBe(true)
  expect(page.gaps).toContain('attachments_not_read')
})

it.each(['history', 'mget'])('rejects an actual native account switch after %s before publishing a page', async phase => {
  const f = fixture(args => {
    if ((phase === 'history' && !mget(args)) || (phase === 'mget' && mget(args))) f.setUser('ou_changed')
    return mget(args) ? { items: [original()] } : { items: [original()], has_more: false }
  })
  await expect(f.read()).rejects.toThrow('does not match')
  expect(f.run.mock.calls.filter(([, args]) => args[0] === 'auth')).toHaveLength(2)
})
