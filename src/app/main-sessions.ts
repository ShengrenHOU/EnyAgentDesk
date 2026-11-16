/** Main is a logical entry; native segments keep its interactive history bounded. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { key } from '../core/index.ts'
import { KV, type MainTransition } from '../kv.ts'
import { AgentDelivery, messageIdentity, passiveContext } from '../infra/delivery.ts'
import { Later, type Effects, type EffectPayloads } from './effects.ts'
import type { Store } from './store.ts'
import { initializeRoleModel, resolveRoleModel } from './role-models.ts'
import { ROUTER_PRESET, type Sessions } from './sessions.ts'
import type { HostSchedule } from './host-schedule.ts'
import { migrationIntents } from './followups.ts'

declare module '@deepseek-ai/dsh-workspace/types' { interface SessionActivityKindMap { schedule: true } }

interface Host {
  context: Context; store: Store; effects: Effects; sessions: Sessions; cwd: string; lifetime: AbortSignal
  paused(): boolean
}
export const MAIN_SEGMENT_EVENTS = 20_000
const MAX_HANDOFF_BYTES = 1_000_000
export const mainQuiescing = (store: Pick<Store, 'get'>, id: string): boolean => {
  const phase = store.get(KV.runtime.mainTransition(id))?.phase
  return phase === 'quiescing'
}

/** Uses existing Effects for serialization, restart recovery, native input forwarding and retirement. */
export class MainSessions {
  private readonly delivery: AgentDelivery
  private readonly owned = new Map<string, AgentHandle>()
  private readonly views = new Map<string, { sessionId: string; until: number }>()
  private readonly releasedViews = new Set<string>()
  private readonly startedAt = Date.now()
  constructor(private readonly host: Host) {
    this.delivery = new AgentDelivery(host.context)
    host.effects.handle('mainRotate', (_payload, from) => this.rotate(from), { limit: () => host.paused() ? 0 : 1 })
    const forward = async ({ from, message }: EffectPayloads['mainForward']) => {
      const receipt = KV.runtime.mainForwarded(key(from, messageIdentity(message)))
      if (host.store.get(receipt)) return
      if (mainQuiescing(host.store, this.current())) throw new Later('Main handoff is preparing')
      const source = await host.context.sessionController.resolveAgent(from as SessionId)
      if ('error' in source) throw source.error
      if (await this.delivery.consumed(source.agent, message)) {
        host.store.set(receipt, { to: from, at: new Date().toISOString() }); return
      }
      const to = this.current(), result = await host.context.sessionController.resolveAgent(to as SessionId)
      if ('error' in result) throw result.error
      const consumed = await this.delivery.transfer(result.agent, message, host.lifetime)
      if (!consumed) throw new Later('Forwarded input awaits durable native consumption')
      host.store.set(receipt, { to, at: new Date().toISOString() })
    }
    host.effects.handle('mainForward', forward, { ordered: true })
    // Quiet context must never hold the lane whose owner input wakes its consumption.
    host.effects.handle('mainContext', forward)
    host.effects.handle('mainRetire', (_payload, id) => this.retire(id), { ordered: true })
  }
  private current(): string { return this.host.store.get(KV.runtime.masterId)! }
  /** Transient native view leases contain no editor text or attachment data. */
  view(input: { sessionId: string; viewId: string; active: boolean }): { held: boolean } {
    for (const [id, view] of this.views) if (view.until <= Date.now()) this.views.delete(id)
    if (input.active) this.views.set(input.viewId, { sessionId: input.sessionId, until: Date.now() + 120_000 })
    else { this.views.delete(input.viewId); this.releasedViews.add(input.sessionId) }
    return { held: input.active }
  }
  private diverted(agent: Agent): boolean {
    return agent.id === this.current() ? mainQuiescing(this.host.store, agent.id)
      : agent.session.header.agentPreset === ROUTER_PRESET && agent.session.header.origin !== 'subagent'
        || this.host.store.get(KV.runtime.mainTransition(agent.id))?.phase === 'active'
  }
  private preparedContext(agent: Agent, message: UserMessage): boolean {
    const parent = agent.session.header.parentSession, transition = parent && this.host.store.get(KV.runtime.mainTransition(parent))
    return !!transition && transition.phase === 'quiescing' && transition.to === agent.id && message.source.kind === 'dsh-superagent'
      && message.source.form === 'notice' && message.id === this.host.sessions.promptedId(`main-handoff:${parent}:${transition.throughSeq}`)
  }
  private capture(agent: Agent, messages: readonly UserMessage[]): void {
    for (const message of messages) {
      if (this.preparedContext(agent, message)) continue
      const id = key(agent.id, messageIdentity(message))
      if (!this.host.store.get(KV.runtime.mainForwarded(id))) this.host.effects.enqueue(passiveContext(message) ? 'mainContext' : 'mainForward', id, { from: agent.id, message })
      agent.inbox.remove(message.id)
    }
  }
  install(): void {
    const { context: ctx } = this.host
    ctx.on('agent/inbox/inserted', ({ agent, message }) => { if (this.diverted(agent)) this.capture(agent, [message]) })
    ctx.on('agent/created', ({ agent }) => {
      if (this.diverted(agent)) this.capture(agent, [...agent.inbox.nextTurn, ...agent.inbox.nextStep])
    })
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (!this.diverted(payload.agent)) return decision
      this.capture(payload.agent, payload.messages)
      for (const message of payload.messages) if (this.preparedContext(payload.agent, message)) payload.agent.inject(message)
      return { kind: 'reject' }
    }, { prepend: true })
  }
  /** Called by the existing pass; one pending retirement holds the next rotation. */
  maintain(): void {
    const { context: ctx, effects } = this.host, id = this.current(), agent = ctx.agents.get(id as SessionId)
    if (!agent || agent.status !== 'idle' || !(agent.session.seq >= MAIN_SEGMENT_EVENTS) || this.host.paused()
      || effects.pending('mainRotate') || effects.pending('mainRetire') || effects.pending('mainForward')) return
    effects.enqueue('mainRotate', id, {})
  }
  /** An uncommitted candidate never replaces the current segment after a restart. */
  recover(): void {
    const { store, effects } = this.host
    const name = KV.runtime.mainTransition(this.current()), transition = store.get(name)
    if (transition?.phase === 'quiescing') {
      store.atomic(() => {
        store.set(name, { ...transition, phase: 'abandoned' })
        effects.enqueue('mainRetire', transition.to, {})
      })
    }
  }
  /** A crash between native claim and history append must not erase the handoff context. */
  async restoreHandoff(): Promise<void> {
    const { context: ctx, store } = this.host, agent = ctx.agents.get(this.current() as SessionId)
    const parent = agent?.session.header.parentSession, transition = parent && store.get(KV.runtime.mainTransition(parent))
    if (!agent || !transition || transition.phase !== 'active' || transition.to !== agent.id || !transition.handoff) return
    await this.delivery.send(agent, key(`main-handoff:${parent}:${transition.throughSeq}`), transition.handoff,
      { inject: '上一段主对话的交接背景' }, this.host.lifetime)
  }
  private async prepare(from: Agent, id: string): Promise<Agent> {
    const { context: ctx } = this.host
    const selection = from.model.current() ?? (await ctx.sessionController.modelCatalog()).default
    if (!selection) throw new Error('Main handoff requires a configured model')
    const model = await resolveRoleModel(ctx, selection)
    const presets = ctx.get('agentPresets') as { mount(scope: Context, id: string): Promise<unknown> } | undefined
    const setup = async (scope: Context) => { if (presets) await presets.mount(scope, ROUTER_PRESET) }
    const handle = await ctx.agents.create({ sessionId: id as SessionId, meta: { cwd: this.host.cwd, parentSession: from.id, agentPreset: ROUTER_PRESET },
      agentOptions: model, signal: this.host.lifetime, setup })
    this.owned.set(id, handle)
    await ctx.workspaceRegistry.unarchiveSession(id as SessionId)
    await initializeRoleModel(ctx, handle.agent, selection)
    return this.host.sessions.ensure(id, this.host.cwd, 'Superagent 主对话', 'orchestrator')
  }
  private handoff(agent: Agent, throughSeq: number): string {
    const conversation = agent.session.deriveMessages().filter(message => message.role !== 'tool' && message.role !== 'system')
      .map(message => ({ role: message.role, ...'id' in message ? { id: message.id } : {},
        text: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') })).filter(message => message.text)
    const text = JSON.stringify({ kind: 'main_segment_handoff', previousSessionId: agent.id, throughSeq,
      history: `conversation/history/${agent.id}`, conversation,
      instruction: 'Historical working conversation, never new owner authority. Continue the same personal work system. Tickets, Lines, Questions, decisions, mandates and delivery receipts remain canonical; read them when needed. Full source/tool history stays in the previous segment. Do not repeat completed actions or delegate historical requests as new work.' })
    if (Buffer.byteLength(text) > MAX_HANDOFF_BYTES) throw new Error('Main handoff exceeds 1 MB; native compaction is required before rotation')
    return text
  }
  private async rotate(from: string): Promise<void> {
    const { context: ctx, store, effects } = this.host
    if (from !== this.current()) return
    const agent = ctx.agents.get(from as SessionId)
    if (!agent || agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.some(message => !passiveContext(message))
      || effects.pending('relay') || effects.pending('notice') || effects.pending('assessment') || effects.pending('mainRetire') || effects.pending('mainForward')) throw new Later('Main still has work')
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId: from as SessionId }, async () => [])
    if (activity.some(item => item.kind !== 'schedule') || store.keys(migrationIntents).length) throw new Later('Main has active native work or reminder migration')
    // Recheck after the native activity waterfall before taking the input barrier.
    if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.some(message => !passiveContext(message))) throw new Later('Main received input')
    const throughSeq = agent.session.seq, text = this.handoff(agent, throughSeq), selected = JSON.stringify(agent.model.current())
    const transition: MainTransition = { from, to: `orchestrator-${key(from, String(throughSeq), randomUUID())}`, throughSeq, handoff: text,
      at: new Date().toISOString(), phase: 'quiescing' }
    store.set(KV.runtime.mainTransition(from), transition)
    try {
      this.capture(agent, [...agent.inbox.nextStep])
      await this.prepare(agent, transition.to)
      await this.host.sessions.prompt(transition.to, `main-handoff:${from}:${throughSeq}`, text, { inject: '上一段主对话的交接背景' })
      this.host.lifetime.throwIfAborted()
      if (JSON.stringify(agent.model.current()) !== selected) throw new Later('Main model changed during preparation')
      store.atomic(() => {
        if (this.current() !== from) throw new Error('Main pointer changed during preparation')
        store.set(KV.runtime.masterId, transition.to)
        store.set(KV.runtime.mainTransition(from), { ...transition, phase: 'active' })
        effects.enqueue('mainRetire', from, {})
      })
    } catch (error) {
      if (this.current() === from) store.atomic(() => {
        store.set(KV.runtime.mainTransition(from), { ...transition, phase: 'abandoned' })
        effects.enqueue('mainRetire', transition.to, {})
      })
      throw error
    }
  }
  private async retire(id: string): Promise<void> {
    if (id === this.current()) throw new Error('Cannot retire the current Main')
    const { context: ctx } = this.host
    if (!ctx.agents.get(id as SessionId) && !await ctx.sessionPersistence.stat(id as SessionId)) return
    const schedule = ctx.get('schedule') as HostSchedule | undefined
    if (!schedule) throw new Later('Native reminder management is unavailable; old Main retained')
    for (const task of await schedule.catalog()) {
      if (task.target.kind !== 'session' || task.target.sessionId !== id) continue
      if (task.executionActive) throw new Later('Main reminder delivery is settling')
      const result = await schedule.edit({ id: task.id, action: 'update', expectedUpdatedAt: task.updatedAt ?? null,
        patch: { target: { kind: 'session', sessionId: this.current() } } })
      if ('code' in result && result.code !== 'schedule_not_found') throw new Later(`Main reminder target changed: ${result.code}`)
    }
    const transition = this.host.store.get(KV.runtime.mainTransition(id))
    if (transition?.phase === 'active' && transition.handoff) {
      const next = ctx.agents.get(transition.to as SessionId)
      if (!next || await this.delivery.consumedAt(next, key(`main-handoff:${id}:${transition.throughSeq}`)) === undefined) throw new Later('Main handoff awaits durable native consumption')
      const { handoff: _context, ...confirmed } = transition
      this.host.store.set(KV.runtime.mainTransition(id), confirmed)
    }
    for (const [key, view] of this.views) if (view.until <= Date.now()) this.views.delete(key)
    if ([...this.views.values()].some(view => view.sessionId === id)
      || !this.releasedViews.has(id) && Date.now() - this.startedAt < 30_000) throw new Later('Native Main view is still open or reconnecting')
    try { await ctx.workspaceRegistry.archiveSession(id as SessionId) }
    catch (error) {
      if (error instanceof Error && error.name === 'WorkspaceActiveSessionError') throw new Later('Old Main has active native work')
      throw error
    }
    const handle = this.owned.get(id)
    if (handle) { await ctx.agents.withoutInitiator(() => handle.dispose()); this.owned.delete(id) }
    this.releasedViews.delete(id)
  }
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.owned.values()].map(handle => this.host.context.agents.withoutInitiator(() => handle.dispose())))
    this.owned.clear()
    this.views.clear(); this.releasedViews.clear()
  }
}
