// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { OwnerDesk } from '../src/client/owner-desk.tsx'
import { zh } from '../src/client/locales.ts'
import { translator, click, type, settle } from './fixtures/panel.tsx'
import { server, ticketSummary, usePanelServer } from './fixtures/panel-server.ts'

let root: Root
usePanelServer(() => { act(() => root?.unmount()); document.body.innerHTML = ''; localStorage.clear(); openTicket.mockClear() })
const t = translator(zh)
const openTicket = vi.fn()
async function mount(sessionId = 'master') {
  const container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  const send = vi.fn(async (_text: string) => {})
  await act(async () => { root.render(<OwnerDesk sessionId={sessionId} t={t} send={send} openTicket={openTicket} />) })
  await settle()
  return send
}
async function remount() {
  await act(async () => { root.unmount() })
  document.body.innerHTML = ''
  await mount()
}

it('shows global work only on the main conversation and opens no task merely by viewing it', async () => {
  const send = await mount('worker-one')
  expect(document.querySelector('.dt-owner-desk')).toBeNull()
  expect(send).not.toHaveBeenCalled()
})

it('starts collapsed and remembers the owner opening it', async () => {
  await mount()
  expect(document.querySelector('.dt-owner-body')).toBeNull()
  const toggle = document.querySelector<HTMLButtonElement>('.dt-owner-toggle')!
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  await click(toggle)
  expect(document.querySelector('.dt-owner-body')).not.toBeNull()
  expect(localStorage.getItem('dsh-superagent/owner-desk-open')).toBe('true')
  await remount()
  expect(document.querySelector('.dt-owner-body')).not.toBeNull()
})

it('collapses the followup agenda from its own handle without opening a ticket', async () => {
  server.ticketDetails.t1!.followups = [{ id: 'f1', at: '2099-01-01T00:00:00Z', reason: '核对签收', createdAt: '2026-11-08T00:00:00Z' }]
  await mount()
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-toggle')!)
  const agenda = document.querySelector<HTMLButtonElement>('.dt-followup-toggle')!
  expect(agenda.getAttribute('aria-expanded')).toBe('false')
  expect(document.querySelectorAll('.dt-followup-agenda li')).toHaveLength(0)
  await click(agenda)
  expect(agenda.getAttribute('aria-expanded')).toBe('true')
  expect(document.querySelectorAll('.dt-followup-agenda li')).toHaveLength(1)
  await click(agenda)
  expect(document.querySelectorAll('.dt-followup-agenda li')).toHaveLength(0)
  expect(openTicket).not.toHaveBeenCalled()
})

it('keeps the exact task and decision on a native owner reply and preserves failed input', async () => {
  const original = globalThis.fetch
  const submit = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ saved: true })
  const bodies: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/answer')) { bodies.push(JSON.parse(String(init?.body))); return Response.json(await submit()) }
    return original(url, init)
  }))
  const send = await mount()
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-tabs button')!)
  await click(zh.workbenchAnswer)
  const input = document.querySelector('textarea')!
  expect(input.getAttribute('aria-label')).toBe(zh.workbenchReplyInstruction)
  expect(document.querySelector<HTMLButtonElement>('.dt-owner-response button[type="submit"]')?.disabled).toBe(true)
  await type(input, '使用我们刚才确认的方案')
  await click(zh.workbenchSendUpdate)
  expect(input.value).toBe('使用我们刚才确认的方案')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('offline')
  await click(zh.workbenchSendUpdate)
  expect(bodies).toEqual([expect.objectContaining({ ticketId: 't1', attentionId: expect.any(String), instruction: '使用我们刚才确认的方案' }),
    expect.objectContaining({ ticketId: 't1', attentionId: expect.any(String), instruction: '使用我们刚才确认的方案' })])
  expect(send).not.toHaveBeenCalled()
  expect(document.querySelector('textarea')).toBeNull()
  expect(document.querySelector('[role="status"]')?.textContent).toContain(zh.ticketAnswerSent)
})

it.each([true, false])('keeps the owner reply target while its request is pending (success=%s)', async success => {
  const original = globalThis.fetch
  let finish!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { finish = resolve })
  const bodies: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/answer')) { bodies.push(JSON.parse(String(init?.body))); return pending }
    return original(url, init)
  }))
  server.person.push(ticketSummary({ id: 't2', title: '另一件事', attention: { id: 'q2', question: '另一问题' } },
    { stage: 'person', action: 'answer' }))
  await mount()
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-tabs button')!)
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.dt-owner-actions button')]
    .filter(button => button.textContent === zh.workbenchAnswer)
  await click(buttons()[0]!)
  await type(document.querySelector('textarea')!, '保留第一件事的答复')
  await click(zh.workbenchSendUpdate)
  await click(buttons()[1]!)
  expect(document.querySelector('.dt-owner-response')?.textContent).toContain('修复回归')
  expect(document.querySelector('textarea')?.value).toBe('保留第一件事的答复')
  expect(buttons().every(button => button.disabled)).toBe(true)
  await act(async () => { finish(success ? Response.json({ saved: true }) : Response.json({ error: 'offline' }, { status: 500 })) })
  await settle()
  expect(bodies).toEqual([expect.objectContaining({ ticketId: 't1', attentionId: 'q1' })])
  if (success) expect(document.querySelector('.dt-owner-response')).toBeNull()
  else {
    expect(document.querySelector('textarea')?.value).toBe('保留第一件事的答复')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('offline')
  }
  expect(buttons().every(button => !button.disabled)).toBe(true)
  await click(buttons()[1]!)
  expect(document.querySelector('.dt-owner-response')?.textContent).toContain('另一件事')
})

it('keeps an edited reply when its editor is reopened and restores each Ticket’s own draft', async () => {
  server.person.push(ticketSummary({ id: 't2', title: '另一件事', attention: { id: 'q2', question: '另一个问题' } },
    { stage: 'person', action: 'answer' }))
  await mount()
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-toggle')!)
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-tabs button')!)
  const entries = () => [...document.querySelectorAll<HTMLButtonElement>('.dt-owner-actions button')]
    .filter(button => button.textContent === zh.workbenchAnswer)
  const editor = () => document.querySelector<HTMLTextAreaElement>('.dt-owner-response textarea')!
  await click(entries()[0]!)
  await type(editor(), '工单 A 的草稿')
  await click(entries()[0]!)
  expect(document.querySelector('.dt-owner-response')?.textContent).toContain('修复回归')
  expect(editor().value).toBe('工单 A 的草稿')
  await click(entries()[1]!)
  expect(document.querySelector('.dt-owner-response')?.textContent).toContain('另一件事')
  expect(editor().value).toBe('')
  await type(editor(), '工单 B 的草稿')
  await click(entries()[0]!)
  expect(editor().value).toBe('工单 A 的草稿')
  // Discarding B's dialog keeps its text; confirming removes only B's draft.
  await click(entries()[1]!)
  await click(zh.homeDiscardDraft)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(zh.homeDiscardDraftConfirm)
  await click(zh.cancel)
  expect(editor().value).toBe('工单 B 的草稿')
  await click(zh.homeDiscardDraft)
  await click(zh.confirm)
  expect(document.querySelector('.dt-owner-response')).toBeNull()
  await click(entries()[0]!)
  expect(editor().value).toBe('工单 A 的草稿')
  await click(entries()[1]!)
  expect(editor().value).toBe('')
})

it('keeps a failed reply for retry when its own editor is reopened', async () => {
  const original = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => url.endsWith('/answer')
    ? Response.json({ error: 'offline' }, { status: 500 })
    : original(url, init)))
  await mount()
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-toggle')!)
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-tabs button')!)
  const entry = () => [...document.querySelectorAll<HTMLButtonElement>('.dt-owner-actions button')]
    .find(button => button.textContent === zh.workbenchAnswer)!
  const editor = () => document.querySelector<HTMLTextAreaElement>('.dt-owner-response textarea')!
  await click(entry())
  await type(editor(), '待重试的答复')
  await click(zh.workbenchSendUpdate)
  expect(editor().value).toBe('待重试的答复')
  await click(entry())
  expect(editor().value).toBe('待重试的答复')
})

it('keeps a reply on its own Question when a poll replaces it, and rebinds only on request', async () => {
  const original = globalThis.fetch
  const bodies: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/answer')) { bodies.push(JSON.parse(String(init?.body))); return Response.json({ saved: true }) }
    return original(url, init)
  }))
  await mount()
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-toggle')!)
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-tabs button')!)
  const entries = () => [...document.querySelectorAll<HTMLButtonElement>('.dt-owner-actions button')]
    .filter(button => button.textContent === zh.workbenchAnswer)
  const editor = () => document.querySelector<HTMLTextAreaElement>('.dt-owner-response textarea')!
  await click(entries()[0]!)
  await type(editor(), '针对原问题的答复')
  server.person[0]!.attention = { id: 'q2', question: '需要确认新的按钮颜色' }
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) }); await settle()
  expect(document.querySelector('.dt-owner-response')?.textContent).toContain(zh.homeDraftAttentionChanged)
  expect(document.querySelector('.dt-owner-response')?.textContent).toContain('需要确认按钮颜色')
  expect(editor().value).toBe('针对原问题的答复')
  // The refreshed Question's own entry still leaves the draft on the earlier Question until the owner moves it.
  await click(entries()[0]!)
  expect(document.querySelector('.dt-owner-response')?.textContent).toContain(zh.homeDraftAttentionChanged)
  expect(editor().value).toBe('针对原问题的答复')
  await click(zh.homeDraftUseNewQuestion)
  expect(document.querySelector('.dt-owner-response')?.textContent).toContain('需要确认新的按钮颜色')
  expect(editor().value).toBe('针对原问题的答复')
  await click(zh.workbenchSendUpdate)
  expect(bodies).toEqual([expect.objectContaining({ ticketId: 't1', attentionId: 'q2', instruction: '针对原问题的答复' })])
})

it('cannot move a reply to a replacement Question while its answer is in flight', async () => {
  const original = globalThis.fetch
  let finish!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { finish = resolve })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/answer')) return pending
    return original(url, init)
  }))
  await mount()
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-toggle')!)
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-tabs button')!)
  const entry = () => [...document.querySelectorAll<HTMLButtonElement>('.dt-owner-actions button')]
    .find(button => button.textContent === zh.workbenchAnswer)!
  const editor = () => document.querySelector<HTMLTextAreaElement>('.dt-owner-response textarea')!
  await click(entry())
  await type(editor(), '针对原问题的答复')
  const submit = document.querySelector<HTMLButtonElement>('.dt-owner-response button[type="submit"]')!
  await act(async () => { submit.click() })
  server.person[0]!.attention = { id: 'q2', question: '需要确认新的按钮颜色' }
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) }); await settle()
  const adopt = [...document.querySelectorAll<HTMLButtonElement>('.dt-owner-response button')]
    .find(button => button.textContent === zh.homeDraftUseNewQuestion)!
  // The pending answer still owns the editor, so the replacement cannot take its text meanwhile.
  expect(adopt.disabled).toBe(true)
  expect(editor().value).toBe('针对原问题的答复')
  await act(async () => { finish(Response.json({ saved: true })) })
  await settle()
  expect(document.querySelector('.dt-owner-response')).toBeNull()
  // Reopening the new Question starts without the earlier draft.
  await click(entry())
  expect(document.querySelector('.dt-owner-response')?.textContent).toContain('需要确认新的按钮颜色')
  expect(editor().value).toBe('')
})

it('answers the current Question in one line on the card itself, without opening the editor', async () => {
  const original = globalThis.fetch
  const bodies: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/answer')) { bodies.push(JSON.parse(String(init?.body))); return Response.json({ saved: true }) }
    return original(url, init)
  }))
  await mount()
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-tabs button')!)
  const field = document.querySelector<HTMLInputElement>(`.dt-owner-task input[aria-label="${zh.quickReplyTicket}"]`)!
  expect(document.querySelector('textarea')).toBeNull()
  await type(field, '用蓝色')
  await click(zh.quickReplySend)
  expect(bodies).toEqual([expect.objectContaining({ ticketId: 't1', attentionId: 'q1', instruction: '用蓝色' })])
  expect(document.querySelector('textarea')).toBeNull()
  expect(document.querySelector('[role="status"]')?.textContent).toContain(zh.ticketAnswerSent)
})

it('answers the Question the draft was written for when a poll replaces it', async () => {
  const original = globalThis.fetch
  const bodies: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/answer')) { bodies.push(JSON.parse(String(init?.body))); return Response.json({ saved: true }) }
    return original(url, init)
  }))
  await mount()
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-tabs button')!)
  await type(document.querySelector<HTMLInputElement>('.dt-owner-task input')!, '用蓝色')
  server.person[0]!.attention = { id: 'q2', question: '需要确认新的按钮颜色' }
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  await settle()
  expect(document.querySelector('.dt-owner-question')?.textContent).toContain('新的按钮颜色')
  await click(zh.quickReplySend)
  expect(bodies).toEqual([expect.objectContaining({ ticketId: 't1', attentionId: 'q1', instruction: '用蓝色' })])
})

it('lets a cleared line bind to the Question now shown', async () => {
  const original = globalThis.fetch
  const bodies: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/answer')) { bodies.push(JSON.parse(String(init?.body))); return Response.json({ saved: true }) }
    return original(url, init)
  }))
  await mount()
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-tabs button')!)
  await type(document.querySelector<HTMLInputElement>('.dt-owner-task input')!, '用蓝色')
  await type(document.querySelector<HTMLInputElement>('.dt-owner-task input')!, '')
  server.person[0]!.attention = { id: 'q2', question: '需要确认新的按钮颜色' }
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  await settle()
  await type(document.querySelector<HTMLInputElement>('.dt-owner-task input')!, '用绿色')
  await click(zh.quickReplySend)
  expect(bodies).toEqual([expect.objectContaining({ attentionId: 'q2', instruction: '用绿色' })])
})

it('starts a later Question on the same Ticket from its own identity', async () => {
  const original = globalThis.fetch
  const bodies: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/answer')) { bodies.push(JSON.parse(String(init?.body))); return Response.json({ saved: true }) }
    return original(url, init)
  }))
  await mount()
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-tabs button')!)
  await type(document.querySelector<HTMLInputElement>('.dt-owner-task input')!, '用蓝色')
  await click(zh.quickReplySend)
  expect(document.querySelector<HTMLInputElement>('.dt-owner-task input')?.value).toBe('')
  server.person[0]!.attention = { id: 'q2', question: '需要确认新的按钮颜色' }
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  await settle()
  await type(document.querySelector<HTMLInputElement>('.dt-owner-task input')!, '用绿色')
  await click(zh.quickReplySend)
  expect(bodies).toEqual([expect.objectContaining({ attentionId: 'q1', instruction: '用蓝色' }),
    expect.objectContaining({ attentionId: 'q2', instruction: '用绿色' })])
})

it('keeps a failed one-line answer in place for a retry', async () => {
  const original = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/answer')) return Response.json({ error: 'offline' }, { status: 500 })
    return original(url, init)
  }))
  await mount()
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-tabs button')!)
  const field = document.querySelector<HTMLInputElement>('.dt-owner-task input')!
  await type(field, '用蓝色')
  await click(zh.quickReplySend)
  expect(document.querySelector<HTMLInputElement>('.dt-owner-task input')?.value).toBe('用蓝色')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('offline')
})

it('shows a deferred Question in its own group with its return time, without the needs-you emphasis', async () => {
  server.person = [ticketSummary({ id: 'now', title: '现在处理', attention: { id: 'q1', question: '现在要处理吗？' } },
    { stage: 'person', action: 'answer' })]
  server.personDeferred = [{ ...ticketSummary({ id: 'later', title: '稍后处理', attention: { id: 'q2', question: '稍后要处理吗？' } },
    { stage: 'person', action: 'answer' }), until: '2099-01-01T01:00:00Z' }]
  await mount()
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-toggle')!)
  const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('.dt-owner-tabs button')]
  const deferredTab = tabs().find(tab => tab.textContent?.includes(zh.ownerDeskDeferred))!
  expect(deferredTab.textContent).toContain('1')
  expect(deferredTab.hasAttribute('data-needs-attention')).toBe(false)
  expect(tabs().find(tab => tab.textContent?.includes(zh.ownerDeskNeedsYou))!.hasAttribute('data-needs-attention')).toBe(true)
  await click(deferredTab)
  const body = document.querySelector('.dt-owner-content')?.textContent ?? ''
  expect(body).toContain('稍后要处理吗？')
  expect(body).toContain(zh.queueDeferredUntil.replace('{at}', ''))
  // The early answer stays available; a deferral changes the reminder, not the person's ability to decide.
  expect(document.querySelector('.dt-owner-task input')).not.toBeNull()
})

it('previews a published artifact beside the conversation and lets the owner revise the same delivered task', async () => {
  server.work = { working: [], workingTotal: 0, waiting: [], waitingTotal: 0,
    delivered: [ticketSummary({ id: 'report', title: '业务报告', summary: '最新报告', deliverables: [
      { title: '报告原文', url: '/api/superagent-workbench/artifact?ticketId=report&path=report.md&sha256=verified' },
    ] }, { stage: 'ended' })], deliveredTotal: 1 }
  const send = await mount()
  await click([...document.querySelectorAll<HTMLButtonElement>('.dt-owner-tabs button')].at(-1)!)
  await click('报告原文')
  expect(document.querySelector('iframe')?.getAttribute('sandbox')).toBe('')
  await click(zh.ownerDeskRevise)
  await type(document.querySelector('textarea')!, '请增加具体下一步')
  await click(zh.workbenchSendUpdate)
  expect(send.mock.calls[0]?.[0]).toContain('工单 report')
})

it('closes a failed Ticket in the needs-you panel with an optional reason and clears it', async () => {
  const failed = ticketSummary({ id: 'failed', title: '截图工具', actions: { retry: true, stop: true }, summary: 'LlmError: no adapter' },
    { stage: 'person', action: 'failed' })
  server.person = [failed]
  await mount()
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-tabs button')!)
  expect(document.querySelector('.dt-owner-task')?.textContent).toContain(zh.closeTicket)
  await click(zh.closeTicket)
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog.textContent).toContain('截图工具')
  expect(dialog.textContent).toContain(zh.closeTicketDescription)
  await type(dialog.querySelector('textarea')!, '已过期，不再需要')
  await click(zh.closeTicketConfirm)
  expect(server.requests).toContainEqual({ path: 'tickets/failed/stop', method: 'POST', body: { reason: '已过期，不再需要' } })
  expect(document.body.textContent).toContain(zh.closeTicketDone.replace('{title}', '截图工具'))
  expect(document.querySelector('.dt-owner-content')?.textContent ?? '').not.toContain('截图工具')
})
