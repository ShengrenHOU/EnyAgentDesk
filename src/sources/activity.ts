/** Configured read-only collection, independent of individual business Tickets. */
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, liveTicket, threadKey, type Ticket, type Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import type { Commands } from '../infra/commands.ts'
import { sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { ownerDiscussionChannel, type WorkbenchConfig } from './workbench.ts'
import type { ActivityBindings, ActivityEvent, ActivityProvider, ActivityRange, ActivityReaderContext, ActivityScan, ActivityTools } from './activity-types.ts'
import { scanLarkMessages, scanLarkDocuments, readLarkActivityContext, readLarkImContext, readLarkWindow, resolveLarkConversation } from './activity-lark.ts'
import { scanWechatActivity, readWechatActivityContext, readWechatImContext, readWechatWindow, waitWechatChange } from './activity-wechat.ts'
import { imDedupKey, imMessageId, imObjectId } from './im-identity.ts'
import { documentEventChanges } from './document-events.ts'
import { pendingLarkEvents, larkReconcileToken, finishLarkReconcile } from './lark-event-inbox.ts'

export const SOURCE = 'activity'
const PROVIDERS = ['feishu-messages', 'feishu-documents', 'wechat'] as const
export const ActivityConfigSchema = z.object({
  ticketId: z.string().trim().max(200).default(''),
  collectionId: z.string().trim().max(200).default(''),
  routing: z.enum(['monitor', 'tasks']).default('monitor'),
  activationId: z.string().trim().max(128).default(''),
  feishuMessages: z.boolean().default(true),
  feishuDocuments: z.boolean().default(true),
  wechat: z.boolean().default(true),
  alertChatId: z.string().trim().regex(/^$|^oc_[a-zA-Z0-9]+$/).default(''),
  alertSeverities: z.string().trim().max(200).default('警告,严重,恢复'),
  lookbackHours: z.number().int().min(1).max(168).default(24),
  pollSeconds: z.number().int().min(30).max(3600).default(120),
  wechatPollSeconds: z.number().int().min(30).max(3600).optional(),
  wechatNotifications: z.boolean().default(false),
  documentEvents: z.boolean().default(false),
  watchedDocuments: z.array(z.object({ token: z.string().min(1), type: z.enum(['docx', 'sheet', 'bitable', 'file', 'slides']),
    url: z.url(), name: z.string().optional() }).strict()).max(200).default([]),
  documentReconcileSeconds: z.number().int().min(300).max(86400).default(86400),
  overlapSeconds: z.number().int().min(0).max(3600).default(120),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
}).strict()
export type ActivityConfig = z.infer<typeof ActivityConfigSchema>
/** Comma-separated severity labels; an empty list disables alert-card filtering. */
const parseAlertSeverities = (config: ActivityConfig) => config.alertSeverities.split(/[,，、\s]+/).map(value => value.trim()).filter(Boolean)
export interface ActivitySourceBindings extends ActivityBindings { ownerChatId: string }

export interface ActivityProgress {
  since?: string
  pending?: ActivityRange
  lastSuccess?: string
  nextAt?: string
  failures: number
  firstFailure?: string
  alerted?: boolean
  objects?: number
  records?: number
  changes?: number
  partial?: number
  skipped?: number
  error?: string
}
export const activityState = {
  wechatWake: family<{ token: string; at: string }, [collection: string, activation: string]>('activity-wechat-wake:'),
  bound: family<{ at: string; owner: string }, [ticket: string, activation: string]>('activity-bound:'),
  progress: family<ActivityProgress, [collection: string, activation: string, provider: ActivityProvider]>('activity-progress:'),
}
// Keep the former namespace on upgrade so watermarks, event IDs and WeChat acknowledgements survive.
const collection = (config: ActivityConfig) => config.collectionId || config.ticketId || SOURCE
const activation = (config: ActivityConfig) => config.activationId || collection(config)
const monitorRef = (config: ActivityConfig) => ({ source: SOURCE, id: `monitor:${config.ticketId}:${activation(config)}` })
const enabled = (config: ActivityConfig, provider: ActivityProvider): boolean =>
  provider === 'feishu-messages' ? config.feishuMessages : provider === 'feishu-documents' ? config.feishuDocuments : config.wechat
const healthName = (provider: ActivityProvider) => `${SOURCE}:${provider}`

/** A changed source configuration suspends collection without consuming its pending batch. */
export class ActivityHeld extends Error {}

function target(ctx: SourceContext, config: ActivityConfig, bindings: ActivitySourceBindings, signature: string, signal: AbortSignal): Ticket | undefined {
  if (signal.aborted) throw new ActivityHeld('Activity Source stopped')
  const current = ctx.config<ActivityConfig>(SOURCE)
  if (!current || JSON.stringify(current) !== signature) throw new ActivityHeld('Activity Source disabled or configuration changed')
  if (!bindings.lark.expectedUserId) throw new ActivityHeld('Configure the owner reader identity')
  if (config.routing === 'tasks') {
    if (!ownerDiscussionChannel(ctx)) throw new ActivityHeld('Choose a private owner destination for individual matters')
    return
  }
  if (!config.ticketId) throw new ActivityHeld('Choose an owner-authorized monitoring ticket and private destination')
  const ticket = ctx.tickets.get(config.ticketId)
  if (!ticket || !liveTicket(ticket)) throw new ActivityHeld('Monitoring ticket ended or is unavailable')
  if (ticket.paused) throw new ActivityHeld('Monitoring ticket is paused')
  const nativeOwner = ctx.config<WorkbenchConfig>('workbench')?.ownerId
  const native = ticket.mandate.actor.source === 'workbench' && !!nativeOwner && ticket.mandate.actor.id === nativeOwner
  const feishu = ticket.mandate.actor.source === 'feishu' && ticket.mandate.actor.id === bindings.lark.expectedUserId
  if (ticket.mandate.strength !== 'explicit' || (!native && !feishu)) {
    throw new ActivityHeld('Monitoring ticket does not belong to the configured owner')
  }
  const origin = ctx.triggers.get(ticket.origin.triggerId)
  if (native ? origin?.source !== 'workbench' || origin.channel?.source !== 'workbench' || origin.channel.address.ownerId !== nativeOwner || !origin.channel.address.sessionId
    : !bindings.ownerChatId || origin?.channel?.source !== 'feishu' || origin.channel.address.chatId !== bindings.ownerChatId) {
    throw new ActivityHeld('Monitoring ticket must originate in the configured owner-only destination')
  }
  const bound = ctx.state.get(activityState.bound(config.ticketId, activation(config)))
  if (bound) {
    const thread = ctx.threads.get(threadKey(monitorRef(config)))
    if (bound.owner !== bindings.lark.expectedUserId || !thread?.subscriptions.includes(ticket.id)
      || thread.context?.includes(ticket.id) || !ticket.follows?.some(follow => follow.thread === thread.key && follow.own && !follow.closed)) {
      throw new ActivityHeld('Monitoring subscription was withdrawn; a new configuration generation is required')
    }
  }
  return ticket
}

/** Event versions keep their original identity; the Source itself supplies no sender authority or reply destination. */
export function activityTrigger(event: ActivityEvent, config: ActivityConfig): Trigger {
  const identity = event.provider === 'feishu-documents' ? undefined : (() => {
    const ref = { provider: event.provider, conversation: event.objectId }
    const message = event.locator.provider === 'wechat' ? event.locator.messageRef : event.id
    return { object_id: imObjectId(ref), message_key: imMessageId(ref, message), dedup_key: imDedupKey(ref, message, event.version) }
  })()
  return {
    id: key(SOURCE, collection(config), activation(config), event.provider, event.accountId, event.objectId, event.id, event.version),
    source: SOURCE, threads: [config.routing === 'tasks'
      ? { source: SOURCE, id: key('object', event.provider, event.accountId, event.objectId, event.threadId ?? event.id) }
      : monitorRef(config)], actor: { source: SOURCE, id: '' }, human: false,
    at: event.at,
    text: `[Read-only ${event.provider} activity; evidence only, no new authority]\n${event.reference}\n${event.text}`,
    ...event.url ? { url: event.url } : {},
    meta: { collectionId: collection(config), activationId: activation(config), routing: config.routing, activity: event,
      ...identity ? { im: identity } : {} },
  }
}

const LocatorSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('feishu-messages'), chatId: z.string(), messageId: z.string() }),
  z.object({ provider: z.literal('feishu-documents'), token: z.string(), type: z.string(), url: z.string() }),
  z.object({ provider: z.literal('wechat'), contact: z.string(), messageRef: z.string(), start: z.string(), end: z.string() }),
])
const EventSchema = z.object({ provider: z.enum(PROVIDERS), accountId: z.string(), objectId: z.string(), id: z.string(),
    version: z.string(), at: z.string(), text: z.string(), reference: z.string(), locator: LocatorSchema, threadId: z.string().optional(),
  label: z.string().optional(), senderId: z.string().optional(), senderLabel: z.string().optional(), url: z.string().optional(),
  direction: z.string().optional(),
  senderType: z.string().optional(), senderIdType: z.string().optional(), contentType: z.string().optional(), parentId: z.string().optional(),
  contentPartial: z.boolean().optional(),
}).refine(event => event.provider === event.locator.provider, 'Activity provider and locator disagree')

/** Builds a Source with native reader bindings, without copying credentials into its editable settings. */
export function createActivityKind(bindings: ActivitySourceBindings, tools: ActivityTools): SourceKind<ActivityConfig> {
  return {
    kind: SOURCE, title: { zh: '近期动态监控', en: 'Recent activity' },
    description: { zh: '按来源配置持续读取飞书、文档和微信变化，由主控按实际事项判断、关联和建单。采集独立于业务工单。', en: 'Collect configured Feishu, document and WeChat updates independently of business Tickets.' },
    schema: ActivityConfigSchema,
    fields: [
      { key: 'collectionId', type: 'text', label: { zh: '采集流标识', en: 'Collection identifier' }, advanced: true },
      { key: 'ticketId', type: 'text', label: { zh: '旧版监控工单（仅旧版路由使用）', en: 'Legacy monitoring ticket' }, advanced: true },
      { key: 'routing', type: 'select', label: { zh: '动态处理方式', en: 'Activity routing' }, options: [
        { value: 'monitor', label: { zh: '交给监控工单', en: 'Monitoring ticket' } },
        { value: 'tasks', label: { zh: '按实际事项判断与分流', en: 'Route individual matters' } },
      ] },
      { key: 'activationId', type: 'text', label: { zh: '采集配置代次', en: 'Activation identifier' },
        hint: { zh: '保持稳定以续接现有进度。旧版监控路由取消订阅后，明确使用新代次才重新绑定。', en: 'Keep stable to retain collection progress. Legacy withdrawn subscriptions require an explicitly new generation.' }, advanced: true },
      { key: 'feishuMessages', type: 'switch', label: { zh: '近期飞书会话与群聊', en: 'Recent Feishu messages' } },
      { key: 'feishuDocuments', type: 'switch', label: { zh: '近期云文档', en: 'Recent documents' } },
      { key: 'wechat', type: 'switch', label: { zh: '本机微信近期会话', en: 'Recent local WeChat' } },
      { key: 'alertChatId', type: 'text', pattern: '^$|^oc_[a-zA-Z0-9]+$', label: { zh: '告警群', en: 'Alert chat' },
        hint: { zh: '飞书群 ID（oc_…）。该群内机器人卡片只在标题包含下列级别时采集；留空不过滤。', en: 'Feishu chat ID (oc_…). Bot cards in this chat are collected only when their title names a listed severity; empty disables the filter.' }, advanced: true },
      { key: 'alertSeverities', type: 'text', label: { zh: '保留的告警级别', en: 'Alert severities kept' },
        hint: { zh: '逗号分隔，默认 警告,严重,恢复。不含这些级别的进展卡片（如 成功、运行中）不进入采集与分诊。', en: 'Comma-separated; default 警告,严重,恢复. Progress cards naming none of these (for example success or running) are not collected.' }, advanced: true },
      { key: 'lookbackHours', type: 'number', min: 1, max: 168, label: { zh: '首次回看小时数', en: 'Initial lookback hours' }, advanced: true },
      { key: 'pollSeconds', type: 'number', min: 30, max: 3600, label: { zh: '扫描间隔／秒', en: 'Scan interval / seconds' }, advanced: true },
      { key: 'wechatPollSeconds', type: 'number', min: 30, max: 3600, label: { zh: '微信独立扫描间隔／秒', en: 'WeChat scan interval / seconds' }, advanced: true },
      { key: 'wechatNotifications', type: 'switch', label: { zh: '微信数据库变化唤醒', en: 'Wake on WeChat database changes' } },
      { key: 'documentEvents', type: 'switch', label: { zh: '重要文档按事件读取', en: 'Read important documents on events' } },
      { key: 'watchedDocuments', type: 'rows', label: { zh: '关注文档', en: 'Watched documents' }, columns: [
        { key: 'token', type: 'text', label: { zh: '对象 token', en: 'Object token' } },
        { key: 'type', type: 'text', label: { zh: '类型', en: 'Type' } },
        { key: 'url', type: 'text', label: { zh: '链接', en: 'URL' } },
        { key: 'name', type: 'text', optional: true, label: { zh: '名称', en: 'Name' } }] },
      { key: 'overlapSeconds', type: 'number', min: 0, max: 3600, label: { zh: '重叠读取／秒', en: 'Read overlap / seconds' }, advanced: true },
      { key: 'failuresBeforeError', type: 'number', min: 1, max: 20, label: { zh: '连续失败告警次数', en: 'Failures before alert' }, advanced: true },
    ],
    health: [SOURCE, 'activity:events', 'activity:wechat-events', ...PROVIDERS.map(healthName)],
    scope: ({ meta }, config) => (meta.collectionId ?? meta.monitorTicketId) === collection(config) && meta.activationId === activation(config)
      ? { listened: true, observed: config.routing === 'tasks' && meta.routing === 'tasks', ...config.routing === 'tasks' ? { row: 'updates' } : {} }
      : { listened: false, reason: 'activity_monitor_changed' },
    policy: { schema: z.object({ allowed: z.array(z.object({ id: z.string() })).default([]) }).strict(), fields: [],
      explicit: { zh: '采集动态只提供证据，由本人启用的规则决定是否建立事项。', en: 'Collected activity is evidence; owner-enabled rules decide whether work is admitted.' },
      rows: config => [{ id: 'updates', label: { zh: '近期动态', en: 'Recent activity' },
        note: { zh: config.routing === 'tasks' ? '逐事项判断' : '监控工单', en: config.routing === 'tasks' ? 'Individual matters' : 'Monitoring ticket' },
        cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true } }],
    },
    guardOutbound: async (commands, message) => {
      if (bindings.ownerChatId && message.channel.source === 'feishu' && message.channel.address.chatId === bindings.ownerChatId) {
        await assertOwnerAudience(commands, bindings)
      }
    },
    imEvidence: (trigger, config) => {
      const event = EventSchema.parse(trigger.meta.activity)
      if (!enabled(config, event.provider) || event.provider === 'feishu-documents') return undefined
      if (event.provider === 'feishu-messages' && event.accountId !== bindings.lark.expectedUserId) return undefined
      return { provider: event.provider, account: event.accountId, conversation: event.objectId,
        message: event.locator.provider === 'wechat' ? event.locator.messageRef : event.id, version: event.version,
        ...(event.senderId ? { sender: event.senderId } : {}), partial: event.contentPartial ?? false,
        ...(event.direction !== undefined ? { direction: event.direction } : {}),
        ...(event.threadId && event.threadId !== event.id ? { root: event.threadId } : {}) }
    },
    imHeader: trigger => {
      const event = EventSchema.parse(trigger.meta.activity)
      return { at: event.at,
        ...(event.label ? { conversationLabel: event.label } : {}),
        ...(event.senderLabel ? { senderLabel: event.senderLabel } : {}),
        ...(event.senderType ? { senderType: event.senderType } : {}),
        ...(event.senderIdType ? { senderIdType: event.senderIdType } : {}),
        ...(event.contentType ? { contentType: event.contentType } : {}),
        ...(event.parentId ? { parent: event.parentId } : {}),
        ...(event.url ? { url: event.url } : {}) }
    },
    imAnchorText: trigger => EventSchema.parse(trigger.meta.activity).text,
    imContext: async (commands, request, cursor, config, signal) => {
      if (request.anchor.provider === 'wechat' && enabled(config, 'wechat')) {
        return readWechatImContext(tools, bindings.wechat, request, cursor, signal)
      }
      if (request.anchor.provider === 'feishu-messages' && enabled(config, 'feishu-messages')) {
        return readLarkImContext(commands, bindings.lark, request, cursor, signal)
      }
      throw new Error('This IM context reader is disabled or unsupported')
    },
    imRead: {
      providers: ['feishu-messages', 'wechat'],
      async read(commands, request, cursor, config, signal) {
        if (request.provider === 'wechat' && enabled(config, 'wechat')) {
          return readWechatWindow(tools, bindings.wechat, request, cursor, signal)
        }
        if (request.provider === 'feishu-messages' && enabled(config, 'feishu-messages')) {
          const found = await resolveLarkConversation(commands, bindings.lark, request.conversation, signal)
          if (!('resolved' in found)) {
            return { provider: 'feishu-messages', account: bindings.lark.expectedUserId, conversation: request.conversation,
              start: request.start, end: request.end, messages: [], candidates: found.candidates,
              consistency: 'live_paginated', gaps: [found.candidates.length ? 'conversation_ambiguous' : 'conversation_not_found'] }
          }
          return readLarkWindow(commands, bindings.lark, { ...request, conversation: found.resolved.id }, cursor, signal,
            found.resolved, found.resolution)
        }
        throw new Error('This IM reader is disabled or unsupported')
      },
    },
    threadContext: {
      messageId: trigger => {
        const { locator } = EventSchema.parse(trigger.meta.activity)
        return locator.provider === 'wechat' ? locator.messageRef : locator.provider === 'feishu-messages' ? locator.messageId : locator.token
      },
      async read(commands, trigger, part, cursor, config) {
        const event = EventSchema.parse(trigger.meta.activity)
        if (!enabled(config, event.provider)) throw new Error('This activity reader is disabled')
        return event.provider === 'wechat'
          ? readWechatActivityContext(tools, bindings.wechat, commands, event, part, cursor)
          : readLarkActivityContext(commands, bindings.lark, event, part, cursor)
      },
    },
  }
}

const MembersSchema = z.object({ users: z.array(z.object({ member_id: z.string() })),
  bots: z.array(z.object({ member_id: z.string(), app_id: z.string().optional() })),
  has_more: z.boolean(), truncations: z.array(z.unknown()).default([]),
  user_total: z.number().optional(), bot_total: z.number().optional(),
})

/** Check the complete current audience with the bot identity, independently of user-reader credentials. */
export async function assertOwnerAudience(commands: Commands, bindings: ActivitySourceBindings): Promise<void> {
  const bot = commands.deployment.feishu
  if (!bindings.ownerChatId || !bindings.lark.expectedUserId || !bot) throw new ActivityHeld('Owner-only destination is not configured')
  const members = MembersSchema.parse(await commands.lark(['im', '+chat-members-list', '--chat-id', bindings.ownerChatId,
    '--member-types', 'user,bot', '--page-all', '--page-limit', '0']))
  const currentBot = members.bots[0]
  if (members.has_more || members.truncations.length || members.users.length !== 1 || members.bots.length !== 1
    || members.users[0]?.member_id !== bindings.lark.expectedUserId
    || (members.user_total !== undefined && members.user_total !== 1) || (members.bot_total !== undefined && members.bot_total !== 1)
    || !currentBot || !(currentBot.member_id === bot.botId || currentBot.member_id === bot.appId || currentBot.app_id === bot.appId)) {
    throw new ActivityHeld('Owner control chat audience changed or its membership could not be fully verified')
  }
}

function providerHealth(ctx: SourceContext, provider: ActivityProvider, progress: ActivityProgress, state: 'ready' | 'error'): void {
  ctx.report(healthName(provider), { state, at: progress.lastSuccess,
    detail: `Last success: ${progress.lastSuccess ?? 'never'}; objects ${progress.objects ?? 0}; records ${progress.records ?? 0}; changes ${progress.changes ?? 0}; partial ${progress.partial ?? 0}; left to the Feishu Source ${progress.skipped ?? 0}; next scan ${progress.nextAt ?? 'now'}`
      + (progress.error ? `; ${progress.error}` : '') })
}

/** Adds an idempotent source-health notice to the configured owner destination. */
function notice(ctx: SourceContext, config: ActivityConfig, provider: ActivityProvider, ticket: Ticket | undefined, progress: ActivityProgress, recovered: boolean): void {
  const channel = ticket ? ctx.triggers.get(ticket.origin.triggerId)?.channel : ownerDiscussionChannel(ctx)
  if (!channel || !['feishu', 'workbench'].includes(channel.source)) return
  ctx.notify({ id: key('activity-health', collection(config), activation(config), provider, progress.firstFailure ?? '', recovered ? 'recovered' : 'failed'),
    channel, kind: 'notice', ...ticket ? { ticketId: ticket.id } : {},
    text: recovered ? `${provider} 近期动态读取已恢复，将继续按来源配置采集与分流。`
      : `${provider} 近期动态已连续 ${progress.failures} 次未完整读取。读取进度保留，系统会继续重试；请查看中台来源健康，必要时恢复来源连接或授权。` })
}

/** One bounded pass keeps each provider's confirmed range independent and never acknowledges a rejected intake. */
export async function scanActivityRound(ctx: SourceContext, bindings: ActivitySourceBindings, tools: ActivityTools, signal: AbortSignal,
  clock: () => number = Date.now): Promise<void> {
  const config = ctx.config<ActivityConfig>(SOURCE)
  if (!config) {
    for (const entry of [SOURCE, ...PROVIDERS.map(healthName)]) ctx.report(entry, { state: 'paused', detail: 'Activity Source is disabled' })
    return
  }
  if (!PROVIDERS.some(provider => enabled(config, provider))) {
    for (const entry of [SOURCE, ...PROVIDERS.map(healthName)]) ctx.report(entry, { state: 'paused', detail: 'All activity readers are disabled' })
    return
  }
  const signature = JSON.stringify(config)
  const assertActive = () => { target(ctx, config, bindings, signature, signal) }
  try {
    assertActive()
    const due = PROVIDERS.some(provider => {
      const progress = ctx.state.get(activityState.progress(collection(config), activation(config), provider))
      return enabled(config, provider) && (!progress?.nextAt || Date.parse(progress.nextAt) <= clock())
    })
    const notified = config.documentEvents && (pendingLarkEvents(ctx, bindings.lark.expectedUserId, 'documents').length > 0
      || larkReconcileToken(ctx, bindings.lark.expectedUserId, 'documents') !== undefined)
      || config.wechatNotifications && !!ctx.state.get(activityState.wechatWake(collection(config), activation(config)))
    if (due || notified) {
      const monitored = target(ctx, config, bindings, signature, signal)
      if (monitored && ctx.triggers.get(monitored.origin.triggerId)?.channel?.source === 'feishu') await assertOwnerAudience(ctx.commands.withSignal(signal), bindings)
      assertActive()
    }
    ctx.atomic(() => {
      if (config.routing === 'monitor' && !ctx.state.get(activityState.bound(config.ticketId, activation(config)))) {
        assertActive()
        ctx.tickets.bindThread(config.ticketId, monitorRef(config), true)
        ctx.state.set(activityState.bound(config.ticketId, activation(config)), { at: new Date(clock()).toISOString(), owner: bindings.lark.expectedUserId })
      }
    })
  } catch (error) {
    if (!(error instanceof ActivityHeld)) throw error
    for (const entry of [SOURCE, ...PROVIDERS.map(healthName)]) ctx.report(entry, { state: 'paused', detail: error.message })
    return
  }
  let failures = 0
  for (const provider of PROVIDERS) {
    if (!enabled(config, provider)) { ctx.report(healthName(provider), { state: 'paused', detail: 'Reader disabled' }); continue }
    const stateKey = activityState.progress(collection(config), activation(config), provider)
    const pollSeconds = provider === 'wechat' ? config.wechatPollSeconds ?? config.pollSeconds
      : provider === 'feishu-documents' && config.documentEvents ? config.documentReconcileSeconds : config.pollSeconds
    const previous = ctx.state.get(stateKey) ?? { failures: 0 }
    const wakeKey = activityState.wechatWake(collection(config), activation(config))
    const wake = provider === 'wechat' && config.wechatNotifications ? ctx.state.get(wakeKey) : undefined
    const reconnect = provider === 'feishu-documents' && config.documentEvents ? larkReconcileToken(ctx, bindings.lark.expectedUserId, 'documents') : undefined
    let changes = 0, range: ActivityRange | undefined, result: ActivityScan | undefined
    try {
      assertActive()
      // A retained document notification must fail inside this provider's boundary; otherwise its retry would stop the readers after it.
      if (provider === 'feishu-documents' && config.documentEvents) {
        const events = await documentEventChanges(ctx, bindings.lark, config, signal)
        for (const event of events.events) {
          const trigger = activityTrigger(event, config)
          const channel = ownerDiscussionChannel(ctx)
          if (channel) trigger.channel = channel
          const received = await ctx.receive(trigger)
          if (received !== 'stored' && received !== 'duplicate') throw new Error('Document event was not persisted')
          if (received === 'stored') changes++
        }
        events.confirm()
      }
      if (previous.nextAt && Date.parse(previous.nextAt) > clock() && !(wake && !previous.failures) && reconnect === undefined) {
        providerHealth(ctx, provider, previous, previous.failures >= config.failuresBeforeError ? 'error' : 'ready')
        failures += previous.failures >= config.failuresBeforeError ? 1 : 0
        continue
      }
      range = previous.pending ?? { start: new Date(previous.since ? Date.parse(previous.since) - config.overlapSeconds * 1000
        : clock() - config.lookbackHours * 3600_000).toISOString(), end: new Date(clock()).toISOString() }
      const reader: ActivityReaderContext = { source: ctx, signal, consumerId: key(SOURCE, collection(config), activation(config), provider), assertActive,
        async emit(event) {
          assertActive()
          if (event.provider !== provider) throw new Error('Reader emitted an event for another provider')
          const trigger = activityTrigger(event, config)
          if (config.routing === 'tasks') {
            const channel = ownerDiscussionChannel(ctx)
            if (!channel) throw new ActivityHeld('Choose a private owner destination for individual matters')
            trigger.channel = channel
          }
          const result = await ctx.receive(trigger)
          if (result === 'stored' && config.routing === 'tasks') ctx.threads.describe(threadKey(trigger.threads[0]!), { label: event.label ?? event.reference, ...event.url ? { url: event.url } : {} })
          if (result === 'filtered') throw new Error('Activity intake was filtered; its batch must not be acknowledged')
          assertActive()
          if (result === 'stored') changes++
          return result
        } }
      assertActive()
      ctx.state.set(stateKey, { ...previous, pending: range })
      const scanned: ActivityScan = provider === 'feishu-messages' ? await scanLarkMessages(reader, bindings.lark, range,
        { alertChats: config.alertChatId ? [config.alertChatId] : [], severities: parseAlertSeverities(config) })
        : provider === 'feishu-documents' ? await scanLarkDocuments(reader, bindings.lark, range, config.documentEvents ? config.watchedDocuments : undefined)
          : await scanWechatActivity(reader, tools, bindings.wechat, range)
      result = scanned
      assertActive()
      if (!scanned.complete) throw new Error(scanned.detail ?? 'Incomplete scan; read position retained')
      const progress: ActivityProgress = { since: range.end, lastSuccess: new Date(clock()).toISOString(), failures: 0,
        nextAt: new Date(clock() + pollSeconds * 1000).toISOString(), objects: scanned.objects, records: scanned.records,
        changes, partial: scanned.contentPartial ?? 0, ...scanned.skipped ? { skipped: scanned.skipped } : {} }
      ctx.atomic(() => {
        assertActive()
        if (previous.alerted) notice(ctx, config, provider, target(ctx, config, bindings, signature, signal), previous, true)
        ctx.state.set(stateKey, progress)
        if (wake && ctx.state.get(wakeKey)?.token === wake.token) ctx.state.set(wakeKey, undefined)
        if (provider === 'feishu-documents') finishLarkReconcile(ctx, bindings.lark.expectedUserId, 'documents', reconnect)
      })
      providerHealth(ctx, provider, progress, 'ready')
    } catch (error) {
      if (error instanceof ActivityHeld || signal.aborted) {
        ctx.report(healthName(provider), { state: 'paused', detail: error instanceof Error ? error.message : 'Activity Source stopped' })
        ctx.report(SOURCE, { state: 'paused', detail: 'Monitoring held; pending progress is retained' })
        return
      }
      // A reader may fail at the same time that its configuration or subscription is withdrawn.
      try { assertActive() }
      catch (held) {
        if (!(held instanceof ActivityHeld)) throw held
        ctx.report(SOURCE, { state: 'paused', detail: held.message })
        return
      }
      const progress: ActivityProgress = { ...previous, pending: range ?? previous.pending, failures: previous.failures + 1,
        firstFailure: previous.firstFailure ?? new Date(clock()).toISOString(), nextAt: new Date(clock() + pollSeconds * 1000).toISOString(),
        changes, ...(result ? { objects: result.objects, records: result.records, partial: 1 + (result.contentPartial ?? 0),
          ...result.skipped ? { skipped: result.skipped } : {} } : {}),
        error: error instanceof Error ? error.message : String(error) }
      ctx.atomic(() => {
        assertActive()
        if (progress.failures >= config.failuresBeforeError && !previous.alerted) {
          notice(ctx, config, provider, target(ctx, config, bindings, signature, signal), progress, false)
          progress.alerted = true
        }
        ctx.state.set(stateKey, progress)
      })
      const failed = progress.failures >= config.failuresBeforeError
      failures += failed ? 1 : 0
      providerHealth(ctx, provider, progress, failed ? 'error' : 'ready')
    }
  }
  ctx.report(SOURCE, { state: failures ? 'error' : 'ready', detail: failures ? `${failures} activity reader(s) need attention` : 'Recent activity readers are up to date', at: new Date(clock()).toISOString() })
}

/** Runs inside the existing Source lifecycle so stop and restart join all in-flight reads before Store closes. */
export async function runActivity(ctx: SourceContext, bindings: ActivitySourceBindings, tools: ActivityTools, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, { state: 'paused', detail: 'Waiting for setup' }); return }
  while (!signal.aborted) {
    let seconds = 5
    try { await scanActivityRound(ctx, bindings, tools, signal) }
    catch (error) {
      if (signal.aborted) return
      ctx.report(SOURCE, { state: 'error', detail: error instanceof Error ? error.message : String(error), at: new Date().toISOString() })
      seconds = ctx.config<ActivityConfig>(SOURCE)?.pollSeconds ?? 120
    }
    try { await delay(seconds * 1000, undefined, { signal }) }
    catch (error) { if (!signal.aborted) throw error }
  }
}

export const name = 'dsh-superagent-activity'
export const inject = ['orchestrator', 'tools']
export const Config = s.object({
  configDir: s.string().default('').description('Existing user lark-cli configuration directory; no credentials.'),
  larkCli: s.string().default('').description('Absolute path of the native lark-cli used for owner reads; empty reuses the Feishu Source CLI.'),
  expectedOwner: s.string().default('').description('Feishu open_id of the owner who delegated the monitor.'),
  ownerChatId: s.string().default('').description('Previously verified owner-and-bot-only Feishu control chat.'),
  serverName: s.string().default('wechat_readonly').description('Existing native MCP server name for read-only WeChat.'),
})
export type ActivityPluginConfig = ReturnType<typeof Config>
export function apply(ctx: Context, config: ActivityPluginConfig): void {
  const bindings: ActivitySourceBindings = { ownerChatId: config.ownerChatId, lark: { expectedUserId: config.expectedOwner, ...config.configDir ? { configDir: config.configDir } : {}, ...config.larkCli ? { cli: config.larkCli } : {} },
    wechat: { serverName: config.serverName } }
  const kind = createActivityKind(bindings, ctx.tools)
  ctx.effect(() => ctx.orchestrator.sources.register(kind), 'activity: source kind')
  ctx.effect(() => ctx.tools.guard(execution => execution.agent && execution.name === `mcp__${bindings.wechat.serverName}__wechat_incremental_ack`
    ? 'Only the activity Source may acknowledge its durable evidence batches' : undefined))
  ctx.effect(() => ctx.orchestrator.runSource(async signal => {
    const source = sourceContext(ctx.orchestrator, kind)
    await Promise.all([runActivity(source, bindings, ctx.tools, signal), watchWechatActivity(source, bindings, ctx.tools, signal)])
  }))
}

/** The WeChat package owns native notification handles; this loop only persists a durable wake hint. */
export async function watchWechatActivity(ctx: SourceContext, bindings: ActivitySourceBindings, tools: ActivityTools, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) return
  let token = '', signature = ''
  while (!signal.aborted) {
    const config = ctx.config<ActivityConfig>(SOURCE)
    if (!config?.wechat || !config.wechatNotifications) {
      ctx.report('activity:wechat-events', { state: 'paused', detail: 'Native WeChat notifications disabled' })
      token = ''; signature = ''
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    const current = JSON.stringify(config)
    if (current !== signature) { token = ''; signature = current }
    try {
      const change = await waitWechatChange(tools, bindings.wechat, token, signal)
      if (JSON.stringify(ctx.config<ActivityConfig>(SOURCE)) !== signature) continue
      if (change.changed) ctx.state.set(activityState.wechatWake(collection(config), activation(config)), { token: change.token, at: new Date().toISOString() })
      token = change.token
      ctx.report('activity:wechat-events', { state: 'ready', detail: 'Windows database notifications; messages use validated incremental reads', at: new Date().toISOString() })
    } catch (error) {
      if (signal.aborted) return
      ctx.report('activity:wechat-events', { state: 'error', detail: error instanceof Error ? error.message : 'Native notification unavailable; periodic reconciliation remains active' })
      await delay(30_000, undefined, { signal }).catch(() => {})
    }
  }
}
