/** Idempotent message delivery to DSH agents across Session restarts. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-superagent': { kind: 'dsh-superagent' } & ContextFormed
  }
}

type Seen = { ids: Set<string>; nativeIds: Set<string>; claimed: Set<string>; consumed: Map<string, number>; loaded?: Promise<void> }
/** The id of the message delivered under `requestId`, the same on every retry. */
export const messageId = (requestId: string) => MessageId(`dsh-superagent:${requestId}`)
/** Extracts the idempotency key from current or legacy plugin message sources. */
function deliveryId(message: UserMessage): string | undefined {
  // Persisted sources may predate the current producer-specific source map.
  const source: { kind: string; plugin?: unknown; rpcId?: unknown } = message.source
  if (source.kind === 'dsh-superagent' || (source.kind === 'plugin' && source.plugin === 'dsh-superagent')) return message.id
  // Requests admitted by the former user RPC retain their original attribution.
  if (source.kind === 'user' && 'rpcId' in source && typeof source.rpcId === 'string') return messageId(source.rpcId)
}
/** A native RPC retry may mint a new message id while retaining its request attribution. */
export const messageIdentity = (message: UserMessage): string => {
  const source: { kind: string; plugin?: unknown; rpcId?: unknown } = message.source
  return JSON.stringify([source.kind, source.kind === 'plugin' ? source.plugin : null,
    source.kind === 'user' && typeof source.rpcId === 'string' ? source.rpcId : message.id])
}
/** Context-only producer messages retain their native non-waking delivery semantics. */
export const passiveContext = (message: UserMessage): boolean => message.source.kind !== 'user' && 'form' in message.source
  && (message.source.form === 'notice' || message.source.form === 'snapshot')
function remember(seen: Seen, message: UserMessage, time: number): void {
  seen.nativeIds.add(messageIdentity(message))
  const id = deliveryId(message)
  if (id) {
    seen.ids.add(id)
    if (Number.isFinite(time)) seen.consumed.set(id, time)
  }
}

/**
 * Delivers messages to DSH agents at most once per request ID across active and restored Sessions.
 * Tracks delivered message IDs from live Session events, persisted history, and pending inboxes so retries from `Sessions` do not duplicate messages,
 * and marks delivered messages with `dsh-superagent`'s own source (`dsh-superagent`) rather than user RPCs so they are never mistaken for messages written by a person.
 */
export class AgentDelivery {
  private readonly seen = new WeakMap<Session, Seen>()
  private state(session: Session): Seen {
    let seen = this.seen.get(session)
    if (!seen) { seen = { ids: new Set(), nativeIds: new Set(), claimed: new Set(), consumed: new Map() }; this.seen.set(session, seen) }
    return seen
  }
  constructor(private readonly ctx: Context) {
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const seen = this.state(agent.session)
      seen.claimed.add(message.id); seen.claimed.add(messageIdentity(message))
      const id = deliveryId(message); if (id) seen.claimed.add(id)
    })
    ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') this.seen.get(agent.session)?.claimed.clear() })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      remember(this.state(session), event.data, event.time)
    })
  }
  private async history(agent: Agent): Promise<Seen> {
    const state = this.state(agent.session)
    state.loaded ??= (async () => {
      await this.ctx.sessionPersistence.flush()
      await using handle = await this.ctx.sessionPersistence.open(agent.id, 'read')
      for (let offset = 0; ; ) {
        const { events } = await handle.read(offset, 512)
        if (!events.length) break
        for (const event of events) {
          if (event.type !== 'user/message') continue
          remember(state, event.data, event.time)
        }
        offset += events.length
      }
    })().catch(error => { state.loaded = undefined; throw error })
    await state.loaded
    return state
  }
  /** Only durable user/message evidence establishes consumption; absence from an inbox proves nothing. */
  async consumedAt(agent: Agent, requestId: string): Promise<number | undefined> {
    const seen = await this.history(agent)
    await this.ctx.sessionPersistence.flush()
    return seen.consumed.get(messageId(requestId))
  }
  /** Synchronous unread snapshot for the final pre-enqueue admission check (after history is loaded). */
  unread(agent: Agent): readonly UserMessage[] {
    const seen = this.seen.get(agent.session)
    return [...agent.inbox.nextTurn, ...agent.inbox.nextStep].filter(message => !seen?.consumed.has(message.id))
  }
  async holds(agent: Agent, requestId: string): Promise<boolean> {
    const id = messageId(requestId)
    return (await this.history(agent)).ids.has(id) || [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => deliveryId(message) === id)
  }
  /** A retry consumed in its original segment must not become a new instruction after a handoff. */
  async consumed(agent: Agent, message: UserMessage): Promise<boolean> {
    const seen = await this.history(agent)
    await this.ctx.sessionPersistence.flush()
    return seen.nativeIds.has(messageIdentity(message))
  }
  /** Transfer an already admitted native input without minting user attribution or a new instruction. */
  async transfer(agent: Agent, message: UserMessage, signal: AbortSignal): Promise<boolean> {
    const seen = await this.history(agent), id = messageIdentity(message)
    signal.throwIfAborted()
    if (this.ctx.agents.get(agent.id) !== agent) throw new Error('Delivery target was disposed')
    if (!seen.nativeIds.has(id) && !(agent.status === 'running' && seen.claimed.has(id))
      && ![...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(item => messageIdentity(item) === id)) {
      if (passiveContext(message)) agent.inject(message)
      else agent.followup(message)
    }
    await this.ctx.sessionPersistence.flush()
    return seen.nativeIds.has(id)
  }
  /** Delivers once to the selected inbox, or injects into history without waking the agent, and flushes Session persistence before acknowledging the producer. */
  async send(agent: Agent, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, signal: AbortSignal, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    signal.throwIfAborted()
    const seen = await this.history(agent)
    signal.throwIfAborted()
    if (this.ctx.agents.get(agent.id) !== agent) throw new Error('Delivery target was disposed')
    authorize?.()
    const id = messageId(requestId)
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => deliveryId(message) === id)
    if (!seen.ids.has(id) && !pending && !(agent.status === 'running' && seen.claimed.has(id))) {
      const source = typeof mode === 'object' ? { kind: 'dsh-superagent' as const, form: 'notice' as const, summary: mode.inject }
        : { kind: 'dsh-superagent' as const, form: 'relay' as const }
      const message = freezeMessage({ id, role: 'user' as const, content: [{ type: 'text' as const, text }], source })
      if (typeof mode === 'object') agent.inject(message)
      else if (mode === 'steer') agent.steer(message)
      else agent.followup(message)
    }
    accepted?.()
    await this.ctx.sessionPersistence.flush()
  }
}
