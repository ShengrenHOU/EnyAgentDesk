/** Binds each ticket to one persistent executor and shares capacity across both paths. */
import type { AssessmentOutcome, Assignment, Ticket } from '../core/index.ts'
import { latestAssignment, liveTicket, runningAssignment, waitsForPerson } from '../core/index.ts'
import { z } from 'zod'
import { KV } from '../kv.ts'
import { Later } from '../app/effects.ts'
import { CodexExecutor, type CodexHost } from './codex.ts'
import { DshExecutor, WorkerSlots, workerSessionId } from './dsh.ts'
import { ExecutionStage, StageHandoff, stageModels } from './execution-stage.ts'

export const ExecutorKind = z.enum(['codex', 'dsh'])
export type ExecutorKind = z.infer<typeof ExecutorKind>

/** Dispatches persistent work to its recorded owner, with one shared capacity limit. */
export class ExecutorRouter {
  private readonly codex: CodexExecutor
  private readonly dsh: DshExecutor
  private readonly slots: WorkerSlots
  private readonly transferring = new Set<string>()
  constructor(private readonly host: CodexHost) {
    this.slots = new WorkerSlots(() => [...this.codex?.activeTicketIds() ?? [], ...this.dsh?.activeTicketIds() ?? []],
      () => host.store.settings().executor.maxWorkers)
    const beforeLaunch = (ticketId: string) => {
      if (this.transferring.has(ticketId) || host.ticketPaused?.(ticketId)) throw new Later('Ticket is paused or transferring')
      this.slots.beforeLaunch(ticketId, host.store.tickets.open(), host.launchReady)
    }
    const scoped = (kind: ExecutorKind): CodexHost => {
      const owns = (ticket: Ticket) => ticket.execution?.executor === kind
      const tickets = host.store.tickets
      return { ...host, get engine() { return host.engine }, slots: this.slots, beforeLaunch,
        ticketPaused: id => this.transferring.has(id) || !!host.ticketPaused?.(id),
        store: { get: host.store.get.bind(host.store), set: host.store.set.bind(host.store),
          settings: host.store.settings.bind(host.store), atomic: host.store.atomic.bind(host.store),
          afterCommit: host.store.afterCommit.bind(host.store), triggers: host.store.triggers, tickets: {
            get: id => { const ticket = tickets.get(id); return ticket && owns(ticket) ? ticket : undefined },
            list: () => tickets.list().filter(owns),
            open: () => tickets.open().filter(owns), active: () => tickets.active().filter(owns),
          } } }
    }
    this.codex = new CodexExecutor(scoped('codex'))
    this.dsh = new DshExecutor({ ...scoped('dsh'), get engine() { return host.engine }, separateDshQueue: true })
  }
  /**
   * Bind tickets created by an earlier version to the executor that owned them, and queue the deliveries and launches an
   * earlier DSH-only binding left behind. Runs once the Engine exists, before this startup dispatches work.
   */
  migrateLegacyBindings(): void {
    // Old instances selected Codex at startup. Preserve that owner when no binding was recorded.
    for (const ticket of this.host.store.tickets.list()) {
      if (!ticket.execution || ticket.execution.executor) continue
      const executor = this.host.store.get(KV.codex.binding(ticket.id)) ? 'codex'
        : this.host.store.get(KV.sessions.prompts(workerSessionId(ticket.id)))?.length ? 'dsh' : 'codex'
      this.host.engine.assignExecutor(ticket.id, executor)
    }
    // Queue rows written by an earlier DSH-only binding retain their intent after a controlled migration.
    for (const ticket of this.host.store.tickets.list().filter(ticket => ticket.execution?.executor === 'dsh')) {
      if (liveTicket(ticket) && ticket.undelivered.length) this.host.effects.enqueue('dshDelivery', ticket.id, { ticketId: ticket.id })
      const pending = latestAssignment(ticket)
      if (liveTicket(ticket) && pending?.state === 'pending' && !ticket.attention && !waitsForPerson(ticket)) this.dsh.start(ticket, pending)
    }
  }
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    if (outcome.executor === 'dsh' && outcome.stage) throw new Error('Codex stages require the Codex executor; omit stage for DSH work')
    const kind = outcome.executor ?? 'codex'
    const prepared = this.executor(kind).prepare(ticket, outcome)
    return { ...prepared, execution: { ...prepared.execution!, executor: kind } }
  }
  start(ticket: Ticket, assignment: Assignment): void { this.forTicket(ticket).start(ticket, assignment) }
  deliver(ticket: Ticket, assignment: Assignment): void { this.forTicket(ticket).deliver(ticket, assignment) }
  stop(ticket: Ticket, assignment: Assignment, reason: string): void { this.forTicket(ticket).stop(ticket, assignment, reason) }
  install(): void { this.codex.install(); this.dsh.install() }
  resume(): void { this.codex.resume(); this.dsh.resume() }
  activeCount(): number { return this.slots.used() }
  /** Release the old idle transport before atomically changing owner and queuing the complete handoff. */
  async transfer(ticketId: string, requested: ExecutorKind, input: StageHandoff, note: (id: string, text: string) => void,
    initialStage?: ExecutionStage) {
    const target = ExecutorKind.parse(requested), handoff = StageHandoff.parse(input)
    const stage = initialStage === undefined ? undefined : ExecutionStage.parse(initialStage)
    if (target === 'dsh' && stage) throw new Error('Codex stages require the Codex executor; omit stage for DSH work')
    if (this.transferring.has(ticketId)) throw new Error('An executor transfer is already in progress')
    const ticket = this.transferable(ticketId)
    const from = ticket.execution!.executor ?? 'codex'
    if (from === target) return { changed: false, executor: target }
    const version = JSON.stringify(ticket)
    this.transferring.add(ticketId)
    try {
      await this.executor(from).releaseTicket(ticketId)
      return this.host.store.atomic(() => {
        const current = this.transferable(ticketId)
        if (JSON.stringify(current) !== version) throw new Error('The ticket changed during executor release; inspect the new input before retrying')
        const at = new Date().toISOString()
        if (target === 'codex' && stage && !this.host.codex.model) {
          const previous = this.host.store.get(KV.codex.stages(ticketId))
          this.host.store.set(KV.codex.stages(ticketId), { current: stage,
            history: [...previous?.history ?? [], { stage, model: stageModels[stage], at, handoff }], turns: previous?.turns ?? [] })
        }
        this.host.engine.assignExecutor(ticketId, target, { from, to: target, at, handoff })
        note(ticketId, `Executor handoff ${from} -> ${target}. Continue the same task and preserve its mandate.\n${JSON.stringify(handoff)}`)
        return { changed: true, executor: target }
      })
    } finally { this.transferring.delete(ticketId) }
  }
  private transferable(ticketId: string): Ticket {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || !ticket.execution || !runningAssignment(ticket)) throw new Error('Executor transfer requires an open assigned ticket')
    if (this.host.closing() || this.host.paused() || ticket.paused || this.host.ticketPaused?.(ticketId)) throw new Error('A paused ticket cannot change executor')
    if (waitsForPerson(ticket) || ticket.attention || ticket.undelivered.length || ticket.inputs.some(item => item.kind === 'trigger' && item.readAt === null)) {
      throw new Error('Resolve the pending question or input before changing executor')
    }
    if (this.slots.contains(ticketId)) throw new Error('Wait for the current executor and its background work to become idle')
    const binding = this.host.store.get(KV.codex.binding(ticketId))
    if (this.host.store.get(KV.codex.stages(ticketId))?.pending || binding?.pending || binding?.turnId) {
      throw new Error('Reconcile the pending Codex turn or stage before changing executor')
    }
    return ticket
  }
  async shutdown(): Promise<void> { await Promise.all([this.codex.shutdown(), this.dsh.shutdown()]) }
  dispose(): void { this.codex.dispose(); this.dsh.dispose() }
  private executor(kind: ExecutorKind) { return kind === 'codex' ? this.codex : this.dsh }
  private forTicket(ticket: Ticket) { return this.executor(ticket.execution?.executor ?? 'codex') }
}
