// @vitest-environment jsdom
// The Execution status, a Ticket, and the Execution settings.
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, find, tab, click, type, text, field, at } from './fixtures/panel.tsx'
import { MEMBER, server, ticketSummary, threadSummary } from './fixtures/panel-server.ts'

usePanel()
it('edits priority and deadline on the original ticket page and exposes follow-up and usable deliverables', async () => {
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!,
    followup: { id: 'later', at: '2026-11-05T02:00:00Z', reason: 'Check the requested reply', createdAt: '2026-11-04T00:00:00Z' },
    deliverables: [{ title: 'Research note', url: 'https://example.com/research-note' }] }
  at({ page: 'execution', id: 't1' }); await mount()
  expect(text()).toContain('Check the requested reply')
  expect(document.querySelector<HTMLAnchorElement>('a[href="https://example.com/research-note"]')?.textContent).toContain('Research note')
  await click(zh.taskManagement)
  await type(field(zh.ticketPriority), 'urgent')
  await type(field(zh.ticketDueAt), '2026-11-05T10:00')
  await click(all('label').find(label => label.textContent?.trim() === zh.ticketPaused)!)
  await click(zh.managementSave)
  expect(server.requests.find(request => request.path === 'tickets/t1/management')).toMatchObject({ method: 'PUT',
    body: { priority: 'urgent', dueAt: new Date('2026-11-05T10:00').toISOString(), paused: true } })
  expect(server.ticketDetails.t1?.priority).toBe('urgent')
  expect(server.ticketDetails.t1?.taskPaused).toBe(true)
})

it('shows the saved full report for completed and ready Codex Tickets without a DSH Session link', async () => {
  const summary = '审查完成。\n\n[报告证据](https://github.com/acme/widgets/pull/42)\n\n' + '保留限定。'.repeat(100) + '\n报告末尾已保留。'
  const original = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...original, stage: 'ended',
    actions: { retry: false, stop: false }, sessionId: '', codexThreadId: 'native-thread', summary,
    ended: { at: '2026-09-23T00:00:00Z', by: 'executor', outcome: 'completed' } }
  at({ page: 'execution', id: 't1' }); await mount()
  expect(text()).toContain(zh.latestExecutionReport)
  expect(text()).toContain('报告末尾已保留。')
  expect(all('.dt-disclosure-body a').some(link => link.getAttribute('href') === 'https://github.com/acme/widgets/pull/42')).toBe(true)
  expect(text()).toContain(zh.codexReportHistoryHint)
  expect(text()).toContain('Codex: native-thread')
  expect(all('.dt-page-head button').some(button => button.textContent?.includes(zh.openSession))).toBe(false)
  server.ticketDetails.t1 = { ...original, stage: 'person', action: 'review', ended: undefined,
    actions: { retry: false, stop: true }, sessionId: '', codexThreadId: 'native-thread', summary }
  await remount()
  expect(text()).toContain(zh.latestExecutionReport)
  expect(text()).toContain('报告末尾已保留。')
})

it('keeps a completed DSH result readable with its executor handoff history', async () => {
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, executor: 'dsh', stage: 'ended', actions: { retry: false, stop: false },
    ended: { by: 'executor', outcome: 'completed', at: '2026-11-04T00:00:00Z' }, summary: 'Completed DSH research result',
    executorHandoffs: [{ from: 'codex', to: 'dsh', at: '2026-11-03T23:00:00Z',
      handoff: { purpose: 'Continue research', decisions: 'Keep scope', results: 'Existing notes', evidence: 'notes.md', remaining: 'Summarize' } }] }
  at({ page: 'execution', id: 't1' }); await mount()
  expect(text()).toContain('Completed DSH research result')
  expect(text()).toContain(zh.executorHandoffs)
  expect(text()).toContain('Codex → DSH / DeepSeek')
  expect(text()).not.toContain(zh.codexReportHistoryHint)
})

it('shows the full waiting report and next step for an idle DSH ticket while preserving its Session', async () => {
  const summary = 'Waiting for the partner reply.\n\nNext: compare it with the draft and retain the existing decisions.'
  const original = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...original, executor: 'dsh', stage: 'idle', summary }
  at({ page: 'execution', id: 't1' }); await mount()
  expect(text()).toContain(zh.latestExecutionReport)
  expect(text()).toContain('Next: compare it with the draft and retain the existing decisions.')
  expect(text()).not.toContain(zh.codexReportHistoryHint)
  await click(find(zh.openSession, '.dt-page-head button'))
  expect(server.opened).toEqual(['worker-t1'])
  server.ticketDetails.t1 = { ...original, executor: 'dsh', stage: 'working', action: undefined }
  await remount()
  expect(text()).not.toContain(zh.latestExecutionReport)
})

it('uses Windows directory and environment syntax while showing the Codex model as read-only', async () => {
  server.setup.machine = { ...server.setup.machine, prepareShell: 'powershell', executor: { kind: 'codex', model: 'codex-native-test' } }
  at({ page: 'settings', query: { group: 'execution' } }); await mount()
  expect(all('.dt-model input')).toHaveLength(0)
  const model = field<HTMLInputElement>(zh.modelName)
  expect(model.disabled).toBe(true)
  expect(model.value).toBe('codex-native-test')
  expect(text()).toContain(zh.executorCodexModelHint)
  const directory = field<HTMLInputElement>(zh.executionDirectory)
  await type(directory, 'C:/work/my tasks')
  expect(directory.checkValidity()).toBe(true)
  const prepare = field<HTMLTextAreaElement>(zh.prepareCommand)
  await type(prepare, 'git worktree add ')
  prepare.setSelectionRange(17, 17)
  await click('可用的环境变量 3'); await click('DSH_SUPERAGENT_DIR')
  expect(prepare.value).toBe('git worktree add "$env:DSH_SUPERAGENT_DIR"')
  await click(zh.save)
  expect(server.settings.executor).toMatchObject({ directory: 'C:/work/my tasks', prepare: 'git worktree add "$env:DSH_SUPERAGENT_DIR"', model: null })
  server.setup.machine.executor = { kind: 'codex', model: null }
  await remount()
  expect(field<HTMLInputElement>(zh.modelName).value).toBe(zh.executorCodexLocalModel)
})

it('lists Tickets under Execution by who they wait on, with the Executor state and its pause as an action', async () => {
  server.tickets.open = [ticketSummary(), ticketSummary({ id: 't2', title: '执行中的工单', threads: [{ key: 'github:7',
    source: 'github', title: '#7 x', facts: { number: { value: '#7' }, autoMerge: { label: { zh: '自动合并', en: 'Auto-merge' },
      value: { zh: '已开启', en: 'on' } } } }] })]
  await mount()
  await click(zh['tab.execution'])
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh.statusTitle)
  expect(server.requests.some(request => request.path === 'tickets?state=open&limit=20')).toBe(true)
  expect(text()).toContain(zh.executorRunning)
  expect(all('.dt-chip').map(chip => chip.textContent)).toContain('GitHub#7自动合并已开启')
  await click(zh.idleLabel)
  expect(server.requests.some(request => request.path === 'tickets?state=idle&limit=20')).toBe(true)
  expect(text()).toContain('执行器结束了当前回合')
  await click(zh['ticket.ended'])
  expect(text()).toContain('旧工单')
  expect(text()).toContain(zh['outcome.stopped'])
  expect(all('.dt-status-line .dt-lv').map(item => item.textContent)).toEqual(['执行中 2 / 3', '排队 0'])
  // The pause is its own action: an Execution settings draft started before it still saves.
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['promptPart.runtime/work'])
  await type(field<HTMLInputElement>(zh.maxWorkers), '4')
  await click(tab(zh['tab.execution']))
  await click(zh.pauseProcessing)
  await click(zh.confirm)
  expect(server.requests.find(request => request.path === 'executor/pause')).toMatchObject({ method: 'POST', body: { paused: true } })
  expect(text()).toContain(zh.processingPaused)
  expect(find(zh.resumeProcessing).textContent).toBe(zh.resumeProcessing)
  await click(tab(zh['tab.settings']))
  await click(zh.save)
  expect(server.settings).toMatchObject({ paused: true, executor: { maxWorkers: 4 } })
})

it('stops an open Ticket from its page after confirmation', async () => {
  await mount()
  await click('修复回归')
  await click(zh.stop)
  expect(server.requests.some(request => request.path.endsWith('/stop'))).toBe(false)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('停止“修复回归”')
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t1/stop' && request.method === 'POST')).toBe(true)
})

it('shows a Ticket with its stage, its Mandate details with the Trigger and Decision behind it, its Threads, and the rest behind disclosures', async () => {
  await mount()
  await click(all('.dt-open').find(button => button.textContent === '修复回归')!)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
  // Progress is in the Channels and the Session, so the page has no report section.
  expect(all('.dt-section-title').map(title => title.querySelector('.dt-section-name')?.textContent)).toEqual(['下次跟进', '授权详情', '未送达的输入', '订阅的线程'])
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh.executingLabel)
  expect(document.querySelector('.dt-status-line .dt-stage .dt-spinner')).not.toBeNull()
  // A Thread this Ticket follows reads as subscribed on its page, though no other Ticket follows it.
  expect(all('.dt-list .dt-ticket .dt-stage').map(stage => stage.textContent)).toContain(zh.threadSubscribed)
  expect(all('.dt-list .dt-ticket .dt-stage').map(stage => stage.textContent)).not.toContain(zh.threadUnsubscribed)
  expect(all('.dt-status-line .dt-lv').map(item => item.textContent)).toEqual(['授权 明确', '发起 飞书 · Alice', expect.stringMatching(/^更新 /)])
  for (const expected of ['修复登录页回归', '点名方式@ 智能体', '名单里的人明确请求，由主 Session 接单', '未送达：等待派工运行',
    'Alice：顺便改标题']) expect(text()).toContain(expected)
  expect(all('.dt-chip').map(chip => chip.textContent)).toContain('飞书团队群')
  await click(zh['term.channel'])
  expect(all('.dt-disclosure-body a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['飞书消息',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1'], ['GitHub #42', 'https://github.com/acme/widgets/issues/42']])
  await click(zh['term.environment'])
  expect(all('.dt-disclosure-body .dt-table tr').map(row => row.textContent)).toEqual(['DSH_SUPERAGENT_DIR/w/t1',
    'DSH_SUPERAGENT_GITHUB_NUMBER—'])
  await click(document.querySelector<HTMLElement>('.dt-trigger-link')!)
  expect(tab(zh['tab.trigger']).getAttribute('aria-selected')).toBe('true')
})

it('reports a missing Ticket instead of rendering an empty page', async () => {
  at({ page: 'execution', id: 'missing' })
  await mount()
  expect(document.querySelector('.dt-hint')?.textContent).toBe(zh.ticketNotFound)
})

it('links a question to its Channel, folds consecutive automated messages among Inputs, and shows field explanations in a hover tooltip',
  async () => {
  const ci = (id: string, at: string, failed: number) => ({ id, kind: 'trigger' as const, triggerId: `c${id}`, at, delivered: true,
    trigger: { id: `c${id}`, actor: { source: 'github', id: '' }, human: false,
      preview: `CI of PR #42 at abc1234: 10 checks, ${failed} failed, 0 running.`, thread: 'github:42' } })
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'answer', attention: { id: 'q1', question: '需要确认按钮颜色' }, inputs: [ci('i3',
    '2026-09-22T00:06:00Z', 1), ci('i2', '2026-09-22T00:05:00Z', 0)] }
  await mount()
  await click(all('.dt-open').find(button => button.textContent === '修复回归')!)
  expect(all('.dt-banner a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['去飞书回答',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1']])
  await click('已送达的输入 · 2')
  expect(all('.dt-disclosure-body .dt-row-title').map(title => title.textContent)).toEqual(['自动通知：CI of PR #42 at abc1234: 10 checks, 1 failed, 0 running.'])
  await click('同一发送者之前还有 1 条自动消息')
  expect(text()).toContain('CI of PR #42 at abc1234: 10 checks, 0 failed, 0 running.')
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(text()).not.toContain('到期后记为未完成')
  const tip = field(zh.evalTimeout).closest('.dt-field')!.querySelector<HTMLElement>('.dt-info')!
  await act(async () => { tip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('到期后记为未完成')
  expect(tip.closest('.dt-field')!.textContent).not.toContain('到期后记为未完成')
  await act(async () => { tip.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
})

it('answers a workbench Ticket\'s pending question directly on its page', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'answer', attention: { id: 'q1', question: '需要确认按钮颜色' },
    mandate: { ...t1.mandate, actor: { source: 'workbench', id: 'owner' } },
    channels: [{ source: 'workbench', url: '#superagent', sessionId: 'master', label: { zh: 'DSH 工作台', en: 'DSH workbench' } }] }
  const base = globalThis.fetch
  const updates: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('/api/superagent-workbench/discussion')) return Response.json({ throughSeq: 7 })
    if (String(url) === '/api/superagent-workbench/answer') {
      updates.push(JSON.parse(String(init?.body)))
      return Response.json({ saved: true })
    }
    return base(url, init)
  }))
  at({ page: 'execution', id: 't1' }); await mount()
  const answer = field<HTMLTextAreaElement>(zh.workbenchReplyInstruction)
  await type(answer, '用蓝色')
  await click(zh.workbenchSendUpdate)
  expect(updates).toEqual([expect.objectContaining({ ticketId: 't1', attentionId: 'q1',
    instruction: '用蓝色' })])
  expect(text()).toContain(zh.ticketAnswerSent)
})

it('supplements a workbench Ticket without requiring an outstanding question', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, attention: undefined,
    mandate: { ...t1.mandate, actor: { source: 'workbench', id: 'owner' } },
    channels: [{ source: 'workbench', url: '#superagent', sessionId: 'master', label: { zh: 'DSH 工作台', en: 'DSH workbench' } }] }
  const original = globalThis.fetch
  const updates: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/superagent-workbench/discussion')) return Response.json({ throughSeq: 7 })
    if (url === '/api/superagent-workbench/update') { updates.push(JSON.parse(String(init?.body))); return Response.json({ received: 'stored' }) }
    return original(url, init)
  }))
  at({ page: 'execution', id: 't1' }); await mount()
  expect(document.activeElement).not.toBe(field<HTMLTextAreaElement>(zh.workbenchReplyInstruction))
  await type(field<HTMLTextAreaElement>(zh.workbenchReplyInstruction), '补充一条背景\n继续沿原事项推进')
  await click(zh.workbenchSendUpdate)
  expect(updates).toEqual([expect.objectContaining({ ticketId: 't1', instruction: '补充一条背景\n继续沿原事项推进' })])
  expect(updates[0]).not.toHaveProperty('attentionId')
})

it('schedules independent follow-ups on the Ticket and cancels only the selected one', async () => {
  at({ page: 'execution', id: 't1' }); await mount()
  await click(zh.ticketScheduleFollowup)
  await type(field<HTMLInputElement>(zh.ticketFollowupTime), '2099-01-01T09:00')
  await type(field<HTMLTextAreaElement>(zh.ticketFollowupReason), '核对第一次交付')
  await click(zh.ticketSaveFollowup)
  await type(field<HTMLInputElement>(zh.ticketFollowupTime), '2099-01-02T09:00')
  await type(field<HTMLTextAreaElement>(zh.ticketFollowupReason), '核对后续反馈')
  await click(zh.ticketSaveFollowup)
  const checks = server.ticketDetails.t1!.followups!
  expect(checks).toHaveLength(2)
  expect(checks[0]!.id).not.toBe(checks[1]!.id)
  await click(find(zh.homeCancelFollowup))
  await click(zh.confirm)
  expect(server.ticketDetails.t1!.followups?.map(item => item.id)).toEqual([checks[1]!.id])
  expect(server.requests.filter(item => item.method === 'DELETE').at(-1)?.path).toBe(`tickets/t1/followup?request_id=${checks[0]!.id}`)
})

it('reuses a follow-up request after an uncertain connection failure', async () => {
  const original = globalThis.fetch
  const attempts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/tickets/t1/followup') && init?.method === 'POST') {
      attempts.push(String(init.body))
      if (attempts.length === 1) throw new Error('Connection lost')
    }
    return original(url, init)
  }))
  at({ page: 'execution', id: 't1' }); await mount()
  await click(zh.ticketScheduleFollowup)
  await type(field<HTMLInputElement>(zh.ticketFollowupTime), '2099-01-01T09:00')
  await type(field<HTMLTextAreaElement>(zh.ticketFollowupReason), '核对交付')
  await click(zh.ticketSaveFollowup)
  expect(field<HTMLTextAreaElement>(zh.ticketFollowupReason).value).toBe('核对交付')
  await click(zh.ticketSaveFollowup)
  expect(attempts).toHaveLength(2)
  expect(attempts[0]).toBe(attempts[1])
  expect(server.ticketDetails.t1!.followups).toHaveLength(1)
})

it('previews an authenticated local deliverable on the Ticket page', async () => {
  server.ticketDetails.t1!.deliverables = [{ title: '交付报告', url: '/api/superagent-workbench/artifact?ticketId=t1&path=report.md&sha256=fixed' }]
  at({ page: 'execution', id: 't1' }); await mount()
  await click(zh.ticketPreview)
  expect(document.querySelector('iframe')?.title).toBe('交付报告')
  expect(document.querySelector('iframe')?.getAttribute('sandbox')).toBe('')
})

it('reuses the same answer after an uncertain transport result', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'answer', attention: { id: 'q1', question: '需要确认按钮颜色' },
    mandate: { ...t1.mandate, actor: { source: 'workbench', id: 'owner' } },
    channels: [{ source: 'workbench', url: '#superagent', sessionId: 'master', label: { zh: 'DSH 工作台', en: 'DSH workbench' } }] }
  const base = globalThis.fetch
  const updates: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('/api/superagent-workbench/discussion')) return Response.json({ throughSeq: 7 })
    if (String(url) === '/api/superagent-workbench/answer') {
      updates.push(String(init?.body))
      if (updates.length === 1) throw new Error('Connection lost')
      return Response.json({ saved: true })
    }
    return base(url, init)
  }))
  at({ page: 'execution', id: 't1' }); await mount()
  await type(field<HTMLTextAreaElement>(zh.workbenchReplyInstruction), '用蓝色')
  await click(zh.workbenchSendUpdate)
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Connection lost')
  await click(zh.workbenchSendUpdate)
  expect(updates).toHaveLength(2)
  expect(updates[0]).toBe(updates[1])
  expect(text()).toContain(zh.ticketAnswerSent)
})

it('preserves a draft when the worker replaces the pending question and requires explicit retargeting', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'answer', attention: { id: 'q1', question: '需要确认按钮颜色' },
    mandate: { ...t1.mandate, actor: { source: 'workbench', id: 'owner' } },
    channels: [{ source: 'workbench', url: '#superagent', sessionId: 'master', label: { zh: 'DSH 工作台', en: 'DSH workbench' } }] }
  at({ page: 'execution', id: 't1' }); await mount()
  await type(field<HTMLTextAreaElement>(zh.workbenchReplyInstruction), '用蓝色')
  server.ticketDetails.t1 = { ...server.ticketDetails.t1, attention: { id: 'q2', question: '改用红色还是蓝色？' } }
  // A management save reloads the Ticket, as the poll would when the worker replaces its question.
  await click(zh.taskManagement)
  await click(zh.managementSave)
  expect(text()).toContain('改用红色还是蓝色？')
  expect(field<HTMLTextAreaElement>(zh.workbenchReplyInstruction).value).toBe('用蓝色')
  expect(text()).toContain(zh.ticketAnswerChanged)
  await click(zh.ticketAnswerUseCurrent)
  expect(text()).not.toContain(zh.ticketAnswerChanged)
})

it('offers the same owner answer command on source Tickets and keeps their source link', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'answer', attention: { id: 'q1', question: '需要确认按钮颜色' } }
  at({ page: 'execution', id: 't1' }); await mount()
  expect(all('textarea')).toHaveLength(1)
  expect(find('去飞书回答', 'a').getAttribute('href')).toBe('https://applink.feishu.cn/client/chat/open?openChatId=oc_1')
})

it('offers a Ticket awaiting review its review place and Session in the page head', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'review', threads: [threadSummary(),
    { ...threadSummary({ key: 'github:42', source: 'github', title: '#42 Fix login' }), url: 'https://github.com/acme/widgets/pull/42' }] }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh['stage.review'])
  expect(all('.dt-page-head a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['打开 GitHub 原文',
    'https://github.com/acme/widgets/pull/42']])
})

it('keeps what a person types in the Execution settings, converting it once on save', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const blocked = () => field<HTMLInputElement>(zh.blockedCommands), root = () => field<HTMLInputElement>(zh.executionDirectory),
    workers = () => field<HTMLInputElement>(zh.maxWorkers)
  // A separator typed before the next command, a space inside a path and a cleared number stay as typed.
  await type(blocked(), 'gh-personal ')
  expect(blocked().value).toBe('gh-personal ')
  await type(blocked(), 'gh-personal, gh-other')
  await type(root(), '/srv/my work ')
  expect(root().value).toBe('/srv/my work ')
  await type(workers(), '')
  expect(workers().value).toBe('')
  await type(workers(), '2')
  await click(zh.save)
  expect(server.requests.find(request => request.path === 'settings/executor')?.body).toMatchObject({ value: { blockedCommands: ['gh-personal', 'gh-other'], directory: '/srv/my work ', maxWorkers: 2 } })
  expect(server.settings.executor).toMatchObject({ blockedCommands: ['gh-personal', 'gh-other'], directory: '/srv/my work', maxWorkers: 2 })
})

it('edits the outbound proxy and saves it with the other Execution settings', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const proxy = () => field<HTMLInputElement>(zh.outboundProxy)
  expect(proxy().value).toBe('')
  await type(proxy(), 'http://127.0.0.1:7897')
  await click(zh.save)
  expect(server.requests.find(request => request.path === 'settings/executor')?.body).toMatchObject({ value: { proxy: 'http://127.0.0.1:7897' } })
  expect(server.settings.executor.proxy).toBe('http://127.0.0.1:7897')
  // Empty is a saved direct connection that also clears an inherited proxy, not a missing value.
  await type(proxy(), '')
  await click(zh.save)
  expect(server.settings.executor.proxy).toBe('')
})

it('says why an Input was not delivered on its Ticket\'s page, in either language', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'delivery', deliveryError: 'feishu: message recalled' }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh['stage.delivery'])
  expect(document.querySelector('.dt-banner.dt-danger')?.textContent).toBe(`${zh.deliveryFailedPrefix}feishu: message recalled`)
  expect(text()).toContain(zh.inputRetryHint)
  expect(text()).not.toContain(zh.inputWaitingHint)
  expect(document.querySelector('.dt-status-line')?.textContent).toMatch(/9月\d+日/)
  await remount(en)
  expect(document.querySelector('.dt-status-line')?.textContent).toMatch(/Sep \d+/)
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(en['stage.delivery'])
  expect(document.querySelector('.dt-banner.dt-danger')?.textContent).toBe(`${en.deliveryFailedPrefix}feishu: message recalled`)
  expect(text()).toContain(en.inputRetryHint)
})

it('tells a Ticket or Thread that does not exist from a dsh-superagent that is not answering', async () => {
  at({ page: 'execution', id: 't9' })
  await mount()
  expect(text()).toContain(zh.ticketNotFound)
  // While dsh-superagent restarts, DSH's web server answers every route with an empty 404.
  at({ page: 'execution', id: 't1' })
  server.down = true
  await remount()
  expect(text()).not.toContain(zh.ticketNotFound)
  expect(text()).toContain(zh.hostNotRunning)
  at({ page: 'trigger', id: 'feishu:oc_1:om_root' })
  await remount()
  expect(text()).not.toContain(zh.threadNotFound)
  expect(text()).toContain(zh.hostNotRunning)
})

it('gives a Ticket a bot\'s message started its basis, marks a Thread it follows for context, and an Input it handed back', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, mandate: { ...t1.mandate, strength: 'inferred', basis: { via: 'bot', sender: '评审机器人',
    observation: { mode: 'auto' } } },
  basis: { facts: [{ name: 'sender', value: '评审机器人' }, { name: 'bot' }, { name: 'mode', value: 'auto' }], legacy: false },
  threads: [threadSummary(), { ...threadSummary({ key: 'github:7', title: '#7 相关 Issue' }), context: true }],
  inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:03:00Z', delivered: true, trigger: { id: 'e2',
    actor: { source: 'feishu', id: MEMBER, name: { zh: 'Alice', en: 'Alice' } }, human: true, preview: '顺便加一个页面',
    thread: 'feishu:oc_1:om_root', handback: { reason: 'Asks for a new page', at: '2026-09-22T00:05:00Z' } } }] }
  at({ page: 'execution', id: 't1' })
  await mount()
  const facts = () => all('.dt-kv > div').map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent])
  expect(facts()).toEqual(expect.arrayContaining([[zh['basis.sender'], '评审机器人'], [zh['basis.bot'], zh.yes], [zh['basis.mode'], zh['mode.auto']]]))
  expect(all('.dt-list .dt-ticket').map(row => row.querySelector('.dt-tag')?.textContent)).toEqual([undefined, zh.contextOnly])
  await click(zh.deliveredInputs.replace('{count}', '1'))
  expect(text()).toContain('已交回评估：Asks for a new page')
  await remount(en)
  expect(facts()).toEqual(expect.arrayContaining([[en['basis.bot'], en.yes]]))
  expect(all('.dt-list .dt-ticket').map(row => row.querySelector('.dt-tag')?.textContent)).toEqual([undefined, en.contextOnly])
  await click(en.deliveredInputs.replace('{count}', '1'))
  expect(text()).toContain('Handed back for an Eval: Asks for a new page')
})

it('words an ended Ticket by its outcome, on its row and its page, with a person\'s reason after it', async () => {
  const fields = { id: 't3', title: '已合并的工单', state: 'ended' as const, actions: { retry: false, stop: false },
    ended: { at: '2026-09-21T00:00:00Z', by: 'executor' as const, outcome: 'merged' as const } }
  server.tickets.ended = [ticketSummary(fields, { stage: 'ended' }), ...server.tickets.ended]
  server.ticketDetails.t3 = { ...server.ticketDetails.t1!, ...fields, stage: 'ended' }
  await mount()
  await click(zh['tab.execution'])
  await click(zh['ticket.ended'])
  expect(all('.dt-ticket-stage').map(stage => stage.textContent)).toEqual([zh['outcome.merged'], zh['outcome.stopped']])
  await click('已合并的工单')
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh['outcome.merged'])
  expect(text()).toContain(zh['outcome.merged'])
  expect(text()).not.toContain('执行器结束')
  server.ticketDetails.t3 = { ...server.ticketDetails.t3, ended: { at: '2026-09-21T00:00:00Z', by: 'human', outcome: 'stopped',
    reason: '不需要了' } }
  await remount(en)
  expect(all('.dt-hint').map(hint => hint.textContent).find(line => line?.includes(en['outcome.stopped']))).toMatch(/Stopped by a person: 不需要了$/)
})

it('sends one stop for a double click on Confirm', async () => {
  at({ page: 'execution', id: 't1' })
  await mount()
  await click(zh.stop)
  const confirm = find(zh.confirm)
  await act(async () => { confirm.click(); confirm.click() })
  expect(server.requests.filter(request => request.path === 'tickets/t1/stop')).toHaveLength(1)
})
