/** WeChat activity through the configured native MCP tools; only the Source owns consumption acknowledgments. */
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { family, record } from '../kv.ts'
import type { Commands } from '../infra/commands.ts'
import { ImContextReadError, type ImContextPage, type ImContextRequest, type ImReadPage, type ImReadRequest } from './im-context.ts'
import type { ContextPart, ContextPartName } from './kind.ts'
import type { ActivityEvent, ActivityRange, ActivityReaderContext, ActivityScan, ActivityTools, WechatActivityBinding } from './activity-types.ts'

const DateTime = z.string().datetime({ offset: true })
const WindowDays = 31 * 86_400_000, RotationOverlap = 86_400_000
/** Python's sorted-key JSON: keys sort at every depth, so an app or attachment object hashes identically. */
const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, sorted(record[key])]))
  }
  return value
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex')
const hash = (parts: readonly string[]) => digest(parts)
type NativeTool = 'wechat_list_chats' | 'wechat_incremental_read' | 'wechat_incremental_ack' | 'wechat_read_window' | 'wechat_wait_for_source_change'
const Envelope = z.object({ structuredContent: z.unknown().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })) })
const WrappedJson = z.object({ result: z.string() })
const Chat = z.object({ wxid: z.string().min(1), display: z.string(), lastMessageAt: DateTime })
const Page = z.object({ status: z.literal('ok'), account: z.string().min(1), chats: z.array(Chat),
  count: z.number().int().nonnegative(), total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative().nullable(), has_more: z.boolean(), snapshot_id: z.string().min(1),
  start_inclusive: DateTime, end_exclusive: DateTime })
const Original = z.object({ account: z.string().min(1), conversation: z.string().min(1), record_id: z.string().min(1),
  message_ref: z.string().startsWith('wx1.'), timestamp: z.number().int(), time: DateTime, text: z.string(),
  sender: z.string().nullable(), direction: z.string(), contact: z.string().optional(),
  local_type: z.number().int(), app: z.unknown().optional(), attachment: z.unknown().optional(),
  server_id: z.string().optional(), local_id: z.number().int().optional() })
/** The native collector's content fingerprint, reproduced so collection and window reads share one version key. */
const FINGERPRINT_KEYS = ['app', 'attachment', 'direction', 'local_type', 'sender', 'text', 'timestamp'] as const
function wechatFingerprint(record: z.infer<typeof Original>): string {
  const value: Record<string, unknown> = {}
  for (const key of FINGERPRINT_KEYS) if (record[key] !== undefined) value[key] = record[key]
  return digest(value)
}
const Evidence = z.object({ event_id: z.string().regex(/^wxe_[a-f0-9]{64}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), original: Original })
const Batch = z.object({ status: z.literal('ok'), scope_id: z.string(), account: z.string().min(1), conversation: z.string().min(1),
  start_inclusive: z.number().int(), end_exclusive: z.number().int(), records: z.array(Evidence).max(500),
  count: z.number().int().nonnegative(), has_more: z.boolean(), batch_id: z.string(),
  delivery_state: z.enum(['pending_ack', 'no_changes']) })
const Ack = z.object({ status: z.literal('acknowledged'), batch_id: z.string(), count: z.number().int().nonnegative() })
const ReadWindow = z.object({ status: z.literal('ok'), conversation: z.string(), records: z.array(Original), count: z.number().int().nonnegative(),
  has_more: z.boolean(), next_offset: z.number().int().nonnegative().nullable(), snapshot_id: z.string().min(1) })
interface Cursor { account: string; contact: string; label: string; start: string; scopeId: string; pending: boolean }

function toolName(binding: WechatActivityBinding, tool: NativeTool): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(binding.serverName)) throw new Error('Invalid WeChat MCP server namespace')
  return `mcp__${binding.serverName}__${tool}`
}
/** File notifications only wake the existing collector; no source batch is acknowledged here. */
export async function waitWechatChange(tools: ActivityTools, binding: WechatActivityBinding, token: string, signal: AbortSignal) {
  return call(tools, binding, 'wechat_wait_for_source_change', { token, timeout_seconds: 30 },
    z.object({ status: z.literal('ok'), token: z.string().regex(/^[a-f0-9]{64}$/), changed: z.boolean() }), signal)
}
/** ToolRuntime owns policy, cancellation, output validation and the current MCP connection generation. */
async function call<T>(tools: ActivityTools, binding: WechatActivityBinding, tool: NativeTool, args: object, schema: z.ZodType<T>,
  signal: AbortSignal, active: () => void = () => signal.throwIfAborted()): Promise<T> {
  active(); signal.throwIfAborted()
  const name = toolName(binding, tool)
  // Execute the named tool directly; projecting every installed schema can fail on an unrelated plugin.
  const result = await tools.execute({ callId: ToolCallId(`activity-wechat-${randomUUID()}`), name, arguments: args, signal })
    .catch((error: unknown) => {
      active(); signal.throwIfAborted()
      if (tool === 'wechat_read_window') throw new ImContextReadError(true)
      throw error
    })
  active(); signal.throwIfAborted()
  if (result.isError) {
    const message = result.error.message
    if (tool === 'wechat_read_window') throw new ImContextReadError(
      !/permission|forbidden|unauthori[sz]ed|access denied|\b40[13]\b/i.test(message)
      && /unavailable|temporar|disconnected|timed?\s*out|timeout|ECONNRESET|ECONNREFUSED|\b(?:429|502|503|504)\b/i.test(message))
    throw new Error(`WeChat ${tool} failed: ${message}`)
  }
  const envelope = Envelope.parse(result.value), structured = envelope.structuredContent
  // Existing JSON-string tools and the activity-aware structured list are both native MCP output contracts.
  if (structured && typeof structured === 'object' && 'status' in structured) return schema.parse(structured)
  const wrapped = WrappedJson.safeParse(structured)
  const text = wrapped.success ? wrapped.data.result : envelope.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
  return schema.parse(JSON.parse(text))
}

function bounds(range: ActivityRange): { start: string; end: string; endMs: number } {
  DateTime.parse(range.start); DateTime.parse(range.end)
  const start = Math.floor(Date.parse(range.start) / 1000) * 1000, end = Math.floor(Date.parse(range.end) / 1000) * 1000
  if (end <= start) throw new Error('WeChat activity range must cover at least one second')
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), endMs: end }
}

async function listChats(tools: ActivityTools, binding: WechatActivityBinding, range: ActivityRange, signal: AbortSignal,
  active: () => void = () => signal.throwIfAborted()) {
  const chats = new Map<string, z.infer<typeof Chat>>()
  let offset = 0, snapshot = '', account = '', total = 0
  for (;;) {
    const page = await call(tools, binding, 'wechat_list_chats', { limit: 500, offset, start: range.start, end: range.end, snapshot_id: snapshot }, Page, signal, active)
    if (page.offset !== offset || page.count !== page.chats.length || page.total < page.count
      || Date.parse(page.start_inclusive) !== Date.parse(range.start) || Date.parse(page.end_exclusive) !== Date.parse(range.end)
      || (snapshot && (page.snapshot_id !== snapshot || page.account !== account || page.total !== total))) {
      throw new Error('WeChat activity discovery changed or returned an inconsistent page; no batch was acknowledged')
    }
    snapshot = page.snapshot_id; account = page.account; total = page.total
    for (const chat of page.chats) {
      if (chats.has(chat.wxid) || Date.parse(chat.lastMessageAt) < Date.parse(range.start) || Date.parse(chat.lastMessageAt) >= Date.parse(range.end)) {
        throw new Error('WeChat activity discovery returned duplicate or out-of-window conversations')
      }
      chats.set(chat.wxid, chat)
    }
    if (!page.has_more) {
      if (page.next_offset !== null || chats.size !== total) throw new Error('WeChat activity discovery is incomplete')
      return { account, chats }
    }
    if (!page.count || page.next_offset !== offset + page.count) throw new Error('WeChat activity discovery has an invalid continuation')
    offset = page.next_offset
  }
}

async function discover(ctx: ActivityReaderContext, tools: ActivityTools, binding: WechatActivityBinding, range: ActivityRange) {
  return listChats(tools, binding, range, ctx.signal, () => ctx.assertActive())
}

function eventOf(evidence: z.infer<typeof Evidence>, label: string): ActivityEvent {
  const original = evidence.original, start = new Date(original.timestamp * 1000).toISOString()
  return { provider: 'wechat', accountId: original.account, objectId: original.conversation,
    id: evidence.event_id, version: evidence.fingerprint, at: start, text: original.text,
    reference: original.message_ref, label, senderId: original.sender ?? '', direction: original.direction,
    contentType: String(original.local_type),
    locator: { provider: 'wechat', contact: original.conversation, messageRef: original.message_ref,
      start, end: new Date((original.timestamp + 1) * 1000).toISOString() },
    ...original.attachment !== undefined || ['3', '34', '43', '47'].includes(String(original.local_type)) ? { contentPartial: true } : {} }
}

/** Discover active conversations, then durably ingest and acknowledge their independent monitor evidence batches. */
export async function scanWechatActivity(ctx: ActivityReaderContext, tools: ActivityTools, binding: WechatActivityBinding,
  range: ActivityRange): Promise<ActivityScan> {
  ctx.assertActive(); ctx.signal.throwIfAborted()
  const selected = bounds(range), found = await discover(ctx, tools, binding, selected)
  const namespace = hash([ctx.consumerId, binding.serverName]), state = ctx.source.state
  const accountKey = record<string>(`activity-wechat-account:${namespace}`)
  const account = state.get(accountKey)
  if (account && account !== found.account) throw new Error('The configured WeChat account changed; start a new monitor activation')
  ctx.assertActive(); state.set(accountKey, found.account)
  const cursors = family<Cursor, [string]>(`activity-wechat-cursor:${namespace}:`, contact => hash([contact]))
  const pending = state.keys(cursors).map(key => state.get(key)).filter((cursor): cursor is Cursor => !!cursor?.pending)
  const contacts = new Map([...pending.map(cursor => [cursor.contact, cursor.label] as const), ...[...found.chats].map(([id, chat]) => [id, chat.display] as const)])
  let records = 0, partial = 0
  for (const [contact, label] of contacts) {
    const key = cursors(contact)
    let cursor = state.get(key)
    const makeCursor = (start: string): Cursor => ({ account: found.account, contact, label, start, pending: true,
      scopeId: `activity-${hash([namespace, found.account, contact, start]).slice(0, 48)}` })
    cursor ??= makeCursor(selected.start)
    if (cursor.account !== found.account || cursor.contact !== contact) throw new Error('WeChat consumer binding changed')
    cursor = { ...cursor, label, pending: true }
    ctx.assertActive(); state.set(key, cursor)
    for (;;) {
      const endMs = Math.min(Date.parse(cursor.start) + WindowDays, selected.endMs)
      if (endMs <= Date.parse(cursor.start)) throw new Error('WeChat consumer window cannot move backwards')
      const end = new Date(endMs).toISOString()
      const batch = await call(tools, binding, 'wechat_incremental_read', { scope_id: cursor.scopeId, contact,
        start: cursor.start, end, limit: 500 }, Batch, ctx.signal, () => ctx.assertActive())
      if (batch.scope_id !== cursor.scopeId || batch.account !== found.account || batch.conversation !== contact
        || batch.start_inclusive !== Date.parse(cursor.start) / 1000 || batch.end_exclusive > endMs / 1000
        || batch.end_exclusive <= batch.start_inclusive || batch.count !== batch.records.length
        || (batch.count ? batch.delivery_state !== 'pending_ack' || !/^[a-f0-9]{32}$/.test(batch.batch_id)
          : batch.delivery_state !== 'no_changes' || batch.has_more || batch.batch_id !== '')) {
        throw new Error('WeChat returned an inconsistent incremental batch; no acknowledgment was sent')
      }
      for (const evidence of batch.records) {
        const original = evidence.original
        if (original.account !== found.account || original.conversation !== contact
          || original.timestamp < batch.start_inclusive || original.timestamp >= batch.end_exclusive) {
          throw new Error('WeChat evidence escaped its bound account, conversation or window')
        }
        ctx.assertActive(); ctx.signal.throwIfAborted()
        const event = eventOf(evidence, label)
        const delivered = await ctx.emit(event)
        if (delivered !== 'stored' && delivered !== 'duplicate') throw new Error('WeChat evidence was not durably handed to the monitor')
        records++; if (event.contentPartial) partial++
      }
      if (batch.count) {
        const ack = await call(tools, binding, 'wechat_incremental_ack', { scope_id: cursor.scopeId, batch_id: batch.batch_id }, Ack,
          ctx.signal, () => ctx.assertActive())
        if (ack.batch_id !== batch.batch_id || ack.count !== batch.count) throw new Error('WeChat acknowledgment receipt did not match its batch')
        continue
      }
      if (batch.end_exclusive !== endMs / 1000) throw new Error('WeChat empty batch did not cover the requested window')
      if (endMs < selected.endMs) {
        // Keep a one-day overlap when the 31-day scope expires; immutable event/version IDs deduplicate the overlap.
        cursor = makeCursor(new Date(endMs - RotationOverlap).toISOString())
        ctx.assertActive(); state.set(key, cursor)
        continue
      }
      ctx.assertActive(); state.set(key, { ...cursor, pending: false })
      break
    }
  }
  return { records, objects: contacts.size, complete: true, contentPartial: partial,
    detail: 'Active conversations by original message time; local synchronized evidence only; attachments were not read.' }
}

const ContextCursor = z.object({ reference: z.string(), offset: z.number().int().nonnegative(), snapshotId: z.string().min(1) })
/** Read only the event's bound timestamp window. Wider history and attachments remain explicitly outside this context page. */
export async function readWechatActivityContext(tools: ActivityTools, binding: WechatActivityBinding, _commands: Commands,
  event: ActivityEvent, part: ContextPartName, cursor?: string, signal: AbortSignal = AbortSignal.timeout(60_000)): Promise<ContextPart> {
  if (event.provider !== 'wechat' || event.locator.provider !== 'wechat' || event.reference !== event.locator.messageRef
    || event.objectId !== event.locator.contact) throw new Error('Invalid WeChat activity locator')
  if (part === 'parent') return { messages: [], status: 'unsupported', body: { contentPartial: true, reason: 'Parent message identity is not provided by this WeChat locator.' } }
  const locator = event.locator, selected = bounds(locator)
  const continuation = cursor ? ContextCursor.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))) : undefined
  if (continuation && continuation.reference !== event.reference) throw new Error('WeChat context cursor belongs to another event')
  let offset = continuation?.offset ?? 0, snapshotId = continuation?.snapshotId ?? ''
  for (;;) {
    const page = await call(tools, binding, 'wechat_read_window', { contact: locator.contact, start: selected.start, end: selected.end,
      limit: 500, offset, snapshot_id: snapshotId }, ReadWindow, signal)
    if (page.conversation !== locator.contact || page.count !== page.records.length || (snapshotId && page.snapshot_id !== snapshotId)
      || page.records.some(record => record.account !== event.accountId || record.conversation !== locator.contact
        || record.timestamp * 1000 < Date.parse(selected.start) || record.timestamp * 1000 >= selected.endMs)) {
      throw new Error('WeChat context does not match its bound event')
    }
    if (page.has_more && (!page.count || page.next_offset !== offset + page.count)) throw new Error('Invalid WeChat context continuation')
    const records = part === 'root' ? page.records.filter(record => record.message_ref === event.reference) : page.records
    if (part === 'root' && !records.length && page.has_more) { offset = page.next_offset!; snapshotId = page.snapshot_id; continue }
    const next = part === 'thread' && page.has_more ? Buffer.from(JSON.stringify({ reference: event.reference,
      offset: page.next_offset, snapshotId: page.snapshot_id })).toString('base64url') : undefined
    return { messages: records.map(record => ({ id: record.message_ref, from: record.sender ?? '', direction: record.direction,
      at: new Date(record.timestamp * 1000).toISOString(), text: record.text })), ...next ? { next } : {},
      status: part === 'root' && !records.length ? 'not_found' : 'partial',
      body: { contentPartial: true, eventVersion: event.version, currentLocalSnapshot: true,
        window: { start: selected.start, end: selected.end }, coverage: 'Only the bound message timestamp window; not the full conversation. Attachments were not read.' } }
  }
}


const ImWindowCursor = z.object({ server: z.string(), account: z.string(), conversation: z.string(),
  anchor: z.string(), version: z.string(), start: DateTime, end: DateTime,
  offset: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), snapshot: z.string().min(1) }).strict()
const ImReadWindow = ReadWindow.extend({ records: z.array(Original).max(100),
  account: z.string().min(1).optional(), start_inclusive: DateTime.optional(), end_exclusive: DateTime.optional() })

/** Read a fixed conversation window without participating in the monitor's delivery or ACK protocol. */
export async function readWechatImContext(tools: ActivityTools, binding: WechatActivityBinding, request: ImContextRequest,
  cursor: string | undefined, signal: AbortSignal): Promise<ImContextPage> {
  signal.throwIfAborted()
  const { anchor, start, end } = request
  DateTime.parse(start); DateTime.parse(end)
  const startMs = Date.parse(start), endMs = Date.parse(end)
  if (anchor.provider !== 'wechat' || !anchor.account || !anchor.conversation || !anchor.message.startsWith('wx1.')
    || endMs <= startMs) {
    throw new Error('Invalid WeChat IM context identity or window')
  }
  // Native timestamps are whole seconds and native bounds truncate milliseconds. Ceil preserves the exact half-open set.
  const nativeStart = Math.ceil(startMs / 1000) * 1000, nativeEnd = Math.ceil(endMs / 1000) * 1000
  const scope = { server: binding.serverName, account: anchor.account, conversation: anchor.conversation,
    anchor: anchor.message, version: anchor.version, start, end }
  const continuation = cursor === undefined ? undefined : ImWindowCursor.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
  if (continuation && Object.entries(scope).some(([key, value]) => continuation[key as keyof typeof scope] !== value)) {
    throw new Error('WeChat IM context cursor belongs to another binding, anchor or window')
  }
  // A positive subsecond window can contain no possible whole-second message timestamp.
  if (nativeStart === nativeEnd) return { provider: 'wechat', account: anchor.account, conversation: anchor.conversation, start, end,
    messages: [], consistency: 'live_paginated', gaps: ['local_sync_only', 'native_version_unavailable', 'deletion_status_unavailable', 'account_unverified_empty_window'] }
  const offset = continuation?.offset ?? 0
  const page = await call(tools, binding, 'wechat_read_window', { contact: anchor.conversation, start: new Date(nativeStart).toISOString(), end: new Date(nativeEnd).toISOString(),
    limit: 100, offset, snapshot_id: continuation?.snapshot ?? '' }, ImReadWindow, signal)
  if (page.conversation !== anchor.conversation || page.count !== page.records.length
    || (page.account !== undefined && page.account !== anchor.account)
    || (page.start_inclusive !== undefined && Date.parse(page.start_inclusive) !== nativeStart)
    || (page.end_exclusive !== undefined && Date.parse(page.end_exclusive) !== nativeEnd)
    || (continuation && continuation.snapshot !== page.snapshot_id)) {
    throw new Error('WeChat IM context page changed account, conversation, window or snapshot')
  }
  if (page.has_more ? !page.count || !Number.isSafeInteger(page.next_offset) || page.next_offset !== offset + page.count
    : page.next_offset !== null) throw new Error('Invalid WeChat IM context continuation')
  const recordIds = new Set<string>(), messageIds = new Set<string>()
  for (const original of page.records) {
    if (original.account !== anchor.account || original.conversation !== anchor.conversation
      || original.timestamp * 1000 < startMs || original.timestamp * 1000 >= endMs
      || Date.parse(original.time) !== original.timestamp * 1000
      || recordIds.has(original.record_id) || messageIds.has(original.message_ref)) {
      throw new Error('WeChat IM context returned duplicate records or escaped its account, conversation or window')
    }
    recordIds.add(original.record_id); messageIds.add(original.message_ref)
  }
  return { provider: 'wechat', account: anchor.account, conversation: anchor.conversation, start, end,
    snapshot: page.snapshot_id, consistency: 'native_snapshot', gaps: ['local_sync_only', 'native_version_unavailable', 'deletion_status_unavailable',
      ...!page.records.length && page.account === undefined ? ['account_unverified_empty_window'] : []],
    messages: page.records.map(original => ({ id: original.message_ref, text: original.text, sender: original.sender ?? '', direction: original.direction,
      createdAt: new Date(original.timestamp * 1000).toISOString(),
      ...original.attachment !== undefined || ['3', '34', '43', '47'].includes(String(original.local_type)) ? { partial: true } : {} })),
    ...page.has_more ? { next: Buffer.from(JSON.stringify({ ...scope, offset: page.next_offset, snapshot: page.snapshot_id })).toString('base64url') } : {} }
}

const NativeWindow = z.object({ status: z.enum(['ok', 'not_found', 'ambiguous_contact', 'snapshot_changed']),
  conversation: z.string().min(1).optional(), timezone: z.string().optional(),
  start_inclusive: DateTime.optional(), end_exclusive: DateTime.optional(),
  records: z.array(Original).max(100).default([]), count: z.number().int().nonnegative().default(0),
  has_more: z.boolean().default(false), next_offset: z.number().int().nonnegative().nullable().optional(),
  snapshot_id: z.string().min(1).optional(), message: z.string().optional(),
  candidates: z.array(z.object({ conversation: z.string().min(1), display: z.string().optional() })).max(20).optional() })
const WindowCursor = z.object({ provider: z.literal('wechat'), conversation: z.string().min(1),
  start: DateTime, end: DateTime, keyword: z.string(), offset: z.number().int().positive(), snapshot: z.string().min(1) }).strict()
const NATIVE_CONTACT = (value: string) => /^wxid_[A-Za-z0-9_-]+$/.test(value) || /@chatroom$/.test(value)
const IDENTIFIER = (value: string) => /^[A-Za-z0-9_.@-]+$/.test(value)

/** Read a bounded WeChat window by native wxid or by an exact display name from the same window's active chats. */
export async function readWechatWindow(tools: ActivityTools, binding: WechatActivityBinding, request: ImReadRequest,
  cursor: string | undefined, signal: AbortSignal): Promise<ImReadPage> {
  signal.throwIfAborted()
  const startMs = Date.parse(request.start), endMs = Date.parse(request.end)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) throw new Error('Invalid WeChat read window')
  const continuation = cursor === undefined ? undefined : WindowCursor.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
  if (continuation && (continuation.conversation !== request.conversation || Date.parse(continuation.start) !== startMs
    || Date.parse(continuation.end) !== endMs || continuation.keyword !== (request.keyword ?? ''))) {
    throw new Error('WeChat window cursor belongs to another conversation, window or keyword')
  }
  const nativeStart = Math.ceil(startMs / 1000) * 1000, nativeEnd = Math.ceil(endMs / 1000) * 1000
  if (nativeStart === nativeEnd) {
    return { provider: 'wechat', account: '', conversation: request.conversation, start: request.start, end: request.end,
      messages: [], consistency: 'live_paginated', gaps: ['window_below_native_resolution'], resolved: { id: request.conversation } }
  }
  let resolved: { id: string; label?: string }, resolution: 'native_id' | 'exact_name'
  if (continuation) {
    resolved = { id: continuation.conversation }; resolution = 'native_id'
  } else if (NATIVE_CONTACT(request.conversation)) {
    resolved = { id: request.conversation }; resolution = 'native_id'
  } else {
    const found = await listChats(tools, binding, { start: new Date(nativeStart).toISOString(), end: new Date(nativeEnd).toISOString() }, signal)
    const wanted = request.conversation.trim().toLocaleLowerCase()
    const exact = [...found.chats.values()].filter(chat => chat.display.trim().toLocaleLowerCase() === wanted)
    if (exact.length === 1) {
      resolved = { id: exact[0]!.wxid, label: exact[0]!.display }; resolution = 'exact_name'
    } else if (exact.length > 1) {
      return { provider: 'wechat', account: found.account, conversation: request.conversation, start: request.start, end: request.end,
        messages: [], consistency: 'live_paginated', gaps: ['conversation_ambiguous'],
        candidates: exact.slice(0, 10).map(chat => ({ id: chat.wxid, label: chat.display })) }
    } else if (IDENTIFIER(request.conversation)) {
      // Some native wxids do not carry the wxid_ prefix; the native reader still resolves them exactly.
      resolved = { id: request.conversation }; resolution = 'native_id'
    } else {
      return { provider: 'wechat', account: found.account, conversation: request.conversation, start: request.start, end: request.end,
        messages: [], consistency: 'live_paginated', gaps: ['conversation_not_found'], candidates: [] }
    }
  }
  const page = await call(tools, binding, 'wechat_read_window', { contact: resolved.id,
    start: new Date(nativeStart).toISOString(), end: new Date(nativeEnd).toISOString(), keyword: request.keyword ?? '',
    limit: 100, offset: continuation?.offset ?? 0, snapshot_id: continuation?.snapshot ?? '' }, NativeWindow, signal)
  if (page.status === 'snapshot_changed') throw new Error('WeChat window changed; restart the read from its first page')
  if (page.status === 'not_found') {
    return { provider: 'wechat', account: '', conversation: resolved.id, start: request.start, end: request.end,
      messages: [], consistency: 'live_paginated', gaps: ['conversation_not_found'], candidates: [], resolved, resolution }
  }
  if (page.status === 'ambiguous_contact') {
    return { provider: 'wechat', account: '', conversation: resolved.id, start: request.start, end: request.end,
      messages: [], consistency: 'live_paginated', gaps: ['conversation_ambiguous'], resolved,
      candidates: (page.candidates ?? []).map(item => ({ id: item.conversation, ...item.display ? { label: item.display } : {} })) }
  }
  const conversation = page.conversation ?? resolved.id
  if (conversation !== resolved.id) throw new Error('WeChat returned a different conversation than the one resolved')
  if (continuation && page.snapshot_id !== continuation.snapshot) {
    throw new Error('WeChat window snapshot changed; restart the read from its first page')
  }
  if (page.count !== page.records.length || (page.start_inclusive && Date.parse(page.start_inclusive) !== nativeStart)
    || (page.end_exclusive && Date.parse(page.end_exclusive) !== nativeEnd)) {
    throw new Error('WeChat returned an inconsistent page for the requested window')
  }
  const offset = continuation?.offset ?? 0
  if (page.has_more ? !page.count || !Number.isSafeInteger(page.next_offset) || page.next_offset !== offset + page.count
    : page.next_offset !== null) throw new Error('Invalid WeChat window continuation')
  if (page.has_more && !page.snapshot_id) throw new Error('WeChat window cannot continue without a native snapshot')
  const accounts = new Set<string>(), recordIds = new Set<string>(), messageIds = new Set<string>()
  for (const record of page.records) {
    if (record.conversation !== conversation || record.timestamp * 1000 < startMs || record.timestamp * 1000 >= endMs
      || Date.parse(record.time) !== record.timestamp * 1000 || recordIds.has(record.record_id) || messageIds.has(record.message_ref)) {
      throw new Error('WeChat returned duplicate records or escaped its conversation or window')
    }
    accounts.add(record.account); recordIds.add(record.record_id); messageIds.add(record.message_ref)
  }
  if (accounts.size > 1) throw new Error('WeChat returned records from more than one account')
  const account = [...accounts][0] ?? ''
  const label = resolved.label ?? page.records.find(record => record.contact)?.contact
  const next = page.has_more ? Buffer.from(JSON.stringify({ provider: 'wechat', conversation, start: request.start,
    end: request.end, keyword: request.keyword ?? '', offset: page.next_offset, snapshot: page.snapshot_id })).toString('base64url') : undefined
  return { provider: 'wechat', account, conversation, start: request.start, end: request.end,
    messages: page.records.map(record => ({ id: record.message_ref,
      version: wechatFingerprint(record), versionBasis: 'source_digest',
      nativeVersion: String(record.timestamp), text: record.text, sender: record.sender ?? '', direction: record.direction,
      createdAt: new Date(record.timestamp * 1000).toISOString(),
      ...record.attachment !== undefined || ['3', '34', '43', '47'].includes(String(record.local_type)) ? { partial: true } : {} })),
    ...next ? { next } : {}, consistency: 'native_snapshot', ...page.snapshot_id ? { snapshot: page.snapshot_id } : {},
    gaps: ['local_sync_only', 'native_version_unavailable', 'deletion_status_unavailable',
      ...request.keyword ? ['keyword_native_filter'] : [], ...!page.records.length ? ['account_unverified_empty_window'] : []],
    resolved: { id: conversation, ...label ? { label } : {} }, resolution }
}
