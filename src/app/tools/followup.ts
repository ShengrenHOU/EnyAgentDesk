/** Schedule within an existing ticket's mandate and retain a durable request receipt. */
import { z } from 'zod'
import { FollowupRequestSchema, type Followups } from '../followups.ts'
import { tool, type Tool } from './tool.ts'

export function followupTools(followups: Followups, ticketId?: string): Tool[] {
  if (ticketId) return [
    tool({ name: 'orchestrator_followup', description: 'Schedule an independent next check of this delegated task. Read the ticket’s pending followups first; reuse request_id when retrying, or cancel the old ID before replacing that check. Do not duplicate a waiting condition.',
      schema: FollowupRequestSchema, execute: async args => followups.schedule(ticketId, args) }),
    tool({ name: 'orchestrator_followup_cancel', description: 'Cancel request_id or explicitly set all=true. When only one check exists, request_id may be omitted.',
      schema: z.object({ request_id: z.string().trim().min(1).max(200).optional(), all: z.boolean().optional() }).strict()
        .refine(args => !(args.request_id && args.all), 'Choose one request_id or all'), execute: async args => {
        if (!args.request_id && !args.all && followups.list(ticketId).length > 1) throw new Error('Multiple checks are pending; specify request_id')
        return followups.cancel(ticketId, args.request_id)
      } }),
  ]
  return [tool({ name: 'orchestrator_ticket_followup', description: 'Schedule an independent authorized check of an existing ticket. Read its pending followups first, avoid duplicates and preserve the original owner, scope and conversation.',
    schema: FollowupRequestSchema.extend({ ticket_id: z.string().min(1) }), execute: async ({ ticket_id, ...request }) => followups.schedule(ticket_id, request) })]
}
