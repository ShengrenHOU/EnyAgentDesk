/** Capture an immutable discussion prefix through the installed DSH Session Controller. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { WorkbenchContextSchema, type WorkbenchContext } from './workbench.ts'

/** How far back the owner-conversation resource reads, and how many of its messages one page holds. */
export const CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000
export const CONVERSATION_PAGE_SIZE = 20
export const CONVERSATION_MAX_PAGE_SIZE = 50
/** The window keeps at most this many messages, and this many characters, so one read stays bounded. */
const MAX_MESSAGES = 500
const TEXT_BUDGET = 200_000

type OwnerMessage = SessionEvent<'user/message' | 'assistant/message'>
type AttachmentReads = Pick<AttachmentStore, 'fileHostPath' | 'imageHostPath'>

/** Refuses another Session's inspection and managed execution, which is never the owner's one face. */
function ownerDiscussion(inspection: SessionInspection, sessionId: string): void {
  if (inspection.meta.id !== sessionId) throw new Error('Session inspection returned another discussion')
  // The Main Session is the owner's one face; worker Sessions and subagents remain managed execution.
  const managed = inspection.meta.agentPreset?.startsWith('dsh-superagent-')
    && inspection.meta.agentPreset !== 'dsh-superagent-router'
  if (inspection.meta.origin === 'subagent' || managed) {
    throw new Error('Managed worker and subagent Sessions are not owner discussions')
  }
}

/** Shape one original user or assistant message, retaining attachment identities and marking what the budget cut. */
function capture(event: OwnerMessage, store: AttachmentReads | undefined, remaining: number) {
  const message = event.type === 'user/message' ? event.data : event.data.message
  const text: string[] = [], references: string[] = [], attachments: WorkbenchContext['attachments'] = []
  let partial = false
  for (const block of message.content) {
    if (block.type === 'text') text.push(block.text)
    else if (block.type === 'file' || block.type === 'image') {
      const reference = `dsh-attachment:${block.attachment.attachmentId}`
      references.push(reference)
      const readonlyPath = block.type === 'file' ? store?.fileHostPath(block.attachment) : store?.imageHostPath(block.attachment)
      attachments.push({ reference, kind: block.type, name: block.attachment.name ?? block.attachment.attachmentId,
        ...(readonlyPath ? { readonlyPath } : {}) })
      if (!readonlyPath) partial = true
      text.push(`[${block.type}: ${block.attachment.name ?? block.attachment.attachmentId}]`)
    }
  }
  const full = text.join('\n')
  if (!full && !references.length) return undefined
  const captured = full.slice(0, remaining)
  return { message: { seq: event.seq, role: event.type === 'user/message' ? 'user' as const : 'assistant' as const,
    text: captured, at: new Date(event.time).toISOString(), references }, attachments, partial: partial || captured.length !== full.length }
}

/** Original user and assistant messages are evidence; injected notices and reasoning are excluded. */
export function discussionContext(inspection: SessionInspection, sessionId: string, throughSeq: number,
  store?: AttachmentReads): WorkbenchContext {
  ownerDiscussion(inspection, sessionId)
  if (!Number.isSafeInteger(throughSeq) || throughSeq < 0 || !inspection.events.some(event => event.seq === throughSeq)) {
    throw new Error('The selected discussion boundary is unavailable')
  }
  const messages: WorkbenchContext['messages'] = []
  const attachments = new Map<string, WorkbenchContext['attachments'][number]>()
  let partial = false, remaining = TEXT_BUDGET
  // Start at the latest selected evidence so the user's most recent corrections survive the bounded capture.
  for (const event of [...inspection.events].reverse()) {
    if (event.seq > throughSeq) continue
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    if (event.type === 'user/message' && event.data.source.kind !== 'user') continue
    if (messages.length === MAX_MESSAGES || remaining === 0) { partial = true; break }
    const captured = capture(event, store, remaining)
    if (!captured) continue
    for (const attachment of captured.attachments) attachments.set(attachment.reference, attachment)
    partial ||= captured.partial
    remaining -= captured.message.text.length
    messages.unshift(captured.message)
  }
  if (!messages.some(message => message.role === 'user')) throw new Error('No owner discussion is available at this boundary')
  return WorkbenchContextSchema.parse({ sessionId, throughSeq, messages, partial, attachments: [...attachments.values()] })
}

/** Read persisted or attached discussion history without starting another Agent or copying browser-provided history. */
export async function readDiscussion(controller: Pick<Context['sessionController'], 'inspect'>, sessionId: string,
  throughSeq: number, signal?: AbortSignal, attachments?: AttachmentReads): Promise<WorkbenchContext> {
  return discussionContext(await controller.inspect(sessionId as SessionId, signal), sessionId, throughSeq, attachments)
}

/** A bounded page of the owner's live main discussion, newest first, from the last 24 hours. */
export interface DiscussionWindow {
  sessionId: string
  /** The latest Session sequence the window read; absent while the Session has no events. */
  throughSeq: number | null
  /** The oldest instant the window includes, as the cutoff its messages are newer than. */
  windowStart: string
  messages: WorkbenchContext['messages']
  attachments: WorkbenchContext['attachments']
  /** True when an attachment path, text or older in-window message was left out rather than reported whole. */
  partial: boolean
  nextOffset: number | null
}

/**
 * Read the owner's main discussion as a read-only window: the last 24 hours, newest first, one bounded page.
 * Managed worker and subagent Sessions are refused, as are injected notices and reasoning. This grants no authority:
 * it neither receives a message nor creates or executes work.
 */
export function discussionWindow(inspection: SessionInspection, sessionId: string,
  options: { now?: Date; offset?: number; limit?: number; attachments?: AttachmentReads } = {}): DiscussionWindow {
  ownerDiscussion(inspection, sessionId)
  const now = options.now ?? new Date()
  const offset = Math.max(0, options.offset ?? 0)
  const size = Math.min(options.limit ?? CONVERSATION_PAGE_SIZE, CONVERSATION_MAX_PAGE_SIZE)
  const cutoff = now.getTime() - CONVERSATION_WINDOW_MS
  const candidates: OwnerMessage[] = []
  let partial = false
  // Events append in time order, so the first event before the cutoff ends the scan; newer evidence is kept first.
  for (const event of [...inspection.events].reverse()) {
    if (event.time < cutoff) break
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    if (event.type === 'user/message' && event.data.source.kind !== 'user') continue
    if (candidates.length === MAX_MESSAGES) { partial = true; break }
    candidates.push(event)
  }
  const pageEvents = candidates.slice(offset, offset + size)
  const messages: WorkbenchContext['messages'] = []
  const attachments = new Map<string, WorkbenchContext['attachments'][number]>()
  let remaining = TEXT_BUDGET
  for (const event of pageEvents) {
    if (remaining === 0) { partial = true; break }
    const captured = capture(event, options.attachments, remaining)
    if (!captured) continue
    for (const attachment of captured.attachments) attachments.set(attachment.reference, attachment)
    partial ||= captured.partial
    remaining -= captured.message.text.length
    messages.push(captured.message)
  }
  const nextOffset = remaining === 0 ? null : offset + pageEvents.length < candidates.length ? offset + size : null
  return { sessionId, throughSeq: inspection.events.at(-1)?.seq ?? null, windowStart: new Date(cutoff).toISOString(),
    messages, attachments: [...attachments.values()], partial, nextOffset }
}
