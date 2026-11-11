/** The owner's decision queue: a read model over pending Questions with the owner's own defer and ignore records. */
import { key, type DecisionAdvice } from '../core/index.ts'
import { family, type Key } from '../kv.ts'
import type { SourceContext } from './host.ts'

/** One pending decision as the panel shows it: who asks, what it is, what the agent recommends, and the draft. */
export interface QueueItem {
  id: string
  ticketId: string
  attentionId: string
  title: string
  question: string
  advice?: DecisionAdvice
  /** The Source the Ticket was accepted from, when it has one. */
  source?: string
  at: string
  priority?: string
}
export interface DeferredItem extends QueueItem { until: string }
export interface IgnoredItem extends QueueItem { ignoredAt: string; reason: string }
export interface QueueView {
  items: QueueItem[]
  deferred: DeferredItem[]
  ignored: IgnoredItem[]
  counts: { open: number; deferred: number; ignored: number }
}

/** A deferral the owner chose; it never answers the question, it only keeps the row out of the list until `until`. */
export const queueDefer = family<{ ticketId: string; attentionId: string; at: string; until: string }, [ticketId: string, attentionId: string]>(
  'workbench-queue-defer:')
/** An owner's "no action needed" decision, kept after its answer cleared the Question so it can be corrected. */
export const queueIgnore = family<{ ticketId: string; attentionId: string; title: string; question: string;
  reason: string; at: string }, [ticketId: string, attentionId: string]>('workbench-queue-ignore:')
/** How long an ignored row stays in the folded history before it is archived out of the queue view. */
export const IGNORE_RETENTION_MS = 30 * 24 * 3_600_000
/** The longest a person may defer one decision in a single action. */
export const DEFER_LIMIT_MS = 90 * 24 * 3_600_000
const PRIORITY: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }

const item = (ticket: { id: string; title: string; updatedAt: string; priority?: string; channels: { source: string }[] },
  attention: { id: string; question: string; advice?: DecisionAdvice }): QueueItem => ({
  id: key('queue-item', ticket.id, attention.id), ticketId: ticket.id, attentionId: attention.id,
  title: ticket.title, question: attention.question, ...(attention.advice ? { advice: attention.advice } : {}),
  ...(ticket.channels[0]?.source ? { source: ticket.channels[0].source } : {}), at: ticket.updatedAt,
  ...(ticket.priority ? { priority: ticket.priority } : {}),
})
const order = (a: QueueItem, b: QueueItem) => (PRIORITY[a.priority ?? 'normal']! - PRIORITY[b.priority ?? 'normal']!)
  || a.at.localeCompare(b.at)

type DeferralState = { get<V>(key: Key<V>): V | undefined }
/**
 * The time a live deferral keeps this Ticket's current Question out of every "needs you now" count and list, or
 * undefined when it is absent or due. The Today queue and the main-conversation overview both read this one record.
 */
export function deferredUntil(state: DeferralState, ticket: { id: string; attention?: { id: string } },
  now = Date.now()): string | undefined {
  const attention = ticket.attention
  if (!attention) return undefined
  const defer = state.get(queueDefer(ticket.id, attention.id))
  return defer && defer.until > new Date(now).toISOString() ? defer.until : undefined
}

/**
 * Reads the queue from the Tickets and this Source's own records. It writes nothing: a deferred row leaves the open list and
 * returns when `until` passes, and an ignored row stays in the folded history with its reason so it can be corrected.
 */
export function readQueue(source: SourceContext, now = Date.now()): QueueView {
  const items: QueueItem[] = [], deferred: DeferredItem[] = []
  for (const ticket of source.tickets.open()) {
    const attention = ticket.attention
    if (!attention) continue
    const row = item(ticket, attention)
    const until = deferredUntil(source.state, ticket, now)
    if (until) deferred.push({ ...row, until })
    else items.push(row)
  }
  const ignored = source.state.keys(queueIgnore).flatMap(entry => {
    const record = source.state.get(entry)
    if (!record || record.at < new Date(now - IGNORE_RETENTION_MS).toISOString()) return []
    return [{ id: key('queue-item', record.ticketId, record.attentionId), ticketId: record.ticketId,
      attentionId: record.attentionId, title: record.title, question: record.question, at: record.at,
      ignoredAt: record.at, reason: record.reason }]
  }).sort((a, b) => b.ignoredAt.localeCompare(a.ignoredAt))
  items.sort(order); deferred.sort(order)
  return { items, deferred, ignored, counts: { open: items.length, deferred: deferred.length, ignored: ignored.length } }
}

/** The open Ticket whose current Question is the one this action names; a replaced Question means the row is stale. */
function current(source: SourceContext, ticketId: string, attentionId: string) {
  const ticket = source.tickets.get(ticketId)
  if (!ticket || ticket.ended) throw new Error('This decision has ended; reload the workbench')
  if (ticket.attention?.id !== attentionId) throw new Error('This decision has ended or been replaced; reload the workbench')
  return ticket
}

/** Keeps one decision out of the open list until `until`; it does not answer the Question or create work. */
export function deferDecision(source: SourceContext, ticketId: string, attentionId: string, until: string, now = Date.now()) {
  const ticket = current(source, ticketId, attentionId)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(until)) throw new Error('A deferral needs an ISO time')
  const milliseconds = Date.parse(until) - now
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > DEFER_LIMIT_MS) {
    throw new Error('Defer this decision to a future time within 90 days')
  }
  source.state.set(queueDefer(ticketId, attentionId), { ticketId, attentionId, at: new Date(now).toISOString(), until })
  return { saved: true as const, until }
}

/** Puts a deferred or ignored decision back into the open list when it still has a current Question. */
export function restoreDecision(source: SourceContext, ticketId: string, attentionId: string) {
  const ticket = source.tickets.get(ticketId)
  const attention = ticket?.attention
  const restore = attention?.id === attentionId
  if (restore) source.state.set(queueDefer(ticketId, attentionId), undefined)
  source.state.set(queueIgnore(ticketId, attentionId), undefined)
  return { saved: true as const, open: restore }
}

/**
 * Records the owner's "no action needed" decision as the answer to the current Question, in that order: an answer that the
 * Engine refuses leaves no record that could hide a still-pending decision, and a recorded reason keeps the correction path.
 */
export function ignoreDecision(source: SourceContext, ticketId: string, attentionId: string, reason: string, now = Date.now()) {
  const ticket = current(source, ticketId, attentionId)
  const text = reason.trim()
  if (!text || text.length > 500) throw new Error('Give a reason of 1 to 500 characters for “no action needed”')
  const answer = source.tickets.answerAttention(ticketId, attentionId, `本人判断无需动作：${text}。请按这个判断继续当前工单；如果因此无事可做，请直接结束并说明。`)
  source.state.set(queueIgnore(ticketId, attentionId), { ticketId, attentionId, title: ticket.title,
    question: ticket.attention!.question, reason: text, at: new Date(now).toISOString() })
  return answer
}

/** Drops only the folded record after the owner corrected a “no action needed” decision on the Ticket itself. */
export function forgetDecision(source: SourceContext, ticketId: string, attentionId: string) {
  source.state.set(queueIgnore(ticketId, attentionId), undefined)
  return { saved: true as const }
}
