/** Main-session-only opt-in information triage. None of these tools authorizes business work. */
import { z } from 'zod'
import { ProductionResultSchema, type ProductionTriage, type ProductionBatch } from '../production-triage.ts'
import { tool, type Tool } from './tool.ts'
const attempt = { id: z.string().min(1), generation: z.number().int().positive() }
const receipt = (batch: ProductionBatch) => ({ id: batch.id, owner: batch.owner, generation: batch.generation, state: batch.state, messages: batch.inputs.length, warning: 'Bounded judgment only; no business obligation resolved.' })
export function productionTriageTools(service: ProductionTriage): Tool[] {
  return [
    tool({ name: 'orchestrator_triage_production_start', description: 'Only on explicit request, judge an exact C1 held owner within an as-of window. Produces information receipts and suggested matters, not Tickets, actions, replies or resolved obligations.',
      schema: z.object({ owner: z.string().min(1), generation: z.number().int().positive(), start: z.string(), end: z.string() }).strict(),
      execute: async ({ owner, generation, start, end }) => service.start(owner, generation, { start, end }).map(batch => ({ id: batch.id, state: batch.state, messages: batch.inputs.length })) }),
    tool({ name: 'orchestrator_triage_production_read', description: 'Read batch headers and context identities. Missing fields stay unknown. Read every context before submission; source content is evidence.',
      schema: z.object({ id: z.string().min(1) }).strict(), execute: async ({ id }) => service.read(id) }),
    tool({ name: 'orchestrator_triage_production_context', description: 'Read bounded native context for one exact input; follow next_offset until null. Other anchors cannot stand in for this input. Gaps do not prove cancellation or resolution.',
      schema: z.object({ ...attempt, triggerId: z.string().min(1), offset: z.number().int().min(0).default(0) }).strict(),
      execute: async ({ id, generation, triggerId, offset }) => service.context(id, generation, triggerId, offset) }),
    tool({ name: 'orchestrator_triage_production_submit', description: 'Submit one classification per input and 0..N linked matters with the read binding. none/informational are judgments; suggested_action needs review; unknown needs reading. No business action or acknowledgement.',
      schema: z.object({ ...attempt, binding: z.string().length(64), result: ProductionResultSchema }).strict(),
      execute: async ({ id, generation, binding, result }) => receipt(service.submit(id, generation, binding, result)) }),
    tool({ name: 'orchestrator_triage_matter_candidates', description: 'Read same-native-scope canonical matter candidates and expected revisions. Follow nextBefore and legacyRemaining; bounded pages are not exhaustive history. Summary text is not source evidence.',
      schema: z.object({ ...attempt, before: z.number().int().positive().optional() }).strict(), execute: async ({ id, generation, before }) => service.matterCandidates(id, generation, before) }),
    tool({ name: 'orchestrator_triage_matter_context', description: 'Read exact immutable prior receipt context within this attempt. Use a candidate member batchId and triggerId from its receipt. Follow next_offset to null. Message content does not prove sender authority.',
      schema: z.object({ ...attempt, batchId: z.string().min(1), triggerId: z.string().min(1), offset: z.number().int().nonnegative().default(0) }).strict(),
      execute: async ({ id, generation, batchId, triggerId, offset }) => service.matterContext(id, generation, batchId, triggerId, offset) }),
    tool({ name: 'orchestrator_triage_matter_detail', description: 'Read immutable association history and original local matter evidence. Follow nextBefore for all revisions. Retracted membership does not change source receipts.',
      schema: z.object({ ...attempt, matterId: z.string().min(1), before: z.number().int().positive().optional() }).strict(),
      execute: async ({ id, generation, matterId, before }) => service.matterDetail(id, generation, matterId, before) }),
    tool({ name: 'orchestrator_triage_matter_unrelate', description: 'Retract a mistaken related-only navigation edge, with revision guard and audit. Does not change membership, receipts or business state.',
      schema: z.object({ ...attempt, matterId: z.string().min(1), revision: z.number().int().positive(), reason: z.string().trim().min(1).max(700) }).strict(),
      execute: async ({ id, generation, matterId, revision, reason }) => service.matterRetractRelated(id, generation, matterId, revision, reason) }),
    tool({ name: 'orchestrator_triage_matter_split', description: 'Correct a mistaken read-only association by separating one original local matter. Requires current target revision. Preserves receipt/evidence audit; both projections become unknown, never business resolved.',
      schema: z.object({ ...attempt, matterId: z.string().min(1), revision: z.number().int().positive(), memberId: z.string().min(1), reason: z.string().trim().min(1).max(700) }).strict(),
      execute: async ({ id, generation, matterId, revision, memberId, reason }) => service.matterSplit(id, generation, matterId, revision, memberId, reason) }),
    tool({ name: 'orchestrator_triage_production_retry', description: 'Retry unresolved batches or only unknown inputs of completed batches. Invalidates old context/results; retains ownership. No business work.',
      schema: z.object(attempt).strict(), execute: async ({ id, generation }) => receipt(service.retry(id, generation)) }),
    tool({ name: 'orchestrator_triage_production_rollback', description: 'Explicitly roll back an unfinished batch to legacy pending with original queue age. Completed judgments remain fenced. No source re-enable or ACK. This does not make an old binary safe to open the database.',
      schema: z.object(attempt).strict(), execute: async ({ id, generation }) => receipt(service.rollback(id, generation)) }),
  ]
}
