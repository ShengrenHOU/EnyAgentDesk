/** Durable one-time follow-ups that return delegated work to its existing ticket and executor. */
import { z } from 'zod'
import { key, liveTicket, runningAssignment, ticketFollowups, waitsForPerson, type Engine, type Ticket, type TicketFollowup } from '../core/index.ts'
import { family } from '../kv.ts'
import type { Store } from './store.ts'

export const FollowupRequestSchema = z.object({
  request_id: z.string().trim().min(1).max(200),
  at: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(1).max(2000),
}).strict()
export type FollowupRequest = z.infer<typeof FollowupRequestSchema>

/** A retained request receipt makes retries after firing, cancellation or replacement idempotent. */
export interface FollowupReceipt {
  requestId: string
  ticketId: string
  at: string
  reason: string
  createdAt: string
  status: 'scheduled' | 'fired' | 'cancelled' | 'superseded'
  finishedAt?: string
}
export const followupReceipts = family<FollowupReceipt, [ticketId: string, requestId: string]>(
  'followup-request:', (ticketId, requestId) => key(ticketId, requestId))

export interface FollowupsHost {
  readonly store: Pick<Store, 'atomic' | 'get' | 'set'> & { tickets: Pick<Store['tickets'], 'get' | 'open'> }
  readonly engine: Pick<Engine, 'note' | 'scheduleFollowup' | 'finishFollowup'>
  paused(): boolean
  authorized(ticket: Ticket): boolean
}

/** Uses the existing orchestration pass and transactional input delivery, with no separate timer process. */
export class Followups {
  constructor(private readonly host: FollowupsHost, private readonly now = () => Date.now()) {}

  list(ticketId: string): TicketFollowup[] { return ticketFollowups(this.require(ticketId)) }

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
      return receipt
    })
  }

  /** Also used by the ticket-ended event so a manual stop leaves no pending timer in the UI. */
  cancel(ticketId: string, requestId?: string): { cancelled: boolean; receipt?: FollowupReceipt; receipts?: FollowupReceipt[] } {
    return this.host.store.atomic(() => {
      const ticket = this.require(ticketId)
      const pending = ticketFollowups(ticket).filter(item => !requestId || item.id === requestId)
      if (!pending.length) return { cancelled: false }
      const receipts = pending.map(item => this.finish(ticket, item, 'cancelled', new Date(this.now()).toISOString()))
      return { cancelled: true, receipt: receipts[0], ...(receipts.length > 1 ? { receipts } : {}) }
    })
  }

  /** An overdue human wait remains due until its existing attention or blocked state is resolved. */
  runDue(): number {
    if (this.host.paused()) return 0
    const now = this.now()
    const due = this.host.store.tickets.open().filter(ticket => !ticket.paused && !ticket.attention && !waitsForPerson(ticket)
      && runningAssignment(ticket) && this.host.authorized(ticket))
      .flatMap(ticket => ticketFollowups(ticket).filter(item => Date.parse(item.at) <= now).map(item => ({ ticketId: ticket.id, item })))
      .sort((a, b) => a.item.at.localeCompare(b.item.at) || a.ticketId.localeCompare(b.ticketId) || a.item.id.localeCompare(b.item.id)).slice(0, 32)
    let fired = 0
    for (const candidate of due) {
      this.host.store.atomic(() => {
        const ticket = this.require(candidate.ticketId)
        const followup = ticketFollowups(ticket).find(item => item.id === candidate.item.id)
        if (!followup || this.host.paused() || ticket.paused || !liveTicket(ticket)
          || ticket.attention || waitsForPerson(ticket) || !runningAssignment(ticket) || !this.host.authorized(ticket)) return
        // Clear the timer before note() reads and saves the ticket, in the same transaction as the wake-up input.
        this.finish(ticket, followup, 'fired', new Date(now).toISOString())
        this.host.engine.note(ticket.id, `Scheduled follow-up ${followup.id} is due (${followup.at}). ${followup.reason}\n`
          + 'Continue this ticket within its existing mandate. Check current evidence and prior outcomes before taking the next action.')
        fired++
      })
    }
    return fired
  }

  private require(ticketId: string): Ticket {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket) throw new Error('Unknown ticket')
    return ticket
  }

  private finish(ticket: Ticket, followup: TicketFollowup, status: Exclude<FollowupReceipt['status'], 'scheduled'>, finishedAt: string): FollowupReceipt {
    const receipt: FollowupReceipt = { requestId: followup.id, ticketId: ticket.id, at: followup.at,
      reason: followup.reason, createdAt: followup.createdAt, status, finishedAt }
    this.host.engine.finishFollowup(ticket.id, followup.id, finishedAt)
    this.host.store.set(followupReceipts(ticket.id, followup.id), receipt)
    return receipt
  }
}
