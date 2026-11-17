/** Reconcile native lifecycle summaries without owning another execution state. */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export function reconcileSessionStatus(sessions: Pick<ISessions, 'binding' | 'refresh'>, id: SessionId, running: boolean): Promise<void> {
  const session = sessions.binding(id)?.session
  // shortcut: DSH 0.2.2 does not relay availability summaries to retained Sessions; remove after upstream fixes that relay.
  return session && session.getSnapshot().running !== running ? sessions.refresh() : Promise.resolve()
}
