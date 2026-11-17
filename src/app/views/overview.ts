/** Overview view: active system problems, tickets awaiting human action, executor load, and 24-hour trigger flow. */
import { reasonText, ticketStage, type Decision, type Thread } from '../../core/index.ts'
import type { Health } from '../../sources/host.ts'
import type { SetupProblem } from '../../setup.ts'
import { anyoneAllowed } from '../../policy.ts'
import { deferredUntil } from '../../sources/workbench-queue.ts'
import type { Store } from '../store.ts'
import { awaitingEval, dayAgo, newestFirst, ownersOf, snapshot, threadSummary, type Snapshot, type ViewHost } from './records.ts'
import { sourceHealth, type HealthMap } from './sources.ts'
import { ticketRow, type ExecutorLoad } from './tickets.ts'
import { preview } from './text.ts'
import { TriageMatters } from '../triage-matters.ts'
import { productionOverview } from '../production-triage.ts'
import { compareTickets } from '../management.ts'
import { historicalStats, type ReadResults } from '../read-models.ts'

/** Threads whose latest decision since `since` is an undismissed `unavailable` eval and that are neither evaluating nor queued. */
function unjudged(store: Store, since: string): { thread: Thread; decision: Decision }[] {
  const seen = new Set<string>()
  const queue = { store, owners: ownersOf(store) }
  return store.read.unavailableSince(since).flatMap(decision => {
    if (seen.has(decision.threadKey)) return []
    seen.add(decision.threadKey)
    const thread = store.threads.get(decision.threadKey)
    if (!thread || thread.evaluating || awaitingEval(queue, thread).length || decision.dismissed) return []
    if (store.read.latestDecision(thread.key)?.id !== decision.id) return []
    return [{ thread, decision }]
  })
}
/** Reports error health when any thread has an undismissed `unavailable` eval from the last hour without a newer decision or active eval. */
export function evalsHealth(store: Store, now = Date.now()): Health {
  const since = new Date(now - 3_600_000).toISOString()
  const open = unjudged(store, since)
  if (!open.length) return { state: 'ready', detail: 'No unavailable Eval in the last hour' }
  const latest = open[0]!.decision
  return { state: 'error', at: latest.at, detail: `${open.length} Eval(s) unavailable in the last hour without a later judgement; `
    + `the latest on ${latest.threadKey}: ${reasonText(latest.reason)}` }
}
/**
 * The conversation dock's own bounded projection: the Tickets that need the owner now, the deferred Questions, and the
 * working/waiting/delivered summary it lists. It deliberately omits triage matters, production receipts, source
 * diagnostics and the 24-hour flow, which the dock does not render and which scan the whole trigger table.
 */
export type OwnerDeskView = {
  person: ReturnType<typeof ticketRow>[]
  personDeferred?: (ReturnType<typeof ticketRow> & { until: string })[]
  work?: {
    working: ReturnType<typeof ticketRow>[]; workingTotal: number
    waiting: ReturnType<typeof ticketRow>[]; waitingTotal: number
    delivered: ReturnType<typeof ticketRow>[]; deliveredTotal: number
  }
}
export function ownerDeskView(host: ViewHost, nowMs = Date.now()): OwnerDeskView {
  return deskOf(snapshot(host), nowMs, dayAgo()).desk
}
/**
 * Builds the dock's slice once for both the dock and the full overview. Every "needs you now" count and list reads the
 * same deferral: a deferred Question stays a Ticket waiting on its person, but leaves the immediate queue until its
 * time and is listed separately with when it returns.
 */
function deskOf(view: Snapshot, nowMs: number, since: string) {
  const { store } = view
  const open = store.tickets.open().sort(compareTickets)
  const person: OwnerDeskView['person'] = [], personDeferred: NonNullable<OwnerDeskView['personDeferred']> = []
  for (const ticket of open.filter(item => ticketStage(item).stage === 'person')) {
    const until = deferredUntil(store, ticket, nowMs)
    if (until) personDeferred.push({ ...ticketRow(view, ticket), until })
    else person.push(ticketRow(view, ticket))
  }
  const working = open.filter(ticket => !ticket.paused && ticketStage(ticket).stage === 'working')
  const waiting = open.filter(ticket => ticket.paused || ticketStage(ticket).stage === 'idle')
  const delivered = store.read.deliveredSince(since).sort(newestFirst)
  const work: OwnerDeskView['work'] = open.length || delivered.length ? {
    working: working.slice(0, 10).map(ticket => ticketRow(view, ticket)), workingTotal: working.length,
    waiting: waiting.slice(0, 10).map(ticket => ticketRow(view, ticket)), waitingTotal: waiting.length,
    delivered: delivered.slice(0, 10).map(ticket => ticketRow(view, ticket)), deliveredTotal: delivered.length,
  } : undefined
  return { open, desk: { person, ...(personDeferred.length ? { personDeferred } : {}), ...(work ? { work } : {}) } }
}
/**
 * Builds the operator overview: active system problems, tickets awaiting human action, executor load, and 24-hour trigger flow.
 * @param setup - Setup problem to surface first (where setup stopped, or a Source paused by setup).
 */
export function workbenchView(host: ViewHost, health: HealthMap, policyVersionValue: string, load: ExecutorLoad, setup?: SetupProblem) {
  const { store, sources } = host
  const view = snapshot(host)
  const settings = store.settings()
  const nowMs = Date.now(), now = new Date(nowMs).toISOString(), since = dayAgo()
  const evaluating = store.threads.active().filter(thread => thread.evaluating)
  const instances = sources.instances()
  const running = instances.filter(instance => instance.enabled && instance.installed).map(instance => sourceHealth(sources, instance, health))
  const diagnostics = instances.filter(instance => instance.installed && (instance.enabled || instance.configError))
    .map(instance => sourceHealth(sources, instance, health))
  // Exclude source-owned and policy-sync health entries so only core runtime errors surface as `runtime-error`.
  const sourceParts = new Set(instances.flatMap(instance => sources.kind(instance.kind)?.health ?? []))
  const problems = [
    ...(setup ? [{ kind: 'setup' as const, ...setup }] : []),
    ...(running.length ? [] : [{ kind: 'no-source' as const }]),
    // Only allowed senders can originate work, so empty allowlists mean no request can ever become a ticket.
    ...(anyoneAllowed(settings) ? [] : [{ kind: 'no-allowed' as const }]),
    ...diagnostics.flatMap(source => source.health.filter(item => item.state === 'error').map(item => ({ kind: 'source-error' as const, source: { id: source.id, title: source.title, health: item } }))),
    ...(settings.paused ? [{ kind: 'executor-paused' as const }] : []),
    // Unavailable Evals behind the `evals` health entry are listed individually as `eval-unavailable` below.
    ...Object.entries(health).filter(([name, item]) => item.state === 'error' && !sourceParts.has(name) && !name.startsWith('sync:')
      && name !== 'evals')
      .map(([name, item]) => ({ kind: 'runtime-error' as const, name, detail: item.detail })),
    ...evaluating.filter(thread => thread.evaluating!.deadline < now)
      .map(thread => ({ kind: 'eval-overdue' as const, thread: threadSummary(view, thread) })),
    ...unjudged(store, since).map(({ thread, decision }) => ({ kind: 'eval-unavailable' as const, decisionId: decision.id,
      thread: threadSummary(view, thread), reason: decision.reason, triggerId: decision.triggerIds[0] ?? '' })),
    ...store.read.failingReplies().map(item => ({ kind: 'outgoing' as const, outgoing: { id: item.id, channel: item.channel,
      text: preview(item.text),
      attempts: item.attempts, error: item.error } })),
  ]
  const { desk, open } = deskOf(view, nowMs, since)
  return {
    problems,
    person: desk.person,
    ...(desk.personDeferred ? { personDeferred: desk.personDeferred } : {}),
    ...(desk.work ? { work: desk.work } : {}),
    executor: { ...load, maxWorkers: settings.executor.maxWorkers, idle: open.filter(ticket => ticketStage(ticket).stage === 'idle').length },
    policyVersion: policyVersionValue,
  }
}
/** Historical diagnostics are requested separately from the daily workspace. */
export function overview(host: ViewHost, health: HealthMap, policyVersionValue: string, load: ExecutorLoad, setup?: SetupProblem, history?: ReadResults['history']) {
  const { store, sources } = host
  const flow = history?.stats ?? historicalStats(store)
  return { ...workbenchView(host, health, policyVersionValue, load, setup),
    triageMatters: history?.matters ?? new TriageMatters(store, trigger => sources.imEvidence(trigger)).overview(),
    productionTriage: history?.production ?? productionOverview(store, trigger => sources.imEvidence(trigger), {}, trigger => sources.imHeader(trigger)),
    flow: { ...flow, evaluating: store.threads.active().filter(thread => thread.evaluating).length } }
}
export type OverviewView = ReturnType<typeof overview>
