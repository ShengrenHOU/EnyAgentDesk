// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { PanelProvider } from '../src/client/provider.tsx'
import { ArtifactPreview, isMarkdownArtifact } from '../src/client/widgets.tsx'
import type { T } from '../src/client/text.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const t = ((key: string, params?: Record<string, unknown>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}) as T
const state = { load: { running: 0 } }
const artifact = (path: string) => `/api/superagent-workbench/artifact?ticketId=t1&path=${path}&sha256=fixed`
const MARKDOWN = ['# 交付报告', '', '| 项目 | 状态 |', '| --- | --- |', '| 表格 | 已渲染 |', '',
  '```ts', 'const ok = true', '```', '', '- [x] 已完成', '- [ ] 待处理', '', '[坏链接](javascript:alert(1))', '',
  '![追踪图](https://tracker.example/pixel.png)', '', '<script>window.hacked = true</script>'].join('\n')
let dispose: (() => void) | undefined
afterEach(() => { act(() => dispose?.()); dispose = undefined; vi.unstubAllGlobals(); document.body.innerHTML = '' })

async function render(node: ReactNode) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<PanelProvider t={t}>{node}</PanelProvider>) })
  dispose = () => { root.unmount(); container.remove() }
  return container
}
/** Answers the panel's state poll and returns `markdown` for the artifact read. */
function serve(markdown: string | null, status = 200) {
  const get = vi.fn(async (input: string) => String(input).includes('/artifact')
    ? new Response(markdown ?? '', { status }) : Response.json(state))
  vi.stubGlobal('fetch', get)
  return get
}

it('recognizes Markdown artifacts by their published path, not their display title', () => {
  expect(isMarkdownArtifact(artifact('report.md'))).toBe(true)
  expect(isMarkdownArtifact(artifact('notes.MARKDOWN'))).toBe(true)
  expect(isMarkdownArtifact(artifact('chart.png'))).toBe(false)
  expect(isMarkdownArtifact('not a url')).toBe(false)
})

it('renders fetched Markdown as GFM instead of raw text, without executing HTML', async () => {
  const get = serve(MARKDOWN)
  const container = await render(<ArtifactPreview title="报告" url={artifact('report.md')} />)
  await vi.waitFor(() => expect(container.querySelector('.dt-artifact-md table')).not.toBeNull())
  expect(container.querySelector('.dt-artifact-md th')?.textContent).toBe('项目')
  expect(container.querySelector('.dt-artifact-md pre code')?.textContent).toContain('const ok = true')
  const checks = [...container.querySelectorAll<HTMLInputElement>('.dt-artifact-md input[type="checkbox"]')]
  expect(checks.map(check => check.checked)).toEqual([true, false])
  expect(checks.every(check => check.disabled)).toBe(true)
  expect(container.querySelector('.dt-artifact-md script')).toBeNull()
  expect(container.querySelector('.dt-artifact-md a[href^="javascript"]')).toBeNull()
  // A source-derived external image must not load outside the artifact's no-network policy.
  expect(container.querySelector('.dt-artifact-md img')).toBeNull()
  expect(container.querySelector('iframe')).toBeNull()
  expect(get).toHaveBeenCalledWith(artifact('report.md'), expect.objectContaining({ credentials: 'same-origin' }))
})

it('keeps the sandboxed frame for images and other verified files', async () => {
  serve(null)
  const container = await render(<ArtifactPreview title="图表" url={artifact('chart.png')} />)
  expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('')
  expect(container.querySelector('iframe')?.getAttribute('src')).toBe(artifact('chart.png'))
})

it('offers the original when the Markdown bytes cannot be read', async () => {
  serve(null, 500)
  const container = await render(<ArtifactPreview title="报告" url={artifact('report.md')} />)
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('HTTP 500'))
  expect(container.querySelector('.dt-artifact-md')).toBeNull()
  expect(container.querySelector('a[href*="artifact"]')).not.toBeNull()
})
