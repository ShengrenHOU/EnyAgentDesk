/** User-identity Lark activity reads; the existing Source controller owns scan scheduling and watermarks. */
import { z } from 'zod'
import type { ImContextRequest, ImContextPage, ImContextMessage, ImReadPage, ImReadRequest } from './im-context.ts'
import { key } from '../core/index.ts'
import { Commands } from '../infra/commands.ts'
import { family } from '../kv.ts'
import { feishuTriggerId, historyText } from './feishu-trigger.ts'
import type { ContextMessage, ContextPart, ContextPartName } from './kind.ts'
import { larkUserReader as userReader, nextPage } from './lark-user.ts'
import type { ActivityEvent, ActivityRange, ActivityReaderContext, ActivityScan, LarkActivityBinding } from './activity-types.ts'

const id = z.string().min(1)
const epoch = z.string().regex(/^\d+$/)
const RawMessage = z.object({ message_id: id, chat_id: id, msg_type: id, create_time: epoch, update_time: epoch.optional(),
  deleted: z.boolean().optional(), body: z.object({ content: z.string() }).optional(),
  sender: z.object({ id: z.string(), sender_type: z.string(), id_type: z.string().optional() }),
  root_id: z.string().optional(), parent_id: z.string().optional(), thread_id: z.string().optional(),
  message_app_link: z.url().optional() }).refine(message => message.deleted || message.body, 'Source message has no readable body')
type RawMessage = z.infer<typeof RawMessage>
const MessageBatch = z.object({ items: z.array(RawMessage) })
const RawMessagePage = z.object({ items: z.array(RawMessage), has_more: z.boolean(), page_token: z.string().optional() })
const Chat = z.object({ chat_id: id, name: z.string().optional(), chat_mode: z.string().optional() }).passthrough()
const ChatPage = z.object({ chats: z.array(Chat).nullish(), has_more: z.boolean().optional(), page_token: z.string().optional() })
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
const DocumentMetas = z.object({ metas: z.array(z.object({ doc_token: id, doc_type: id, title: z.string(), latest_modify_time: epoch, url: z.url() })),
  failed_list: z.array(z.object({ token: id, code: z.number() })).default([]) })
const MAX_EVENT_TEXT = 20_000, CONTEXT_CHARS = 12_000
type UserRead = Awaited<ReturnType<typeof userReader>>
function active(ctx: ActivityReaderContext) { ctx.signal.throwIfAborted(); ctx.assertActive() }
function rangeTimes(range: ActivityRange): [number, number] {
  const start = Date.parse(range.start), end = Date.parse(range.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('Activity scan needs a valid fixed time range')
  return [start, end]
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
/** Normalized native message evidence shared by anchored context and anchorless window reads. */
function imView(message: RawMessage, gaps: string[]): ImContextMessage {
  const full = originalText(message)
  const partial = !message.deleted && (!['text', 'system'].includes(message.msg_type) || full.length > MAX_EVENT_TEXT)
  if (partial && !gaps.includes('content_partial')) gaps.push('content_partial')
  if (!message.deleted && !['text', 'system'].includes(message.msg_type) && !gaps.includes('attachments_not_read')) gaps.push('attachments_not_read')
  return { id: message.message_id, version: key(message.update_time ?? message.create_time, message.msg_type, String(!!message.deleted), full),
    versionBasis: 'source_digest', nativeVersion: message.update_time ?? message.create_time,
    text: full.slice(0, MAX_EVENT_TEXT), sender: message.sender.id, senderType: message.sender.sender_type,
    ...message.sender.id_type ? { senderIdType: message.sender.id_type } : {},
    createdAt: new Date(Number(message.create_time)).toISOString(), ...message.update_time ? { updatedAt: new Date(Number(message.update_time)).toISOString() } : {},
    ...message.deleted ? { deleted: true } : {}, ...partial ? { partial: true } : {},
    ...message.parent_id ? { parent: message.parent_id } : {}, ...message.root_id ? { root: message.root_id } : {} }
}
/** Intake filter for bot alert cards in one configured chat; an empty severity list disables it. */
export interface LarkMessageFilter { alertChats: readonly string[]; severities: readonly string[] }
/** A bot card in an alert chat is evidence only when its title names a retained severity; progress states carry no matter. */
function progressCardNoise(message: RawMessage, filter: LarkMessageFilter): boolean {
  if (!filter.alertChats.includes(message.chat_id) || !filter.severities.length) return false
  if (message.msg_type !== 'interactive' || message.sender.sender_type === 'user' || message.deleted) return false
  let content: unknown
  try { content = JSON.parse(originalText(message)) } catch { return false }
  if (!content || typeof content !== 'object' || !('title' in content) || typeof content.title !== 'string') return false
  const title = content.title.trim()
  const labels = [...title.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]!.trim())
  if (!labels.length) return false
  const status = title.replace(/^(?:\[[^\]]+\]\s*)+/, '').trim()
  return ![...labels, status].some(label => filter.severities.includes(label))
}
async function messages(read: UserRead, ids: string[]): Promise<RawMessage[]> {
  const result = await read(MessageBatch, ['api', 'GET', '/open-apis/im/v1/messages/mget', '--params', JSON.stringify({ message_ids: ids })])
  if (result.items.some(message => !ids.includes(message.message_id)) || ids.some(id => !result.items.some(message => message.message_id === id))) {
    throw new Error('Lark did not return every requested source message')
  }
  return result.items
}

/** Discover all indexed messages in a fixed window, using raw milliseconds and body hashes for durable versions. */
export async function scanLarkMessages(ctx: ActivityReaderContext, binding: LarkActivityBinding, range: ActivityRange,
  filter?: LarkMessageFilter): Promise<ActivityScan> {
  const [start, end] = rangeTimes(range)
  // Lark search rejects fractional epoch seconds; widen boundaries so subsecond events are not lost.
  const searchTime = (value: number) => new Date(value * 1000).toISOString().replace('.000Z', '+00:00')
  const read = await userReader(ctx.source.commands.withSignal(ctx.signal), binding, () => active(ctx))
  const pages = new Set<string>(), objects = new Set<string>(), seen = new Set<string>()
  let cursor: string | undefined, records = 0, contentPartial = 0, skipped = 0
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
        if (filter && progressCardNoise(message, filter)) continue
        // The bot collector stores one ID per message and cannot replace an edit or a deletion; keep that evidence here.
        // Intake also stores filtered records, so only a successfully admitted Trigger owns the unchanged message.
        const botTrigger = feishuTriggerId(message.message_id)
        const disposition = ctx.source.triggers.get(botTrigger) ? ctx.source.triggers.disposition(botTrigger) : undefined
        if (disposition && !disposition.filtered) {
          const changed = message.deleted || (message.update_time !== undefined && message.update_time !== message.create_time)
          if (!changed) { skipped++; continue }
        }
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
          senderType: message.sender.sender_type, contentType: message.msg_type,
          ...(message.sender.id_type ? { senderIdType: message.sender.id_type } : {}),
          ...(message.parent_id ? { parentId: message.parent_id } : {}),
          ...(discovered.message_app_link ?? message.message_app_link) ? { url: discovered.message_app_link ?? message.message_app_link } : {},
          ...partial ? { contentPartial: true } : {} })
        active(ctx); records++; if (partial) contentPartial++
      }
    }
    cursor = nextPage(page, pages)
  } while (cursor)
  active(ctx)
  return { records, objects: objects.size, complete: true, ...contentPartial ? { contentPartial } : {},
    ...skipped ? { skipped } : {} }
}

/** Discover recently modified indexed objects, independently of who edited or opened them. */
export async function scanLarkDocuments(ctx: ActivityReaderContext, binding: LarkActivityBinding, range: ActivityRange,
  watched?: readonly { token: string; type: string; url: string }[]): Promise<ActivityScan> {
  const [start, end] = rangeTimes(range)
  if (watched && !watched.length) return { records: 0, objects: 0, complete: true }
  const read = await userReader(ctx.source.commands.withSignal(ctx.signal), binding, () => active(ctx))
  const pages = new Set<string>(), objects = new Set<string>()
  let cursor: string | undefined, records = 0, contentPartial = 0, previous = Infinity, reachedStart = false
  do {
    let page: z.infer<typeof SearchDocuments>
    if (watched) {
      const result = await read(DocumentMetas, ['api', 'POST', '/open-apis/drive/v1/metas/batch_query', '--data',
        JSON.stringify({ request_docs: watched.map(item => ({ doc_token: item.token, doc_type: item.type })), with_url: true })])
      if (result.failed_list.length || result.metas.length !== watched.length) throw new Error('Watched document metadata is incomplete; progress retained')
      if (result.metas.some(meta => !watched.some(item => item.token === meta.doc_token && item.type === meta.doc_type.toLowerCase()))) {
        throw new Error('Document metadata returned an object outside the configured watch scope')
      }
      page = { results: result.metas.map(meta => ({ entity_type: meta.doc_type, title_highlighted: meta.title,
        result_meta: { token: meta.doc_token, doc_types: meta.doc_type, url: meta.url, update_time: Number(meta.latest_modify_time) } })), has_more: false }
    } else page = await read(SearchDocuments, ['drive', '+search', '--query', '', '--sort', 'edit_time', '--page-size', '20',
      ...cursor ? ['--page-token', cursor] : []])
    for (const found of page.results) {
      const meta = found.result_meta, at = meta.update_time * 1000
      if (!watched && at > previous) throw new Error('Lark documents are not in edit-time order; coverage is incomplete')
      previous = at
      if (!watched && at < start) { reachedStart = true; break }
      if (!watched && at > end) continue
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

/** Bounded chat timeline, not a complete thread transcript or an atomic snapshot.
 * Native API contract: https://open.larksuite.com/document/server-docs/im-v1/message/list
 * Raw bounded-query example and regular-group reply limitation: https://github.com/larksuite/cli/issues/2074
 */
export async function readLarkImContext(commands: Commands, binding: LarkActivityBinding,
  request: ImContextRequest, cursor: string | undefined, signal: AbortSignal): Promise<ImContextPage> {
  signal.throwIfAborted()
  const { anchor, start, end } = request
  if (anchor.provider !== 'feishu-messages' || anchor.account !== binding.expectedUserId) {
    throw new Error('IM evidence belongs to a different Lark account or provider')
  }
  const [from, until] = rangeTimes(request)
  const read = await userReader(commands.withSignal(signal), binding, () => signal.throwIfAborted())
  const gaps = ['live_pagination', 'thread_replies_not_covered']
  // A bounded context should include the most recent owner replies before older history.
  const page = await read(z.object({ items: z.array(RawMessage), has_more: z.boolean(), page_token: z.string().optional() }),
    ['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify({ container_id_type: 'chat',
      container_id: anchor.conversation, start_time: String(Math.floor(from / 1000)), end_time: String(Math.ceil(until / 1000)),
      sort_type: 'ByCreateTimeDesc', page_size: 50, only_thread_root_messages: false, ...cursor ? { page_token: cursor } : {} })])
  if (page.items.some(message => message.chat_id !== anchor.conversation)) throw new Error('Lark returned context outside the source conversation')
  const next = nextPage(page, new Set(cursor ? [cursor] : []))
  const view = (message: RawMessage): ImContextMessage => imView(message, gaps)
  // Reread after each history page: history can omit recalled messages and stale anchors.
  // Parse IDs/chat before body validation so unreadable foreign records still fail closed.
  const originals = await read(z.object({ items: z.array(z.object({ message_id: id, chat_id: id }).passthrough()) }),
    ['api', 'GET', '/open-apis/im/v1/messages/mget', '--params', JSON.stringify({ message_ids: [anchor.message] })])
  if (originals.items.some(message => message.message_id !== anchor.message || message.chat_id !== anchor.conversation) || originals.items.length > 1) {
    throw new Error('Lark returned an anchor outside the source conversation or message')
  }
  let current: ImContextMessage | undefined
  const raw = originals.items[0]
  if (!raw) gaps.push('anchor_missing')
  else {
    const parsed = RawMessage.safeParse(raw)
    if (!parsed.success) gaps.push('anchor_unreadable')
    else { current = view(parsed.data); if (current.deleted) gaps.push('anchor_deleted') }
  }
  const items = page.items.filter(message => Number(message.create_time) >= from && Number(message.create_time) < until).map(view)
  // The native CLI account can change independently of Source configuration during a read.
  // Revalidate the actual identity before publishing any collected data.
  await userReader(commands.withSignal(signal), binding, () => signal.throwIfAborted())
  signal.throwIfAborted()
  return { provider: anchor.provider, account: anchor.account, conversation: anchor.conversation, start, end,
    messages: items, ...current ? { anchor: current } : {}, ...next ? { next } : {}, consistency: 'live_paginated', gaps }
}

const NATIVE_CHAT = /^oc_[A-Za-z0-9_-]+$/
const named = (chat: z.infer<typeof Chat>): string => chat.name?.trim() ?? ''
const candidate = (chat: z.infer<typeof Chat>): { id: string; label?: string } =>
  ({ id: chat.chat_id, ...named(chat) ? { label: chat.name!.trim() } : {} })
const exactName = (chats: { id: string; label?: string }[], query: string) => {
  const wanted = query.trim().toLocaleLowerCase()
  return chats.filter(chat => (chat.label ?? '').toLocaleLowerCase() === wanted)
    .filter((chat, index, all) => all.findIndex(other => other.id === chat.id) === index)
}
/**
 * Resolve an exact display name to one visible conversation. A native chat ID bypasses resolution; ambiguous or
 * unknown names return candidates and the caller reads nothing rather than guessing.
 */
export async function resolveLarkConversation(commands: Commands, binding: LarkActivityBinding, query: string, signal: AbortSignal):
Promise<{ resolved: { id: string; label?: string }; resolution: 'native_id' | 'exact_name' } | { candidates: { id: string; label?: string }[] }> {
  signal.throwIfAborted()
  const text = query.trim()
  if (!text) throw new Error('An IM read needs a conversation ID or exact display name')
  if (NATIVE_CHAT.test(text)) return { resolved: { id: text }, resolution: 'native_id' }
  const read = await userReader(commands.withSignal(signal), binding, () => signal.throwIfAborted())
  const found = new Map<string, { id: string; label?: string }>()
  // Group search covers visible group and topic chats; the p2p listing always runs too, because a private
  // conversation and a group can share a display name and a group-only match would silently pick one.
  const search = await read(ChatPage, ['im', '+chat-search', '--query', text, '--page-size', '100', '--page-all', '--page-limit', '5'])
  for (const chat of search.chats ?? []) found.set(chat.chat_id, candidate(chat))
  const listed = await read(ChatPage, ['im', '+chat-list', '--types', 'p2p', '--page-all', '--page-limit', '5', '--page-size', '100'])
  for (const chat of listed.chats ?? []) found.set(chat.chat_id, candidate(chat))
  // A page limit that stopped a list cannot prove the match is unique; return what was seen instead of guessing.
  if (search.has_more || listed.has_more) return { candidates: [...found.values()].slice(0, 10) }
  const exact = exactName([...found.values()], text)
  if (exact.length > 1) return { candidates: exact.slice(0, 10) }
  if (exact.length === 1) return { resolved: exact[0]!, resolution: 'exact_name' }
  return { candidates: [...found.values()].slice(0, 10) }
}

/**
 * Read an ascending native message window without an anchor. The window is half-open in milliseconds; Lark's
 * list API uses whole seconds, so the read widens to whole seconds and filters the exact bounds locally.
 */
export async function readLarkWindow(commands: Commands, binding: LarkActivityBinding, request: ImReadRequest, cursor: string | undefined,
  signal: AbortSignal, resolved: { id: string; label?: string }, resolution: 'native_id' | 'exact_name'): Promise<ImReadPage> {
  signal.throwIfAborted()
  if (resolved.id !== request.conversation) throw new Error('Lark window conversation does not match its resolution')
  const [from, until] = rangeTimes(request)
  const read = await userReader(commands.withSignal(signal), binding, () => signal.throwIfAborted())
  const page = await read(RawMessagePage, ['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify({
    container_id_type: 'chat', container_id: request.conversation,
    start_time: String(Math.floor(from / 1000)), end_time: String(Math.ceil(until / 1000)),
    sort_type: 'ByCreateTimeAsc', page_size: 50, only_thread_root_messages: false,
    ...cursor ? { page_token: cursor } : {} })])
  if (page.items.some(message => message.chat_id !== request.conversation)) {
    throw new Error('Lark returned messages outside the requested conversation')
  }
  const gaps = ['live_pagination', 'thread_replies_not_covered']
  if (from % 1000 !== 0 || until % 1000 !== 0) gaps.push('window_bounds_whole_seconds')
  const keyword = request.keyword?.trim().toLowerCase()
  if (keyword) gaps.push('keyword_local_filter')
  // Match the full native text before imView truncates it: a keyword after the display limit must still select its message.
  const items = page.items.filter(message => {
    const at = Number(message.create_time)
    return at >= from && at < until && (!keyword || originalText(message).toLowerCase().includes(keyword))
  }).map(message => imView(message, gaps))
  const next = page.has_more ? page.page_token : undefined
  if (page.has_more && (!next || next === cursor)) throw new Error('Lark message pagination did not advance; coverage is incomplete')
  const messages = items
  // The native CLI account can change independently of Source configuration during a read.
  await userReader(commands.withSignal(signal), binding, () => signal.throwIfAborted())
  signal.throwIfAborted()
  return { provider: 'feishu-messages', account: binding.expectedUserId, conversation: request.conversation,
    start: request.start, end: request.end, messages, ...next ? { next } : {}, consistency: 'live_paginated', gaps,
    resolved, resolution }
}
