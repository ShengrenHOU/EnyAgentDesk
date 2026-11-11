// @vitest-environment jsdom
// The overview.
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, find, tab, click, text } from './fixtures/panel.tsx'
import { server, droppedReply, threadSummary, ticketSummary } from './fixtures/panel-server.ts'

usePanel()
it('shows progressing, waiting and delivered work together with the existing decisions on the overview', async () => {
  server.work = {
    working: [ticketSummary({ title: 'High-priority research', priority: 'high', executor: 'dsh' })], workingTotal: 1,
    waiting: [ticketSummary({ title: 'Waiting for the partner', followup: { id: 'f', at: '2026-11-05T00:00:00Z',
      reason: 'Read the partner reply', createdAt: '2026-11-04T00:00:00Z' } }, { stage: 'idle' })], waitingTotal: 1,
    delivered: [ticketSummary({ title: 'Delivered note', state: 'ended', actions: { stop: false, retry: false },
      deliverables: [{ title: 'Open note', url: 'https://example.com/note' }] }, { stage: 'ended' })], deliveredTotal: 1,
  }
  await mount()
  expect(text()).toContain('需要确认按钮颜色')
  expect(text()).toContain('High-priority research')
  expect(text()).toContain('DSH / DeepSeek')
  expect(text()).toContain('Read the partner reply')
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual(expect.arrayContaining([
    `${zh.workInProgress}1${zh.details}`, `${zh.workWaiting}1${zh.details}`, `${zh.workDelivered}1${zh.details}`]))
  expect(document.querySelector<HTMLAnchorElement>('a[href="https://example.com/note"]')?.textContent).toContain('Open note')
})

it('shows the waiting reason and next condition on an idle row without requiring a human question or follow-up timer', async () => {
  const reason = 'Waiting for the partner reply. Next: compare it with the draft.'
  server.work = { working: [], workingTotal: 0, delivered: [], deliveredTotal: 0,
    waiting: [ticketSummary({ executor: 'dsh', note: { text: reason, error: false }, summary: reason }, { stage: 'idle' })],
    waitingTotal: 1 }
  server.tickets.open = server.work.waiting
  await mount()
  expect(all('.dt-ticket-note').some(note => note.textContent === reason)).toBe(true)
  await click(zh['tab.execution'])
  await click(zh.idleLabel)
  expect(all('.dt-ticket-note').map(note => note.textContent)).toEqual([reason])
})

it('leads the overview with the pending Tickets, then problems, the last day and the Executor, each linking to its stage', async () => {
  await mount()
  expect(tab(zh['tab.overview']).getAttribute('aria-selected')).toBe('true')
  expect(all('[role="tab"]').map(tab => tab.textContent)).toEqual(['概览', '来源', '触发', '评估', '执行', '设置'])
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual(['待处理工单2', '系统问题2', '过去 24 小时详情 ›', '执行器详情 ›'])
  expect(all('.dt-cards .dt-ticket-stage').map(item => item.textContent)).toEqual(['待回答', '待处理失败'])
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toEqual(['飞书 来源异常', '评估未完成：这个文案好奇怪'])
  // Actions sit below the title and Threads, apart from the stage, each with its icon.
  expect(all('.dt-ticket').every(row => row.querySelector('.dt-ticket-stage button, .dt-ticket-stage a') === null
    && [...row.querySelectorAll('.dt-ticket-actions button, .dt-ticket-actions a')].every(action => action.querySelector('svg')))).toBe(true)
  expect(text()).toContain('来源会在每次轮询时自动重试')
  expect(text()).toContain('需要确认按钮颜色')
  expect(all('.dt-stat').map(stat => stat.textContent)).toEqual(['到达12', '被过滤2', '已评估5', '接单或续做1', '执行中2 / 3', '排队0', '等待新触发1'])
  expect(all('.dt-chip').map(chip => chip.textContent)[0]).toBe('GitHub#42CI 失败1')
  expect(document.querySelector('.dt-chip-problem')?.textContent).toBe('CI 失败1')
  expect(document.querySelector<HTMLAnchorElement>('a.dt-chip-link')?.href).toBe('https://github.com/acme/widgets/pull/42')
  await click(all('.dt-more-link').at(-1)!)
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
})

it('re-evaluates or dismisses an unjudged Eval from the problem list', async () => {
  await mount()
  await click(zh.requeue)
  expect(server.requests.some(request => request.path === 'triggers/e3/requeue' && request.method === 'POST')).toBe(true)
  await click(zh.dismiss)
  expect(server.requests.some(request => request.path === 'decisions/u1/dismiss' && request.method === 'POST')).toBe(true)
  expect(server.requests.filter(request => request.path === 'overview').length).toBeGreaterThan(2)
})

it('opens the Thread of an unjudged Eval at its Trigger from the problem list', async () => {
  await mount()
  await click('评估未完成：这个文案好奇怪')
  expect(server.requests.some(request => request.path.startsWith('threads/feishu:oc_1:om_root'))).toBe(true)
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('message e3')
})

it('shows the running package build and warns when its source moved past it', async () => {
  await mount()
  const badge = () => document.querySelector('.dt-head .dt-tag')
  expect(badge()?.textContent).toContain('运行版本 0.5.19')
  expect(badge()?.getAttribute('title')).toContain('构建 abc123def456')
  server.runtime = { ...server.runtime, behind: { branch: 'main', head: 'fff999000111' } }
  await remount()
  expect(badge()?.textContent).toContain('落后于 main')
  expect(badge()?.getAttribute('title')).toContain('fff999000111')
})

it('follows the last day\'s counts to the status of each stage', async () => {
  await mount()
  // Arrived Triggers include filtered ones, which have no Thread, so no list has that count to link to.
  expect(all('.dt-stat button').map(button => button.textContent)).toEqual(['2', '1'])
  await click(all('.dt-stat button')[0]!)
  expect(tab(zh['tab.source']).getAttribute('aria-selected')).toBe('true')
  await click(zh.sourceFilteredTitle)
  expect(text()).toContain('looks wrong')
  expect(text()).toContain(zh['reason.source_disabled'])
})

it('offers each Ticket that needs a person its actions on the overview: answer in its Channel, retry or open a failed worker, and stop',
  async () => {
  await mount()
  expect(all('.dt-ticket-actions a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['去飞书回答',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1']])
  expect(all('.dt-ticket-note').map(note => note.textContent)).toContain('LlmError: no adapter registered for provider "provider-a"')
  await click(zh.retry)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t4/retry' && request.method === 'POST')).toBe(true)
  await click(all('.dt-ticket-actions button').find(button => button.textContent === '打开 Session')!)
  expect(server.opened).toEqual(['worker-t4'])
  await click(all('.dt-ticket-actions button').filter(button => button.textContent === '停止').at(-1)!)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t4/stop' && request.method === 'POST')).toBe(true)
  expect(text()).not.toContain('截图工具')
})

it('shows paused processing as a system problem with its resume action, and says so on the Policy records', async () => {
  server.settings = { ...server.settings, paused: true }
  await mount()
  expect(text()).toContain(zh.problemPaused)
  await click(zh['tab.eval'])
  expect(text()).toContain(zh.evalRecordsPaused)
  await click(zh.resumeWhere)
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
  await click(zh['tab.overview'])
  await click(find(zh.resumeProcessing, '.dt-att button'))
  await click(zh.confirm)
  expect(server.requests.find(request => request.path === 'executor/pause')).toMatchObject({ method: 'POST', body: { paused: false } })
})

it('offers the step that fixes a settings problem as a button on the overview', async () => {
  server.settings = { ...server.settings, policy: { ...server.settings.policy, sources: { feishu: { allowed: [], admission: {} },
    github: { allowed: [], admission: {} } } } }
  await mount()
  expect(text()).toContain(zh.problemNoAllowed)
  await click(zh.actionAddAllowed)
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.eval'])
})

it('counts the messages not sent in the last day, linking to the Source status, and shows nothing when there are none', async () => {
  await mount()
  expect(all('.dt-stat-label').map(label => label.textContent)).not.toContain(zh.flowDroppedLabel)
  server.dropped = [droppedReply('m2', 1, 'feishu', 'channelGone'), droppedReply('m1', 2, 'github', 'channelIgnored'), droppedReply('m0',
    30, 'feishu', 'channelGone')]
  await remount()
  const stat = all('.dt-stat').find(item => item.querySelector('.dt-stat-label')?.textContent === zh.flowDroppedLabel)!
  expect(stat.textContent).toBe(`${zh.flowDroppedLabel}2`)
  await click(stat.querySelector('button')!)
  expect(tab(zh['tab.source'])?.getAttribute('aria-selected')).toBe('true')
})

it('names a failing part of dsh-superagent itself by its label', async () => {
  server.health = { launch: { state: 'error', detail: 'spawn failed' }, relay: { state: 'ready', detail: 'Nothing waiting' } }
  await mount()
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toContain(zh.problemRuntime.replace('{name}', zh['health.launch']))
  expect(text()).toContain('spawn failed')
})

it('words a refused retry in the interface language by its code', async () => {
  await mount()
  // Simulate another user retrying the ticket after the overview loaded.
  server.person = server.person.map(ticket => ticket.id === 't4' ? { ...ticket, actions: { ...ticket.actions, retry: false } } : ticket)
  await click(find(zh.retry, '.dt-ticket-actions button'))
  await click(zh.confirm)
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh['userError.notRetryable'])
  expect(text()).not.toContain('Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed')
})

it('shows the overview in English', async () => {
  await mount(en)
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual([`${en.pendingTickets}2`, `${en.problems}2`,
    `${en.lastDay}${en.details}`, `${en['term.executor']}${en.details}`])
  expect(all('.dt-cards .dt-ticket-stage').map(item => item.textContent)).toEqual([en['stage.answer'], en['stage.failed']])
  expect(all('.dt-stat-label').map(label => label.textContent)).toEqual([en.flowReceivedLabel, en.flowFilteredLabel, en.flowJudgedLabel,
    en.flowAcceptedLabel, en.executingLabel, en.queuedLabel, en.idleLabel])
})

it('lists the unavailable Evals one by one, without the health entry that counts them as a failure of dsh-superagent', async () => {
  server.health.evals = { state: 'error', detail: '1 Eval(s) unavailable in the last hour without a later judgement' }
  await mount()
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toEqual(['飞书 来源异常', '评估未完成：这个文案好奇怪'])
  expect(text()).not.toContain(zh['health.evals'])
})

it('says when no Source is on, an Eval is past its deadline or a message keeps failing, each with the way to it', async () => {
  for (const kind of ['feishu', 'github']) server.settings.sources[kind] = { ...server.settings.sources[kind]!, enabled: false }
  server.threads = [threadSummary({ key: 'github:9', title: '#9 迟迟未决', stage: 'evaluating',
    evaluating: { id: 'v9', triggers: 1, strength: 'inferred', startedAt: '2026-08-31T23:58:00Z', deadline: '2026-09-01T00:00:00Z' } })]
  server.failing = [{ id: 'm1', channel: { source: 'github', thread: 'github:42', address: { number: '42' } },
    text: '已修复', attempts: 4,
    error: 'HTTP 502 from GitHub' }]
  await mount()
  const titles = () => all('.dt-cards .dt-att-what').map(item => item.textContent)
  // The Feishu Source is off, so its error is no problem any more.
  expect(titles()).toEqual([zh.problemNoSource, '评估超时未决定：#9 迟迟未决', '评估未完成：这个文案好奇怪', 'GitHub 回复发送失败（已重试 4 次）'])
  expect(text()).toContain('HTTP 502 from GitHub')
  await click(zh.actionOpenSources)
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.source'])
  await click(tab(zh['tab.overview']))
  await click('评估超时未决定：#9 迟迟未决')
  expect(server.requests.some(request => request.path.startsWith('threads/github:9'))).toBe(true)
})
