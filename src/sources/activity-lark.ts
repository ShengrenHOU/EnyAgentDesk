/** User-identity Lark activity reads; the existing Source controller owns scan scheduling and watermarks. */
import { z } from 'zod'
import { key } from '../core/index.ts'
import { Commands, CliError } from '../infra/commands.ts'
import { family } from '../kv.ts'
import { historyText } from './feishu-trigger.ts'
import type { ContextMessage, ContextPart, ContextPartName } from './kind.ts'
import type { ActivityEvent, ActivityRange, ActivityReaderContext, ActivityScan, LarkActivityBinding } from './activity-types.ts'

const id = z.string().min(1)
const epoch = z.string().regex(/^\d+$/)
const RawMessage = z.object({ message_id: id, chat_id: id, msg_type: id, create_time: epoch, update_time: epoch.optional(),
  deleted: z.boolean().optional(), body: z.object({ content: z.string() }).optional(),
  sender: z.object({ id: z.string(), sender_type: z.string() }),
  root_id: z.string().optional(), parent_id: z.string().optional(), thread_id: z.string().optional(),
  message_app_link: z.url().optional() }).refine(message => message.deleted || message.body, 'Source message has no readable body')
type RawMessage = z.infer<typeof RawMessage>
const MessageBatch = z.object({ items: z.array(RawMessage) })
const SearchMessages = z.object({ messages: z.array(z.object({ message_id: id, chat_id: id,
  chat_name: z.string().optional(), message_app_link: z.url().optional() })), has_more: z.boolean(), page_token: z.string().optional() })
const SearchDocuments = z.object({ results: z.array(z.object({ entity_type: z.string(), result_meta: z.object({
  token: id, doc_types: id, url: z.url(), update_time: z.number().int().nonnegative(),
}), title_highlighted: z.string().optional() })), has_more: z.boolean(), page_token: z.string().optional() })
const Inspected = z.object({ token: id, type: id, url: z.url() })
const DocMetadata = z.object({ document: z.object({ document_id: id, revision_id: z.number().int().nonnegative() }) })
const DocContent = z.object({ document: z.object({ document_id: id, revision_id: z.number().int().nonnegative(), content: z.string(),
  tips: z.string().optional() }) })
const documentVersions = family<{ sourceVersion: string }, [consumer: string, account: string, object: string]>('activity-lark-doc-version:')
const MAX_EVENT_TEXT = 20_000, CONTEXT_CHARS = 12_000
const json = (value: string): unknown => {
  try { return JSON.parse(value) }
  catch { throw new Error('Lark activity returned invalid JSON') }
}
/** Bind reads to the configured user without making the bot CLI or worker environment user-capable. */
async function userReader(commands: Commands, binding: LarkActivityBinding, active = () => {}) {
  const scoped = commands.withEnvironment({ LARKSUITE_CLI_CONFIG_DIR: binding.configDir })
  // Owner reads resolve their own CLI so they keep working when the Feishu bot Source is off.
  const cli = binding.cli || scoped.deployment.feishu?.cli
  if (!cli) throw new Error('Lark activity requires the configured native lark-cli executable')
  active()
  // The CLI refreshes a needs_refresh token on its next user API call.
  const auth = z.object({ identities: z.object({ user: z.object({ status: z.enum(['ready', 'needs_refresh']), openId: id }) }) })
    .parse(json(await scoped.run(cli, ['auth', 'status', '--json'])))
  active()
  if (auth.identities.user.openId !== binding.expectedUserId) throw new Error('Lark activity user does not match the configured account')
  return async <T>(schema: z.ZodType<T>, args: string[]): Promise<T> => {
    active()
    const envelope = z.object({ ok: z.boolean(), identity: z.string().optional(), data: z.unknown().optional(),
      error: z.object({ code: z.number().optional(), type: z.string().optional(), subtype: z.string().optional() }).optional() })
      .parse(json(await scoped.run(cli, [...args, '--as', 'user', '--format', 'json'])))
    active()
    if (!envelope.ok) throw new CliError(`Lark activity read failed: ${envelope.error?.subtype ?? envelope.error?.type ?? 'unknown'}`, envelope.error?.code)
    if (envelope.identity !== 'user') throw new Error('Lark activity returned an unexpected identity')
    return schema.parse(envelope.data)
  }
}
type UserRead = Awaited<ReturnType<typeof userReader>>
function active(ctx: ActivityReaderContext) { ctx.signal.throwIfAborted(); ctx.assertActive() }
function rangeTimes(range: ActivityRange): [number, number] {
  const start = Date.parse(range.start), end = Date.parse(range.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('Activity scan needs a valid fixed time range')
  return [start, end]
}
function nextPage(result: { has_more: boolean; page_token?: string }, seen: Set<string>): string | undefined {
  if (!result.has_more) return undefined
  const token = result.page_token
  if (!token || seen.has(token)) throw new Error('Lark activity pagination did not advance; coverage is incomplete')
  seen.add(token)
  return token
}
const messageTime = (message: RawMessage) => new Date(Number(message.update_time ?? message.create_time)).toISOString()
const originalText = (message: RawMessage) => message.deleted ? '[Message deleted]' : historyText(message)
function messageView(message: RawMessage): ContextMessage {
  return { id: message.message_id, from: message.sender.id, at: messageTime(message), text: originalText(message),
    ...message.sender.sender_type !== 'user' ? { bot: true } : {}, ...message.deleted ? { deleted: true } : {},
    ...message.parent_id ? { reply_to: message.parent_id } : {}, ...message.message_app_link ? { url: message.message_app_link } : {} }
}
function messageContext(items: RawMessage[], status = 'available', next?: string): ContextPart {
  const views = items.map(messageView)
  const partial = views.some(message => message.text.length > CONTEXT_CHARS) || items.some(message => !['text', 'system'].includes(message.msg_type))
  return { messages: views.map(message => ({ ...message, text: message.text.slice(0, CONTEXT_CHARS) })), ...next ? { next } : {}, status,
    body: { status, ...partial ? { contentPartial: true } : {} } }
}
async function messages(read: UserRead, ids: string[]): Promise<RawMessage[]> {
  const result = await read(MessageBatch, ['api', 'GET', '/open-apis/im/v1/messages/mget', '--params', JSON.stringify({ message_ids: ids })])
  if (result.items.some(message => !ids.includes(message.message_id)) || ids.some(id => !result.items.some(message => message.message_id === id))) {
    throw new Error('Lark did not return every requested source message')
  }
  return result.items
}

/** Discover all indexed messages in a fixed window, using raw milliseconds and body hashes for durable versions. */
export async function scanLarkMessages(ctx: ActivityReaderContext, binding: LarkActivityBinding, range: ActivityRange): Promise<ActivityScan> {
  const [start, end] = rangeTimes(range)
  // Lark search rejects fractional epoch seconds; widen boundaries so subsecond events are not lost.
  const searchTime = (value: number) => new Date(value * 1000).toISOString().replace('.000Z', '+00:00')
  const read = await userReader(ctx.source.commands.withSignal(ctx.signal), binding, () => active(ctx))
  const pages = new Set<string>(), objects = new Set<string>(), seen = new Set<string>()
  let cursor: string | undefined, records = 0, contentPartial = 0
  do {
    const page = await read(SearchMessages, ['im', '+messages-search', '--query', '', '--start', searchTime(Math.floor(start / 1000)), '--end', searchTime(Math.ceil(end / 1000)),
      '--page-size', '50', '--no-reactions', ...cursor ? ['--page-token', cursor] : []])
    if (page.messages.length) {
      const originals = await messages(read, [...new Set(page.messages.map(message => message.message_id))])
      for (const message of originals) {
        const discovered = page.messages.find(item => item.message_id === message.message_id)!
        if (message.chat_id !== discovered.chat_id) throw new Error('Lark message does not belong to its discovered conversation')
        const bot = ctx.source.commands.deployment.feishu
        if (bot && (message.sender.id === bot.botId || message.sender.id === bot.appId)) continue
        const full = originalText(message), version = key(message.update_time ?? message.create_time, message.msg_type, String(!!message.deleted), full)
        const eventId = key(message.message_id, version)
        if (seen.has(eventId)) continue
        seen.add(eventId); objects.add(message.chat_id)
        const partial = full.length > MAX_EVENT_TEXT || !['text', 'system'].includes(message.msg_type)
        active(ctx)
        await ctx.emit({ provider: 'feishu-messages', accountId: binding.expectedUserId, objectId: message.chat_id, id: message.message_id,
          threadId: message.root_id || message.thread_id || message.message_id, version,
          at: messageTime(message), text: full.slice(0, MAX_EVENT_TEXT), reference: `feishu message ${message.message_id}`,
          locator: { provider: 'feishu-messages', chatId: message.chat_id, messageId: message.message_id },
          ...discovered.chat_name ? { label: discovered.chat_name } : {}, senderId: message.sender.id,
          ...(discovered.message_app_link ?? message.message_app_link) ? { url: discovered.message_app_link ?? message.message_app_link } : {},
          ...partial ? { contentPartial: true } : {} })
        active(ctx); records++; if (partial) contentPartial++
      }
    }
    cursor = nextPage(page, pages)
  } while (cursor)
  active(ctx)
  return { records, objects: objects.size, complete: true, ...contentPartial ? { contentPartial } : {} }
}

/** Discover recently modified indexed objects, independently of who edited or opened them. */
export async function scanLarkDocuments(ctx: ActivityReaderContext, binding: LarkActivityBinding, range: ActivityRange): Promise<ActivityScan> {
  const [start, end] = rangeTimes(range)
  const read = await userReader(ctx.source.commands.withSignal(ctx.signal), binding, () => active(ctx))
  const pages = new Set<string>(), objects = new Set<string>()
  let cursor: string | undefined, records = 0, contentPartial = 0, previous = Infinity, reachedStart = false
  do {
    const page = await read(SearchDocuments, ['drive', '+search', '--query', '', '--sort', 'edit_time', '--page-size', '20',
      ...cursor ? ['--page-token', cursor] : []])
    for (const found of page.results) {
      const meta = found.result_meta, at = meta.update_time * 1000
      if (at > previous) throw new Error('Lark documents are not in edit-time order; coverage is incomplete')
      previous = at
      if (at < start) { reachedStart = true; break }
      if (at > end) continue
      const locator = found.entity_type === 'WIKI' || new URL(meta.url).pathname.startsWith('/wiki/')
        ? await read(Inspected, ['drive', '+inspect', '--url', meta.url]) : { token: meta.token, type: meta.doc_types.toLowerCase(), url: meta.url }
      const objectId = `${locator.type}:${locator.token}`
      if (objects.has(objectId)) continue
      objects.add(objectId)
      const cacheKey = documentVersions(ctx.consumerId, binding.expectedUserId, objectId)
      let sourceVersion = `modified:${meta.update_time}`
      if (locator.type === 'docx') {
        const current = await read(DocMetadata, ['api', 'GET', `/open-apis/docx/v1/documents/${encodeURIComponent(locator.token)}`])
        if (current.document.document_id !== locator.token) throw new Error('Lark returned a different source document')
        sourceVersion = `revision:${current.document.revision_id}`
      }
      if (ctx.source.state.get(cacheKey)?.sourceVersion === sourceVersion) continue
      let text = `${locator.type} document modified at ${new Date(at).toISOString()}.`, partial = true
      if (locator.type === 'docx') {
        const full = await read(DocContent, ['docs', '+fetch', '--doc', locator.token, '--doc-format', 'markdown'])
        if (full.document.document_id !== locator.token) throw new Error('Lark returned a different source document')
        sourceVersion = `revision:${full.document.revision_id}`
        text = full.document.content; partial = text.length > MAX_EVENT_TEXT || !!full.document.tips
      }
      const version = key(sourceVersion, text), label = found.title_highlighted?.replace(/<\/?h[b]?>/g, '')
      active(ctx)
      await ctx.emit({ provider: 'feishu-documents', accountId: binding.expectedUserId, objectId,
        id: locator.token, version, at: new Date(at).toISOString(),
        text: text.slice(0, MAX_EVENT_TEXT), reference: locator.url, locator: { provider: 'feishu-documents', ...locator },
        url: locator.url, ...label ? { label } : {}, ...partial ? { contentPartial: true } : {} })
      active(ctx)
      ctx.source.state.set(cacheKey, { sourceVersion }); records++; if (partial) contentPartial++
    }
    if (reachedStart) break
    cursor = nextPage(page, pages)
  } while (cursor)
  active(ctx)
  return { records, objects: objects.size, complete: true, ...contentPartial ? { contentPartial } : {},
    detail: 'Search-index edit-time discovery; search indexing delay is not a complete change-log guarantee' }
}

/** Reads only the native object retained by an activity event; source content grants no execution authority. */
export async function readLarkActivityContext(commands: Commands, binding: LarkActivityBinding, event: ActivityEvent,
  part: ContextPartName, cursor?: string): Promise<ContextPart> {
  if (event.accountId !== binding.expectedUserId) throw new Error('Activity event belongs to a different Lark account')
  const read = await userReader(commands, binding)
  const locator = event.locator
  if (locator.provider === 'feishu-messages' && event.provider === locator.provider) {
    const source = (await messages(read, [locator.messageId]))[0]!
    if (source.chat_id !== locator.chatId) throw new Error('Activity source message does not match its retained conversation')
    if (part !== 'thread') {
      if (cursor) throw new Error('Only thread context has a continuation cursor')
      const target = part === 'root' ? source.root_id ?? source.message_id : source.parent_id
      if (!target) return { messages: [], body: { status: 'no_parent' }, status: 'no_parent' }
      const result = target === source.message_id ? source : (await messages(read, [target]))[0]!
      if (result.chat_id !== locator.chatId) throw new Error('Lark returned context outside the source conversation')
      return messageContext([result], result.deleted ? 'deleted' : 'available')
    }
    if (!source.thread_id) {
      if (cursor) throw new Error('This activity message has no thread continuation')
      return messageContext([source], 'message_only')
    }
    const page = await read(z.object({ items: z.array(RawMessage), has_more: z.boolean(), page_token: z.string().optional() }),
      ['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify({ container_id_type: 'thread', container_id: source.thread_id,
        page_size: 50, sort_type: 'ByCreateTimeAsc', ...cursor ? { page_token: cursor } : {} })])
    if (page.items.some(message => message.chat_id !== locator.chatId || message.thread_id !== source.thread_id)) {
      throw new Error('Lark returned context outside the source thread')
    }
    const next = nextPage(page, new Set(cursor ? [cursor] : []))
    return messageContext(page.items, 'available', next)
  }
  if (locator.provider !== 'feishu-documents' || event.provider !== locator.provider) throw new Error('Not a Lark activity locator')
  if (part === 'parent') return { messages: [], body: { status: 'no_parent' }, status: 'no_parent' }
  if (locator.type !== 'docx') return { messages: [], status: 'content_not_read',
    body: { status: 'content_not_read', type: locator.type, reference: locator.url, detail: 'Use the existing resource-type Skill to read its structured content' } }
  if (cursor && !/^\d+:\d+$/.test(cursor)) throw new Error('Invalid document revision/offset continuation')
  const full = await read(DocContent, ['docs', '+fetch', '--doc', locator.token, '--doc-format', 'markdown'])
  if (full.document.document_id !== locator.token) throw new Error('Lark returned a different source document')
  const [revision, position] = cursor?.split(':') ?? []
  if (revision && Number(revision) !== full.document.revision_id) throw new Error('Lark document changed during pagination; restart the source read')
  const offset = position ? Number(position) : 0, text = full.document.content.slice(offset, offset + CONTEXT_CHARS)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > full.document.content.length) throw new Error('Invalid document continuation offset')
  return { messages: [{ id: locator.token, from: 'Lark document', at: event.at, text, url: locator.url }],
    ...offset + text.length < full.document.content.length ? { next: `${full.document.revision_id}:${offset + text.length}` } : {},
    body: { status: 'available', revision_id: full.document.revision_id, ...full.document.tips ? { tips: full.document.tips, contentPartial: true } : {} } }
}
