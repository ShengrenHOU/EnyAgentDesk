/** Exercise the installed native state owner, not a copy of its state machine. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import type { ISessions, Session } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { reconcileSessionStatus } from '../src/client/session-status.ts'

interface NativeManager {
  get(id: SessionId): Session
  getListSnapshot(): { items: SessionSummary[] }
  handleSessionAdded(summary: SessionSummary): void
  handleSessionRemoved(id: SessionId): void
  handleConnected(): void
  refreshList(): Promise<void>
}
const native = readFileSync(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-api-session-controller/client'), 'utf8')
function fixture(running = true) {
  let Manager!: new (remote: object) => NativeManager
  // Expose only the class for this test; its installed implementation stays unchanged.
  runInNewContext(native.replace('exports.apply = apply;', 'exports.TestManager = SessionManager; exports.apply = apply;'), {
    queueMicrotask, setTimeout, clearTimeout, AbortController, console,
    window: { __ModuleLoader__: { load({ factory }: { factory(require: (name: string) => object): { TestManager: typeof Manager } }) {
      Manager = factory(name => name.includes('gateway') ? { RemoteJournalStream: class {} }
        : name.includes('client-store') ? { notifySubscribers: (listeners: Set<() => void>) => { for (const fn of listeners) fn() } } : {}).TestManager
    } } },
  })
  const id = 'worker-status-test' as SessionId
  let summary: SessionSummary = { sessionId: id, running, blank: false, agentAvailable: true, updatedAt: 1 }
  const list = vi.fn(async () => ({ ok: true, value: { items: [summary] } }))
  const manager = new Manager({ session: { list } })
  manager.handleSessionAdded(summary)
  const session = manager.get(id)
  const sessions: Pick<ISessions, 'binding' | 'refresh'> = {
    // The refresh consumer reads just the session face; no scope or history is acquired.
    binding: target => target === id ? { session } as ReturnType<ISessions['binding']> : undefined,
    refresh: vi.fn(() => manager.refreshList()),
  }
  const added = (running: boolean, agentAvailable = true) => {
    summary = { ...summary, running, agentAvailable }
    manager.handleSessionAdded(summary)
    return reconcileSessionStatus(sessions, id, running)
  }
  return { manager, session, sessions, list, id, added,
    serverIdle: () => { summary = { ...summary, running: false, agentAvailable: false } } }
}

it('reconciles an idle availability summary with the already-open native Session', async () => {
  const f = fixture()
  const original = f.session
  await f.added(false, false)
  expect(f.manager.get(f.id)).toBe(original)
  expect(f.session.getSnapshot().running).toBe(false)
  expect(f.manager.getListSnapshot().items[0]?.running).toBe(false)
  expect(f.list).toHaveBeenCalledOnce()
})

it('also shows a genuinely running Agent when its availability summary arrives', async () => {
  const f = fixture(false)
  await f.added(true)
  expect(f.session.getSnapshot().running).toBe(true)
  expect(f.manager.getListSnapshot().items[0]?.running).toBe(true)
})

it('does not refresh normal matching notifications or acquire an unopened Session', async () => {
  const f = fixture()
  await f.added(true)
  await reconcileSessionStatus(f.sessions, 'worker-unopened' as SessionId, false)
  expect(f.list).not.toHaveBeenCalled()
  expect(f.session.getSnapshot().running).toBe(true)
})

it('clears a released execution while keeping its persisted history and removal flag', async () => {
  const f = fixture()
  await f.manager.refreshList()
  const events = f.session.eventSource
  f.serverIdle()
  f.manager.handleSessionRemoved(f.id)
  await reconcileSessionStatus(f.sessions, f.id, false)
  expect(f.session.getSnapshot()).toMatchObject({ running: false, removed: true })
  expect(f.session.eventSource).toBe(events)
})

it('keeps newer lifecycle notifications ahead of an in-flight list response', async () => {
  const f = fixture()
  const response = Promise.withResolvers<Awaited<ReturnType<typeof f.list>>>()
  f.list.mockImplementationOnce(() => response.promise)
  const first = f.sessions.refresh()
  const correction = f.added(false, false)
  response.resolve({ ok: true, value: { items: [{ sessionId: f.id, running: true, agentAvailable: true, blank: false, updatedAt: 1 }] } })
  await Promise.all([first, correction])
  expect(f.list).toHaveBeenCalledOnce()
  expect(f.session.getSnapshot().running).toBe(false)
})

it('lets the native reconnect baseline repair a missed completion event', async () => {
  const f = fixture()
  f.list.mockResolvedValue({ ok: true, value: { items: [{ sessionId: f.id, running: false, agentAvailable: false, blank: false, updatedAt: 1 }] } })
  f.manager.handleConnected()
  await f.manager.refreshList()
  expect(f.session.getSnapshot().running).toBe(false)
})
