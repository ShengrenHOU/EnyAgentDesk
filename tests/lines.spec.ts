/** Work lines: one long-lived goal grouping Tickets, its search evidence, and closure that never reopens unlinked. */
import { afterEach, expect, it, vi } from 'vitest'
import { attach, close, detail, linesView, open, reassign, reopen, search, unlinkedTickets } from '../src/app/lines.ts'
import { relatedLines } from '../src/app/cards.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const now = () => new Date(Date.now() + 1000)
const rename = (id: string, title: string) => {
  const ticket = h!.runtime.store.tickets.get(id)!
  h!.runtime.store.tickets.save({ ...ticket, title })
}
const end = (id: string, at: string) => {
  const ticket = h!.runtime.store.tickets.get(id)!
  const last = ticket.assignments.length - 1
  const assignments = ticket.assignments.map((assignment, index) => index === last
    ? { ...assignment, report: { state: 'ready' as const, summary: '阶段结果已归档', at } } : assignment)
  h!.runtime.store.tickets.save({ ...ticket, assignments, ended: { at, by: 'executor', outcome: 'completed' } })
}

it('groups Tickets for one goal, searches them, and keeps the whole line in stage order', async () => {
  h = await startRuntime()
  const first = await h.acceptedTicket(feishu('301', '申昊战略入股：盘点文档'))
  const second = await h.acceptedTicket(feishu('302', '申昊战略入股：推进方案'))
  rename(first.ticket.id, '申昊战略入股：飞书文档盘点')
  rename(second.ticket.id, '申昊战略入股：进展与推进步骤')
  const { line, created } = open(h.runtime.store, { title: '申昊战略入股', evidence: '同一交易：申昊智维投资任能，投前 5000 万元', at: now() })
  expect(created).toBe(true)
  attach(h.runtime.store, { lineId: line.id, ticketId: first.ticket.id, evidence: '盘点文档是同一入股交易的准备阶段', at: now() })
  attach(h.runtime.store, { lineId: line.id, ticketId: second.ticket.id, evidence: '推进步骤承接同一交易的对外方案', at: now() })
  // A follow-up left pending after its time passed is still an outstanding check, not a completed one.
  const openFirst = h.runtime.store.tickets.get(first.ticket.id)!
  h.runtime.store.tickets.save({ ...openFirst, followups: [{ id: 'followup-overdue', at: '2026-10-30T00:00:00.000Z',
    reason: '检查材料', createdAt: '2026-10-29T00:00:00.000Z' }] })

  const found = search(h.runtime.store, '申昊 入股', 8, now())
  expect(found.lines[0]).toMatchObject({ id: line.id, title: '申昊战略入股', ticketCount: 2, openCount: 2,
    latestJudgement: { action: 'attached', evidence: '推进步骤承接同一交易的对外方案' },
    nextFollowup: { ticketId: first.ticket.id, reason: '检查材料', overdue: true } })
  expect(found.tickets.map(ticket => ticket.id)).toEqual(expect.arrayContaining([first.ticket.id, second.ticket.id]))
  expect(found.tickets.find(ticket => ticket.id === first.ticket.id)?.line).toMatchObject({ id: line.id, status: 'open' })

  const page = detail(h.runtime.store, line.id, now())!
  expect(page.tickets.map(ticket => ticket.title)).toEqual(['申昊战略入股：飞书文档盘点', '申昊战略入股：进展与推进步骤'])
  expect(page.judgements.map(item => item.action)).toEqual(['opened', 'attached', 'attached'])
  expect(page.tickets.every(ticket => ticket.stage === 'working' || ticket.stage === 'idle')).toBe(true)
})

it('lists only open Tickets on no line, newest first and bounded', async () => {
  h = await startRuntime()
  const unlinked = await h.acceptedTicket(feishu('404', '未挂线的目标'))
  const linked = await h.acceptedTicket(feishu('405', '已挂线的目标'))
  const ended = await h.acceptedTicket(feishu('406', '已结束且未挂线'))
  const { line } = open(h.runtime.store, { title: '已有目标', evidence: '同一目标' })
  attach(h.runtime.store, { lineId: line.id, ticketId: linked.ticket.id, evidence: '同一目标' })
  end(ended.ticket.id, now().toISOString())
  const view = unlinkedTickets(h.runtime.store)
  expect(view.count).toBe(1)
  expect(view.items.map(ticket => ticket.id)).toEqual([unlinked.ticket.id])
  expect(unlinkedTickets(h.runtime.store, 1).items).toHaveLength(1)
})

it('reports the whole closed count while folding the closed history', async () => {
  h = await startRuntime()
  const store = h.runtime.store
  for (let index = 0; index < 11; index++) {
    const { line } = open(store, { title: `已完成目标 ${index}`, evidence: '同一目标' })
    close(store, { lineId: line.id, evidence: '目标已完成' })
  }
  const view = linesView(store, now())
  expect(view.open).toHaveLength(0)
  expect(view.closed).toHaveLength(10)
  expect(view.closedTotal).toBe(11)
})

it('refuses a second line for one Ticket and closes only after every stage ended', async () => {
  h = await startRuntime()
  const store = h.runtime.store
  const { ticket } = await h.acceptedTicket(feishu('303', '申昊战略入股：推进'))
  rename(ticket.id, '申昊战略入股：进展')
  const one = open(store, { title: '申昊战略入股', evidence: '交易同一', at: now() }).line
  const other = open(store, { title: '国电投上海投资口', evidence: '不同对手方', at: now() }).line
  attach(store, { lineId: one.id, ticketId: ticket.id, evidence: '同一交易', at: now() })
  expect(() => attach(store, { lineId: other.id, ticketId: ticket.id, evidence: '误挂' }))
    .toThrow('already belongs to line')

  expect(() => close(store, { lineId: one.id, evidence: '已经谈完', at: now() })).toThrow('open ticket')
  end(ticket.id, now().toISOString())
  expect(close(store, { lineId: one.id, evidence: '交易文件已归档，阶段结束', at: now() }).closed).toBe(true)
  expect(linesView(store, now()).open).toHaveLength(1)
  expect(linesView(store, now()).closed[0]).toMatchObject({ id: one.id, lastResult: { title: '申昊战略入股：进展' } })
  // A closed line takes no work until an explicit reopen with evidence; a message alone never reopens it.
  expect(() => attach(store, { lineId: one.id, ticketId: ticket.id, evidence: '又来消息' })).toThrow('closed')
  expect(reopen(store, { lineId: one.id, evidence: '对方重新启动同一轮入股谈判', at: now() }).reopened).toBe(true)
  expect(attach(store, { lineId: one.id, ticketId: ticket.id, evidence: '同一交易继续' }).changed).toBe(false)
})

it('keeps same-titled goals independent and reuses only the same creation request', async () => {
  h = await startRuntime()
  const first = open(h.runtime.store, { title: '项目推进', evidence: '对手方 A 的产品试点', requestId: 'creation-a', at: now() })
  const other = open(h.runtime.store, { title: '项目推进', evidence: '对手方 B 的独立融资', requestId: 'creation-b', at: now() })
  expect(other.created).toBe(true)
  expect(other.line.id).not.toBe(first.line.id)
  const again = open(h.runtime.store, { title: '项目推进', evidence: '对手方 A 的产品试点', requestId: 'creation-a', at: now() })
  expect(again.created).toBe(false)
  expect(again.line.id).toBe(first.line.id)
  expect(again.line.judgements).toHaveLength(1)
  const view = linesView(h.runtime.store, now())
  expect(view.open).toHaveLength(2)
  expect(search(h.runtime.store, '', 8, now()).lines.map(line => line.id)).toEqual(expect.arrayContaining([first.line.id, other.line.id]))
})

it('preserves both memberships on closed destinations, stale source links and a failed second write', async () => {
  h = await startRuntime()
  const store = h.runtime.store
  const { ticket } = await h.acceptedTicket(feishu('membership-rollback', '检查错误关联'))
  const from = open(store, { title: '来源主线', evidence: '原归类' }).line
  const to = open(store, { title: '目标主线', evidence: '独立目标' }).line
  attach(store, { lineId: from.id, ticketId: ticket.id, evidence: '最初判断' })
  close(store, { lineId: to.id, evidence: '这条目标已结束' })
  const input = { lineId: from.id, ticketId: ticket.id, targetLineId: to.id, evidence: '纠正归属', by: 'owner' as const }
  expect(() => reassign(store, input)).toThrow('target line is closed')
  expect(detail(store, from.id)!.tickets.map(item => item.id)).toEqual([ticket.id])
  reopen(store, { lineId: to.id, evidence: '本人明确恢复' })
  const beforeFrom = detail(store, from.id), beforeTo = detail(store, to.id)
  const original = store.set.bind(store)
  const fail = vi.spyOn(store, 'set').mockImplementationOnce((key, value) => original(key, value))
    .mockImplementationOnce(() => { throw new Error('synthetic second write failed') })
  expect(() => reassign(store, input)).toThrow('second write failed')
  fail.mockRestore()
  expect(detail(store, from.id)).toEqual(beforeFrom)
  expect(detail(store, to.id)).toEqual(beforeTo)
  expect(reassign(store, input).changed).toBe(true)
  const third = open(store, { title: '另一主线', evidence: '另一目标' }).line
  expect(() => reassign(store, { ...input, targetLineId: third.id })).toThrow('membership changed')
  expect(detail(store, to.id)!.tickets.map(item => item.id)).toEqual([ticket.id])
})

it('keeps repeated corrections as history and can detach from a closed line without reopening it', async () => {
  h = await startRuntime()
  const store = h.runtime.store
  const { ticket } = await h.acceptedTicket(feishu('membership-history', '独立事项'))
  const from = open(store, { title: '项目 A', evidence: '第一项目' }).line
  const to = open(store, { title: '项目 B', evidence: '第二项目' }).line
  attach(store, { lineId: from.id, ticketId: ticket.id, evidence: '第一判断' })
  const forward = { lineId: from.id, ticketId: ticket.id, targetLineId: to.id, evidence: '重新判断', by: 'owner' as const }
  reassign(store, forward)
  reassign(store, { ...forward, lineId: to.id, targetLineId: from.id })
  reassign(store, forward)
  expect(detail(store, from.id)!.judgements.filter(item => item.action === 'moved')).toHaveLength(3)
  end(ticket.id, now().toISOString())
  close(store, { lineId: to.id, evidence: '阶段完成' })
  reassign(store, { ...forward, lineId: to.id, targetLineId: null })
  expect(detail(store, to.id)).toMatchObject({ status: 'closed', ticketCount: 0,
    latestJudgement: { action: 'detached', by: 'owner' } })
  expect(store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
})

it('records a real reattachment with identical evidence while keeping attachment retries quiet', async () => {
  h = await startRuntime()
  const store = h.runtime.store
  const { ticket } = await h.acceptedTicket(feishu('membership-reattach', '重新归入原目标'))
  const { line } = open(store, { title: '原项目', evidence: '一个明确目标' })
  const input = { lineId: line.id, ticketId: ticket.id, evidence: '同一阶段' }
  attach(store, input)
  reassign(store, { ...input, targetLineId: null, by: 'owner' })
  expect(attach(store, input).changed).toBe(true)
  expect(detail(store, line.id)!.judgements.map(item => item.action)).toEqual(['opened', 'attached', 'detached', 'attached'])
  expect(attach(store, input).changed).toBe(false)
  expect(detail(store, line.id)!.judgements).toHaveLength(4)
})

it('recalls possible lines from a message\'s words as bounded evidence, without changing membership', async () => {
  h = await startRuntime()
  const store = h.runtime.store
  const first = await h.acceptedTicket(feishu('401', '申昊战略入股：盘点文档'))
  const unrelated = await h.acceptedTicket(feishu('402', '国电投上海投资口：材料整理'))
  rename(first.ticket.id, '申昊战略入股：飞书文档盘点')
  rename(unrelated.ticket.id, '国电投上海投资口：材料整理')
  const { line } = open(store, { title: '申昊战略入股', evidence: '同一交易：申昊智维投资任能' })
  attach(store, { lineId: line.id, ticketId: first.ticket.id, evidence: '盘点文档是同一入股交易的准备阶段' })
  const other = open(store, { title: '国电投上海投资口', evidence: '不同对手方' }).line
  attach(store, { lineId: other.id, ticketId: unrelated.ticket.id, evidence: '材料整理' })
  const found = relatedLines(store, '董事会一页纸：申昊产业入股与战略合作')
  expect(found?.note).toContain('不是归属')
  expect(found?.items.map(item => item.line_id)).toEqual([line.id])
  expect(found?.items[0]).toMatchObject({ line_id: line.id, status: 'open', active: { ticket_id: first.ticket.id },
    matched: expect.arrayContaining(['申昊']) })
  expect(found?.items[0]!.recent_tickets[0]).toMatchObject({ ticket_id: first.ticket.id, title: '申昊战略入股：飞书文档盘点' })
  // The recall is read-only and bounded: the line keeps exactly its member, and an unrelated message recalls nothing.
  expect(detail(store, line.id)!.ticketCount).toBe(1)
  expect(relatedLines(store, '今天天气不错，出去走走')).toBeUndefined()
  // The candidate card carries the same evidence, so the main Session can judge membership on its own screen.
  const trigger = feishu('403', '@bot 董事会一页纸：申昊产业入股与战略合作')
  h.runtime.receive(trigger); await h.runtime.idle()
  const card = h.relays(h.runtime.masterId).filter(item => item.kind === 'candidate' && item.trigger_id === trigger.id).at(-1)!
  expect(card.related_lines).toMatchObject({ note: expect.stringContaining('不是归属'),
    items: [expect.objectContaining({ line_id: line.id, read: { tool: 'orchestrator_line', action: 'view', line_id: line.id } })] })
})
