/** Plugin entry for the read-only Lark workspace Sources: mailbox, assigned tasks and the owner's calendar. */
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { setTimeout as delay } from 'node:timers/promises'
import { calendarKind, scanCalendarRound } from './calendar.ts'
import { sourceContext } from './host.ts'
import type { LarkUserBinding } from './lark-user.ts'
import { createMailKind, scanMailRound } from './mail.ts'
import { queueTaskEvent, scanTaskRound, taskKind } from './task.ts'
import { consumeLarkBridge, type BridgeEvent } from './lark-events.ts'
import { queueLarkEvent, requestLarkReconcile } from './lark-event-inbox.ts'
import { receiveSharedFeishu } from './feishu-loops.ts'
import { feishuKind } from './feishu.ts'
import { prepareLarkSubscriptions } from './lark-subscriptions.ts'
import { larkUserBinding } from './lark-user.ts'
import { runWorkspaceSource } from './workspace-run.ts'

export const name = 'dsh-superagent-lark-workspace'
export const inject = ['orchestrator']
export const Config = s.object({
  configDir: s.string().default('').description('Existing user lark-cli configuration directory; no credentials.'),
  larkCli: s.string().default('').description('Absolute path of the native lark-cli used for owner reads; empty reuses the Feishu Source CLI.'),
  expectedUserId: s.string().default('').description('Feishu open_id the owner-delegated reads must resolve to.'),
  eventCommand: s.array(s.string()).default([]).description('Trusted broker command for the shared native SDK event bridge; no credentials.'),
})
export type LarkWorkspacePluginConfig = ReturnType<typeof Config>
/**
 * Retries the initial shared personal-event setup. The bridge is the only consumer when the Feishu Source shares
 * delivery, so a temporary CLI or identity failure must keep retrying instead of ending the transport for good.
 */
export async function prepareSharedEventSetup(signal: AbortSignal, setup: () => Promise<Record<string, string>>,
  report: (state: 'error', detail: string) => void, retryMs = 30_000): Promise<Record<string, string>> {
  while (true) {
    try { return await setup() }
    catch (error) {
      if (signal.aborted) return {}
      report('error', `Personal event setup failed; retrying: ${error instanceof Error ? error.message : String(error)}`)
      await delay(retryMs, undefined, { signal }).catch(() => {})
      if (signal.aborted) return {}
    }
  }
}
/** Registers the three kinds and starts one read-only loop per kind; each loop stops with the plugin or the Runtime. */
export function apply(ctx: Context, config: LarkWorkspacePluginConfig): void {
  const binding: LarkUserBinding = { expectedUserId: config.expectedUserId, ...config.configDir ? { configDir: config.configDir } : {},
    ...config.larkCli ? { cli: config.larkCli } : {} }
  const mail = createMailKind(binding), task = taskKind(binding), calendar = calendarKind(binding)
  ctx.effect(() => ctx.orchestrator.sources.register(mail), 'mail: source kind')
  ctx.effect(() => ctx.orchestrator.sources.register(task), 'task: source kind')
  ctx.effect(() => ctx.orchestrator.sources.register(calendar), 'calendar: source kind')
  ctx.effect(() => ctx.orchestrator.runSource(signal =>
    runWorkspaceSource(sourceContext(ctx.orchestrator, mail), mail.kind, signal, (source, stopped) => scanMailRound(source, binding, stopped))))
  ctx.effect(() => ctx.orchestrator.runSource(signal =>
    runWorkspaceSource(sourceContext(ctx.orchestrator, task), task.kind, signal, (source, stopped) => scanTaskRound(source, binding, stopped))))
  ctx.effect(() => ctx.orchestrator.runSource(async signal => {
    const source = sourceContext(ctx.orchestrator, task)
    await source.ready
    if (!source.configured()) return
    if (config.eventCommand.length) {
      const feishu = sourceContext(ctx.orchestrator, feishuKind)
      const mailContext = sourceContext(ctx.orchestrator, mail), calendarContext = sourceContext(ctx.orchestrator, calendar)
      const activity = ctx.orchestrator.context({ kind: 'activity', health: ['activity', 'activity:events', 'activity:feishu-documents'] })
      let failures: Record<string, string> = {}, received = 0
      const subscriptionConfig = () => JSON.stringify(['mail', 'task', 'calendar', 'activity'].map(kind => source.config(kind)))
      const report: Parameters<typeof consumeLarkBridge>[3] = (state, detail) => {
        for (const [kind, context] of [['task', source], ['mail', mailContext], ['calendar', calendarContext], ['activity', activity]] as const) {
          const enabled = kind === 'activity' ? activity.config<{ documentEvents: boolean }>(kind)?.documentEvents
            : context.config<{ events: boolean }>(kind)?.events
          context.report(`${kind}:events`, { state: !enabled ? 'paused' : failures[kind] ? 'error' : state,
            detail: !enabled ? 'Event reads disabled' : failures[kind] ?? `${detail}; ${received} notifications received (connection readiness is not delivery coverage)`, at: new Date().toISOString() })
        }
        if (feishu.config<{ sharedEvents?: boolean }>('feishu')?.sharedEvents) feishu.report('feishu', { state, detail, at: new Date().toISOString() })
      }
      // A transient identity or subscription failure at startup must not end the only shared transport.
      failures = await prepareSharedEventSetup(signal, async () => {
        await larkUserBinding(source.commands.withSignal(signal), binding)
        return prepareLarkSubscriptions(source, binding, signal)
      }, (state, detail) => {
        if (state === 'error') failures = Object.fromEntries(['mail', 'task', 'calendar', 'activity'].map(kind => [kind, detail]))
        report(state, detail)
      })
      if (signal.aborted) return
      let subscribed = subscriptionConfig()
      const renew = async () => {
        while (!signal.aborted) {
          await delay(30_000, undefined, { signal }).catch(() => {})
          if (signal.aborted) return
          const current = subscriptionConfig()
          if (current !== subscribed || Object.keys(failures).length) {
            try {
              failures = await prepareLarkSubscriptions(source, binding, signal)
              subscribed = current
            } catch {
              if (signal.aborted) return
              failures = Object.fromEntries(['mail', 'task', 'calendar', 'activity'].map(kind => [kind, 'Personal subscription identity unavailable; retrying']))
            }
          }
        }
      }
      const accept = async (event: BridgeEvent) => {
        received++
        if (event.eventType === 'im.message.receive_v1') { await receiveSharedFeishu(feishu, event.payload); return }
        if (event.eventType === 'task.task.update_user_access_v2') {
          queueTaskEvent(source, binding, { header: { event_id: event.eventId, event_type: event.eventType, create_time: event.at }, event: event.payload })
          return
        }
        if (event.eventType === 'mail.user_mailbox.event.message_received_v1' && mailContext.config<{ events: boolean }>('mail')?.events) queueLarkEvent(mailContext, binding.expectedUserId, 'mail', event)
        else if (event.eventType === 'calendar.calendar.event.changed_v4' && calendarContext.config<{ events: boolean }>('calendar')?.events) queueLarkEvent(calendarContext, binding.expectedUserId, 'calendar', event)
        else if (event.eventType.startsWith('drive.') && activity.config<{ documentEvents: boolean }>('activity')?.documentEvents) queueLarkEvent(activity, binding.expectedUserId, 'documents', event)
      }
      let connected = false
      await Promise.all([consumeLarkBridge(config.eventCommand, signal, async event => { await accept(event); report('ready', `Last event: ${event.eventType}`) }, (state, detail) => {
        if (state === 'ready' && !connected) {
          for (const kind of ['task', 'mail', 'calendar', 'documents']) requestLarkReconcile(source, binding.expectedUserId, kind)
        }
        connected = state === 'ready'
        report(state, detail)
      }), renew()])
      return
    }
    source.report('task:events', { state: 'paused', detail: 'Configure the shared personal event command' })
  }))
  ctx.effect(() => ctx.orchestrator.runSource(signal =>
    runWorkspaceSource(sourceContext(ctx.orchestrator, calendar), calendar.kind, signal, (source, stopped) => scanCalendarRound(source, binding, stopped))))
}
