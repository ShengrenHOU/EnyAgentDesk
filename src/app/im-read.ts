/**
 * One bounded, read-only IM window shared by the owner's Main Session and ticket workers.
 *
 * The Source owning the native reader resolves the conversation and returns native messages. This module gives
 * every message one canonical object/message/version key, refuses an ambiguous display name instead of guessing,
 * and binds each continuation cursor to the exact conversation, window and keyword it started with.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ImContextWindowSchema, type ImContextMessage, type ImReadPage } from '../sources/im-context.ts'
import { imDedupKey, imMessageId, imObjectId } from '../sources/im-identity.ts'
import type { Commands } from '../infra/commands.ts'
import type { SourceRegistry } from '../sources/registry.ts'

export interface ImReadHost {
  readonly sources: Pick<SourceRegistry, 'imRead'>
  readonly commands: Commands
}
export interface ImReadArgs { provider: string; conversation: string; start: string; end: string; keyword?: string; cursor?: string }
/** Host-owned bounds for one page; the adapter's own page limits stay smaller for Feishu. */
export const IM_READ_LIMITS = { messages: 100, chars: 48_000, messageChars: 8_000 } as const
export interface ImReadResultMessage {
  id: string; object_id: string; message_key: string; dedup_key: string; version: string
  version_basis: NonNullable<ImContextMessage['versionBasis']>
  native_version?: string; at: string; updated_at?: string; sender?: string; sender_type?: string; sender_id_type?: string
  direction?: string; text: string; deleted?: boolean; partial?: boolean; parent?: string; root?: string
}
export interface ImReadResult {
  provider: string; account?: string; resolved: boolean
  conversation: { id?: string; name?: string; label?: string }
  window: { start: string; end: string }; keyword?: string
  candidates?: { id: string; label?: string }[]; messages: ImReadResultMessage[]
  gaps: string[]; consistency: ImReadPage['consistency']; next?: string
}

const Cursor = z.object({ v: z.literal(1), provider: z.string().min(1), source: z.string().min(1), conversation: z.string().min(1),
  label: z.string().optional(), start: z.string().min(1), end: z.string().min(1), keyword: z.string().optional(),
  next: z.string().min(1) }).strict()
type ReadCursor = z.infer<typeof Cursor>
const digest = (parts: readonly string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const sameTime = (left: string, right: string): boolean => Date.parse(left) === Date.parse(right)
const decode = (cursor: string): ReadCursor =>
  Cursor.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
const encode = (cursor: ReadCursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url')
/** A message normally arrives with a native or source-digest version; otherwise its rendered content is the version. */
const versionOf = (message: ImContextMessage): string =>
  message.version ?? digest([message.id, message.createdAt, message.text])

/** Read one page; `next` continues the same provider, conversation, window and keyword. */
export async function readImWindow(host: ImReadHost, args: ImReadArgs, signal: AbortSignal): Promise<ImReadResult> {
  const window = ImContextWindowSchema.parse({ start: args.start, end: args.end })
  const keyword = args.keyword?.trim() || undefined
  const cursor = args.cursor ? decode(args.cursor) : undefined
  if (cursor && (cursor.provider !== args.provider
    || (cursor.source !== args.conversation && cursor.conversation !== args.conversation)
    || !sameTime(cursor.start, window.start) || !sameTime(cursor.end, window.end) || (cursor.keyword ?? '') !== (keyword ?? ''))) {
    throw new Error('This cursor belongs to another IM read; restart from its first page')
  }
  const conversation = cursor?.conversation ?? args.conversation
  let page: ImReadPage
  try {
    page = await host.sources.imRead(host.commands, { provider: args.provider, conversation, start: window.start, end: window.end,
      ...keyword ? { keyword } : {} }, cursor?.next, signal)
  } catch (error) {
    signal.throwIfAborted()
    // Never return partial private text or raw CLI diagnostics after a failed or revoked read.
    throw new Error('IM read failed, or its source access or snapshot changed; no content was returned. '
      + 'Restart from the first page if a complete window is needed.', { cause: error })
  }
  if (page.provider !== args.provider) throw new Error('IM read returned a different provider')
  if (page.candidates !== undefined) {
    return { provider: page.provider, resolved: false as const,
      conversation: page.resolved ? { id: page.resolved.id, ...page.resolved.label ? { label: page.resolved.label } : {} }
        : { name: conversation },
      window: { start: window.start, end: window.end }, ...keyword ? { keyword } : {},
      candidates: page.candidates.slice(0, 10), messages: [], consistency: page.consistency,
      gaps: [...new Set([...page.gaps, page.candidates.length ? 'conversation_ambiguous' : 'conversation_not_found'])].sort() }
  }
  if (!sameTime(page.start, window.start) || !sameTime(page.end, window.end)) throw new Error('IM read escaped its requested window')
  const resolved = page.resolved
    ? { ...page.resolved, ...!page.resolved.label && cursor?.label ? { label: cursor.label } : {} }
    : { id: page.conversation, ...cursor?.label ? { label: cursor.label } : {} }
  if (page.resolved && page.resolved.id !== page.conversation) throw new Error('IM read returned an inconsistent conversation identity')
  const seen = new Map<string, string>()
  const messages: ImReadResultMessage[] = []
  const gaps = new Set(page.gaps)
  let chars = 0, truncated = false, sliced = false
  for (const message of page.messages) {
    const version = versionOf(message)
    const prior = seen.get(message.id)
    if (prior !== undefined) {
      if (prior !== version) throw new Error('IM read returned two versions of one message')
      continue
    }
    seen.set(message.id, version)
    const text = message.text.slice(0, IM_READ_LIMITS.messageChars)
    if (messages.length >= IM_READ_LIMITS.messages || chars + text.length > IM_READ_LIMITS.chars) {
      truncated = true
      break
    }
    chars += text.length
    if (text.length < message.text.length) sliced = true
    const ref = { provider: page.provider, conversation: resolved.id }
    messages.push({ id: message.id, object_id: imObjectId(ref), message_key: imMessageId(ref, message.id),
      dedup_key: imDedupKey(ref, message.id, version), version, version_basis: message.versionBasis ?? 'source_digest',
      ...message.nativeVersion ? { native_version: message.nativeVersion } : {},
      at: message.createdAt, ...message.updatedAt ? { updated_at: message.updatedAt } : {},
      ...message.sender ? { sender: message.sender } : {}, ...message.senderType ? { sender_type: message.senderType } : {},
      ...message.senderIdType ? { sender_id_type: message.senderIdType } : {}, ...message.direction ? { direction: message.direction } : {},
      text, ...message.deleted ? { deleted: true } : {}, ...message.partial || text.length < message.text.length ? { partial: true } : {},
      ...message.parent ? { parent: message.parent } : {}, ...message.root ? { root: message.root } : {} })
  }
  // A truncated page must not offer a continuation: it would skip the messages this page held back.
  if (truncated) gaps.add('page_budget')
  if (sliced) gaps.add('text_truncated')
  if (!messages.length) gaps.add('empty_window')
  const next = page.next && !truncated ? encode({ v: 1, provider: page.provider, source: args.conversation, conversation: resolved.id,
    ...resolved.label ? { label: resolved.label } : {}, start: window.start, end: window.end,
    ...keyword ? { keyword } : {}, next: page.next }) : undefined
  return { provider: page.provider, account: page.account, resolved: true as const, conversation: resolved,
    window: { start: window.start, end: window.end }, ...keyword ? { keyword } : {}, messages,
    gaps: [...gaps].sort(), consistency: page.consistency, ...next ? { next } : {} }
}
