/** Shared assessment admission and durable consumption are independent from unrelated user/report traffic. */
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { Sessions, type SessionsHost } from '../src/app/sessions.ts'
import { Later } from '../src/app/effects.ts'
function fixture() {
  const ctx = new Context(), history: { type: 'user/message'; seq: ReturnType<typeof SessionSeq>; time: number; surfaceOp: 'append'; data: UserMessage }[] = []
  const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[], remove(id: string) {
    return [inbox.nextTurn, inbox.nextStep].some(list => { const index = list.findIndex(message => message.id === id); if (index < 0) return false; list.splice(index, 1); return true })
  } }
  const agent = { id: SessionId('main'), session: { id: SessionId('main') }, inbox,
    followup: vi.fn((message: UserMessage) => inbox.nextTurn.push(message)), steer: vi.fn(), inject: vi.fn() } as unknown as Agent
  const read = vi.fn(async (offset: number, limit: number) => ({ events: history.slice(offset, offset + limit) }))
  const flush = vi.fn(async () => {}), open = vi.fn(async () => ({ read, [Symbol.asyncDispose]: async () => {} }))
  ctx.reflect.provide('agents', new Map([[agent.id, agent]]))
  ctx.reflect.provide('sessionPersistence', { open, flush })
  ctx.reflect.provide('sessionController', { resolveAgent: async () => ({ agent }) })
  const current = vi.fn(() => true)
  const host = { context: ctx, store: {}, prompts: {}, effects: { handle: vi.fn() }, health: { set: vi.fn() },
    masterId: agent.id, lifetime: new AbortController().signal, closing: () => false, assessmentCurrent: current } as unknown as SessionsHost
  const sessions = new Sessions(host)
  const notice = (id = 'a', generation = 1) => ({ request: `production-triage:${id}:${generation}`, text: JSON.stringify({ kind: 'im_production_judgment', id, generation }) })
  const send = (id = 'a', generation = 1) => { const value = notice(id, generation); return sessions.assessment(value.request, value.text, () => { if (!current()) throw new Error('Stale') }) }
  const consume = (message: UserMessage) => {
    inbox.remove(message.id)
    const event = { type: 'user/message' as const, seq: SessionSeq(history.length), time: 1234, surfaceOp: 'append' as const, data: message }
    history.push(event); ctx.emit('session/event', agent.session, event)
  }
  return { ctx, agent, sessions, inbox, current, read, open, flush, send, consume, history, host, notice }
}
it('acknowledges consumed A with unrelated unread B; missing/cancelled input is never inferred consumed', async () => {
  const f = fixture(); await expect(f.send()).rejects.toBeInstanceOf(Later)
  const a = f.inbox.nextTurn[0]!; f.consume(a)
  const user = createUserMessage({ content: [{ type: 'text', text: 'Owner B' }], source: { kind: 'user' } }); f.inbox.nextTurn.push(user)
  expect(await f.send()).toBe(new Date(1234).toISOString()); expect(f.inbox.nextTurn).toEqual([user])
  await expect(f.send('other')).rejects.toBeInstanceOf(Later)
  f.inbox.nextTurn.length = 0; await expect(f.send('cancelled')).rejects.toBeInstanceOf(Later)
  f.inbox.nextTurn.length = 0
  // No user/message history exists for cancelled: a retry queues it again instead of returning an ACK.
  await expect(f.send('cancelled')).rejects.toBeInstanceOf(Later)
})
it('retains injected idle notices while admitting an assessment that can wake the Main Session', async () => {
  const f = fixture()
  const injected = createUserMessage({ content: [{ type: 'text', text: 'Ticket ended' }],
    source: { kind: 'dsh-superagent', form: 'notice', summary: 'Ticket ended' } })
  f.inbox.nextStep.push(injected)
  expect(await f.sessions.candidateState('candidate:next')).toBe('ready')
  await expect(f.send()).rejects.toBeInstanceOf(Later)
  expect(f.agent.followup).toHaveBeenCalledOnce()
  expect(f.inbox.nextStep).toEqual([injected])
  expect(f.inbox.nextTurn).toHaveLength(1)
  f.consume(f.inbox.nextTurn[0]!)
  f.inbox.nextStep.push(createUserMessage({ content: injected.content, source: { kind: 'user' } }))
  expect(await f.sessions.candidateState('candidate:other')).toBe('blocked')
})
it('rechecks unread admission immediately before enqueue when owner input arrives during history loading', async () => {
  const f = fixture(); let release!: () => void
  f.read.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve }); return { events: [] } })
  const sending = f.send(); const rejected = expect(sending).rejects.toBeInstanceOf(Later)
  while (!release) await Promise.resolve()
  const owner = createUserMessage({ content: [{ type: 'text', text: 'Owner wins' }], source: { kind: 'user' } })
  f.inbox.nextTurn.push(owner); release(); await rejected
  expect(f.agent.followup).not.toHaveBeenCalled(); expect(f.inbox.nextTurn).toEqual([owner])
})
it('serializes the final unread check across simultaneous legacy and production delivery without a separate quota', async () => {
  const f = fixture()
  const a = f.sessions.assessment('candidate:eval', JSON.stringify({ kind: 'candidate', eval_id: 'eval' }), () => {})
  const b = f.send()
  const results = await Promise.allSettled([a, b]); expect(results.every(result => result.status === 'rejected')).toBe(true)
  expect(f.inbox.nextTurn).toHaveLength(1); expect(f.agent.followup).toHaveBeenCalledTimes(1)
})
it('prunes only exact generated metadata/ID pairs, never owner lookalikes or reports', async () => {
  const f = fixture(); await expect(f.send()).rejects.toBeInstanceOf(Later)
  const old = f.inbox.nextTurn[0]!, report = { ...old, id: f.sessions.promptedId('report'), content: [{ type: 'text' as const, text: '{"kind":"worker_report"}' }] } as UserMessage
  const forged = { ...old, id: f.sessions.promptedId('unrelated') } as UserMessage
  const owner = createUserMessage({ content: old.content, source: { kind: 'user' } })
  f.inbox.nextTurn.push(report, forged, owner); f.current.mockReturnValue(false); f.sessions.pruneAssessments()
  expect(f.inbox.nextTurn).toEqual([report, forged, owner]); expect(f.history).toEqual([])
})
it('uses actual persisted consumption after Sessions restart and preserves already-consumed history', async () => {
  const f = fixture(); await expect(f.send()).rejects.toBeInstanceOf(Later); f.consume(f.inbox.nextTurn[0]!)
  const restarted = new Sessions(f.host), owner = createUserMessage({ content: [], source: { kind: 'user' } }); f.inbox.nextTurn.push(owner)
  const n = f.notice(); expect(await restarted.assessment(n.request, n.text, () => {})).toBe(new Date(1234).toISOString())
  f.current.mockReturnValue(false); restarted.pruneAssessments(); expect(f.history).toHaveLength(1); expect(f.inbox.nextTurn).toEqual([owner])
})
it('filters invalid generated notices at model pre-step while preserving owner and report messages', async () => {
  const f = fixture(); f.sessions.install(); await expect(f.send()).rejects.toBeInstanceOf(Later)
  const old = f.inbox.nextTurn[0]!, owner = createUserMessage({ content: old.content, source: { kind: 'user' } })
  f.current.mockReturnValue(false)
  const decision = await agentEvents(f.ctx, f.agent).waterfall('agent/pre-step', { messages: [old, owner], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter' as const, messages: [old, owner] }))
  expect(decision).toEqual({ kind: 'enter', messages: [owner] })
})
