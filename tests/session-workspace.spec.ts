/** Sidebar grouping never changes the main or worker Session's execution directory. */
import { afterEach, expect, it } from 'vitest'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

it('reuses one native Main Workspace without changing its execution directory', async () => {
  h = await startRuntime()
  const created = h.controller.create.mock.calls.map(([options]) => options as { sessionId: string; cwd?: string; workspaceId?: string })
  const main = created.find(options => options.sessionId === h!.runtime.masterId)!
  expect(main).toMatchObject({ cwd: h.directory })
  expect(main).not.toHaveProperty('workspaceId')
  expect(h.workspaces.size).toBe(1)
})

it('starts a worker in its ticket directory without creating a sidebar Workspace', async () => {
  h = await startRuntime()
  const { sessionId, ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const created = h.controller.create.mock.calls.map(([options]) => options as { sessionId: string; cwd?: string; workspaceId?: string })
  const worker = created.find(options => options.sessionId === sessionId)!
  expect(worker.cwd).toBe(ticket.execution!.directory)
  expect(worker).not.toHaveProperty('workspaceId')
  expect(h.workspaces.size).toBe(1)
  expect([...h.workspaces.values()][0]!.sessionIds).not.toContain(sessionId)
})

it('reuses the canonical registration across repeated Main ensures', async () => {
  h = await startRuntime()
  const legacy = await h.workspaceRegistry.create(h.directory)
  legacy.sessionIds = [h.runtime.masterId]
  await h.runtime.sessions.ensure(h.runtime.masterId, h.directory, 'dsh-superagent orchestrator', 'orchestrator')
  expect(legacy.sessionIds).toEqual([h.runtime.masterId])
  expect(h.workspaces.has(legacy.id)).toBe(true)
  expect(h.workspaces.size).toBe(1)
})

it('preserves other Sessions sharing the canonical Main Workspace', async () => {
  h = await startRuntime()
  const occupied = await h.workspaceRegistry.create(h.directory)
  occupied.sessionIds = [h.runtime.masterId, 'another-session']
  await h.runtime.sessions.ensure(h.runtime.masterId, h.directory, 'dsh-superagent orchestrator', 'orchestrator')
  expect(occupied.sessionIds).toEqual([h.runtime.masterId, 'another-session'])
  expect(h.workspaces.has(occupied.id)).toBe(true)
})
