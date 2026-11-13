/** Durable source deliveries awaiting object reads; business state stays in Trigger/Line/Ticket. */
import { family } from '../kv.ts'
import type { SourceContext } from './host.ts'
import type { BridgeEvent } from './lark-events.ts'

export type LarkSourceEvent = Pick<BridgeEvent, 'eventType' | 'eventId' | 'at' | 'payload'>
const deliveries = family<LarkSourceEvent, [owner: string, kind: string, id: string]>('lark-source-pending:')
const reconcile = family<number, [owner: string, kind: string]>('lark-source-reconcile:')
/** A connection recovery wakes a bounded catch-up without changing the source's confirmed cursor. */
export const larkReconcileToken = (ctx: SourceContext, owner: string, kind: string) => ctx.state.get(reconcile(owner, kind))
export function requestLarkReconcile(ctx: SourceContext, owner: string, kind: string) {
  const key = reconcile(owner, kind)
  ctx.state.set(key, (ctx.state.get(key) ?? 0) + 1)
}
export function finishLarkReconcile(ctx: SourceContext, owner: string, kind: string, token: number | undefined) {
  const key = reconcile(owner, kind)
  if (token !== undefined && ctx.state.get(key) === token) ctx.state.set(key, undefined)
}
type Outcome = 'pending' | 'applied' | 'outside_scope'
const receipts = family<{ at: string; kind: string; eventType: string; objectId?: string; outcome: Outcome }, [owner: string, id: string]>('lark-source-receipt:')
const receipt = (event: LarkSourceEvent, kind: string, outcome: Outcome) => ({
  at: event.at, kind, eventType: event.eventType, outcome,
  objectId: [event.payload.task_guid, event.payload.message_id, event.payload.calendar_event_id, event.payload.file_token]
    .find((value): value is string => typeof value === 'string'),
})

export function queueLarkEvent(ctx: SourceContext, owner: string, kind: string, event: LarkSourceEvent) {
  ctx.atomic(() => {
    const id = receipts(owner, event.eventId)
    if (ctx.state.get(id)) return
    const { eventType, eventId, at, payload } = event
    ctx.state.set(deliveries(owner, kind, event.eventId), { eventType, eventId, at, payload })
    ctx.state.set(id, receipt(event, kind, 'pending'))
  })
}

export function pendingLarkEvents(ctx: SourceContext, owner: string, kind: string) {
  const prefix = family<LarkSourceEvent>(`lark-source-pending:${owner}:${kind}:`)
  return ctx.state.keys(prefix).flatMap(id => {
    const event = ctx.state.get(id)
    return event ? [event] : []
  }).sort((a, b) => Number(a.at) - Number(b.at))
}

export function finishLarkEvent(ctx: SourceContext, owner: string, kind: string, event: LarkSourceEvent, outcome: Exclude<Outcome, 'pending'> = 'applied') {
  ctx.atomic(() => {
    ctx.state.set(receipts(owner, event.eventId), receipt(event, kind, outcome))
    ctx.state.set(deliveries(owner, kind, event.eventId), undefined)
  })
}
