/** Context is bounded shadow evidence: native history cannot claim, acknowledge or dispatch business work. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Store } from '../src/app/store.ts'
import { ShadowTriage, type TriageBatch } from '../src/app/triage.ts'
import type { Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'
import type { ImContextPage, ImContextRequest } from '../src/sources/im-context.ts'
import { SourceRegistry } from '../src/sources/registry.ts'

let directory: string, store: Store, triage: ShadowTriage, sources: SourceRegistry
let now: number, paused: boolean, allowed: boolean, settings: ReturnType<Store['settings']>
let unregister: () => void
let fetchPage: (request: ImContextRequest, cursor: string | undefined, signal: AbortSignal) => Promise<ImContextPage>
let reader: ReturnType<typeof vi.fn<typeof fetchPage>>
const window = { start: '2026-11-10T00:00:00Z', end: '2026-11-11T00:00:00Z' }
const message = (id: string, text = 'Please prepare the deck', createdAt = '2026-11-10T01:00:00Z') => ({ id, text, version: 'native-v1', createdAt })
const trigger = (id: string, conversation = 'chat'): Trigger => ({ id, source: 'generic-im', at: new Date(now).toISOString(),
  threads: [{ source: 'generic-im', id: `thread-${id}` }], actor: { source: 'generic-im', id: 'sender' }, human: false,
  text: 'Please prepare the deck', meta: { conversation, message: `native-${id}` } })
const page = (request: ImContextRequest): ImContextPage => ({ provider: request.anchor.provider, account: request.anchor.account,
  conversation: request.anchor.conversation, start: request.start, end: request.end, messages: [message(request.anchor.message)],
  consistency: 'live_paginated', gaps: [] })
const claim = (...items: Trigger[]) => { items.forEach(item => store.triggers.save(item)); return triage.claim(items.map(item => item.id)).batches[0]! }
const result = (batch: TriageBatch) => ({ model: 'test-model', items: batch.inputs.map(input => ({ triggerId: input.triggerId,
  bucket: 'none' as const, reason: 'Later evidence cancels the request', matterIds: [] })), matters: [] })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function pendingRead() {
  const entered = deferred<ImContextRequest>(), release = deferred<void>()
  fetchPage = async request => { entered.resolve(request); await release.promise; return page(request) }
  return { entered: entered.promise, release: () => release.resolve() }
}
function businessSnapshot() {
  return { tables: Object.fromEntries(['trigger', 'trigger_thread', 'thread', 'ticket', 'decision', 'disposition', 'outbox', 'effect']
    .map(table => [table, store.db.prepare(`SELECT * FROM ${table}`).all()])),
  otherKV: store.db.prepare("SELECT * FROM kv WHERE key NOT LIKE 'triage-shadow-%' ORDER BY key").all() }
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'im-context-triage-')); store = new Store(join(directory, 'state.sqlite'))
  now = Date.parse('2026-11-10T01:00:00Z'); paused = false; allowed = true; settings = store.settings()
  sources = new SourceRegistry(() => settings)
  fetchPage = async request => page(request)
  reader = vi.fn((request: ImContextRequest, cursor: string | undefined, signal: AbortSignal) => fetchPage(request, cursor, signal))
  unregister = sources.register({ kind: 'generic-im', title: { en: 'IM', zh: 'IM' }, description: { en: 'IM', zh: 'IM' },
    schema: z.object({ revision: z.string().default('v1') }), fields: [], health: [], scope: () => allowed ? { listened: true, observed: true } : { listened: false, reason: 'scope' },
    imEvidence: item => ({ provider: 'generic-provider', account: 'owner', conversation: String(item.meta.conversation),
      message: String(item.meta.message), version: 'native-v1', partial: false }),
    imAnchorText: item => String(item.meta.nativeText ?? item.text),
    imContext: (_commands, request, cursor, _config, signal) => reader(request, cursor, signal) })
  const commands = new Commands(() => { throw new Error('Tests must not invoke external commands') }, {}, new AbortController().signal)
  triage = new ShadowTriage({ store, evidence: item => sources.imEvidence(item), context: item => sources.imContext(item, commands),
    paused: () => paused, now: () => now })
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('uses the real generic reader and collector, preserving later replies and cancellation without business writes or ACKs', async () => {
  const batch = claim(trigger('a'), trigger('b'))
  store.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('source-ack-test', JSON.stringify({ cursor: 'not-consumed' }))
  const before = businessSnapshot()
  fetchPage = async (request, cursor) => {
    expect(store.db.isTransaction).toBe(false)
    return cursor === undefined
    ? { ...page(request), next: 'page-2' }
    : { ...page(request), messages: [message('reply', 'Already done', '2026-11-10T02:00:00Z'),
      message('cancel', 'Cancel the deck request', '2026-11-10T03:00:00Z')] }
  }
  const saved = await triage.prepareContext(batch.id, 1, 'b', window)
  expect(reader).toHaveBeenCalledTimes(2)
  expect(reader.mock.calls[0]![0]).toEqual({ ...window, anchor: batch.inputs[1]!.identity, anchorText: trigger('b').text })
  expect(saved.context).toMatchObject({ generation: 1, settingsRevision: 0, revision: 1, manifest: {
    schema: 'im-context-v1', contextComplete: false, pages: 2, requested: window, covered: window,
    scope: { provider: 'generic-provider', account: 'owner', conversation: 'chat' },
    anchor: { id: 'native-b', selectedVersion: 'native-v1', status: 'matched', contentMatch: true },
    gaps: ['live_pagination_not_snapshot'],
  } })
  expect(saved.context!.manifest.hash).toMatch(/^[a-f0-9]{64}$/)
  expect(saved.context!.manifest.messages.map(item => item.id)).toEqual(['native-b', 'reply', 'cancel'])
  expect(saved.inputs).toEqual(batch.inputs); expect(saved.contextComplete).toBe(false); expect(saved.state).toBe('claimed')
  expect(triage.read(batch.id)).toEqual(saved)
  expect(businessSnapshot()).toEqual(before)
  expect(store.keys('triage-shadow-').length).toBeGreaterThan(0)
})

it('requires the exact selected Trigger anchor, not a native message ID or another batch member', async () => {
  const batch = claim(trigger('a')), foreign = claim(trigger('foreign', 'other'))
  for (const id of ['native-a', foreign.inputs[0]!.triggerId, 'missing']) {
    await expect(triage.prepareContext(batch.id, 1, id, window)).rejects.toThrow('exact input')
  }
  expect(reader).not.toHaveBeenCalled(); expect(triage.read(batch.id).context).toBeUndefined()
})

it('rejects stale generation before any fetch', async () => {
  const batch = claim(trigger('a')); now += 300_001; triage.claim(['a'])
  await expect(triage.prepareContext(batch.id, 1, 'a', window)).rejects.toThrow('Stale')
  expect(reader).not.toHaveBeenCalled()
})

it('rejects a generation renewed during fetch and never attaches late evidence', async () => {
  const batch = claim(trigger('a')), pending = pendingRead()
  const work = triage.prepareContext(batch.id, 1, 'a', window); await pending.entered
  now += 300_001; const renewed = triage.claim(['a']).batches[0]!; pending.release()
  await expect(work).rejects.toThrow('Stale')
  expect(triage.read(batch.id)).toEqual(renewed); expect(renewed.context).toBeUndefined()
})

it.each(['settings', 'configuration', 'disabled', 'scope', 'paused', 'lease', 'immutable', 'unregistered'] as const)(
  'discards context when %s changes during the fetch', async change => {
    const batch = claim(trigger('a'), trigger('b')), pending = pendingRead()
    const work = triage.prepareContext(batch.id, 1, 'a', window); await pending.entered
    if (change === 'settings') store.set(KV.settings.revision, 1)
    if (change === 'configuration' || change === 'disabled') settings = { ...settings, sources: { ...settings.sources,
      'generic-im': { enabled: change !== 'disabled', config: { revision: change === 'configuration' ? 'v2' : 'v1' } } } }
    if (change === 'scope') allowed = false
    if (change === 'paused') paused = true
    if (change === 'lease') now += 300_000
    // Every input is fenced, even when the changed record was not selected as the anchor.
    if (change === 'immutable') store.triggers.save({ ...store.triggers.get('b')!, text: 'Edited immutable evidence' })
    if (change === 'unregistered') unregister()
    const beforeRelease = store.db.prepare("SELECT * FROM kv WHERE key LIKE 'triage-shadow-%' ORDER BY key").all()
    pending.release(); await expect(work).rejects.toThrow()
    expect(store.db.prepare("SELECT * FROM kv WHERE key LIKE 'triage-shadow-%' ORDER BY key").all()).toEqual(beforeRelease)
  })

it('does not attach context to a completed result, including completion while fetching', async () => {
  const batch = claim(trigger('a')), pending = pendingRead()
  const work = triage.prepareContext(batch.id, 1, 'a', window); await pending.entered
  const completed = triage.submit(batch.id, 1, result(batch)); pending.release()
  await expect(work).rejects.toThrow('Completed')
  await expect(triage.prepareContext(batch.id, 1, 'a', window)).rejects.toThrow('Completed')
  expect(reader).toHaveBeenCalledTimes(1); expect(triage.read(batch.id)).toEqual(completed)
})

it('uses compare-and-swap so simultaneous reads cannot overwrite the winner', async () => {
  const batch = claim(trigger('a')), entered = deferred<void>(), releaseFirst = deferred<void>()
  let reads = 0
  fetchPage = async request => { const read = ++reads; if (read === 1) { entered.resolve(); await releaseFirst.promise }
    return { ...page(request), gaps: [read === 1 ? 'first' : 'second'] } }
  const first = triage.prepareContext(batch.id, 1, 'a', window); await entered.promise
  const winner = await triage.prepareContext(batch.id, 1, 'a', window)
  releaseFirst.resolve(); await expect(first).rejects.toThrow('context changed')
  expect(winner.context!.revision).toBe(1); expect(triage.read(batch.id)).toEqual(winner)
  const next = await triage.prepareContext(batch.id, 1, 'a', window)
  expect(next.context!.revision).toBe(2)
})

it('rejects cancellation during fetch without attaching a late adapter response', async () => {
  const batch = claim(trigger('a')), pending = pendingRead(), abort = new AbortController()
  const work = triage.prepareContext(batch.id, 1, 'a', window, abort.signal); await pending.entered
  abort.abort(new Error('User cancelled')); await expect(work).rejects.toThrow('User cancelled')
  pending.release(); await Promise.resolve(); expect(triage.read(batch.id).context).toBeUndefined()
})

it('invalidates saved context at lease renewal and retains exact batch membership', async () => {
  const batch = claim(trigger('a'), trigger('b')); await triage.prepareContext(batch.id, 1, 'a', window)
  now += 300_001; const renewed = triage.claim(['b']).batches[0]!
  expect(renewed.generation).toBe(2); expect(renewed.inputs).toEqual(batch.inputs); expect(renewed.context).toBeUndefined()
  expect((await triage.prepareContext(batch.id, 2, 'b', window)).context).toMatchObject({ generation: 2, revision: 1 })
})

it('rejects invalid windows and already-aborted calls before source reads', async () => {
  const batch = claim(trigger('a')), abort = new AbortController(); abort.abort(new Error('Stopped'))
  await expect(triage.prepareContext(batch.id, 1, 'a', { start: window.end, end: window.start })).rejects.toThrow()
  await expect(triage.prepareContext(batch.id, 1, 'a', window, abort.signal)).rejects.toThrow('Stopped')
  expect(reader).not.toHaveBeenCalled()
})

it.each(['settings', 'configuration', 'disabled', 'scope', 'paused', 'lease', 'immutable'] as const)(
  'refuses a new read when %s was already invalidated', async change => {
    const batch = claim(trigger('a'))
    if (change === 'settings') store.set(KV.settings.revision, 1)
    if (change === 'configuration' || change === 'disabled') settings = { ...settings, sources: { ...settings.sources,
      'generic-im': { enabled: change !== 'disabled', config: { revision: change === 'configuration' ? 'v2' : 'v1' } } } }
    if (change === 'scope') allowed = false
    if (change === 'paused') paused = true
    if (change === 'lease') now += 300_000
    if (change === 'immutable') store.triggers.save({ ...store.triggers.get('a')!, text: 'Edited immutable evidence' })
    await expect(triage.prepareContext(batch.id, 1, 'a', window)).rejects.toThrow()
    expect(reader).not.toHaveBeenCalled()
  })

it('does not expose saved context under changed settings or configuration', async () => {
  const batch = claim(trigger('a')); await triage.prepareContext(batch.id, 1, 'a', window)
  store.set(KV.settings.revision, 1); expect(() => triage.read(batch.id)).toThrow('stale')
  store.set(KV.settings.revision, 0)
  settings = { ...settings, sources: { ...settings.sources, 'generic-im': { enabled: true, config: { revision: 'v2' } } } }
  expect(() => triage.read(batch.id)).toThrow('configuration changed')
})

it('does not broaden result coverage to include fetched context messages', async () => {
  const batch = claim(trigger('a'))
  fetchPage = async request => ({ ...page(request), messages: [...page(request).messages, message('cancel', 'Cancel this request')] })
  await triage.prepareContext(batch.id, 1, 'a', window)
  const judgment = result(batch)
  expect(() => triage.submit(batch.id, 1, { ...judgment, items: [...judgment.items,
    { triggerId: 'cancel', bucket: 'none', reason: 'Cancellation evidence', matterIds: [] }] })).toThrow('Every input')
  expect(triage.submit(batch.id, 1, judgment).state).toBe('completed')
})


it('passes Source-native anchor content to the shadow collector', async () => {
  const input = trigger('a')
  input.text = '[Read-only presentation] wrapped message'
  input.meta.nativeText = 'native message'
  const batch = claim(input)
  await triage.prepareContext(batch.id, 1, input.id, window)
  expect(reader.mock.calls[0]![0].anchorText).toBe('native message')
})
