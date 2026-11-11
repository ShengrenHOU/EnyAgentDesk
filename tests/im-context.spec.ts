/** Host limits, scope fences and honest incomplete conversation evidence apply to every IM plugin. */
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { collectImContext, IM_CONTEXT_LIMITS, type ImContextRequest, type ImContextPage, type ImContextReader } from '../src/sources/im-context.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import type { Trigger } from '../src/core/index.ts'

const request: ImContextRequest = { anchor: { provider: 'test', account: 'owner', conversation: 'chat', message: 'a', version: 'v1', partial: false },
  anchorText: 'Please do it', start: '2026-11-01T10:00:00Z', end: '2026-11-01T11:00:00Z' }
const message = (id = 'a', extra = {}) => ({ id, version: 'v1', text: request.anchorText, createdAt: request.start, ...extra })
const page = (extra: Partial<ImContextPage> = {}): ImContextPage => ({ provider: 'test', account: 'owner', conversation: 'chat',
  start: request.start, end: request.end, messages: [message()], consistency: 'native_snapshot', snapshot: 's1', gaps: [], ...extra })
const reader = (read: ImContextReader['read']): ImContextReader => ({ assertActive: vi.fn(), read })
afterEach(() => vi.useRealTimers())

it('retains later outgoing replies/cancellation and host hashes a non-authoritative bounded manifest', async () => {
  const result = await collectImContext(reader(async (_, cursor) => cursor ? page({ messages: [message('b', { text: 'Cancel that', sender: 'owner' })] })
    : page({ next: 'two' })), request)
  expect(result.messages.map(item => item.id)).toEqual(['a', 'b'])
  expect(result.anchor.status).toBe('matched'); expect(result.contextComplete).toBe(false)
  expect(result.hash).toMatch(/^[a-f0-9]{64}$/); expect(result.covered).toEqual({ start: request.start, end: request.end })
})

it.each([
  [{ version: 'v2' }, 'edited'], [{ deleted: true }, 'deleted'], [{ version: undefined }, 'unverified'],
] as const)('reports exact observed anchor status %#', async (fields, status) => {
  const result = await collectImContext(reader(async () => page({ messages: [message('a', fields)] })), request)
  expect(result.anchor.status).toBe(status)
})

it('does not turn missing or unreadable latest anchor into an older history match', async () => {
  const result = await collectImContext(reader(async (_, cursor) => cursor ? page({ messages: [message('b')], gaps: ['anchor_missing'] })
    : page({ next: 'two', anchor: message() })), request)
  expect(result.anchor.status).toBe('missing'); expect(result.anchor.observed).toBeUndefined()
  const unreadable = await collectImContext(reader(async () => page({ gaps: ['anchor_unreadable'] })), request)
  expect(unreadable.anchor.status).toBe('missing')
})

it('an empty window has a missing anchor and no proven covered interval', async () => {
  const result = await collectImContext(reader(async () => page({ messages: [] })), request)
  expect(result.anchor.status).toBe('missing'); expect(result.covered).toBeNull()
})

it.each([
  { account: 'other' }, { conversation: 'other' }, { provider: 'other' }, { end: '2026-11-01T12:00:00Z' },
  { messages: [message('foreign', { createdAt: request.end })] }, { anchor: message('foreign') },
  { consistency: 'live_paginated', snapshot: 'fake' },
] as Partial<ImContextPage>[])('rejects foreign scope/window or invented snapshot %#', async extra => {
  await expect(collectImContext(reader(async () => page(extra)), request)).rejects.toThrow()
})

it.each(['duplicate', 'snapshot', 'cursor', 'empty'] as const)('rejects invalid cross-page %s', async fault => {
  const first = page({ next: 'two' })
  const second = fault === 'snapshot' ? page({ snapshot: 's2', messages: [message('b')] })
    : fault === 'cursor' ? page({ next: 'two', messages: [message('b')] })
      : fault === 'empty' ? page({ next: 'three', messages: [] }) : page()
  await expect(collectImContext(reader(async (_, cursor) => cursor ? second : first), request)).rejects.toThrow()
})

it('enforces text/messages/pages caps, recording loss without promoting completeness', async () => {
  const long = await collectImContext(reader(async () => page({ messages: [message('a', { text: 'x'.repeat(60_000), partial: true })] })), request)
  expect(long.messages[0]!.text.length).toBe(IM_CONTEXT_LIMITS.messageChars)
  expect(long.gaps).toEqual(expect.arrayContaining(['text_budget', 'partial_content_or_attachment']))
  const many = await collectImContext(reader(async () => page({ messages: Array.from({ length: 201 }, (_, i) => message(String(i))) })), request)
  expect(many.messages).toHaveLength(200); expect(many.gaps).toContain('message_budget')
  let n = 0
  const pages = await collectImContext(reader(async () => page({ messages: [message(String(++n))], next: String(n) })), request)
  expect(n).toBe(8); expect(pages.gaps).toContain('page_budget'); expect(pages.covered).toBeNull()
})

it('aborts even a non-cooperative page reader, and does not publish after explicit abort', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const pending = collectImContext(reader(() => new Promise(() => {})), request, controller.signal)
  const checked = expect(pending).rejects.toThrow('cancelled')
  controller.abort(new Error('cancelled')); await checked
})

it('invalidates a fetched page when scope is withdrawn before return', async () => {
  let active = true
  const r = reader(async () => { active = false; return page() })
  r.assertActive = () => { if (!active) throw new Error('Source disabled') }
  await expect(collectImContext(r, request)).rejects.toThrow('Source disabled')
})

it('fences third-party plugin configuration, enabled state, registration and account before each page and after it', async () => {
  const settings = SettingsSchema.parse({})
  settings.sources['third-party'] = { enabled: true, config: { account: 'owner' } }
  const registry = new SourceRegistry(() => settings)
  let mutate = () => {}
  const kind = { kind: 'third-party', title: { en: 'IM', zh: 'IM' }, description: { en: 'IM', zh: 'IM' },
    schema: z.object({ account: z.string().default('owner') }), fields: [], health: [],
    imEvidence: (_: Trigger, config: { account: string }) => ({ ...request.anchor, account: config.account }),
    imContext: async () => { mutate(); return page() } }
  const unregister = registry.register(kind)
  const trigger = { source: 'third-party', meta: {} } as Trigger
  const commands = { withSignal: () => commands } as unknown as Commands
  for (const change of [() => { settings.sources['third-party']!.enabled = false },
    () => { settings.sources['third-party']!.config.account = 'new' }, unregister]) {
    settings.sources['third-party'] = { enabled: true, config: { account: 'owner' } }
    const r = registry.imContext(trigger, commands); mutate = change
    await expect(collectImContext(r, request)).rejects.toThrow('configuration, account or scope changed')
  }
})

it('unsupported third-party capability produces an explicit empty partial manifest', async () => {
  const settings = SettingsSchema.parse({}), registry = new SourceRegistry(() => settings)
  registry.register({ kind: 'third-party', title: { en: 'IM', zh: 'IM' }, description: { en: 'IM', zh: 'IM' },
    schema: z.object({}), fields: [], health: [], imEvidence: () => request.anchor })
  const r = registry.imContext({ source: 'third-party', meta: {} } as Trigger, {} as Commands)
  const result = await collectImContext(r, request)
  expect(result.gaps).toContain('history_unsupported'); expect(result.covered).toBeNull()
})

it('returns a time gap within the host deadline even if a plugin never settles', async () => {
  const deadline = new AbortController(), timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  try {
    const pending = collectImContext(reader(() => new Promise(() => {})), request)
    deadline.abort(new DOMException('deadline', 'TimeoutError'))
    const result = await pending
    expect(result.gaps).toContain('time_budget'); expect(result.covered).toBeNull(); expect(result.messages).toEqual([])
  } finally { timeout.mockRestore() }
})

it('sanitizes permission/read failures instead of attaching partial evidence or CLI diagnostics', async () => {
  const registry = new SourceRegistry(() => SettingsSchema.parse({}))
  registry.register({ kind: 'third-party', title: { en: 'IM', zh: 'IM' }, description: { en: 'IM', zh: 'IM' },
    schema: z.object({}), fields: [], health: [], imEvidence: () => request.anchor,
    imContext: async () => { throw new Error('SECRET_STDERR') } })
  const commands = { withSignal: () => commands } as unknown as Commands
  await expect(collectImContext(registry.imContext({ source: 'third-party', meta: {} } as Trigger, commands), request))
    .rejects.toThrow('IM context read failed or permission is unavailable; no context was attached')
})

it.each([[503, true], [429, true], [403, false], [232011, false], [undefined, true]] as const)('retains safe retry classification for native CLI code %s', async (code, retryable) => {
  const registry = new SourceRegistry(() => SettingsSchema.parse({}))
  registry.register({ kind: 'third-party', title: { en: 'IM', zh: 'IM' }, description: { en: 'IM', zh: 'IM' },
    schema: z.object({}), fields: [], health: [], imEvidence: () => request.anchor,
    imContext: async () => { throw new CliError('SECRET_STDERR', code) } })
  const commands = { withSignal: () => commands } as unknown as Commands
  await expect(collectImContext(registry.imContext({ source: 'third-party', meta: {} } as Trigger, commands), request))
    .rejects.toMatchObject({ retryable, message: 'IM context read failed or permission is unavailable; no context was attached' })
})
