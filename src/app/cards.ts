/** Compact, bounded model-facing projections of triggers, tickets, threads, and decisions; full texts stay behind readable resources. */
import { latestReport, reasonText, threadKey, ticketFollowups, ticketStage, type Decision, type Mandate, type Thread, type Ticket, type TicketInput,
  type Trigger, type TriggerDisposition } from '../core/index.ts'
import { pullOf } from '../sources/github-pull.ts'
import { batchLine, inputResource } from '../executor/dsh.ts'
import { allLines, type LineRepo, type LineStatus } from './lines.ts'

/** Collapses whitespace and truncates text for display previews while keeping code, angle brackets, and links intact for model readers. */
export function preview(text: string): string { return text.replace(/\s+/g, ' ').slice(0, 160) }
export function triggerCard(trigger: Trigger, disposition?: TriggerDisposition) {
  return { trigger_id: trigger.id, source: trigger.source, ...(trigger.url ? { source_url: trigger.url } : {}), actor: trigger.actor.id, thread: threadKey(trigger.threads[0]!), human: trigger.human, at: trigger.at,
    preview: preview(trigger.text), chars: trigger.text.length, read: `trigger/${trigger.id}`,
    ...(disposition ? { disposition: { ...(disposition.filtered ? { filtered: reasonText(disposition.filtered) } : {}),
      ...(disposition.decisionId ? { decision_id: disposition.decisionId } : {}),
      delivered_to: disposition.fanout } } : {}) }
}
/** The states a ticket card shows: an open ticket's stage (docs/003), and an ended ticket's outcome. */
export const TICKET_STATES = ['person/delivery', 'person/answer', 'person/review', 'person/blocked', 'person/failed', 'working', 'working/queued', 'working/answer-pending', 'idle',
  'completed', 'merged', 'closed', 'dropped', 'stopped'] as const
export type TicketCardState = typeof TICKET_STATES[number]
function cardState(ticket: Ticket): TicketCardState {
  if (ticket.ended) return ticket.ended.outcome
  const stage = ticketStage(ticket)
  if (stage.stage === 'person') return `person/${stage.action}`
  return stage.stage === 'idle' ? 'idle' : stage.stage === 'working' && stage.action ? `working/${stage.action}` : 'working'
}
export function ticketCard(ticket: Ticket) {
  const ended = ticket.ended && { at: ticket.ended.at, by: ticket.ended.by, reason: ticket.ended.reason ?? ticket.ended.outcome }
  const { attention } = ticket
  return { ticket_id: ticket.id, title: ticket.title, state: cardState(ticket), strength: ticket.mandate.strength,
    ...(pullOf(ticket) ? { pr_number: pullOf(ticket) } : {}), ...(ended ? { ended } : {}),
    ...(attention ? { attention: { id: attention.id, question: attention.question, ...attention.triggerId ? { trigger_id: attention.triggerId } : {} } } : {}),
    preview: preview(latestReport(ticket)?.summary ?? ''), read: `ticket/${ticket.id}` }
}
/** Strips `policyVersion`, an internal hash that callers never query by. */
const mandateOf = ({ policyVersion: _version, ...mandate }: Mandate) => mandate
export const INPUTS = 10, ASSIGNMENTS = 3
const INPUT_TEXT = 80
/** Summarizes a ticket input inline for short text or as a resource reference, omitting decision IDs for worker Sessions. */
export function inputLine(ticket: Ticket, input: TicketInput, worker = false) {
  const read = { read: inputResource(ticket.id, input.id) }
  const names = input.kind === 'trigger' || input.kind === 'resumed' ? { trigger_id: input.triggerId }
    : input.kind === 'reopen' && !worker ? { decision_id: input.decisionId }
    : input.kind !== 'text' ? read
    : input.text.length <= INPUT_TEXT ? { text: input.text }
    : { preview: preview(input.text).slice(0, INPUT_TEXT), chars: input.text.length, ...read }
  return { kind: input.kind, at: input.at, ...names, ...ticket.undelivered.includes(input.id) ? { undelivered: true } : {} }
}
export function assignmentLine(ticket: Ticket, item: Ticket['assignments'][number]) {
  return { id: item.id, state: item.state, at: item.createdAt, ...(item.endedReason ? { ended_reason: reasonText({ code: item.endedReason }) } : {}),
    ...(item.report ? { report: { state: item.report.state, at: item.report.at, preview: preview(item.report.summary).slice(0, 100),
      ...(item.report.deliverables?.length ? { deliverables: item.report.deliverables } : {}),
      ...(item.report.method ? { method: item.report.method } : {}), ...(item.report.skills?.length ? { skills: item.report.skills } : {}),
      chars: item.report.summary.length, read: `ticket/${ticket.id}/report/${item.id}` } } : {}) }
}
/**
 * A compact reading of one report: its conclusion, the lines that carry a number or a link (its key figures and evidence),
 * and a `read` resource for the full text. History uses this so a model can recall conclusions and totals without loading
 * every report whole; the complete text stays on disk behind the report resource.
 */
export function reportExcerpt(ticket: Ticket, item: Ticket['assignments'][number]) {
  const report = item.report
  if (!report) return undefined
  const paragraphs = report.summary.split(/\n{2,}/).map(part => part.trim()).filter(Boolean)
  const conclusion = (paragraphs[0] ?? '').slice(0, 240)
  const key = [...new Set(report.summary.split('\n').map(line => line.trim()).filter(line => line && line !== paragraphs[0]
    && (/\d/.test(line) || /https?:\/\//.test(line))))].slice(0, 4)
  return { assignment_id: item.id, state: report.state, at: report.at, conclusion,
    ...key.length ? { key } : {}, ...(report.deliverables?.length ? { deliverables: report.deliverables } : {}),
    ...(report.method ? { method: report.method } : {}), ...(report.skills?.length ? { skills: report.skills } : {}),
    chars: report.summary.length, read: `ticket/${ticket.id}/report/${item.id}` }
}
export function reportHistory(ticket: Ticket, offset: number, size: number) {
  const reports = ticket.assignments.filter(item => item.report)
  const newest = reports.slice().reverse()
  const more = offset + size < newest.length
  return { items: newest.slice(offset, offset + size).flatMap(item => { const excerpt = reportExcerpt(ticket, item); return excerpt ? [excerpt] : [] }),
    ...more ? { next_offset: offset + size } : {} }
}
export function newestPage<T, L>(items: readonly T[], offset: number, size: number, line: (item: T) => L, next: string) {
  const newest = items.slice().reverse()
  const more = offset + size < newest.length
  return { items: newest.slice(offset, offset + size).map(line), ...more ? { next_resource: next, next_offset: offset + size } : {} }
}
export interface TicketThread { thread: string; context?: true; bound?: true }
/** Projects a ticket with its linked triggers, threads, and first pages of assignments and inputs, omitting decision IDs for workers. */
export function ticketDetails(ticket: Ticket, threads: TicketThread[], batch: readonly Trigger[], worker = false) {
  // Drop card preview because the latest report's preview is already shown on the first assignment entry.
  const { preview: _preview, ...card } = ticketCard(ticket)
  const followups = ticketFollowups(ticket)
  return { ...card, trigger_id: ticket.origin.triggerId, ...batch.length ? { batch: batch.map(batchLine) } : {},
    ...worker ? {} : { decision_id: ticket.decisionId }, threads, directory: ticket.execution?.directory,
    scope: ticket.mandate.scope, requested_by: ticket.mandate.actor.id,
    ...ticket.execution?.requiredSkills?.length ? { required_skills: ticket.execution.requiredSkills } : {},
    ...followups.length ? { followups } : {},
    assignments: newestPage(ticket.assignments, 0, ASSIGNMENTS, item => assignmentLine(ticket, item), `ticket/${ticket.id}/assignments`),
    inputs: newestPage(ticket.inputs, 0, INPUTS, input => inputLine(ticket, input, worker), `ticket/${ticket.id}/inputs`),
    assignment: `ticket/${ticket.id}/assignment`, result: `ticket/${ticket.id}/result`, transcript: `ticket/${ticket.id}/transcript` }
}

export function threadCard(thread: Thread, label: string) {
  return { thread: thread.key, label, source: thread.ref.source, tickets: thread.subscriptions,
    ...(thread.evaluating ? { evaluating: { since: thread.evaluating.startedAt, deadline: thread.evaluating.deadline } } : {}),
    pending: thread.pending.length,
    ...(thread.meta.pollError ? { error: preview(String(thread.meta.pollError)) } : {}), ...(thread.meta.url ? { url: thread.meta.url } : {}),
    read: `thread/${thread.key}` }
}
export function decisionCard(decision: Decision) {
  return { decision_id: decision.id, kind: decision.kind, reason: reasonText(decision.reason), strength: decision.strength,
    thread: decision.threadKey,
    trigger_ids: decision.triggerIds, ...(decision.ticketId ? { ticket_id: decision.ticketId } : {}), at: decision.at,
    read: `decision/${decision.id}` }
}
export function decisionDetails(decision: Decision) {
  return { ...decisionCard(decision), ...(decision.mandate ? { mandate: mandateOf(decision.mandate) } : {}),
    ...(decision.audit ? { audit: decision.audit } : {}) }
}
/** Slices text by UTF-16 code units so concatenated pages reconstruct the exact string. */
export function textPage(resource: string, text: string, offset: number, limit: number) {
  const end = Math.min(text.length, offset + limit)
  return { resource, offset, total_chars: text.length, next_offset: end < text.length ? end : null, text: text.slice(offset, end) }
}
export function relatedTickets(tickets: readonly Ticket[]) {
  const order = [...tickets].sort((a, b) => Number(!a.ended) === Number(!b.ended) ? b.createdAt.localeCompare(a.createdAt) : a.ended ? 1 : -1)
  return { related_tickets: order.slice(0, 8).map(ticketCard), tickets_total: tickets.length }
}
/** The fixed meaning of `related_lines`: recalled terms are evidence for the main Session's judgement, never a membership verdict. */
export const RELATED_LINES_NOTE = '以下是按消息词面召回的可能相关主线，只是证据、不是归属结论：判断是否同一目标后，再决定 continue / attach / accept with line_id / 新建线（closed 线先带证据 restore）。'
export const RELATED_LINES = 5, RELATED_LINE_TICKETS = 3, RELATED_LINE_TERMS = 6
export interface RelatedLineTicket { ticket_id: string; title: string; at: string; state: TicketCardState; report?: string }
export interface RelatedLine {
  line_id: string; title: string; status: LineStatus; updated_at: string
  /** The terms that recalled this line; they do not establish membership. */
  matched: string[]
  /** The open member Ticket that changed most recently, when the line has one. */
  active?: { ticket_id: string; title: string; state: TicketCardState }
  recent_tickets: RelatedLineTicket[]
  read: { tool: 'orchestrator_line'; action: 'view'; line_id: string }
}
export interface RelatedLines { note: string; items: RelatedLine[] }
const TERM_CHARS = 6
const NOT_TERM = /[^\p{L}\p{N}]+/u
const CJK = /[\u3400-\u9fff]+/g
const LATIN = /[a-z][a-z0-9-]+/g
const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase()
/**
 * The words of `corpus` that also appear in `text`, longest first. It is a bounded recall aid for Chinese and Latin
 * terms, not a tokenizer or a semantic comparison: a recall misses rather than inventing a link.
 */
function sharedTerms(corpus: string, text: string): string[] {
  const terms = new Set<string>()
  for (const segment of corpus.split(NOT_TERM)) {
    if (!segment) continue
    for (const run of segment.match(CJK) ?? []) {
      for (let size = Math.min(TERM_CHARS, run.length); size >= 2; size--) {
        for (let start = 0; start + size <= run.length; start++) {
          const term = run.slice(start, start + size)
          if (text.includes(term)) terms.add(term)
        }
      }
    }
    for (const word of segment.match(LATIN) ?? []) if (word.length >= 3 && text.includes(word)) terms.add(word)
  }
  const longest = [...terms].sort((a, b) => b.length - a.length || a.localeCompare(b))
  // Keep the longest matches only: a short one adds nothing when a longer one already covers it.
  const kept: string[] = []
  for (const term of longest) {
    if (kept.some(other => other.includes(term))) continue
    kept.push(term)
    if (kept.length >= RELATED_LINE_TERMS) break
  }
  return kept
}
/**
 * Lines a message may continue, recalled from the message's own words against line titles, member Ticket titles and
 * recent membership evidence. The result is bounded, read-only evidence for the main Session: it never attaches,
 * opens or closes a line, and no match at all omits the field rather than reporting an empty claim.
 */
export function relatedLines(repo: LineRepo, text: string, limit = RELATED_LINES): RelatedLines | undefined {
  const query = normalize(text)
  if (!query) return undefined
  const entries = allLines(repo).flatMap(line => {
    const tickets = line.tickets.flatMap(id => repo.tickets.get(id) ?? [])
    const corpus = normalize([line.title, ...tickets.map(ticket => ticket.title), ...line.judgements.slice(-3).map(item => item.evidence)]
      .join('\n').slice(0, 4000))
    const matched = sharedTerms(corpus, query)
    if (!matched.length) return []
    const updatedAt = [line.updatedAt, ...tickets.map(ticket => ticket.updatedAt)].reduce((a, b) => a > b ? a : b)
    return [{ line, tickets, matched, updatedAt }]
  })
  if (!entries.length) return undefined
  // A term that also recalls many lines is weaker evidence than one only this line shares.
  const frequency = new Map<string, number>()
  for (const entry of entries) for (const term of entry.matched) frequency.set(term, (frequency.get(term) ?? 0) + 1)
  const rank = (entry: typeof entries[number]): number => entry.matched.reduce((sum, term) => sum + (term.length - 1) / (1 + (frequency.get(term) ?? 1)), 0)
  const items = [...entries].sort((a, b) => (a.line.status === b.line.status ? 0 : a.line.status === 'open' ? -1 : 1)
    || rank(b) - rank(a) || b.updatedAt.localeCompare(a.updatedAt) || a.line.id.localeCompare(b.line.id))
    .slice(0, Math.max(1, Math.min(limit, 10)))
    .map(({ line, tickets, matched, updatedAt }): RelatedLine => {
      const open = tickets.filter(ticket => !ticket.ended).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      const recent = [...tickets].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(0, RELATED_LINE_TICKETS)
      const active = open[0]
      return { line_id: line.id, title: line.title, status: line.status, updated_at: updatedAt, matched,
        ...(active ? { active: { ticket_id: active.id, title: active.title, state: ticketCard(active).state } } : {}),
        recent_tickets: recent.map(ticket => {
          const report = latestReport(ticket)
          return { ticket_id: ticket.id, title: ticket.title, at: ticket.createdAt, state: ticketCard(ticket).state,
            ...(report ? { report: preview(report.summary) } : {}) }
        }),
        read: { tool: 'orchestrator_line', action: 'view', line_id: line.id } }
    })
  return { note: RELATED_LINES_NOTE, items }
}
