// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { PanelProvider } from '../src/client/provider.tsx'
import { QuickReply, TurnQuickReply } from '../src/client/quick-reply.tsx'
import { click, settle, translator, type } from './fixtures/panel.tsx'
import { usePanelServer } from './fixtures/panel-server.ts'

let root: Root
usePanelServer(() => { act(() => root?.unmount()); document.body.innerHTML = '' })
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
  await mount([1, 2, 3].map(turn => <TurnQuickReply key={turn} sessionId="master" turn={turn} t={t} send={send} />))
  expect(document.querySelectorAll('.dt-quick')).toHaveLength(1)
  await type(input()!, '允许 user')
  await click(zh.quickReplySend)
  expect(send).toHaveBeenCalledWith('允许 user')
  expect(input()?.value).toBe('')
  expect(document.querySelector('[role="status"]')?.textContent).toBe(zh.quickReplySent)
})

it('keeps the typed line when a newer Turn takes over the control', async () => {
  const send = vi.fn(async (_text: string) => {})
  const turns = (list: number[]) => list.map(turn => <TurnQuickReply key={turn} sessionId="master" turn={turn} t={t} send={send} />)
  await mount(turns([4, 5]))
  await type(input()!, '先做 B')
  await act(async () => { root.render(turns([4, 5, 6])) })
  await settle()
  expect(document.querySelectorAll('.dt-quick')).toHaveLength(1)
  expect(input()?.value).toBe('先做 B')
})

it('keeps an in-flight send unavailable when a newer Turn takes over', async () => {
  let release: () => void = () => {}
  const send = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
  const turns = (list: number[]) => list.map(turn => <TurnQuickReply key={turn} sessionId="master" turn={turn} t={t} send={send} />)
  await mount(turns([7, 8]))
  await type(input()!, '先做 C')
  await click(zh.quickReplySend)
  await act(async () => { root.render(turns([7, 8, 9])) })
  await settle()
  expect(document.querySelectorAll('.dt-quick')).toHaveLength(1)
  expect(input()?.value).toBe('先做 C')
  expect(sendButton()?.disabled).toBe(true)
  await act(async () => { release() })
  await settle()
})

it('leaves the composer as the only reply in a Session that is not the main one', async () => {
  const send = vi.fn(async (_text: string) => {})
  await mount(<TurnQuickReply sessionId="worker-one" turn={1} t={t} send={send} />)
  expect(document.querySelector('.dt-quick')).toBeNull()
})
