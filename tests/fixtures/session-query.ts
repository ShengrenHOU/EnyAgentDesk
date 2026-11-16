/** Native query observations over records supplied by an isolated host fixture. */
import type { SessionQueryEngine, SessionObservation } from '@deepseek-ai/dsh-session-query'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session'

export function sessionQueryFixture(read: (id: SessionId, signal?: AbortSignal) => Promise<SessionInspection>): Pick<SessionQueryEngine, 'observeSession'> {
  return { async observeSession(id, options) {
    const record = await read(id, options?.signal)
    const observation: SessionObservation = { source: 'live', header: record.meta, events: record.events,
      inheritedEventCount: record.inheritedEventCount, cursor: record.events.at(-1)?.seq ?? -1,
      retain: () => observation, [Symbol.dispose]() {} }
    return observation
  } }
}
