/** Coalesces event-driven admission passes; time-owned operations run through durable Effects. */
import type { Engine, ReceiveResult, Trigger } from '../core/index.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Effects } from './effects.ts'

export interface PassesHost {
  readonly engine: Pick<Engine, 'receive' | 'evaluateDue'>
  readonly effects: Pick<Effects, 'kick' | 'idle'>
  readonly health: HealthEntry
  readonly lifetime: AbortSignal
  configured(): boolean
  closing(): boolean
}

const now = (): string => new Date().toISOString()

/**
 * Schedules and serializes orchestration passes that kick due `Effects` and advance `Engine` evaluations.
 * `Runtime` manages its lifecycle, while committed intake, decisions and configuration changes request passes.
 * Updates the runtime `HealthEntry` when a pass fails and clears the error once a subsequent pass succeeds.
 */
export class Passes {
  private stopped = false
  private pumping?: Promise<void>
  private pumpAgain?: Promise<void>
  constructor(private readonly host: PassesHost) {}
  private requested?: Promise<void>
  private readonly requests = new Set<Promise<void>>()
  start(): void { if (!this.stopped) this.request() }
  stop(): Promise<unknown> {
    this.stopped = true
    return Promise.allSettled([...this.requests, this.pumping, this.pumpAgain])
  }
  receive(trigger: Trigger): ReceiveResult {
    if (this.host.closing()) throw new Error('Orchestrator is stopping')
    const result = this.host.engine.receive(trigger)
    if (result === 'stored') this.request()
    return result
  }
  request(): void {
    if (this.stopped || this.requested) return
    const { health } = this.host
    const work = Promise.resolve().then(() => { this.requested = undefined; return this.stopped ? undefined : this.pump() }).then(() => {
      if (health.get()?.state !== 'error' || this.host.lifetime.aborted) return
      health.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
    }, (error: unknown) => { health.set({ state: 'error', detail: `A pass failed: ${String(error)}`, at: now() }) })
    this.requested = work
    this.requests.add(work)
    void work.then(() => this.requests.delete(work))
  }
  /** Wait until no pass or effect that can start now is running. */
  async idle(): Promise<void> {
    for (;;) {
      await Promise.allSettled([...this.requests, this.pumping, this.pumpAgain])
      await this.host.effects.idle()
      if (!this.requests.size && !this.pumping && !this.pumpAgain) return
    }
  }
  /** Run one pass, coalescing concurrent callers into a single follow-up pass. */
  async pump(): Promise<void> {
    // Do not assess, dispatch, or send while waiting for setup; queued work waits for the restart that completes setup.
    if (this.stopped || !this.host.configured() || this.host.closing()) return
    if (!this.pumping) return this.pumping = this.pumpOnce().finally(() => { this.pumping = undefined })
    const next = () => { this.pumpAgain = undefined; return this.pump() }
    return this.pumpAgain ??= this.pumping.then(next, next)
  }
  private async pumpOnce(): Promise<void> {
    this.host.effects.kick()
    if (this.host.closing()) return
    // While processing is paused, the Engine only records the pause on active Evals so they do not expire.
    this.host.engine.evaluateDue()
  }
}
