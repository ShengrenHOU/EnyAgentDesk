/** Native user calendar synchronization. Event notifications wake the existing durable cursor. */
import { z } from 'zod'
import { KV } from '../kv.ts'
import { calendarCancellation, CalendarEventSchema, calendarTrigger, eventStart, eventVersion, type CalendarConfig } from './calendar.ts'
import { finishLarkEvent, pendingLarkEvents, larkReconcileToken, finishLarkReconcile } from './lark-event-inbox.ts'
import { larkUserBinding, nextPage, type LarkUserBinding } from './lark-user.ts'
import type { SourceContext } from './host.ts'
import { CliError } from '../infra/commands.ts'

const NativeTime = z.object({ timestamp: z.string().optional(), date: z.string().optional(), timezone: z.string().optional() })
const NativeEvent = z.object({ event_id: z.string().min(1), status: z.string().optional(), summary: z.string().optional(),
  start_time: NativeTime.optional(), end_time: NativeTime.optional(), app_link: z.string().optional(),
  event_organizer: z.object({ user_id: z.string().optional(), display_name: z.string().optional() }).optional(),
  self_rsvp_status: z.string().optional(), is_exception: z.boolean().optional(),
  vchat: z.object({ meeting_url: z.string().nullish() }).nullish() })
const Page = z.object({ items: z.array(NativeEvent), has_more: z.boolean(), page_token: z.string().optional(), sync_token: z.string().optional() })
const Primary = z.object({ calendars: z.array(z.object({ calendar: z.object({ calendar_id: z.string().min(1) }) })) })
const time = (value: z.infer<typeof NativeTime>) => ({
  ...value.timestamp ? { datetime: new Date(Number(value.timestamp) * 1000).toISOString() } : {},
  ...value.date ? { date: value.date } : {}, ...value.timezone ? { timezone: value.timezone } : {},
})

export async function scanCalendarSync(ctx: SourceContext, binding: LarkUserBinding, signal: AbortSignal,
  clock: () => Date): Promise<string> {
  const config = ctx.config<CalendarConfig>('calendar')
  if (!config?.events) return 'off'
  const now = clock(), previous = ctx.state.get(KV.workspace.calendar) ?? {}
  const pending = pendingLarkEvents(ctx, binding.expectedUserId, 'calendar')
  const reconnect = larkReconcileToken(ctx, binding.expectedUserId, 'calendar')
  if (reconnect === undefined && previous.syncToken && !pending.length && previous.lastSuccess
    && Date.parse(previous.lastSuccess) + config.reconcileSeconds * 1000 > now.getTime()) return 'Calendar events active; incremental reconciliation is not due'
  const signature = JSON.stringify(config)
  const active = () => {
    signal.throwIfAborted()
    if (JSON.stringify(ctx.config<CalendarConfig>('calendar')) !== signature) throw new Error('Calendar source changed during sync')
  }
  const user = await larkUserBinding(ctx.commands.withSignal(signal), binding, active)
  const calendarId = previous.nativeCalendarId ?? (await user.read(Primary, ['api', 'POST', '/open-apis/calendar/v4/calendars/primary'])).calendars[0]?.calendar.calendar_id
  if (!calendarId) throw new Error('Personal primary calendar was not resolved')
  const relevant = pending.filter(event => event.payload.calendar_id === calendarId)
  const changedIds = new Set(relevant.map(event => event.payload.calendar_event_id))
  const versions = { ...previous.events }
  const inPlanningWindow = (start: string) => Date.parse(start) >= now.getTime()
    && Date.parse(start) < now.getTime() + config.horizonDays * 86400_000
  const pages = new Set<string>()
  let cursor: string | undefined, token: string | undefined, emitted = 0, count = 0
  let activeToken = previous.syncToken, recovered = false
  while (true) {
    const params = { page_size: 500, ...activeToken ? { sync_token: activeToken } : { anchor_time: String(Math.floor(now.getTime() / 1000) - 86400) },
      ...cursor ? { page_token: cursor } : {} }
    let page: z.infer<typeof Page>
    try {
      page = await user.read(Page, ['api', 'GET', `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`, '--params', JSON.stringify(params)])
    } catch (error) {
      if (error instanceof CliError && error.code === 190008 && !recovered && (activeToken || cursor)) {
        activeToken = undefined; cursor = undefined; recovered = true; pages.clear(); count = 0
        continue
      }
      throw error
    }
    for (const item of page.items) {
      const old = versions[item.event_id]
      let trigger
      if (item.status === 'cancelled') {
        if (old && !old.cancelled) {
          const revision = (old.revision ?? 0) + 1
          if (inPlanningWindow(old.start)) trigger = calendarCancellation(item.event_id, old, now.toISOString(), revision)
          versions[item.event_id] = { ...old, cancelled: true, revision }
        }
      } else {
        if (!item.start_time) throw new Error('Calendar change lacks its start time')
        const event = CalendarEventSchema.parse({ ...item, start_time: time(item.start_time), end_time: item.end_time ? time(item.end_time) : undefined })
        const version = eventVersion(event), revision = !old || old.version !== version || old.cancelled ? (old?.revision ?? 0) + 1 : old.revision ?? 0
        const entry = { version, start: eventStart(event.start_time), summary: event.summary ?? '', revision,
          ...event.event_organizer?.user_id ? { organizer: event.event_organizer.user_id } : {} }
        versions[item.event_id] = entry
        const inWindow = inPlanningWindow(entry.start)
        const previousInWindow = !!old && !old.cancelled && inPlanningWindow(old.start)
        if ((previous.baselineAt || changedIds.has(item.event_id)) && (inWindow || previousInWindow)
          && (!old || old.cancelled || old.version !== version)) {
          trigger = calendarTrigger(event, !old || old.cancelled ? 'scheduled' : 'updated', now.toISOString(), revision)
          if (!inWindow) trigger.meta.outsidePlanningWindow = true
        }
      }
      if (trigger) {
        trigger.meta = { ...trigger.meta, calendarId }
        const result = await ctx.receive(trigger)
        if (result !== 'stored' && result !== 'duplicate') throw new Error('Calendar change was not persisted')
        emitted++
      }
    }
    count++
    cursor = nextPage(page, pages)
    token = page.sync_token
    if (cursor && count >= 40) throw new Error('Calendar sync page budget reached; old cursor retained')
    if (!cursor) break
  }
  if (!token) throw new Error('Calendar returned no durable sync token')
  active()
  ctx.atomic(() => {
    ctx.state.set(KV.workspace.calendar, { ...previous, events: versions, baselineAt: previous.baselineAt ?? now.toISOString(),
      nativeCalendarId: calendarId, syncToken: token, lastSuccess: now.toISOString(),
      ...recovered ? { syncGap: { at: now.toISOString(), reason: 'token_expired' as const } } : {} })
    for (const event of pending) finishLarkEvent(ctx, binding.expectedUserId, 'calendar', event,
      event.payload.calendar_id === calendarId ? 'applied' : 'outside_scope')
    finishLarkReconcile(ctx, binding.expectedUserId, 'calendar', reconnect)
  })
  return `${emitted} calendar change(s) through native incremental sync${recovered ? '; expired-token gap retained, current state resynchronized' : ''}`
}
