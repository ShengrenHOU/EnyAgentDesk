/** Model-written reading projection; Tickets and Threads remain the source of business state. */
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { packagePath } from '../infra/paths.ts'
import { record } from '../kv.ts'
import type { SourceContext } from './host.ts'
import { latestReport, ticketFollowups, threadKey as keyOfThread } from '../core/index.ts'
import type { WorkbenchConfig } from './workbench.ts'

const packageVersion = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(packagePath('package.json'), 'utf8'))).version

export const FocusSchema = z.object({
  headline: z.string().trim().min(1).max(500),
  items: z.array(z.object({
    title: z.string().trim().min(1).max(160),
    reason: z.string().trim().min(1).max(800),
    nextAction: z.string().trim().min(1).max(600),
    evidenceAt: z.iso.datetime().describe('Ticket read version when ticketId is set, otherwise the Thread read version.'),
    threadEvidenceAt: z.iso.datetime().optional().describe('Required when both ticketId and threadKey are cited. Copy the Thread read version.'),
    ticketId: z.string().min(1).optional(),
    threadKey: z.string().min(1).optional(),
    domainId: z.string().min(1).optional(),
  }).strict().refine(item => !!item.ticketId || !!item.threadKey, 'A suggestion needs an existing Ticket or Thread')
    .refine(item => !item.ticketId || !item.threadKey || !!item.threadEvidenceAt, 'Two references require both read versions')).max(5),
}).strict()
export type Focus = z.infer<typeof FocusSchema>
interface FocusRecord extends Focus { generatedAt: string }
const focusKey = record<FocusRecord>('workbench:focus')
export const focusRequestKey = record<{ id: string; at: string }>('workbench:focus-request')

export function publishFocus(source: SourceContext, input: Focus, at: string) {
  const focus = FocusSchema.parse(input)
  const domains = source.config<WorkbenchConfig>('workbench')?.domains ?? []
  for (const item of focus.items) {
    if (item.domainId && !domains.some(domain => domain.id === item.domainId && domain.state === 'active')) throw new Error('Suggestion refers to an unknown or dormant domain')
    const ticket = item.ticketId ? source.tickets.get(item.ticketId) : undefined
    const thread = item.threadKey ? source.threads.get(item.threadKey) : undefined
    if (item.ticketId && !ticket) throw new Error('Suggestion refers to an unknown Ticket')
    if (item.threadKey && !thread) throw new Error('Suggestion refers to an unknown Thread')
    // A reading projection preserves its actual read version; concurrent updates surface as stale, not a failed publication.
  }
  source.state.set(focusKey, { ...focus, generatedAt: at })
  return { saved: true, generatedAt: at, items: focus.items.length }
}

export function readFocus(source: SourceContext) {
  const stored = source.state.get(focusKey)
  // The 0.4.0 preview did not record the model's read version; regenerate that projection.
  const focus = stored?.items.every(item => item.evidenceAt) ? stored : undefined
  return { domains: source.config<WorkbenchConfig>('workbench')?.domains ?? [], focus: focus ? { ...focus, items: focus.items.map(item => {
    const ticket = item.ticketId ? source.tickets.get(item.ticketId) : undefined
    const thread = item.threadKey ? source.threads.get(item.threadKey) : undefined
    const ticketChanged = !!item.ticketId && ticket?.updatedAt !== item.evidenceAt
    const threadVersion = item.ticketId ? item.threadEvidenceAt : item.evidenceAt
    const threadChanged = !!item.threadKey && (!threadVersion || thread?.lastAt !== threadVersion)
    return { ...item, stale: ticketChanged || threadChanged,
      evidence: ticket?.title ?? (typeof thread?.meta.label === 'string' ? thread.meta.label : item.threadKey) ?? '' }
  }) } : null, requested: source.state.get(focusRequestKey) ?? null }
}

/**
 * Include an optional projection field only when it has a value. DSH requires a tool result to be lossless JSON and
 * rejects the whole result when an own property is `undefined`, as an absent attention, follow-up, end reason or label
 * would otherwise make every focus refresh fail.
 */
const defined = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : { [key]: value } as Record<K, V>

export function focusContext(source: SourceContext, ticketId?: string, threadKey?: string) {
  const tickets = ticketId ? [source.tickets.get(ticketId)].filter(item => item !== undefined) : source.tickets.open()
  const followed = tickets.flatMap(ticket => (ticket.follows ?? []).map(follow => follow.thread))
  const origins = tickets.flatMap(ticket => (source.triggers.get(ticket.origin.triggerId)?.threads ?? []).map(keyOfThread))
  const keys = threadKey ? [threadKey] : [...new Set([...followed, ...origins])]
  const threads = keys.flatMap(key => {
    const thread = source.threads.get(key)
    if (!thread?.lastAt) return []
    const latest = source.triggers.latest(thread.key)
    return [{ threadKey: thread.key, evidenceAt: thread.lastAt, ...defined('label', thread.meta.label),
      ...defined('latestTriggerId', latest?.id), latest: latest?.text.slice(0, 4000) ?? '', contentPartial: (latest?.text.length ?? 0) > 4000 }]
  }).sort((a, b) => b.evidenceAt.localeCompare(a.evidenceAt)).slice(0, 12)
  return { tickets: tickets.map(ticket => {
    const attention = ticket.attention
    const ended = ticket.ended
    const followups = ticketFollowups(ticket)
    return { ticketId: ticket.id, title: ticket.title, evidenceAt: ticket.updatedAt,
      summary: latestReport(ticket)?.summary ?? '', ...defined('priority', ticket.priority), ...defined('dueAt', ticket.dueAt),
      ...defined('attention', attention && { id: attention.id, question: attention.question, ...defined('triggerId', attention.triggerId) }),
      ...defined('followup', followups[0]), ...defined('followups', followups.length ? followups : undefined),
      ...defined('ended', ended && { at: ended.at, by: ended.by, outcome: ended.outcome, ...defined('reason', ended.reason) }),
      mandate: { scope: ticket.mandate.scope, strength: ticket.mandate.strength } }
  }), threads, domains: source.config<WorkbenchConfig>('workbench')?.domains ?? [], runtime: { packageVersion } }
}

