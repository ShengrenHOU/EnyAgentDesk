/** Plugin entry for the read-only Lark workspace Sources: mailbox, assigned tasks and the owner's calendar. */
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { calendarKind, scanCalendarRound } from './calendar.ts'
import { sourceContext } from './host.ts'
import { createMailKind, scanMailRound } from './mail.ts'
import { queueTaskEvent, scanTaskRound, taskKind } from './task.ts'
import type { LarkEventStatus } from './lark-account.ts'
import { queueLarkEvent, requestLarkReconcile } from './lark-event-inbox.ts'
import { runLarkSubscriptions } from './lark-subscriptions.ts'
import { runWorkspaceSource } from './workspace-run.ts'

export const name = 'dsh-superagent-lark-workspace'
export const inject = ['orchestrator', 'larkAccount']
export const Config = s.object({
  configDir: s.string().default('').hidden().description('Legacy migration input; configure lark-account.'),
  larkCli: s.string().default('').hidden().description('Legacy migration input; configure lark-account.'),
  expectedUserId: s.string().default('').hidden().description('Legacy migration input; configure lark-account.'),
  eventCommand: s.array(s.string()).default([]).hidden().description('Legacy migration input; configure lark-account.'),
})
export type LarkWorkspacePluginConfig = ReturnType<typeof Config>
export { prepareSharedEventSetup } from './lark-subscriptions.ts'
/** Registers the three kinds and starts one read-only loop per kind; each loop stops with the plugin or the Runtime. */
export function apply(ctx: Context, config: LarkWorkspacePluginConfig): void {
  const account = ctx.larkAccount, binding = account.binding
  account.checkLegacy({ expectedUserId: config.expectedUserId, configDir: config.configDir, cli: config.larkCli }, config.eventCommand)
  const mail = createMailKind(binding), task = taskKind(binding), calendar = calendarKind(binding)
  ctx.effect(() => ctx.orchestrator.sources.register(mail), 'mail: source kind')
  ctx.effect(() => ctx.orchestrator.sources.register(task), 'task: source kind')
  ctx.effect(() => ctx.orchestrator.sources.register(calendar), 'calendar: source kind')
  const contexts = { task: sourceContext(ctx.orchestrator, task), mail: sourceContext(ctx.orchestrator, mail), calendar: sourceContext(ctx.orchestrator, calendar) }
  let failures: Record<string, string> = {}
  const statuses = new Map<string, LarkEventStatus>()
  const report = (kind: keyof typeof contexts, status: LarkEventStatus) => {
    statuses.set(kind, status)
    const source = contexts[kind], enabled = source.config<{ events: boolean }>(kind)?.events
    const problem = failures[kind] || (enabled && account.mode !== 'sdk' ? 'Configure the account event command' : undefined)
    source.report(`${kind}:events`, { state: !enabled ? 'paused' : problem ? 'error' : status.state,
      detail: !enabled ? 'Event reads disabled' : problem ?? `${status.detail}; received ${status.received}, accepted ${status.accepted}, failed ${status.failed} deliveries (including retries)`, at: new Date().toISOString() })
  }
  const types = { task: 'task.task.update_user_access_v2', mail: 'mail.user_mailbox.event.message_received_v1', calendar: 'calendar.calendar.event.changed_v4' }
  for (const kind of ['task', 'mail', 'calendar'] as const) {
    const source = contexts[kind]
    ctx.effect(() => account.subscribe([types[kind]], async event => {
      if (!source.config<{ events: boolean }>(kind)?.events) return false
      if (kind === 'task') queueTaskEvent(source, binding, { header: { event_id: event.eventId, event_type: event.eventType, create_time: event.at }, event: event.payload })
      else queueLarkEvent(source, binding.expectedUserId, kind, event)
      return true
    }, status => report(kind, status), () => requestLarkReconcile(source, binding.expectedUserId, kind)))
  }
  ctx.effect(() => ctx.orchestrator.runSource(signal => runWorkspaceSource(contexts.mail, 'mail', signal, (source, stopped) => scanMailRound(source, binding, stopped))))
  ctx.effect(() => ctx.orchestrator.runSource(signal => runWorkspaceSource(contexts.task, 'task', signal, (source, stopped) => scanTaskRound(source, binding, stopped))))
  ctx.effect(() => ctx.orchestrator.runSource(signal => runWorkspaceSource(contexts.calendar, 'calendar', signal, (source, stopped) => scanCalendarRound(source, binding, stopped))))
  ctx.effect(() => ctx.orchestrator.runSource(async signal => {
    await contexts.task.ready
    if (!contexts.task.configured() || account.mode !== 'sdk') return
    await runLarkSubscriptions(contexts.task, binding, ['mail', 'task', 'calendar'], signal, value => {
      failures = value
      for (const kind of ['mail', 'task', 'calendar'] as const) report(kind, statuses.get(kind)!)
    })
  }))
}
