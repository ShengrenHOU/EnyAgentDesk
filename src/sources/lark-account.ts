/** One profile-owned Feishu account and event connection, shared by the resource Sources. */
import { Service, type Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { normalize } from 'node:path'
import { consumeLarkBridge, type BridgeEvent } from './lark-events.ts'
import type { LarkUserBinding } from './lark-user.ts'

export const name = 'dsh-superagent-lark-account'
export const inject = ['orchestrator']
export const Config = s.object({
  configDir: s.string().default('').description('Personal user CLI configuration directory; bot configuration stays separate.'),
  larkCli: s.string().default('').description('Native CLI for personal resource access.'),
  expectedUserId: s.string().default('').description('The owner open_id shared by personal resource Sources.'),
  eventCommand: s.array(s.string()).default([]).description('Trusted credential-broker argument array for the application event bridge.'),
})
export type LarkAccountConfig = ReturnType<typeof Config>
export interface LarkEventStatus {
  state: 'starting' | 'ready' | 'error'
  detail: string
  received: number
  accepted: number
  failed: number
  lastEventAt?: string
}
interface Receiver {
  receive(event: BridgeEvent): Promise<boolean>
  report(status: LarkEventStatus): void
  recover(): void
  counts: Pick<LarkEventStatus, 'received' | 'accepted' | 'failed' | 'lastEventAt'>
}
declare module '@deepseek-ai/cordis' { interface Context { larkAccount: LarkAccount } }

/** Owns one user binding and SDK connection; resource plugins own subscriptions, parsing and durable progress. */
export class LarkAccount extends Service {
  readonly binding: LarkUserBinding
  readonly mode: 'sdk' | 'cli'
  private readonly receivers = new Map<string, Receiver>()
  private status: Pick<LarkEventStatus, 'state' | 'detail'> = { state: 'starting', detail: 'Waiting for the application event connection' }
  constructor(ctx: Context, readonly config: LarkAccountConfig) {
    super(ctx, 'larkAccount')
    this.binding = { expectedUserId: config.expectedUserId, ...config.configDir ? { configDir: config.configDir } : {},
      ...config.larkCli ? { cli: config.larkCli } : {} }
    this.mode = config.eventCommand.length ? 'sdk' : 'cli'
  }
  /** Legacy duplicated fields may agree during migration, but cannot select another account. */
  checkLegacy(binding: LarkUserBinding, command: readonly string[] = []): void {
    for (const field of ['expectedUserId', 'configDir', 'cli'] as const) {
      const old = binding[field], current = this.binding[field]
      if (old && (field === 'expectedUserId' ? old !== current : !current || normalize(old) !== normalize(current))) throw new Error(`Move the personal ${field} configuration to dsh-superagent-lark-account`)
    }
    if (command.length && JSON.stringify(command) !== JSON.stringify(this.config.eventCommand)) throw new Error('Move eventCommand to dsh-superagent-lark-account')
  }
  subscribe(types: readonly string[], receive: Receiver['receive'], report: Receiver['report'], recover: Receiver['recover'] = () => {}): () => void {
    if (types.some(type => this.receivers.has(type))) throw new Error('Feishu event type already has a Source owner')
    const receiver: Receiver = { receive, report, recover, counts: { received: 0, accepted: 0, failed: 0 } }
    for (const type of types) this.receivers.set(type, receiver)
    report({ ...this.status, ...receiver.counts })
    if (this.status.state === 'ready') recover()
    return () => { for (const type of types) if (this.receivers.get(type) === receiver) this.receivers.delete(type) }
  }
  async deliver(event: BridgeEvent): Promise<void> {
    const receiver = this.receivers.get(event.eventType)
    if (!receiver) return
    receiver.counts.received++
    receiver.counts.lastEventAt = event.at
    try { if (await receiver.receive(event)) receiver.counts.accepted++ }
    catch (error) { receiver.counts.failed++; throw error }
    finally { receiver.report({ ...this.status, ...receiver.counts }) }
  }
  connection(state: LarkEventStatus['state'], detail: string): void {
    const recovered = state === 'ready' && this.status.state !== 'ready'
    this.status = { state, detail }
    for (const receiver of new Set(this.receivers.values())) {
      if (recovered) receiver.recover()
      receiver.report({ ...this.status, ...receiver.counts })
    }
  }
  async run(signal: AbortSignal): Promise<void> {
    if (this.mode === 'sdk') await consumeLarkBridge(this.config.eventCommand, signal,
      event => this.deliver(event), (state, detail) => this.connection(state, detail))
  }
}

export function apply(ctx: Context, config: LarkAccountConfig): void {
  const account = new LarkAccount(ctx, config)
  ctx.effect(() => ctx.orchestrator.runSource(async signal => {
    const host = ctx.orchestrator.context({ kind: 'lark-account', health: [] })
    await host.ready
    if (host.configured()) await account.run(signal)
  }))
}
