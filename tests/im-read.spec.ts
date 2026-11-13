/** The shared IM read gateway normalizes one bounded window and binds every continuation to its exact request. */
import { expect, it, vi } from 'vitest'
import { readImWindow, type ImReadHost } from '../src/app/im-read.ts'
import { imDedupKey, imMessageId, imObjectId } from '../src/sources/im-identity.ts'
import type { ImReadPage, ImReadRequest } from '../src/sources/im-context.ts'
import type { Commands } from '../src/infra/commands.ts'

const start = '2026-11-01T10:00:00Z', end = '2026-11-01T11:00:00Z'
const request = { provider: 'feishu-messages', conversation: 'Project Alpha', start, end }
const message = (fields: object = {}) => ({ id: 'om_one', version: 'v1', versionBasis: 'source_digest' as const,
  text: 'Project update', sender: 'ou_sender', createdAt: '2026-11-01T10:01:00Z', ...fields })
const page = (overrides: Partial<ImReadPage> = {}): ImReadPage => ({ provider: 'feishu-messages', account: 'ou_owner',
  conversation: 'oc_group', start, end, messages: [message()], consistency: 'live_paginated', gaps: ['live_pagination'],
  resolved: { id: 'oc_group', label: 'Project Alpha' }, resolution: 'exact_name', ...overrides })
const host = (read: (request: ImReadRequest, cursor?: string) => Promise<ImReadPage>): ImReadHost => {
  const imRead = async (_commands: Commands, request: ImReadRequest, cursor: string | undefined) => read(request, cursor)
  return { sources: { imRead }, commands: {} as Commands }
}
const signal = new AbortController().signal

it('returns one canonical identity for each native message and a cursor for the next page', async () => {
  const read = vi.fn(async (_request: ImReadRequest, _cursor?: string) => page({ next: 'native-next' }))
  const result = await readImWindow(host(read), request, signal)
  expect(result.resolved).toBe(true)
  expect(result.conversation).toEqual({ id: 'oc_group', label: 'Project Alpha' })
  expect(result.messages[0]).toMatchObject({ id: 'om_one', object_id: imObjectId({ provider: 'feishu-messages', conversation: 'oc_group' }),
    message_key: imMessageId({ provider: 'feishu-messages', conversation: 'oc_group' }, 'om_one'),
    dedup_key: imDedupKey({ provider: 'feishu-messages', conversation: 'oc_group' }, 'om_one', 'v1'), version: 'v1' })
  const cursor = JSON.parse(Buffer.from(result.next!, 'base64url').toString('utf8'))
  expect(cursor).toMatchObject({ v: 1, provider: 'feishu-messages', source: 'Project Alpha', conversation: 'oc_group',
    start, end, next: 'native-next' })
  const second = await readImWindow(host(read), { ...request, cursor: result.next }, signal)
  expect(second.messages[0]?.id).toBe('om_one')
  expect(read.mock.calls[1]?.[0]).toMatchObject({ conversation: 'oc_group' })
  expect(read.mock.calls[1]?.[1]).toBe('native-next')
  // A caller may continue with the resolved native ID instead of repeating the display name.
  await expect(readImWindow(host(read), { ...request, conversation: 'oc_group', cursor: result.next }, signal)).resolves.toBeDefined()
})

it('returns candidates instead of reading when a display name is ambiguous or unknown', async () => {
  const ambiguous = await readImWindow(host(async () => page({ messages: [], candidates: [{ id: 'oc_one', label: 'Alpha' }],
    gaps: ['conversation_ambiguous'], resolved: undefined })), { ...request, conversation: 'Alpha' }, signal)
  expect(ambiguous).toMatchObject({ resolved: false, messages: [], candidates: [{ id: 'oc_one', label: 'Alpha' }] })
  expect(ambiguous.gaps).toContain('conversation_ambiguous')
  const missing = await readImWindow(host(async () => page({ messages: [], candidates: [], resolved: undefined,
    gaps: ['conversation_not_found'] })), { ...request, conversation: 'Nobody' }, signal)
  expect(missing).toMatchObject({ resolved: false, candidates: [] })
  expect(missing.gaps).toContain('conversation_not_found')
})

it('binds a cursor to its provider, source name, window and keyword', async () => {
  const read = vi.fn(async (_request: ImReadRequest, _cursor?: string) => page({ next: 'native-next' }))
  const first = await readImWindow(host(read), request, signal)
  await expect(readImWindow(host(read), { ...request, cursor: first.next, keyword: 'contract' }, signal)).rejects.toThrow('another IM read')
  await expect(readImWindow(host(read), { ...request, cursor: first.next, start: '2026-11-01T10:00:01Z' }, signal)).rejects.toThrow('another IM read')
  await expect(readImWindow(host(read), { ...request, conversation: 'Other', cursor: first.next }, signal)).rejects.toThrow('another IM read')
  await expect(readImWindow(host(read), { ...request, cursor: 'not-base64-json' }, signal)).rejects.toThrow()
})

it('rejects a page that changes provider or window and two versions of one message', async () => {
  await expect(readImWindow(host(async () => page({ provider: 'wechat' })), request, signal)).rejects.toThrow('different provider')
  await expect(readImWindow(host(async () => page({ end: '2026-11-01T12:00:00Z' })), request, signal)).rejects.toThrow('escaped its requested window')
  await expect(readImWindow(host(async () => page({ resolved: { id: 'oc_other' } })), request, signal)).rejects.toThrow('inconsistent conversation')
  const duplicate = page({ messages: [message(), message({ version: 'v2' })] })
  await expect(readImWindow(host(async () => duplicate), request, signal)).rejects.toThrow('two versions')
})

it('deduplicates exact repeated messages and reports an empty window explicitly', async () => {
  const repeated = await readImWindow(host(async () => page({ messages: [message(), message()] })), request, signal)
  expect(repeated.messages).toHaveLength(1)
  const empty = await readImWindow(host(async () => page({ messages: [] })), request, signal)
  expect(empty.messages).toEqual([])
  expect(empty.gaps).toContain('empty_window')
})

it('keeps the keyword in the result and rejects a window longer than seven days', async () => {
  const result = await readImWindow(host(async () => page()), { ...request, keyword: ' update ' }, signal)
  expect(result.keyword).toBe('update')
  await expect(readImWindow(host(async () => page()), { ...request, start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' }, signal))
    .rejects.toThrow('at most seven days')
})

it('bounds an oversized page without offering a continuation that would skip held-back messages', async () => {
  const messages = Array.from({ length: 30 }, (_, index) => message({ id: `om_${index}`, text: 'x'.repeat(4_000) }))
  const result = await readImWindow(host(async () => page({ messages, next: 'native-next' })), request, signal)
  expect(result.messages.length).toBeLessThan(30)
  expect(result.next).toBeUndefined()
  expect(result.gaps).toContain('page_budget')
})

it('truncates one long message and marks it partial', async () => {
  const result = await readImWindow(host(async () => page({ messages: [message({ text: 'x'.repeat(9_000) })] })), request, signal)
  expect(result.messages[0]?.text).toHaveLength(8_000)
  expect(result.messages[0]?.partial).toBe(true)
  expect(result.gaps).toContain('text_truncated')
})
