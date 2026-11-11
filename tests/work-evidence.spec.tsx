// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { WorkEvidence } from '../src/client/work-evidence.tsx'
import type { ApiResponse } from '../src/app/api.ts'
import type { T } from '../src/client/text.ts'

vi.mock('../src/client/widgets.tsx', () => ({
  When: ({ at }: { at?: string }) => <time>{at}</time>,
  ExternalLink: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))
const t = ((key: string) => key === 'lang' ? 'en' : key) as T
const page = (): ApiResponse<'GET tickets/:id/evidence'> => ({ items: [{ reference: 'one', matterId: 'goal', revision: 1,
  redacted: false, title: 'Deployment evidence', assessment: 'informational', provider: 'wechat', partial: true,
  header: { at: '2026-11-11T00:00:00Z', conversationLabel: 'Project group' }, excerpt: 'Native source excerpt' }], next_offset: null })

it('fetches only while expanded and hides cached source content after a refresh failure', async () => {
  const element = document.createElement('div'), root = createRoot(element), load = vi.fn(async () => page())
  try {
    await act(async () => root.render(<WorkEvidence t={t} load={load} />))
    expect(load).not.toHaveBeenCalled()
    await act(async () => { const details = element.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')) })
    expect(load).toHaveBeenCalledTimes(1)
    expect(element.textContent).toContain('Native source excerpt')
    expect(element.textContent).toContain('unread or truncated')
    load.mockRejectedValueOnce(new Error('Source unavailable'))
    await act(async () => element.querySelector<HTMLButtonElement>('button')!.click())
    expect(element.querySelector('[role="alert"]')).not.toBeNull()
    expect(element.textContent).not.toContain('Native source excerpt')
  } finally { await act(async () => root.unmount()) }
})

it('hides all source details for a redacted receipt', async () => {
  const element = document.createElement('div'), root = createRoot(element), value = page()
  Object.assign(value.items[0]!, { redacted: true, title: 'PRIVATE TITLE', excerpt: 'PRIVATE BODY', url: 'https://example.com/PRIVATE' })
  try {
    await act(async () => root.render(<WorkEvidence t={t} load={async () => value} />))
    await act(async () => { const details = element.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')) })
    expect(element.textContent).toContain('Source access changed')
    expect(element.innerHTML).not.toContain('PRIVATE')
    expect(element.textContent).not.toContain('Project group')
  } finally { await act(async () => root.unmount()) }
})
