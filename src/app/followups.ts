/** Durable one-time follow-ups that return delegated work to its existing ticket and executor, and their one-way move to a DSH automation task. */
import { z } from 'zod'
import { Later, type Effects } from './effects.ts'
import { key, latestReport, liveTicket, runningAssignment, ticketFollowups, waitsForPerson, UserError, type Engine, type Ticket, type TicketFollowup }
  from '../core/index.ts'
import { KV, family, type Key } from '../kv.ts'
import type { Store } from './store.ts'

export const FollowupRequestSchema = z.object({
  request_id: z.string().trim().min(1).max(200),
  at: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(1).max(2000),
}).strict()
export type FollowupRequest = z.infer<typeof FollowupRequestSchema>

/** A DSH Host Schedule task a mechanical check was moved to; the workbench reads its current state through `catalog`. */
export interface AutomationRef {
  id: string
  sessionId: string
  title: string
  scheduledAt: string
}
/** A retained request receipt makes retries after firing, cancellation, replacement or migration idempotent. */
export interface FollowupReceipt {
  wakeRequested?: true
  requestId: string
  ticketId: string
  at: string
  reason: string
  createdAt: string
  status: 'scheduled' | 'fired' | 'cancelled' | 'superseded' | 'migrated'
  finishedAt?: string
  automation?: AutomationRef
}
export const followupReceipts = family<FollowupReceipt, [ticketId: string, requestId: string]>(
  'followup-request:', (ticketId, requestId) => key(ticketId, requestId))

/** Written before the Host Schedule task so a crash between its write and the local commit can be reconciled. */
export interface MigrationIntent {
  ticketId: string
  requestId: string
  sessionId: string
  title: string
  prompt: string
  at: string
  marker: string
  createdAt: string
}
export const migrationIntents = family<MigrationIntent, [ticketId: string, requestId: string]>(
  'migration-intent:', (ticketId, requestId) => key(ticketId, requestId))
/** A Host Schedule deletion that failed, retried by `maintain` instead of being lost after the Ticket ended. */
export interface AutomationCleanup {
  ticketId: string
  requestId: string
  sessionId: string
  automationId: string
  /** True when this deletion belongs to a cancelled check, so the receipt becomes cancelled after the delete. */
  cancelReceipt?: boolean
}
export const automationCleanups = family<AutomationCleanup, [automationId: string]>(
  'automation-cleanup:', automationId => automationId)

/** What one migrated check shows in the workbench: its schedule plus the Ticket it came from. */
export interface AutomationView extends AutomationRef {
  ticketId: string
  ticketTitle: string
  requestId: string
  status: 'scheduled' | 'paused' | 'ended' | 'unknown'
}
export interface AutomationsView {
  /** Whether this profile can create DSH Schedule tasks; false leaves every pending check on its Ticket. */
  available: boolean
  items: AutomationView[]
}

/** The DSH Host Schedule operations this plugin uses; the service is optional because a profile may not load it. */
export interface CatalogTask extends AutomationRef {
  status: 'active' | 'paused' | 'inactive'
  /** The stored instruction, which carries the migration marker used to adopt a task after a crash. */
  prompt?: string
}
export interface SchedulePort {
  create(sessionId: string, request: { title: string; prompt: string; at: string }): Promise<AutomationRef>
  delete(request: { sessionId: string; id: string }): Promise<{ deleted: boolean; code?: string }>
  catalog?(): Promise<CatalogTask[]>
}

export interface FollowupsHost {
  readonly effects?: Pick<Effects, 'enqueue' | 'handle'>
  readonly store: Pick<Store, 'atomic' | 'get' | 'set' | 'delete' | 'keys'> & { tickets: Pick<Store['tickets'], 'get' | 'open'> }
  readonly engine: Pick<Engine, 'note' | 'scheduleFollowup' | 'finishFollowup'>
  /** The main Session a migrated mechanical check reports to. */
  readonly masterId?: string
  /** Resolved at call time so a Host Schedule loaded after this plugin is still usable. */
  readonly schedule?: () => SchedulePort | undefined
  paused(): boolean
  authorized(ticket: Ticket): boolean
}

/** Keeps business waits on Tickets while native Schedule and durable Effects own delivery and recovery. */
export class Followups {
  /** The reconciliation `maintain` started, kept so concurrent callers join it and a stopping Runtime can wait for it. */
  private maintaining?: Promise<void>
  private readonly reconciling = new Set<string>()
  /** In-flight migrations by marker: concurrent callers join the same Host Schedule write instead of creating a second task. */
  private readonly migrations = new Map<string, Promise<FollowupReceipt>>()
  constructor(private readonly host: FollowupsHost, private readonly now = () => Date.now()) {
    const effects = host.effects
    if (!effects) return
    effects.handle('followupSchedule', async ({ ticketId, requestId }) => {
      const receipt = host.store.get(followupReceipts(ticketId, requestId))
      if (receipt?.status !== 'scheduled') return
      const ticket = this.require(ticketId)
      if (!liveTicket(ticket)) return
      if (host.store.get(migrationIntents(ticketId, requestId))) {
        await this.reconcileMigrations()
        if (host.store.get(migrationIntents(ticketId, requestId))) throw new Later('Native reminder outcome is being reconciled')
      }
      if (Date.parse(receipt.at) <= this.now()) {
        if (!this.fireDue(ticketId, requestId)) throw new Later('Original follow-up is waiting for its condition')
        return
      }
      if (!host.schedule?.()) throw new Later('Native Schedule is unavailable')
      await this.migrate(ticketId, requestId)
    }, { limit: () => host.paused() ? 0 : 1 })
    effects.handle('followupFire', async ({ ticketId, requestId }) => { this.fireNative(ticketId, requestId) },
      { limit: () => host.paused() ? 0 : 1 })
    effects.handle('followupCleanup', async ({ automationId }) => {
      const cleanup = host.store.get(automationCleanups(automationId))
      if (!cleanup) return
      const schedule = host.schedule?.()
      if (!schedule) throw new Later('Native Schedule is unavailable')
      await this.deleteTask(schedule, cleanup.sessionId, automationId)
      if (cleanup.cancelReceipt) host.store.atomic(() => {
        const receipt = host.store.get(followupReceipts(cleanup.ticketId, cleanup.requestId))
        if (receipt?.status === 'migrated') {
          host.engine.finishFollowup(cleanup.ticketId, cleanup.requestId, new Date(this.now()).toISOString())
          host.store.set(followupReceipts(cleanup.ticketId, cleanup.requestId), { ...receipt, status: 'cancelled', finishedAt: new Date(this.now()).toISOString() })
        }
      })
      host.store.delete(automationCleanups(automationId))
    })
    effects.handle('followupRestore', async () => {
      await this.maintain()
      if (host.store.keys(migrationIntents.prefix).length || host.store.keys(automationCleanups.prefix).length) throw new Later('Native reminder recovery is pending')
    })
  }

  /** Startup restores only pending work; Ticket lifecycle events reactivate held native deliveries. */
  resume(): void {
    if (!this.host.effects) return
    this.host.effects.enqueue('followupRestore', 'native-reminders', {})
    for (const ticket of this.host.store.tickets.open()) {
      for (const item of ticketFollowups(ticket)) {
        const receipt = this.host.store.get(followupReceipts(ticket.id, item.id))
        if (!receipt) this.host.store.set(followupReceipts(ticket.id, item.id), { ticketId: ticket.id, requestId: item.id, at: item.at,
          reason: item.reason, createdAt: item.createdAt, status: 'scheduled' })
        if (!receipt || receipt.status === 'scheduled') this.host.effects.enqueue('followupSchedule', key(ticket.id, item.id), { ticketId: ticket.id, requestId: item.id })
      }
      this.changed(ticket.id)
    }
    for (const name of this.host.store.keys(automationCleanups.prefix)) {
      const cleanup = this.host.store.get(name as Key<AutomationCleanup>)
      if (cleanup) this.host.effects.enqueue('followupCleanup', cleanup.automationId, { automationId: cleanup.automationId })
    }
  }
  changed(ticketId: string): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || this.blocker(ticket)) return
    for (const item of ticketFollowups(ticket)) {
      const receipt = this.host.store.get(followupReceipts(ticketId, item.id))
      if (receipt?.wakeRequested && receipt.status === 'migrated') this.host.effects?.enqueue('followupFire', key(ticketId, item.id), { ticketId, requestId: item.id })
    }
  }
  private persistCleanup(cleanup: AutomationCleanup): void {
    this.host.store.set(automationCleanups(cleanup.automationId), cleanup)
    this.host.effects?.enqueue('followupCleanup', cleanup.automationId, { automationId: cleanup.automationId })
  }

  list(ticketId: string): TicketFollowup[] { return ticketFollowups(this.require(ticketId)) }

  /** A native reminder resumes its exact retained check after current state and mandate validation. */
  fireNative(ticketId: string, requestId: string): { accepted: boolean; reused?: true; reason?: string } {
    return this.host.store.atomic(() => {
      const receipt = this.host.store.get(followupReceipts(ticketId, requestId))
      if (receipt?.status === 'fired') return { accepted: true, reused: true }
      if (receipt?.status !== 'migrated' || !receipt.automation) return { accepted: false, reason: 'inactive' }
      if (Date.parse(receipt.at) > this.now()) return { accepted: false, reason: 'not_due' }
      const ticket = this.require(ticketId)
      if (!liveTicket(ticket)) return { accepted: false, reason: 'ended' }
      const blocked = this.blocker(ticket)
      if (blocked) {
        this.host.store.set(followupReceipts(ticketId, requestId), { ...receipt, wakeRequested: true })
        return { accepted: false, reason: blocked }
      }
      this.host.engine.finishFollowup(ticketId, requestId, new Date(this.now()).toISOString())
      this.host.engine.note(ticketId, `Scheduled follow-up ${requestId} is due (${receipt.at}). ${receipt.reason}\n`
        + 'Continue this ticket within its existing mandate. Check current evidence and prior outcomes before taking the next action.')
      this.host.store.set(followupReceipts(ticketId, requestId), { ...receipt, status: 'fired', finishedAt: new Date(this.now()).toISOString() })
      return { accepted: true }
    })
  }

  /** All pending checks are a projection of open Tickets, including those held by the same rules as runDue. */
  pending() {
    const now = this.now()
    return this.host.store.tickets.open().flatMap(ticket => {
      const last = latestReport(ticket)
      return ticketFollowups(ticket).map(item => ({ ...item,
        ticketId: ticket.id, title: ticket.title, due: Date.parse(item.at) <= now,
        blocked: this.blocker(ticket) ?? (this.migrationPending(ticket.id, item.id) ? 'migration' as const : undefined),
        ...last ? { last: { state: last.state, summary: last.summary, at: last.at } } : {} }))
    }).sort((a, b) => a.at.localeCompare(b.at) || a.ticketId.localeCompare(b.ticketId) || a.id.localeCompare(b.id))
  }

  schedule(ticketId: string, request: FollowupRequest): FollowupReceipt {
    const at = new Date(request.at).toISOString()
    return this.host.store.atomic(() => {
      const ticket = this.require(ticketId)
      const existing = this.host.store.get(followupReceipts(ticketId, request.request_id))
      if (existing) {
        if (existing.at !== at || existing.reason !== request.reason) throw new Error('Follow-up request id was already used with different content')
        return existing
      }
      if (!liveTicket(ticket)) throw new Error('Ticket ended; a follow-up cannot restart it')
      if (!this.host.authorized(ticket)) throw new Error('The ticket mandate no longer authorizes a follow-up')
      if (Date.parse(at) <= this.now()) throw new Error('Follow-up time must be in the future')
      const createdAt = new Date(this.now()).toISOString()
      this.host.engine.scheduleFollowup(ticketId, { id: request.request_id, at, reason: request.reason, createdAt })
      const receipt: FollowupReceipt = { requestId: request.request_id, ticketId, at, reason: request.reason, createdAt, status: 'scheduled' }
      this.host.store.set(followupReceipts(ticketId, request.request_id), receipt)
      this.host.effects?.enqueue('followupSchedule', key(ticketId, request.request_id), { ticketId, requestId: request.request_id })
      return receipt
    })
  }

  /** Also used by the ticket-ended event so a manual stop leaves no pending timer in the UI. */
  cancel(ticketId: string, requestId?: string): { cancelled: boolean; receipt?: FollowupReceipt; receipts?: FollowupReceipt[] } {
    return this.host.store.atomic(() => {
      const ticket = this.require(ticketId)
      const pending = ticketFollowups(ticket).filter(item => !requestId || item.id === requestId)
      if (!pending.length) return { cancelled: false }
      const receipts = pending.map(item => {
        const old = this.host.store.get(followupReceipts(ticketId, item.id))
        const receipt = this.finish(ticket, item, 'cancelled', new Date(this.now()).toISOString())
        if (old?.automation) {
          this.persistCleanup({ ticketId, requestId: item.id,
            sessionId: old.automation.sessionId, automationId: old.automation.id, cancelReceipt: true })
        }
        return receipt
      })
      return { cancelled: true, receipt: receipts[0], ...(receipts.length > 1 ? { receipts } : {}) }
    })
  }

  /**
   * Move one mechanical check to a DSH Host Schedule task bound to the main Session.
   * The Ticket follow-up is removed only after the automation exists; a retry returns the retained receipt.
   * Concurrent calls for one check share this process's in-flight promise; across a restart the retained intent and the
   * Host Schedule catalog decide whether the task exists, so a retry adopts it rather than creating another.
   */
  async migrate(ticketId: string, requestId: string): Promise<FollowupReceipt> {
    const marker = key(ticketId, requestId)
    const running = this.migrations.get(marker)
    if (running) return running
    if (this.reconciling.has(marker)) throw new UserError('automationPending')
    const migration = this.migrateOnce(ticketId, requestId, marker).finally(() => { this.migrations.delete(marker) })
    this.migrations.set(marker, migration)
    return migration
  }

  private async migrateOnce(ticketId: string, requestId: string, marker: string): Promise<FollowupReceipt> {
    const existing = this.host.store.get(followupReceipts(ticketId, requestId))
    if (existing?.status === 'migrated' && existing.automation) return existing
    if (existing && existing.status !== 'scheduled') throw new UserError('followupFinished')
    if (this.cleanupPending(ticketId, requestId)) throw new UserError('automationPending')
    const ticket = this.require(ticketId)
    const followup = ticketFollowups(ticket).find(item => item.id === requestId)
    if (!followup) throw new UserError('unknownFollowup')
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (!this.host.authorized(ticket)) throw new UserError('mandateRevoked')
    if (Date.parse(followup.at) <= this.now()) throw new UserError('followupDue')
    const schedule = this.host.schedule?.()
    const masterId = this.host.masterId
    if (!schedule || !masterId) throw new UserError('automationUnavailable')
    const title = `自动化检查：${ticket.title}`.slice(0, 120)
    // A retained intent means an earlier Host Schedule write had an unknown result. Read the catalog before writing again:
    // a matching task is adopted; without a catalog the result stays unverified rather than creating a possible duplicate.
    const pending = this.host.store.get(migrationIntents(ticketId, requestId))
    if (pending) {
      const catalog = await schedule.catalog?.().catch(() => undefined)
      if (!catalog) throw new UserError('automationPending')
      const [keep, ...extra] = this.matching(catalog, pending)
      if (keep) {
        for (const item of extra) await this.retainCleanup(schedule, pending, item)
        try { return this.commitMigration(pending, keep.id, keep.scheduledAt || followup.at) }
        catch (error) { await this.compensate(schedule, pending, keep.id); throw error }
      }
      // The catalog carries no task with this marker, so the earlier write did not land; this retry may create it.
      this.host.store.delete(migrationIntents(ticketId, requestId))
    }
    if (this.migrationPending(ticketId, requestId)) throw new UserError('automationPending')
    const currentMain = this.host.masterId!
    if (this.host.store.get(KV.runtime.mainTransition(currentMain))?.phase === 'quiescing') throw new UserError('automationPending')
    const intent: MigrationIntent = { ticketId, requestId, sessionId: currentMain, title,
      prompt: automationPrompt(ticket, followup, marker), at: followup.at, marker, createdAt: new Date(this.now()).toISOString() }
    this.host.store.set(migrationIntents(ticketId, requestId), intent)
    let created: AutomationRef
    try {
      created = await schedule.create(currentMain, { title, prompt: intent.prompt, at: followup.at })
    } catch (error) {
      // The Host Schedule may have written the task before its response was lost. Keep the intent so a retry or `maintain`
      // adopts it by marker; deleting it here would leave an orphan that no normal cancellation covers.
      throw error
    }
    try {
      return this.commitMigration(intent, created.id, created.scheduledAt || followup.at)
    } catch (error) {
      // The check fired, was cancelled or lost its mandate while the Host Schedule write was in flight.
      await this.compensate(schedule, intent, created.id)
      throw error
    }
  }

  /**
   * Retry what a crash or an unavailable Schedule left behind: an uncommitted migration intent, and a task deletion that
   * failed when its Ticket ended. The recovery effect calls this and reuses the original intent identity.
   */
  maintain(): Promise<void> {
    return this.maintaining ??= this.reconcile().finally(() => { this.maintaining = undefined })
  }

  /**
   * Resolves once the reconciliation `maintain` started has finished. A stopping Runtime awaits it so a Host Schedule
   * read already under way cannot write the Store after the database closes.
   */
  drain(): Promise<void> { return this.maintaining ?? Promise.resolve() }

  private async reconcile(): Promise<void> {
    await this.reconcileMigrations()
    await this.reconcileCleanups()
  }

  private commitMigration(intent: MigrationIntent, automationId: string, scheduledAt: string): FollowupReceipt {
    return this.host.store.atomic(() => {
      const ticket = this.require(intent.ticketId)
      if (!liveTicket(ticket)) throw new UserError('ticketEnded')
      if (!this.host.authorized(ticket)) throw new UserError('mandateRevoked')
      const followup = ticketFollowups(ticket).find(item => item.id === intent.requestId)
      if (!followup) throw new UserError('followupFinished')
      if (Date.parse(followup.at) <= this.now()) throw new UserError('followupDue')
      const finishedAt = new Date(this.now()).toISOString()
      const receipt: FollowupReceipt = { requestId: followup.id, ticketId: ticket.id, at: followup.at, reason: followup.reason,
        createdAt: followup.createdAt, status: 'migrated', finishedAt,
        automation: { id: automationId, sessionId: intent.sessionId, title: intent.title, scheduledAt } }
      if (!this.host.effects) this.host.engine.finishFollowup(ticket.id, intent.requestId, finishedAt)
      this.host.store.set(followupReceipts(ticket.id, intent.requestId), receipt)
      this.host.store.delete(migrationIntents(intent.ticketId, intent.requestId))
      return receipt
    })
  }

  /** Adopt a task a crash left after `create`, or delete it when the check can no longer move. */
  private async reconcileMigrations(): Promise<void> {
    const keys = this.host.store.keys(migrationIntents.prefix)
    if (!keys.length) return
    const schedule = this.host.schedule?.()
    if (!schedule?.catalog) return
    const catalog = await schedule.catalog().catch(() => undefined)
    if (!catalog) return
    for (const name of keys) {
      const intent = this.host.store.get(name as Key<MigrationIntent>)
      if (!intent) continue
      // An explicit in-flight migration owns its intent, however long its Host Schedule write takes.
      if (this.migrations.has(intent.marker) || this.cleanupPending(intent.ticketId, intent.requestId)) continue
      // Give an in-flight migrate time to create and commit its task before treating the intent as a crash remnant.
      if (this.now() - Date.parse(intent.createdAt) < 60_000) continue
      const [keep, ...extra] = this.matching(catalog, intent)
      if (!keep) {
        // No task reached the Host Schedule; the follow-up is still the only timer.
        this.host.store.delete(name)
        continue
      }
      this.reconciling.add(intent.marker)
      try {
        for (const item of extra) await this.retainCleanup(schedule, intent, item)
        try {
          this.commitMigration(intent, keep.id, keep.scheduledAt)
        } catch {
          // The check fired, was cancelled, ended or lost its mandate; remove the automation instead.
          await this.compensate(schedule, intent, keep.id)
        }
      } finally { this.reconciling.delete(intent.marker) }
    }
  }
  /** Host Schedule tasks carrying this intent's marker, oldest first, so one is kept and the rest are duplicates. */
  private matching(catalog: CatalogTask[], intent: MigrationIntent): CatalogTask[] {
    return catalog.filter(item => item.sessionId === intent.sessionId && item.prompt?.includes(intent.marker))
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id))
  }
  /** Deletes an extra copy of one migration; a failed deletion stays retryable without touching the kept task's receipt. */
  private async retainCleanup(schedule: SchedulePort, intent: MigrationIntent, item: AutomationRef): Promise<void> {
    try { await this.deleteTask(schedule, item.sessionId, item.id) }
    catch (error) {
      void error
      this.persistCleanup({ ticketId: intent.ticketId, requestId: intent.requestId,
        sessionId: item.sessionId, automationId: item.id })
    }
  }
  /**
   * Removes a created task whose migration cannot commit. The task is known, so a failed deletion is retained by ID even
   * when another success already removed the shared intent; the intent then stops waiting for a task no longer adopted.
   */
  private async compensate(schedule: SchedulePort, intent: MigrationIntent, automationId: string): Promise<void> {
    try { await this.deleteTask(schedule, intent.sessionId, automationId) }
    catch (error) {
      void error
      this.persistCleanup({ ticketId: intent.ticketId, requestId: intent.requestId,
        sessionId: intent.sessionId, automationId })
    }
    const current = this.host.store.get(migrationIntents(intent.ticketId, intent.requestId))
    if (current?.marker === intent.marker) this.host.store.delete(migrationIntents(intent.ticketId, intent.requestId))
  }

  /** Finish deletions that failed when their Ticket ended, once the Host Schedule answers again. */
  private async reconcileCleanups(): Promise<void> {
    const keys = this.host.store.keys(automationCleanups.prefix)
    if (!keys.length) return
    const schedule = this.host.schedule?.()
    if (!schedule) return
    for (const name of keys) {
      const cleanup = this.host.store.get(name as Key<AutomationCleanup>)
      if (!cleanup) continue
      const marker = key(cleanup.ticketId, cleanup.requestId)
      if (this.migrations.has(marker) || this.reconciling.has(marker)) continue
      this.reconciling.add(marker)
      try {
        if (!await this.deleteTask(schedule, cleanup.sessionId, cleanup.automationId).catch(() => false)) continue
        this.host.store.atomic(() => {
          if (cleanup.cancelReceipt) {
            const receipt = this.host.store.get(followupReceipts(cleanup.ticketId, cleanup.requestId))
            if (receipt?.automation) this.host.store.set(followupReceipts(cleanup.ticketId, cleanup.requestId),
              { ...receipt, status: 'cancelled', finishedAt: new Date(this.now()).toISOString() })
          }
          this.host.store.delete(name)
        })
      } finally { this.reconciling.delete(marker) }
    }
  }

  /** Migrated checks with their current Host Schedule target; a missing catalog entry means the task ended or was deleted. */
  async automations(): Promise<AutomationsView> {
    const schedule = this.host.schedule?.()
    const receipts = this.migrated()
    if (!schedule) return { available: false, items: receipts.map(receipt => this.automationView(receipt, undefined)) }
    const catalog = schedule.catalog ? await schedule.catalog().catch(() => undefined) : undefined
    const byId = catalog ? new Map(catalog.map(item => [item.id, item])) : undefined
    return { available: true, items: receipts.map(receipt => this.automationView(receipt, byId)) }
  }

  /** Delete one migrated automation from the Host Schedule and retain the cancelled receipt. */
  async cancelAutomation(ticketId: string, requestId: string): Promise<{ cancelled: boolean; receipt?: FollowupReceipt }> {
    const receipt = this.host.store.get(followupReceipts(ticketId, requestId))
    if (!receipt?.automation) throw new UserError('unknownFollowup')
    const automation = receipt.automation
    if (receipt.status === 'cancelled') return { cancelled: true, receipt }
    if (receipt.status !== 'migrated') throw new UserError('followupFinished')
    const schedule = this.host.schedule?.()
    if (!schedule) throw new UserError('automationUnavailable')
    // Invalidate the business wait before a remote delete can race a late reminder.
    this.host.store.atomic(() => {
      this.host.engine.finishFollowup(ticketId, requestId, new Date(this.now()).toISOString())
      this.host.store.set(followupReceipts(ticketId, requestId), { ...receipt, status: 'cancelled', finishedAt: new Date(this.now()).toISOString() })
      this.persistCleanup({ ticketId, requestId, sessionId: automation.sessionId, automationId: automation.id, cancelReceipt: true })
    })
    try {
      await this.deleteTask(schedule, receipt.automation.sessionId, receipt.automation.id)
    } catch (error) {
      this.persistCleanup({ ticketId, requestId,
        sessionId: receipt.automation.sessionId, automationId: receipt.automation.id, cancelReceipt: true })
      throw error
    }
    this.host.store.delete(automationCleanups(receipt.automation.id))
    return this.host.store.atomic(() => {
      const cancelled: FollowupReceipt = { ...receipt, status: 'cancelled', finishedAt: new Date(this.now()).toISOString() }
      this.host.store.set(followupReceipts(ticketId, requestId), cancelled)
      this.host.engine.finishFollowup(ticketId, requestId, new Date(this.now()).toISOString())
      return { cancelled: true, receipt: cancelled }
    })
  }

  /** Remove a Ticket's migrated automations when it ends, retaining a retry for each deletion that fails. */
  async cancelAutomations(ticketId: string): Promise<number> {
    const receipts = this.migrated().filter(receipt => receipt.ticketId === ticketId)
    let failed = 0
    for (const receipt of receipts) {
      try { await this.cancelAutomation(ticketId, receipt.requestId) }
      catch {
        failed++
        const automation = receipt.automation!
        this.persistCleanup({ ticketId, requestId: receipt.requestId,
          sessionId: automation.sessionId, automationId: automation.id, cancelReceipt: true })
      }
    }
    if (failed) throw new Error(`Could not delete ${failed} automation task(s); cleanup is retained for retry`)
    return receipts.length
  }

  /** An overdue human wait remains due until its existing attention or blocked state is resolved. */
  private fireDue(ticketId: string, requestId: string): boolean {
    return this.host.store.atomic(() => {
      const ticket = this.require(ticketId), item = ticketFollowups(ticket).find(item => item.id === requestId)
      if (!item || !liveTicket(ticket)) return true
      if (Date.parse(item.at) > this.now() || this.blocker(ticket) || this.migrationPending(ticketId, requestId)) return false
      this.finish(ticket, item, 'fired', new Date(this.now()).toISOString())
      this.host.engine.note(ticketId, `Scheduled follow-up ${item.id} is due (${item.at}). ${item.reason}\n`
        + 'Continue this ticket within its existing mandate. Check current evidence and prior outcomes before taking the next action.')
      return true
    })
  }
  runDue(): number {
    if (this.host.paused()) return 0
    const now = this.now()
    const due = this.host.store.tickets.open().filter(ticket => !this.blocker(ticket))
      .flatMap(ticket => ticketFollowups(ticket)
        .filter(item => Date.parse(item.at) <= now && !this.migrationPending(ticket.id, item.id))
        .map(item => ({ ticketId: ticket.id, item })))
      .sort((a, b) => a.item.at.localeCompare(b.item.at) || a.ticketId.localeCompare(b.ticketId) || a.item.id.localeCompare(b.item.id)).slice(0, 32)
    let fired = 0
    for (const candidate of due) {
      this.host.store.atomic(() => {
        const ticket = this.require(candidate.ticketId)
        const followup = ticketFollowups(ticket).find(item => item.id === candidate.item.id)
        if (!followup || !liveTicket(ticket) || this.blocker(ticket) || this.migrationPending(ticket.id, followup.id)) return
        // Clear the timer before note() reads and saves the ticket, in the same transaction as the wake-up input.
        this.finish(ticket, followup, 'fired', new Date(now).toISOString())
        this.host.engine.note(ticket.id, `Scheduled follow-up ${followup.id} is due (${followup.at}). ${followup.reason}\n`
          + 'Continue this ticket within its existing mandate. Check current evidence and prior outcomes before taking the next action.')
        fired++
      })
    }
    return fired
  }

  /** Hold the original check until its uncertain creation and every known remote cleanup are settled. */
  private migrationPending(ticketId: string, requestId: string): boolean {
    return !!this.host.store.get(migrationIntents(ticketId, requestId)) || this.cleanupPending(ticketId, requestId)
  }

  /** A known remote deletion must finish before its request can adopt or create another task. */
  private cleanupPending(ticketId: string, requestId: string): boolean {
    return this.host.store.keys(automationCleanups.prefix).some(name => {
      const cleanup = this.host.store.get(name as Key<AutomationCleanup>)
      return cleanup?.ticketId === ticketId && cleanup.requestId === requestId
    })
  }

  private migrated(): FollowupReceipt[] {
    const receipts: FollowupReceipt[] = []
    for (const name of this.host.store.keys(followupReceipts.prefix)) {
      const receipt = this.host.store.get(name as Key<FollowupReceipt>)
      if (receipt?.status === 'migrated' && receipt.automation) receipts.push(receipt)
    }
    return receipts.sort((a, b) => a.automation!.scheduledAt.localeCompare(b.automation!.scheduledAt)
      || a.ticketId.localeCompare(b.ticketId) || a.requestId.localeCompare(b.requestId))
  }

  private automationView(receipt: FollowupReceipt, catalog: Map<string, CatalogTask> | undefined): AutomationView {
    const automation = receipt.automation!
    const current = catalog?.get(automation.id)
    const status = current ? current.status === 'active' ? 'scheduled' as const : current.status === 'paused' ? 'paused' as const : 'ended' as const
      : catalog ? 'ended' as const : 'unknown' as const
    return { ...automation, ...current ? { sessionId: current.sessionId } : {}, ticketId: receipt.ticketId, ticketTitle: this.host.store.tickets.get(receipt.ticketId)?.title ?? receipt.ticketId,
      requestId: receipt.requestId, status, scheduledAt: current?.scheduledAt ?? automation.scheduledAt }
  }

  private async deleteTask(schedule: SchedulePort, sessionId: string, id: string): Promise<boolean> {
    const result = await schedule.delete({ sessionId, id })
    if (!result.deleted && result.code !== 'schedule_not_found') throw new Error(`Could not delete automation task ${id}`)
    return true
  }

  private require(ticketId: string): Ticket {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket) throw new Error('Unknown ticket')
    return ticket
  }

  private blocker(ticket: Ticket): 'paused' | 'ticketPaused' | 'attention' | 'person' | 'assignment' | 'authority' | undefined {
    if (this.host.paused()) return 'paused'
    if (ticket.paused) return 'ticketPaused'
    if (ticket.attention) return 'attention'
    if (waitsForPerson(ticket)) return 'person'
    if (!runningAssignment(ticket)) return 'assignment'
    if (!this.host.authorized(ticket)) return 'authority'
    return undefined
  }

  private finish(ticket: Ticket, followup: TicketFollowup, status: Exclude<FollowupReceipt['status'], 'scheduled' | 'migrated'>, finishedAt: string): FollowupReceipt {
    const receipt: FollowupReceipt = { requestId: followup.id, ticketId: ticket.id, at: followup.at,
      reason: followup.reason, createdAt: followup.createdAt, status, finishedAt }
    this.host.engine.finishFollowup(ticket.id, followup.id, finishedAt)
    this.host.store.set(followupReceipts(ticket.id, followup.id), receipt)
    return receipt
  }
}

/** The stock instruction a migrated check receives; the marker lets a restart find a task whose local commit was lost. */
function automationPrompt(ticket: Ticket, followup: TicketFollowup, marker: string): string {
  return `自动化检查（从工单 ${ticket.id} 迁移）\n事项：${ticket.title}\n原定时间：${followup.at}\n检查口径：${followup.reason}\n\n`
    + `到点后调用 orchestrator_followup_fire，ticket_id=${ticket.id}，request_id=${followup.id}。程序会核对当前事项、约定时间和授权，并把检查交回原 worker。`
    + `若返回 accepted=false，按 reason 保留等待或结束本次提醒。沿原事项处理后续进展。\n\nInternal migration id: ${marker}`
}
