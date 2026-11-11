/** The main Session's line tool: semantic continuation evidence, retroactive grouping, and non-reopening closure. */
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { detail } from '../src/app/lines.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const rename = (host: Host, id: string, title: string) => {
  const ticket = host.runtime.store.tickets.get(id)!
  host.runtime.store.tickets.save({ ...ticket, title })
}
const line = (host: Host, id: string) => detail(host.runtime.store, id)!

it('hands a judged receipt to an existing worker through normal tools and fences cached reads after revocation', async () => {
  h = await startRuntime(undefined, { triageHandoff: true, triageProduction: true })
  const { ticket, sessionId } = await h.acceptedTicket(feishu('evidence-work', 'Review deployment evidence'))
  const runtime = h.runtime, sourceId = 'evidence-test'
  runtime.sources.register({ kind: sourceId, title: { en: 'Evidence', zh: 'Evidence' }, description: { en: 'Evidence', zh: 'Evidence' },
    schema: z.object({}), fields: [], health: [], scope: () => ({ listened: true, observed: true }),
    imEvidence: trigger => ({ provider: 'test', account: 'owner', conversation: 'chat', message: trigger.id, version: '1', partial: false }),
    imContext: async (_commands, request) => ({ provider: 'test', account: 'owner', conversation: 'chat', start: request.start, end: request.end,
      consistency: 'live_paginated', gaps: [], messages: [{ id: request.anchor.message, text: request.anchorText, version: '1', createdAt: request.start }] }) })
  const settings = runtime.store.settings()
  runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, [sourceId]: { allowed: [{ id: 'sender' }] } } } })
  const id = 'deployment-evidence'
  runtime.engine.receive({ id, source: sourceId, threads: [{ source: sourceId, id: 'chat' }], actor: { source: sourceId, id: 'sender' }, human: true,
    text: 'Deployment evidence from a native source', at: '2026-11-11T01:00:00.000Z', meta: {} })
  runtime.triageHandoffs.adopt('evidence-owner', [id], runtime.triageHandoffs.preview([id]).fingerprint)
  const [batch] = runtime.productionTriage.start('evidence-owner', 1, { start: '2026-11-11T00:00:00.000Z', end: '2026-11-12T00:00:00.000Z' })
  await runtime.idle(); h.consume()
  const current = runtime.productionTriage.read(batch!.id), context = current.contexts[id]!
  let offset: number | null = 0
  do { offset = runtime.productionTriage.context(current.id, 1, id, offset).next_offset } while (offset !== null)
  runtime.productionTriage.submit(current.id, 1, current.binding!, { model: 'test', items: [{ triggerId: id, kind: 'informational',
    reason: 'Deployment update', context: { revision: context.revision, hash: context.hash }, matterIds: ['deployment'] }],
    matters: [{ id: 'deployment', title: 'Deployment update', reason: 'Same deployment', triggerIds: [id] }] })
  const matter = runtime.productionTriage.matters.overview().groups[0]!
  const args = { ticket_id: ticket.id, text: 'Read the deployment update', matter_id: matter.id, matter_revision: matter.revision }
  const first = await h.runTool(runtime.masterId, 'orchestrator_ticket_note', args)
  expect(first.saved).toBe(true)
  expect((await h.runTool(runtime.masterId, 'orchestrator_ticket_note', args)).reused).toBe(true)
  expect(runtime.store.tickets.get(ticket.id)!.inputs.filter(input => input.kind === 'note')).toHaveLength(1)
  const page = await h.runTool(sessionId, 'orchestrator_read', { resource: `ticket/${ticket.id}/evidence` }) as { items: { reference: string }[] }
  const resource = `ticket/${ticket.id}/evidence/${page.items[0]!.reference}`
  const read = await h.runTool(sessionId, 'orchestrator_read', { resource, limit: 100 })
  expect(read.text).toContain('batchId')
  await expect(h.runTool(sessionId, 'orchestrator_read', { resource: `triage/evidence/${page.items[0]!.reference}` })).rejects.toThrow('main Session')
  runtime.store.saveSettings({ ...runtime.store.settings(), sources: { ...runtime.store.settings().sources, [sourceId]: { enabled: false, config: {} } } })
  await expect(h.runTool(sessionId, 'orchestrator_read', { resource, offset: 100 })).rejects.toThrow('access changed')
})

it('uses the native call identity for retries, while allowing separately chosen goals with the same title', async () => {
  h = await startRuntime()
  await h.acceptedTicket(feishu('line-native-call', '准备独立目标'))
  const args = { action: 'open', title: '项目推进', evidence: '对手方 A 的产品试点' }
  const first = await h.runTool(h.runtime.masterId, 'orchestrator_line', args, 'native-open-a') as { line: { id: string } }
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_line', args, 'native-open-a'))
    .toMatchObject({ created: false, line: { id: first.line.id } })
  const other = await h.runTool(h.runtime.masterId, 'orchestrator_line', { ...args, evidence: '对手方 B 的独立融资' },
    'native-open-b') as { line: { id: string }; created: boolean }
  expect(other.created).toBe(true)
  expect(other.line.id).not.toBe(first.line.id)
  await h.runTool(h.runtime.masterId, 'orchestrator_line', { action: 'close', line_id: first.line.id, evidence: '本人结束这条线' })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_line', args, 'native-open-a'))
    .toMatchObject({ created: false, line: { id: first.line.id, status: 'closed' } })
})

it('corrects a mistaken link with an auditable move or detach, without changing the Ticket', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('line-correction', '同一对手方的独立目标'))
  const make = async (title: string) => (await h!.runTool(h!.runtime.masterId, 'orchestrator_line',
    { action: 'open', title, evidence: '两个目标分别推进' }) as { line: { id: string } }).line.id
  const from = await make('融资'), to = await make('产品测试')
  await h.runTool(h.runtime.masterId, 'orchestrator_line', { action: 'attach', line_id: from,
    ticket_id: ticket.id, evidence: '最初归类' })
  const before = structuredClone(h.runtime.store.tickets.get(ticket.id))
  const move = { action: 'move', line_id: from, target_line_id: to, ticket_id: ticket.id, evidence: '这是产品测试，不是融资' }
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_line', move)).toMatchObject({ changed: true })
  expect(line(h, from).tickets).toHaveLength(0)
  expect(line(h, to).tickets.map(item => item.id)).toEqual([ticket.id])
  for (const id of [from, to]) expect(line(h, id).judgements.at(-1)).toMatchObject({ action: 'moved', ticketId: ticket.id,
    fromLine: { id: from, title: '融资' }, toLine: { id: to, title: '产品测试' }, evidence: move.evidence })
  const count = line(h, to).judgements.length
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_line', move)).toMatchObject({ changed: false })
  expect(line(h, to).judgements).toHaveLength(count)
  const detach = { action: 'detach', line_id: to, ticket_id: ticket.id, evidence: '本次仅为独立事项，暂不挂线' }
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_line', detach)).toMatchObject({ changed: true })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_line', detach)).toMatchObject({ changed: false })
  expect(line(h, to).tickets).toHaveLength(0)
  expect(line(h, to).judgements.at(-1)).toMatchObject({ action: 'detached', fromLine: { id: to } })
  expect(h.runtime.store.tickets.get(ticket.id)).toEqual(before)
})

it('searches, opens, attaches and closes a line through the main Session tool', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('401', '申昊战略入股：盘点'))
  rename(h, ticket.id, '申昊战略入股：飞书文档盘点')
  const opened = await h.runTool(h.runtime.masterId, 'orchestrator_line', { action: 'open', title: '申昊战略入股',
    evidence: '同一入股交易：申昊智维投资任能，投前 5000 万元' }) as { line: { id: string }; created: boolean }
  expect(opened.created).toBe(true)
  const attached = await h.runTool(h.runtime.masterId, 'orchestrator_line', { action: 'attach', line_id: opened.line.id,
    ticket_id: ticket.id, evidence: '盘点文档是同一入股交易的准备阶段' }) as { changed: boolean }
  expect(attached.changed).toBe(true)

  const found = await h.runTool(h.runtime.masterId, 'orchestrator_line', { action: 'search', query: '申昊 入股' }) as
    { lines: { id: string; active?: { id: string } }[]; tickets: { id: string; line?: { id: string } }[] }
  expect(found.lines[0]).toMatchObject({ id: opened.line.id, active: { id: ticket.id } })
  expect(found.tickets.find(item => item.id === ticket.id)?.line).toMatchObject({ id: opened.line.id })
  const viewed = await h.runTool(h.runtime.masterId, 'orchestrator_line', { action: 'view', line_id: opened.line.id }) as
    { tickets: { id: string }[]; judgements: { action: string }[] }
  expect(viewed.tickets.map(item => item.id)).toEqual([ticket.id])
  expect(viewed.judgements.map(item => item.action)).toEqual(['opened', 'attached'])

  await expect(h.runTool(h.runtime.masterId, 'orchestrator_line', { action: 'close', line_id: opened.line.id,
    evidence: '已经谈完' })).rejects.toThrow('open ticket')
  const row = h.runtime.store.tickets.get(ticket.id)!
  h.runtime.store.tickets.save({ ...row, ended: { at: new Date().toISOString(), by: 'executor', outcome: 'completed' } })
  const closed = await h.runTool(h.runtime.masterId, 'orchestrator_line', { action: 'close', line_id: opened.line.id,
    evidence: '交易文件已归档，阶段结束' }) as { closed: boolean }
  expect(closed.closed).toBe(true)
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_line', { action: 'attach', line_id: opened.line.id,
    ticket_id: ticket.id, evidence: '又来一条消息' })).rejects.toThrow('closed')
  const reopened = await h.runTool(h.runtime.masterId, 'orchestrator_line', { action: 'restore', line_id: opened.line.id,
    evidence: '对方重新启动同一轮入股谈判' }) as { restored: boolean }
  expect(reopened.restored).toBe(true)
  expect(line(h, opened.line.id).judgements.map(item => item.action)).toEqual(['opened', 'attached', 'closed', 'reopened'])
})

it('accepts a new stage into a line atomically and keeps the accept idempotent', async () => {
  h = await startRuntime()
  const trigger = feishu('402', '申昊战略入股：出一版对外方案')
  h.runtime.receive(trigger)
  await h.runtime.idle()
  const item = { kind: 'accept', trigger_id: trigger.id, title: '申昊战略入股：对外方案', worktree_name: 'line-accept',
    acknowledgement: '收到，按原主线准备对外方案。', line_title: '申昊战略入股', line_evidence: '同一交易，承接同一轮对外沟通' }
  const result = await h.route(item) as { line: { id: string }; ticket: { ticket_id: string } }
  expect(line(h, result.line.id).tickets.map(ticket => ticket.id)).toEqual([result.ticket.ticket_id])
  const again = await h.route(item) as { line: { id: string }; reason: string }
  expect(again.reason).toContain('Already accepted')
  expect(line(h, result.line.id).tickets).toHaveLength(1)
  expect(line(h, result.line.id).tickets[0]!.id).toBe(result.ticket.ticket_id)

  const corrected = await h.runTool(h.runtime.masterId, 'orchestrator_line', { action: 'open', title: '本人更正后的目标',
    evidence: '本人确认最初的归类错误' }) as { line: { id: string } }
  await h.runTool(h.runtime.masterId, 'orchestrator_line', { action: 'move', line_id: result.line.id,
    target_line_id: corrected.line.id, ticket_id: result.ticket.ticket_id, evidence: '本人更正归属' })
  expect(await h.route(item)).toMatchObject({ line: { id: corrected.line.id } })
  expect(line(h, result.line.id).tickets).toHaveLength(0)

  // A different goal starts its own line; a refused link leaves no accepted Ticket behind.
  const other = feishu('403', '国电投上海投资口：确定周几拜访')
  h.runtime.receive(other)
  await h.runtime.idle()
  const before = h.runtime.store.tickets.list().length
  await expect(h.route({ kind: 'accept', trigger_id: other.id, title: '国电投拜访', worktree_name: 'line-other',
    acknowledgement: '收到，确认国电投拜访时间。', line_id: result.line.id, line_evidence: '' })).rejects.toThrow('line_evidence')
  expect(h.runtime.store.tickets.list()).toHaveLength(before)
})

it('does not merge independently accepted goals by their identical line titles', async () => {
  h = await startRuntime()
  const accept = async (id: string, evidence: string) => {
    const trigger = feishu(id, evidence)
    h!.runtime.receive(trigger); await h!.runtime.idle()
    return h!.route({ kind: 'accept', trigger_id: trigger.id, title: evidence, worktree_name: id,
      acknowledgement: '收到，按独立目标推进。', line_title: '项目推进', line_evidence: evidence }) as Promise<{ line: { id: string } }>
  }
  const first = await accept('same-title-a', '对手方 A 的产品试点')
  const other = await accept('same-title-b', '对手方 B 的独立融资')
  expect(other.line.id).not.toBe(first.line.id)
  expect(line(h, first.line.id).tickets).toHaveLength(1)
  expect(line(h, other.line.id).tickets).toHaveLength(1)
})

it('continues the line\'s open Ticket with the trigger and records the evidence', async () => {
  h = await startRuntime()
  const first = await h.acceptedTicket(feishu('404', '申昊战略入股：推进'))
  rename(h, first.ticket.id, '申昊战略入股：进展与推进')
  const opened = await h.runTool(h.runtime.masterId, 'orchestrator_line', { action: 'open', title: '申昊战略入股',
    evidence: '同一入股交易' }) as { line: { id: string } }
  await h.runTool(h.runtime.masterId, 'orchestrator_line', { action: 'attach', line_id: opened.line.id,
    ticket_id: first.ticket.id, evidence: '推进阶段属于同一交易' })
  const followUp = feishu('405', '申昊补充：先把对外版金额定下来')
  h.runtime.receive(followUp)
  await h.runtime.idle()
  const continued = await h.runTool(h.runtime.masterId, 'orchestrator_line', { action: 'continue', line_id: opened.line.id,
    trigger_id: followUp.id, evidence: '同一交易同一轮对外沟通，补充金额口径' }) as { continued: boolean }
  expect(continued.continued).toBe(true)
  const ticket = h.runtime.store.tickets.get(first.ticket.id)!
  expect(ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === followUp.id)).toBe(true)
  expect(line(h, opened.line.id).judgements.at(-1)).toMatchObject({ action: 'continued', triggerId: followUp.id })

  // With no open stage the line cannot continue: the next work is accepted under the line instead.
  h.runtime.engine.stopTicket(first.ticket.id)
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(first.ticket.id)?.ended).toBeTruthy()
  const next = feishu('406', '申昊又来一条')
  h.runtime.receive(next)
  await h.runtime.idle()
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_line', { action: 'continue', line_id: opened.line.id,
    ticket_id: first.ticket.id, trigger_id: next.id, evidence: '同一交易' })).rejects.toThrow('has ended')
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_line', { action: 'continue', line_id: opened.line.id,
    trigger_id: next.id, evidence: '同一交易' })).rejects.toThrow('no open Ticket')
})
