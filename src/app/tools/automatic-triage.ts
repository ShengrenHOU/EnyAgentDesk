/** Main-only metadata coverage and recoverable owner discovery. Does not release or execute work. */
import { z } from 'zod'
import type { AutomaticTriage } from '../automatic-triage.ts'
import { tool, type Tool } from './tool.ts'
export function automaticTriageTools(service: AutomaticTriage): Tool[] {
  return [tool({ name: 'orchestrator_triage_automatic_status', description: 'Read automatic intake coverage and all waiting/blocked owner IDs. Follow next cursor until null. Owners can be explicitly released using triage handoff controls; release does not automatically recapture or imply business resolution. Metadata only.',
    schema: z.object({ after: z.number().int().min(0).default(0) }).strict(), execute: async ({ after }) => service.status(after) }),
    tool({ name: 'orchestrator_triage_automatic_recover', description: 'Only on explicit operator request, retry or release up to20 exact unfinished accumulation owners. Retry revalidates current source/ownership and uses current configuration. Release restores legacy pending with original age and prevents automatic recapture. Does not resolve business obligations or change source messages.',
      schema: z.object({ owners: z.array(z.object({ owner: z.string().min(1), generation: z.number().int().positive() }).strict()).min(1).max(20), action: z.enum(['retry','release']) }).strict(),
      execute: async ({ owners, action }) => service.recover(owners, action) })]
}
