/** The coordinator can explicitly hand idle work to another persistent executor. */
import { z } from 'zod'
import { ExecutorKind } from '../../executor/router.ts'
import { ExecutionStage, StageHandoff } from '../../executor/execution-stage.ts'
import { tool, type Tool } from './tool.ts'

export const ExecutorTransferSchema = z.object({ executor: ExecutorKind, handoff: StageHandoff, stage: ExecutionStage.optional() }).strict()
export type ExecutorTransfer = z.infer<typeof ExecutorTransferSchema>
export function routingTools(transfer: (id: string, request: ExecutorTransfer) => Promise<unknown>): Tool[] {
  return [tool({ name: 'orchestrator_ticket_executor',
    description: 'Explicitly transfer idle work with full context. For Codex, infer its initial stage from the task and explicit model requirements; omit stage for DSH. Preserve prior decisions, results and side-effect evidence.',
    schema: ExecutorTransferSchema.extend({ ticket_id: z.string().min(1) }),
    execute: async ({ ticket_id, ...request }) => transfer(ticket_id, request) })]
}
