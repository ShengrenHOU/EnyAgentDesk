/** DSH 0.2.2 reminder contract and the existing follow-up projection. */
import type { SchedulePort } from './followups.ts'

export interface NativeReminder {
  id: string; title: string; prompt: string; scheduledAt: string
  target: { kind: string; sessionId?: string }; status: 'active' | 'paused' | 'ended'
  updatedAt?: string; executionActive?: true
}
type EditResult = NativeReminder | { id: string; code: string } | { id: string; deleted: true }
/** The native optional service provided by the DSH base bundle. */
export interface HostSchedule {
  catalog(): Promise<NativeReminder[]>
  create(request: { title: string; prompt: string; timing: { kind: 'at'; at: string }; target: { kind: 'session'; sessionId: string } }, actorSessionId?: string): Promise<NativeReminder>
  edit(request: { id: string; expectedUpdatedAt?: string | null } & ({ action: 'delete' } | { action: 'update'; patch: { target: { kind: 'session'; sessionId: string } } })): Promise<EditResult>
}
/** Keep the app's public follow-up receipts stable while calling native global reminder management. */
export function followupSchedule(native: HostSchedule | undefined): SchedulePort | undefined {
  if (!native) return undefined
  return {
    create: async (sessionId, request) => {
      const task = await native.create({ title: request.title, prompt: request.prompt, timing: { kind: 'at', at: request.at },
        target: { kind: 'session', sessionId } }, sessionId)
      return { id: task.id, sessionId, title: task.title, scheduledAt: task.scheduledAt }
    },
    delete: async ({ id }) => {
      const result = await native.edit({ id, action: 'delete' })
      if ('deleted' in result) return { deleted: true }
      if ('code' in result) return { deleted: false, code: result.code }
      throw new Error('Native reminder deletion returned a task instead of a deletion receipt')
    },
    catalog: async () => (await native.catalog()).flatMap(task => task.target.kind === 'session' && task.target.sessionId
      ? [{ id: task.id, sessionId: task.target.sessionId, title: task.title, scheduledAt: task.scheduledAt, prompt: task.prompt,
        status: task.status === 'ended' ? 'inactive' as const : task.status }] : []),
  }
}
