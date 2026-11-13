/** Desensitized native calendar responses used by the recurring-event regressions. */
export const unix = (iso: string): string => String(Math.floor(Date.parse(iso) / 1000))
export const plusMinutes = (iso: string, minutes: number): string => new Date(Date.parse(iso) + minutes * 60_000).toISOString()
export const timed = (iso: string, timezone?: string): Record<string, string> => ({
  timestamp: unix(iso), ...timezone ? { timezone } : {},
})
export const allDay = (date: string, timezone?: string): Record<string, string> => ({ date, ...timezone ? { timezone } : {} })
/** The stable occurrence id the native API derives from the series uid and an occurrence's original time. */
export const occurrenceId = (seriesId: string, originalIso: string): string =>
  `${seriesId.replace(/_0$/, '')}_${unix(originalIso)}`
export const nativeEvent = (eventId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  event_id: eventId, status: 'confirmed', ...overrides,
})
/** A recurring series master: the original start stays outside the test window while instances remain inside it. */
export const seriesMaster = (seriesId: string, originalIso: string, overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  nativeEvent(seriesId, { summary: 'Weekly exchange', recurrence: 'FREQ=WEEKLY;INTERVAL=1',
    start_time: timed(originalIso), end_time: timed(plusMinutes(originalIso, 60)),
    event_organizer: { user_id: 'ou_organizer' }, ...overrides })
export const occurrence = (seriesId: string, originalIso: string, overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  nativeEvent(occurrenceId(seriesId, originalIso), { summary: 'Weekly exchange', recurring_event_id: seriesId,
    is_exception: false, start_time: timed(originalIso), end_time: timed(plusMinutes(originalIso, 60)),
    event_organizer: { user_id: 'ou_organizer' }, ...overrides })
export const nativePage = (items: unknown[], syncToken: string, next?: string): Record<string, unknown> => ({
  items, has_more: !!next, ...next ? { page_token: next } : {}, sync_token: syncToken,
})
export const instanceView = (items: unknown[]): Record<string, unknown> => ({ items })
