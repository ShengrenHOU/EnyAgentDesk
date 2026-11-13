/** Per-conversation triage context coverage. Not a Source read cursor, ACK, or complete history. */
import { family } from '../kv.ts'
import type { ImEvidence } from '../sources/kind.ts'
import { imScope } from './im-evidence-revisions.ts'
import type { Store } from './store.ts'

/** The first batch for a conversation looks back this far; later batches read from its covered cursor. */
export const INITIAL_LOOKBACK_MS = 24 * 3_600_000
/** A small overlap keeps the last covered messages in view without rereading a whole day. */
export const INCREMENTAL_OVERLAP_MS = 120_000
const MAX_WINDOW_MS = 7 * 86_400_000

/** Durable context coverage for one native conversation: the last event-time boundary read and judged. */
export interface ConversationCursor {
  scope: string
  conversation: string
  /** Event-time boundary; messages at or after it have not been covered by a completed batch. */
  through: string
  revision: number
  updatedAt: string
  messageId?: string
  version?: string
}
const cursors = family<ConversationCursor>('triage-conversation-cursor:')

export type ContextMode = 'initial' | 'incremental' | 'change' | 'explicit'
export interface ContextInput { triggerId: string; at: string; identity: ImEvidence }
/** One bounded native window plus the explicit coverage statement a receipt retains. */
export interface PlannedContext {
  mode: ContextMode
  window: { start: string; end: string }
  previous: string | null
  /** Inputs behind the cursor: an edit/delete of a covered message or a late arrival, read as single anchors. */
  changeTriggerIds: string[]
  gaps: string[]
}
export interface BatchContextCoverage {
  scope: string
  conversation: string
  mode: ContextMode
  from: string
  to: string
  previous: string | null
  changeTriggerIds: string[]
  /** Planning limitations that stay true for this window, independent of what an attempt manages to read. */
  planGaps: string[]
  /** Planning gaps plus the current attempt's collected context gaps; recomputed on every retry. */
  gaps: string[]
}
const iso = (value: number) => new Date(value).toISOString()
const time = (value: string) => {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error('Triage context needs a valid event time')
  return parsed
}
export const readConversationCursor = (store: Store, identity: ImEvidence): ConversationCursor | undefined => store.get(cursors(imScope(identity)))
/** Forward-only: a later batch never moves coverage backwards; incomplete or rolled back work does not call this. */
export function advanceConversationCursor(store: Store, identity: ImEvidence, through: string, updatedAt: string,
  observed?: { messageId?: string; version?: string }): ConversationCursor {
  const key = cursors(imScope(identity)), current = store.get(key), boundary = time(through)
  if (current && time(current.through) >= boundary) return current
  const next: ConversationCursor = { scope: imScope(identity), conversation: identity.conversation, through,
    revision: (current?.revision ?? 0) + 1, updatedAt,
    ...observed?.messageId ? { messageId: observed.messageId } : {}, ...observed?.version ? { version: observed.version } : {} }
  store.set(key, next)
  return next
}
/** Plans one native conversation at a time. Inputs behind the cursor must be a separate plan from newer input. */
export function planContext(inputs: ContextInput[], cursor: ConversationCursor | undefined, explicit?: { start: string; end: string }): PlannedContext {
  if (!inputs.length) throw new Error('Triage context requires at least one input')
  const scope = imScope(inputs[0]!.identity)
  if (inputs.some(input => imScope(input.identity) !== scope)) throw new Error('A triage context plan covers exactly one native conversation')
  const previous = cursor?.through ?? null
  if (explicit) {
    const start = time(explicit.start), end = time(explicit.end)
    return { mode: 'explicit', window: { start: explicit.start, end: explicit.end }, previous,
      changeTriggerIds: cursor ? inputs.filter(input => time(input.at) < time(cursor.through)).map(input => input.triggerId) : [], gaps: [] }
  }
  const through = cursor ? time(cursor.through) : undefined
  const times = inputs.map(input => time(input.at))
  const oldest = Math.min(...times), newest = Math.max(...times)
  if (through === undefined) {
    // Shift the lookback start by at most one second so a six-day accumulation fits the seven-day window with its
    // newest input strictly before the exclusive end; the first-sight lookback remains 24h otherwise.
    const start = Math.max(oldest - INITIAL_LOOKBACK_MS, newest + 1000 - MAX_WINDOW_MS), end = newest + 1000
    return { mode: 'initial', window: { start: iso(start), end: iso(end) }, previous, changeTriggerIds: [], gaps: [] }
  }
  const behind = inputs.filter(input => time(input.at) < through)
  if (behind.length) {
    // A change or late arrival is re-read at its own anchor; it neither widens the incremental window nor moves the cursor back.
    if (behind.length !== inputs.length) throw new Error('A triage context plan cannot mix newer and behind-cursor messages')
    const start = oldest - INCREMENTAL_OVERLAP_MS, end = newest + 1000
    return { mode: 'change', window: { start: iso(start), end: iso(end) }, previous,
      changeTriggerIds: inputs.map(input => input.triggerId), gaps: [] }
  }
  const start = Math.max(through - INCREMENTAL_OVERLAP_MS, newest - INITIAL_LOOKBACK_MS), end = newest + 1000
  // A long dormant gap cannot be proven covered; reopen at most a day and record the explicit gap.
  const capped = start > through - INCREMENTAL_OVERLAP_MS
  return { mode: 'incremental', window: { start: iso(start), end: iso(end) }, previous, changeTriggerIds: [],
    gaps: capped ? ['incremental_gap_capped'] : [] }
}
export function coverageOf(plan: PlannedContext, identity: ImEvidence): BatchContextCoverage {
  return { scope: imScope(identity), conversation: identity.conversation, mode: plan.mode, from: plan.window.start,
    to: plan.window.end, previous: plan.previous, changeTriggerIds: plan.changeTriggerIds, planGaps: plan.gaps, gaps: [...plan.gaps] }
}
