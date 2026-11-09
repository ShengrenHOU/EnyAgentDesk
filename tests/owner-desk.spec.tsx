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
