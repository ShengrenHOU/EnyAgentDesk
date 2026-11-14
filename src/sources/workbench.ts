/** Native user delegation enters the existing Source lifecycle; ordinary Session messages do not. */
import { z } from 'zod'
import { key, latestReport, ticketFollowups, type Trigger, type OutboundMessage, type ChannelRef } from '../core/index.ts'
import type { SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { family, KV, record } from '../kv.ts'
import { ticketStage } from '../core/stage.ts'

const Identity = z.string().trim().min(1).max(200)
export const WorkbenchRequestSchema = z.object({
  requestId: Identity,
  sessionId: Identity,
  throughSeq: z.number().int().nonnegative(),
  instruction: z.string().trim().min(1).max(20_000),
}).strict()
export type WorkbenchRequest = z.infer<typeof WorkbenchRequestSchema>
export const DelegatedTasksSchema = z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
  owner_instruction_quote: z.string().trim().min(1).max(20_000),
}).strict()).min(1).max(20).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Task IDs must be distinct')
const taskPlan = (ownerId: string, sessionId: string, throughSeq: number) => record<{
  requestId: string; tasks: z.infer<typeof DelegatedTasksSchema>
}>(`workbench-task-plan:${key(ownerId, sessionId, String(throughSeq))}`)
export const WorkbenchUpdateSchema = WorkbenchRequestSchema.extend({ ticketId: Identity, attentionId: Identity.optional() })
export type WorkbenchUpdate = z.infer<typeof WorkbenchUpdateSchema>

/** The authenticated Host reads this snapshot; browser-supplied text cannot impersonate its history. */
export const WorkbenchContextSchema = z.object({
  sessionId: Identity,
  throughSeq: z.number().int().nonnegative(),
  messages: z.array(z.object({ seq: z.number().int().nonnegative(), role: z.enum(['user', 'assistant']),
    text: z.string().max(200_000), at: z.iso.datetime(),
    references: z.array(z.string().min(1).max(4000)).default([]),
  }).strict()).max(500),
  attachments: z.array(z.object({ reference: z.string(), name: z.string(), kind: z.enum(['file', 'image']),
    readonlyPath: z.string().optional() }).strict()).default([]),
  partial: z.boolean(),
}).strict().refine(value => value.messages.every(message => message.seq <= value.throughSeq), 'Context exceeds delegation boundary')
export type WorkbenchContext = z.infer<typeof WorkbenchContextSchema>

export const WorkbenchConfigSchema = z.object({ ownerId: z.string().trim().max(200).default(''),
  domains: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/), name: z.string().trim().min(1).max(80),
    scope: z.string().trim().min(1).max(1500), state: z.enum(['active', 'dormant']).default('active'),
  }).strict()).max(30).default([]).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Domain IDs must be unique'),
}).strict()
export type WorkbenchConfig = z.infer<typeof WorkbenchConfigSchema>
export const WORKBENCH = 'workbench'
/** Sources publish automatic work to the configured owner's inbox rather than a third-party evidence thread. */
export function ownerDiscussionChannel(ctx: Pick<SourceContext, 'config' | 'state'>): ChannelRef | undefined {
  const ownerId = ctx.config<WorkbenchConfig>(WORKBENCH)?.ownerId
  const sessionId = ctx.state.get(KV.runtime.masterId)
  return ownerId && sessionId ? { source: WORKBENCH, thread: key(WORKBENCH, sessionId, 'inbox'), address: { ownerId, sessionId } } : undefined
}
export const discussionRequests = (sessionId: string) => family<{ triggerId: string; at: string }, [requestId: string]>(`workbench-discussion:${key(sessionId)}:`)
const discussionMessages = (sessionId: string) => family<OutboundMessage & { publishedAt?: string }, [id: string]>(`workbench-messages:${key(sessionId)}:`)

/** Native delivery is publication into the durable owner discussion inbox, not a synthetic Feishu reply. */
export function createWorkbenchKind(ctx: SourceContext, publishFiles?: SourceKind<WorkbenchConfig>['publishFiles'],
  notify?: (message: OutboundMessage) => Promise<void>): SourceKind<WorkbenchConfig> {
  return { ...workbenchKind, ...(publishFiles ? { publishFiles } : {}), channel: {
    allowed: (address, config) => !!config.ownerId && address.ownerId === config.ownerId && !!address.sessionId,
    async send(_host, message) {
      const config = ctx.config<WorkbenchConfig>(WORKBENCH)
      if (!config || message.channel.address.ownerId !== config.ownerId || !message.channel.address.sessionId) {
        throw new Error('Native discussion delivery is unavailable')
      }
      const record = discussionMessages(message.channel.address.sessionId)(message.id)
      ctx.state.set(record, { ...message, publishedAt: ctx.state.get(record)?.publishedAt ?? new Date().toISOString() })
      if (notify) await notify(message)
      return 'sent'
    },
    link: address => ({ url: '#superagent', sessionId: address.sessionId, label: { zh: 'DSH 工作台', en: 'DSH workbench' } }),
  } }
}

export function discussionNotices(ctx: SourceContext, sessionId: string) {
  return ctx.state.keys(discussionMessages(sessionId)).flatMap(entry => {
    const message = ctx.state.get(entry)
    return message ? [{ id: message.id, ticketId: message.ticketId, text: message.text, kind: message.kind, at: message.publishedAt ?? '' }] : []
  }).sort((a, b) => a.at.localeCompare(b.at))
}

export const workbenchKind: SourceKind<WorkbenchConfig> = {
  kind: WORKBENCH, title: { zh: '原生工作台', en: 'Native workbench' },
  description: { zh: '接收本人从 DSH 讨论中明确交办的事项。普通讨论不自动派工。',
    en: 'Receives explicit owner delegation from DSH discussions; ordinary messages do not start work.' },
  schema: WorkbenchConfigSchema,
  fields: [{ key: 'ownerId', type: 'text', label: { zh: '本人身份', en: 'Owner identity' }, readonly: true },
    { key: 'domains', type: 'rows', label: { zh: '长期关注域', en: 'Long-term focus domains' },
      hint: { zh: '按业务组织关注方向，可增删、合并或休眠。工单继续保存实际责任和授权。', en: 'Organize attention by business. Add, merge, remove or park domains; Tickets retain work and authority.' },
      columns: [
        { key: 'id', type: 'text', label: { zh: '标识', en: 'ID' }, pattern: '^[a-zA-Z0-9_-]{1,40}$' },
        { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' } },
        { key: 'scope', type: 'text', label: { zh: '关注范围', en: 'Scope' } },
        { key: 'state', type: 'select', label: { zh: '状态', en: 'State' }, options: [
          { value: 'active', label: { zh: '关注中', en: 'Active' } }, { value: 'dormant', label: { zh: '休眠', en: 'Dormant' } },
        ] },
      ] },
  ],
  health: [],
  scope: ({ meta }, config) => config.ownerId && meta.ownerId === config.ownerId
    ? { listened: true, observed: false } : { listened: false, reason: 'workbench_owner_mismatch' },
  threadContext: {
    messageId: trigger => trigger.id,
    async read(_commands, trigger, part, cursor) {
      const context = WorkbenchContextSchema.parse(trigger.meta.context)
      if (part === 'parent') return { messages: [], body: {}, status: 'unsupported' }
      if (cursor !== undefined && !/^\d+$/.test(cursor)) throw new Error('Invalid discussion context cursor')
      const offset = cursor === undefined ? 0 : Number(cursor)
      if (!Number.isSafeInteger(offset) || offset > context.messages.length) throw new Error('Invalid discussion context cursor')
      const messages = context.messages.slice(offset, offset + 50)
      return { messages: messages.map(message => ({ id: key(context.sessionId, String(message.seq)),
        from: message.role, at: message.at, text: message.text })),
        ...(offset + messages.length < context.messages.length ? { next: String(offset + messages.length) } : {}),
        status: context.partial ? 'partial' : 'available',
        body: { sessionId: context.sessionId, throughSeq: context.throughSeq,
          references: messages.flatMap(message => message.references), attachments: context.attachments,
          attachmentPolicy: 'Provider-owned originals: read only; write deliverables in the task workspace.', contentPartial: context.partial } }
    },
  },
}

/** Called only after the Host authenticates the owner and reads the selected persisted Session prefix. */
export async function delegateDiscussion(ctx: SourceContext, ownerId: string, request: WorkbenchRequest,
  context: WorkbenchContext, at: string): Promise<{ triggerId: string; received: 'stored' | 'duplicate' }> {
  const config = ctx.config<WorkbenchConfig>(WORKBENCH)
  if (!config?.ownerId || ownerId !== config.ownerId) throw new Error('Workbench delegation is disabled or belongs to another owner')
  const input = WorkbenchRequestSchema.parse(request)
  const snapshot = WorkbenchContextSchema.parse(context)
  if (input.sessionId !== snapshot.sessionId || input.throughSeq !== snapshot.throughSeq) throw new Error('Discussion context does not match the delegation')
  const plan = ctx.state.get(taskPlan(ownerId, input.sessionId, input.throughSeq))
  const plannedTask = plan?.tasks.find(task => input.requestId === key(plan.requestId, task.id) && input.instruction === task.owner_instruction_quote)
  if (plan && !plannedTask) {
    throw new Error('This owner message already has a task plan; reuse its original tasks')
  }
  const id = key(WORKBENCH, ownerId, input.sessionId, input.requestId)
  const previous = ctx.triggers.get(id)
  if (previous) {
    if (previous.text !== input.instruction || previous.meta.throughSeq !== input.throughSeq) {
      throw new Error('Delegation request ID was already used for different input')
    }
    ctx.state.set(discussionRequests(input.sessionId)(input.requestId), { triggerId: id, at: previous.at })
    return { triggerId: id, received: 'duplicate' }
  }
  const trigger: Trigger = { id, source: WORKBENCH, actor: { source: WORKBENCH, id: ownerId },
    channel: { source: WORKBENCH, thread: id, address: { sessionId: input.sessionId, ownerId } },
    // Separate delegations in one discussion must never share an automatic fanout thread.
    threads: [{ source: WORKBENCH, id }], human: true, addressed: 'direct',
    at: z.iso.datetime().parse(at), text: input.instruction,
    meta: { ownerId, sessionId: input.sessionId, throughSeq: input.throughSeq, requestId: input.requestId, context: snapshot,
      ...(plannedTask ? { task: plannedTask } : {}) } }
  const received = await ctx.receive(trigger)
  if (received === 'filtered') throw new Error('Workbench delegation was filtered; no task acceptance is claimed')
  ctx.state.set(discussionRequests(input.sessionId)(input.requestId), { triggerId: id, at: trigger.at })
  return { triggerId: id, received }
}

/** Accepted goals keep their identity; later additions and retries reuse the same owner-message plan. */
export async function delegateDiscussionTasks(ctx: SourceContext, ownerId: string, request: WorkbenchRequest,
  context: WorkbenchContext, tasks: z.infer<typeof DelegatedTasksSchema>, at: string) {
  const input = WorkbenchRequestSchema.parse(request)
  const snapshot = WorkbenchContextSchema.parse(context)
  const planned = DelegatedTasksSchema.parse(tasks)
  if (ctx.config<WorkbenchConfig>(WORKBENCH)?.ownerId !== ownerId || input.sessionId !== snapshot.sessionId || input.throughSeq !== snapshot.throughSeq) throw new Error('Task plan does not belong to this owner discussion')
  if (planned.some(task => !input.instruction.includes(task.owner_instruction_quote))) throw new Error('Each task must quote a goal in the original owner instruction')
  const value = { requestId: input.requestId, tasks: planned }
  ctx.atomic(() => {
    const name = taskPlan(ownerId, input.sessionId, input.throughSeq)
    const previous = ctx.state.get(name)
    if (previous) {
      if (previous.requestId !== value.requestId || planned.some(task => {
        const accepted = previous.tasks.find(item => item.id === task.id)
        return accepted && accepted.owner_instruction_quote !== task.owner_instruction_quote
      })) throw new Error('This owner message already has a different task plan')
      value.tasks = DelegatedTasksSchema.parse([...previous.tasks, ...planned.filter(task => !previous.tasks.some(item => item.id === task.id))])
    }
    if (ctx.triggers.get(key(WORKBENCH, ownerId, input.sessionId, input.requestId))) throw new Error('This owner message was already delegated as one task')
    ctx.state.set(name, value)
  })
  const receipts = []
  for (const task of planned) receipts.push({ taskId: task.id, ...await delegateDiscussion(ctx, ownerId,
    { ...input, requestId: key(input.requestId, task.id), instruction: task.owner_instruction_quote }, snapshot, at) })
  return { tasks: receipts }
}

/** The Session index is a navigation projection; task state is always read from its existing owner. */
export function discussionTasks(ctx: SourceContext, sessionId: string) {
  return ctx.state.keys(discussionRequests(sessionId)).flatMap(entry => {
    const record = ctx.state.get(entry)
    if (!record) return []
    const trigger = ctx.triggers.get(record.triggerId)
    if (!trigger || trigger.meta.sessionId !== sessionId) return []
    const thread = ctx.threads.get(`${WORKBENCH}:${record.triggerId}`)
    const tickets = (thread?.subscriptions ?? []).flatMap(id => { const ticket = ctx.tickets.get(id); return ticket ? [ticket] : [] })
    return [{ triggerId: record.triggerId, at: record.at, instruction: trigger.text,
      tickets: tickets.map(ticket => ({ id: ticket.id, title: ticket.title, paused: !!ticket.paused,
        ended: ticket.ended?.outcome ?? null, updatedAt: ticket.updatedAt, attention: ticket.attention ?? null,
        status: ticketStage(ticket), followupAt: ticketFollowups(ticket)[0]?.at ?? null,
        summary: latestReport(ticket)?.summary ?? '', deliverables: latestReport(ticket)?.deliverables ?? [] })) }]
  }).sort((a, b) => b.at.localeCompare(a.at))
}

/** Counts for the Session row: active work includes requests still waiting for admission, attention is the decision queue. */
export interface DiscussionSummary { sessionId: string; active: number; attention: number }
export function discussionSummary(ctx: SourceContext, sessionId: string): DiscussionSummary {
  const requests = discussionTasks(ctx, sessionId)
  const tickets = requests.flatMap(request => request.tickets)
  return { sessionId,
    active: tickets.filter(ticket => !ticket.ended).length + requests.filter(request => !request.tickets.length).length,
    attention: tickets.filter(ticket => !!ticket.attention).length }
}

/** Explicit updates reuse the task's native thread; unrelated discussion never enters this path. */
export async function updateDiscussionTask(ctx: SourceContext, ownerId: string, request: WorkbenchUpdate,
  context: WorkbenchContext, at: string): Promise<{ triggerId: string; received: 'stored' | 'duplicate' }> {
  const config = ctx.config<WorkbenchConfig>(WORKBENCH)
  if (!config?.ownerId || ownerId !== config.ownerId) throw new Error('Workbench is disabled or belongs to another owner')
  const input = WorkbenchUpdateSchema.parse(request), snapshot = WorkbenchContextSchema.parse(context)
  if (snapshot.sessionId !== input.sessionId || snapshot.throughSeq !== input.throughSeq) throw new Error('Discussion context does not match the update')
  const ticket = ctx.tickets.get(input.ticketId)
  const origin = ticket && ctx.triggers.get(ticket.origin.triggerId)
  if (!ticket || !origin || origin.source !== WORKBENCH || origin.meta.sessionId !== input.sessionId
    || origin.actor.id !== ownerId) throw new Error('Task does not belong to this owner discussion')
  const id = key(WORKBENCH, 'update', ownerId, input.ticketId, input.requestId)
  const previous = ctx.triggers.get(id)
  if (previous) {
    if (previous.text !== input.instruction || previous.meta.throughSeq !== input.throughSeq || previous.meta.attentionId !== input.attentionId) {
      throw new Error('Update request ID was already used for different input')
    }
    return { triggerId: id, received: 'duplicate' }
  }
  if (ticket.ended?.by === 'human') throw new Error('This task was stopped; a new delegation is required')
  if (input.attentionId && ticket.attention?.id !== input.attentionId) throw new Error('This decision is no longer pending; refresh the task')
  const thread = origin.threads[0]!
  const subscriptions = ctx.threads.get(`${thread.source}:${thread.id}`)?.subscriptions
  if (subscriptions?.length !== 1 || subscriptions[0] !== ticket.id) throw new Error('Task thread was reassigned; refresh the task before updating')
  const received = await ctx.receive({ id, source: WORKBENCH, threads: [thread], channel: origin.channel, human: true, addressed: 'direct',
    actor: { source: WORKBENCH, id: ownerId }, at: z.iso.datetime().parse(at), text: input.instruction,
    meta: { ownerId, sessionId: input.sessionId, throughSeq: input.throughSeq, ticketId: ticket.id,
      ...(input.attentionId ? { attentionId: input.attentionId } : {}), context: snapshot } })
  if (received === 'filtered') throw new Error('Task update was filtered')
  return { triggerId: id, received }
}
