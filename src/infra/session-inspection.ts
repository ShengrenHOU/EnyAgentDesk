/** One immutable live-preferred Session read without creating or resuming an Agent. */
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session'

export async function inspectSession(query: Pick<SessionQueryEngine, 'observeSession'>, sessionId: string,
  signal?: AbortSignal): Promise<SessionInspection> {
  using observation = await query.observeSession(sessionId as SessionId, { signal, projectionMode: 'none' })
  return { meta: observation.header, inheritedEventCount: observation.inheritedEventCount, events: observation.events }
}
