/** Main-only, explicitly enabled controls. These never judge message content or start Tickets. */
import { z } from 'zod'
import type { TriageHandoffs } from '../triage-handoffs.ts'
import { tool, type Tool } from './tool.ts'

export function triageHandoffTools(service: TriageHandoffs): Tool[] {
  return [
    tool({ name: 'orchestrator_triage_handoff_preview', description: 'Only after an explicit operator request to hold selected passive pending IM evidence. Check all IDs and return a fingerprint. No text, judgment, ownership change or backlog completion. Explicit requests and previously owned evidence are refused.',
      schema: z.object({ trigger_ids: z.array(z.string().min(1)).min(1).max(200) }).strict(), execute: async ({ trigger_ids }) => service.preview(trigger_ids) }),
    tool({ name: 'orchestrator_triage_handoff_adopt', description: 'Explicitly hold the exact previewed selection away from Eval with an exclusive durable owner. All-or-nothing. No timeout or automatic release. This suspends judgment, not completes it. Preserve owner and generation for rollback. Never adopt merely because shadow results say none.',
      schema: z.object({ owner: z.string().min(1).max(100), trigger_ids: z.array(z.string().min(1)).min(1).max(200), fingerprint: z.string().length(64) }).strict(),
      execute: async ({ owner, trigger_ids, fingerprint }) => service.adopt(owner, trigger_ids, fingerprint) }),
    tool({ name: 'orchestrator_triage_handoff_release', description: 'Explicit rollback of one saved owner and generation. Restore held IDs and original queue age without removing newer arrivals. Works with source disabled; source is not enabled by release. Required before downgrading to a binary that does not understand held markers.',
      schema: z.object({ owner: z.string().min(1).max(100), generation: z.number().int().positive() }).strict(), execute: async ({ owner, generation }) => service.release(owner, generation) }),
    tool({ name: 'orchestrator_triage_handoff_read', description: 'Read one bounded handoff receipt and pending/released references without message text. Held means awaiting context and production judgment, never processed.',
      schema: z.object({ owner: z.string().min(1).max(100) }).strict(), execute: async ({ owner }) => service.read(owner) }),
  ]
}
