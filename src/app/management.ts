/** Per-ticket priority and deadline edits, with the same ordering used by views and dispatch. */
import { z } from 'zod'
import type { Engine, Ticket, TicketManagement } from '../core/index.ts'

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export const ManagementPatchSchema = z.object({
  priority: z.enum(PRIORITIES).optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  paused: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Provide a priority or deadline')
export type ManagementPatch = z.infer<typeof ManagementPatchSchema>

/** Compare active work by priority, then deadline, then the oldest waiting task. */
export function compareTickets(left: Ticket, right: Ticket): number {
  const priority = PRIORITIES.indexOf(right.priority ?? 'normal') - PRIORITIES.indexOf(left.priority ?? 'normal')
  const deadline = (left.dueAt ?? '9999').localeCompare(right.dueAt ?? '9999')
  return priority || deadline || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
}

/** Apply a person's management change through the Engine, which owns every Ticket write and reports the change as an event. */
export function updateTicketManagement(engine: Pick<Engine, 'updateTicketManagement'>, ticketId: string, patch: ManagementPatch): TicketManagement {
  return engine.updateTicketManagement(ticketId, patch)
}
