/**
 * Work lines: a long-lived owner goal that groups Tickets across stages and Sessions.
 * The main Session judges whether a new message continues a line; this module stores the line,
 * its ordered Tickets and the evidence of each judgement, and builds the read model the panel shows.
 * It contains no execution or authorization rules: a Link only records the orchestrator's judgement.
 */
import { randomUUID } from 'node:crypto'
import { key, latestReport, liveTicket, ticketFollowups, ticketStage, type Ticket, type TicketPriority, type TicketStage }
  from '../core/index.ts'
import { family, type Key } from '../kv.ts'
import { preview } from './views/text.ts'

/** The worker-facing record of one line, stored under `line:<id>`. */
export const LINES = { record: family<LineRecord, [id: string]>('line:') }
export type LineStatus = 'open' | 'closed'
/** A stale source link or closed destination refuses correction without changing either line. */
export class MembershipConflict extends Error {}
export type LineAction = 'opened' | 'continued' | 'attached' | 'accepted' | 'closed' | 'reopened' | 'detached' | 'moved'
/** One recorded judgement: why the orchestrator put a Ticket on the line, continued it, or closed/reopened the line. */
export interface LineJudgement {
  at: string
  action: LineAction
  evidence: string
  ticketId?: string
  triggerId?: string
  by?: 'owner' | 'orchestrator'
  fromLine?: { id: string; title: string }
  toLine?: { id: string; title: string }
}
/** The stored line aggregate; membership changes go through this module's commands. */
export interface LineRecord {
  id: string
  title: string
  status: LineStatus
  createdAt: string
  updatedAt: string
  closedAt?: string
  /** Member Tickets in the order they joined. A Ticket belongs to at most one line. */
  tickets: string[]
  judgements: LineJudgement[]
}
/** A Ticket's current execution stage plus the facts the line view shows. */
export type LineTicketView = TicketStage & {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  priority?: TicketPriority
  ended?: Ticket['ended']
  report?: { state: NonNullable<Ticket['assignments'][number]['report']>['state']; summary: string; at: string
    deliverables?: NonNullable<Ticket['assignments'][number]['report']>['deliverables'] }
  followups: { id: string; at: string; reason: string }[]
  /** The line this Ticket belongs to, when a search result includes a still-linked Ticket. */
  line?: { id: string; title: string; status: LineStatus }
}
export type LineTicketRef = TicketStage & { id: string; title: string; updatedAt: string; ended?: Ticket['ended'] }
export interface LineSummary {
  id: string
  title: string
  status: LineStatus
  createdAt: string
  updatedAt: string
  closedAt?: string
  ticketCount: number
  openCount: number
  /** The open member Ticket that continued the line most recently. */
  active?: LineTicketRef
  lastResult?: { ticketId: string; title: string; at: string; summary: string }
  nextFollowup?: { ticketId: string; title: string; at: string; reason: string; overdue?: true }
  latestJudgement?: LineJudgement
}
export interface LineDetail extends LineSummary {
  tickets: LineTicketView[]
  judgements: LineJudgement[]
}
export interface LinesView { open: LineSummary[]; closed: LineSummary[]; closedTotal: number; generatedAt: string }
export interface LineSearchView { query: string; lines: LineSummary[]; tickets: LineTicketView[] }
/** The store surface the read model needs; `Store` and a read-only resource host both supply it. */
export interface LineReadRepo {
  get<V>(key: Key<V>): V | undefined
  keys(prefix: string): string[]
  tickets: { get(id: string): Ticket | undefined; list(): Ticket[] }
}
/** The store surface this module's commands need; `Store` supplies it directly, tests may pass a fake. */
export interface LineRepo extends LineReadRepo {
  atomic<T>(work: () => T): T
  set<V>(key: Key<V>, value: V): void
}

const time = (value: Date | string = new Date()): string => {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('A line timestamp is not a date')
  return date.toISOString()
}
const text = (value: string | undefined, name: string, max: number): string => {
  const trimmed = (value ?? '').trim()
  if (!trimmed) throw new Error(`${name} is required`)
  if (trimmed.length > max) throw new Error(`${name} is at most ${max} characters`)
  return trimmed
}
export const readLine = (repo: LineReadRepo, id: string): LineRecord | undefined => repo.get(LINES.record(id))
export function allLines(repo: LineReadRepo): LineRecord[] {
  return repo.keys(LINES.record.prefix).flatMap(name => {
    const line = repo.get(LINES.record(name.slice(LINES.record.prefix.length)))
    return line ? [line] : []
  })
}
export function findLineOf(repo: LineReadRepo, ticketId: string): LineRecord | undefined {
  return allLines(repo).find(line => line.tickets.includes(ticketId))
}
/**
 * Open Tickets on no line, newest first. The coordinator reads them as evidence that a new goal may not yet be linked;
 * the count is whole and the Items bounded, and the result never writes a line or a Ticket.
 */
export function unlinkedTickets(repo: LineReadRepo, limit = 10): { count: number; items: Ticket[] } {
  const linked = new Set(allLines(repo).flatMap(line => line.tickets))
  const open = repo.tickets.list().filter(ticket => liveTicket(ticket) && !linked.has(ticket.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  return { count: open.length, items: open.slice(0, Math.max(1, Math.min(limit, 50))) }
}
function lineMembers(repo: LineReadRepo, line: LineRecord): Ticket[] {
  return line.tickets.flatMap(id => repo.tickets.get(id) ?? [])
}
function stageOf(ticket: Ticket): TicketStage { return ticketStage(ticket) }
function ticketView(repo: LineReadRepo, ticket: Ticket): LineTicketView {
  const report = latestReport(ticket)
  const line = findLineOf(repo, ticket.id)
  return { ...stageOf(ticket), id: ticket.id, title: ticket.title, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt,
    ...(ticket.priority ? { priority: ticket.priority } : {}), ...(ticket.ended ? { ended: ticket.ended } : {}),
    ...(report ? { report: { state: report.state, summary: preview(report.summary, 600), at: report.at,
      ...(report.deliverables ? { deliverables: report.deliverables } : {}) } } : {}),
    followups: ticketFollowups(ticket).map(item => ({ id: item.id, at: item.at, reason: item.reason })),
    ...(line ? { line: { id: line.id, title: line.title, status: line.status } } : {}) }
}
function ticketRef(ticket: Ticket): LineTicketRef {
  return { ...stageOf(ticket), id: ticket.id, title: ticket.title, updatedAt: ticket.updatedAt,
    ...(ticket.ended ? { ended: ticket.ended } : {}) }
}
/** One line's read model, derived from its Tickets at read time. Missing Ticket ids are skipped rather than invented. */
export function summary(repo: LineReadRepo, line: LineRecord, now = new Date()): LineSummary {
  const members = lineMembers(repo, line)
  const open = members.filter(liveTicket).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  const ended = members.filter(ticket => !!ticket.ended).sort((a, b) => (b.ended!.at).localeCompare(a.ended!.at))
  const resultTicket = ended.find(ticket => !!latestReport(ticket))
  const result = resultTicket ? latestReport(resultTicket)! : undefined
  const next = open.flatMap(ticket => ticketFollowups(ticket).map(item => ({ ticket, item })))
    .sort((a, b) => a.item.at.localeCompare(b.item.at))[0]
  const lastActivity = [line.updatedAt, ...members.map(ticket => ticket.updatedAt)].reduce((a, b) => a > b ? a : b)
  return { id: line.id, title: line.title, status: line.status, createdAt: line.createdAt,
    updatedAt: lastActivity, ...(line.closedAt ? { closedAt: line.closedAt } : {}),
    ticketCount: line.tickets.length, openCount: open.length,
    ...(open[0] ? { active: ticketRef(open[0]) } : {}),
    ...(result && resultTicket ? { lastResult: { ticketId: resultTicket.id, title: resultTicket.title,
      at: resultTicket.ended!.at, summary: preview(result.summary, 600) } } : {}),
    ...(next ? { nextFollowup: { ticketId: next.ticket.id, title: next.ticket.title, at: next.item.at,
      reason: next.item.reason, ...(Date.parse(next.item.at) < now.getTime() ? { overdue: true as const } : {}) } } : {}),
    ...(line.judgements.at(-1) ? { latestJudgement: line.judgements.at(-1) } : {}) }
}
export function detail(repo: LineReadRepo, id: string, now = new Date()): LineDetail | undefined {
  const line = readLine(repo, id)
  if (!line) return undefined
  const members = lineMembers(repo, line).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  return { ...summary(repo, line, now), tickets: members.map(ticket => ticketView(repo, ticket)),
    judgements: line.judgements }
}
export function linesView(repo: LineReadRepo, now = new Date()): LinesView {
  const summaries = allLines(repo).map(line => summary(repo, line, now))
  const open = summaries.filter(line => line.status === 'open').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)
    || a.title.localeCompare(b.title))
  const closed = summaries.filter(line => line.status === 'closed')
    .sort((a, b) => (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt))
  return { open, closed: closed.slice(0, 10), closedTotal: closed.length, generatedAt: now.toISOString() }
}
const tokens = (query: string): string[] => query.normalize('NFKC').toLocaleLowerCase().split(/[\s,，。;；、/]+/).filter(Boolean)
const matches = (haystack: string, words: string[]): boolean => words.every(word => haystack.includes(word))
function lineHaystack(repo: LineReadRepo, line: LineRecord): string {
  const tickets = lineMembers(repo, line)
  return [line.title, ...line.judgements.map(item => item.evidence), ...tickets.flatMap(ticket => [ticket.title,
    latestReport(ticket)?.summary ?? '', ...(latestReport(ticket)?.deliverables ?? []).map(item => item.title)])]
    .join('\n').normalize('NFKC').toLocaleLowerCase()
}
function ticketHaystack(ticket: Ticket): string {
  const report = latestReport(ticket)
  return [ticket.title, report?.summary ?? '', ...(report?.deliverables ?? []).map(item => item.title)]
    .join('\n').normalize('NFKC').toLocaleLowerCase()
}
const bounded = (limit: number) => Math.max(1, Math.min(limit, 20))
/**
 * Bounded title matches for the panel's global search: a goal name recalls its lines, and nothing else is read as
 * evidence. Same-titled goals stay separate by id, and the result never creates a Ticket or changes a line.
 */
export function searchTitles(repo: LineReadRepo, query: string, limit = 5, now = new Date()): LineSummary[] {
  const words = tokens(query)
  if (!words.length) return []
  return allLines(repo).filter(line => matches(line.title.normalize('NFKC').toLocaleLowerCase(), words))
    .map(line => summary(repo, line, now))
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, bounded(limit))
}
/**
 * Finds lines and Tickets that may continue the goal described by `query`. The main Session reads this evidence before
 * deciding; the query terms are matched against titles, recorded judgement evidence, report summaries and deliverables.
 */
export function search(repo: LineReadRepo, query: string, limit = 8, now = new Date()): LineSearchView {
  const words = tokens(query)
  const summaries = allLines(repo).map(line => ({ line, summary: summary(repo, line, now) }))
  const lines = (words.length ? summaries.filter(item => matches(lineHaystack(repo, item.line), words))
    : summaries.filter(item => item.summary.status === 'open'))
    .map(item => item.summary)
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, bounded(limit))
  const tickets = words.length ? repo.tickets.list().filter(ticket => matches(ticketHaystack(ticket), words))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10).map(ticket => ticketView(repo, ticket)) : []
  return { query, lines, tickets }
}
function requireLine(repo: LineReadRepo, id: string): LineRecord {
  const line = readLine(repo, id)
  if (!line) throw new Error(`Unknown line ${id}`)
  return line
}
function requireOpen(repo: LineReadRepo, id: string): LineRecord {
  const line = requireLine(repo, id)
  if (line.status === 'closed') throw new Error(`Line “${line.title}” is closed; restore it to open with evidence before adding work`)
  return line
}
function record(line: LineRecord, entry: LineJudgement, at: string, membershipChanged = false): void {
  const duplicate = !membershipChanged && line.judgements.some(item => item.action === entry.action && item.ticketId === entry.ticketId
    && item.triggerId === entry.triggerId && item.evidence === entry.evidence)
  if (!duplicate) line.judgements.push(entry)
  line.updatedAt = at
}
/** Opens the goal the coordinator chose; only a retry of the same creation request reuses its line. */
export function open(repo: LineRepo, input: { title: string; evidence: string; requestId?: string; at?: Date | string }):
  { line: LineRecord; created: boolean } {
  const title = text(input.title, 'A line title', 200)
  const evidence = text(input.evidence, 'The evidence for opening a line', 1000)
  const at = time(input.at)
  const id = key('line', input.requestId ?? randomUUID())
  const existing = readLine(repo, id)
  if (existing) {
    return { line: existing, created: false }
  }
  const line: LineRecord = { id, title, status: 'open', createdAt: at, updatedAt: at, tickets: [],
    judgements: [{ at, action: 'opened', evidence }] }
  repo.set(LINES.record(id), line)
  return { line, created: true }
}
/**
 * Puts an existing Ticket on a line, recording why the orchestrator judged it to belong there.
 * A Ticket belongs to one line; the call refuses another line and a closed one.
 */
export function attach(repo: LineRepo, input: { lineId: string; ticketId: string; evidence: string; triggerId?: string
  action?: Extract<LineAction, 'attached' | 'continued' | 'accepted'>; at?: Date | string }): { line: LineRecord; changed: boolean } {
  const line = requireOpen(repo, input.lineId)
  const ticket = repo.tickets.get(input.ticketId)
  if (!ticket) throw new Error(`Unknown ticket ${input.ticketId}`)
  const evidence = text(input.evidence, 'The evidence for linking this work to the line', 1000)
  const other = findLineOf(repo, input.ticketId)
  if (other && other.id !== line.id) throw new Error(`Ticket “${ticket.title}” already belongs to line “${other.title}” (${other.id})`)
  const at = time(input.at)
  const changed = !line.tickets.includes(input.ticketId)
  if (changed) line.tickets.push(input.ticketId)
  record(line, { at, action: input.action ?? 'attached', ticketId: input.ticketId, ...(input.triggerId ? { triggerId: input.triggerId } : {}),
    evidence }, at, changed)
  repo.set(LINES.record(line.id), line)
  return { line, changed }
}
/** Corrects a soft link atomically, without changing any Ticket, permission, subscription or execution state. */
export function reassign(repo: LineRepo, input: { lineId: string; ticketId: string; targetLineId: string | null;
  evidence: string; by: 'owner' | 'orchestrator'; at?: Date | string }): { changed: boolean } {
  return repo.atomic(() => {
    const from = requireLine(repo, input.lineId)
    if (!repo.tickets.get(input.ticketId)) throw new Error(`Unknown ticket ${input.ticketId}`)
    const evidence = text(input.evidence, 'The evidence for correcting this membership', 1000)
    const to = input.targetLineId === null ? undefined : requireLine(repo, input.targetLineId)
    const current = findLineOf(repo, input.ticketId)
    if (current?.id !== from.id) {
      if (current?.id === to?.id) return { changed: false }
      throw new MembershipConflict('Ticket membership changed; refresh the line before correcting it')
    }
    if (to?.id === from.id) return { changed: false }
    if (to?.status === 'closed') throw new MembershipConflict('The target line is closed; explicitly restore it before moving work')
    const at = time(input.at)
    const entry: LineJudgement = { at, action: to ? 'moved' : 'detached', evidence, by: input.by, ticketId: input.ticketId,
      fromLine: { id: from.id, title: from.title }, ...(to ? { toLine: { id: to.id, title: to.title } } : {}) }
    // State-based no-ops keep retries quiet while retaining every later correction, even with the same reason.
    repo.set(LINES.record(from.id), { ...from, tickets: from.tickets.filter(id => id !== input.ticketId),
      updatedAt: at, judgements: [...from.judgements, entry] })
    if (to) repo.set(LINES.record(to.id), { ...to, tickets: [...to.tickets, input.ticketId],
      updatedAt: at, judgements: [...to.judgements, entry] })
    return { changed: true }
  })
}
/** The open member Ticket that most recently changed, which a same-line continuation takes by default. */
export function activeTicket(repo: LineReadRepo, line: LineRecord): Ticket | undefined {
  return lineMembers(repo, line).filter(liveTicket).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)
    || a.id.localeCompare(b.id))[0]
}
/** Closes a line once none of its Tickets is open; a still-open Ticket must be finished or stopped first. */
export function close(repo: LineRepo, input: { lineId: string; evidence: string; at?: Date | string }):
  { line: LineRecord; closed: boolean } {
  const line = requireLine(repo, input.lineId)
  const evidence = text(input.evidence, 'The evidence for closing the line', 1000)
  if (line.status === 'closed') return { line, closed: false }
  const openTickets = lineMembers(repo, line).filter(liveTicket)
  if (openTickets.length) {
    const names = openTickets.slice(0, 4).map(ticket => `“${ticket.title}”`).join('、')
    throw new Error(`Line “${line.title}” still has ${openTickets.length} open ticket(s): ${names}. Finish or stop them before closing the line.`)
  }
  const at = time(input.at)
  line.status = 'closed'; line.closedAt = at
  record(line, { at, action: 'closed', evidence }, at)
  repo.set(LINES.record(line.id), line)
  return { line, closed: true }
}
/** Reopens a closed line only on an explicit judgement with evidence; messages alone never reopen it. */
export function reopen(repo: LineRepo, input: { lineId: string; evidence: string; at?: Date | string }):
  { line: LineRecord; reopened: boolean } {
  const line = requireLine(repo, input.lineId)
  const evidence = text(input.evidence, 'The evidence for restoring the line', 1000)
  if (line.status === 'open') return { line, reopened: false }
  const at = time(input.at)
  delete line.closedAt
  line.status = 'open'
  record(line, { at, action: 'reopened', evidence }, at)
  repo.set(LINES.record(line.id), line)
  return { line, reopened: true }
}
