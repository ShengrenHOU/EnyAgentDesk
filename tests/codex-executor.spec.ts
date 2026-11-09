import type { CodexConfig } from '../src/executor/codex.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { CodexRpc, type CodexRpcOptions } from '../src/executor/codex-rpc.ts'
import { KV } from '../src/kv.ts'
import { key } from '../src/core/index.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture(completeImmediately = false, readOnly = false, beforeThread?: (connection: number) => Promise<void> | undefined, networkAccess = false, hostAccess = false) {
  const connections: { options: CodexRpcOptions; call: Mock<(method: string, params: Record<string, unknown>) => Promise<unknown>>; close: Mock<() => Promise<void>> }[] = []
  let turn = 0
  vi.spyOn(CodexRpc, 'connect').mockImplementation(async options => {
    const index = connections.length
    const connection = { options, close: vi.fn(async () => {}), call: vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/start' || method === 'thread/resume') { await beforeThread?.(index); return { thread: { id: 'codex-thread-1' } } }
      if (method === 'turn/start') {
        const id = `turn-${++turn}`
        if (completeImmediately) options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id, status: 'completed' } })
        return { turn: { id } }
      }
      if (method === 'turn/steer') return { turnId: params.expectedTurnId }
      if (method === 'turn/interrupt') return {}
      if (method === 'thread/read') return { thread: { id: 'codex-thread-1', turns: [] } }
      throw new Error(`Unexpected method ${method}`)
    }) }
    connections.push(connection)
    return connection as unknown as CodexRpc
  })
  const codex: CodexConfig = { command: process.execPath, readOnly, networkAccess, hostAccess }
  host = await startRuntime(undefined, { codex })
  return { host, connections, codex }
}
describe('Codex executor integration with upstream Engine and Effects', () => {
  it('consumes an owner answer when its Codex report arrives before turn completion', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('1', 'Prepare a summary'))
    const c = connections[0]!
    h.runtime.engine.report(ticket.id, { state: 'blocked', summary: 'Need scope', question: 'Which scope?' })
    c.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await vi.waitFor(() => expect(h.runtime.store.get(KV.codex.binding(ticket.id))?.turnId).toBeUndefined())
    const attention = h.runtime.store.tickets.get(ticket.id)!.attention!
    h.runtime.engine.answerAttention(ticket.id, attention.id, 'Summary only', { source: 'feishu', id: 'ou_alice' })
    await h.runtime.idle()
    const reportAt = new Date(Date.now() + 1000).toISOString()
    vi.spyOn(Date.prototype, 'toISOString').mockReturnValue(reportAt)
    const result = await c.options.request('item/tool/call', { threadId: 'codex-thread-1', turnId: 'turn-2',
      callId: 'answer-ready', tool: 'orchestrator_report', arguments: { state: 'ready', summary: 'Summary verified' } })
    expect(result).toMatchObject({ success: true })
    expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
    expect(h.runtime.store.tickets.get(ticket.id)?.inputs.at(-1)).toMatchObject({ kind: 'answer', readAt: expect.any(String), reportedAt: expect.any(String) })
    await h.runtime.idle()
    expect(c.call.mock.calls.some(([method]) => method === 'turn/interrupt')).toBe(false)
  })

  it('keeps an answer out of an active Codex turn so a stale report cannot consume it', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('1', 'Prepare a summary'))
    const c = connections[0]!
    const attention = h.runtime.engine.report(ticket.id, { state: 'blocked', summary: 'Need scope', question: 'Which scope?' }).attention!
    h.runtime.engine.answerAttention(ticket.id, attention.id, 'Summary only', { source: 'feishu', id: 'ou_alice' })
    await h.runtime.idle()
    expect(c.call.mock.calls.some(([method]) => method === 'turn/steer')).toBe(false)
    await c.options.request('item/tool/call', { threadId: 'codex-thread-1', turnId: 'turn-1', callId: 'old-ready',
      tool: 'orchestrator_report', arguments: { state: 'ready', summary: 'Old turn result' } })
    expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
    c.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await vi.waitFor(() => expect(c.call.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(2))
    await c.options.request('item/tool/call', { threadId: 'codex-thread-1', turnId: 'turn-2', callId: 'new-ready',
      tool: 'orchestrator_report', arguments: { state: 'ready', summary: 'Answer applied' } })
    expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
  })
  it('keeps a follow-up queued when paused while reconnecting its Codex thread', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const { host: h, connections } = await fixture(false, false, async index => {
      if (index === 1) { entered.resolve(); await release.promise }
    })
    const { ticket } = await h.acceptedLegacyTicket(feishu('1', 'Read the document'))
    h.runtime.executor.dispose()
    h.runtime.receive(feishu('2', 'Additional detail', { root_id: 'om_1' }))
    const delivery = h.runtime.idle()
    await entered.promise
    h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, paused: true })
    release.resolve()
    await delivery
    expect(connections[1]!.call.mock.calls.some(([method]) => method === 'turn/start' || method === 'turn/steer')).toBe(false)
    expect(h.runtime.store.tickets.get(ticket.id)!.undelivered).toHaveLength(1)
  })
  it('holds an initial Codex turn when its ticket is paused during connection', async () => {
    const entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>()
    const { host: h, connections } = await fixture(false, false, async () => { entered.resolve(); await ready.promise })
    const accepted = h.acceptedLegacyTicket(feishu('1', 'Work after connection'))
    await entered.promise
    expect(connections[0]!.call).toHaveBeenCalledWith('thread/start', expect.anything())
    const ticket = h.runtime.store.tickets.open()[0]!
    h.runtime.store.tickets.save({ ...ticket, paused: true })
    ready.resolve()
    await accepted
    expect(connections[0]!.call.mock.calls.some(([method]) => method === 'turn/start')).toBe(false)
  })

  it('holds a completed-turn stage transition while its ticket is paused', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('1', 'Continue in another stage'))
    h.runtime.store.set(KV.codex.stages(ticket.id), { current: 'research', history: [], turns: [], pending: {
      stage: 'implementation', requestId: 'code', turnId: 'turn-1', handoff: { purpose: 'Fix', decisions: 'Keep', results: 'Design', evidence: 'Source', remaining: 'Code' },
    } })
    h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, paused: true })
    connections[0]!.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await h.runtime.idle()
    await vi.waitFor(() => expect(h.runtime.store.get(KV.codex.binding(ticket.id))?.turnId).toBeUndefined())
    expect(connections[0]!.call.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
    expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.current).toBe('research')
  })
  it.each([undefined, 'fixed-model'])('routes documentation without an executor hint to Codex, retaining model override %s', async override => {
    const { host: h, connections, codex } = await fixture()
    codex.model = override
    const trigger = feishu('document-routing', '整理当前设计和运行状态，写一页速查。')
    h.runtime.receive(trigger); await h.runtime.idle()
    await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'Daily guide', worktree_name: 'daily-guide',
      acknowledgement: '整理当前设计和运行状态，交付一页速查。', stage: 'documentation' })
    await h.runtime.idle()
    const ticket = h.runtime.store.tickets.open()[0]!
    expect(ticket.execution?.executor).toBe('codex')
    expect(connections[0]!.call.mock.calls.find(([method]) => method === 'turn/start')?.[1]).toMatchObject({ model: override ?? 'gpt-6.1-terra' })
    expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.current).toBe(override ? undefined : 'documentation')
    const again = await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'Changed title', worktree_name: 'changed-title',
      acknowledgement: 'Another acknowledgement.', executor: 'dsh' })
    expect(again.reason).toContain('Already accepted')
    expect(h.runtime.store.tickets.open()).toHaveLength(1)
    expect(h.runtime.store.tickets.get(ticket.id)?.execution?.executor).toBe('codex')
  })

  it('routes auxiliary work to DSH without opening Codex or saving an auxiliary Codex stage', async () => {
    const { host: h, connections } = await fixture()
    const trigger = feishu('auxiliary-routing', '请用 DSH 简短摘录这段材料。')
    h.runtime.receive(trigger); await h.runtime.idle()
    await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'Short extract', worktree_name: 'short-extract',
      acknowledgement: '摘录所给材料。', stage: 'auxiliary' })
    await h.runtime.idle()
    const ticket = h.runtime.store.tickets.open()[0]!
    expect(ticket.execution?.executor).toBe('dsh')
    expect(h.runtime.store.get(KV.codex.stages(ticket.id))).toBeUndefined()
    expect(h.agents.has(`worker-${ticket.id}`)).toBe(true)
    expect(connections).toHaveLength(0)
  })

  it('keeps a mixed-runtime batch acceptance unchanged when a later item chooses another stage or omits it', async () => {
    const { host: h, connections } = await fixture()
    await h.runtime.settings.pause(true, 'panel')
    const first = feishu('batch1', '整理当前设计。'), second = feishu('batch2', '交付一页速查。', { root_id: 'om_batch1' })
    h.runtime.receive(first); h.runtime.receive(second)
    await h.runtime.settings.pause(false, 'panel'); await h.runtime.pump(); await h.runtime.idle()
    const accept = { kind: 'accept', title: 'Daily guide', worktree_name: 'daily-guide', acknowledgement: '整理设计并交付一页速查。' }
    const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
      { ...accept, trigger_id: first.id, stage: 'documentation' },
      { ...accept, trigger_id: second.id, title: 'Changed title', acknowledgement: 'Different acknowledgement.', stage: 'auxiliary' },
      { kind: 'ignore', trigger_id: second.id, reason: 'chat' },
    ] }) as { results: Record<string, unknown>[] }
    await h.runtime.idle()
    const ticket = h.runtime.store.tickets.open()[0]!
    expect(h.runtime.store.tickets.open()).toHaveLength(1)
    expect(results[1]).toMatchObject({ decision: 'accept', ticket: { ticket_id: ticket.id }, reason: expect.stringContaining('Already accepted') })
    expect(results[2]).toMatchObject({ refused: expect.stringContaining('Decided in this call') })
    const replay = await h.route({ ...accept, trigger_id: second.id })
    expect(replay.reason).toContain('Already accepted')
    expect(h.runtime.store.tickets.get(ticket.id)).toMatchObject({ title: accept.title, execution: { executor: 'codex' } })
    expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.current).toBe('documentation')
    expect(h.runtime.store.receipts.get(key('ack', ticket.origin.triggerId))?.text).toBe(accept.acknowledgement)
    expect(connections[0]!.call.mock.calls.find(([method]) => method === 'turn/start')?.[1]).toMatchObject({ model: 'gpt-6.1-terra' })
  })

  it('adopts a verified DSH ticket directory after an explicit persisted executor handoff', async () => {
    const { host: h, connections } = await fixture(true)
    const trigger = feishu('transferred-workspace', 'Continue the accepted work')
    h.runtime.receive(trigger); await h.runtime.idle()
    await h.runtime.settings.pause(true, 'panel')
    const { ticket } = await h.acceptedLegacyTicket(trigger)
    await mkdir(ticket.execution!.directory, { recursive: true })
    const current = h.runtime.store.tickets.get(ticket.id)!
    h.runtime.store.tickets.save({ ...current, execution: { ...current.execution!, executor: 'codex', handoffs: [{
      from: 'dsh', to: 'codex', at: new Date().toISOString(), handoff: {
        purpose: 'Continue the work', decisions: 'Keep scope', results: 'Directory prepared by DSH', evidence: 'Prior report', remaining: 'Verify result',
      },
    }] } })
    expect(h.runtime.store.get(KV.codex.workspace(ticket.id))).toBeUndefined()
    await h.runtime.settings.pause(false, 'panel'); await h.runtime.idle()
    await vi.waitFor(() => expect(connections).toHaveLength(1))
    expect(h.runtime.store.get(KV.codex.workspace(ticket.id))).toBe(true)
    expect(connections[0]!.call.mock.calls.some(([method]) => method === 'thread/start')).toBe(true)
  })

  it('saves a complete handoff and changes model only after completed turn', async () => {
    const { host: h, connections } = await fixture()
    const trigger = feishu('stage', 'Implement the requested fix')
    h.runtime.receive(trigger); await h.runtime.idle()
    await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'Stage task', worktree_name: 'stage-task', acknowledgement: 'Received: fixing the issue.', executor: 'codex', stage: 'research' })
    await h.runtime.idle()
    const ticket = h.runtime.store.tickets.open()[0]!
    expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.current).toBe('research')
    expect(connections[0]!.call.mock.calls.find(([method]) => method === 'turn/start')?.[1]).toMatchObject({ model: 'gpt-6-astra' })
    const c = connections[0]!
    const args = { request_id: 'handoff-1', stage: 'implementation', handoff: {
      purpose: 'Fix the authorized bug', decisions: 'Use the existing helper', results: 'Design reviewed',
      evidence: 'Issue and source', remaining: 'Implement and verify',
    } }
    const request = () => c.options.request('item/tool/call', { threadId: 'codex-thread-1', turnId: 'turn-1',
      callId: 'stage-call', tool: 'orchestrator_stage', arguments: args })
    expect(await request()).toMatchObject({ success: true })
    expect(await request()).toMatchObject({ success: true })
    expect(c.call.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
    c.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await vi.waitFor(() => expect(c.call.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(2))
    expect(c.call.mock.calls.filter(([method]) => method === 'turn/start')[1]?.[1]).toMatchObject({ model: 'gpt-6.1-sol' })
    expect(h.runtime.store.get(KV.codex.stages(ticket.id))).toMatchObject({ current: 'implementation', history: [{ stage: 'research' }, { handoff: args.handoff }] })
    c.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-2', status: 'completed' } })
    await vi.waitFor(() => expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.turns).toHaveLength(2))
    c.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } })
    c.options.notification('model/rerouted', { threadId: 'codex-thread-1', turnId: 'turn-1', fromModel: 'gpt-6-astra', toModel: 'other-model', reason: 'stale' })
    expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.turns[0]).toMatchObject({ requestedModel: 'gpt-6-astra' })
    expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.turns[0]?.actualModel).toBeUndefined()
  })

  it.each(['interrupted', 'failed'])('does not advance a handoff after a %s turn', async status => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('2', 'Fix the requested file'))
    h.runtime.store.set(KV.codex.stages(ticket.id), { current: 'research', history: [], turns: [],
      pending: { stage: 'implementation', turnId: 'turn-1', requestId: 'next', handoff: {
        purpose: 'Fix', decisions: 'Keep scope', results: 'Read', evidence: 'Local', remaining: 'Implement',
      } } })
    connections[0]!.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status } })
    await vi.waitFor(() => expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.state).toBe('failed'))
    expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.current).toBe('research')
    expect(connections[0]!.call.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
  })
  it('records a rerouted model and stops instead of silently accepting another model', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('2', 'Fix the requested file'))
    h.runtime.store.set(KV.codex.stages(ticket.id), { current: 'research', history: [], turns: [] })
    const c = connections[0]!
    c.options.notification('model/rerouted', { threadId: 'codex-thread-1', turnId: 'turn-1', fromModel: 'gpt-6-astra', toModel: 'other-model', reason: 'unavailable' })
    c.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await vi.waitFor(() => expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.state).toBe('failed'))
    expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.turns[0]).toMatchObject({ actualModel: 'other-model', requestedModel: 'gpt-6-astra' })
  })
  it('records actual model only from the bound thread and turn rollout metadata', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('2', 'Fix the requested file'))
    h.runtime.store.set(KV.codex.stages(ticket.id), { current: 'research', history: [], turns: [] })
    const path = join(h.directory, 'rollout.jsonl')
    await writeFile(path, [
      { type: 'session_meta', payload: { id: 'codex-thread-1' } },
      { type: 'turn_context', payload: { turn_id: 'other-turn', model: 'other-model' } },
      { type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-6-astra' } },
    ].map(value => JSON.stringify(value)).join('\n'))
    const c = connections[0]!, original = c.call.getMockImplementation()!
    c.call.mockImplementation(async (method, params) => method === 'thread/read' ? { thread: { path } } : original(method, params))
    c.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await vi.waitFor(() => expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.turns[0]).toMatchObject({ actualModel: 'gpt-6-astra' }))
    const page = await h.api('GET', `tickets/${ticket.id}`)
    expect(page.body).toMatchObject({ executionStages: { turns: [{ requestedModel: 'gpt-6-astra', actualModel: 'gpt-6-astra' }] } })
  })
  it('reports a stage model launch rejection once and retains the unknown delivery intent', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('2', 'Fix the requested file'))
    h.runtime.store.set(KV.codex.stages(ticket.id), { current: 'research', history: [], turns: [], pending: {
      stage: 'implementation', requestId: 'code', turnId: 'turn-1', handoff: { purpose: 'Fix', decisions: 'Keep', results: 'Design', evidence: 'Source', remaining: 'Code' },
    } })
    const c = connections[0]!, original = c.call.getMockImplementation()!
    c.call.mockImplementation(async (method, params) => {
      if (method === 'turn/start') throw new Error('Requested model is unavailable')
      return original(method, params)
    })
    c.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await vi.waitFor(() => expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report).toMatchObject({ state: 'failed', summary: 'Requested model is unavailable' }))
    expect(h.runtime.store.get(KV.codex.binding(ticket.id))?.pending?.marker).toBe('superagent-stage:code')
    expect(c.call.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(2)
  })
  it('keeps unavailable rollout evidence unknown without failing the completed business turn', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('2', 'Fix the requested file'))
    h.runtime.store.set(KV.codex.stages(ticket.id), { current: 'research', history: [], turns: [] })
    const c = connections[0]!, original = c.call.getMockImplementation()!
    c.call.mockImplementation(async (method, params) => method === 'thread/read' ? { thread: { path: join(h.directory, 'not-present') } } : original(method, params))
    c.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await vi.waitFor(() => expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.turns).toHaveLength(1))
    expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.turns[0]?.actualModel).toBeUndefined()
    expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.state).toBe('waiting')
  })
  it('deduplicates delayed completion and holds delivery until its receipt is processed', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('2', 'Fix the requested file'))
    h.runtime.store.set(KV.codex.stages(ticket.id), { current: 'research', history: [], turns: [] })
    const gate = Promise.withResolvers<void>(), c = connections[0]!, original = c.call.getMockImplementation()!
    c.call.mockImplementation(async (method, params) => {
      if (method === 'thread/read') { await gate.promise; return { thread: {} } }
      return original(method, params)
    })
    const done = { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } }
    c.options.notification('turn/completed', done)
    c.options.notification('turn/completed', done)
    h.runtime.receive(feishu('3', 'Also explain the change', { root_id: 'om_2' }))
    try {
      await vi.waitFor(() => expect(c.call.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(1))
      expect(c.call.mock.calls.some(([method]) => method === 'turn/steer')).toBe(false)
    } finally { gate.resolve() }
    await vi.waitFor(() => expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.turns).toHaveLength(1))
  })
  it('retains a pending stage while a human decision is required', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('2', 'Fix the requested file'))
    h.runtime.store.set(KV.codex.stages(ticket.id), { current: 'research', history: [], turns: [], pending: {
      stage: 'implementation', requestId: 'code', turnId: 'turn-1', handoff: { purpose: 'Fix', decisions: 'Keep', results: 'Design', evidence: 'Source', remaining: 'Code' },
    } })
    h.runtime.engine.report(ticket.id, { state: 'progress', summary: 'Need a consequential decision', question: 'Which authorized target is intended?' })
    const c = connections[0]!
    c.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await vi.waitFor(() => expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.turns).toHaveLength(1))
    await h.runtime.idle()
    expect(c.call.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
    expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.pending).toBeDefined()
    h.runtime.engine.report(ticket.id, { state: 'progress', summary: 'Decision received', question: null })
    await expect.poll(() => c.call.mock.calls.filter(([method]) => method === 'turn/start').length, { timeout: 7000, interval: 100 }).toBe(2)
  }, 10_000)
  it('recovers a saved handoff exactly once and keeps that model on subsequent recovery', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('2', 'Fix the requested file'))
    const handoff = { purpose: 'Fix', decisions: 'Keep scope', results: 'Design', evidence: 'Source', remaining: 'Code' }
    h.runtime.store.set(KV.codex.stages(ticket.id), { current: 'research', history: [], turns: [], pending: {
      stage: 'implementation', requestId: 'code', turnId: 'turn-1', handoff,
    } })
    const connect = vi.mocked(CodexRpc.connect), originalConnect = connect.getMockImplementation()!
    connect.mockImplementation(async options => {
      const result = await originalConnect(options)
      const c = connections.at(-1)!, original = c.call.getMockImplementation()!
      c.call.mockImplementation(async (method, params) => method === 'thread/read'
        ? { thread: { turns: [{ id: 'turn-1', status: 'completed', items: [] }] } } : original(method, params))
      return result
    })
    h.runtime.executor.dispose(); h.runtime.executor.resume(); await h.runtime.idle()
    expect(connections[1]!.call.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
    expect(connections[1]!.call.mock.calls.find(([method]) => method === 'turn/start')?.[1]).toMatchObject({ model: 'gpt-6.1-sol' })
    expect(h.runtime.store.get(KV.codex.stages(ticket.id))).toMatchObject({ current: 'implementation', history: [{ requestId: 'code', handoff }] })
    h.runtime.executor.dispose(); h.runtime.executor.resume(); await h.runtime.idle()
    expect(connections[2]!.call.mock.calls.find(([method]) => method === 'turn/start')?.[1]).toMatchObject({ model: 'gpt-6.1-sol' })
    expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.history).toHaveLength(1)
  })
  it('honors a later explicit model override without reinterpreting an older turn receipt', async () => {
    const { host: h, connections, codex } = await fixture()
    const trigger = feishu('2', 'Fix the requested file')
    h.runtime.receive(trigger); await h.runtime.idle()
    await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'Stage task', worktree_name: 'stage-task', acknowledgement: 'Received: fixing the issue.', executor: 'codex', stage: 'research' })
    await h.runtime.idle()
    const ticket = h.runtime.store.tickets.open()[0]!, c = connections[0]!
    codex.model = 'explicit-model'
    c.options.notification('model/rerouted', { threadId: 'codex-thread-1', turnId: 'turn-1', fromModel: 'gpt-6-astra', toModel: 'gpt-6-astra', reason: 'same' })
    c.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await vi.waitFor(() => expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.state).toBe('waiting'))
    expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.turns[0]?.requestedModel).toBe('gpt-6-astra')
    h.runtime.receive(feishu('3', 'Continue this scoped task', { root_id: 'om_2' })); await h.runtime.idle()
    const active = connections.at(-1)!
    expect(active.call.mock.calls.filter(([method]) => method === 'turn/start').at(-1)?.[1]).toMatchObject({ model: 'explicit-model' })
    active.options.notification('model/rerouted', { threadId: 'codex-thread-1', turnId: 'turn-2', fromModel: 'explicit-model', toModel: 'explicit-model', reason: 'same' })
    active.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-2', status: 'completed' } })
    await vi.waitFor(() => expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.turns.find(turn => turn.turnId === 'turn-2')?.actualModel).toBe('explicit-model'))
    h.runtime.executor.dispose(); h.runtime.executor.resume(); await h.runtime.idle()
    h.runtime.receive(feishu('4', 'Continue after restarting this executor', { root_id: 'om_2' })); await h.runtime.idle()
    const resumed = connections.at(-1)!
    expect(resumed.call.mock.calls.find(([method]) => method === 'thread/resume')?.[1]).toMatchObject({ model: 'explicit-model' })
    expect(resumed.call.mock.calls.find(([method]) => method === 'turn/start')?.[1]).toMatchObject({ model: 'explicit-model' })
    expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.turns[0]?.requestedModel).toBe('gpt-6-astra')
  })
  it.each(['failed', 'interrupted', 'mismatched'])('invalidates a %s source handoff before retrying the original stage', async status => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('2', 'Fix the requested file'))
    h.runtime.store.set(KV.codex.stages(ticket.id), { current: 'research', history: [], turns: [], pending: {
      stage: 'implementation', requestId: 'code', turnId: 'turn-1', handoff: { purpose: 'Fix', decisions: 'Keep', results: 'Design', evidence: 'Source', remaining: 'Code' },
    } })
    const c = connections[0]!
    if (status === 'mismatched') c.options.notification('model/rerouted', { threadId: 'codex-thread-1', turnId: 'turn-1', fromModel: 'gpt-6-astra', toModel: 'wrong-model', reason: 'unavailable' })
    c.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: status === 'mismatched' ? 'completed' : status } })
    await vi.waitFor(() => expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.state).toBe('failed'))
    const connect = vi.mocked(CodexRpc.connect), originalConnect = connect.getMockImplementation()!
    connect.mockImplementation(async options => {
      const result = await originalConnect(options), connection = connections.at(-1)!, original = connection.call.getMockImplementation()!
      connection.call.mockImplementation(async (method, params) => method === 'thread/read' ? { thread: { turns: [{ id: 'turn-1', status: status === 'mismatched' ? 'completed' : status, items: [] }] } } : original(method, params))
      return result
    })
    if (status === 'mismatched') expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.pending?.turnId).toBe('turn-1')
    h.runtime.executor.dispose()
    h.runtime.engine.retryTicket(ticket.id); await h.runtime.idle()
    const next = connections.at(-1)!
    expect(next.call.mock.calls.find(([method]) => method === 'turn/start')?.[1]).toMatchObject({ model: 'gpt-6-astra' })
    expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.pending).toBeUndefined()
    expect(await next.options.request('item/tool/call', { threadId: 'codex-thread-1', turnId: 'turn-2', callId: 'ready', tool: 'orchestrator_report', arguments: { state: 'ready', summary: 'Fix is ready' } })).toMatchObject({ success: true })
  })
  it('recovers a failed-source pending handoff persisted by an earlier executor version', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('2', 'Fix the requested file'))
    h.runtime.store.set(KV.codex.stages(ticket.id), { current: 'research', history: [], turns: [], pending: {
      stage: 'implementation', requestId: 'old', turnId: 'turn-1', handoff: { purpose: 'Fix', decisions: 'Keep', results: 'Design', evidence: 'Source', remaining: 'Code' },
    } })
    h.runtime.engine.report(ticket.id, { state: 'failed', summary: 'Source turn failed before the restart' })
    const connect = vi.mocked(CodexRpc.connect), originalConnect = connect.getMockImplementation()!
    connect.mockImplementation(async options => {
      const result = await originalConnect(options), c = connections.at(-1)!, original = c.call.getMockImplementation()!
      c.call.mockImplementation(async (method, params) => method === 'thread/read' ? { thread: { turns: [{ id: 'turn-1', status: 'failed', items: [] }] } } : original(method, params))
      return result
    })
    h.runtime.executor.dispose(); h.runtime.engine.retryTicket(ticket.id); await h.runtime.idle()
    expect(connections.at(-1)!.call.mock.calls.find(([method]) => method === 'turn/start')?.[1]).toMatchObject({ model: 'gpt-6-astra' })
    expect(h.runtime.store.get(KV.codex.stages(ticket.id))?.pending).toBeUndefined()
  })
  it('continues a handoff after a new input supersedes the retained waiting report', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('2', 'Fix the requested file'))
    h.runtime.store.set(KV.codex.stages(ticket.id), { current: 'research', history: [], turns: [] })
    const c = connections[0]!
    c.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await vi.waitFor(() => expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.state).toBe('waiting'))
    h.runtime.receive(feishu('3', 'Continue with the agreed implementation', { root_id: 'om_2' })); await h.runtime.idle()
    expect(await c.options.request('item/tool/call', { threadId: 'codex-thread-1', turnId: 'turn-2', callId: 'next', tool: 'orchestrator_stage', arguments: {
      request_id: 'implement', stage: 'implementation', handoff: { purpose: 'Fix', decisions: 'Keep scope', results: 'Design', evidence: 'Source', remaining: 'Code' },
    } })).toMatchObject({ success: true })
    c.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-2', status: 'completed' } })
    await vi.waitFor(() => expect(c.call.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(3))
    expect(c.call.mock.calls.filter(([method]) => method === 'turn/start')[2]?.[1]).toMatchObject({ model: 'gpt-6.1-sol' })
  })
  it.each(['reroute', 'rollout'])('rejects ready before ending the ticket when %s proves the wrong model', async source => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('2', 'Fix the requested file'))
    h.runtime.store.set(KV.codex.stages(ticket.id), { current: 'research', history: [], turns: [] })
    const c = connections[0]!
    if (source === 'reroute') c.options.notification('model/rerouted', { threadId: 'codex-thread-1', turnId: 'turn-1', fromModel: 'gpt-6-astra', toModel: 'wrong-model', reason: 'unavailable' })
    else {
      const path = join(h.directory, 'ready-rollout.jsonl')
      await writeFile(path, [{ type: 'session_meta', payload: { id: 'codex-thread-1' } }, { type: 'turn_context', payload: { turn_id: 'turn-1', model: 'wrong-model' } }].map(value => JSON.stringify(value)).join('\n'))
      const original = c.call.getMockImplementation()!
      c.call.mockImplementation(async (method, params) => method === 'thread/read' ? { thread: { path } } : original(method, params))
    }
    expect(await c.options.request('item/tool/call', { threadId: 'codex-thread-1', turnId: 'turn-1', callId: 'ready', tool: 'orchestrator_report', arguments: { state: 'ready', summary: 'Reviewable result' } })).toMatchObject({ success: false })
    expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
    expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.state).toBe('failed')
  })
  it('holds a stage effect while follow-up turn/start is awaiting its receipt', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('2', 'Fix the requested file'))
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 2 } })
    const c = connections[0]!
    c.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await vi.waitFor(() => expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.state).toBe('waiting'))
    h.runtime.store.set(KV.codex.stages(ticket.id), { current: 'research', history: [], turns: [], pending: { stage: 'implementation', requestId: 'next', turnId: 'turn-1', handoff: { purpose: 'Fix', decisions: 'Keep', results: 'Design', evidence: 'Source', remaining: 'Code' } } })
    const gate = Promise.withResolvers<void>(), original = c.call.getMockImplementation()!
    c.call.mockImplementation(async (method, params) => { if (method === 'turn/start') await gate.promise; return original(method, params) })
    h.runtime.receive(feishu('3', 'Also apply the scoped clarification', { root_id: 'om_2' }))
    try {
      await vi.waitFor(() => expect(c.call.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(2))
      h.runtime.effects.enqueue('codexStage', ticket.id, { ticketId: ticket.id, assignmentId: ticket.assignments.at(-1)!.id, turnId: 'turn-1' })
      await h.runtime.effects.idle('codexStage')
      expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.state).not.toBe('failed')
      expect(h.runtime.store.db.prepare("SELECT key FROM effect WHERE kind='codexStage'").all()).toHaveLength(1)
    } finally { gate.resolve(); await h.runtime.idle() }
  })
  it.each(['stop', 'input', 'handoff'])('does not accept ready when %s supersedes its metadata collection', async action => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('2', 'Fix the requested file'))
    h.runtime.store.set(KV.codex.stages(ticket.id), { current: 'research', history: [], turns: [] })
    const c = connections[0]!, gate = Promise.withResolvers<void>(), original = c.call.getMockImplementation()!
    c.call.mockImplementation(async (method, params) => { if (method === 'thread/read') await gate.promise; return original(method, params) })
    const ready = c.options.request('item/tool/call', { threadId: 'codex-thread-1', turnId: 'turn-1', callId: 'ready', tool: 'orchestrator_report', arguments: { state: 'ready', summary: 'Reviewable result' } })
    try {
      await vi.waitFor(() => expect(c.call.mock.calls.some(([method]) => method === 'thread/read')).toBe(true))
      if (action === 'stop') h.runtime.engine.stopTicket(ticket.id, 'Stop this work')
      else if (action === 'input') { h.runtime.receive(feishu('3', 'Handle this clarification first', { root_id: 'om_2' })); await h.runtime.idle() }
      else expect(await c.options.request('item/tool/call', { threadId: 'codex-thread-1', turnId: 'turn-1', callId: 'stage', tool: 'orchestrator_stage', arguments: { request_id: 'next', stage: 'implementation', handoff: { purpose: 'Fix', decisions: 'Keep', results: 'Design', evidence: 'Source', remaining: 'Code' } } })).toMatchObject({ success: true })
    } finally { gate.resolve() }
    expect(await ready).toMatchObject({ success: false })
    expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.state).not.toBe('ready')
  })
  it('holds delivery while a stage effect reconciles a prior receipt', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('2', 'Fix the requested file'))
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 2 } })
    const c = connections[0]!
    c.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await vi.waitFor(() => expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.state).toBe('waiting'))
    h.runtime.engine.report(ticket.id, { state: 'progress', summary: 'Ready to continue the stage' })
    h.runtime.store.set(KV.codex.stages(ticket.id), { current: 'research', history: [], turns: [], pending: { stage: 'implementation', requestId: 'next', turnId: 'turn-1', handoff: { purpose: 'Fix', decisions: 'Keep', results: 'Design', evidence: 'Source', remaining: 'Code' } } })
    h.runtime.store.set(KV.codex.binding(ticket.id), { threadId: 'codex-thread-1', assignmentId: ticket.assignments.at(-1)!.id, pending: { marker: 'confirmed-input', inputIds: [] } })
    const gate = Promise.withResolvers<void>(), original = c.call.getMockImplementation()!
    c.call.mockImplementation(async (method, params) => {
      if (method === 'thread/read') { await gate.promise; return { thread: { turns: [{ id: 'turn-1', status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'confirmed-input' }] }] }] } } }
      return original(method, params)
    })
    h.runtime.effects.enqueue('codexStage', ticket.id, { ticketId: ticket.id, assignmentId: ticket.assignments.at(-1)!.id, turnId: 'turn-1' })
    try {
      await vi.waitFor(() => expect(c.call.mock.calls.some(([method]) => method === 'thread/read')).toBe(true))
      h.runtime.receive(feishu('3', 'Also apply the scoped clarification', { root_id: 'om_2' }))
      await h.runtime.effects.idle('delivery')
      expect(c.call.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
    } finally { gate.resolve(); await h.runtime.idle() }
    expect(c.call.mock.calls.filter(([method]) => method === 'turn/start')[1]?.[1]).toMatchObject({ model: 'gpt-6.1-sol' })
  })
  it('rejects an interrupted turn ready report even while the failed worker connection is closing', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('2', 'Fix the requested file'))
    h.runtime.store.set(KV.codex.stages(ticket.id), { current: 'research', history: [], turns: [] })
    const c = connections[0]!, metadata = Promise.withResolvers<void>(), closing = Promise.withResolvers<void>(), original = c.call.getMockImplementation()!
    let reads = 0
    c.close.mockImplementation(async () => { await closing.promise })
    c.call.mockImplementation(async (method, params) => { if (method === 'thread/read' && reads++ === 0) await metadata.promise; return original(method, params) })
    const ready = c.options.request('item/tool/call', { threadId: 'codex-thread-1', turnId: 'turn-1', callId: 'ready', tool: 'orchestrator_report', arguments: { state: 'ready', summary: 'Reviewable result' } })
    try {
      await vi.waitFor(() => expect(reads).toBe(1))
      c.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'interrupted' } })
      await vi.waitFor(() => expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.state).toBe('failed'))
      metadata.resolve()
      expect(await ready).toMatchObject({ success: false })
      expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
    } finally { metadata.resolve(); closing.resolve() }
  })
  it('applies explicitly authorized host access on start and resume', async () => {
    const { host: h, connections } = await fixture(false, false, undefined, false, true)
    await h.acceptedLegacyTicket(feishu('1', 'Perform the authorized repository task'))
    expect(connections[0]!.call.mock.calls.find(([method]) => method === 'thread/start')?.[1]).toMatchObject({ sandbox: 'danger-full-access' })
    h.runtime.executor.dispose()
    h.runtime.executor.resume()
    await h.runtime.idle()
    expect(connections[1]!.call.mock.calls.find(([method]) => method === 'thread/resume')?.[1]).toMatchObject({ sandbox: 'danger-full-access' })
  })
  it('uses a read-only sandbox for an explicitly selected review profile', async () => {
    const { host: h, connections } = await fixture(false, true, undefined, true, true)
    await h.acceptedLegacyTicket(feishu('1', 'Review the proposed change without editing'))
    expect(connections[0]!.call.mock.calls.find(([method]) => method === 'thread/start')?.[1]).toMatchObject({ sandbox: 'read-only', config: { 'sandbox_workspace_write.network_access': false } })
  })
  it('enables network only for an explicitly authorized writable profile', async () => {
    const { host: h, connections } = await fixture(false, false, undefined, true)
    await h.acceptedLegacyTicket(feishu('1', 'Fix the authorized repository'))
    expect(connections[0]!.call.mock.calls.find(([method]) => method === 'thread/start')?.[1]).toMatchObject({ sandbox: 'workspace-write', config: { 'sandbox_workspace_write.network_access': true } })
    h.runtime.executor.dispose()
    h.runtime.executor.resume()
    await h.runtime.idle()
    expect(connections[1]!.call.mock.calls.find(([method]) => method === 'thread/resume')?.[1]).toMatchObject({ sandbox: 'workspace-write', config: { 'sandbox_workspace_write.network_access': true } })
  })
  it('starts one thread, deduplicates events and steers a follow-up into the same turn', async () => {
    const { host: h, connections } = await fixture()
    const original = feishu('1', 'Fix the trial file')
    const { ticket } = await h.acceptedLegacyTicket(original)
    const c = connections[0]!
    expect(connections).toHaveLength(1)
    expect(c.call.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
    expect(h.runtime.store.get(KV.codex.binding(ticket.id))?.threadId).toBe('codex-thread-1')
    const page = await h.api('GET', 'tickets')
    expect((page.body.items as Record<string, unknown>[])[0]).toMatchObject({ sessionId: '', codexThreadId: 'codex-thread-1' })
    h.runtime.receive(original)
    await h.runtime.idle()
    expect(c.call.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
    h.runtime.receive(feishu('2', 'Also explain the change', { root_id: 'om_1' }))
    await h.runtime.idle()
    expect(c.call.mock.calls.filter(([method]) => method === 'turn/steer')).toHaveLength(1)
    expect(h.runtime.store.tickets.get(ticket.id)?.undelivered).toEqual([])
  })
  it('interrupts a stopped ticket and rejects subsequent worker tool calls', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('1', 'Fix the trial file'))
    const c = connections[0]!
    h.runtime.engine.stopTicket(ticket.id, 'Owner stopped this work')
    await vi.waitFor(() => expect(c.close).toHaveBeenCalled())
    expect(c.call).toHaveBeenCalledWith('turn/interrupt', { threadId: 'codex-thread-1', turnId: 'turn-1' })
    await expect(c.options.request('item/tool/call', { threadId: 'codex-thread-1', turnId: 'turn-1',
      callId: 'late', tool: 'orchestrator_report', arguments: { state: 'ready', summary: 'late' } })).rejects.toThrow('does not own')
    expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('stopped')
  })
  it('closes a connection stopped before its thread start returns without starting a turn', async () => {
    const gate = Promise.withResolvers<void>()
    const { host: h, connections } = await fixture(false, false, () => gate.promise)
    const accepted = h.acceptedLegacyTicket(feishu('1', 'Fix the trial file'))
    await vi.waitFor(() => expect(connections[0]?.call).toHaveBeenCalledWith('thread/start', expect.anything()))
    const ticket = h.runtime.store.tickets.open()[0]!
    h.runtime.engine.stopTicket(ticket.id, 'Stop during startup')
    gate.resolve(); await accepted
    expect(connections[0]!.close).toHaveBeenCalledExactlyOnceWith()
    expect(connections[0]!.call.mock.calls.some(([method]) => method === 'turn/start')).toBe(false)
    expect(h.runtime.executor.activeCount()).toBe(0)
  })
  it('closes a connection superseded by disposal and can start again with a fresh connection', async () => {
    const gate = Promise.withResolvers<void>()
    const { host: h, connections } = await fixture(false, false, () => gate.promise)
    const accepted = h.acceptedLegacyTicket(feishu('1', 'Fix the trial file'))
    await vi.waitFor(() => expect(connections[0]?.call).toHaveBeenCalledWith('thread/start', expect.anything()))
    h.runtime.executor.dispose()
    gate.resolve(); const { ticket } = await accepted
    expect(connections[0]!.close).toHaveBeenCalledExactlyOnceWith()
    expect(connections[0]!.call.mock.calls.some(([method]) => method === 'turn/start')).toBe(false)
    h.runtime.executor.resume(); await h.runtime.idle()
    expect(connections).toHaveLength(2)
    expect(connections[1]!.call.mock.calls.some(([method]) => method === 'turn/start')).toBe(true)
    expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report).toBeUndefined()
    expect(h.runtime.executor.activeCount()).toBe(1)
  })
  it('closes a connection returned during host shutdown without starting a turn', async () => {
    const gate = Promise.withResolvers<void>()
    const { host: h, connections } = await fixture(false, false, () => gate.promise)
    const trigger = feishu('1', 'Fix the trial file')
    h.runtime.receive(trigger); await h.runtime.idle()
    h.runtime.engine.decide(trigger.id, { kind: 'accept', title: 'Fix file', scope: 'Fix file', name: 'fix-file', acknowledgement: 'Received: fix file.', reason: 'Legacy core executor acceptance' })
    await vi.waitFor(() => expect(connections[0]?.call).toHaveBeenCalledWith('thread/start', expect.anything()))
    const stopped = h.runtime.stop()
    gate.resolve(); await stopped
    expect(connections[0]!.close).toHaveBeenCalledExactlyOnceWith()
    expect(connections[0]!.call.mock.calls.some(([method]) => method === 'turn/start')).toBe(false)
  })
  it('does not let a superseded resume connection replace or close the retried worker', async () => {
    const gate = Promise.withResolvers<void>()
    const { host: h, connections } = await fixture(false, false, index => index === 1 ? gate.promise : undefined)
    const { ticket } = await h.acceptedLegacyTicket(feishu('1', 'Fix the trial file'))
    h.runtime.engine.report(ticket.id, { state: 'blocked', summary: 'Need a choice', question: 'Which option?' })
    connections[0]!.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await vi.waitFor(() => expect(h.runtime.executor.activeCount()).toBe(0))
    h.runtime.executor.dispose()
    h.runtime.receive(feishu('2', 'Use the first option', { root_id: 'om_1' }))
    h.runtime.engine.deliveryFailed(ticket.id, ticket.assignments.at(-1)!.id, 'Earlier input delivery failed')
    const delivering = h.runtime.idle()
    try {
      await vi.waitFor(() => expect(connections[1]?.call).toHaveBeenCalledWith('thread/resume', expect.anything()))
      h.runtime.engine.retryTicket(ticket.id)
      await vi.waitFor(() => expect(connections[2]?.call.mock.calls.some(([method]) => method === 'turn/start')).toBe(true))
    } finally { gate.resolve() }
    await delivering; await h.runtime.idle()
    expect(connections[1]!.close).toHaveBeenCalledExactlyOnceWith()
    expect(connections[2]!.close).not.toHaveBeenCalled()
    expect(h.runtime.executor.activeCount()).toBe(1)
  })
  it('interrupts an explicit human stop during the same turn that reported ready', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('1', 'Fix the trial file'))
    const current = h.runtime.store.tickets.get(ticket.id)!
    current.follows = [{ thread: 'github:7', own: true }]; h.runtime.store.tickets.save(current)
    h.runtime.engine.report(ticket.id, { state: 'ready', summary: 'Ready, waiting for PR' })
    h.runtime.engine.stopTicket(ticket.id, 'Stop even though the worker reported ready')
    await vi.waitFor(() => expect(connections[0]!.close).toHaveBeenCalledExactlyOnceWith())
    expect(connections[0]!.call).toHaveBeenCalledWith('turn/interrupt', { threadId: 'codex-thread-1', turnId: 'turn-1' })
  })
  it('allows a naturally completed ready turn to finish before closing its connection', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('1', 'Fix the trial file'))
    h.runtime.engine.report(ticket.id, { state: 'ready', summary: 'Completed' })
    expect(connections[0]!.close).not.toHaveBeenCalled()
    expect(connections[0]!.call.mock.calls.some(([method]) => method === 'turn/interrupt')).toBe(false)
    connections[0]!.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await vi.waitFor(() => expect(connections[0]!.close).toHaveBeenCalledExactlyOnceWith())
  })
  it('resumes the recorded Codex thread on recovered work rather than starting another', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('1', 'Fix the trial file'))
    h.runtime.executor.dispose()
    h.runtime.executor.resume()
    await h.runtime.idle()
    expect(connections).toHaveLength(2)
    expect(connections[1]!.call.mock.calls.find(([method]) => method === 'thread/resume')?.[1]).toMatchObject({ threadId: 'codex-thread-1', config: { 'sandbox_workspace_write.network_access': false } })
    expect(connections[1]!.call.mock.calls.some(([method]) => method === 'thread/start')).toBe(false)
    expect(h.runtime.store.tickets.get(ticket.id)?.assignments).toHaveLength(2)
  })
  it('does not translate an unreported completed turn into successful business completion', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('1', 'Fix the trial file'))
    connections[0]!.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await vi.waitFor(() => expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.state).toBe('waiting'))
    expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
  })
  it('handles completion arriving before the turn/start response without leaving a running slot', async () => {
    const { host: h } = await fixture(true)
    const { ticket } = await h.acceptedLegacyTicket(feishu('1', 'Fix the trial file'))
    expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.state).toBe('waiting')
    expect(h.runtime.store.get(KV.codex.binding(ticket.id))?.turnId).toBeUndefined()
    expect(h.runtime.executor.activeCount()).toBe(0)
  })
  it('does not launch Codex for an unlisted Feishu sender', async () => {
    const { host: h, connections } = await fixture()
    h.runtime.receive(feishu('9', 'Run this task', { sender_id: 'ou_unlisted' }))
    await h.runtime.idle()
    expect(h.runtime.store.tickets.list()).toEqual([])
    expect(connections).toEqual([])
  })
  it('keeps the coordinator model secret out of the Codex process environment', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-secret')
    const { host: h, connections } = await fixture()
    await h.acceptedLegacyTicket(feishu('1', 'Fix the trial file'))
    expect(connections[0]!.options.env?.DEEPSEEK_API_KEY).toBeUndefined()
    expect(connections[0]!.options.env?.DSH_SUPERAGENT_DIR).toContain('fix-regression')
  })
  it.each(['assistant-only', 'in-progress'])('retains uncertain delivery intent for %s history instead of replaying it', async mode => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('1', 'Fix the trial file'))
    const pending = { marker: 'uncertain-input-marker', inputIds: ['unconfirmed'] }
    h.runtime.store.set(KV.codex.binding(ticket.id), { threadId: 'codex-thread-1', pending })
    const c = connections[0]!, original = c.call.getMockImplementation()!
    c.call.mockImplementation(async (method, params) => method === 'thread/read' ? { thread: { turns: [{
      id: 'turn-1', status: mode === 'in-progress' ? 'inProgress' : 'completed',
      items: mode === 'in-progress' ? [{ type: 'userMessage', content: [{ type: 'text', text: pending.marker }] }]
        : [{ type: 'agentMessage', text: pending.marker }],
    }] } } : original(method, params))
    h.runtime.receive(feishu('2', 'Continue checking', { root_id: 'om_1' }))
    await h.runtime.idle()
    expect(h.runtime.store.get(KV.codex.binding(ticket.id))?.pending).toEqual(pending)
    expect(c.call.mock.calls.filter(([method]) => method === 'turn/steer')).toEqual([])
    expect(h.runtime.store.tickets.get(ticket.id)?.delivery?.error).toBeTruthy()
  })
  it('refuses a corrupted workspace path before another Codex process starts', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('1', 'Fix the trial file'))
    h.runtime.executor.dispose()
    const stored = h.runtime.store.tickets.get(ticket.id)!
    stored.execution!.directory = h.directory
    h.runtime.store.tickets.save(stored)
    h.runtime.executor.resume()
    await h.runtime.idle()
    const report = h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report
    expect(report?.state).toBe('failed')
    expect(report?.summary).toContain('outside the configured ticket root')
    expect(connections).toHaveLength(1)
  })
  it('interrupts a follow-up even when the previous turn reported ready while waiting for a PR', async () => {
    const { host: h, connections } = await fixture()
    const { ticket } = await h.acceptedLegacyTicket(feishu('1', 'Fix the trial file'))
    const current = h.runtime.store.tickets.get(ticket.id)!
    current.follows = [{ thread: 'github:7', own: true }]
    h.runtime.store.tickets.save(current)
    h.runtime.engine.report(ticket.id, { state: 'ready', summary: 'Ready, waiting for PR' })
    connections[0]!.options.notification('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await vi.waitFor(() => expect(h.runtime.executor.activeCount()).toBe(0))
    h.runtime.receive(feishu('2', 'Continue checking', { root_id: 'om_1' }))
    await h.runtime.idle()
    h.runtime.engine.stopTicket(ticket.id, 'Stop the follow-up')
    await vi.waitFor(() => expect(connections[0]!.call).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'codex-thread-1', turnId: 'turn-2',
    }))
  })
})
