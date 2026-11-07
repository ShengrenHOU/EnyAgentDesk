/** Agents and the Web share the same bounded ticket planning operation. */
import { z } from 'zod'
import type { TicketManagement } from '../../core/index.ts'
import { ManagementPatchSchema, type ManagementPatch } from '../management.ts'
import { tool, type Tool } from './tool.ts'

export function managementTools(manage: (ticketId: string, patch: ManagementPatch) => TicketManagement, requestPass: () => void,
  ticketId?: string): Tool[] {
  if (ticketId) return [tool({ name: 'orchestrator_plan', description: 'Update this task’s priority, known deadline or pause of future work from its goal and actual dependencies. Use existing commitments and avoid invented deadlines.',
    schema: ManagementPatchSchema, execute: async args => { const result = manage(ticketId, args); requestPass(); return result } })]
  return [tool({ name: 'orchestrator_ticket_manage', description: 'Arrange an existing delegated ticket: set priority, known deadline, or pause/resume its future work. Reuse accepted goals and dependencies.',
    schema: z.object({ ticket_id: z.string().min(1), change: ManagementPatchSchema }).strict(),
    execute: async ({ ticket_id, change }) => { const result = manage(ticket_id, change); requestPass(); return result } })]
}
