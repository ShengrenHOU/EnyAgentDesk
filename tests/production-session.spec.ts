/** Background judgments own native lifecycle handles and cannot acquire business tools. */
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type AgentHandle, type CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Sessions, type SessionsHost } from '../src/app/sessions.ts'
import type { Tool } from '../src/app/tools/tool.ts'

function fixture(consume = true) {
  const ctx = new Context(), records = new Map<string, unknown[]>(), definitions = new Map<string, ToolDefinition>()
  const agents = new Map<string, unknown>()
  const restrict = vi.fn(() => () => {}), disposed = vi.fn(), effect = vi.fn(), execute = vi.fn(async () => ({ saved: true }))
  const persistence = { flush: vi.fn(async () => {}), open: vi.fn(async (id: string) => ({
    read: async (offset: number, limit: number) => ({ events: (records.get(id) ?? []).slice(offset, offset + limit) }),
    [Symbol.asyncDispose]: async () => {},
  })) }
  const create = vi.fn(async (options: CreateAgentOptions) => {
    const scope = new Context(), id = options.sessionId
    scope.reflect.provide('tools', { restrict, register: (tool: ToolDefinition) => { definitions.set(tool.name, tool); return () => definitions.delete(tool.name) } })
    scope.reflect.provide('systemPrompt', { section: () => () => {} })
    const history = records.get(id) ?? []; records.set(id, history)
    const session = { id, header: { id }, snapshotEvents: () => history }
    const agent = { id, session, status: 'idle', inbox: { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[] },
      followup: (message: UserMessage) => {
        if (!consume) { agent.inbox.nextTurn.push(message); return }
        agent.status = 'running'
        const event = { type: 'user/message', seq: history.length, time: 1000, data: message }
        history.push(event); ctx.emit('session/event', session as never, event as never)
      } }
    await options.setup?.(scope, agent as never)
    agents.set(id, agent)
    return { agent, dispose: async () => { disposed(id); agents.delete(id); await scope.fiber.dispose() } } as unknown as AgentHandle
  })
  const resume = vi.fn(async () => { throw new SessionPersistenceNotFoundError(SessionId('missing')) })
  Object.assign(agents, { create, resume, withoutInitiator: (run: () => unknown) => run() })
  ctx.reflect.provide('agents', agents)
  ctx.reflect.provide('sessionPersistence', persistence)
  ctx.reflect.provide('sessionController', { modelCatalog: async () => ({ default: { provider: 'test', model: 'small' } }) })
  ctx.reflect.provide('llm', { resolveCallConfig: async (value: unknown) => value })
  const current = vi.fn(() => true), paused = vi.fn(() => false)
  const tools = ['orchestrator_triage_production_read', 'orchestrator_triage_production_submit', 'orchestrator_route', 'pwsh']
    .map(name => ({ name, description: name, schema: z.object({ id: z.string(), generation: z.number().optional() }), execute }))
  const host = { context: ctx, masterId: 'main', lifetime: new AbortController().signal,
    store: { settings: () => ({ eval: { model: null } }) }, effects: { handle: effect },
    health: { set: vi.fn() }, productionTools: () => tools as Tool[], assessmentCurrent: current, assessmentsPaused: paused } as unknown as SessionsHost
  const sessions = new Sessions(host)
  const send = () => sessions.productionAssessment('production-triage:batch:1', JSON.stringify({ kind: 'im_production_judgment', id: 'batch', generation: 1 }), () => { if (!current()) throw new Error('Stale') })
  return { host, ctx, sessions, send, create, resume, definitions, restrict, current, paused, disposed, execute, agents, records }
}

it('delivers once outside Main and exposes only batch-bound information tools', async () => {
  const f = fixture()
  expect(await f.send()).toBe('1970-01-01T00:00:01.000Z')
  expect(await f.send()).toBe('1970-01-01T00:00:01.000Z')
  expect(f.create).toHaveBeenCalledTimes(1)
  expect(f.create.mock.calls[0]![0].meta).toMatchObject({ parentSession: 'main', origin: 'subagent' })
  expect(f.agents.has('main')).toBe(false)
  expect([...f.definitions.keys()]).toEqual(['orchestrator_triage_production_read', 'orchestrator_triage_production_submit'])
  expect(f.restrict).toHaveBeenCalledWith({ allow: [] })
  const tool = f.definitions.get('orchestrator_triage_production_submit')!
  const context = { signal: new AbortController().signal } as never
  await expect(async () => tool.execute({ id: 'other', generation: 1 }, context)).rejects.toThrow()
  await expect(async () => tool.execute({ id: 'batch', generation: 2 }, context)).rejects.toThrow()
  expect(f.execute).not.toHaveBeenCalled()
  await expect(tool.execute({ id: 'batch', generation: 1 }, context)).resolves.toEqual({ saved: true })
  f.current.mockReturnValue(false)
  await expect(tool.execute({ id: 'batch', generation: 1 }, context)).rejects.toThrow('Stale production assessment')
  f.sessions.pruneAssessments()
  await vi.waitFor(() => expect(f.disposed).toHaveBeenCalledTimes(1))
  await f.sessions.dispose()
})

it('does not silently replace a corrupt or unreadable persisted assessment', async () => {
  const f = fixture(); f.resume.mockRejectedValue(new Error('corrupt history') as never)
  await expect(f.send()).rejects.toThrow('corrupt history')
  expect(f.create).not.toHaveBeenCalled()
  await f.sessions.dispose()
})

it('rejects background step admission during pause before consuming its request', async () => {
  const f = fixture(false); f.sessions.install()
  await expect(f.send()).rejects.toThrow('not durably consumed')
  const { agent } = await f.create.mock.results[0]!.value
  f.paused.mockReturnValue(true)
  const step = () => agentEvents(f.ctx, agent).waterfall('agent/pre-step', { messages: agent.inbox.nextTurn, turn: 1, step: 1,
    modelSelection: { provider: 'test', model: 'small' }, signal: new AbortController().signal }, async () => ({ kind: 'enter' as const, messages: agent.inbox.nextTurn }))
  expect(await step()).toEqual({ kind: 'reject' })
  expect(f.records.get(agent.id)).toHaveLength(0)
  f.paused.mockReturnValue(false)
  expect((await step()).kind).toBe('enter')
  await f.sessions.dispose()
})

it('wakes a restored consumed-but-unfinished batch once without changing its original consumption timestamp', async () => {
  const f = fixture(); const consumedAt = await f.send()
  const options = f.create.mock.calls[0]![0]
  await f.sessions.dispose()
  f.resume.mockImplementation(async () => f.create(options) as never)
  const restarted = new Sessions(f.host)
  const send = () => restarted.productionAssessment('production-triage:batch:1', JSON.stringify({ kind: 'im_production_judgment', id: 'batch', generation: 1 }), () => {})
  expect(await send()).toBe(consumedAt)
  expect([...f.records.values()][0]).toHaveLength(2)
  expect(await send()).toBe(consumedAt)
  expect([...f.records.values()][0]).toHaveLength(2)
  await restarted.dispose()
})
