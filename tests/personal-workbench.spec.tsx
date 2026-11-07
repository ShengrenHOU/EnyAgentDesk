// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { Workbench } from '../src/client/personal-workbench.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { zh } from '../src/client/locales.ts'
import { translator, click, settle, type } from './fixtures/panel.tsx'
import { server, ticketSummary, usePanelServer } from './fixtures/panel-server.ts'

let root: Root
usePanelServer(() => { act(() => root?.unmount()); document.body.innerHTML = '' })
async function mount(focus: object | null, requested: object | null = null, domains: object[] = []) {
  const original = globalThis.fetch
  const refresh = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/focus')) return Response.json({ focus, requested, domains })
    if (input.endsWith('/focus/refresh')) { refresh(); return Response.json({ queued: true }) }
    return original(input, init)
  }))
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const send = vi.fn(async (_id: string, _text: string) => {})
  const openSession = vi.fn(async (_id: string) => {})
  const openManagement = vi.fn()
  const openDomainSettings = vi.fn()
  const openGithubSettings = vi.fn()
  const openWorkList = vi.fn()
  await act(async () => { root.render(<PanelProvider t={translator(zh)} openSession={openSession}><Workbench t={translator(zh)}
    send={send} openSession={openSession} openManagement={openManagement} openDomainSettings={openDomainSettings} openGithubSettings={openGithubSettings} openWorkList={openWorkList} /></PanelProvider>) })
  await settle()
  return { send, openSession, refresh, openManagement, openDomainSettings, openGithubSettings, openWorkList }
}

it('opens the existing GitHub source settings from the workbench', async () => {
  const { openGithubSettings } = await mount(null)
  await click(zh.homeGithubSettings)
  expect(openGithubSettings).toHaveBeenCalledOnce()
})

it('keeps unavailable-evaluation recovery reachable from the daily problem details', async () => {
  await mount(null)
  const details = document.querySelector<HTMLDetailsElement>('details.pw-runtime-note')!
  expect(details).not.toBeNull()
  await act(async () => { details.querySelector('summary')!.click() })
  expect(details.textContent).toContain(zh.requeue)
  expect(details.textContent).toContain(zh.dismiss)
  await click(zh.requeue)
  expect(server.requests).toContainEqual(expect.objectContaining({ method: 'POST', path: 'triggers/e3/requeue' }))
})

it('shows independent follow-ups and cancels only the selected check', async () => {
  const checks = [{ id: 'first', at: '2099-01-01T00:00:00.000Z', reason: '核对签收', createdAt: '2026-11-06T00:00:00.000Z' },
    { id: 'second', at: '2099-01-02T00:00:00.000Z', reason: '核对付款', createdAt: '2026-11-06T00:00:00.000Z' }]
  const task = server.tickets.open[0]!
  task.followup = checks[0]; task.followups = checks
  server.ticketDetails[task.id]!.followup = checks[0]; server.ticketDetails[task.id]!.followups = checks
  server.person = []
  server.work = { working: [task], workingTotal: 1, waiting: [], waitingTotal: 0, delivered: [], deliveredTotal: 0 }
  await mount(null)
  expect(document.body.textContent).toContain('核对签收')
  expect(document.body.textContent).toContain('核对付款')
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.pw-task button')].filter(button => button.textContent === zh.homeCancelFollowup)
  await click(buttons[0]!)
  await click(zh.confirm)
  expect(server.requests.filter(item => item.method === 'DELETE').at(-1)?.path).toBe(`tickets/${task.id}/followup?request_id=first`)
  expect(server.ticketDetails[task.id]!.followups?.map(item => item.id)).toEqual(['second'])
})

it('adds one line to the selected matter without leaving the workbench', async () => {
  const { send, openSession } = await mount(null)
  await click(zh.ownerDeskRevise)
  const input = document.querySelector<HTMLInputElement>('.pw-supplement input')!
  await type(input, '先按 A 修，补充背景见上一条。')
  await click(zh.workbenchSendUpdate)
  expect(send).toHaveBeenCalledWith('master', expect.stringMatching(/^请继续已有工单 t\d+。本人补充或修改要求如下。/))
  expect(send.mock.calls[0]![1]).toContain('先按 A 修')
  expect(openSession).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain(zh.homeSent)
  expect(document.querySelector('.pw-shell')?.getAttribute('data-chat')).toBe('false')
})

it('explains why discussion, answers and updates are unavailable without a main Session', async () => {
  server.masterId = ''
  const { send } = await mount({ headline: '先核对原说明的实际使用情况', generatedAt: new Date().toISOString(), items: [
    { title: '复核说明', reason: '原说明已有交付', nextAction: '先讨论是否需要补充', ticketId: 't1', evidence: '原事项', stale: false },
  ] })
  expect(document.body.textContent).toContain(zh.masterNotReady)
  const discuss = [...document.querySelectorAll<HTMLButtonElement>('.pw-focus button')]
    .find(button => button.textContent === zh.homeDiscuss)!
  expect(discuss.disabled).toBe(true)
  await click(zh.workbenchAnswer)
  const input = document.querySelector<HTMLInputElement>('.pw-supplement input')!
  await type(input, '先按 A 修，补充背景见上一条。')
  const submit = [...document.querySelectorAll<HTMLButtonElement>('.pw-supplement button')]
    .find(button => button.textContent === zh.workbenchSendUpdate)!
  expect(submit.disabled).toBe(true)
  expect(input.disabled).toBe(false)
  expect(input.value).toBe('先按 A 修，补充背景见上一条。')
  expect(send).not.toHaveBeenCalled()
})

it('keeps detailed discussion in the main Session instead of a second transcript', async () => {
  const { send, openSession } = await mount({ headline: '先核对原说明的实际使用情况', generatedAt: '2026-11-05T00:00:00Z', items: [
    { title: '复核说明', reason: '原说明已有交付', nextAction: '先讨论是否需要补充', ticketId: 't1', evidence: '原事项', stale: false },
  ] })
  expect(document.body.textContent).toContain(zh.homeSupplementEmpty)
  expect(document.querySelector('.pw-dialogue')).toBeNull()
  await click(zh.homeDiscuss)
  expect(send).toHaveBeenCalledWith('master', expect.stringContaining('不启动执行'))
  expect(send.mock.calls[0]?.[1]).toContain('关联工单 t1')
  expect(openSession).toHaveBeenCalledWith('master')
})

it('distinguishes a source update from linked work without creating a ticket', async () => {
  const { send, openManagement } = await mount({ headline: '新动态', generatedAt: new Date().toISOString(), items: [
    { title: '读新消息', reason: '来源有变化', nextAction: '先读原文', threadKey: 'feishu:updates', evidence: '项目群', stale: false },
  ] })
  await click(`${zh.homeSourceUpdate}项目群`)
  expect(openManagement).toHaveBeenCalledWith(undefined, 'feishu:updates')
  expect(send).not.toHaveBeenCalled()
})

it('filters by configured business domain and discusses an empty domain without claiming coverage', async () => {
  const { send, openSession, openDomainSettings } = await mount({ headline: 'Current work', generatedAt: new Date().toISOString(), items: [
    { title: '模型报告', reason: '已交付', nextAction: '读取报告', ticketId: 't1', evidence: '模型事项', stale: false, domainId: 'mle' },
  ] }, null, [
    { id: 'mle', name: 'MLE', scope: '模型与预测', state: 'active' },
    { id: 'quant', name: 'Quant', scope: '策略研究', state: 'active' },
    { id: 'parked', name: '休眠方向', scope: '稍后', state: 'dormant' },
  ])
  expect(document.querySelectorAll('.pw-domain')).toHaveLength(3)
  expect(document.querySelector('.pw-domain-grid')?.textContent).not.toContain('休眠方向')
  const quant = [...document.querySelectorAll<HTMLButtonElement>('.pw-domain')].find(button => button.textContent?.includes('Quant'))!
  await click(quant)
  expect(quant.getAttribute('aria-pressed')).toBe('true')
  expect(document.querySelector('.pw-focus')?.textContent).not.toContain('模型报告')
  expect(document.body.textContent).toContain(zh.homeDomainEmpty)
  await click(zh.homeDiscussDomain)
  expect(send).toHaveBeenCalledWith('master', expect.stringContaining('不启动业务执行'))
  expect(send.mock.calls[0]?.[1]).toContain('策略研究')
  expect(openSession).toHaveBeenCalledWith('master')
  await click(zh.homeManageDomains)
  expect(openDomainSettings).toHaveBeenCalledOnce()
})

it('opens the original main conversation from the prominent daily entry', async () => {
  const { openSession, send } = await mount(null)
  await click(zh.mainConversationEntry)
  expect(openSession).toHaveBeenCalledWith('master')
  expect(send).not.toHaveBeenCalled()
  expect(document.querySelector('.pw-domain-grid')?.textContent).toContain(zh.homeDomainPending)
})

it('shows required decisions before model suggestions without hiding them behind domain filters', async () => {
  await mount(null)
  const decisions = document.querySelector('.pw-decisions')!
  const focus = document.querySelector('.pw-focus')!
  expect(decisions.compareDocumentPosition(focus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it('shows the real total beyond overview limits and links to full work and result history', async () => {
  server.person = []
  const working = Array.from({ length: 10 }, (_, index) => ticketSummary({ id: `work-${index}`, title: `事项 ${index}` }))
  server.work = { working, workingTotal: 11, waiting: [], waitingTotal: 0, delivered: [], deliveredTotal: 0 }
  const { openWorkList } = await mount(null)
  const heading = [...document.querySelectorAll('.pw-section-title')].find(item => item.querySelector('h2')?.textContent === zh.homeProgress)!
  expect(heading.querySelector('span')?.textContent).toBe('11')
  await click(zh.homeAllWork)
  expect(openWorkList).toHaveBeenLastCalledWith('open')
  expect(document.body.textContent).toContain('最近 24 小时')
  await click(zh.homeFullHistory)
  expect(openWorkList).toHaveBeenLastCalledWith('ended')
})

it('confirms ending only the selected task and retains its record and results', async () => {
  const other = ticketSummary({ id: 't2', title: '另一项工作' })
  server.person = []
  server.tickets.open.push(other)
  server.work = { working: [server.tickets.open[0]!, other], workingTotal: 2, waiting: [], waitingTotal: 0, delivered: [], deliveredTotal: 0 }
  server.ticketDetails.t1!.deliverables = [{ title: '已有成果', url: 'https://example.com/report' }]
  const { send, openManagement } = await mount(null)
  expect(document.body.textContent).toContain(zh.homeFocusHint)
  const end = document.querySelector<HTMLButtonElement>('.pw-task .pw-actions button:nth-child(2)')!
  await click(end)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('修复回归')
  await click(zh.cancel)
  expect(server.requests.filter(request => request.path.endsWith('/stop'))).toHaveLength(0)
  await click(end)
  await click(zh.confirm)
  expect(server.requests.filter(request => request.path.endsWith('/stop'))).toEqual([
    expect.objectContaining({ path: 'tickets/t1/stop', method: 'POST' }),
  ])
  expect(document.body.textContent).toContain('已结束“修复回归”')
  expect(document.body.textContent).toContain('已有成果')
  await click(zh.homeFullRecord)
  expect(openManagement).toHaveBeenCalledWith('t1')
  await click(zh.homeBack)
  expect(document.querySelector('.pw-task-grid')?.textContent).not.toContain('修复回归')
  expect(document.body.textContent).toContain('另一项工作')
  expect(send).not.toHaveBeenCalled()
})

it('keeps refresh retryable when an earlier reading request has not published a result', async () => {
  const { refresh, send } = await mount(null, { id: 'pending', at: new Date().toISOString() })
  expect(refresh).not.toHaveBeenCalled()
  await click(zh.homeRefresh)
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(send).not.toHaveBeenCalled()
})

it.each([null, { headline: 'Earlier suggestion', generatedAt: new Date().toISOString(), items: [
  { title: 'Old evidence', reason: 'Changed', nextAction: 'Reread it', ticketId: 't1', evidence: 'Work', stale: true },
] }])('requests a reading projection once for missing or changed evidence without delegating work', async focus => {
  const { send, refresh } = await mount(focus)
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(send).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain(zh.homeFocus)
})
