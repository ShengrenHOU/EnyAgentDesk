// @vitest-environment jsdom
/** Explicit native delegation and uncertain-submit recovery in the visible discussion action. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkbenchAction } from '../src/client/workbench.tsx'
import { zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals() })
const t = ((name: keyof typeof zh) => zh[name]) as T
const button = (text: string) => [...document.querySelectorAll('button')].find(item => item.textContent === text)!
const state = { sessionId: 'discussion', throughSeq: 4, messageCount: 2, partial: false, references: [], requests: [] }

it('shows waiting, queued and failed work distinctly and preserves the follow-up time', async () => {
  const tasks = [
    { id: 'waiting', title: 'Waiting work', ended: null, status: { stage: 'idle' }, followupAt: '2026-11-06T01:00:00Z' },
    { id: 'queued', title: 'Queued work', ended: null, status: { stage: 'working', action: 'queued' } },
    { id: 'failed', title: 'Blocked work', ended: null, status: { stage: 'person', action: 'failed' } },
  ]
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...state, requests: [{ triggerId: 'request', at: '', instruction: 'Continue', tickets: tasks }] })))
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(<WorkbenchAction sessionId="status-discussion" t={t} openTicket={() => {}} />) })
  await act(async () => { container.querySelector('button')!.click() })
  for (const label of [zh.workbenchStatusWaiting, zh.workbenchStatusQueued, zh.workbenchStatusFailed, zh.workbenchNextFollowup]) expect(document.body.textContent).toContain(label)
  expect(document.querySelector('time[datetime="2026-11-06T01:00:00Z"]')).not.toBeNull()
  expect(document.body.textContent).not.toContain(zh.workbenchStatusWorking)
})

it('does not delegate on opening, and reuses the exact request after an uncertain transport result', async () => {
  const submissions: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      submissions.push(String(options.body))
      if (submissions.length === 1) throw new Error('Connection lost')
      return Response.json({ triggerId: 'saved', received: 'duplicate' })
    }
    return Response.json(state)
  }))
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(<WorkbenchAction sessionId="discussion" t={t} openTicket={() => {}} />) })
  await act(async () => { container.querySelector('button')!.click() })
  expect(submissions).toHaveLength(0)
  await act(async () => { button(zh.workbenchDelegate).click() })
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Connection lost')
  await act(async () => { button(zh.workbenchDelegate).click() })
  expect(submissions).toHaveLength(2)
  expect(submissions[0]).toBe(submissions[1])
  expect(JSON.parse(submissions[0]!)).toMatchObject({ sessionId: 'discussion', throughSeq: 4 })
  expect(button(zh.workbenchDelegate).disabled).toBe(true)
})

it('opens the linked task without submitting another delegation', async () => {
  const fetch = vi.fn(async (_url: string, _options?: RequestInit) => Response.json({ ...state, requests: [{ triggerId: 'saved', instruction: 'Reading note',
    at: '2026-11-04T10:00:00Z', tickets: [{ id: 'ticket-1', title: 'Agreed report', deliverables: [{ title: 'Verified note', url: 'https://example.test/note' }] }] }] }))
  vi.stubGlobal('fetch', fetch)
  const openTicket = vi.fn(), container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(<WorkbenchAction sessionId="discussion" t={t} openTicket={openTicket} />) })
  await act(async () => { container.querySelector('button')!.click() })
  expect(document.querySelector('a[href="https://example.test/note"]')?.textContent).toBe('Verified note')
  await act(async () => { button('Agreed report').click() })
  expect(openTicket).toHaveBeenCalledWith('ticket-1')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(fetch.mock.calls.some(call => (call[1] as RequestInit | undefined)?.method === 'POST')).toBe(false)
})

it('answers the selected pending decision through the shared owner answer command', async () => {
  const submitted: { url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') { submitted.push({ url, body: JSON.parse(String(options.body)) }); return Response.json({ saved: true }) }
    return Response.json({ ...state, requests: [{ triggerId: 'origin', instruction: 'Report', tickets: [
      { id: 'ticket-1', title: 'Report', attention: { id: 'decision-1', question: 'Which scope?' }, ended: null },
    ] }] })
  }))
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(<WorkbenchAction sessionId="discussion" t={t} openTicket={() => {}} />) })
  await act(async () => { container.querySelector('button')!.click() })
  await act(async () => { button(zh.workbenchAnswer).click() })
  expect(button(zh.workbenchSendUpdate).disabled).toBe(true)
  const textarea = document.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Use the original scope.')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { button(zh.workbenchSendUpdate).click() })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatchObject({ url: '/api/superagent-workbench/answer', body: {
    ticketId: 'ticket-1', attentionId: 'decision-1', instruction: 'Use the original scope.',
  } })
})

it('shows each linked task status, its pending question and its deliverable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...state, requests: [{ triggerId: 'origin', instruction: '整理一份报告',
    at: '2026-11-04T10:00:00Z', tickets: [
      { id: 'working', title: '进行中的任务', updatedAt: '2026-11-04T10:05:00Z', summary: '正在读取资料', deliverables: [] },
      { id: 'attention', title: '待决定的任务', attention: { id: 'decision-1', question: '用哪个时间范围？' },
        deliverables: [{ title: '草稿', url: 'https://example.test/draft' }] },
    ] }] })))
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(<WorkbenchAction sessionId="discussion" t={t} openTicket={() => {}} />) })
  await act(async () => { container.querySelector('button')!.click() })
  expect(document.body.textContent).toContain(zh.workbenchStatusWorking)
  expect(document.body.textContent).toContain(zh.workbenchStatusAttention)
  expect(document.body.textContent).toContain('用哪个时间范围？')
  expect(document.querySelector('a[href="https://example.test/draft"]')?.textContent).toBe('草稿')
})

it('explains how to start when the discussion has no linked work', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(state)))
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(<WorkbenchAction sessionId="discussion" t={t} openTicket={() => {}} />) })
  await act(async () => { container.querySelector('button')!.click() })
  expect(document.body.textContent).toContain(zh.workbenchEmpty)
})

it('marks a stopped task and offers no further update action', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...state, requests: [{ triggerId: 'origin', instruction: '整理',
    at: '2026-11-04T10:00:00Z', tickets: [{ id: 'stopped', title: '已停止的任务', ended: 'stopped' }] }] })))
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(<WorkbenchAction sessionId="discussion" t={t} openTicket={() => {}} />) })
  await act(async () => { container.querySelector('button')!.click() })
  expect(document.body.textContent).toContain(zh.workbenchStatusStopped)
  expect([...document.querySelectorAll('button')].some(item => item.textContent === zh.workbenchUpdate)).toBe(false)
})

it('marks the Session row with the pending decision count', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes('/summary')
    ? Response.json({ sessionId: 'discussion-badge', active: 2, attention: 1 })
    : Response.json(state)))
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(<WorkbenchAction sessionId="discussion-badge" t={t} openTicket={() => {}} />) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  const badge = document.querySelector('.dt-workbench-badge')
  expect(badge?.textContent).toBe('1')
  expect(badge?.getAttribute('data-tone')).toBe('warning')
  expect(container.querySelector('button')?.getAttribute('aria-label')).toContain('待决定')
})

it('marks a Session row with in-progress work and no badge without linked work', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes('/summary')
    ? Response.json(url.includes('idle') ? { sessionId: 'discussion-idle', active: 0, attention: 0 }
      : { sessionId: 'discussion-active', active: 3, attention: 0 })
    : Response.json(state)))
  const active = document.createElement('div'); document.body.append(active); root = createRoot(active)
  await act(async () => { root!.render(<WorkbenchAction sessionId="discussion-active" t={t} openTicket={() => {}} />) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(document.querySelector('.dt-workbench-badge')?.textContent).toBe('3')
  act(() => root!.unmount()); root = undefined; document.body.innerHTML = ''
  const idle = document.createElement('div'); document.body.append(idle); root = createRoot(idle)
  await act(async () => { root!.render(<WorkbenchAction sessionId="discussion-idle" t={t} openTicket={() => {}} />) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(document.querySelector('.dt-workbench-badge')).toBeNull()
})
