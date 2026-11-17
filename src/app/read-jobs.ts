/** Read-only computation uses native DSH Jobs for observation and cancellation. */
import { MessageChannel, Worker } from 'node:worker_threads'
import type { Context } from '@deepseek-ai/cordis'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { ReadPage, ReadResults } from './read-models.ts'
import type { Store } from './store.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Trigger } from '../core/model.ts'
import { KV } from '../kv.ts'

declare module '@deepseek-ai/dsh-jobs/view' {
  interface JobKindMap { superagentRead: 'superagent-read' }
}

/** Owns read producers and coalesces identical in-flight views without caching completed business data. */
export class ReadJobs {
  private readonly active = new Map<keyof ReadResults, { key: string; promise: Promise<ReadResults[keyof ReadResults]> }>()
  private readonly cancel = new Set<() => void>()
  private readonly release: () => void
  private closed = false
  constructor(private readonly ctx: Context, private readonly store: Store, private readonly sources?: SourceRegistry) {
    this.release = ctx.jobs.attachController('Superagent read views')
  }
  run<K extends keyof ReadResults>(kind: K, page?: ReadPage): Promise<ReadResults[K]> {
    if (this.closed) return Promise.reject(new Error('Read jobs are closed'))
    const key = JSON.stringify([kind, page]), current = this.active.get(kind)
    if (current) return current.key === key ? current.promise as Promise<ReadResults[K]>
      // A failed page does not prevent a different read; each view kind owns at most one worker.
      : current.promise.then(() => this.run(kind, page), () => this.run(kind, page))
    const result = Promise.withResolvers<ReadResults[K]>(), completion = Promise.withResolvers<JobOutcome>()
    const revision = this.store.get(KV.settings.revision)
    const kinds = new Map(this.sources?.instances().map(instance => [instance.id, this.sources?.kind(instance.id)]))
    const assertAccess = () => {
      const current = this.sources?.instances() ?? []
      if (revision !== this.store.get(KV.settings.revision) || current.length !== kinds.size || current.some(instance => this.sources?.kind(instance.id) !== kinds.get(instance.id)))
        throw new Error('Source configuration changed; reload this view')
    }
    let failure: Error | undefined, received = false
    const jobId = this.ctx.jobs.start({ kind: 'superagent-read', label: `Read ${kind}`, run: () => {
      const source = import.meta.url.endsWith('.ts')
      const { port1, port2 } = new MessageChannel(), signal = new SharedArrayBuffer(4)
      port1.on('message', (trigger: Trigger) => {
        try {
          assertAccess()
          if (!this.sources) throw new Error('Evidence reads require the live Source owner')
          const evidence = this.sources.imEvidence(trigger)
          port1.postMessage({ value: evidence ? { evidence, header: this.sources.imHeader(trigger) } : {} })
        } catch (error) { port1.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
        finally { Atomics.store(new Int32Array(signal), 0, 1); Atomics.notify(new Int32Array(signal), 0) }
      })
      let worker: Worker
      try {
        worker = new Worker(new URL(source ? './read-worker.ts' : './read-worker.js', import.meta.url),
          { workerData: { path: this.store.path, kind, page, at: Date.now(), access: { port: port2, signal } }, transferList: [port2],
            env: {}, execArgv: source ? ['--experimental-transform-types'] : [] })
      } catch (error) { port1.close(); port2.close(); throw error }
      worker.once('message', (frame: { ok: true; value: ReadResults[K] } | { ok: false; error: string }) => {
        received = true
        if (frame.ok) {
          try { assertAccess(); result.resolve(frame.value) }
          catch (error) { failure = error instanceof Error ? error : new Error(String(error)); result.reject(failure) }
        }
        else { failure = new Error(frame.error); result.reject(failure) }
      })
      worker.once('error', error => { failure = error; result.reject(error) })
      worker.once('exit', code => {
        port1.close()
        if (!received && !failure) { failure = new Error(`Read worker exited (${code})`); result.reject(failure) }
        completion.resolve({ status: failure ? 'failed' : 'completed', detail: failure ? 'Read model failed' : undefined })
      })
      return { done: completion.promise, cancel: () => { void worker.terminate() } }
    } })
    const stop = () => { this.ctx.jobs.kill(jobId, undefined, 'Read view owner is closing') }
    this.cancel.add(stop)
    const promise = result.promise.finally(async () => {
      try {
        await completion.promise
        // Producer cleanup precedes the registry's terminal commit and output drain.
        await this.ctx.jobs.wait(jobId, 10_000)
        this.ctx.jobs.remove(jobId)
      } finally { this.cancel.delete(stop); this.active.delete(kind) }
    })
    this.active.set(kind, { key, promise })
    return promise
  }
  async close(): Promise<void> {
    this.closed = true
    for (const stop of this.cancel) stop()
    await Promise.allSettled([...this.active.values()].map(current => current.promise))
    this.release()
  }
}
