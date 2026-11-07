/** Activity reads keep user identity, native object versions, coverage and original-context boundaries explicit. */
import { afterEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { scanLarkDocuments, scanLarkMessages, readLarkActivityContext } from '../src/sources/activity-lark.ts'
import type { ActivityEvent, ActivityReaderContext } from '../src/sources/activity-types.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { testDeployment } from './fixtures/deployment.ts'

const binding = { expectedUserId: 'ou_reader' }
const range = { start: '2026-11-01T10:00:00Z', end: '2026-11-01T11:00:00Z' }
const end = Date.parse(range.end) / 1000
const envelope = (data: unknown) => ({ ok: true, identity: 'user', data })
const original = (fields: object = {}) => ({ message_id: 'om_one', chat_id: 'oc_one', msg_type: 'text',
  create_time: '1793527200123', update_time: '1793527200456', body: { content: '{"text":"Original message."}' },
  sender: { id: 'ou_sender', sender_type: 'user' }, ...fields })
const discovered = (id = 'om_one', chat = 'oc_one') => ({ message_id: id, chat_id: chat, chat_name: 'Synthetic conversation' })
const document = (token: string, type: string, time: number, entity = 'DOC') => ({ entity_type: entity,
  title_highlighted: '<h>Synthetic</h> document', result_meta: { token, doc_types: type,
    url: `https://example.feishu.cn/${entity === 'WIKI' ? 'wiki' : type.toLowerCase()}/${token}`, update_time: time } })
function fixture(handler: (args: string[]) => unknown | Promise<unknown>, user = binding.expectedUserId, status = 'ready') {
  const run = vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_cli, args) => JSON.stringify(args[0] === 'auth'
    ? { identities: { user: { status, openId: user } } } : await handler(args)))
  const environment = vi.spyOn(Commands.prototype, 'withEnvironment')
  const commands = new Commands(() => testDeployment({ feishu: { cli: 'synthetic-lark', appId: 'cli_test', botId: 'ou_bot',
    name: 'Test bot', brand: 'feishu' } }), { LARKSUITE_CLI_CONFIG_DIR: 'synthetic-bot-config' }, new AbortController().signal)
  const values = new Map<string, unknown>()
  const source = { commands, state: { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value) } } as unknown as SourceContext
  const events: ActivityEvent[] = [], abort = new AbortController()
  const ctx: ActivityReaderContext = { source, signal: abort.signal, consumerId: 'monitor-test', assertActive: vi.fn(),
    emit: vi.fn(async (event: ActivityEvent): Promise<'stored' | 'duplicate'> => { events.push(event); return 'stored' }) }
  return { ctx, commands, run, environment, events, values, abort }
}
afterEach(() => vi.restoreAllMocks())

it('lets the CLI refresh a renewable user token on the next actual read', async () => {
  const f = fixture(() => envelope({ messages: [], has_more: false }), binding.expectedUserId, 'needs_refresh')
  expect(await scanLarkMessages(f.ctx, binding, range)).toMatchObject({ complete: true })
  expect(f.run.mock.calls.some(([, args]) => args.includes('+messages-search'))).toBe(true)
})

it('still blocks an unavailable user identity before any API read', async () => {
  const f = fixture(() => { throw new Error('Unexpected API read') }, binding.expectedUserId, 'not_configured')
  await expect(scanLarkMessages(f.ctx, binding, range)).rejects.toThrow()
  expect(f.run).toHaveBeenCalledTimes(1)
})

it('reads every search page as the bound user and retains raw millisecond versions and native message IDs', async () => {
  const f = fixture(args => {
    if (args.includes('+messages-search')) return envelope({ messages: [discovered(args.includes('--page-token') ? 'om_two' : 'om_one')],
      has_more: !args.includes('--page-token'), page_token: 'page-two' })
    const ids = JSON.parse(args[args.indexOf('--params') + 1]!).message_ids as string[]
    return envelope({ items: ids.map(message_id => original({ message_id })) })
  })
  expect(await scanLarkMessages(f.ctx, binding, range)).toMatchObject({ complete: true, records: 2, objects: 1 })
  expect(f.environment).toHaveBeenCalledWith({ LARKSUITE_CLI_CONFIG_DIR: undefined })
  expect(f.events.map(event => event.id)).toEqual(['om_one', 'om_two'])
  expect(f.events[0]).toMatchObject({ objectId: 'oc_one', accountId: 'ou_reader', at: '2026-11-01T10:00:00.456Z', text: 'Original message.' })
  for (const [, args] of f.run.mock.calls.filter(([, args]) => args[0] !== 'auth')) {
    expect(args.slice(-4)).toEqual(['--as', 'user', '--format', 'json'])
    if (args.includes('+messages-search')) expect(args).toEqual(expect.arrayContaining(['--query', '', '--start', '2026-11-01T10:00:00+00:00', '--end', '2026-11-01T11:00:00+00:00']))
  }
})

it('ignores only this system bot’s own messages and retains other bots as evidence', async () => {
  const f = fixture(args => {
    if (args.includes('+messages-search')) return envelope({ messages: [discovered('own'), discovered('other')], has_more: false })
    return envelope({ items: [original({ message_id: 'own', sender: { id: 'ou_bot', sender_type: 'app' } }),
      original({ message_id: 'other', sender: { id: 'ou_other_bot', sender_type: 'app' } })] })
  })
  expect(await scanLarkMessages(f.ctx, binding, range)).toMatchObject({ complete: true, records: 1 })
  expect(f.events.map(item => item.id)).toEqual(['other'])
})

it('widens fractional search bounds to the whole seconds accepted by the live API', async () => {
  const f = fixture(() => envelope({ messages: [], has_more: false }))
  await scanLarkMessages(f.ctx, binding, { start: '2026-11-01T10:00:00.123Z', end: '2026-11-01T11:00:00.456Z' })
  const args = f.run.mock.calls.find(([, args]) => args.includes('+messages-search'))![1]
  expect(args).toEqual(expect.arrayContaining(['--start', '2026-11-01T10:00:00+00:00', '--end', '2026-11-01T11:00:01+00:00']))
})

it('changes a message version when its body changes within the same displayed minute', async () => {
  let content = 'First version.'
  const f = fixture(args => envelope(args.includes('+messages-search')
    ? { messages: [discovered()], has_more: false }
    : { items: [original({ body: { content: JSON.stringify({ text: content }) } })] }))
  await scanLarkMessages(f.ctx, binding, range)
  content = 'Second version.'
  await scanLarkMessages(f.ctx, binding, range)
  expect(f.events[0]!.id).toBe(f.events[1]!.id)
  expect(f.events[0]!.version).not.toBe(f.events[1]!.version)
})

it('rejects the wrong account before discovery and never changes the original bot Commands instance', async () => {
  const f = fixture(() => { throw new Error('No discovery allowed') }, 'ou_other')
  await expect(scanLarkMessages(f.ctx, binding, range)).rejects.toThrow('does not match')
  expect(f.run).toHaveBeenCalledTimes(1)
  expect(f.events).toEqual([])
})

it.each([
  { ok: true, identity: 'bot', data: { messages: [], has_more: false } },
  { ok: false, identity: 'user', error: { type: 'authorization', subtype: 'missing_scope', code: 99991679 } },
])('does not treat a wrong identity or access error as an empty source', async response => {
  const f = fixture(() => response)
  await expect(scanLarkMessages(f.ctx, binding, range)).rejects.toThrow()
  expect(f.events).toEqual([])
})

it('keeps a partial scan failed after a later page fails instead of acknowledging complete coverage', async () => {
  const f = fixture(args => {
    if (args.includes('+messages-search')) {
      if (args.includes('--page-token')) throw new Error('Source unavailable')
      return envelope({ messages: [discovered()], has_more: true, page_token: 'next' })
    }
    return envelope({ items: [original()] })
  })
  await expect(scanLarkMessages(f.ctx, binding, range)).rejects.toThrow('Source unavailable')
  expect(f.events).toHaveLength(1)
  expect(f.values.size).toBe(0)
})

it('refuses stalled pagination and missing raw originals rather than silently losing candidates', async () => {
  const f = fixture(() => envelope({ messages: [], has_more: true, page_token: 'same' }))
  await expect(scanLarkMessages(f.ctx, binding, range)).rejects.toThrow('pagination did not advance')
  f.run.mockImplementation(async (_cli, args) => JSON.stringify(args[0] === 'auth'
    ? { identities: { user: { status: 'ready', openId: 'ou_reader' } } }
    : envelope(args.includes('+messages-search') ? { messages: [discovered()], has_more: false } : { items: [] })))
  await expect(scanLarkMessages(f.ctx, binding, range)).rejects.toThrow('every requested source message')
})

it('stops before emitting a batch if pause/stop changes while its raw read is in flight', async () => {
  let paused = false
  const f = fixture(args => {
    if (args.includes('+messages-search')) return envelope({ messages: [discovered()], has_more: false })
    paused = true
    return envelope({ items: [original()] })
  })
  vi.mocked(f.ctx.assertActive).mockImplementation(() => { if (paused) throw new Error('Monitor paused') })
  await expect(scanLarkMessages(f.ctx, binding, range)).rejects.toThrow('Monitor paused')
  expect(f.events).toEqual([])
})

it('discovers by global modification order, resolves Wiki aliases and stops only after the lower time bound', async () => {
  const f = fixture(args => {
    if (args.includes('+search')) return envelope(args.includes('--page-token')
      ? { results: [document('old', 'DOCX', end - 7200)], has_more: true, page_token: 'older' }
      : { results: [document('wiki-alias', 'DOCX', end - 2, 'WIKI'), document('canonical', 'DOCX', end - 3)], has_more: true, page_token: 'next' })
    if (args.includes('+inspect')) return envelope({ token: 'canonical', type: 'docx', url: 'https://example.feishu.cn/docx/canonical' })
    if (args[0] === 'api') return envelope({ document: { document_id: 'canonical', revision_id: 7 } })
    return envelope({ document: { document_id: 'canonical', revision_id: 7, content: 'Verified source document.' } })
  })
  expect(await scanLarkDocuments(f.ctx, binding, range)).toMatchObject({ complete: true, records: 1, objects: 1 })
  expect(f.events[0]).toMatchObject({ id: 'canonical', objectId: 'docx:canonical', text: 'Verified source document.',
    locator: { provider: 'feishu-documents', token: 'canonical', type: 'docx' } })
  const searches = f.run.mock.calls.filter(([, args]) => args.includes('+search'))
  expect(searches).toHaveLength(2)
  for (const [, args] of searches) {
    expect(args).toEqual(expect.arrayContaining(['--query', '', '--sort', 'edit_time']))
    for (const wrong of ['--edited-since', '--opened-since', '--doc-types']) expect(args).not.toContain(wrong)
  }
})

it('reads full Docx content only for changed revisions, including two revisions in the same source second', async () => {
  let revision = 7
  const f = fixture(args => {
    if (args.includes('+search')) return envelope({ results: [document('canonical', 'DOCX', end - 2)], has_more: false })
    return envelope({ document: { document_id: 'canonical', revision_id: revision, ...args[0] === 'docs' ? { content: `Revision ${revision}` } : {} } })
  })
  await scanLarkDocuments(f.ctx, binding, range)
  await scanLarkDocuments(f.ctx, binding, range)
  expect(f.run.mock.calls.filter(([, args]) => args.includes('+fetch'))).toHaveLength(1)
  revision = 8
  await scanLarkDocuments(f.ctx, binding, range)
  expect(f.events).toHaveLength(2)
  expect(f.events[0]!.version).not.toBe(f.events[1]!.version)
})

it('never acknowledges a document version before its event is durably accepted', async () => {
  const f = fixture(args => envelope(args.includes('+search')
    ? { results: [document('sheet', 'SHEET', end - 2)], has_more: false } : {}))
  vi.mocked(f.ctx.emit).mockRejectedValue(new Error('Storage failed'))
  await expect(scanLarkDocuments(f.ctx, binding, range)).rejects.toThrow('Storage failed')
  expect(f.values.size).toBe(0)
})

it('reports structured document content as unread instead of inventing Sheet or Base text', async () => {
  const f = fixture(() => envelope({ results: [document('sheet', 'SHEET', end - 2)], has_more: false }))
  expect(await scanLarkDocuments(f.ctx, binding, range)).toMatchObject({ complete: true, contentPartial: 1 })
  expect(f.events[0]!.contentPartial).toBe(true)
  expect(await readLarkActivityContext(f.commands, binding, f.events[0]!, 'thread')).toMatchObject({
    messages: [], status: 'content_not_read', body: { type: 'sheet' } })
})

it('rejects unordered document pages because a cutoff would lose newer changes', async () => {
  const f = fixture(() => envelope({ results: [document('sheet', 'SHEET', end - 5), document('newer', 'SHEET', end - 2)], has_more: false }))
  await expect(scanLarkDocuments(f.ctx, binding, range)).rejects.toThrow('not in edit-time order')
})

const messageEvent: ActivityEvent = { provider: 'feishu-messages', accountId: 'ou_reader', objectId: 'oc_one', id: 'om_one',
  version: 'version', at: range.start, text: 'Retained evidence', reference: 'feishu message om_one',
  locator: { provider: 'feishu-messages', chatId: 'oc_one', messageId: 'om_one' } }
it('reads the retained source and refuses a parent from another conversation', async () => {
  const f = fixture(args => envelope({ items: [original({ ...args[args.indexOf('--params') + 1]!.includes('om_parent')
    ? { message_id: 'om_parent', chat_id: 'oc_other' } : { parent_id: 'om_parent' } })] }))
  expect(await readLarkActivityContext(f.commands, binding, messageEvent, 'root')).toMatchObject({ messages: [{ text: 'Original message.' }] })
  await expect(readLarkActivityContext(f.commands, binding, messageEvent, 'parent')).rejects.toThrow('outside the source conversation')
})

it('does not use a retained locator from another account', async () => {
  const f = fixture(() => { throw new Error('No read allowed') })
  await expect(readLarkActivityContext(f.commands, binding, { ...messageEvent, accountId: 'ou_other' }, 'root')).rejects.toThrow('different Lark account')
  expect(f.run).not.toHaveBeenCalled()
})

it('exposes an oversized original as a bounded partial rather than claiming the excerpt is the full message', async () => {
  const f = fixture(() => envelope({ items: [original({ body: { content: JSON.stringify({ text: 'x'.repeat(13000) }) } })] }))
  const context = await readLarkActivityContext(f.commands, binding, messageEvent, 'root')
  expect(context.messages[0]!.text).toHaveLength(12000)
  expect(context.body.contentPartial).toBe(true)
})

it('binds document continuation to the fetched revision so changed pages cannot be silently combined', async () => {
  let revision = 7
  const f = fixture(() => envelope({ document: { document_id: 'canonical', revision_id: revision, content: 'x'.repeat(12001) } }))
  const event: ActivityEvent = { ...messageEvent, provider: 'feishu-documents', objectId: 'docx:canonical', id: 'canonical',
    locator: { provider: 'feishu-documents', token: 'canonical', type: 'docx', url: 'https://example.feishu.cn/docx/canonical' } }
  const first = await readLarkActivityContext(f.commands, binding, event, 'thread')
  expect(first.messages[0]!.text).toHaveLength(12000)
  expect(first.next).toBe('7:12000')
  expect((await readLarkActivityContext(f.commands, binding, event, 'thread', first.next)).messages[0]!.text).toBe('x')
  revision = 8
  await expect(readLarkActivityContext(f.commands, binding, event, 'thread', first.next)).rejects.toThrow('changed during pagination')
})
