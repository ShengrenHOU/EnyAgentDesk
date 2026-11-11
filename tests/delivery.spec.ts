import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { AgentDelivery } from '../src/infra/delivery.ts'
import { Sessions } from '../src/app/sessions.ts'
import { Later } from '../src/app/effects.ts'

function fixture(history: UserMessage[] = []) {
  const ctx = new Context()
  const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[], remove: (id: string) => {
    for (const list of [inbox.nextTurn, inbox.nextStep]) { const i = list.findIndex(message => message.id === id); if (i >= 0) { list.splice(i, 1); return true } }
    return false
  } }
  const steer = vi.fn((message: UserMessage) => { inbox.nextStep.push(message) })
  const followup = vi.fn((message: UserMessage) => { inbox.nextTurn.push(message) })
  const injected = vi.fn((_message: UserMessage) => {})
  // Only the delivery-facing Agent methods participate in this fixture.
  const agent = { id: SessionId('delivery-test'), session: {}, inbox, steer, followup, inject: injected } as unknown as Agent
  const event = (message: UserMessage): SessionEvent => ({ type: 'user/message', seq: SessionSeq(0), time: 0, surfaceOp: 'append', data: message })
  const read = vi.fn(async (offset: number, length: number) => ({ events: history.slice(offset, offset + length).map(event) }))
  const close = vi.fn(async () => {})
  const flush = vi.fn(async () => {})
  const open = vi.fn(async () => ({ read, [Symbol.asyncDispose]: close }))
  const agents = new Map([[agent.id, agent]])
  ctx.reflect.provide('agents', agents)
  ctx.reflect.provide('sessionPersistence', { open, flush })
  ctx.reflect.provide('sessionController', { resolveAgent: async () => ({ agent }) })
  const delivery = new AgentDelivery(ctx)
  const signal = new AbortController()
  const send = (id = 'request', mode: 'queue' | 'steer' = 'steer') => delivery.send(agent, id, '{"event_id":"event"}', mode, signal.signal)
  const inject = (id: string, summary: string) => delivery.send(agent, id, '{"settings_saved":"policy"}', { inject: summary }, signal.signal)
  const holds = (id: string) => delivery.holds(agent, id)
  const consume = (message: UserMessage) => {
    inbox.nextStep.splice(0); inbox.nextTurn.splice(0)
    ctx.emit('session/event', agent.session, event(message))
  }
  return { ctx, delivery, agent, agents, inbox, steer, followup, injected, open, read, close, flush, send, inject, holds, consume, signal }
}

it.each(['queue', 'steer'] as const)('delivers %s as an orchestrator relay, deduplicating pending and consumed messages', async mode => {
  const f = fixture()
  await f.send('request', mode)
  const target = mode === 'queue' ? f.followup : f.steer
  expect(target).toHaveBeenCalledOnce()
  const message = target.mock.calls[0]![0]
  expect(message.role).toBe('user')
  expect(message.source).toEqual({ kind: 'dsh-superagent', form: 'relay' })
  expect(Object.isFrozen(message)).toBe(true)
  await f.send('request', mode)
  f.consume(message)
  await f.send('request', mode)
  expect(target).toHaveBeenCalledOnce()
  expect(f.open).toHaveBeenCalledOnce()
  expect(f.close).toHaveBeenCalledOnce()
  const restored = fixture([message])
  await restored.send('request', mode)
  expect(restored.steer).not.toHaveBeenCalled()
  expect(restored.followup).not.toHaveBeenCalled()
})

it.each(['pending', 'consumed', 'live'] as const)('recognizes legacy plugin identity in %s input without rewriting it', async location => {
  // Bypass TypeScript's current source union to construct the retired serialized shape.
  const old: UserMessage = JSON.parse(JSON.stringify({ id: 'dsh-superagent:request', role: 'user', content: [], source: { kind: 'plugin', plugin: 'dsh-superagent', form: 'relay' } }))
  const before = JSON.stringify(old)
  const f = fixture(location === 'consumed' ? [old] : [])
  if (location === 'pending') f.inbox.nextTurn.push(old)
  if (location === 'live') f.read.mockImplementationOnce(async () => { f.consume(old); return { events: [] } })
  await f.send()
  expect(f.steer).not.toHaveBeenCalled()
  expect(JSON.stringify(old)).toBe(before)
  await f.send('different-request')
  expect(f.steer).toHaveBeenCalledOnce()
})

it.each(['another-plugin', undefined])('does not treat a legacy plugin source %s as this producer', async plugin => {
  const old: UserMessage = JSON.parse(JSON.stringify({ id: 'dsh-superagent:request', role: 'user', content: [], source: { kind: 'plugin', plugin, form: 'relay' } }))
  const f = fixture([old])
  await f.send()
  expect(f.steer).toHaveBeenCalledOnce()
})

it.each(['pending', 'consumed'] as const)('recognizes legacy user RPC identity in %s input', async location => {
  const old = createUserMessage({ content: [{ type: 'text', text: 'old relay' }], source: { kind: 'user', rpcId: 'request' } })
  const f = fixture(location === 'consumed' ? [old] : [])
  if (location === 'pending') f.inbox.nextTurn.push(old)
  await f.send()
  expect(f.steer).not.toHaveBeenCalled()
  expect(old.source.kind).toBe('user')
  await f.send('different-request')
  expect(f.steer).toHaveBeenCalledOnce()
})

it('retries a failed durability barrier without another delivery and permits concurrent retries', async () => {
  const f = fixture()
  f.flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk busy'))
  await expect(f.send()).rejects.toThrow('disk busy')
  f.consume(f.steer.mock.calls[0]![0])
  await Promise.all([f.send(), f.send()])
  expect(f.steer).toHaveBeenCalledOnce()
  expect(f.flush).toHaveBeenCalledTimes(4)
})

it('retries history failures and reads past the first page', async () => {
  const old = createUserMessage({ content: [], source: { kind: 'user', rpcId: 'request' } })
  const f = fixture([...Array.from({ length: 512 }, () => createUserMessage({ content: [], source: { kind: 'user' } })), old])
  f.read.mockRejectedValueOnce(new Error('read failed'))
  await expect(f.send()).rejects.toThrow('read failed')
  await f.send()
  expect(f.steer).not.toHaveBeenCalled()
  expect(f.close).toHaveBeenCalledTimes(2)
})

it('keeps consumption that happens during the initial history read', async () => {
  const f = fixture()
  const old = createUserMessage({ content: [], source: { kind: 'user', rpcId: 'request' } })
  f.read.mockImplementationOnce(async () => { f.consume(old); return { events: [] } })
  await f.send()
  expect(f.steer).not.toHaveBeenCalled()
})

it('does not dispatch when cancelled or disposed during history loading', async () => {
  const cancelled = fixture()
  cancelled.read.mockImplementationOnce(async () => { cancelled.signal.abort(); return { events: [] } })
  await expect(cancelled.send()).rejects.toThrow()
  expect(cancelled.steer).not.toHaveBeenCalled()
  const disposed = fixture()
  disposed.read.mockImplementationOnce(async () => { disposed.agents.clear(); return { events: [] } })
  await expect(disposed.send()).rejects.toThrow('disposed')
  expect(disposed.steer).not.toHaveBeenCalled()
})

it('injects a notice once, as dsh-superagent\'s notice with its summary, without waking the agent', async () => {
  const f = fixture()
  await f.inject('notice:settings', 'Settings saved')
  await f.inject('notice:settings', 'Settings saved')
  expect(f.injected).toHaveBeenCalledOnce()
  expect(f.injected.mock.calls[0]![0]).toMatchObject({ role: 'user', source: { kind: 'dsh-superagent', form: 'notice', summary: 'Settings saved' } })
  expect([f.steer, f.followup].map(spy => spy.mock.calls.length)).toEqual([0, 0])
})

it('tells whether the Session holds a message: one waiting in its inbox, one it took, and one in its stored history', async () => {
  const f = fixture()
  expect(await f.holds('request')).toBe(false)
  await f.send('request')
  expect(await f.holds('request')).toBe(true)
  f.consume(f.steer.mock.calls[0]![0])
  expect([f.inbox.nextStep.length, await f.holds('request')]).toEqual([0, true])
  const restored = fixture([f.steer.mock.calls[0]![0]])
  expect([await restored.holds('request'), await restored.holds('other')]).toEqual([true, false])
})


it('holds a burst outside the native inbox until each candidate is consumed, without blocking owner input', async () => {
  const f = fixture()
  const active = new Set(Array.from({ length: 400 }, (_, i) => `e${i}`))
  const sessions = new Sessions({ context: f.ctx, masterId: f.agent.id, lifetime: f.signal.signal,
    effects: { handle: vi.fn() }, assessmentCurrent: (notice: { id: string }) => active.has(notice.id) } as never)
  const deliver = (i: number) => sessions.assessment(`candidate:e${i}`, JSON.stringify({ kind: 'candidate', trigger_id: `t${i}`, eval_id: `e${i}` }), () => {})
  const attempts = await Promise.allSettled(Array.from({ length: 400 }, (_, i) => deliver(i)))
  expect(attempts.every(result => result.status === 'rejected' && result.reason instanceof Later)).toBe(true)
  expect(f.inbox.nextTurn).toHaveLength(1)
  expect(f.followup).toHaveBeenCalledOnce()
  f.consume(f.inbox.nextTurn[0]!)
  await expect(deliver(0)).resolves.toBe(new Date(0).toISOString())
  await expect(deliver(1)).rejects.toBeInstanceOf(Later)
  expect(f.inbox.nextTurn).toHaveLength(1)
})

it('acknowledges a consumed candidate while other input waits, instead of deferring its deadline', async () => {
  const f = fixture()
  const active = new Set(Array.from({ length: 400 }, (_, i) => `e${i}`))
  const sessions = new Sessions({ context: f.ctx, masterId: f.agent.id, lifetime: f.signal.signal,
    effects: { handle: vi.fn() }, assessmentCurrent: (notice: { id: string }) => active.has(notice.id) } as never)
  await expect(sessions.assessment('candidate:e1', JSON.stringify({ kind: 'candidate', trigger_id: 't1', eval_id: 'e1' }), () => {})).rejects.toBeInstanceOf(Later)
  f.consume(f.inbox.nextTurn[0]!)
  // A person's message waiting behind the notice must not hold the consumed assessment's deadline.
  f.inbox.nextTurn.push(createUserMessage({ content: [{ type: 'text', text: 'owner' }], source: { kind: 'user' } }))
  expect(await sessions.candidateState('candidate:e1')).toBe('consumed')
  await expect(sessions.assessment('candidate:e1', JSON.stringify({ kind: 'candidate', trigger_id: 't1', eval_id: 'e1' }), () => {})).resolves.toBe(new Date(0).toISOString())
  expect(await sessions.candidateState('candidate:e2')).toBe('blocked')
  f.consume(f.inbox.nextTurn[0]!)
  expect(await sessions.candidateState('candidate:e2')).toBe('ready')
})

it('prunes decided and superseded plugin candidates while preserving user instructions and reports', async () => {
  const f = fixture()
  const active = new Set(Array.from({ length: 400 }, (_, i) => `e${i}`))
  const sessions = new Sessions({ context: f.ctx, masterId: f.agent.id, lifetime: f.signal.signal,
    effects: { handle: vi.fn() }, assessmentCurrent: (notice: { id: string }) => active.has(notice.id) } as never)
  active.clear(); active.add('old-eval')
  await expect(sessions.assessment('candidate:old-eval', JSON.stringify({ kind: 'candidate', trigger_id: 'old', eval_id: 'old-eval' }), () => {})).rejects.toBeInstanceOf(Later)
  await f.delivery.send(f.agent, 'report', JSON.stringify({ kind: 'worker_report', trigger_id: 'old' }), 'queue', f.signal.signal)
  const user = createUserMessage({ content: [{ type: 'text', text: '{"kind":"candidate","trigger_id":"old"}' }], source: { kind: 'user' } })
  f.inbox.nextTurn.push(user)
  active.delete('old-eval'); active.add('new-eval')
  sessions.pruneAssessments()
  expect(f.inbox.nextTurn).toHaveLength(2)
  expect(f.inbox.nextTurn).toContain(user)
  expect(f.inbox.nextTurn.some(message => message.content.some(block => block.type === 'text' && block.text.includes('worker_report')))).toBe(true)
  await expect(sessions.assessment('candidate:new-eval', JSON.stringify({ kind: 'candidate', trigger_id: 'old', eval_id: 'new-eval' }), () => {})).rejects.toBeInstanceOf(Later)
  expect(f.inbox.nextTurn).toHaveLength(2)
})

it('retains pre-upgrade candidates without exact eval metadata until consumed, without silently freeing admission', async () => {
  const f = fixture()
  const sessions = new Sessions({ context: f.ctx, masterId: f.agent.id, lifetime: f.signal.signal,
    effects: { handle: vi.fn() }, assessmentCurrent: () => false } as never)
  await f.delivery.send(f.agent, 'legacy-candidate', JSON.stringify({ kind: 'candidate', trigger_id: 'old' }), 'queue', f.signal.signal)
  const old = f.inbox.nextTurn[0]!
  sessions.pruneAssessments()
  expect(f.inbox.nextTurn).toEqual([old])
  expect(await sessions.candidateState('candidate:new')).toBe('blocked')
  f.consume(old)
  expect(await sessions.candidateState('candidate:new')).toBe('ready')
})
