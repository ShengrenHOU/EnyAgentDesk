// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { OwnerDesk } from '../src/client/owner-desk.tsx'
import { zh } from '../src/client/locales.ts'
import { translator, click, type, settle } from './fixtures/panel.tsx'
import { server, ticketSummary, usePanelServer } from './fixtures/panel-server.ts'

let root: Root
usePanelServer(() => { act(() => root?.unmount()); document.body.innerHTML = '' })
const t = translator(zh)
async function mount(sessionId = 'master') {
  const container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  const send = vi.fn(async (_text: string) => {})
  await act(async () => { root.render(<OwnerDesk sessionId={sessionId} t={t} send={send} openTicket={() => {}} />) })
  await settle()
  return send
}

it('shows global work only on the main conversation and opens no task merely by viewing it', async () => {
  const send = await mount('worker-one')
  expect(document.querySelector('.dt-owner-desk')).toBeNull()
  expect(send).not.toHaveBeenCalled()
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
