/** Native user calendar synchronization. Event notifications wake the existing durable cursor; recurring masters are projected through a bounded instance view. */
import { z } from 'zod'
import { KV } from '../kv.ts'
import { calendarCancellation, CalendarEventSchema, calendarTrigger, eventStart, eventVersion, type CalendarConfig,
  type CalendarState } from './calendar.ts'
import { finishLarkEvent, pendingLarkEvents, larkReconcileToken, finishLarkReconcile } from './lark-event-inbox.ts'
import { larkUserBinding, nextPage, type LarkUserBinding } from './lark-user.ts'
import type { SourceContext } from './host.ts'
import { CliError } from '../infra/commands.ts'

const NativeTime = z.object({ timestamp: z.string().optional(), date: z.string().optional(), timezone: z.string().optional() })
const NativeEvent = z.object({ event_id: z.string().min(1), status: z.string().optional(), summary: z.string().optional(),
  start_time: NativeTime.optional(), end_time: NativeTime.optional(), app_link: z.string().optional(),
  event_organizer: z.object({ user_id: z.string().optional(), display_name: z.string().optional() }).optional(),
  self_rsvp_status: z.string().optional(), is_exception: z.boolean().optional(),
  recurrence: z.string().nullish(), recurring_event_id: z.string().nullish(),
  vchat: z.object({ meeting_url: z.string().nullish() }).nullish() })
const Page = z.object({ items: z.array(NativeEvent), has_more: z.boolean(), page_token: z.string().optional(), sync_token: z.string().optional() })
const InstanceView = z.object({ items: z.array(NativeEvent) })
const Primary = z.object({ calendars: z.array(z.object({ calendar: z.object({ calendar_id: z.string().min(1) }) })) })
const time = (value: z.infer<typeof NativeTime>) => ({
  ...value.timestamp ? { datetime: new Date(Number(value.timestamp) * 1000).toISOString() } : {},
  ...value.date ? { date: value.date } : {}, ...value.timezone ? { timezone: value.timezone } : {},
})
type Native = z.infer<typeof NativeEvent>
type CalendarEntry = NonNullable<CalendarState['events']>[string]
type User = Awaited<ReturnType<typeof larkUserBinding>>
/** The occurrence id the native API derives from a series uid and its original time; suffix 0 is the series master. */
const eventIdBase = (eventId: string): string => {
  const at = eventId.lastIndexOf('_')
  return at > 0 ? eventId.slice(0, at) : eventId
}
const occurrenceTime = (eventId: string): string => {
  const at = eventId.lastIndexOf('_')
  return at > 0 ? eventId.slice(at + 1) : ''
}
const isOccurrence = (eventId: string): boolean => /^\d+$/.test(occurrenceTime(eventId)) && Number(occurrenceTime(eventId)) > 0
const numericSuffix = (eventId: string): boolean => /^\d+$/.test(occurrenceTime(eventId))
const relatedTo = (seriesId: string, item: Native): boolean => item.recurring_event_id === seriesId
  || (!!item.recurring_event_id && numericSuffix(item.recurring_event_id) && numericSuffix(seriesId)
    && eventIdBase(item.recurring_event_id) === eventIdBase(seriesId))
  || (isOccurrence(item.event_id) && numericSuffix(seriesId) && eventIdBase(item.event_id) === eventIdBase(seriesId))
const instanceStart = (item: Native): string | undefined => item.start_time ? eventStart(time(item.start_time)) : undefined
const instanceAt = (item: Native): number => {
  const start = instanceStart(item)
  return start ? Date.parse(start) : Number.MAX_SAFE_INTEGER
}
/** Master fields plus the recurrence rule; occurrence starts move with the clock and are not a change signal. */
const masterFingerprint = (event: z.infer<typeof CalendarEventSchema>): string =>
  `${eventVersion(event)}\u0000${event.recurrence ?? ''}`
/** One instance-view response may repeat an occurrence across a split boundary; keep the first by identity and order by start. */
const uniqueInstances = (items: Native[]): Native[] => {
  const seen = new Set<string>()
  return items.filter(item => {
    const identity = `${item.event_id}\u0000${instanceStart(item) ?? ''}`
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  }).sort((left, right) => instanceAt(left) - instanceAt(right))
}
/**
 * Reads the bounded instance view for the planning window. The endpoint has no page token, but its 1000-instance
 * and 40-day limits are recoverable by halving the range; any other failure propagates so the notification is retried.
 */
async function readInstanceView(user: User, calendarId: string, from: number, to: number, depth = 0): Promise<Native[]> {
  if (to <= from) return []
  const params = { start_time: String(Math.floor(from / 1000)), end_time: String(Math.ceil(to / 1000)) }
  try {
    return (await user.read(InstanceView, ['api', 'GET',
      `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/instance_view`, '--params', JSON.stringify(params)])).items
  } catch (error) {
    const split = error instanceof CliError && (error.code === 193103 || error.code === 193104)
    if (!split || depth >= 10 || to - from <= 2 * 3_600_000) throw error
    const middle = Math.floor((from + to) / 2)
    return [...await readInstanceView(user, calendarId, from, middle, depth + 1),
      ...await readInstanceView(user, calendarId, middle + 1, to, depth + 1)]
  }
}
/** Projects the first in-window occurrence onto the series master so a change keeps the stable series identity but a real start. */
function projectSeries(master: z.infer<typeof CalendarEventSchema>, occurrence: Native | undefined) {
  if (!occurrence?.start_time) return master
  return CalendarEventSchema.parse({ ...master, start_time: time(occurrence.start_time),
    end_time: occurrence.end_time ? time(occurrence.end_time) : master.end_time })
}

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
  const versions: Record<string, CalendarEntry> = { ...previous.events }
  const inPlanningWindow = (start: string) => Date.parse(start) >= now.getTime()
    && Date.parse(start) < now.getTime() + config.horizonDays * 86400_000
  const pages = new Set<string>()
  let instanceCache: Native[] | undefined, viewRead = false
  const instances = async () => {
    if (!instanceCache) {
      viewRead = true
      instanceCache = uniqueInstances(await readInstanceView(user, calendarId, now.getTime(),
        now.getTime() + config.horizonDays * 86400_000))
    }
    return instanceCache
  }
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
      const start = instanceStart(item)
      // A series master is recognisable by its rule, or by an existing projected entry, or by an old `{uid}_0` event
      // whose original start is outside the window. Exceptions remain single occurrences on their own event id.
      const series = item.is_exception !== true && (!!item.recurrence || old?.recurring === true
        || (!!old && old.recurring === undefined && item.event_id.endsWith('_0') && !inPlanningWindow(old.start)
          && !!start && !inPlanningWindow(start)))
      let trigger
      if (item.status === 'cancelled') {
        if (old && !old.cancelled) {
          const revision = (old.revision ?? 0) + 1
          if (series) {
            const related = (await instances()).filter(candidate => relatedTo(item.event_id, candidate))
            const projected = old.recurring === true || !!item.recurrence || related.length > 0
            if (projected) {
              // Stored and current occurrence starts are both judged against the clock now; a series that ended
              // weeks ago must not cancel on starts that were in the window at its last projection.
              const relatedStarts = related.flatMap(candidate => {
                const at = instanceStart(candidate)
                return at && inPlanningWindow(at) ? [at] : []
              }).sort()
              const storedStarts = (old.windowStarts ?? []).filter(inPlanningWindow).sort()
              const evidenceStart = relatedStarts[0] ?? storedStarts[0]
              const legacyStart = old.windowStarts === undefined && inPlanningWindow(old.start)
              if (evidenceStart || legacyStart) {
                trigger = calendarCancellation(item.event_id, evidenceStart ? { ...old, start: evidenceStart } : old,
                  now.toISOString(), revision)
              }
              versions[item.event_id] = { ...old, cancelled: true, recurring: true, revision, windowStarts: [] }
            } else {
              if (inPlanningWindow(old.start)) trigger = calendarCancellation(item.event_id, old, now.toISOString(), revision)
              versions[item.event_id] = { ...old, cancelled: true, revision }
            }
          } else {
            if (inPlanningWindow(old.start)) trigger = calendarCancellation(item.event_id, old, now.toISOString(), revision)
            versions[item.event_id] = { ...old, cancelled: true, revision }
          }
        } else if (!old && series && item.recurrence) {
          // A cancelled series first observed through the notification still resolves its bounded window occurrences.
          const related = (await instances()).filter(candidate => relatedTo(item.event_id, candidate) && candidate.start_time)
            .map(candidate => ({ item: candidate, start: instanceStart(candidate)! }))
            .filter(candidate => inPlanningWindow(candidate.start)).sort((left, right) => Date.parse(left.start) - Date.parse(right.start))
          const earliest = related[0]
          if (earliest && (previous.baselineAt || changedIds.has(item.event_id))) {
            const event = CalendarEventSchema.parse({ ...item, start_time: time(earliest.item.start_time!),
              ...earliest.item.end_time ? { end_time: time(earliest.item.end_time) } : {},
              ...!item.summary && earliest.item.summary ? { summary: earliest.item.summary } : {},
              ...!item.event_organizer && earliest.item.event_organizer ? { event_organizer: earliest.item.event_organizer } : {} })
            const occurrence = { version: eventVersion(event), start: earliest.start, summary: event.summary ?? '',
              ...event.event_organizer?.user_id ? { organizer: event.event_organizer.user_id } : {} }
            trigger = calendarCancellation(item.event_id, occurrence, now.toISOString(), 1)
            versions[item.event_id] = { ...occurrence, revision: 1, cancelled: true, recurring: true, windowStarts: [] }
          }
        } else if (!old && isOccurrence(item.event_id)) {
          // A cancelled virtual occurrence was never stored on its own; resolve its start from the same bounded view.
          const found = (await instances()).find(candidate => candidate.event_id === item.event_id && candidate.start_time)
          const at = found ? instanceStart(found) : undefined
          if (found && at && inPlanningWindow(at) && (previous.baselineAt || changedIds.has(item.event_id))) {
            const event = CalendarEventSchema.parse({ ...found, start_time: time(found.start_time!),
              end_time: found.end_time ? time(found.end_time) : undefined })
            const occurrence = { version: eventVersion(event), start: at, summary: event.summary ?? '',
              ...event.event_organizer?.user_id ? { organizer: event.event_organizer.user_id } : {} }
            trigger = calendarCancellation(item.event_id, occurrence, now.toISOString(), 1)
            versions[item.event_id] = { ...occurrence, revision: 1, cancelled: true }
          }
        }
      } else {
        if (!item.start_time) throw new Error('Calendar change lacks its start time')
        const event = CalendarEventSchema.parse({ ...item, start_time: time(item.start_time), end_time: item.end_time ? time(item.end_time) : undefined })
        const related = series ? (await instances()).filter(candidate => relatedTo(item.event_id, candidate)) : []
        // Inference alone is not enough to persist a series: a plain `{uid}_0` event must not become recurring just
        // because its original start stayed outside the window. A rule, an earlier projection or actual occurrences do.
        if (series && (!!item.recurrence || old?.recurring === true || related.length > 0)) {
          const window = related.filter(candidate => candidate.status !== 'cancelled' && candidate.start_time)
            .map(candidate => ({ item: candidate, start: instanceStart(candidate)! }))
            .filter(candidate => inPlanningWindow(candidate.start)).sort((left, right) => Date.parse(left.start) - Date.parse(right.start))
          const starts = [...new Set(window.map(candidate => candidate.start))]
          const projected = projectSeries(event, window[0]?.item)
          const version = eventVersion(projected)
          // Keep the master fields separate from the first occurrence: an exception at the front of the window can
          // mask a changed series duration, while the projected version still has to carry the occurrence start.
          // Occurrence sets move with the clock, so only master content (including the rule) is a change signal.
          const masterVersion = masterFingerprint(event)
          // Entries written before series projection stored the master version in `version`, so they compare against
          // their existing version and adopt the new projection silently; only real content changes may emit.
          const contentChanged = !old || old.cancelled
            || (old.masterVersion !== undefined ? old.masterVersion !== masterVersion : old.version !== eventVersion(event))
          const revision = contentChanged ? (old?.revision ?? 0) + 1 : old?.revision ?? 0
          const entry: CalendarEntry = { version, start: starts[0] ?? eventStart(event.start_time), summary: projected.summary ?? '',
            revision, recurring: true, windowStarts: starts, masterVersion,
            ...projected.event_organizer?.user_id ? { organizer: projected.event_organizer.user_id } : {} }
          versions[item.event_id] = entry
          const storedWindow = (old?.windowStarts ?? []).filter(inPlanningWindow)
          const previousInWindow = !!old && !old.cancelled && (storedWindow.length > 0 || inPlanningWindow(old.start))
          if ((previous.baselineAt || changedIds.has(item.event_id)) && contentChanged
            && (starts.length > 0 || previousInWindow)) {
            trigger = calendarTrigger(projected, !old || old.cancelled ? 'scheduled' : 'updated', now.toISOString(), revision)
            if (!starts.length) trigger.meta.outsidePlanningWindow = true
          }
        } else {
          const version = eventVersion(event), revision = !old || old.version !== version || old.cancelled ? (old?.revision ?? 0) + 1 : old.revision ?? 0
          const entry: CalendarEntry = { version, start: eventStart(event.start_time), summary: event.summary ?? '', revision,
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
  return `${emitted} calendar change(s) through native incremental sync${viewRead ? '; recurring window coverage verified' : ''}${recovered ? '; expired-token gap retained, current state resynchronized' : ''}`
}
