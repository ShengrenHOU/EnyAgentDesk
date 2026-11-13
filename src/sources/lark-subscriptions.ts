/** Resource subscriptions use the owner's existing CLI identity; app transport credentials stay in its child. */
import { z } from 'zod'
import { accountsOf, type MailConfig } from './mail.ts'
import type { CalendarConfig } from './calendar.ts'
import type { TaskConfig } from './task.ts'
import type { ActivityConfig } from './activity.ts'
import type { SourceContext } from './host.ts'
import { larkUserBinding, type LarkUserBinding } from './lark-user.ts'
import { CliError } from '../infra/commands.ts'

export async function prepareLarkSubscriptions(ctx: SourceContext, binding: LarkUserBinding, signal: AbortSignal) {
  const user = await larkUserBinding(ctx.commands.withSignal(signal), binding, () => signal.throwIfAborted())
  const failures: Record<string, string> = {}
  const attempt = async (kind: string, work: () => Promise<void>) => {
    try { await work() }
    catch (error) {
      signal.throwIfAborted()
      failures[kind] = `Subscription unavailable (${error instanceof CliError && error.code ? error.code : error instanceof Error ? error.name : 'unknown'}); verify resource access and published app events`
    }
  }
  const task = ctx.config<TaskConfig>('task')
  if (task?.events) await attempt('task', async () => { await user.read(z.unknown(), ['api', 'POST', '/open-apis/task/v2/task_v2/task_subscription', '--params', '{"user_id_type":"open_id"}']) })
  const mail = ctx.config<MailConfig>('mail')
  if (mail?.events) await attempt('mail', async () => { for (const account of accountsOf(mail)) {
    await user.read(z.unknown(), ['api', 'POST', `/open-apis/mail/v1/user_mailboxes/${encodeURIComponent(account.mailbox)}/event/subscribe`, '--data', '{"event_type":1}'])
  } })
  const calendar = ctx.config<CalendarConfig>('calendar')
  if (calendar?.events) await attempt('calendar', async () => {
    const primary = await user.read(z.object({ calendars: z.array(z.object({ calendar: z.object({ calendar_id: z.string().min(1) }) })) }),
      ['api', 'POST', '/open-apis/calendar/v4/calendars/primary'])
    const id = primary.calendars[0]?.calendar.calendar_id
    if (!id) throw new Error('Personal calendar subscription could not resolve its calendar')
    await user.read(z.unknown(), ['api', 'POST', `/open-apis/calendar/v4/calendars/${encodeURIComponent(id)}/events/subscription`])
  })
  const activity = ctx.config<ActivityConfig>('activity')
  if (activity?.documentEvents) await attempt('activity', async () => { for (const document of activity.watchedDocuments) {
    await user.read(z.unknown(), ['api', 'POST', `/open-apis/drive/v1/files/${encodeURIComponent(document.token)}/subscribe`,
      '--params', JSON.stringify({ file_type: document.type })])
  } })
  return failures
}
