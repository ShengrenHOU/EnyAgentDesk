/** Resource subscriptions use the owner's existing CLI identity; app transport credentials stay in its child. */
import { z } from 'zod'
import { setTimeout as delay } from 'node:timers/promises'
import { accountsOf, type MailConfig } from './mail.ts'
import type { CalendarConfig } from './calendar.ts'
import type { TaskConfig } from './task.ts'
import type { ActivityConfig } from './activity.ts'
import type { SourceContext } from './host.ts'
import { larkUserBinding, type LarkUserBinding } from './lark-user.ts'
import { larkErrorCode } from './lark-events.ts'
import { requestLarkReconcile } from './lark-event-inbox.ts'

export async function prepareLarkSubscriptions(ctx: SourceContext, binding: LarkUserBinding, signal: AbortSignal, kinds: readonly string[] = ['task', 'mail', 'calendar', 'activity']) {
  if (!kinds.some(kind => { const config = ctx.config<{ events?: boolean; documentEvents?: boolean }>(kind); return kind === 'activity' ? config?.documentEvents : config?.events })) return {}
  const user = await larkUserBinding(ctx.commands.withSignal(signal), binding, () => signal.throwIfAborted())
  const failures: Record<string, string> = {}
  const attempt = async (kind: string, work: () => Promise<void>) => {
    try { await work() }
    catch (error) {
      signal.throwIfAborted()
      failures[kind] = `Subscription unavailable (${larkErrorCode(error)}); verify resource access and published app events`
    }
  }
  const task = ctx.config<TaskConfig>('task')
  if (kinds.includes('task') && task?.events) await attempt('task', async () => { await user.read(z.unknown(), ['api', 'POST', '/open-apis/task/v2/task_v2/task_subscription', '--params', '{"user_id_type":"open_id"}']) })
  const mail = ctx.config<MailConfig>('mail')
  if (kinds.includes('mail') && mail?.events) for (const account of accountsOf(mail)) await attempt('mail', async () => {
    await user.read(z.unknown(), ['api', 'POST', `/open-apis/mail/v1/user_mailboxes/${encodeURIComponent(account.mailbox)}/event/subscribe`, '--data', '{"event_type":1}'])
  })
  const calendar = ctx.config<CalendarConfig>('calendar')
  if (kinds.includes('calendar') && calendar?.events) await attempt('calendar', async () => {
    const primary = await user.read(z.object({ calendars: z.array(z.object({ calendar: z.object({ calendar_id: z.string().min(1) }) })) }),
      ['api', 'POST', '/open-apis/calendar/v4/calendars/primary'])
    const id = primary.calendars[0]?.calendar.calendar_id
    if (!id) throw new Error('Personal calendar subscription could not resolve its calendar')
    await user.read(z.unknown(), ['api', 'POST', `/open-apis/calendar/v4/calendars/${encodeURIComponent(id)}/events/subscription`])
  })
  const activity = ctx.config<ActivityConfig>('activity')
  if (kinds.includes('activity') && activity?.documentEvents) for (const document of activity.watchedDocuments) await attempt('activity', async () => {
    await user.read(z.unknown(), ['api', 'POST', `/open-apis/drive/v1/files/${encodeURIComponent(document.token)}/subscribe`,
      '--params', JSON.stringify({ file_type: document.type })])
  })
  return failures
}

/** Subscription retries are independent of the application transport and never stop other Sources. */
export async function prepareSharedEventSetup(signal: AbortSignal, setup: () => Promise<Record<string, string>>,
  report: (state: 'error', detail: string) => void, retryMs = 30_000): Promise<Record<string, string>> {
  while (true) {
    try { return await setup() }
    catch (error) {
      if (signal.aborted) return {}
      report('error', `Personal event setup failed (${larkErrorCode(error)}); retrying`)
      await delay(retryMs, undefined, { signal }).catch(() => {})
      if (signal.aborted) return {}
    }
  }
}

/** Each Source owns its subscriptions; successful unchanged subscriptions cause no recurring API calls. */
export async function runLarkSubscriptions(ctx: SourceContext, binding: LarkUserBinding, kinds: readonly string[], signal: AbortSignal,
  report: (failures: Record<string, string>) => void, intervalMs = 30_000): Promise<void> {
  let signature = '', failures: Record<string, string> = {}
  const successful = new Map<string, string>()
  while (!signal.aborted) {
    const current = JSON.stringify(kinds.map(kind => ctx.config(kind)))
    if (current !== signature || Object.keys(failures).length) {
      failures = await prepareSharedEventSetup(signal, () => prepareLarkSubscriptions(ctx, binding, signal, kinds), (_state, detail) => {
        failures = Object.fromEntries(kinds.map(kind => [kind, detail])); report(failures)
      })
      if (signal.aborted) return
      if (current !== JSON.stringify(kinds.map(kind => ctx.config(kind)))) continue
      for (const kind of kinds) {
        const config = ctx.config<{ events?: boolean; documentEvents?: boolean }>(kind)
        if (failures[kind] || !(kind === 'activity' ? config?.documentEvents : config?.events)) { successful.delete(kind); continue }
        const configured = JSON.stringify(config)
        if (successful.get(kind) !== configured) {
          // The socket may become ready before subscriptions; cover the interval after the earlier connection catch-up.
          requestLarkReconcile(ctx, binding.expectedUserId, kind === 'activity' ? 'documents' : kind)
          successful.set(kind, configured)
        }
      }
      signature = current
      report(failures)
    }
    await delay(intervalMs, undefined, { signal }).catch(() => {})
  }
}
