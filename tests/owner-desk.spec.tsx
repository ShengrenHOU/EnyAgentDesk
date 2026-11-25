// @vitest-environment jsdom
import { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { TurnQuickReply, WorkerDiscussionSave } from '../src/client/quick-reply.tsx'
import { OwnerDesk } from '../src/client/owner-desk.tsx'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { zh } from '../src/client/locales.ts'
import { translator, click, type, settle } from './fixtures/panel.tsx'
import { server, ticketSummary, usePanelServer } from './fixtures/panel-server.ts'

let root: Root
usePanelServer(() => { act(() => root?.unmount()); document.body.innerHTML = ''; localStorage.clear(); openTicket.mockClear(); openMain.mockClear(); nativeInput = { draft: '', attachmentIds: [], phase: 'plain' } })
const t = translator(zh)
const openTicket = vi.fn()
const openMain = vi.fn(async (_id: string, _signal: AbortSignal) => {})
let nativeInput: Pick<InputState, 'draft' | 'attachmentIds' | 'phase'> = { draft: '', attachmentIds: [], phase: 'plain' }
const inputListeners = new Set<() => void>()
const useNativeInput = <T,>(selector: (input: typeof nativeInput) => T): T => {
  const input = useSyncExternalStore(listener => { inputListeners.add(listener); return () => { inputListeners.delete(listener) } }, () => nativeInput)
  return selector(input)
}
async function mount(sessionId = 'master') {
  const container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  const send = vi.fn(async (_text: string) => {})
  await act(async () => { root.render(<OwnerDesk sessionId={sessionId} t={t} send={send} openTicket={openTicket}
    useInput={useNativeInput} openMain={openMain} />) })
  await settle()
  return send
}
async function remount() {
  await act(async () => { root.unmount() })
  document.body.innerHTML = ''
  await mount()
}

async function refreshMain() {
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await settle() })
}

it('follows a moved Main only when the native draft is empty and the view was current', async () => {
  await mount()
  server.masterId = 'orchestrator-next'
  await refreshMain()
  await vi.waitFor(() => expect(openMain).toHaveBeenCalledOnce())
  expect(openMain.mock.calls[0]![0]).toBe('orchestrator-next')
})

it('keeps the native draft when Main moves and follows after that draft is sent', async () => {
  nativeInput = { draft: 'Keep this unfinished text', attachmentIds: [], phase: 'plain' }
  await mount()
  server.masterId = 'orchestrator-next'; await refreshMain()
  expect(openMain).not.toHaveBeenCalled()
  expect(nativeInput.draft).toBe('Keep this unfinished text')
  await act(async () => { nativeInput = { draft: '', attachmentIds: [], phase: 'plain' }; inputListeners.forEach(listener => listener()) })
  await vi.waitFor(() => expect(openMain).toHaveBeenCalledOnce())
})

it('leaves an explicit visit to historical Main in place', async () => {
  server.masterId = 'orchestrator-current'
  await mount('orchestrator-previous')
  expect(openMain).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('继续主对话')
})

it('keeps an inline answer visible and blocks automatic continuation until its draft is cleared', async () => {
  await mount()
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-tabs button')!)
  const editor = () => document.querySelector<HTMLInputElement>(`.dt-owner-task input[aria-label="${zh.quickReplyTicket}"]`)!
  await type(editor(), 'Keep this answer for its original Question')
  server.masterId = 'orchestrator-next'; await refreshMain()
  expect(openMain).not.toHaveBeenCalled()
  expect(editor().value).toBe('Keep this answer for its original Question')
  await type(editor(), '')
  await vi.waitFor(() => expect(openMain).toHaveBeenCalledOnce())
})

it('loads the dock from its bounded projection instead of the full overview', async () => {
  await mount()
  expect(server.requests).toContainEqual({ path: 'owner-desk', method: 'GET' })
  expect(server.requests.filter(request => request.path === 'overview')).toEqual([])
})

it('shows global work only on the main conversation and opens no task merely by viewing it', async () => {
  const send = await mount('worker-one')
  expect(document.querySelector('.dt-owner-desk')).toBeNull()
  expect(send).not.toHaveBeenCalled()
})

it('opens the original worker Session directly from the Main card', async () => {
  const send = await mount()
  await click(document.querySelector<HTMLButtonElement>('.dt-owner-tabs button')!)
  await click(zh.openOriginalSession)
  expect(openMain).toHaveBeenCalledWith('worker-t1', expect.any(AbortSignal))
  expect(send).not.toHaveBeenCalled()
  expect(openTicket).not.toHaveBeenCalled()
})

it('prefills an editable conclusion and keeps the saved receipt if Main navigation fails', async () => {
  const post = vi.fn().mockRejectedValueOnce(new Error('offline'))
    .mockImplementation(() => Promise.resolve(Response.json({ sessionId: 'worker-t1', throughSeq: 36 })))
  const fetch = vi.fn((url: string, init: RequestInit) => init.method === 'GET'
    ? Promise.resolve(Response.json({ id: 't1' })) : post(url, init))
  vi.stubGlobal('fetch', fetch)
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const readReply = vi.fn(() => ' Original conclusion. ')
  const openCurrentMain = vi.fn().mockRejectedValueOnce(new Error('Main unavailable')).mockResolvedValue(undefined)
  await act(async () => { root.render(<WorkerDiscussionSave sessionId="worker-t1" throughSeq={36} t={t} readReply={readReply}
    openMain={openCurrentMain} />) })
  expect(readReply).not.toHaveBeenCalled()
  await click(zh.discussionConclusionSave)
  const draft = 'Reviewed the final figures.'
  const input = document.querySelector('textarea')!
  expect(input.value).toBe('Original conclusion.')
  await type(input, draft)
  await click(zh.save)
  expect(input.value).toBe(draft)
  await click(zh.save)
  expect(post.mock.calls.map(([url, init]) => [url, JSON.parse(init.body)])).toEqual(Array(2).fill(
    ['/api/superagent-workbench/worker-discussion', { sessionId: 'worker-t1', throughSeq: 36, summary: draft }]))
  expect(document.querySelector('[role="status"]')?.textContent).toBe(zh.discussionConclusionSaved)
  await click(zh.discussionReturnMain)
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Main unavailable')
  expect(document.querySelector('[role="status"]')?.textContent).toBe(zh.discussionConclusionSaved)
  await click(zh.discussionReturnMain)
  expect(openCurrentMain).toHaveBeenCalledTimes(2)
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('recovers the edited saved conclusion after remount without making a duplicate POST', async () => {
  const sessionId = 'worker-t1', throughSeq = 36
  const openCurrentMain = vi.fn(async () => {})
  const readReply = vi.fn(() => 'Original assistant reply')
  let saved: { sessionId: string; throughSeq: number; summary: string } | undefined
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === 'GET') return Response.json({ id: 't1', discussionConclusion: saved })
    saved = JSON.parse(String(init.body))
    return Response.json(saved)
  })
  vi.stubGlobal('fetch', fetch)
  const mountConclusion = async () => {
    const container = document.createElement('div'); document.body.append(container)
    root = createRoot(container)
    await act(async () => { root.render(<WorkerDiscussionSave sessionId={sessionId} throughSeq={throughSeq} t={t}
      readReply={readReply} openMain={openCurrentMain} />) })
  }
  await mountConclusion()
  await click(zh.discussionConclusionSave)
  await type(document.querySelector('textarea')!, 'Owner-edited conclusion')
  await click(zh.save)
  expect(saved?.summary).toBe('Owner-edited conclusion')
  await act(async () => { root.unmount() })
  await mountConclusion()
  expect(document.body.textContent).toContain(zh.discussionConclusionSaved)
  expect(Array.from(document.querySelectorAll('button'), button => button.textContent)).not.toContain(zh.discussionConclusionSave)
  expect(document.querySelector('textarea')).toBeNull()
  expect(readReply).toHaveBeenCalledOnce()
  await click(zh.discussionReturnMain)
  expect(openCurrentMain).toHaveBeenCalledOnce()
  expect(fetch.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
    ['/orchestrator/api/tickets/t1', 'GET'], ['/api/superagent-workbench/worker-discussion', 'POST'], ['/orchestrator/api/tickets/t1', 'GET'],
  ])
})

it('coalesces mounted turns and does not show a newer reply or a different Session as saved', async () => {
  const receipt = { sessionId: 'worker-t1', throughSeq: 36, summary: 'Owner-edited conclusion' }
  const fetch = vi.fn(async (url: string) => Response.json({ id: url.endsWith('/t1') ? 't1' : 't2', discussionConclusion: receipt }))
  vi.stubGlobal('fetch', fetch)
  const container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  const view = (sessionId: string, throughSeq: number) => <WorkerDiscussionSave sessionId={sessionId} throughSeq={throughSeq}
    t={t} readReply={() => 'Another reply'} openMain={vi.fn()} />
  await act(async () => { root.render(<>
    <div id="older">{view('worker-t1', 35)}</div><div id="match">{view('worker-t1', 36)}</div>
    <div id="new">{view('worker-t1', 37)}</div><div id="another">{view('worker-t2', 36)}</div>
  </>) })
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/orchestrator/api/tickets/t1', '/orchestrator/api/tickets/t2'])
  expect(document.querySelector('#older')?.textContent).toBe('')
  expect(document.querySelector('#match')?.textContent).toContain(zh.discussionConclusionSaved)
  for (const id of ['#new', '#another']) {
    const view = document.querySelector(id)
    expect(view?.querySelector('button')?.textContent).toBe(zh.discussionConclusionSave)
    expect(view?.textContent).not.toContain(zh.discussionConclusionSaved)
  }
})

it('keeps an unverifiable conclusion distinct from an unsaved reply and retries the read', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async () => Response.json({
    id: 't1', discussionConclusion: { sessionId: 'worker-t1', throughSeq: 36, summary: 'Owner-edited conclusion' },
  }))
  vi.stubGlobal('fetch', fetch)
  const container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => { root.render(<WorkerDiscussionSave sessionId="worker-t1" throughSeq={36} t={t}
    readReply={() => 'Original'} openMain={vi.fn()} />) })
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(zh.discussionConclusionReadFailed)
  expect(document.querySelector('button')?.textContent).toBe(zh.retry)
  await click(zh.retry)
  expect(document.body.textContent).toContain(zh.discussionConclusionSaved)
  expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true)
})

it('leaves a long reply available in history without pre-filling a truncated conclusion', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 't1' })))
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root.render(<WorkerDiscussionSave sessionId="worker-t1" throughSeq={36} t={t}
    readReply={() => 'a'.repeat(601)} openMain={vi.fn()} />) })
  await click(zh.discussionConclusionSave)
  expect(document.querySelector('textarea')?.value).toBe('')
  expect(document.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true)
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
  expect(document.querySelector('iframe')).toBeNull()
  expect(document.querySelector('.dt-artifact-md table')).not.toBeNull()
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


it('aborts automatic continuation when editing resumes while navigation waits', async () => {
  let release!: () => void
  openMain.mockImplementationOnce(async (_id, signal) => {
    await new Promise<void>(resolve => { release = resolve })
    if (!signal.aborted) throw new Error('Navigation must be cancelled')
  })
  await mount()
  server.masterId = 'orchestrator-next'; await refreshMain()
  expect(openMain).toHaveBeenCalledOnce()
  await act(async () => { nativeInput = { draft: 'New text while catalog waits', attachmentIds: [], phase: 'plain' }; inputListeners.forEach(listener => listener()) })
  expect(openMain.mock.calls[0]![1].aborted).toBe(true)
  await act(async () => { release() }); await settle()
  expect(document.querySelector('[role="alert"]')).toBeNull()
})

it('holds Main navigation while a turn-tail reply is edited or sending', async () => {
  const sessionId = 'master-turn-guard'; server.masterId = sessionId
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const send = vi.fn(async (_text: string) => {})
  await act(async () => root.render(<><OwnerDesk sessionId={sessionId} t={t} send={send} openTicket={openTicket}
    useInput={useNativeInput} openMain={openMain} /><TurnQuickReply sessionId={sessionId} turn={1} seq={22} quote="Pending reply" t={t} send={send} /></>))
  await settle()
  const editor = () => document.querySelector<HTMLInputElement>('.dt-turn-reply input')!
  await type(editor(), 'Keep the reply for this Turn')
  server.masterId = 'orchestrator-next'; await refreshMain()
  expect(openMain).not.toHaveBeenCalled()
  expect(editor().value).toBe('Keep the reply for this Turn')
  await type(editor(), '')
  await vi.waitFor(() => expect(openMain).toHaveBeenCalledOnce())
})

it('opens a Worker conversation without mounting global desk or reply subscriptions', async () => {
  await mount('worker-one')
  expect(server.requests).toEqual([])
  await act(async () => { root.render(<TurnQuickReply sessionId="worker-one" turn={0} seq={1} quote="Worker report" t={t} send={vi.fn()} />) })
  await settle()
  expect(server.requests).toEqual([])
  expect(document.querySelector('.dt-owner-desk')).toBeNull()
  expect(document.querySelector('.dt-turn-reply')).toBeNull()
})

it('reads global desk work only for a confirmed Main seat', async () => {
  await mount('ordinary-discussion')
  expect(server.requests.some(request => request.path === 'state')).toBe(true)
  expect(server.requests.some(request => request.path === 'owner-desk')).toBe(false)
})
