// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { PanelProvider } from '../src/client/provider.tsx'
import { QuickReply, TurnQuickReply } from '../src/client/quick-reply.tsx'
import { click, settle, translator, type } from './fixtures/panel.tsx'
import { server, usePanelServer } from './fixtures/panel-server.ts'

let root: Root
usePanelServer(() => { act(() => root?.unmount()); document.body.innerHTML = '' })
let master: string
beforeEach(() => { master = `master-${crypto.randomUUID()}`; server.masterId = master })
const t = translator(zh)
async function mount(children: ReactNode) {
  const container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => { root.render(children) })
  await settle()
}
const input = () => document.querySelector<HTMLInputElement>('.dt-quick input')
const sendButton = () => document.querySelector<HTMLButtonElement>('.dt-quick button')

/** Stands in for a caller that owns the draft and the send. */
function Draft({ onSubmit }: { onSubmit(): void }) {
  const [value, setValue] = useState('')
  return <PanelProvider t={t}><QuickReply value={value} onChange={setValue} onSubmit={onSubmit} busy={false}
    placeholder={zh.quickReplyHere} /></PanelProvider>
}

it('sends one typed line and stays unavailable while the line is empty', async () => {
  const onSubmit = vi.fn()
  await mount(<Draft onSubmit={onSubmit} />)
  expect(input()?.getAttribute('aria-label')).toBe(zh.quickReplyHere)
  expect(sendButton()?.disabled).toBe(true)
  await type(input()!, '先做 A')
  expect(sendButton()?.disabled).toBe(false)
  await click(sendButton()!)
  expect(onSubmit).toHaveBeenCalledTimes(1)
})

it('offers one inline reply, under the newest Turn, and sends it into that Session', async () => {
  const send = vi.fn(async (_text: string) => {})
  await mount([1, 2, 3].map(turn => <TurnQuickReply key={turn} sessionId={master} turn={turn} seq={turn * 10} quote={`报告 ${turn}`} t={t} send={send} />))
  expect(document.querySelectorAll('.dt-quick')).toHaveLength(1)
  await type(input()!, '允许 user')
  await click(zh.quickReplySend)
  expect(send.mock.calls[0]![0]).toContain('消息 30')
  expect(send.mock.calls[0]![0]).toContain('允许 user')
  expect(input()?.value).toBe('')
  expect(document.querySelector('[role="status"]')?.textContent).toBe(zh.quickReplySent)
})

it('pins the editor and focus when newer Turns arrive, and sends the original reference', async () => {
  const send = vi.fn(async (_text: string) => {})
  const turns = (list: number[]) => list.map(turn => <section data-turn={turn} key={turn}>
    <TurnQuickReply sessionId={master} turn={turn} seq={turn * 10} quote={`部署报告 ${turn}`} t={t} send={send} />
  </section>)
  await mount(turns([4, 5]))
  const editor = input()!
  await act(async () => { editor.focus() })
  await type(input()!, '先做 B')
  await act(async () => { root.render(turns([4, 5, 6, 7, 8])) })
  await settle()
  expect(document.querySelectorAll('.dt-quick')).toHaveLength(1)
  expect(input()).toBe(editor)
  expect(document.activeElement).toBe(editor)
  expect(input()?.closest('section')?.dataset.turn).toBe('5')
  expect(input()?.value).toBe('先做 B')
  await click(sendButton()!)
  expect(send).toHaveBeenCalledOnce()
  expect(send.mock.calls[0]![0]).toContain('消息 50')
  expect(send.mock.calls[0]![0]).toContain('部署报告 5')
  expect(send.mock.calls[0]![0]).toContain('先做 B')
})

it('restores each selected Turn draft and keeps it after a failed send', async () => {
  const send = vi.fn(async (_text: string) => { throw new Error('offline') })
  const turns = [10, 11].map(turn => <section data-turn={turn} key={turn}>
    <TurnQuickReply sessionId={master} turn={turn} seq={turn * 10} quote={`报告 ${turn}`} t={t} send={send} />
  </section>)
  await mount(turns)
  await type(input()!, '最新草稿')
  await click(document.querySelector<HTMLElement>('[data-turn="10"] button')!)
  expect(input()?.value).toBe('')
  await type(input()!, '较早草稿')
  await click(document.querySelector<HTMLElement>('[data-turn="11"] button')!)
  expect(input()?.value).toBe('最新草稿')
  await click(document.querySelector<HTMLElement>('[data-turn="10"] button')!)
  expect(input()?.value).toBe('较早草稿')
  await click(sendButton()!)
  expect(input()?.value).toBe('较早草稿')
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('offline')
  expect(send.mock.calls[0]![0]).toContain('消息 100')
})

it('keeps an in-flight send and its draft on the original Turn', async () => {
  let release: () => void = () => {}
  const send = vi.fn((_text: string) => new Promise<void>(resolve => { release = resolve }))
  const turns = (list: number[]) => list.map(turn => <TurnQuickReply key={turn} sessionId={master} turn={turn} seq={turn * 10} quote={`报告 ${turn}`} t={t} send={send} />)
  await mount(turns([20, 21]))
  await type(input()!, '先做 C')
  await click(zh.quickReplySend)
  await act(async () => { root.render(turns([20, 21, 22])) })
  await settle()
  expect(document.querySelectorAll('.dt-quick')).toHaveLength(1)
  expect(input()?.value).toBe('先做 C')
  expect(sendButton()?.disabled).toBe(true)
  await act(async () => { release() })
  await settle()
  expect(input()?.value).toBe('')
  await type(input()!, '新的回复')
  await click(zh.quickReplySend)
  expect(send.mock.calls[1]![0]).toContain('消息 220')
  await act(async () => { release() })
  await settle()
})

it('bounds the quote while retaining the closing question and marking the omitted middle', async () => {
  const send = vi.fn(async (_text: string) => {})
  await mount(<TurnQuickReply sessionId={master} turn={1} seq={15} quote={`开头报告${'x'.repeat(6000)}是否继续？`}
    t={t} send={send} />)
  await type(input()!, '继续')
  await click(sendButton()!)
  const message = send.mock.calls[0]![0]
  expect(message.length).toBeLessThan(4500)
  expect(message).toContain('> 开头报告')
  expect(message).toContain('是否继续？')
  expect(message).toContain('引用已节选')
})

it('leaves the composer as the only reply in a Session that is not the main one', async () => {
  const send = vi.fn(async (_text: string) => {})
  await mount(<TurnQuickReply sessionId="worker-one" turn={1} seq={10} quote="worker" t={t} send={send} />)
  expect(document.querySelector('.dt-quick')).toBeNull()
})
