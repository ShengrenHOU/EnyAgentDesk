// @vitest-environment jsdom
// Panel search, glossary, route persistence, and host-down fallback.
import { act } from 'react'
import { expect, it } from 'vitest'
import type { LinePageView, LineRow } from '../src/client/api.ts'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, click, type, text, field } from './fixtures/panel.tsx'
import { server, found } from './fixtures/panel-server.ts'

const lineRow = (fields: Partial<LineRow> = {}): LineRow => ({ id: 'line-1', title: '跨阶段目标 Alpha', status: 'open',
  createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z', ticketCount: 0, openCount: 0, ...fields })
const linePage = (line: LineRow, judgements: LinePageView['judgements'] = [], tickets: LinePageView['tickets'] = []): LinePageView =>
  ({ ...line, judgements, tickets })
const submitSearch = async (value: string) => {
  const search = field<HTMLInputElement>(zh.searchLabel)
  await type(search, value)
  await act(async () => { search.closest('form')!.requestSubmit() }); await settle()
}

usePanel()
it('states why a filtered search result has no Thread instead of opening an empty one', async () => {
  server.search = { items: [found('e9', '2026-09-20T00:00:00Z', { source: 'github', actor: { source: 'github', id: 'someone' },
    preview: 'issue text', threads: ['github:7'],
    filtered: 'source_disabled' })], threads: [] }
  await mount()
  await type(field<HTMLInputElement>(zh.searchLabel), 'issue')
  await act(async () => { field<HTMLInputElement>(zh.searchLabel).closest('form')!.requestSubmit() }); await settle()
  expect(text()).toContain('被来源过滤：来源已停用')
  expect(all('.dt-search-results button').some(button => button.textContent === 'issue text')).toBe(false)
})

it('opens a search result older than the newest page around its Trigger', async () => {
  server.search = { items: [found('e1', '2026-09-20T00:00:00Z')], threads: [] }
  await mount()
  await type(field<HTMLInputElement>(zh.searchLabel), 'message')
  await act(async () => { field<HTMLInputElement>(zh.searchLabel).closest('form')!.requestSubmit() }); await settle()
  expect(text()).toContain('找到 0 条主线、0 个工单、0 个线程、1 条触发')
  await click(all('.dt-search-results button').find(button => button.textContent === 'message e1')!)
  expect(server.requests.some(request => request.path.includes('around=e1'))).toBe(true)
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('message e1')
})

it('explains what can be searched when nothing matches', async () => {
  await mount()
  await type(field<HTMLInputElement>(zh.searchLabel), 'nothing')
  await act(async () => { field<HTMLInputElement>(zh.searchLabel).closest('form')!.requestSubmit() }); await settle()
  expect(text()).toContain('没有找到。可以输入主线目标名')
})

it('returns to the exact page after a remount of the main panel', async () => {
  await mount()
  await click('修复回归')
  await remount()
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
})

it('shows domain terms in the interface language only and lists both languages in the (?) glossary', async () => {
  await mount(en)
  expect(all('[role="tab"]').map(tab => tab.textContent)).toEqual(['Overview', 'Source', 'Trigger', 'Eval', 'Execution', 'Settings'])
  await click('Glossary')
  const dialog = document.querySelector('[role="dialog"]')!
  const row = [...dialog.querySelectorAll('tr')].find(item => item.textContent?.startsWith('Ticket'))!
  expect([...row.querySelectorAll('td')].map(cell => cell.textContent)).toEqual(['Ticket', '工单', 'An authorized unit of work'])
  expect(dialog.textContent).toContain('Accept 接单')
  // Terms are grouped the way the tabs follow the flow, after the roles that act in it.
  expect([...dialog.querySelectorAll('th.dt-glossary-group')].map(cell => cell.textContent)).toEqual(['Roles', 'Source', 'Trigger', 'Eval',
    'Execution'])
  expect([...dialog.querySelectorAll('tr')].find(item => item.textContent?.startsWith('Main Session'))!.textContent).toContain('prompts call it the orchestrator')
})

it('says dsh-superagent is not answering when its routes are gone, as while it restarts', async () => {
  server.down = true
  await mount()
  expect(text()).toContain(zh.hostNotRunning)
  expect(text()).not.toContain('404')
})

it('closes search results on Escape and on a click outside the search', async () => {
  await mount()
  const search = field<HTMLInputElement>(zh.searchLabel)
  const submit = async () => { await type(search,
    'nothing'); await act(async () => { search.closest('form')!.requestSubmit() }); await settle() }
  await submit()
  expect(document.querySelector('.dt-search-results')).not.toBeNull()
  await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(document.querySelector('.dt-search-results')).toBeNull()
  await submit()
  await act(async () => { document.querySelector('main')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
  expect(document.querySelector('.dt-search-results')).toBeNull()
})

it('shows the answer to the latest search only', async () => {
  server.search = { items: [found('e1', '2026-09-20T00:00:00Z', { preview: 'old message' }), found('e2', '2026-09-21T00:00:00Z',
    { preview: 'new message' })], threads: [] }
  let release = () => {}
  server.searching = async query => { if (query === 'old') await new Promise<void>(resolve => { release = resolve }) }
  await mount()
  const search = field<HTMLInputElement>(zh.searchLabel)
  for (const query of ['old', 'new']) { await type(search,
    query); await act(async () => { search.closest('form')!.requestSubmit() }); await settle() }
  expect(all('.dt-search-results .dt-row-title').map(title => title.textContent)).toEqual(['new message'])
  await act(async () => { release() }); await settle()
  expect(all('.dt-search-results .dt-row-title').map(title => title.textContent)).toEqual(['new message'])
})

it('recalls a Line goal in the global search and opens its existing detail', async () => {
  const at = '2026-11-09T00:00:00Z'
  const line = lineRow({ createdAt: at, updatedAt: at, ticketCount: 1, openCount: 1 })
  server.search = { items: [], threads: [], lines: [line] }
  server.lines = { open: [line], closed: [], closedTotal: 0, generatedAt: at }
  server.lineDetails = { [line.id]: linePage(line, [{ at, action: 'opened', evidence: '本人确认跨阶段目标' }],
    [{ id: 't9', title: '检查材料', stage: 'working', createdAt: at, updatedAt: at, followups: [] }]) }
  await mount()
  await submitSearch('跨阶段目标 Alpha')
  // A Line-only answer is not an empty answer, and its own kind and status are explicit.
  expect(text()).toContain('找到 1 条主线、0 个工单、0 个线程、0 条触发')
  const row = all('.dt-search-results .dt-row').find(item => item.querySelector('.dt-row-title')?.textContent === '跨阶段目标 Alpha')!
  expect(row.textContent).toContain(zh['term.line'])
  expect(row.textContent).toContain(zh.lineOpen)
  expect(row.textContent).toContain('1 张工单')
  await click(row.querySelector<HTMLButtonElement>('.dt-open')!)
  expect(server.requests).toContainEqual(expect.objectContaining({ path: `lines/${line.id}` }))
  expect(document.querySelector('.pw-line-detail')?.textContent).toContain('本人确认跨阶段目标')
  expect(document.body.textContent).toContain('检查材料')
  // Returning keeps the search term in the header, so the same answer is one submit away.
  await click(all('.dt-page button').find(button => button.textContent === zh['tab.overview'])!)
  expect(field<HTMLInputElement>(zh.searchLabel).value).toBe('跨阶段目标 Alpha')
})

it('keeps same-titled Lines as separate results by id, each opening its own detail', async () => {
  const at = '2026-11-09T00:00:00Z'
  const active = lineRow({ id: 'line-open', createdAt: at, updatedAt: at })
  const closed = lineRow({ id: 'line-closed', status: 'closed', createdAt: at, updatedAt: at, closedAt: at })
  server.search = { items: [], threads: [], lines: [active, closed] }
  server.lines = { open: [active], closed: [closed], closedTotal: 1, generatedAt: at }
  server.lineDetails = { [closed.id]: linePage(closed, [{ at, action: 'closed', evidence: '第二个同名目标的关闭依据' }]) }
  await mount()
  await submitSearch('跨阶段目标 Alpha')
  const rows = all('.dt-search-results .dt-row').filter(item => item.textContent?.includes('跨阶段目标 Alpha'))
  expect(rows).toHaveLength(2)
  expect(rows[0]?.textContent).toContain(zh.lineOpen)
  expect(rows[1]?.textContent).toContain(zh.lineClosed)
  // The closed goal remains readable but is labelled closed; opening it does not reopen anything.
  await click(rows[1]!.querySelector<HTMLButtonElement>('.dt-open')!)
  expect(document.querySelector('.pw-line-detail')?.textContent).toContain(zh.lineClosed)
  expect(document.body.textContent).toContain('第二个同名目标的关闭依据')
  expect(server.requests.some(request => request.method === 'POST' && request.path.includes('membership'))).toBe(false)
})

it('labels a Line answer cut at the result limit and says to narrow the search', async () => {
  server.search = { items: [], threads: [], lines: [0, 1, 2, 3, 4].map(index => lineRow({ id: `line-${index}`,
    title: `跨阶段目标 ${index}` })) }
  await mount()
  await submitSearch('跨阶段目标')
  expect(all('.dt-search-results .dt-row')).toHaveLength(5)
  expect(text()).toContain('已达结果上限')
})

it('reports a Line that no longer exists instead of opening an empty detail', async () => {
  server.search = { items: [], threads: [], lines: [lineRow({ id: 'line-gone' })] }
  await mount()
  await submitSearch('跨阶段目标 Alpha')
  await click(all('.dt-search-results .dt-row')[0]!.querySelector<HTMLButtonElement>('.dt-open')!)
  expect(text()).toContain('Line not found')
  expect(all('.dt-page button').some(button => button.textContent === zh['tab.overview'])).toBe(true)
})

