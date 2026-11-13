/** The read-only Lark workspace Sources: mail, assigned tasks and the calendar, on a real Store and Engine. */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { Engine, key, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf } from '../src/app/source-context.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { KV } from '../src/kv.ts'
import { queueLarkEvent, pendingLarkEvents, requestLarkReconcile, larkReconcileToken } from '../src/sources/lark-event-inbox.ts'
import type { BridgeEvent } from '../src/sources/lark-events.ts'
import type { LarkUserBinding } from '../src/sources/lark-user.ts'
import { createMailKind, foldersOf, mailTime, scanMailRound, type MailConfig } from '../src/sources/mail.ts'
import { drainTaskEvents, queueTaskEvent, scanTaskRound, taskKind, type TaskConfig } from '../src/sources/task.ts'
import { calendarKind, CalendarEventSchema, eventStart, eventVersion, scanCalendarRound, type CalendarConfig } from '../src/sources/calendar.ts'
import { prepareSharedEventSetup } from '../src/sources/lark-workspace.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { allDay, instanceView, nativeEvent, nativePage, occurrence, occurrenceId, seriesMaster, timed } from './fixtures/calendar-native.ts'

const owner = 'ou_owner'
const binding: LarkUserBinding = { expectedUserId: owner, cli: 'synthetic-lark', configDir: '/private/user-config' }
const clockAt = (iso: string) => () => new Date(iso)
let directory: string | undefined
let store: Store
afterEach(() => {
  try { store?.close() } catch { /* the test did not open a store */ }
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
  vi.restoreAllMocks()
})

const pad = (value: number) => String(value).padStart(2, '0')
/** The mailbox prints local wall-clock time without a timezone; produce it from the same instant the test clock uses. */
const localStamp = (iso: string): string => {
  const date = new Date(iso)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
const envelope = (data: unknown) => JSON.stringify({ ok: true, identity: 'user', data })
const json = (data: unknown) => JSON.stringify(data)
const primaryCalendar = envelope({ calendars: [{ calendar: { calendar_id: 'primary-calendar' } }] })

function host() {
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  const mail = createMailKind(binding), task = taskKind(binding), calendar = calendarKind(binding)
  sources.register(mail)
  sources.register(task)
  sources.register(calendar)
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: message => store.receipts.add(message), status: () => undefined, withdraw: () => {} }, now: () => new Date().toISOString() })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const received: Trigger[] = []
  const receive = vi.fn((trigger: Trigger) => { received.push(trigger); return engine.receive(trigger) })
  const deps = { store, engine, sources, commands, receive, deployment: testDeployment(), ready: Promise.resolve(), configured: () => true,
    outbox: { send: (message: Parameters<typeof store.receipts.add>[0]) => { store.receipts.add(message) } } }
  return { board, sources, engine, receive, received, commands,
    ctx: { mail: sourceContextOf(deps, mail), task: sourceContextOf(deps, task), calendar: sourceContextOf(deps, calendar) } }
}
/** Installs settings for one workspace kind and returns the host built from them. */
function workspace(sources: Record<string, { enabled: boolean; config: Record<string, unknown> }>, policy: Record<string, unknown> = {}) {
  directory = mkdtempSync(join(tmpdir(), 'lark-workspace-'))
  store = new Store(join(directory, 'state.sqlite'))
  store.saveSettings(SettingsSchema.parse({ eval: { mode: 'observe' }, sources, policy: { sources: policy } }))
  return host()
}
const mailConfig: MailConfig = { accounts: [{ id: 'feishu', mailbox: 'me', folders: 'INBOX', enabled: 'on' }],
  pollSeconds: 120, overlapSeconds: 300, initialLookbackHours: 24, maxMessagesPerPoll: 50, maxPagesPerPoll: 5, ignoreBulk: true, failuresBeforeError: 3, events: false, reconcileSeconds: 86400 }
const taskConfig: TaskConfig = { pollSeconds: 300, pageSize: 100, maxPages: 20, failuresBeforeError: 3, events: false, reconcileSeconds: 86400 }
const calendarConfig: CalendarConfig = { pollSeconds: 300, horizonDays: 7, failuresBeforeError: 3, events: false, reconcileSeconds: 86400 }
const cli = (handler: (args: string[]) => string, primary: string | null = 'owner@example.com') =>
  vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) =>
    args[0] === 'auth' ? json({ identities: { user: { status: 'ready', openId: owner } } })
      : args.includes('user_mailboxes') && args.includes('profile')
        ? envelope(primary === null ? { not_found_reason: 'mailbox address not found' } : { primary_email_address: primary })
        : handler(args))

const mailDetail = (id: string, overrides: Record<string, unknown> = {}) => ({
  message_id: id, thread_id: `thread-${id}`, internal_date: '1794500000000', folder_id: 'INBOX', subject: 'Contract timing',
  head_from: { mail_address: 'alice@example.com', name: 'Alice' }, to: [{ mail_address: 'owner@example.com' }], cc: [],
  label_ids: ['UNREAD'], body_plain_text: 'Can we sign on Tuesday morning?', body_preview: 'Can we sign', security_level: {}, attachments: [],
  ...overrides,
})
const triage = (messages: { id: string; at: string; from?: string }[]) => ({
  messages: messages.map(message => ({ date: localStamp(message.at), folder: 'INBOX', from: message.from ?? 'Alice <alice@example.com>',
    labels: 'UNREAD', message_id: message.id, subject: 'Contract timing', thread_id: `thread-${message.id}` })),
  has_more: false,
})

it('collects one immutable mail message once and leaves later rounds with no new work', async () => {
  const h = workspace({ mail: { enabled: true, config: mailConfig }, feishu: { enabled: false, config: {} } },
    { mail: { allowed: [{ id: 'alice@example.com' }] } })
  const run = cli(args => args.includes('+triage') ? json(triage([{ id: 'm1', at: '2026-11-13T01:30:00Z' }])) : envelope(mailDetail('m1')))
  const at = clockAt('2026-11-13T02:00:00Z')
  expect(await scanMailRound(h.ctx.mail, binding, new AbortController().signal, at)).toContain('1 new')
  expect(h.received).toHaveLength(1)
  expect(h.received[0]).toMatchObject({ id: key('mail', 'feishu', 'm1'), source: 'mail', human: true,
    actor: { source: 'mail', id: 'alice@example.com' }, threads: [{ source: 'mail', id: 'feishu:thread-m1' }],
    meta: { account: 'feishu', folder: 'INBOX', messageId: 'm1', threadId: 'thread-m1' } })
  expect(h.received[0]!.addressed).toBeUndefined()
  const first = store.get(KV.workspace.mail('feishu', 'INBOX'))!
  expect(first).toMatchObject({ seen: ['m1'], pending: [] })
  await scanMailRound(h.ctx.mail, binding, new AbortController().signal, at)
  expect(h.received).toHaveLength(1)
  expect(run.mock.calls.filter(([, args]) => args.includes('+message'))).toHaveLength(1)
})

it('reports queued mail failures instead of a healthy round, then reads them once the source recovers', async () => {
  const h = workspace({ mail: { enabled: true, config: mailConfig } }, { mail: { allowed: [{ id: 'alice@example.com' }] } })
  let fail = true
  cli(args => {
    if (args.includes('+triage')) return json(triage([{ id: 'm1', at: '2026-11-13T01:30:00Z' }]))
    if (fail) throw new Error('Mailbox temporarily unavailable')
    return envelope(mailDetail('m1'))
  })
  const signal = new AbortController().signal
  await expect(scanMailRound(h.ctx.mail, binding, signal, clockAt('2026-11-13T02:00:00Z'))).rejects.toThrow('could not be read')
  expect(h.received).toEqual([])
  expect(store.get(KV.workspace.mail('feishu', 'INBOX'))?.pending).toEqual([{ id: 'm1', at: expect.any(String) }])
  fail = false
  expect(await scanMailRound(h.ctx.mail, binding, signal, clockAt('2026-11-13T02:01:00Z'))).toContain('1 new')
  expect(h.received).toHaveLength(1)
  expect(store.get(KV.workspace.mail('feishu', 'INBOX'))?.pending).toEqual([])
})

it('filters automated senders without letting them into the queue and reports the count', async () => {
  const h = workspace({ mail: { enabled: true, config: mailConfig } }, { mail: { allowed: [{ id: 'alice@example.com' }] } })
  cli(args => args.includes('+triage')
    ? json(triage([{ id: 'auto', at: '2026-11-13T01:30:00Z', from: 'no-reply@example.com' }, { id: 'm1', at: '2026-11-13T01:31:00Z' }]))
    : envelope(mailDetail('m1')))
  const detail = await scanMailRound(h.ctx.mail, binding, new AbortController().signal, clockAt('2026-11-13T02:00:00Z'))
  expect(detail).toContain('1 new, 1 filtered')
  expect(h.received.map(trigger => trigger.meta.messageId)).toEqual(['m1'])
})

it('binds mail scope and Policy rows to the configured account and folder', () => {
  const kind = createMailKind(binding)
  const enabled = { ...mailConfig, accounts: [{ id: 'feishu', mailbox: 'me', folders: 'INBOX, Important', enabled: 'on' as const }] }
  expect(foldersOf(enabled.accounts[0]!)).toEqual(['INBOX', 'IMPORTANT'])
  expect(kind.scope?.({ meta: { account: 'feishu', folder: 'INBOX' } }, enabled)).toMatchObject({ listened: true, observed: true, row: 'feishu:INBOX' })
  expect(kind.scope?.({ meta: { account: 'feishu', folder: 'TRASH' } }, enabled)).toMatchObject({ listened: false })
  expect(kind.policy?.rows?.(enabled).map(row => row.id)).toEqual(['feishu:INBOX', 'feishu:IMPORTANT'])
  expect(mailTime('2026-11-13 09:30')).toBe(new Date(2026, 10, 13, 9, 30).toISOString())
})

it('does not read mail before any account is configured', async () => {
  const h = workspace({ mail: { enabled: true, config: { ...mailConfig, accounts: [] } } })
  const run = vi.spyOn(Commands.prototype, 'run')
  await expect(scanMailRound(h.ctx.mail, binding, new AbortController().signal, clockAt('2026-11-13T02:00:00Z'))).rejects.toThrow('No enabled mailbox')
  expect(run).not.toHaveBeenCalled()
})

const taskItem = (overrides: Record<string, unknown> = {}) => ({ guid: 't1', summary: 'Prepare the demo', completed: false, status: 'todo',
  created_at: '1794400000000', updated_at: '1794400000000', members: [{ id: owner, role: 'assignee', type: 'user' }],
  creator: { id: 'ou_creator', type: 'user', name: 'Creator' }, url: 'https://applink.feishu.cn/client/todo/detail?guid=t1', ...overrides })
const taskPage = (items: unknown[]) => envelope({ items, has_more: false, page_token: '' })

it('records a task baseline silently and then emits only created or changed tasks', async () => {
  const h = workspace({ task: { enabled: true, config: taskConfig } }, { task: { allowed: [{ id: 'ou_creator' }] } })
  let items = [taskItem()]
  cli(args => args.includes('tasks') && args.includes('list') ? taskPage(items) : envelope(taskItem()))
  const signal = new AbortController().signal
  expect(await scanTaskRound(h.ctx.task, binding, signal, clockAt('2026-11-13T02:00:00Z'))).toContain('baseline')
  expect(h.received).toEqual([])
  expect(store.get(KV.workspace.task)?.baselineAt).toBeDefined()
  expect(await scanTaskRound(h.ctx.task, binding, signal, clockAt('2026-11-13T02:05:00Z'))).toContain('0 changed')
  items = [taskItem({ updated_at: '1794500000000', summary: 'Prepare the demo script' })]
  expect(await scanTaskRound(h.ctx.task, binding, signal, clockAt('2026-11-13T02:10:00Z'))).toContain('1 changed')
  expect(h.received).toHaveLength(1)
  expect(h.received[0]).toMatchObject({ source: 'task', human: true, actor: { source: 'task', id: 'ou_creator' },
    threads: [{ source: 'task', id: 't1' }], meta: { guid: 't1', summary: 'Prepare the demo script' } })
  expect(h.received[0]!.addressed).toBeUndefined()
  await scanTaskRound(h.ctx.task, binding, signal, clockAt('2026-11-13T02:15:00Z'))
  expect(h.received).toHaveLength(1)
})

it('reads event-selected tasks while idle event rounds make no API calls', async () => {
  const h = workspace({ task: { enabled: true, config: { ...taskConfig, events: true } } }, { task: { allowed: [{ id: 'ou_creator' }] } })
  let item = taskItem()
  const run = cli(args => args.includes('list') ? taskPage([item]) : envelope(item))
  const signal = new AbortController().signal
  await scanTaskRound(h.ctx.task, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  run.mockClear()
  await scanTaskRound(h.ctx.task, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  expect(run).not.toHaveBeenCalled()
  const event = { header: { event_id: 'event-1', event_type: 'task.task.update_user_access_v2', create_time: '1794500000000' },
    event: { task_guid: 't1', event_types: ['task_summary_update'] } }
  queueTaskEvent(h.ctx.task, binding, event)
  item = taskItem({ updated_at: '1794500000000', summary: 'Changed by an event' })
  await scanTaskRound(h.ctx.task, binding, signal, clockAt('2026-11-13T02:10:00Z'))
  expect(run.mock.calls.some(([, args]) => args.includes('list'))).toBe(false)
  expect(h.received).toMatchObject([{ meta: { guid: 't1', eventId: 'event-1', summary: 'Changed by an event' } }])
  queueTaskEvent(h.ctx.task, binding, event)
  await drainTaskEvents(h.ctx.task, binding, signal)
  expect(h.received).toHaveLength(1)
})

it('retains an event through failed intake and keeps a newer event arriving during a detail read', async () => {
  const h = workspace({ task: { enabled: true, config: { ...taskConfig, events: true } } }, { task: { allowed: [{ id: 'ou_creator' }] } })
  const event = (id: string) => ({ header: { event_id: id, event_type: 'task.task.update_user_access_v2', create_time: '1794500000000' },
    event: { task_guid: 't1', event_types: ['task_summary_update'] } })
  queueTaskEvent(h.ctx.task, binding, event('first'))
  let newer = true
  cli(() => { if (newer) { queueTaskEvent(h.ctx.task, binding, event('second')); newer = false }; return envelope(taskItem()) })
  h.receive.mockImplementationOnce(() => { throw new Error('Intake unavailable') })
  const signal = new AbortController().signal
  await expect(drainTaskEvents(h.ctx.task, binding, signal)).rejects.toThrow('Intake unavailable')
  expect(pendingLarkEvents(h.ctx.task, owner, 'task')).toHaveLength(2)
  await drainTaskEvents(h.ctx.task, binding, signal)
  expect(h.received.at(-1)).toMatchObject({ meta: { eventId: 'second' } })
  expect(pendingLarkEvents(h.ctx.task, owner, 'task')).toEqual([])
})

it('isolates an unreadable pending task so other events and due reconciliation still run', async () => {
  const h = workspace({ task: { enabled: true, config: { ...taskConfig, events: true, reconcileSeconds: 300 } } }, { task: { allowed: [{ id: 'ou_creator' }] } })
  let first = taskItem(), second = taskItem({ guid: 't2', summary: 'Second task' })
  let unreadable = true
  const run = cli(args => {
    if (args.includes('list')) return taskPage([first, second])
    const guid = args[args.indexOf('--task-guid') + 1]
    if (guid === 't1') {
      if (unreadable) throw new Error('Task access lost')
      return envelope(first)
    }
    return envelope(second)
  })
  const signal = new AbortController().signal
  await scanTaskRound(h.ctx.task, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  const event = (id: string, guid: string) => ({ header: { event_id: id, event_type: 'task.task.update_user_access_v2', create_time: '1794500000000' },
    event: { task_guid: guid, event_types: ['task_summary_update'] } })
  queueTaskEvent(h.ctx.task, binding, event('bad', 't1'))
  queueTaskEvent(h.ctx.task, binding, event('good', 't2'))
  second = taskItem({ guid: 't2', summary: 'Changed second task', updated_at: '1794500000000' })
  await expect(scanTaskRound(h.ctx.task, binding, signal, clockAt('2026-11-13T02:10:00Z'))).rejects.toThrow('retained for retry')
  expect(h.received.map(trigger => trigger.meta.guid)).toEqual(['t2'])
  expect(pendingLarkEvents(h.ctx.task, owner, 'task')).toHaveLength(1)
  expect(store.get(KV.workspace.task)?.reconciledAt).toBe('2026-11-13T02:10:00.000Z')
  expect(run.mock.calls.some(([, args]) => args.includes('list'))).toBe(true)
  unreadable = false
  first = taskItem({ updated_at: '1794600000000', summary: 'Changed first task' })
  await scanTaskRound(h.ctx.task, binding, signal, clockAt('2026-11-13T02:20:00Z'))
  expect(pendingLarkEvents(h.ctx.task, owner, 'task')).toEqual([])
  expect(h.received.map(trigger => trigger.meta.guid)).toEqual(['t2', 't1'])
})

const agendaEvent = (overrides: Record<string, unknown> = {}) => ({ event_id: 'e1', summary: 'Technical exchange',
  start_time: { datetime: '2026-11-14T08:00:00+08:00', timezone: 'Asia/Shanghai' },
  end_time: { datetime: '2026-11-14T09:00:00+08:00', timezone: 'Asia/Shanghai' },
  event_organizer: { user_id: 'ou_organizer', display_name: 'Organizer' }, self_rsvp_status: 'accept',
  app_link: 'https://applink.feishu.cn/client/calendar/event/detail?event_id=e1', ...overrides })

const notification = (eventType: string, eventId: string, payload: Record<string, unknown>): BridgeEvent => ({
  type: 'event', deliveryId: '00000000-0000-4000-8000-000000000001', eventType, eventId, at: '1794500000000', payload,
})

it('routes a notification only to the mailbox it names and leaves no primary-account retry', async () => {
  const accounts = [
    { id: 'primary', mailbox: 'me', folders: 'INBOX', enabled: 'on' as const },
    { id: 'second', mailbox: 'second@example.com', folders: 'INBOX', enabled: 'on' as const },
  ]
  const h = workspace({ mail: { enabled: true, config: { ...mailConfig, events: true, accounts } } },
    { mail: { allowed: [{ id: 'alice@example.com' }] } })
  const run = cli(args => {
    if (args.includes('+triage')) return json(triage([]))
    if (args[args.indexOf('--mailbox') + 1] === 'second@example.com') return envelope(mailDetail('foreign'))
    throw new CliError('failed to fetch email: user message not found', 1234034)
  })
  const signal = new AbortController().signal
  queueLarkEvent(h.ctx.mail, owner, 'mail', notification('mail.user_mailbox.event.message_received_v1', 'foreign-event',
    { mail_address: 'second@example.com', message_id: 'foreign' }))
  await scanMailRound(h.ctx.mail, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  expect(h.received.map(trigger => trigger.meta.account)).toEqual(['second'])
  expect(store.get(KV.workspace.mail('primary', 'INBOX'))?.pending ?? []).toEqual([])
  expect(pendingLarkEvents(h.ctx.mail, owner, 'mail')).toEqual([])
  const primaryReads = () => run.mock.calls.filter(([, args]) => args.includes('+message')
    && args[args.indexOf('--mailbox') + 1] === 'me' && args[args.indexOf('--message-id') + 1] === 'foreign')
  expect(primaryReads()).toEqual([])
  run.mockClear()
  expect(await scanMailRound(h.ctx.mail, binding, signal, clockAt('2026-11-13T02:05:00Z'))).toContain('0 new')
  expect(run).not.toHaveBeenCalled()
  expect(h.received).toHaveLength(1)
})

it('matches an explicit mailbox address without regard to case', async () => {
  const h = workspace({ mail: { enabled: true, config: { ...mailConfig, events: true,
    accounts: [{ id: 'explicit', mailbox: 'Owner@Example.com', folders: 'INBOX', enabled: 'on' }] } } })
  const run = cli(args => args.includes('+triage') ? json(triage([])) : envelope(mailDetail('cased')))
  queueLarkEvent(h.ctx.mail, owner, 'mail', notification('mail.user_mailbox.event.message_received_v1', 'cased-event',
    { mail_address: 'OWNER@example.COM', message_id: 'cased' }))
  await scanMailRound(h.ctx.mail, binding, new AbortController().signal, clockAt('2026-11-13T02:00:00Z'))
  expect(h.received.map(trigger => trigger.id)).toEqual([key('mail', 'explicit', 'cased')])
  expect(store.get(KV.workspace.mail('explicit', 'INBOX'))?.pending).toEqual([])
  expect(pendingLarkEvents(h.ctx.mail, owner, 'mail')).toEqual([])
  expect(run.mock.calls.some(([, args]) => args.includes('+message'))).toBe(true)
})

it('treats only the exact me alias as the verified primary mailbox', async () => {
  const h = workspace({ mail: { enabled: true, config: { ...mailConfig, events: true,
    accounts: [{ id: 'upper', mailbox: 'ME', folders: 'INBOX', enabled: 'on' }] } } })
  const calls: string[][] = []
  vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) => {
    calls.push(args)
    return args[0] === 'auth' ? json({ identities: { user: { status: 'ready', openId: owner } } })
      : args.includes('+triage') ? json(triage([])) : envelope(mailDetail('upper'))
  })
  queueLarkEvent(h.ctx.mail, owner, 'mail', notification('mail.user_mailbox.event.message_received_v1', 'upper-event',
    { mail_address: 'owner@example.com', message_id: 'upper' }))
  expect(await scanMailRound(h.ctx.mail, binding, new AbortController().signal, clockAt('2026-11-13T02:00:00Z'))).toContain('0 new')
  expect(calls.some(args => args.includes('user_mailboxes'))).toBe(false)
  expect(calls.some(args => args.includes('+message'))).toBe(false)
  expect(h.received).toEqual([])
  expect(pendingLarkEvents(h.ctx.mail, owner, 'mail')).toEqual([])
})

it('acknowledges a notification for no configured mailbox instead of queueing it forever', async () => {
  const h = workspace({ mail: { enabled: true, config: { ...mailConfig, events: true } } })
  const run = cli(args => args.includes('+triage') ? json(triage([])) : envelope(mailDetail('stranger')))
  queueLarkEvent(h.ctx.mail, owner, 'mail', notification('mail.user_mailbox.event.message_received_v1', 'stranger-event',
    { mail_address: 'stranger@example.com', message_id: 'stranger' }))
  expect(await scanMailRound(h.ctx.mail, binding, new AbortController().signal, clockAt('2026-11-13T02:00:00Z'))).toContain('0 new')
  expect(h.received).toEqual([])
  expect(pendingLarkEvents(h.ctx.mail, owner, 'mail')).toEqual([])
  expect(run.mock.calls.some(([, args]) => args.includes('+message'))).toBe(false)
})

it('does not treat an unresolved primary identity as a wildcard', async () => {
  const h = workspace({ mail: { enabled: true, config: { ...mailConfig, events: true } } })
  let primary: string | null = null
  const run = vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) =>
    args[0] === 'auth' ? json({ identities: { user: { status: 'ready', openId: owner } } })
      : args.includes('user_mailboxes') && args.includes('profile')
        ? envelope(primary === null ? { not_found_reason: 'mailbox address not found' } : { primary_email_address: primary })
        : args.includes('+triage') ? json(triage([])) : envelope(mailDetail('owner-mail')))
  const signal = new AbortController().signal
  queueLarkEvent(h.ctx.mail, owner, 'mail', notification('mail.user_mailbox.event.message_received_v1', 'owner-event',
    { mail_address: 'owner@example.com', message_id: 'owner-mail' }))
  await expect(scanMailRound(h.ctx.mail, binding, signal, clockAt('2026-11-13T02:00:00Z'))).rejects.toThrow('mailbox identity')
  expect(h.received).toEqual([])
  expect(pendingLarkEvents(h.ctx.mail, owner, 'mail')).toHaveLength(1)
  expect(store.get(KV.workspace.mail('feishu', 'INBOX'))?.pending ?? []).toEqual([])
  expect(run.mock.calls.some(([, args]) => args.includes('+message'))).toBe(false)
  primary = 'owner@example.com'
  expect(await scanMailRound(h.ctx.mail, binding, signal, clockAt('2026-11-13T02:05:00Z'))).toContain('1 new')
  expect(h.received.map(trigger => trigger.meta.messageId)).toEqual(['owner-mail'])
  expect(pendingLarkEvents(h.ctx.mail, owner, 'mail')).toEqual([])
})

it('keeps an event-backed pending message unread when identity resolution fails', async () => {
  const h = workspace({ mail: { enabled: true, config: { ...mailConfig, events: true } } })
  store.set(KV.workspace.mail('feishu', 'INBOX'), { since: '2026-11-13T02:00:00Z', seen: [],
    pending: [{ id: 'moved', at: '2026-11-13T01:00:00.000Z', mailbox: 'owner@example.com' }] })
  let primary: string | null = null
  const run = vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) =>
    args[0] === 'auth' ? json({ identities: { user: { status: 'ready', openId: owner } } })
      : args.includes('user_mailboxes') && args.includes('profile')
        ? envelope(primary === null ? { not_found_reason: 'mailbox address not found' } : { primary_email_address: primary })
        : args.includes('+triage') ? json(triage([])) : envelope(mailDetail('moved', { folder_id: 'TRASH' })))
  const signal = new AbortController().signal
  queueLarkEvent(h.ctx.mail, owner, 'mail', notification('mail.user_mailbox.event.message_received_v1', 'moved-event',
    { mail_address: 'owner@example.com', message_id: 'moved' }))
  await expect(scanMailRound(h.ctx.mail, binding, signal, clockAt('2026-11-13T02:10:00Z'))).rejects.toThrow('mailbox identity')
  expect(run.mock.calls.some(([, args]) => args.includes('+message'))).toBe(false)
  expect(store.get(KV.workspace.mail('feishu', 'INBOX'))?.pending).toMatchObject([{ id: 'moved' }])
  // Once the identity resolves, the moved message is rejected against its actual folder instead of being emitted as INBOX.
  primary = 'owner@example.com'
  await scanMailRound(h.ctx.mail, binding, signal, clockAt('2026-11-13T02:15:00Z'))
  expect(h.received).toEqual([])
  expect(store.get(KV.workspace.mail('feishu', 'INBOX'))?.pending).toEqual([])
  expect(pendingLarkEvents(h.ctx.mail, owner, 'mail')).toEqual([])
})

it('recovers a queued message when the verified primary identity changes', async () => {
  const h = workspace({ mail: { enabled: true, config: { ...mailConfig, events: true } } })
  let primary = 'first@example.com'
  const run = vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) => {
    if (args[0] === 'auth') return json({ identities: { user: { status: 'ready', openId: owner } } })
    if (args.includes('user_mailboxes') && args.includes('profile')) return envelope({ primary_email_address: primary })
    if (args.includes('+triage')) return json(triage([]))
    throw new Error('Detail temporarily unavailable')
  })
  const signal = new AbortController().signal
  queueLarkEvent(h.ctx.mail, owner, 'mail', notification('mail.user_mailbox.event.message_received_v1', 'switched-event',
    { mail_address: 'first@example.com', message_id: 'switched' }))
  await expect(scanMailRound(h.ctx.mail, binding, signal, clockAt('2026-11-13T02:00:00Z'))).rejects.toThrow('stay queued')
  expect(store.get(KV.workspace.mail('feishu', 'INBOX'))?.pending).toMatchObject([{ id: 'switched', mailbox: 'first@example.com' }])
  primary = 'second@example.com'
  run.mockClear()
  expect(await scanMailRound(h.ctx.mail, binding, signal, clockAt('2026-11-13T02:05:00Z'))).toContain('1 recovered')
  expect(run.mock.calls.some(([, args]) => args.includes('+message'))).toBe(false)
  expect(store.get(KV.workspace.mail('feishu', 'INBOX'))?.pending).toEqual([])
  expect(store.get(KV.workspace.mail('feishu', 'INBOX'))?.recovered)
    .toMatchObject([{ id: 'switched', mailbox: 'first@example.com', reason: 'mailbox_mismatch' }])
  expect(pendingLarkEvents(h.ctx.mail, owner, 'mail')).toEqual([])
})

it('replays a retained pending message after a restart exactly once', async () => {
  const h = workspace({ mail: { enabled: true, config: { ...mailConfig, events: true } } })
  let fail = true
  cli(args => {
    if (args.includes('+triage')) return json(triage([]))
    if (fail) throw new Error('Detail temporarily unavailable')
    return envelope(mailDetail('replay'))
  })
  queueLarkEvent(h.ctx.mail, owner, 'mail', notification('mail.user_mailbox.event.message_received_v1', 'replay-event',
    { mail_address: 'owner@example.com', message_id: 'replay' }))
  await expect(scanMailRound(h.ctx.mail, binding, new AbortController().signal, clockAt('2026-11-13T02:00:00Z'))).rejects.toThrow('stay queued')
  expect(store.get(KV.workspace.mail('feishu', 'INBOX'))?.pending).toMatchObject([{ id: 'replay' }])
  fail = false
  const restarted = host()
  const signal = new AbortController().signal
  await scanMailRound(restarted.ctx.mail, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  expect(restarted.received.map(trigger => trigger.meta.messageId)).toEqual(['replay'])
  expect(store.get(KV.workspace.mail('feishu', 'INBOX'))?.pending).toEqual([])
  await scanMailRound(restarted.ctx.mail, binding, signal, clockAt('2026-11-13T02:10:00Z'))
  expect(restarted.received).toHaveLength(1)
})

it('recovers a pending entry this mailbox cannot contain and keeps a transiently failed one', async () => {
  const h = workspace({ mail: { enabled: true, config: { ...mailConfig, events: true } } })
  const pending = [{ id: 'foreign', at: '2026-11-13T01:00:00.000Z' }, { id: 'legit', at: '2026-11-13T01:01:00.000Z' }]
  store.set(KV.workspace.mail('feishu', 'INBOX'), { since: '2026-11-13T02:00:00Z', seen: [], pending })
  cli(args => {
    if (args.includes('+triage')) return json(triage([]))
    if (args[args.indexOf('--message-id') + 1] === 'foreign') throw new CliError('failed to fetch email: user message not found', 1234034)
    throw new Error('Mailbox temporarily unavailable')
  })
  await expect(scanMailRound(h.ctx.mail, binding, new AbortController().signal, clockAt('2026-11-13T02:10:00Z')))
    .rejects.toThrow('stay queued')
  expect(h.received).toEqual([])
  const state = store.get(KV.workspace.mail('feishu', 'INBOX'))!
  expect(state.pending).toEqual([{ id: 'legit', at: '2026-11-13T01:01:00.000Z' }])
  expect(state.recovered).toMatchObject([{ id: 'foreign', reason: 'message_not_found', recoveredAt: '2026-11-13T02:10:00.000Z' }])
})

it('recovers a pending entry recorded for another mailbox without reading it', async () => {
  const h = workspace({ mail: { enabled: true, config: { ...mailConfig, events: true } } })
  store.set(KV.workspace.mail('feishu', 'INBOX'), { since: '2026-11-13T02:00:00Z', seen: [],
    pending: [{ id: 'foreign', at: '2026-11-13T01:00:00.000Z', mailbox: 'second@example.com' }] })
  const run = cli(args => args.includes('+triage') ? json(triage([])) : envelope(mailDetail('foreign')))
  queueLarkEvent(h.ctx.mail, owner, 'mail', notification('mail.user_mailbox.event.message_received_v1', 'foreign-event',
    { mail_address: 'second@example.com', message_id: 'foreign' }))
  expect(await scanMailRound(h.ctx.mail, binding, new AbortController().signal, clockAt('2026-11-13T02:10:00Z'))).toContain('1 recovered')
  expect(h.received).toEqual([])
  expect(run.mock.calls.some(([, args]) => args.includes('+message'))).toBe(false)
  expect(store.get(KV.workspace.mail('feishu', 'INBOX'))?.pending).toEqual([])
  expect(store.get(KV.workspace.mail('feishu', 'INBOX'))?.recovered)
    .toMatchObject([{ id: 'foreign', mailbox: 'second@example.com', reason: 'mailbox_mismatch' }])
  expect(pendingLarkEvents(h.ctx.mail, owner, 'mail')).toEqual([])
})

it('reads only event-selected mail and retains failed detail reads through the normal pending state', async () => {
  const h = workspace({ mail: { enabled: true, config: { ...mailConfig, events: true } } }, { mail: { allowed: [{ id: 'alice@example.com' }] } })
  let fail = false
  const run = cli(args => {
    if (args.includes('+triage')) return json(triage([]))
    if (fail) throw new Error('Detail temporarily unavailable')
    return envelope(mailDetail('event-mail'))
  })
  const signal = new AbortController().signal
  await scanMailRound(h.ctx.mail, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  run.mockClear()
  await scanMailRound(h.ctx.mail, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  expect(run).not.toHaveBeenCalled()
  const event = notification('mail.user_mailbox.event.message_received_v1', 'mail-event', { mail_address: 'owner@example.com', message_id: 'event-mail' })
  queueLarkEvent(h.ctx.mail, owner, 'mail', event)
  queueLarkEvent(h.ctx.mail, owner, 'mail', event)
  expect(pendingLarkEvents(h.ctx.mail, owner, 'mail')).toHaveLength(1)
  fail = true
  await expect(scanMailRound(h.ctx.mail, binding, signal, clockAt('2026-11-13T02:10:00Z'))).rejects.toThrow('stay queued')
  expect(pendingLarkEvents(h.ctx.mail, owner, 'mail')).toHaveLength(1)
  fail = false
  await scanMailRound(h.ctx.mail, binding, signal, clockAt('2026-11-13T02:10:00Z'))
  expect(run.mock.calls.some(([, args]) => args.includes('+triage'))).toBe(false)
  expect(h.received).toMatchObject([{ meta: { messageId: 'event-mail' } }])
  expect(pendingLarkEvents(h.ctx.mail, owner, 'mail')).toEqual([])
})

it('advances native calendar sync only after complete pages and emits explicit cancellation once', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  const event = { event_id: 'e1', summary: 'Technical exchange', status: 'confirmed',
    start_time: { timestamp: String(Date.parse('2026-11-14T00:00:00Z') / 1000) },
    end_time: { timestamp: String(Date.parse('2026-11-14T01:00:00Z') / 1000) },
    event_organizer: { user_id: 'ou_organizer' } }
  let response: unknown = { items: [event], has_more: false, sync_token: 'first-token' }, failPage = false
  const run = cli(args => {
    if (args.includes('/open-apis/calendar/v4/calendars/primary')) return envelope({ calendars: [{ calendar: { calendar_id: 'primary-calendar' } }] })
    if (failPage) {
      const params = JSON.parse(args[args.indexOf('--params') + 1]!)
      if (params.page_token) throw new Error('Second page unavailable')
      return envelope({ items: [], has_more: true, page_token: 'next-page' })
    }
    return envelope(response)
  })
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  expect(h.received).toEqual([])
  run.mockClear()
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  expect(run).not.toHaveBeenCalled()
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', notification('calendar.calendar.event.changed_v4', 'calendar-event', {
    calendar_id: 'primary-calendar', calendar_event_id: 'e1' }))
  failPage = true
  await expect(scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:10:00Z'))).rejects.toThrow('Second page unavailable')
  expect(store.get(KV.workspace.calendar)?.syncToken).toBe('first-token')
  expect(pendingLarkEvents(h.ctx.calendar, owner, 'calendar')).toHaveLength(1)
  failPage = false
  response = { items: [{ ...event, status: 'cancelled' }], has_more: false, sync_token: 'second-token' }
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:10:00Z'))
  expect(h.received).toMatchObject([{ meta: { eventId: 'e1', change: 'cancelled', calendarId: 'primary-calendar' } }])
  const query = run.mock.calls.find(([, args]) => args.includes('--params'))![1]
  const params = JSON.parse(query[query.indexOf('--params') + 1]!)
  expect(params).toMatchObject({ sync_token: 'first-token' })
  expect(params.start_time).toBeUndefined(); expect(params.end_time).toBeUndefined()
  expect(store.get(KV.workspace.calendar)?.syncToken).toBe('second-token')
  expect(pendingLarkEvents(h.ctx.calendar, owner, 'calendar')).toEqual([])
})

it('preserves changes when switching an existing polling baseline to native calendar sync', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } })
  store.set(KV.workspace.calendar, { baselineAt: '2026-11-13T01:00:00Z', events: {} })
  cli(args => args.some(arg => arg.endsWith('/calendars/primary'))
    ? envelope({ calendars: [{ calendar: { calendar_id: 'primary-calendar' } }] })
    : envelope({ items: [{ event_id: 'new-during-switch', status: 'confirmed',
      start_time: { timestamp: String(Date.parse('2026-11-14T00:00:00Z') / 1000) } },
      { event_id: 'historical', status: 'confirmed', start_time: { timestamp: String(Date.parse('2026-11-13T01:00:00Z') / 1000) } }], has_more: false, sync_token: 'native-token' }))
  await scanCalendarRound(h.ctx.calendar, binding, new AbortController().signal, clockAt('2026-11-13T02:00:00Z'))
  expect(h.received).toMatchObject([{ meta: { eventId: 'new-during-switch', change: 'scheduled' } }])
})

it('keeps a meeting link in the native calendar projection and reports a link-only change', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  const base = { event_id: 'e1', summary: 'Technical exchange', status: 'confirmed',
    start_time: { timestamp: String(Date.parse('2026-11-14T00:00:00Z') / 1000) },
    end_time: { timestamp: String(Date.parse('2026-11-14T01:00:00Z') / 1000) }, event_organizer: { user_id: 'ou_organizer' } }
  let link = 'https://vc.example/one', token = 0
  cli(args => args.some(arg => arg.endsWith('/calendars/primary'))
    ? envelope({ calendars: [{ calendar: { calendar_id: 'primary-calendar' } }] })
    : envelope({ items: [{ ...base, vchat: { meeting_url: link } }], has_more: false, sync_token: `token-${++token}` }))
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  link = 'https://vc.example/two'
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', notification('calendar.calendar.event.changed_v4', 'calendar-event', {
    calendar_id: 'primary-calendar', calendar_event_id: 'e1' }))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  expect(h.received).toHaveLength(1)
  expect(h.received[0]!.meta.change).toBe('updated')
  expect(h.received[0]!.text).toContain('Meeting: https://vc.example/two')
})

it('reports a known upcoming event that moves beyond the planning window', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  const when = (iso: string) => ({ timestamp: String(Date.parse(iso) / 1000) })
  let start = '2026-11-14T00:00:00Z', token = 0
  cli(args => args.some(arg => arg.endsWith('/calendars/primary'))
    ? envelope({ calendars: [{ calendar: { calendar_id: 'primary-calendar' } }] })
    : envelope({ items: [{ event_id: 'e1', summary: 'Technical exchange', status: 'confirmed',
      start_time: when(start), event_organizer: { user_id: 'ou_organizer' } }], has_more: false, sync_token: `token-${++token}` }))
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  start = '2026-11-25T00:00:00Z'
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', notification('calendar.calendar.event.changed_v4', 'calendar-event', {
    calendar_id: 'primary-calendar', calendar_event_id: 'e1' }))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  expect(h.received).toHaveLength(1)
  expect(h.received[0]).toMatchObject({ meta: { eventId: 'e1', change: 'updated', start: '2026-11-25T00:00:00.000Z', outsidePlanningWindow: true } })
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', notification('calendar.calendar.event.changed_v4', 'calendar-event', {
    calendar_id: 'primary-calendar', calendar_event_id: 'e1' }))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:10:00Z'))
  expect(h.received).toHaveLength(1)
})

it('retains an out-of-window cancellation tombstone without emitting actionable evidence', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } })
  let cancelled = false
  cli(args => args.some(arg => arg.endsWith('/calendars/primary'))
    ? envelope({ calendars: [{ calendar: { calendar_id: 'primary-calendar' } }] })
    : envelope({ items: [{ event_id: 'later', status: cancelled ? 'cancelled' : 'confirmed',
      ...!cancelled ? { start_time: { timestamp: String(Date.parse('2026-12-01T00:00:00Z') / 1000) } } : {} }], has_more: false, sync_token: cancelled ? 'after' : 'before' }))
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  cancelled = true
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', notification('calendar.calendar.event.changed_v4', 'later-cancelled', { calendar_id: 'primary-calendar', calendar_event_id: 'later' }))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  expect(h.received).toEqual([])
  expect(store.get(KV.workspace.calendar)).toMatchObject({ syncToken: 'after', events: { later: { cancelled: true } } })
  expect(pendingLarkEvents(h.ctx.calendar, owner, 'calendar')).toEqual([])
})

it('does not apply an older deletion after a newer task change', async () => {
  const h = workspace({ task: { enabled: true, config: { ...taskConfig, events: true } } })
  store.set(KV.workspace.task, { updated: { t1: 'new-version' }, eventsAt: { t1: '1794500001000' } })
  queueTaskEvent(h.ctx.task, binding, { header: { event_type: 'task.task.update_user_access_v2', event_id: 'late-delete', create_time: '1794500000000' },
    event: { task_guid: 't1', event_types: ['task_deleted'] } })
  cli(() => { throw new Error('Old notification needs no object read') })
  await drainTaskEvents(h.ctx.task, binding, new AbortController().signal)
  expect(h.received).toEqual([])
  expect(store.get(KV.workspace.task)?.updated?.t1).toBe('new-version')
  expect(pendingLarkEvents(h.ctx.task, owner, 'task')).toEqual([])
})

it('recovers an expired native calendar cursor once while retaining the history gap', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } })
  store.set(KV.workspace.calendar, { nativeCalendarId: 'primary-calendar', syncToken: 'expired' })
  const run = cli(args => {
    const params = JSON.parse(args[args.indexOf('--params') + 1]!)
    return params.sync_token ? json({ ok: false, identity: 'user', error: { code: 190008 } })
      : envelope({ items: [], has_more: false, sync_token: 'replacement' })
  })
  expect(await scanCalendarRound(h.ctx.calendar, binding, new AbortController().signal, clockAt('2026-11-13T02:00:00Z'))).toContain('gap retained')
  expect(run.mock.calls.filter(([, args]) => args.includes('--params'))).toHaveLength(2)
  expect(store.get(KV.workspace.calendar)).toMatchObject({ syncToken: 'replacement', syncGap: { reason: 'token_expired' } })
})

const seriesChange = (id: string) => notification('calendar.calendar.event.changed_v4', `series-${id}`,
  { calendar_id: 'primary-calendar', calendar_event_id: 'weekly_0' })

it('projects a recurring series into its planning window and reports one stable change', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  const master = seriesMaster('weekly_0', '2026-10-02T00:00:00Z')
  const occurrences = [occurrence('weekly_0', '2026-11-14T00:00:00Z'), occurrence('weekly_0', '2026-11-19T00:00:00Z')]
  let renamed = false
  const run = cli(args => {
    if (args.some(arg => arg.endsWith('/calendars/primary'))) return primaryCalendar
    if (args.some(arg => arg.endsWith('/events/instance_view'))) return envelope(instanceView(occurrences))
    return envelope(nativePage([renamed ? { ...master, summary: 'Weekly exchange (renamed)' } : master],
      renamed ? 'change-token' : 'baseline-token'))
  })
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  expect(h.received).toEqual([])
  expect(store.get(KV.workspace.calendar)?.events?.weekly_0).toMatchObject({ recurring: true,
    start: '2026-11-14T00:00:00.000Z', windowStarts: ['2026-11-14T00:00:00.000Z', '2026-11-19T00:00:00.000Z'] })
  renamed = true
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', seriesChange('change'))
  expect(await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))).toContain('recurring')
  expect(h.received).toHaveLength(1)
  expect(h.received[0]).toMatchObject({ source: 'calendar', human: true, threads: [{ source: 'calendar', id: 'weekly_0' }],
    meta: { eventId: 'weekly_0', change: 'updated', summary: 'Weekly exchange (renamed)', start: '2026-11-14T00:00:00.000Z', recurring: true } })
  expect(pendingLarkEvents(h.ctx.calendar, owner, 'calendar')).toEqual([])
  expect(run.mock.calls.filter(([, args]) => args.some(arg => arg.includes('instance_view')))).toHaveLength(2)
  // A restarted host replays the same notification without producing a second Trigger.
  const restarted = host()
  queueLarkEvent(restarted.ctx.calendar, owner, 'calendar', seriesChange('replay'))
  await scanCalendarRound(restarted.ctx.calendar, binding, signal, clockAt('2026-11-13T02:10:00Z'))
  expect(restarted.received).toEqual([])
  expect(store.get(KV.workspace.calendar)?.events?.weekly_0?.revision).toBe(2)
})

it('adopts a legacy series entry without replaying it, then reports its first real change', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  const master = seriesMaster('weekly_0', '2026-10-02T00:00:00Z')
  const legacy = CalendarEventSchema.parse({ ...master, start_time: { datetime: '2026-10-02T00:00:00.000Z' },
    end_time: { datetime: '2026-10-02T01:00:00.000Z' } })
  store.set(KV.workspace.calendar, { baselineAt: '2026-11-13T01:00:00Z', syncToken: 'legacy-token', events: {
    weekly_0: { version: eventVersion(legacy), start: '2026-10-02T00:00:00.000Z', summary: 'Weekly exchange',
      organizer: 'ou_organizer', revision: 1 } } })
  let renamed = false
  cli(args => {
    if (args.some(arg => arg.endsWith('/calendars/primary'))) return primaryCalendar
    if (args.some(arg => arg.endsWith('/events/instance_view'))) return envelope(instanceView([
      occurrence('weekly_0', '2026-11-14T00:00:00Z'), occurrence('weekly_0', '2026-11-19T00:00:00Z')]))
    return envelope(nativePage([renamed ? { ...master, summary: 'Weekly exchange (renamed)' } : master],
      renamed ? 'renamed-token' : 'unchanged-token'))
  })
  const signal = new AbortController().signal
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', seriesChange('legacy-unchanged'))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  expect(h.received).toEqual([])
  expect(store.get(KV.workspace.calendar)?.events?.weekly_0).toMatchObject({ recurring: true, revision: 1,
    windowStarts: ['2026-11-14T00:00:00.000Z', '2026-11-19T00:00:00.000Z'] })
  renamed = true
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', seriesChange('legacy-changed'))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  expect(h.received).toHaveLength(1)
  expect(h.received[0]).toMatchObject({ meta: { eventId: 'weekly_0', change: 'updated',
    summary: 'Weekly exchange (renamed)', start: '2026-11-14T00:00:00.000Z', revision: 2 } })
})

it('does not cancel on stored occurrence starts that have left the planning window', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  const master = seriesMaster('weekly_0', '2026-10-02T00:00:00Z')
  const occurrences = [occurrence('weekly_0', '2026-11-14T00:00:00Z'), occurrence('weekly_0', '2026-11-19T00:00:00Z')]
  let later = false
  cli(args => {
    if (args.some(arg => arg.endsWith('/calendars/primary'))) return primaryCalendar
    if (args.some(arg => arg.endsWith('/events/instance_view'))) return envelope(instanceView(later ? [] : occurrences))
    return envelope(nativePage([later ? nativeEvent('weekly_0', { status: 'cancelled' }) : master],
      later ? 'cancelled-token' : 'baseline-token'))
  })
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  expect(store.get(KV.workspace.calendar)?.events?.weekly_0).toMatchObject({ windowStarts: [
    '2026-11-14T00:00:00.000Z', '2026-11-19T00:00:00.000Z'] })
  later = true
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', seriesChange('stale-cancelled'))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-12-13T02:00:00Z'))
  expect(h.received).toEqual([])
  expect(store.get(KV.workspace.calendar)?.events?.weekly_0).toMatchObject({ cancelled: true })
  expect(pendingLarkEvents(h.ctx.calendar, owner, 'calendar')).toEqual([])
})

it('does not report a historical series title change as an outside-window update', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  const master = seriesMaster('weekly_0', '2026-10-02T00:00:00Z')
  const occurrences = [occurrence('weekly_0', '2026-11-14T00:00:00Z')]
  let later = false
  cli(args => {
    if (args.some(arg => arg.endsWith('/calendars/primary'))) return primaryCalendar
    if (args.some(arg => arg.endsWith('/events/instance_view'))) return envelope(instanceView(later ? [] : occurrences))
    return envelope(nativePage([later ? { ...master, summary: 'Weekly exchange (renamed)' } : master],
      later ? 'renamed-token' : 'baseline-token'))
  })
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  later = true
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', seriesChange('stale-renamed'))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-12-13T02:00:00Z'))
  expect(h.received).toEqual([])
  expect(store.get(KV.workspace.calendar)?.events?.weekly_0).toMatchObject({ windowStarts: [] })
  expect(pendingLarkEvents(h.ctx.calendar, owner, 'calendar')).toEqual([])
})

it('does not report clock-driven window movement as a series update', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  const master = seriesMaster('weekly_0', '2026-10-02T00:00:00Z')
  const first = occurrence('weekly_0', '2026-11-14T00:00:00Z'), second = occurrence('weekly_0', '2026-11-19T00:00:00Z')
  let later = false
  cli(args => {
    if (args.some(arg => arg.endsWith('/calendars/primary'))) return primaryCalendar
    if (args.some(arg => arg.endsWith('/events/instance_view'))) return envelope(instanceView(later ? [second] : [first, second]))
    return envelope(nativePage([master], later ? 'resume-token' : 'baseline-token'))
  })
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  expect(store.get(KV.workspace.calendar)?.events?.weekly_0).toMatchObject({ windowStarts: [
    '2026-11-14T00:00:00.000Z', '2026-11-19T00:00:00.000Z'] })
  // The clock passes the first occurrence; a token resync returns the unchanged master and the remaining occurrence.
  later = true
  requestLarkReconcile(h.ctx.calendar, owner, 'calendar')
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-15T02:00:00Z'))
  expect(h.received).toEqual([])
  expect(store.get(KV.workspace.calendar)?.events?.weekly_0).toMatchObject({ revision: 1,
    windowStarts: ['2026-11-19T00:00:00.000Z'] })
})

it('reports a series duration change masked by an exception at the front of the window', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  const master = seriesMaster('weekly_0', '2026-10-02T00:00:00Z')
  const exception = occurrence('weekly_0', '2026-11-14T00:00:00Z', { is_exception: true,
    end_time: timed('2026-11-14T00:30:00Z') })
  let extended = false
  cli(args => {
    if (args.some(arg => arg.endsWith('/calendars/primary'))) return primaryCalendar
    if (args.some(arg => arg.endsWith('/events/instance_view'))) return envelope(instanceView([exception,
      occurrence('weekly_0', '2026-11-19T00:00:00Z', {
        end_time: timed(extended ? '2026-11-19T02:00:00Z' : '2026-11-19T01:00:00Z') })]))
    return envelope(nativePage([extended ? { ...master, end_time: timed('2026-10-02T02:00:00Z') } : master],
      extended ? 'extended-token' : 'baseline-token'))
  })
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  extended = true
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', seriesChange('extended'))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  expect(h.received).toHaveLength(1)
  expect(h.received[0]).toMatchObject({ meta: { eventId: 'weekly_0', change: 'updated', revision: 2,
    start: '2026-11-14T00:00:00.000Z', end: '2026-11-14T00:30:00.000Z' } })
})

it('cancels a recurring series while it still has planning-window instances', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  const master = seriesMaster('weekly_0', '2026-10-02T00:00:00Z')
  const occurrences = [occurrence('weekly_0', '2026-11-14T00:00:00Z'), occurrence('weekly_0', '2026-11-19T00:00:00Z')]
  let cancelled = false
  cli(args => {
    if (args.some(arg => arg.endsWith('/calendars/primary'))) return primaryCalendar
    if (args.some(arg => arg.endsWith('/events/instance_view'))) return envelope(instanceView(cancelled
      ? occurrences.map(item => ({ ...item, status: 'cancelled' })) : occurrences))
    return envelope(nativePage([cancelled ? nativeEvent('weekly_0', { status: 'cancelled' }) : master],
      cancelled ? 'cancelled-token' : 'baseline-token'))
  })
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  cancelled = true
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', seriesChange('cancelled'))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  expect(h.received).toMatchObject([{ source: 'calendar', threads: [{ source: 'calendar', id: 'weekly_0' }],
    meta: { eventId: 'weekly_0', change: 'cancelled', start: '2026-11-14T00:00:00.000Z', revision: 2 } }])
  expect(store.get(KV.workspace.calendar)?.events?.weekly_0).toMatchObject({ cancelled: true, revision: 2 })
  expect(pendingLarkEvents(h.ctx.calendar, owner, 'calendar')).toEqual([])
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', seriesChange('cancelled-replay'))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:10:00Z'))
  expect(h.received).toHaveLength(1)
})

it('keeps a single-occurrence exception on its own stable identity when it moves and is cancelled', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  const exceptionId = occurrenceId('weekly_0', '2026-11-14T00:00:00Z')
  let phase: 'baseline' | 'moved' | 'cancelled' = 'baseline'
  cli(args => {
    if (args.some(arg => arg.endsWith('/calendars/primary'))) return primaryCalendar
    if (args.some(arg => arg.endsWith('/events/instance_view'))) return envelope(instanceView([occurrence('weekly_0', '2026-11-14T00:00:00Z')]))
    if (phase === 'moved') return envelope(nativePage([occurrence('weekly_0', '2026-11-14T00:00:00Z', { is_exception: true,
      summary: 'Weekly exchange (moved)', start_time: timed('2026-11-15T00:00:00Z'), end_time: timed('2026-11-15T01:00:00Z') })], 'moved-token'))
    if (phase === 'cancelled') return envelope(nativePage([nativeEvent(exceptionId, { status: 'cancelled', recurring_event_id: 'weekly_0' })], 'cancelled-token'))
    return envelope(nativePage([seriesMaster('weekly_0', '2026-10-02T00:00:00Z')], 'baseline-token'))
  })
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  phase = 'moved'
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', seriesChange('moved'))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  expect(h.received[0]).toMatchObject({ threads: [{ source: 'calendar', id: exceptionId }],
    meta: { eventId: exceptionId, change: 'scheduled', start: '2026-11-15T00:00:00.000Z', summary: 'Weekly exchange (moved)' } })
  phase = 'cancelled'
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', seriesChange('exception-cancelled'))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:10:00Z'))
  expect(h.received[1]).toMatchObject({ threads: [{ source: 'calendar', id: exceptionId }],
    meta: { eventId: exceptionId, change: 'cancelled', start: '2026-11-15T00:00:00.000Z' } })
})

it('resolves a cancelled recurring occurrence from the bounded instance view', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  const occurrenceIdValue = occurrenceId('weekly_0', '2026-11-14T00:00:00Z')
  let cancelled = false
  cli(args => {
    if (args.some(arg => arg.endsWith('/calendars/primary'))) return primaryCalendar
    if (args.some(arg => arg.endsWith('/events/instance_view'))) return envelope(instanceView([occurrence('weekly_0', '2026-11-14T00:00:00Z',
      cancelled ? { status: 'cancelled' } : {})]))
    return envelope(nativePage([cancelled
      ? nativeEvent(occurrenceIdValue, { status: 'cancelled', recurring_event_id: 'weekly_0' })
      : seriesMaster('weekly_0', '2026-10-02T00:00:00Z')], cancelled ? 'cancelled-token' : 'baseline-token'))
  })
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  cancelled = true
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', seriesChange('occurrence-cancelled'))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  expect(h.received).toMatchObject([{ threads: [{ source: 'calendar', id: occurrenceIdValue }],
    meta: { eventId: occurrenceIdValue, change: 'cancelled', start: '2026-11-14T00:00:00.000Z' } }])
  expect(store.get(KV.workspace.calendar)?.events?.[occurrenceIdValue]).toMatchObject({ cancelled: true })
  expect(pendingLarkEvents(h.ctx.calendar, owner, 'calendar')).toEqual([])
})

it('reports a recurring series leaving and re-entering the planning window', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  const master = seriesMaster('weekly_0', '2026-10-02T00:00:00Z')
  let phase: 'baseline' | 'out' | 'back' = 'baseline'
  cli(args => {
    if (args.some(arg => arg.endsWith('/calendars/primary'))) return primaryCalendar
    if (args.some(arg => arg.endsWith('/events/instance_view'))) return envelope(instanceView(phase === 'out'
      ? [] : [occurrence('weekly_0', '2026-11-14T00:00:00Z')]))
    if (phase === 'out') return envelope(nativePage([{ ...master, recurrence: 'FREQ=MONTHLY;INTERVAL=1' }], 'out-token'))
    if (phase === 'back') return envelope(nativePage([master], 'back-token'))
    return envelope(nativePage([master], 'baseline-token'))
  })
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  phase = 'out'
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', seriesChange('out'))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  expect(h.received[0]).toMatchObject({ meta: { eventId: 'weekly_0', change: 'updated',
    start: '2026-10-02T00:00:00.000Z', outsidePlanningWindow: true, revision: 2 } })
  expect(store.get(KV.workspace.calendar)?.events?.weekly_0).toMatchObject({ windowStarts: [] })
  phase = 'back'
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', seriesChange('back'))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:10:00Z'))
  expect(h.received[1]).toMatchObject({ meta: { eventId: 'weekly_0', change: 'updated',
    start: '2026-11-14T00:00:00.000Z', revision: 3 } })
  expect(h.received[1]!.meta.outsidePlanningWindow).toBeUndefined()
})

it('advances a historical recurring series without inventing window evidence', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  const master = seriesMaster('weekly_0', '2026-01-02T00:00:00Z')
  let renamed = false
  cli(args => {
    if (args.some(arg => arg.endsWith('/calendars/primary'))) return primaryCalendar
    if (args.some(arg => arg.endsWith('/events/instance_view'))) return envelope(instanceView([]))
    return envelope(nativePage([renamed ? { ...master, summary: 'Historical exchange (renamed)' } : master],
      renamed ? 'renamed-token' : 'baseline-token'))
  })
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  renamed = true
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', seriesChange('historical'))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  expect(h.received).toEqual([])
  expect(store.get(KV.workspace.calendar)?.syncToken).toBe('renamed-token')
  expect(pendingLarkEvents(h.ctx.calendar, owner, 'calendar')).toEqual([])
})

it('keeps all-day and zoned recurring occurrences in the planning-window projection', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  const allDayMaster = seriesMaster('allday_0', '2026-10-02T00:00:00Z', { summary: 'All-day series',
    start_time: allDay('2026-10-02', 'Asia/Shanghai'), end_time: allDay('2026-10-03', 'Asia/Shanghai') })
  const zonedMaster = seriesMaster('zoned_0', '2026-10-02T15:00:00Z', { summary: 'Zoned series',
    start_time: timed('2026-10-02T15:00:00Z', 'America/New_York'), end_time: timed('2026-10-02T16:00:00Z', 'America/New_York') })
  const allDayItem = occurrence('allday_0', '2026-11-14T00:00:00Z', { summary: 'All-day series',
    start_time: allDay('2026-11-14', 'Asia/Shanghai'), end_time: allDay('2026-11-15', 'Asia/Shanghai') })
  const zonedItem = occurrence('zoned_0', '2026-11-15T15:00:00Z', { summary: 'Zoned series',
    start_time: timed('2026-11-15T15:00:00Z', 'America/New_York'), end_time: timed('2026-11-15T16:00:00Z', 'America/New_York') })
  let changed = false
  cli(args => {
    if (args.some(arg => arg.endsWith('/calendars/primary'))) return primaryCalendar
    if (args.some(arg => arg.endsWith('/events/instance_view'))) return envelope(instanceView([allDayItem, zonedItem]))
    return envelope(nativePage(changed
      ? [{ ...allDayMaster, summary: 'All-day series (renamed)' }, { ...zonedMaster, summary: 'Zoned series (renamed)' }]
      : [allDayMaster, zonedMaster], changed ? 'changed-token' : 'baseline-token'))
  })
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  changed = true
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', notification('calendar.calendar.event.changed_v4', 'all-day-and-zoned',
    { calendar_id: 'primary-calendar', calendar_event_id: 'allday_0' }))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  const allDayStart = eventStart({ date: '2026-11-14' }), allDayEnd = eventStart({ date: '2026-11-15' })
  expect(h.received).toHaveLength(2)
  expect(h.received[0]).toMatchObject({ meta: { eventId: 'allday_0', change: 'updated',
    start: allDayStart, end: allDayEnd, summary: 'All-day series (renamed)', recurring: true } })
  expect(h.received[1]).toMatchObject({ meta: { eventId: 'zoned_0', change: 'updated',
    start: '2026-11-15T15:00:00.000Z', end: '2026-11-15T16:00:00.000Z', summary: 'Zoned series (renamed)', recurring: true } })
})

it('does not turn a plain historical event into a recurring series when it later moves into the window', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  const plain = (summary: string, start: string) => nativeEvent('plain_0', { summary, start_time: timed(start),
    end_time: timed(new Date(Date.parse(start) + 3_600_000).toISOString()), event_organizer: { user_id: 'ou_organizer' } })
  let phase: 'baseline' | 'renamed' | 'moved' = 'baseline'
  cli(args => {
    if (args.some(arg => arg.endsWith('/calendars/primary'))) return primaryCalendar
    if (args.some(arg => arg.endsWith('/events/instance_view'))) return envelope(instanceView([]))
    const item = phase === 'baseline' ? plain('Historical exchange', '2026-01-02T00:00:00Z')
      : phase === 'renamed' ? plain('Historical exchange (renamed)', '2026-01-02T00:00:00Z')
        : plain('Historical exchange (renamed)', '2026-11-14T00:00:00Z')
    return envelope(nativePage([item], phase === 'baseline' ? 'baseline-token' : phase === 'renamed' ? 'renamed-token' : 'moved-token'))
  })
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  phase = 'renamed'
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', seriesChange('plain-renamed'))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  expect(h.received).toEqual([])
  expect(store.get(KV.workspace.calendar)?.events?.plain_0?.recurring).toBeUndefined()
  phase = 'moved'
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', seriesChange('plain-moved'))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:10:00Z'))
  expect(h.received).toHaveLength(1)
  expect(h.received[0]).toMatchObject({ threads: [{ source: 'calendar', id: 'plain_0' }],
    meta: { eventId: 'plain_0', change: 'updated', start: '2026-11-14T00:00:00.000Z' } })
})

it('retains a recurring calendar notification when its planning window cannot be read', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true } } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  const master = seriesMaster('weekly_0', '2026-10-02T00:00:00Z')
  let renamed = false, failView = false
  cli(args => {
    if (args.some(arg => arg.endsWith('/calendars/primary'))) return primaryCalendar
    if (args.some(arg => arg.endsWith('/events/instance_view'))) {
      if (failView) throw new Error('Instance view unavailable')
      return envelope(instanceView([occurrence('weekly_0', '2026-11-14T00:00:00Z')]))
    }
    return envelope(nativePage([renamed ? { ...master, summary: 'Weekly exchange (renamed)' } : master],
      renamed ? 'change-token' : 'baseline-token'))
  })
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  renamed = true
  failView = true
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', seriesChange('retry'))
  await expect(scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))).rejects.toThrow('Instance view unavailable')
  expect(store.get(KV.workspace.calendar)?.syncToken).toBe('baseline-token')
  expect(pendingLarkEvents(h.ctx.calendar, owner, 'calendar')).toHaveLength(1)
  expect(h.received).toEqual([])
  failView = false
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:10:00Z'))
  expect(h.received).toHaveLength(1)
  expect(h.received[0]).toMatchObject({ meta: { eventId: 'weekly_0', summary: 'Weekly exchange (renamed)' } })
  expect(store.get(KV.workspace.calendar)?.syncToken).toBe('change-token')
  expect(pendingLarkEvents(h.ctx.calendar, owner, 'calendar')).toEqual([])
})

it('splits a bounded instance view that reports too many occurrences', async () => {
  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, events: true, horizonDays: 1 } } },
    { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  const master = seriesMaster('weekly_0', '2026-10-02T00:00:00Z')
  const instance = occurrence('weekly_0', '2026-11-14T00:00:00Z')
  const at = Date.parse('2026-11-14T00:00:00Z') / 1000
  let renamed = false, calls = 0
  cli(args => {
    if (args.some(arg => arg.endsWith('/calendars/primary'))) return primaryCalendar
    if (args.some(arg => arg.endsWith('/events/instance_view'))) {
      calls++
      const params = JSON.parse(args[args.indexOf('--params') + 1]!) as { start_time: string; end_time: string }
      const from = Number(params.start_time), to = Number(params.end_time)
      if (to - from > 6 * 3600) return json({ ok: false, identity: 'user', error: { code: 193104 } })
      return envelope(instanceView(from <= at && at < to ? [instance] : []))
    }
    return envelope(nativePage([renamed ? { ...master, summary: 'Weekly exchange (renamed)' } : master],
      renamed ? 'change-token' : 'baseline-token'))
  })
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  renamed = true
  queueLarkEvent(h.ctx.calendar, owner, 'calendar', seriesChange('split'))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  expect(h.received).toHaveLength(1)
  expect(h.received[0]).toMatchObject({ meta: { eventId: 'weekly_0', change: 'updated', start: '2026-11-14T00:00:00.000Z' } })
  expect(calls).toBeGreaterThan(3)
})


it('does not route an incoming mail notification to an unconfigured folder', async () => {
  const h = workspace({ mail: { enabled: true, config: { ...mailConfig, events: true } } })
  store.set(KV.workspace.mail('feishu', 'INBOX'), { since: '2026-11-13T02:00:00Z' })
  queueLarkEvent(h.ctx.mail, owner, 'mail', notification('mail.user_mailbox.event.message_received_v1', 'junk', { mail_address: 'owner@example.com', message_id: 'junk' }))
  cli(() => envelope(mailDetail('junk', { folder_id: 'SPAM' })))
  await scanMailRound(h.ctx.mail, binding, new AbortController().signal, clockAt('2026-11-13T02:10:00Z'))
  expect(h.received).toEqual([])
  expect(pendingLarkEvents(h.ctx.mail, owner, 'mail')).toEqual([])
})

it('records a calendar baseline, then reports scheduling, change and cancellation exactly once', async () => {
  const h = workspace({ calendar: { enabled: true, config: calendarConfig } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  let events = [agendaEvent()]
  cli(args => args.includes('+agenda') ? envelope(events) : envelope({}))
  const signal = new AbortController().signal
  expect(await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))).toContain('baseline')
  expect(h.received).toEqual([])
  events = [agendaEvent({ summary: 'Technical exchange (moved)', start_time: { datetime: '2026-11-14T09:00:00+08:00' },
    end_time: { datetime: '2026-11-14T10:00:00+08:00' } })]
  expect(await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))).toContain('1 changed')
  expect(h.received[0]).toMatchObject({ source: 'calendar', human: true, actor: { source: 'calendar', id: 'ou_organizer' },
    threads: [{ source: 'calendar', id: 'e1' }], meta: { eventId: 'e1', change: 'updated' } })
  expect(h.received[0]!.addressed).toBeUndefined()
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:10:00Z'))
  expect(h.received).toHaveLength(1)
  events = []
  expect(await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:15:00Z'))).toContain('1 changed')
  expect(h.received[1]).toMatchObject({ source: 'calendar', human: true, actor: { source: 'calendar', id: 'ou_organizer' }, meta: { eventId: 'e1', change: 'cancelled' } })
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:20:00Z'))
  expect(h.received).toHaveLength(2)
  expect(eventVersion(agendaEvent())).toBe(eventVersion(agendaEvent()))
  expect(taskKind(binding).scope?.({ meta: {} }, taskConfig)).toMatchObject({ listened: true, observed: true, row: 'my-tasks' })
  expect(calendarKind(binding).scope?.({ meta: {} }, calendarConfig)).toMatchObject({ listened: true, observed: true, row: 'primary' })
})

it.each(['task', 'mail', 'calendar'] as const)('catches up %s after reconnect and retains a newer in-flight recovery request', async kind => {
  const config = { task: taskConfig, mail: mailConfig, calendar: calendarConfig }[kind]
  const h = workspace({ [kind]: { enabled: true, config: { ...config, events: true } } })
  let duringRead = () => {}
  const run = cli(args => {
    duringRead()
    if (kind === 'task') return taskPage([])
    if (kind === 'mail') return json(triage([]))
    return args.some(arg => arg.endsWith('/calendars/primary'))
      ? envelope({ calendars: [{ calendar: { calendar_id: 'primary-calendar' } }] })
      : envelope({ items: [], has_more: false, sync_token: 'resume-token' })
  })
  const scan = { task: scanTaskRound, mail: scanMailRound, calendar: scanCalendarRound }[kind]
  const signal = new AbortController().signal, ctx = h.ctx[kind]
  await scan(ctx, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  run.mockClear()
  await scan(ctx, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  expect(run).not.toHaveBeenCalled()
  requestLarkReconcile(ctx, owner, kind)
  duringRead = () => { duringRead = () => {}; requestLarkReconcile(ctx, owner, kind) }
  await scan(ctx, binding, signal, clockAt('2026-11-13T02:10:00Z'))
  expect(run).toHaveBeenCalled()
  expect(larkReconcileToken(ctx, owner, kind)).toBe(2)
  await scan(ctx, binding, signal, clockAt('2026-11-13T02:11:00Z'))
  expect(larkReconcileToken(ctx, owner, kind)).toBeUndefined()
  run.mockClear()
  await scan(ctx, binding, signal, clockAt('2026-11-13T02:12:00Z'))
  expect(run).not.toHaveBeenCalled()
})

it('does not invent a change version where the calendar leaves it out', () => {
  expect(eventVersion(agendaEvent())).not.toBe(eventVersion(agendaEvent({ self_rsvp_status: 'decline' })))
})

it('keeps a message in the watermark minute when the overlap is zero', async () => {
  const h = workspace({ mail: { enabled: true, config: { ...mailConfig, overlapSeconds: 0 } } }, { mail: { allowed: [{ id: 'alice@example.com' }] } })
  store.set(KV.workspace.mail('feishu', 'INBOX'), { since: '2026-11-13T02:00:30.000Z', seen: [], pending: [] })
  cli(args => args.includes('+triage') ? json(triage([{ id: 'm1', at: '2026-11-13T02:00:00Z' }])) : envelope(mailDetail('m1')))
  expect(await scanMailRound(h.ctx.mail, binding, new AbortController().signal, clockAt('2026-11-13T02:01:00Z'))).toContain('1 new')
  expect(h.received).toHaveLength(1)
})

it('returns only the requested parent message in the mail thread body', async () => {
  const h = workspace({ mail: { enabled: true, config: mailConfig } }, { mail: { allowed: [{ id: 'alice@example.com' }] } })
  const messages = Array.from({ length: 25 }, (_, index) => mailDetail(`m${index + 1}`, { thread_id: 'thread-m25' }))
  cli(args => args.includes('+thread') ? envelope({ thread_id: 'thread-m25', messages }) : envelope(mailDetail('m25')))
  const trigger: Trigger = { id: 'mail-trigger', source: 'mail', threads: [{ source: 'mail', id: 'feishu:thread-m25' }],
    actor: { source: 'mail', id: 'alice@example.com' }, human: true, at: '2026-11-13T02:00:00Z', text: '',
    meta: { account: 'feishu', folder: 'INBOX', messageId: 'm25', threadId: 'thread-m25' } }
  const part = await createMailKind(binding).threadContext!.read(h.commands, trigger, 'parent', undefined, mailConfig)
  expect(part.messages.map(message => message.id)).toEqual(['m24'])
  expect((part.body.messages as { id: string }[]).map(message => message.id)).toEqual(['m24'])
})

it('distinguishes a calendar transition that returns to an earlier version', async () => {
  const h = workspace({ calendar: { enabled: true, config: calendarConfig } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  let events = [agendaEvent()]
  cli(args => args.includes('+agenda') ? envelope(events) : envelope({}))
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  events = [agendaEvent({ self_rsvp_status: 'decline' })]
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  events = [agendaEvent()]
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:10:00Z'))
  expect(h.received).toHaveLength(2)
  expect(new Set(h.received.map(trigger => trigger.id)).size).toBe(2)
})

it('keeps a cancellation tombstone across empty rounds and makes a delayed reappearance a new occurrence', async () => {
  const h = workspace({ calendar: { enabled: true, config: calendarConfig } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  let events: Record<string, unknown>[] = []
  cli(args => args.includes('+agenda') ? envelope(events) : envelope({}))
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  events = [agendaEvent()]
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  events = []
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:10:00Z'))
  // The tombstone must survive further empty rounds instead of being dropped with the previous state.
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:15:00Z'))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:20:00Z'))
  expect(h.received.map(trigger => [trigger.meta.change, trigger.meta.revision])).toEqual([['scheduled', 1], ['cancelled', 2]])
  expect(store.get(KV.workspace.calendar)?.events?.e1).toMatchObject({ revision: 2, cancelled: true })
  events = [agendaEvent()]
  expect(await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:25:00Z'))).toContain('1 changed')
  expect(h.received.map(trigger => [trigger.meta.change, trigger.meta.revision])).toEqual([['scheduled', 1], ['cancelled', 2], ['scheduled', 3]])
  expect(h.received[2]!.id).not.toBe(h.received[0]!.id)
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:30:00Z'))
  expect(h.received).toHaveLength(3)
})

it('keeps a cancellation tombstone across a restart and does not cancel twice', async () => {
  const h = workspace({ calendar: { enabled: true, config: calendarConfig } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  let events: Record<string, unknown>[] = []
  cli(args => args.includes('+agenda') ? envelope(events) : envelope({}))
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  events = [agendaEvent()]
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  const scheduledId = h.received[0]!.id
  events = []
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:10:00Z'))
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:15:00Z'))
  // A fresh host reads the persisted state again, as a restarted process would.
  const restarted = host()
  await scanCalendarRound(restarted.ctx.calendar, binding, signal, clockAt('2026-11-13T02:20:00Z'))
  expect(restarted.received).toEqual([])
  events = [agendaEvent()]
  expect(await scanCalendarRound(restarted.ctx.calendar, binding, signal, clockAt('2026-11-13T02:25:00Z'))).toContain('1 changed')
  expect(restarted.received.map(trigger => [trigger.meta.change, trigger.meta.revision])).toEqual([['scheduled', 3]])
  expect(restarted.received[0]!.id).not.toBe(scheduledId)
})

it('prunes a cancellation tombstone after its retention period', async () => {
  const h = workspace({ calendar: { enabled: true, config: calendarConfig } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  let events: Record<string, unknown>[] = []
  cli(args => args.includes('+agenda') ? envelope(events) : envelope({}))
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  events = [agendaEvent()]
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))
  events = []
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:10:00Z'))
  expect(store.get(KV.workspace.calendar)?.events?.e1).toMatchObject({ cancelled: true })
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-12-13T02:00:00Z'))
  expect(store.get(KV.workspace.calendar)?.events?.e1).toMatchObject({ cancelled: true })
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-12-15T02:00:00Z'))
  expect(store.get(KV.workspace.calendar)?.events?.e1).toBeUndefined()
  expect(h.received).toHaveLength(2)
})

it('cancels an upcoming event even with a one-day horizon', async () => {  const h = workspace({ calendar: { enabled: true, config: { ...calendarConfig, horizonDays: 1 } } }, { calendar: { allowed: [{ id: 'ou_organizer' }] } })
  let events = [agendaEvent({ start_time: { datetime: '2026-11-13T14:00:00+08:00' }, end_time: { datetime: '2026-11-13T15:00:00+08:00' } })]
  cli(args => args.includes('+agenda') ? envelope(events) : envelope({}))
  const signal = new AbortController().signal
  await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  events = []
  expect(await scanCalendarRound(h.ctx.calendar, binding, signal, clockAt('2026-11-13T02:05:00Z'))).toContain('1 changed')
  expect(h.received[0]).toMatchObject({ meta: { eventId: 'e1', change: 'cancelled' } })
})

it('retries the initial shared-event setup instead of ending the only transport', async () => {
  const report = vi.fn()
  let attempts = 0
  const result = await prepareSharedEventSetup(new AbortController().signal, async () => {
    attempts++
    if (attempts < 3) throw new Error('Temporary identity failure')
    return { task: 'retrying' }
  }, report, 1)
  expect(result).toEqual({ task: 'retrying' })
  expect(attempts).toBe(3)
  expect(report).toHaveBeenCalledTimes(2)
  expect(report.mock.calls[0]![1]).toContain('Personal event setup failed (Error)')
  expect(report.mock.calls[0]![1]).not.toContain('Temporary identity failure')
})

it('stops the shared-event setup retry when the Source stops', async () => {
  const controller = new AbortController(), report = vi.fn()
  const running = prepareSharedEventSetup(controller.signal, async () => { controller.abort(); throw new Error('Stopped') }, report, 1)
  await expect(running).resolves.toEqual({})
  expect(report).not.toHaveBeenCalled()
})

it('honours the native done status in task context and refuses to mark versions while the Source is off', async () => {
  const h = workspace({ task: { enabled: true, config: taskConfig } }, { task: { allowed: [{ id: 'ou_creator' }] } })
  let items = [taskItem()]
  let disabled = false
  cli(args => {
    if (args.includes('tasks') && args.includes('list')) {
      if (disabled) store.saveSettings({ ...store.settings(), sources: { ...store.settings().sources, task: { enabled: false, config: taskConfig } } })
      return taskPage(items)
    }
    return envelope(taskItem({ status: 'done', completed: false }))
  })
  const signal = new AbortController().signal
  await scanTaskRound(h.ctx.task, binding, signal, clockAt('2026-11-13T02:00:00Z'))
  const trigger: Trigger = { id: 'task-trigger', source: 'task', threads: [{ source: 'task', id: 't1' }],
    actor: { source: 'task', id: 'ou_creator' }, human: true, at: '2026-11-13T02:00:00Z', text: '', meta: { guid: 't1' } }
  const part = await taskKind(binding).threadContext!.read(h.commands, trigger, 'thread', undefined, taskConfig)
  expect(part.messages[0]!.text).toContain('Completed')
  disabled = true
  items = [taskItem({ updated_at: '1794700000000' })]
  await expect(scanTaskRound(h.ctx.task, binding, signal, clockAt('2026-11-13T02:05:00Z'))).rejects.toThrow('configuration changed')
  expect(h.received).toEqual([])
  expect(store.get(KV.workspace.task)?.updated?.t1).toBe('1794400000000')
})

