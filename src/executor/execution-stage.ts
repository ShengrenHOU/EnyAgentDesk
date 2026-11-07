/** Codex business execution stages, fixed model choices and durable handoffs. */
import { z } from 'zod'

export const ExecutionStage = z.enum(['research', 'implementation', 'documentation'])
export type ExecutionStage = z.infer<typeof ExecutionStage>
export const stageModels: Record<ExecutionStage, string> = {
  research: 'gpt-6-astra', implementation: 'gpt-6.1-sol', documentation: 'gpt-6.1-terra',
}
export const StageHandoff = z.object({
  purpose: z.string().trim().min(1), decisions: z.string().trim().min(1),
  results: z.string().trim().min(1), evidence: z.string().trim().min(1), remaining: z.string().trim().min(1),
}).strict()
export type StageHandoff = z.infer<typeof StageHandoff>
export interface ExecutionStages {
  current: ExecutionStage
  history: { stage: ExecutionStage; model: string; at: string; requestId?: string; handoff?: StageHandoff }[]
  pending?: { stage: ExecutionStage; handoff: StageHandoff; turnId: string; requestId: string }
  turns: { turnId: string; requestedModel: string; actualModel?: string; evidence?: string }[]
}
