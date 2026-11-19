/** Real worker resources and SQLite protections, with a native-contract job registry fixture. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { Store } from '../src/app/store.ts'
import { ReadJobs } from '../src/app/read-jobs.ts'
import { jobRegistry } from './fixtures/host.ts'
import { runningJobs } from '../src/executor/background.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { Trigger } from '../src/core/model.ts'
import { MessagePort } from 'node:worker_threads'

const startup = vi.hoisted(() => ({ fail: false, ports: new Set<import('node:worker_threads').MessagePort>() }))
vi.mock('node:worker_threads', async original => {
  const actual = await original<typeof import('node:worker_threads')>()
  return { ...actual, Worker: class extends actual.Worker {
    constructor(file: string | URL, options?: import('node:worker_threads').WorkerOptions) {
      if (startup.fail) { startup.fail = false; throw new Error('Worker initialization failed') }
      super(file, options)
    }
  }, MessageChannel: class extends actual.MessageChannel {
    constructor() { super(); startup.ports.add(this.port1); startup.ports.add(this.port2) }
  } }
})

it('releases access ports if the OS refuses to create the worker', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'read-startup-')), store = new Store(join(directory, 'state.sqlite'))
  const registry = jobRegistry(), jobs = new ReadJobs({ jobs: registry.service } as unknown as Context, store)
  const close = vi.spyOn(MessagePort.prototype, 'close')
  try {
    startup.fail = true
    expect(() => jobs.run('stats')).toThrow('Worker initialization failed')
    expect(close).toHaveBeenCalledTimes(2)
    expect(registry.service.list('owner')).toHaveLength(0)
  } finally {
    for (const port of startup.ports) port.close()
    startup.ports.clear(); close.mockRestore(); await jobs.close(); store.close(); rmSync(directory, { recursive: true, force: true })
  }
})

it('coalesces read jobs, returns canonical views and releases native registrations before shutdown', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'read-jobs-')), store = new Store(join(directory, 'state.sqlite'))
  const registry = jobRegistry(), context = { jobs: registry.service, get: () => registry.service } as unknown as Context
  const jobs = new ReadJobs(context, store)
  try {
    const first = jobs.run('stats')
    expect(jobs.run('stats')).toBe(first)
    expect(registry.service.list('owner')).toHaveLength(1)
    expect(runningJobs(context, 'worker')).toEqual([])
    expect(await first).toEqual({ received: 0, filtered: 0, triggers: 0, judged: 0, accepted: 0, dropped: 0 })
    expect(registry.service.list('owner')).toHaveLength(0)
    expect(await jobs.run('lines')).toMatchObject({ open: [], closed: [], closedTotal: 0 })
  } finally { await jobs.close(); store.close(); rmSync(directory, { recursive: true, force: true }) }
  await expect(jobs.run('stats')).rejects.toThrow('closed')
})

it('cancels an unfinished native producer and waits for its worker to exit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'read-jobs-cancel-')), store = new Store(join(directory, 'state.sqlite'))
  const registry = jobRegistry(), jobs = new ReadJobs({ jobs: registry.service } as unknown as Context, store)
  const pending = jobs.run('stats')
  const failed = expect(pending).rejects.toThrow('Read worker exited')
  await jobs.close(); await failed
  expect(registry.service.kill).toHaveBeenCalledOnce()
  expect(registry.service.list('owner')).toHaveLength(0)
  store.close(); rmSync(directory, { recursive: true, force: true })
})

it('opens a read-only Store without migration writes and rejects mutations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'readonly-store-')), path = join(directory, 'state.sqlite')
  new Store(path).close()
  const reader = new Store(path, () => {}, () => {}, { readOnly: true })
  try { expect(() => reader.set('unexpected-write', true)).toThrow(/readonly/i) }
  finally { reader.close(); rmSync(directory, { recursive: true, force: true }) }
})

it('serializes different pages of one view kind instead of spawning unbounded workers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'read-pages-')), store = new Store(join(directory, 'state.sqlite'))
  const registry = jobRegistry(), jobs = new ReadJobs({ jobs: registry.service } as unknown as Context, store)
  try {
    const first = jobs.run('line', { id: 'a' }), second = jobs.run('line', { id: 'b' })
    expect(registry.service.list('owner')).toHaveLength(1)
    expect(await Promise.all([first, second])).toEqual([undefined, undefined])
    expect(registry.service.list('owner')).toHaveLength(0)
  } finally { await jobs.close(); store.close(); rmSync(directory, { recursive: true, force: true }) }
})

// This scenario waits for three real worker starts and exits, which can exceed Vitest's default on the Windows runner.
it('isolates audit graphs while the live Source owns access and rejects results across revocation', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'read-audit-')), store = new Store(join(directory, 'state.sqlite'))
  store.saveSettings({})
  const sources = new SourceRegistry(() => store.settings())
  sources.register({ kind: 'im', title: { en: 'IM', zh: 'IM' }, description: { en: 'IM', zh: 'IM' }, schema: z.object({}), fields: [], health: [],
    scope: () => ({ listened: true, observed: true }), imEvidence: trigger => ({ provider: 'im', account: 'owner', conversation: 'chat', message: trigger.id, version: '1', partial: false }) })
  const at = new Date().toISOString(), trigger: Trigger = { id: 'a', source: 'im', threads: [], at, human: true, actor: { source: 'im', id: 'sender' }, text: 'private text', meta: {} }
  store.triggers.save(trigger)
  const evidence = sources.imEvidence(trigger)!, { configuration: _configuration, ...identity } = evidence
  store.set('triage-production:a', { id: 'a', generation: 1, state: 'completed', createdAt: at, inputs: [{ triggerId: 'a', identity,
    fingerprint: createHash('sha256').update(JSON.stringify({ trigger, evidence })).digest('hex') }], contexts: {} })
  store.set('triage-matter:a', { id: 'a', scope: 'scope', revision: 1, title: 'Private goal', reason: 'Private basis', assessment: 'unknown', anchorBatchId: 'a', createdAt: at, updatedAt: at })
  const registry = jobRegistry(), jobs = new ReadJobs({ jobs: registry.service } as unknown as Context, store, sources)
  try {
    expect((await jobs.run('matters')).groups[0]).toMatchObject({ title: 'Private goal', redacted: false })
    const resolve = sources.imEvidence.bind(sources)
    const spy = vi.spyOn(sources, 'imEvidence').mockImplementationOnce(input => {
      const value = resolve(input)
      store.saveSettings({ ...store.settings(), sources: { im: { enabled: false, config: {} } } })
      return value
    })
    await expect(jobs.run('matters')).rejects.toThrow('Source configuration changed')
    spy.mockRestore()
    const revoked = await jobs.run('matters')
    expect(revoked.groups[0]!.redacted).toBe(true)
    expect(JSON.stringify(revoked)).not.toContain('Private goal')
    expect(registry.service.list('owner')).toHaveLength(0)
  } finally { await jobs.close(); store.close(); rmSync(directory, { recursive: true, force: true }) }
})
