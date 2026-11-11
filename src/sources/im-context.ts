/** Bounded conversation evidence, never proof of complete history, current actionability or authority. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ImEvidence } from './kind.ts'

/** Sanitized native read failure, retaining only the recovery decision at the Source boundary. */
export class ImContextReadError extends Error {
  constructor(readonly retryable: boolean) { super('IM context read failed or permission is unavailable; no context was attached') }
}

export interface ImContextRequest { anchor: ImEvidence; anchorText: string; start: string; end: string }
export interface ImContextMessage {
  id: string; text: string; version?: string; versionBasis?: 'native' | 'source_digest'; nativeVersion?: string
  sender?: string; senderType?: string; senderIdType?: string; createdAt: string; updatedAt?: string
  /** Source-native evidence only; outgoing does not authenticate the owner or authorize work. */
  direction?: string
  deleted?: boolean; partial?: boolean; parent?: string; root?: string
}
export interface ImContextPage {
  provider: string; account: string; conversation: string; start: string; end: string
  messages: ImContextMessage[]; anchor?: ImContextMessage; next?: string; snapshot?: string
  consistency: 'native_snapshot' | 'live_paginated'; gaps: string[]
}
export interface ImContextReader {
  /** Captured native content supplied by the Source, before presentation wrappers. */
  readonly anchorText?: string
  /** Revalidates enabled scope, configuration and registration before/after each page and before publication. */
  assertActive(): void
  read(request: ImContextRequest, cursor: string | undefined, signal: AbortSignal): Promise<ImContextPage>
}
export interface ImContextManifest {
  schema: 'im-context-v1'; hash: string; scope: Pick<ImEvidence, 'provider' | 'account' | 'conversation'>
  requested: { start: string; end: string }; covered: { start: string; end: string } | null
  readStartedAt: string; readEndedAt: string; consistency: 'native_snapshot' | 'live_paginated'; snapshot?: string
  anchor: { id: string; selectedVersion: string; status: 'matched' | 'edited' | 'deleted' | 'missing' | 'unverified'; contentMatch?: boolean; observed?: ImContextMessage }
  messages: ImContextMessage[]; gaps: string[]; pages: number; contextComplete: false
}
export const ImContextWindowSchema = z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) }).strict()
  .refine(value => Date.parse(value.end) > Date.parse(value.start) && Date.parse(value.end) - Date.parse(value.start) <= 7 * 86_400_000,
    'Context window must be positive and at most seven days')
const MessageSchema = z.object({ id: z.string().min(1), text: z.string(), version: z.string().min(1).optional(),
  versionBasis: z.enum(['native', 'source_digest']).optional(), nativeVersion: z.string().optional(),
  sender: z.string().optional(), senderType: z.string().optional(), senderIdType: z.string().optional(),
  direction: z.string().optional(),
  createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }).optional(),
  deleted: z.boolean().optional(), partial: z.boolean().optional(), parent: z.string().optional(), root: z.string().optional() }).strict()
const PageSchema = z.object({ provider: z.string(), account: z.string(), conversation: z.string(),
  start: z.string(), end: z.string(), messages: z.array(MessageSchema).max(500), anchor: MessageSchema.optional(),
  next: z.string().min(1).max(16_384).optional(), snapshot: z.string().min(1).max(16_384).optional(),
  consistency: z.enum(['native_snapshot', 'live_paginated']), gaps: z.array(z.string().max(200)).max(100) }).strict()
export const IM_CONTEXT_LIMITS = { messages: 200, chars: 48_000, messageChars: 8_000, pages: 8, deadlineMs: 30_000 } as const
/** Host-owned collector: adapters cannot upgrade completeness, budgets, scope or authority. */
export async function collectImContext(reader: ImContextReader, request: ImContextRequest, signal?: AbortSignal, maxMessages: number = IM_CONTEXT_LIMITS.messages): Promise<ImContextManifest> {
  const messageLimit = z.number().int().min(1).max(IM_CONTEXT_LIMITS.messages).parse(maxMessages)
  const requested = ImContextWindowSchema.parse({ start: request.start, end: request.end })
  const readStartedAt = new Date().toISOString(), deadline = AbortSignal.timeout(IM_CONTEXT_LIMITS.deadlineMs)
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline
  const messages: ImContextMessage[] = [], gaps = new Set<string>(), ids = new Set<string>(), cursors = new Set<string>()
  let cursor: string | undefined, snapshot: string | undefined, consistency: ImContextPage['consistency'] = 'live_paginated'
  let pages = 0, chars = 0, exhausted = false, observed: ImContextMessage | undefined
  const clip = (message: ImContextMessage) => {
    const text = message.text.slice(0, Math.min(IM_CONTEXT_LIMITS.messageChars, Math.max(0, IM_CONTEXT_LIMITS.chars - chars)))
    chars += text.length
    if (text.length < message.text.length) gaps.add('text_budget')
    if (message.partial) gaps.add('partial_content_or_attachment')
    if (!message.version) gaps.add('version_unavailable')
    return { ...message, text, ...(text.length < message.text.length ? { partial: true } : {}) }
  }
  for (;;) {
    reader.assertActive(); signal?.throwIfAborted()
    if (deadline.aborted) { gaps.add('time_budget'); break }
    let page: ImContextPage
    try {
      // The race bounds even an adapter which ignores AbortSignal. Late results are never attached.
      page = PageSchema.parse(await new Promise<ImContextPage>((resolve, reject) => {
        const stop = () => reject(abort.reason)
        abort.addEventListener('abort', stop, { once: true })
        if (abort.aborted) { abort.removeEventListener('abort', stop); reject(abort.reason); return }
        Promise.resolve().then(() => reader.read(request, cursor, abort)).then(resolve, reject)
          .finally(() => abort.removeEventListener('abort', stop))
      }))
    } catch (error) {
      reader.assertActive(); signal?.throwIfAborted()
      if (deadline.aborted) { gaps.add('time_budget'); break }
      throw error
    }
    reader.assertActive(); signal?.throwIfAborted()
    if (deadline.aborted) { gaps.add('time_budget'); break }
    if (page.provider !== request.anchor.provider || page.account !== request.anchor.account || page.conversation !== request.anchor.conversation
      || Date.parse(page.start) !== Date.parse(request.start) || Date.parse(page.end) !== Date.parse(request.end)) throw new Error('IM context escaped requested scope or window')
    if ((page.consistency === 'native_snapshot' && !page.snapshot) || (page.consistency === 'live_paginated' && page.snapshot)
      || (pages && (page.consistency !== consistency || page.snapshot !== snapshot))) throw new Error('IM context snapshot changed or is invalid')
    consistency = page.consistency; snapshot = page.snapshot; pages++
    for (const gap of page.gaps) gaps.add(gap)
    if (consistency === 'live_paginated') gaps.add('live_pagination_not_snapshot')
    const anchorUnavailable = page.gaps.includes('anchor_missing') || page.gaps.includes('anchor_unreadable')
    if (anchorUnavailable) observed = undefined
    if (page.anchor && anchorUnavailable) throw new Error('IM context anchor status is inconsistent')
    if (page.anchor) {
      if (page.anchor.id !== request.anchor.message) throw new Error('IM context returned a foreign anchor')
      observed = page.anchor
    }
    for (const message of page.messages) {
      if (ids.has(message.id)) throw new Error('IM context returned a duplicate message')
      ids.add(message.id)
      if (Date.parse(message.createdAt) < Date.parse(request.start) || Date.parse(message.createdAt) >= Date.parse(request.end)) throw new Error('IM context returned an out-of-window message')
      if (!page.anchor && !anchorUnavailable && message.id === request.anchor.message) observed = message
      if (messages.length >= messageLimit) { gaps.add('message_budget'); continue }
      messages.push(clip(message))
    }
    if (!page.next) { exhausted = true; break }
    if (cursors.has(page.next) || page.next === cursor || !page.messages.length) throw new Error('IM context pagination did not advance')
    cursors.add(page.next); cursor = page.next
    if (pages >= IM_CONTEXT_LIMITS.pages) { gaps.add('page_budget'); break }
    if (messages.length >= messageLimit) { gaps.add('message_budget'); break }
    if (chars >= IM_CONTEXT_LIMITS.chars) { gaps.add('text_budget'); break }
  }
  reader.assertActive(); signal?.throwIfAborted()
  const status = !observed ? 'missing' : observed.deleted ? 'deleted' : !observed.version ? 'unverified'
    : observed.version === request.anchor.version ? 'matched' : 'edited'
  if (!observed) gaps.add('missing_anchor')
  if (status === 'unverified') gaps.add('anchor_version_unverified')
  const boundedObserved = observed ? clip(observed) : undefined
  // An empty or limited page sequence proves no covered interval. Even exhausted reads remain explicitly non-complete.
  const covered = exhausted && messages.length > 0 && !gaps.has('history_unsupported') && ![...gaps].some(gap => /budget/.test(gap)) ? requested : null
  const manifest = { schema: 'im-context-v1' as const, scope: { provider: request.anchor.provider, account: request.anchor.account, conversation: request.anchor.conversation },
    requested, covered, readStartedAt, readEndedAt: new Date().toISOString(), consistency, ...(snapshot ? { snapshot } : {}),
    anchor: { id: request.anchor.message, selectedVersion: request.anchor.version, status,
      ...(observed ? { contentMatch: observed.text === request.anchorText, observed: boundedObserved } : {}) },
    messages, gaps: [...gaps].sort(), pages, contextComplete: false as const }
  return { ...manifest, hash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') } as ImContextManifest
}
