// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { Workbench } from '../src/client/personal-workbench.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { zh } from '../src/client/locales.ts'
import { fullTime } from '../src/client/text.ts'
import { translator, click, settle, type } from './fixtures/panel.tsx'
import { server, ticketSummary, usePanelServer } from './fixtures/panel-server.ts'

let root: Root
usePanelServer(() => { act(() => root?.unmount()); document.body.innerHTML = ''; localStorage.clear() })
interface QueueItem { id: string; ticketId: string; attentionId: string; title: string; question: string
  advice?: { summary: string; reason?: string; risk?: string; draft?: string }; source?: string; at: string }
interface Queue { items: QueueItem[]; deferred: (QueueItem & { until: string })[]
  ignored: (QueueItem & { ignoredAt: string; reason: string })[]; counts: { open: number; deferred: number; ignored: number } }
/** The fake host has no workbench routes; the queue is the fixture's pending Questions unless a test passes its own. */
async function mount(focus: object | null = null, requested: object | null = null, domains: object[] = [],
  queue?: Partial<Queue> & { down?: boolean }) {
  const original = globalThis.fetch
  const refresh = vi.fn()
  const actions: Record<string, unknown>[] = []
  const items = server.person.flatMap(ticket => ticket.attention ? [{ id: `q-${ticket.id}`, ticketId: ticket.id,
    attentionId: ticket.attention.id, title: ticket.title, question: ticket.attention.question, source: 'feishu', at: ticket.updatedAt }] : [])
  const view: Queue = { items, deferred: [], ignored: [], counts: { open: items.length, deferred: 0, ignored: 0 }, ...queue }
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/focus')) return Response.json({ focus, requested, domains })
    if (input.endsWith('/focus/refresh')) { refresh(); return Response.json({ queued: true }) }
    if (input.endsWith('/queue')) return queue?.down
      ? Response.json({ error: 'Native workbench is disabled' }, { status: 503 })
      : Response.json(view)
    if (input.endsWith('/queue/action')) { actions.push(JSON.parse(String(init?.body))); return Response.json({ saved: true }) }
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
  return { send, openSession, refresh, actions, openManagement, openDomainSettings, openGithubSettings, openWorkList }
}

it('shows the agent recommendation and accepts its draft with one click', async () => {
  const original = globalThis.fetch
  const answers: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/answer')) { answers.push(JSON.parse(String(init?.body))); return Response.json({ saved: true }) }
    return original(url, init)
  }))
  const advice = { summary: 'Apply blue', reason: 'The design review chose blue', risk: 'Contrast is unverified', draft: 'Blue is applied; please review.' }
  await mount(null, null, [], { items: [{ id: 'q1', ticketId: 't1', attentionId: 'q1', title: '修复回归', question: '需要确认按钮颜色',
    advice, source: 'feishu', at: '2026-09-23T00:00:00Z' }], counts: { open: 1, deferred: 0, ignored: 0 } })
  expect(document.querySelector('.pw-decision')?.textContent).toContain(advice.summary)
  expect(document.querySelector('.pw-decision')?.textContent).toContain(advice.reason)
  expect(document.querySelector('.pw-decision')?.textContent).toContain(advice.risk)
  expect(document.querySelector('.pw-draft')?.textContent).toBe(advice.draft)
  await click(zh.queueAccept)
  expect(answers).toEqual([expect.objectContaining({ ticketId: 't1', attentionId: 'q1', instruction: advice.draft })])
  expect(document.body.textContent).toContain(zh.queueAccepted)
})

it('defers one decision and records a reversible “no action needed” decision', async () => {
  const { actions } = await mount()
  await click(zh.queueDefer)
  expect(actions[0]).toMatchObject({ action: 'defer', ticketId: 't1', attentionId: 'q1' })
  const until = new Date(String(actions[0]!.until))
  expect([until.getHours(), until.getMinutes()]).toEqual([9, 0])
  await click(zh.queueIgnore)
  const input = document.querySelector<HTMLInputElement>('.pw-ignore-form input')!
  await type(input, '已当面答复')
  await click(zh.queueIgnoreConfirm)
  expect(actions[1]).toMatchObject({ action: 'ignore', ticketId: 't1', attentionId: 'q1', reason: '已当面答复' })
})

it('is silent when nothing needs a decision and drops a folded record only after the correction is sent', async () => {
  server.person = []
  const { actions, send } = await mount(null, null, [], { items: [], counts: { open: 0, deferred: 0, ignored: 1 },
    ignored: [{ id: 'i1', ticketId: 't1', attentionId: 'q0', title: '旧事项', question: '要处理吗？', at: '2026-11-08T00:00:00Z',
      ignoredAt: '2026-11-08T00:00:00Z', reason: '已经处理' }] })
  expect(document.querySelectorAll('.pw-decision')).toHaveLength(0)
  expect(document.body.textContent).toContain(zh.queueEmpty)
  expect(document.body.textContent).toContain(zh.queueSilence)
  await click(zh.queueReclassify)
  // Opening the correction must not erase the folded record; cancelling leaves it intact.
  expect(actions).toHaveLength(0)
  expect(document.querySelector('.pw-supplement textarea')).not.toBeNull()
  await type(document.querySelector<HTMLTextAreaElement>('.pw-supplement textarea')!, '其实还要补一份说明')
  await click(zh.workbenchSendUpdate)
  expect(send).toHaveBeenCalledWith('master', expect.stringContaining('其实还要补一份说明'))
  expect(actions).toEqual([{ action: 'forget', ticketId: 't1', attentionId: 'q0' }])
})

it('keeps a failed Ticket without a Question visible for recovery, retry or stop', async () => {
  server.person = [ticketSummary({ id: 't4', title: '截图工具', actions: { retry: true, stop: true }, summary: 'LlmError: no adapter registered' },
    { stage: 'person', action: 'failed' })]
  await mount(null, null, [], { items: [], counts: { open: 0, deferred: 0, ignored: 0 } })
  expect(document.body.textContent).toContain(zh.queueRecovery)
  expect(document.body.textContent).toContain('截图工具')
  expect(document.body.textContent).not.toContain(zh.queueEmpty)
  const retry = [...document.querySelectorAll<HTMLButtonElement>('.pw-recovery button')].find(button => button.textContent === zh.retry)!
  await click(retry)
  await click(zh.confirm)
  expect(server.requests).toContainEqual(expect.objectContaining({ method: 'POST', path: 'tickets/t4/retry' }))
})

it('renders the independent overview sections when the optional workbench queue is unavailable', async () => {
  server.person = []
  server.work = { working: [ticketSummary({ id: 'w1', title: '进行中的事项' })], workingTotal: 1, waiting: [], waitingTotal: 0, delivered: [], deliveredTotal: 0 }
  await mount(null, null, [], { down: true })
  expect(document.body.textContent).toContain('Native workbench is disabled')
  expect(document.body.textContent).toContain(zh.homeProgress)
  expect(document.body.textContent).toContain('进行中的事项')
  expect(document.body.textContent).not.toContain(zh.queueSilence)
})

it('opens the existing GitHub source settings from the workbench', async () => {
  const { openGithubSettings } = await mount()
  await click(zh.homeGithubSettings)
  expect(openGithubSettings).toHaveBeenCalledOnce()
})

it('shows all checks beyond the four visible task cards and cancels only the selected check', async () => {
  const original = server.ticketDetails.t1!
  for (let index = 0; index < 12; index++) server.ticketDetails[`agenda-${index}`] = { ...original, id: `agenda-${index}`,
    title: `后续事项 ${index}`, attention: index === 11 ? { id: 'choice', question: 'Which scope?' } : undefined,
    followups: [{ id: 'first', at: '2099-01-01T00:00:00Z', reason: `核对结果 ${index}`, createdAt: '2026-11-08T00:00:00Z' },
      { id: 'second', at: '2099-01-02T00:00:00Z', reason: `核对反馈 ${index}`, createdAt: '2026-11-08T00:00:00Z' }] }
  await mount(null)
  await click(document.querySelector<HTMLButtonElement>('.dt-followup-toggle')!)
  expect(document.querySelectorAll('.dt-followup-agenda li')).toHaveLength(24)
  expect(document.querySelector('.dt-followup-agenda')?.textContent).toContain(zh['followupBlock.attention'])
  const first = [...document.querySelectorAll<HTMLButtonElement>('.dt-followup-agenda li button')].find(button => button.textContent === zh.homeCancelFollowup)!
  await click(first)
  await click(zh.confirm)
  expect(document.querySelectorAll('.dt-followup-agenda li')).toHaveLength(23)
  expect(server.requests).toContainEqual(expect.objectContaining({ method: 'DELETE', path: 'tickets/agenda-0/followup?request_id=first' }))
})

it('keeps unavailable-evaluation recovery reachable from the daily problem details', async () => {
  await mount()
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
  await mount()
  expect(document.body.textContent).toContain('核对签收')
  expect(document.body.textContent).toContain('核对付款')
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.pw-task button')].filter(button => button.textContent === zh.homeCancelFollowup)
  await click(buttons[0]!)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(task.title)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(fullTime(checks[0]!.at, 'zh'))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(checks[0]!.reason)
  await click(zh.confirm)
  expect(server.requests.filter(item => item.method === 'DELETE').at(-1)?.path).toBe(`tickets/${task.id}/followup?request_id=first`)
  expect(server.ticketDetails[task.id]!.followups?.map(item => item.id)).toEqual(['second'])
})

it('adds one line to a running matter without leaving the workbench', async () => {
  server.person = []
  server.work = { working: [ticketSummary({ id: 't2', title: '另一项工作' })], workingTotal: 1, waiting: [], waitingTotal: 0, delivered: [], deliveredTotal: 0 }
  const { send, openSession } = await mount()
  await click(zh.ownerDeskRevise)
  const input = document.querySelector<HTMLTextAreaElement>('.pw-supplement textarea')!
  expect(input.getAttribute('aria-label')).toBe(zh.workbenchReplyInstruction)
  await type(input, '先按 A 修，补充背景见上一条。')
  await click(zh.workbenchSendUpdate)
  expect(send).toHaveBeenCalledWith('master', expect.stringMatching(/^请继续已有工单 t2。本人补充或修改要求如下。/))
  expect(send.mock.calls[0]![1]).toContain('先按 A 修')
  expect(openSession).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain(zh.homeSent)
  expect(document.querySelector('.pw-shell')?.getAttribute('data-chat')).toBe('false')
})

it('saves an answer on its Ticket without sending prose to the main Session', async () => {
  const original = globalThis.fetch
  const answers: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/answer')) { answers.push(JSON.parse(String(init?.body))); return Response.json({ saved: true }) }
    return original(url, init)
  }))
  const { send } = await mount()
  await click(zh.queueRevise)
  await type(document.querySelector<HTMLTextAreaElement>('.pw-supplement textarea')!, '其余工作建立独立单')
  await click(zh.workbenchSendUpdate)
  expect(answers).toEqual([expect.objectContaining({ ticketId: 't1', attentionId: expect.any(String), instruction: '其余工作建立独立单' })])
  expect(send).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain(zh.ticketAnswerSent)
})

it('explains why discussion, answers and updates are unavailable without a main Session', async () => {
  server.masterId = ''
  const { send } = await mount({ headline: '先核对原说明的实际使用情况', generatedAt: new Date().toISOString(), items: [
    { title: '复核说明', reason: '原说明已有交付', nextAction: '先讨论是否需要补充', ticketId: 't1', evidence: '原事项', stale: false },
  ] })
  expect(document.body.textContent).toContain(zh.masterNotReady)
  const discuss = [...document.querySelectorAll<HTMLButtonElement>('.pw-reference button')]
    .find(button => button.textContent === zh.homeDiscuss)!
  expect(discuss.disabled).toBe(true)
  await click(zh.queueRevise)
  const input = document.querySelector<HTMLTextAreaElement>('.pw-supplement textarea')!
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

it('filters reference suggestions by business domain without hiding a pending decision', async () => {
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
  expect(document.querySelector('.pw-reference')?.textContent).not.toContain('模型报告')
  expect(document.body.textContent).toContain(zh.homeDomainEmpty)
  // A pending decision is not a suggestion and stays visible under any domain filter.
  expect(document.querySelectorAll('.pw-decision')).toHaveLength(1)
  await click(zh.homeDiscussDomain)
  expect(send).toHaveBeenCalledWith('master', expect.stringContaining('不启动业务执行'))
  expect(send.mock.calls[0]?.[1]).toContain('策略研究')
  expect(openSession).toHaveBeenCalledWith('master')
  await click(zh.homeManageDomains)
  expect(openDomainSettings).toHaveBeenCalledOnce()
})

it('opens the original main conversation from the prominent daily entry', async () => {
  const { openSession, send } = await mount()
  await click(zh.mainConversationEntry)
  expect(openSession).toHaveBeenCalledWith('master')
  expect(send).not.toHaveBeenCalled()
  expect(document.querySelector('.pw-domain-grid')?.textContent).toContain(zh.homeDomainPending)
})

it('shows required decisions before progress and reference suggestions', async () => {
  await mount()
  const decision = document.querySelector('.pw-decision')!
  const progress = [...document.querySelectorAll('.pw-section-title')].find(item => item.querySelector('h2')?.textContent === zh.homeProgress)!
  expect(decision.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(document.querySelector('.pw-decisions')).toBeNull()
})

it('shows the real total beyond overview limits and links to full work and result history', async () => {
  server.person = []
  const working = Array.from({ length: 10 }, (_, index) => ticketSummary({ id: `work-${index}`, title: `事项 ${index}` }))
  server.work = { working, workingTotal: 11, waiting: [], waitingTotal: 0, delivered: [], deliveredTotal: 0 }
  const { openWorkList } = await mount()
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
  const { send, openManagement } = await mount()
  expect(document.body.textContent).toContain(zh.queueHint)
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

it('never regenerates a reading projection by the calendar or by changed evidence', async () => {
  const { send, refresh } = await mount({ headline: 'Earlier suggestion', generatedAt: new Date().toISOString(), items: [
    { title: 'Old evidence', reason: 'Changed', nextAction: 'Reread it', ticketId: 't1', evidence: 'Work', stale: true },
  ] })
  expect(refresh).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain(zh.queueReference)
})
