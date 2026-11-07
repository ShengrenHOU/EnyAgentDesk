/** The platform's worker tools, orchestration passes and management views share one durable follow-up. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { setupChanged } from '../src/app/setup.ts'
import { ticketFollowups } from '../src/core/index.ts'

let host: Host
let clock: number
const followup = (id = 'check-document') => ({ request_id: id, at: new Date(clock + 60_000).toISOString(), reason: 'Check the project document' })
const wakeMessages = () => host.deliveries.mock.calls.filter(([message]) => message.text.includes('Scheduled follow-up'))
beforeEach(async () => {
  host = await startRuntime()
  clock = Date.now()
  vi.useFakeTimers({ toFake: ['Date'], now: clock })
})
afterEach(async () => { vi.useRealTimers(); await host.stop() })

it('agents arrange their own task and the coordinator applies known management changes through the shared operation', async () => {
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot Arrange this project'))
  await host.runTool(sessionId, 'orchestrator_plan', { priority: 'high', dueAt: new Date(clock + 600_000).toISOString() })
  expect(host.runtime.store.tickets.get(ticket.id)).toMatchObject({ priority: 'high' })
  await expect(host.runTool(sessionId, 'orchestrator_plan', { ticket_id: 'another-task', priority: 'urgent' })).rejects.toThrow()
  await host.runTool(host.runtime.masterId, 'orchestrator_ticket_manage', { ticket_id: ticket.id, change: { paused: true } })
  expect(host.runtime.store.tickets.get(ticket.id)?.paused).toBe(true)
  await host.runTool(host.runtime.masterId, 'orchestrator_ticket_manage', { ticket_id: ticket.id, change: { paused: false } })
  expect(host.runtime.store.tickets.get(ticket.id)?.paused).toBe(false)
})

it('cancels one scheduled check through the management API while the other continues to hold completion', async () => {
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot Follow both milestones'))
  await host.runTool(sessionId, 'orchestrator_followup', followup('one'))
  await host.runTool(sessionId, 'orchestrator_followup', { ...followup('two'), reason: 'Check the second milestone' })
  expect(await host.runTool(sessionId, 'orchestrator_read', { resource: `ticket/${ticket.id}` })).toMatchObject({
    followups: [expect.objectContaining({ id: 'one' }), expect.objectContaining({ id: 'two' })],
  })
  await expect(host.runTool(sessionId, 'orchestrator_followup_cancel', {})).rejects.toThrow('specify request_id')
  expect(ticketFollowups(host.runtime.store.tickets.get(ticket.id)!)).toHaveLength(2)
  const response = await host.api('DELETE', `tickets/${ticket.id}/followup?request_id=one`)
  expect(response).toMatchObject({ status: 200, body: { cancelled: true, receipt: { requestId: 'one' } } })
  expect(ticketFollowups(host.runtime.store.tickets.get(ticket.id)!).map(item => item.id)).toEqual(['two'])
  await expect(host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done' })).rejects.toThrow(/follow.up/i)
})

it('a worker schedules its own follow-up, remains open while waiting and continues the same session once', async () => {
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot Follow the document delivery'))
  const requested = followup()
  expect(await host.runTool(sessionId, 'orchestrator_followup', requested)).toMatchObject({ status: 'scheduled' })
  await expect(host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done' })).rejects.toThrow(/follow.up/i)
  const agent = host.agents.get(sessionId)!
  agent.status = 'idle'; host.ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await host.runtime.idle()
  const before = host.runtime.store.tickets.get(ticket.id)!
  expect(before.ended).toBeUndefined()
  expect(ticketFollowups(before)[0]).toMatchObject({ at: requested.at, reason: requested.reason })
  expect(wakeMessages()).toHaveLength(0)
  clock += 60_000; vi.setSystemTime(clock)
  await host.runtime.pump(); await host.runtime.idle()
  expect(wakeMessages()).toHaveLength(1)
  expect(wakeMessages()[0]![0].sessionId).toBe(sessionId)
  const after = host.runtime.store.tickets.get(ticket.id)!
  expect(after.assignments).toHaveLength(1)
  expect(ticketFollowups(after)).toEqual([])
  expect(after.inputs.filter(input => input.kind === 'note')).toHaveLength(1)
  await host.runtime.pump(); await host.runtime.idle()
  expect(wakeMessages()).toHaveLength(1)
})

it('holds a due timer for a necessary decision and delivers it after the answer is accepted', async () => {
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot Follow the project'))
  await host.runTool(sessionId, 'orchestrator_followup', followup())
  await host.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Need project choice', human_action: 'Which project?' })
  clock += 60_000; vi.setSystemTime(clock)
  await host.runtime.pump(); await host.runtime.idle()
  expect(wakeMessages()).toHaveLength(0)
  expect(ticketFollowups(host.runtime.store.tickets.get(ticket.id)!)).toHaveLength(1)
  host.runtime.receive(feishu('2', 'Use project A', { mentions: [], root_id: 'om_1' }))
  await host.runtime.idle()
  host.step(sessionId)
  await host.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Project A selected', human_action: null })
  await host.runtime.pump(); await host.runtime.idle()
  expect(wakeMessages()).toHaveLength(1)
  expect(host.runtime.store.tickets.get(ticket.id)!.attention).toBeUndefined()
})

it('the management API exposes and cancels the same follow-up the worker created', async () => {
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot Follow this delivery'))
  const requested = followup()
  await host.runTool(sessionId, 'orchestrator_followup', requested)
  expect(await host.api('GET', `tickets/${ticket.id}`)).toMatchObject({ status: 200,
    body: { followup: expect.objectContaining({ at: requested.at, reason: requested.reason }) } })
  expect(await host.api('DELETE', `tickets/${ticket.id}/followup`)).toMatchObject({ status: 200, body: { cancelled: true } })
  expect(ticketFollowups(host.runtime.store.tickets.get(ticket.id)!)).toEqual([])
  expect(await host.api('POST', `tickets/${ticket.id}/followup`, { ...requested, request_id: 'invalid', at: 'tomorrow' })).toMatchObject({ status: 400 })
  clock += 60_000; vi.setSystemTime(clock)
  await host.runtime.pump(); await host.runtime.idle()
  expect(wakeMessages()).toHaveLength(0)
})

it('a manual stop clears scheduled work and no due pass resumes the stopped ticket', async () => {
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot Follow this project'))
  await host.runTool(sessionId, 'orchestrator_followup', followup())
  expect(await host.api('POST', `tickets/${ticket.id}/stop`)).toMatchObject({ status: 200 })
  await host.runtime.idle()
  expect(host.runtime.store.tickets.get(ticket.id)).toMatchObject({ ended: { by: 'human', outcome: 'stopped' } })
  expect(ticketFollowups(host.runtime.store.tickets.get(ticket.id)!)).toEqual([])
  clock += 60_000; vi.setSystemTime(clock)
  await host.runtime.pump(); await host.runtime.idle()
  expect(wakeMessages()).toHaveLength(0)
})

it('an individually paused ticket retains its overdue follow-up until the panel resumes it', async () => {
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot Follow this delivery'))
  await host.runTool(sessionId, 'orchestrator_followup', followup())
  expect(await host.api('PUT', `tickets/${ticket.id}/management`, { paused: true })).toMatchObject({ status: 200 })
  clock += 60_000; vi.setSystemTime(clock)
  await host.runtime.pump(); await host.runtime.idle()
  expect(wakeMessages()).toHaveLength(0)
  expect(ticketFollowups(host.runtime.store.tickets.get(ticket.id)!)).toHaveLength(1)
  expect(await host.api('PUT', `tickets/${ticket.id}/management`, { paused: false })).toMatchObject({ status: 200 })
  await host.runtime.pump(); await host.runtime.idle()
  expect(wakeMessages()).toHaveLength(1)
})

it('a Feishu-only profile starts without a GitHub account, renders settings and completes a non-repository task', async () => {
  vi.useRealTimers()
  await host.stop()
  host = await startRuntime(store => {
    const settings = store.settings()
    store.saveSettings({ ...settings, sources: { ...settings.sources, github: { enabled: false, config: {} } } })
  })
  clock = Date.now(); vi.useFakeTimers({ toFake: ['Date'], now: clock })
  expect(host.runtime.configured()).toBe(true)
  expect(host.runtime.deployment.repository).toBe('')
  expect(host.runtime.deployment.github).toBeUndefined()
  const settings = await host.api('GET', 'settings')
  expect(settings.status).toBe(200)
  expect(settings.body.sources).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'github', facts: {}, value: { enabled: false, config: expect.anything() } })]))
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot Organize the supplied reading notes'))
  expect(host.runtime.ticketEnvironment(ticket).some(variable => variable.owner === 'github')).toBe(false)
  await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Reading notes organized' })
  expect(host.runtime.store.tickets.get(ticket.id)).toMatchObject({ ended: { outcome: 'completed' } })
})

it('enabling or disabling GitHub with unchanged account fields requires setup reconciliation', () => {
  const enabled = host.runtime.store.settings()
  const disabled = { ...enabled, sources: { ...enabled.sources, github: { ...enabled.sources.github!, enabled: false } } }
  expect(setupChanged(enabled, disabled)).toBe(true)
  expect(setupChanged(disabled, enabled)).toBe(true)
  expect(setupChanged(enabled, { ...enabled, executor: { ...enabled.executor, maxWorkers: enabled.executor.maxWorkers + 1 } })).toBe(false)
})
