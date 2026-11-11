import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { KV } from '../src/kv.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let host: Host
beforeEach(async () => { host = await startRuntime() })
afterEach(async () => { vi.useRealTimers(); await host.stop() })

it('holds a transient DSH retry while its ticket is paused and resumes it once', async () => {
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', 'Read the document'))
  const agent = host.agents.get(sessionId)!
  const retries = () => host.deliveries.mock.calls.filter(([m]) => m.sessionId === sessionId && m.text.includes('passing reason'))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  host.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: Object.assign(new Error('Service Unavailable'), { status: 503 }) } as never)
  await host.runTool(host.runtime.masterId, 'orchestrator_ticket_manage', { ticket_id: ticket.id, change: { paused: true } })
  await vi.advanceTimersByTimeAsync(20_000)
  expect(retries()).toHaveLength(0)
  await host.runTool(host.runtime.masterId, 'orchestrator_ticket_manage', { ticket_id: ticket.id, change: { paused: false } })
  await vi.advanceTimersByTimeAsync(5000)
  expect(retries()).toHaveLength(1)
})

it('prepares a DSH workspace with the native platform shell', async () => {
  const settings = host.runtime.store.settings()
  const command = process.platform === 'win32' ? "Write-Output 'prepared'" : "printf prepared"
  host.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: command } })
  await host.acceptedTicket(feishu('1', 'Prepare the workspace'))
  const argv = process.platform === 'win32' ? ['pwsh', '-NoProfile', '-NonInteractive', '-Command', command] : ['sh', '-c', command]
  expect(host.subprocess.spawn.mock.calls.some(([spec]) => JSON.stringify(spec.argv) === JSON.stringify(argv))).toBe(true)
})

it('holds a DSH launch paused while workspace preparation was in flight', async () => {
  const prepare = Promise.withResolvers<void>()
  host.hooks.prepare = prepare.promise
  const settings = host.runtime.store.settings()
  host.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: 'echo prepare' } })
  const accepted = host.acceptedTicket(feishu('1', 'Prepare before working'))
  await vi.waitFor(() => expect(host.subprocess.spawn.mock.calls.some(([spec]) => spec.argv.at(-1) === 'echo prepare')).toBe(true))
  const ticket = host.runtime.store.tickets.open()[0]!
  host.runtime.store.tickets.save({ ...ticket, paused: true })
  prepare.resolve()
  const { sessionId } = await accepted
  expect(host.deliveries.mock.calls.filter(([m]) => m.sessionId === sessionId)).toHaveLength(0)
})

it('does not launch a worker from a non-empty workspace left by failed preparation', async () => {
  const prepare = Promise.withResolvers<void>()
  host.hooks.prepare = prepare.promise
  const settings = host.runtime.store.settings()
  host.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: 'echo prepare' } })
  const accepted = host.acceptedTicket(feishu('1', 'Prepare before working'))
  await vi.waitFor(() => expect(host.subprocess.spawn.mock.calls.some(([spec]) => spec.argv.at(-1) === 'echo prepare')).toBe(true))
  const ticket = host.runtime.store.tickets.open()[0]!
  await mkdir(ticket.execution!.directory, { recursive: true })
  expect(host.runtime.store.get(KV.dsh.preparing(ticket.id))).toBe(ticket.execution!.directory)
  await writeFile(join(ticket.execution!.directory, 'partial.txt'), 'unfinished preparation')
  prepare.reject(new Error('prepare failed after writing files'))
  const { sessionId } = await accepted
  expect(host.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)).toMatchObject({ report: { state: 'failed' } })
  host.hooks.prepare = undefined
  await host.runtime.engine.retryTicket(ticket.id)
  await host.runtime.idle()
  expect(host.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)).toMatchObject({ report: { state: 'failed' } })
  expect(host.deliveries.mock.calls.filter(([m]) => m.sessionId === sessionId)).toHaveLength(0)
  expect(await readFile(join(ticket.execution!.directory, 'partial.txt'), 'utf8')).toBe('unfinished preparation')
  expect(host.subprocess.spawn.mock.calls.filter(([spec]) => spec.argv.at(-1) === 'echo prepare')).toHaveLength(1)
  // An operator can preserve the failed attempt elsewhere and explicitly retry a fresh workspace.
  await rename(ticket.execution!.directory, ticket.execution!.directory + '.partial')
  await host.runtime.engine.retryTicket(ticket.id)
  await host.runtime.idle()
  expect(host.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'running' })
  expect(host.runtime.store.get(KV.dsh.preparing(ticket.id))).toBeUndefined()
  expect(host.subprocess.spawn.mock.calls.filter(([spec]) => spec.argv.at(-1) === 'echo prepare')).toHaveLength(2)
})

it('a DSH-only profile launches urgent work ahead of older normal work', async () => {
  const settings = host.runtime.store.settings()
  host.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  await host.runtime.settings.pause(true, 'panel')
  const normal = await host.acceptedTicket(feishu('1', 'Normal work'))
  const urgent = await host.acceptedTicket(feishu('2', 'Urgent work'))
  await host.runTool(host.runtime.masterId, 'orchestrator_ticket_manage', { ticket_id: urgent.ticket.id, change: { priority: 'urgent' } })
  await host.runtime.settings.pause(false, 'panel')
  await host.runtime.idle()
  expect(host.agents.get(urgent.sessionId)?.status).toBe('running')
  expect(host.agents.has(normal.sessionId)).toBe(false)
})

it('keeps a follow-up queued when its DSH ticket is paused during session restoration', async () => {
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', 'Read the document'))
  host.agents.delete(sessionId)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  host.controller.resolveAgent.mockImplementation(async id => {
    if (id === sessionId) { entered.resolve(); await release.promise }
    return host.resolveDefault(id)
  })
  host.runtime.receive(feishu('2', 'Additional detail', { root_id: 'om_1' }))
  const delivery = host.runtime.idle()
  await entered.promise
  host.runtime.store.tickets.save({ ...host.runtime.store.tickets.get(ticket.id)!, paused: true })
  release.resolve()
  await delivery
  expect(host.runtime.store.tickets.get(ticket.id)!.undelivered).toHaveLength(1)
  expect(host.deliveries.mock.calls.filter(([m]) => m.sessionId === sessionId)).toHaveLength(1)
})
