/** Overview view: active system problems, tickets awaiting human action, executor load, and 24-hour trigger flow. */
import { reasonText, ticketStage, type Decision, type Thread } from '../../core/index.ts'
import type { Health } from '../../sources/host.ts'
import type { SetupProblem } from '../../setup.ts'
import { anyoneAllowed } from '../../policy.ts'
import { deferredUntil } from '../../sources/workbench-queue.ts'
import type { Store } from '../store.ts'
import { awaitingEval, dayAgo, newestFirst, ownersOf, snapshot, threadSummary, type ViewHost } from './records.ts'
import { sourceHealth, type HealthMap } from './sources.ts'
import { ticketRow, type ExecutorLoad } from './tickets.ts'
import { preview } from './text.ts'
import { TriageMatters } from '../triage-matters.ts'
import { productionOverview } from '../production-triage.ts'
import { compareTickets } from '../management.ts'

/** Threads whose latest decision since `since` is an undismissed `unavailable` eval and that are neither evaluating nor queued. */
function unjudged(store: Store, since: string): { thread: Thread; decision: Decision }[] {
  const seen = new Set<string>()
  const queue = { store, owners: ownersOf(store) }
  return store.read.decisionsOfKinds(['unavailable'], 200).filter(decision => decision.at >= since).flatMap(decision => {
    if (seen.has(decision.threadKey)) return []
    seen.add(decision.threadKey)
    const thread = store.threads.get(decision.threadKey)
    if (!thread || thread.evaluating || awaitingEval(queue, thread).length || decision.dismissed) return []
    if (store.decisions.byThread(thread.key).at(-1)?.id !== decision.id) return []
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
 * Builds the operator overview: active system problems, tickets awaiting human action, executor load, and 24-hour trigger flow.
 * @param setup - Setup problem to surface first (where setup stopped, or a Source paused by setup).
 */
export function overview(host: ViewHost, health: HealthMap, policyVersionValue: string, load: ExecutorLoad, setup?: SetupProblem) {
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
  const open = store.tickets.open().sort(compareTickets)
  // Every "needs you now" count and list reads the same deferral: a deferred Question stays a Ticket waiting on its person,
  // but leaves the immediate queue until its time and is listed separately with when it returns.
  const person: ReturnType<typeof ticketRow>[] = [], personDeferred: (ReturnType<typeof ticketRow> & { until: string })[] = []
  for (const ticket of open.filter(item => ticketStage(item).stage === 'person')) {
    const until = deferredUntil(store, ticket, nowMs)
    if (until) personDeferred.push({ ...ticketRow(view, ticket), until })
    else person.push(ticketRow(view, ticket))
  }
  const working = open.filter(ticket => !ticket.paused && ticketStage(ticket).stage === 'working')
  const waiting = open.filter(ticket => ticket.paused || ticketStage(ticket).stage === 'idle')
  const delivered = store.tickets.list().filter(ticket => ticket.ended?.by === 'executor'
    && (ticket.ended.outcome === 'completed' || ticket.ended.outcome === 'merged') && ticket.ended.at >= since).sort(newestFirst)
  const stats = Object.values(store.read.triggerStats(since))
  const received = stats.reduce((sum, item) => sum + item.received, 0), filtered = stats.reduce((sum, item) => sum + item.filtered, 0)
  const judgement = store.read.flow(since)
  return {
    triageMatters: new TriageMatters(store, trigger => sources.imEvidence(trigger)).overview(),
    productionTriage: productionOverview(store, trigger => sources.imEvidence(trigger), {}, trigger => sources.imHeader(trigger)),
    problems,
    person,
    ...(personDeferred.length ? { personDeferred } : {}),
    ...open.length || delivered.length ? { work: {
      working: working.slice(0, 10).map(ticket => ticketRow(view, ticket)), workingTotal: working.length,
      waiting: waiting.slice(0, 10).map(ticket => ticketRow(view, ticket)), waitingTotal: waiting.length,
      delivered: delivered.slice(0, 10).map(ticket => ticketRow(view, ticket)), deliveredTotal: delivered.length,
    } } : {},
    executor: { ...load, maxWorkers: settings.executor.maxWorkers, idle: open.filter(ticket => ticketStage(ticket).stage === 'idle').length },
    flow: { received, filtered, triggers: received - filtered, judged: judgement.judged, accepted: judgement.accepted,
      evaluating: evaluating.length, dropped: store.read.droppedSince(since) },
    policyVersion: policyVersionValue,
  }
}
export type OverviewView = ReturnType<typeof overview>
