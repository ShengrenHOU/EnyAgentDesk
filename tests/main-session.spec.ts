/** The logical Main entry and its delivery route follow one persisted current-session pointer. */
import { SessionId } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { MAIN_SEGMENT_EVENTS } from '../src/app/main-sessions.ts'
import { followupSchedule, type HostSchedule, type NativeReminder } from '../src/app/host-schedule.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

function largeMain(host: Host): Agent {
  const agent = host.ctx.agents.get(host.runtime.masterId as SessionId)!
  Object.defineProperty(agent.session, 'seq', { value: MAIN_SEGMENT_EVENTS, configurable: true })
  vi.spyOn(agent.session, 'deriveMessages').mockReturnValue([createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the authorized project; preserve its pending decision.' }] })])
  return agent
}
async function confirmHandoff(host: Host): Promise<void> {
  host.consume()
  const current = host.ctx.agents.get(host.runtime.masterId as SessionId)!
  if (current.session.header.parentSession) host.runtime.mainSessions.view({ sessionId: current.session.header.parentSession, viewId: 'closed-test-view', active: false })
  host.runtime.store.db.prepare("UPDATE effect SET due=0 WHERE kind IN ('mainRetire','mainForward','mainContext')").run()
  await host.runtime.idle()
}

it('moves the native entry, prompt view and relay destination together without changing tickets', async () => {
  const host = await startRuntime()
  try {
    const { runtime } = host, previous = runtime.masterId, next = 'orchestrator-next'
    const tickets = runtime.store.tickets.list()
    await host.ctx.sessionController.create({ sessionId: SessionId(next) })
    runtime.store.set(KV.runtime.masterId, next)
    await runtime.sessions.ensure(next, runtime.machine.stateDir, 'Main', 'orchestrator')
    expect((await host.api('GET', 'state')).body).toMatchObject({ masterId: next })
    expect((await host.api('GET', 'prompts')).body).toMatchObject({ masterId: next })
    runtime.sessions.relay('current-main-check', JSON.stringify({ kind: 'segment-test' }))
    await runtime.idle()
    expect(host.relays(next)).toContainEqual({ kind: 'segment-test' })
    expect(host.relays(previous)).not.toContainEqual({ kind: 'segment-test' })
    expect(runtime.store.tickets.list()).toEqual(tickets)
  } finally { await host.stop() }
})

it('prepares a native Main with a non-authoritative handoff and retires only the old segment', async () => {
  const host = await startRuntime()
  try {
    const previous = largeMain(host), tickets = host.runtime.store.tickets.list()
    host.runtime.mainSessions.maintain(); await host.runtime.idle()
    const id = host.runtime.masterId, next = host.ctx.agents.get(id as SessionId)!
    expect(id).not.toBe(previous.id)
    expect(next.session.header).toMatchObject({ parentSession: previous.id, agentPreset: 'dsh-superagent-router' })
    expect(next.session.header.origin).toBeUndefined()
    const message = vi.mocked(next.inject).mock.calls[0]![0]
    expect(message.source).toMatchObject({ kind: 'dsh-superagent', form: 'notice' })
    expect(JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join('')))
      .toMatchObject({ kind: 'main_segment_handoff', previousSessionId: previous.id, throughSeq: MAIN_SEGMENT_EVENTS })
    expect(host.workspaceRegistry.archivedSessionIds).not.toContain(previous.id)
    await confirmHandoff(host)
    expect(host.workspaceRegistry.archivedSessionIds).toContain(previous.id)
    expect(host.workspaceRegistry.archivedSessionIds).not.toContain(id)
    expect(host.runtime.store.tickets.list()).toEqual(tickets)
  } finally { await host.stop() }
})

it('preserves genuine input arriving during quiescence and forwards it with original attribution', async () => {
  const host = await startRuntime()
  try {
    const previous = largeMain(host)
    let release!: () => void, entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const create = vi.mocked(host.ctx.agents.create).getMockImplementation()!
    vi.mocked(host.ctx.agents.create).mockImplementationOnce(async options => { entered(); await gate; return create(options) })
    host.runtime.mainSessions.maintain(); await ready
    const message = createUserMessage({ source: { kind: 'user', rpcId: 'late-owner' }, content: [{ type: 'text', text: 'An actual new owner instruction' }] })
    host.agents.get(previous.id)!.inbox.nextTurn.push(message)
    agentEvents(host.ctx, previous).emit('agent/inbox/inserted', { message })
    expect(previous.inbox.nextTurn).toHaveLength(0)
    expect(host.runtime.effects.pending('mainForward')).toBe(true)
    release(); await host.runtime.idle()
    host.runtime.store.db.prepare("UPDATE effect SET due=0 WHERE kind='mainForward'").run(); await host.runtime.idle()
    const next = host.ctx.agents.get(host.runtime.masterId as SessionId)!
    expect(next.followup).toHaveBeenCalledWith(message)
    expect(vi.mocked(next.followup).mock.calls[0]![0].source).toEqual(message.source)
  } finally { await host.stop() }
})

it('keeps the old Main current when native preparation fails and returns captured inputs to it', async () => {
  const host = await startRuntime()
  try {
    const previous = largeMain(host)
    vi.mocked(host.ctx.agents.create).mockRejectedValueOnce(new Error('preset unavailable'))
    host.runtime.mainSessions.maintain(); await host.runtime.idle()
    expect(host.runtime.masterId).toBe(previous.id)
    expect(host.runtime.store.get(KV.runtime.mainTransition(previous.id))?.phase).toBe('abandoned')
    expect(host.workspaceRegistry.archivedSessionIds).not.toContain(previous.id)
  } finally { await host.stop() }
})

it('retargets native reminders with CAS while leaving task identity, timing and prompts untouched', async () => {
  const host = await startRuntime()
  try {
    const previous = largeMain(host), edit = vi.fn(async (_request: unknown) => ({}))
    const schedule = { catalog: async () => [{ id: 'timer', target: { kind: 'session', sessionId: previous.id }, updatedAt: 'revision-1' }], edit }
    Object.assign(host.schedule, schedule)
    host.runtime.mainSessions.maintain(); await host.runtime.idle()
    expect(edit).toHaveBeenCalledOnce()
    expect(edit.mock.calls[0]![0]).toEqual({ id: 'timer', action: 'update', expectedUpdatedAt: 'revision-1',
      patch: { target: { kind: 'session', sessionId: host.runtime.masterId } } })
  } finally { await host.stop() }
})

it('aborts an uncommitted transition on restart without replacing the current Main', async () => {
  const host = await startRuntime()
  try {
    const previous = host.runtime.masterId
    host.runtime.store.set(KV.runtime.mainTransition(previous), { from: previous, to: 'orchestrator-unpublished', throughSeq: 5, at: '2026-11-16T00:00:00Z', phase: 'quiescing' })
    host.runtime.mainSessions.recover(); await host.runtime.idle()
    expect(host.runtime.masterId).toBe(previous)
    expect(host.runtime.store.get(KV.runtime.mainTransition(previous))?.phase).toBe('abandoned')
    expect(host.runtime.effects.pending('mainRetire')).toBe(false)
  } finally { await host.stop() }
})

it('bridges native global reminder create/delete and preserves paused status and current target', async () => {
  const task: NativeReminder = { id: 'task', title: 'Check', prompt: 'Read only', scheduledAt: '2099-01-01T00:00:00Z',
    status: 'paused', target: { kind: 'session', sessionId: 'orchestrator-current' } }
  const create = vi.fn(async () => task), edit = vi.fn(async () => ({ id: 'task', deleted: true as const }))
  const native = { create, edit, catalog: async () => [task] } as HostSchedule
  const port = followupSchedule(native)!
  await port.create('orchestrator-current', { title: task.title, prompt: task.prompt, at: task.scheduledAt })
  expect(create.mock.calls[0]).toEqual([{ title: task.title, prompt: task.prompt, timing: { kind: 'at', at: task.scheduledAt },
    target: task.target }, 'orchestrator-current'])
  expect((await port.catalog!())[0]).toMatchObject({ status: 'paused', sessionId: 'orchestrator-current' })
  await expect(port.delete({ sessionId: 'orchestrator-old', id: 'task' })).resolves.toEqual({ deleted: true })
  expect(edit.mock.calls[0]).toEqual([{ id: 'task', action: 'delete' }])
})

it('keeps a running worker, its assignment, mandate and pending question unchanged across rotation', async () => {
  const host = await startRuntime()
  try {
    const { ticket, sessionId } = await host.acceptedTicket(feishu('81', '@bot 修复有界测试'))
    host.consume()
    host.agents.get(host.runtime.masterId)!.status = 'idle'
    const previous = largeMain(host), worker = host.agents.get(sessionId)!
    const before = JSON.stringify(host.runtime.store.tickets.get(ticket.id))
    host.runtime.mainSessions.maintain(); await host.runtime.idle()
    expect(host.runtime.masterId).not.toBe(previous.id)
    expect(host.agents.get(sessionId)).toBe(worker)
    expect(worker.status).toBe('running')
    expect(JSON.stringify(host.runtime.store.tickets.get(ticket.id))).toBe(before)
  } finally { await host.stop() }
})

it('retains the old routing address when a reminder target edit conflicts, then completes retirement', async () => {
  const host = await startRuntime()
  try {
    const previous = largeMain(host)
    host.schedule.catalog.mockResolvedValue([{ id: 'timer', title: 'Check', prompt: 'Keep', scheduledAt: '2099-01-01T00:00:00Z',
      status: 'active', target: { kind: 'session', sessionId: previous.id }, updatedAt: 'revision' }])
    host.schedule.edit.mockResolvedValueOnce({ id: 'timer', code: 'schedule_conflict' })
    host.runtime.mainSessions.maintain(); await host.runtime.idle()
    expect(host.runtime.masterId).not.toBe(previous.id)
    expect(host.runtime.effects.pending('mainRetire')).toBe(true)
    expect(host.workspaceRegistry.archivedSessionIds).not.toContain(previous.id)
    host.schedule.catalog.mockResolvedValue([])
    await confirmHandoff(host)
    expect(host.workspaceRegistry.archivedSessionIds).toContain(previous.id)
  } finally { await host.stop() }
})

it('does not fence a real subagent merely because it inherited the router preset', async () => {
  const host = await startRuntime()
  try {
    const handle = await host.ctx.agents.create({ sessionId: SessionId('router-subagent'),
      meta: { agentPreset: 'dsh-superagent-router', origin: 'subagent' } })
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Child work' }] })
    host.agents.get(handle.agent.id)!.inbox.nextTurn.push(message)
    agentEvents(host.ctx, handle.agent).emit('agent/inbox/inserted', { message })
    expect(handle.agent.inbox.nextTurn).toContain(message)
    expect(host.runtime.effects.pending('mainForward')).toBe(false)
    await handle.dispose()
  } finally { await host.stop() }
})

it('deduplicates an old-window RPC even after its first destination has itself rotated', async () => {
  const host = await startRuntime()
  try {
    const original = largeMain(host)
    host.runtime.mainSessions.maintain(); await host.runtime.idle()
    await confirmHandoff(host)
    const first = createUserMessage({ source: { kind: 'user', rpcId: 'old-window-request' }, content: [{ type: 'text', text: 'A real owner instruction' }] })
    host.agents.get(original.id)!.inbox.nextTurn.push(first)
    agentEvents(host.ctx, original).emit('agent/inbox/inserted', { message: first }); await host.runtime.idle()
    host.consume(); host.agents.get(host.runtime.masterId)!.status = 'idle'; largeMain(host)
    host.runtime.mainSessions.maintain(); await host.runtime.idle()
    const current = host.ctx.agents.get(host.runtime.masterId as SessionId)!
    const retry = createUserMessage({ source: first.source, content: first.content })
    host.agents.get(original.id)!.inbox.nextTurn.push(retry)
    agentEvents(host.ctx, original).emit('agent/inbox/inserted', { message: retry }); await host.runtime.idle()
    expect(current.followup).not.toHaveBeenCalled()
    expect(host.runtime.effects.pending('mainForward')).toBe(false)
  } finally { await host.stop() }
})

it('restores handoff context that was claimed before native history could record it', async () => {
  const host = await startRuntime()
  try {
    largeMain(host); host.runtime.mainSessions.maintain(); await host.runtime.idle()
    const current = host.agents.get(host.runtime.masterId)!
    current.inbox.nextStep.length = 0
    const before = vi.mocked(current.inject).mock.calls.length
    await host.runtime.mainSessions.restoreHandoff()
    expect(current.inject).toHaveBeenCalledTimes(before + 1)
    expect(current.inbox.nextStep[0]!.source).toMatchObject({ kind: 'dsh-superagent', form: 'notice' })
    await confirmHandoff(host)
  } finally { await host.stop() }
})

it('keeps a viewed old segment open until the native page leaves, even after context consumption', async () => {
  const host = await startRuntime()
  try {
    const previous = largeMain(host)
    host.runtime.mainSessions.view({ sessionId: previous.id, viewId: 'owner-page', active: true })
    host.runtime.mainSessions.maintain(); await host.runtime.idle(); await confirmHandoff(host)
    expect(host.workspaceRegistry.archivedSessionIds).not.toContain(previous.id)
    expect(host.runtime.effects.pending('mainRetire')).toBe(true)
    host.runtime.mainSessions.view({ sessionId: previous.id, viewId: 'owner-page', active: false })
    host.runtime.store.db.prepare("UPDATE effect SET due=0 WHERE kind='mainRetire'").run(); await host.runtime.idle()
    expect(host.workspaceRegistry.archivedSessionIds).toContain(previous.id)
  } finally { await host.stop() }
})

it('moves an idle context notice without waking the next Main', async () => {
  const host = await startRuntime()
  try {
    const previous = largeMain(host), notice = createUserMessage({ source: { kind: 'dsh-superagent', form: 'notice', summary: 'Saved change' },
      content: [{ type: 'text', text: 'Context only' }] })
    host.agents.get(previous.id)!.inbox.nextStep.push(notice)
    host.runtime.mainSessions.maintain(); await host.runtime.idle()
    host.runtime.store.db.prepare("UPDATE effect SET due=0 WHERE kind='mainContext'").run(); await host.runtime.idle()
    const current = host.ctx.agents.get(host.runtime.masterId as SessionId)!
    expect(current.inject).toHaveBeenCalledWith(notice)
    expect(current.followup).not.toHaveBeenCalled()
    expect(host.runtime.effects.pending('mainContext')).toBe(true)
    await confirmHandoff(host)
    expect(host.runtime.effects.pending('mainContext')).toBe(false)
  } finally { await host.stop() }
})


it('delivers owner input behind unconsumed quiet context while preserving owner order', async () => {
  const host = await startRuntime()
  try {
    const previous = largeMain(host), notice = createUserMessage({ source: { kind: 'dsh-superagent', form: 'notice', summary: 'Background' },
      content: [{ type: 'text', text: 'Quiet context awaiting a real wake' }] })
    host.agents.get(previous.id)!.inbox.nextStep.push(notice)
    host.runtime.mainSessions.maintain(); await host.runtime.idle()
    host.runtime.store.db.prepare("UPDATE effect SET due=0 WHERE kind='mainContext'").run(); await host.runtime.idle()
    const current = host.ctx.agents.get(host.runtime.masterId as SessionId)!
    expect(current.inject).toHaveBeenCalledWith(notice)
    expect(host.runtime.effects.pending('mainContext')).toBe(true)
    const messages = ['first', 'second'].map(rpcId => createUserMessage({ source: { kind: 'user', rpcId }, content: [{ type: 'text', text: rpcId }] }))
    for (const message of messages) {
      host.agents.get(previous.id)!.inbox.nextTurn.push(message)
      agentEvents(host.ctx, previous).emit('agent/inbox/inserted', { message })
    }
    await host.runtime.idle()
    expect(vi.mocked(current.followup).mock.calls.map(call => call[0])).toEqual(messages)
    host.consume(); host.agents.get(current.id)!.status = 'idle'
    host.runtime.store.db.prepare("UPDATE effect SET due=0 WHERE kind IN ('mainForward','mainContext')").run(); await host.runtime.idle()
    expect(vi.mocked(current.followup).mock.calls.map(call => call[0])).toEqual(messages)
    await confirmHandoff(host)
    expect(host.runtime.effects.pending('mainContext')).toBe(false)
    expect(host.runtime.effects.pending('mainForward')).toBe(false)
  } finally { await host.stop() }
})


it('does not replay an owner RPC already durably consumed in its original segment', async () => {
  const host = await startRuntime()
  try {
    const previous = largeMain(host), first = createUserMessage({ source: { kind: 'user', rpcId: 'consumed-before-rotation' },
      content: [{ type: 'text', text: 'An already handled instruction' }] })
    previous.followup(first); host.consume(); host.agents.get(previous.id)!.status = 'idle'
    host.runtime.mainSessions.maintain(); await host.runtime.idle()
    await confirmHandoff(host)
    const current = host.ctx.agents.get(host.runtime.masterId as SessionId)!
    const retry = createUserMessage({ source: first.source, content: first.content })
    host.agents.get(previous.id)!.inbox.nextTurn.push(retry)
    agentEvents(host.ctx, previous).emit('agent/inbox/inserted', { message: retry }); await host.runtime.idle()
    expect(current.followup).not.toHaveBeenCalled()
    expect(host.runtime.effects.pending('mainForward')).toBe(false)
  } finally { await host.stop() }
})
