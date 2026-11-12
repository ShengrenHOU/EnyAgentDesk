import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { registerHttp, sourceHead } from '../src/app/http.ts'
import { attach, close, open } from '../src/app/lines.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { Store } from '../src/app/store.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { Ticket } from '../src/core/index.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'
import { testMachine } from './fixtures/deployment.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
it('reports the actual executor model source and server prepare shell', async () => {
  for (const codex of [undefined, { command: 'native-codex', model: 'codex-test-model' }]) {
    const call = serve({ machine: testMachine({ codex }), configured: () => false, masterId: 'master', health: {},
      executor: { activeCount: () => 0 }, store: { triageHandoffStatus: () => ({ held: 0, owners: [], contextComplete: false, state: 'empty' }), settings: () => SettingsSchema.parse({}), get: () => undefined, tickets: { open: () => [] } } })
    expect(await call('GET', 'state')).toMatchObject({ status: 200, body: { setup: { machine: {
      executor: { kind: codex ? 'codex' : 'dsh', model: codex?.model ?? null },
      prepareShell: process.platform === 'win32' ? 'powershell' : 'sh',
    } } } })
  }
})
it('reports the running package build and its activation time', async () => {
  const call = serve({
    store: { triageHandoffStatus: () => ({ held: 0, owners: [], contextComplete: false, state: 'empty' }), settings: () => SettingsSchema.parse({}), get: () => undefined, tickets: { open: () => [] } },
    machine: { promptMaxChars: { get: () => 100_000 }, admissionContextMaxPages: { get: () => 10 },
      admissionContextTimeoutMs: { get: () => 15_000 } },
    executor: { activeCount: () => 0 }, startedAt: '2026-11-09T01:00:00.000Z', health: {}, configured: () => false,
  })
  expect(await call('GET', 'state')).toMatchObject({ status: 200, body: { runtime: { startedAt: '2026-11-09T01:00:00.000Z',
    packageVersion: expect.any(String) } } })
})
it('reads the default-branch checkpoint under the monitored repository scope', () => {
  const stored = new Map<string, unknown>([
    ['github-repository:acme/widgets:github-branch-ci', { branch: 'main', head: 'abc', observedAt: '2026-11-09T00:05:00.000Z' }],
    ['github-branch-ci', { branch: 'legacy', head: 'old', observedAt: '2026-11-09T00:05:00.000Z' }],
  ])
  const host = (deployment: object) => ({ configured: () => true, deployment,
    store: { get: (key: string) => stored.get(key) } }) as unknown as HttpHost
  // A multi-repository deployment scopes every checkpoint by repository; a single-repository one keeps the plain key.
  expect(sourceHead(host({ repository: 'acme/widgets', githubRepositories: ['acme/widgets'] })))
    .toEqual({ repository: 'acme/widgets', branch: 'main', head: 'abc', observedAt: '2026-11-09T00:05:00.000Z' })
  expect(sourceHead(host({ repository: 'acme/widgets' })))
    .toEqual({ repository: 'acme/widgets', branch: 'legacy', head: 'old', observedAt: '2026-11-09T00:05:00.000Z' })
})
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('closes a Ticket with an optional panel reason and refuses an overlong one', async () => {
  const stops: { id: string; reason?: string }[] = []
  const call = serve({
    store: { tickets: { get: (id: string) => id === 't1' ? { id } : undefined } },
    engine: { stopTicket: (id: string, reason?: string) => { stops.push({ id, reason }) } },
  })
  expect(await call('POST', 'tickets/t1/stop', { reason: '  已过期  ' })).toEqual({ status: 200, body: { stopped: true } })
  // The pre-existing bodyless callers keep working, and `{}` still closes without a reason.
  expect(await call('POST', 'tickets/t1/stop')).toEqual({ status: 200, body: { stopped: true } })
  expect(await call('POST', 'tickets/t1/stop', {})).toEqual({ status: 200, body: { stopped: true } })
  expect(await call('POST', 'tickets/t1/stop', { reason: 'x'.repeat(501) })).toMatchObject({ status: 400 })
  expect(await call('POST', 'tickets/t1/stop', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
  // A blank optional reason is recorded as absent rather than as an empty reason line.
  expect(stops).toEqual([{ id: 't1', reason: '已过期' }, { id: 't1', reason: undefined }, { id: 't1', reason: undefined }])
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { triageHandoffStatus: () => ({ held: 0, owners: [], contextComplete: false, state: 'empty' }), settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})

it('serves bounded Line results from the panel search route', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'search-lines-http-'))
  const store = new Store(join(directory, 'state.sqlite'))
  try {
    const goal = open(store, { title: '跨阶段目标 Alpha', evidence: '没有成员工单的目标' }).line
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    const call = serve({ store, sources, sourceLinks: { entries: () => new Map<string, string>().entries() },
      links: () => () => ({ url: '', label: { zh: '', en: '' } }) })
    expect(await call('GET', `search?q=${encodeURIComponent('跨阶段目标 Alpha')}`)).toMatchObject({ status: 200,
      body: { lines: [{ id: goal.id, title: '跨阶段目标 Alpha', status: 'open', ticketCount: 0, openCount: 0 }],
        tickets: [], items: [], threads: [] } })
    expect(await call('GET', 'search?q=')).toMatchObject({ status: 200, body: { lines: [], tickets: [], items: [], threads: [] } })
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('serves the work lines and one line detail', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lines-http-'))
  const store = new Store(join(directory, 'state.sqlite'))
  try {
    const at = '2026-11-09T00:00:00.000Z'
    const ticket: Ticket = { id: 't1', title: '申昊战略入股：盘点', decisionId: 'd1',
      mandate: { strength: 'explicit', policyVersion: 'p1', basis: { via: 'addressed', addressed: 'direct' },
        actor: { source: 'workbench', id: 'owner' }, scope: '申昊战略入股' },
      channels: [], assignments: [], inputs: [], undelivered: [], createdAt: at, updatedAt: at,
      origin: { triggerId: 'tr1', triggerIds: ['tr1'] } }
    store.tickets.save(ticket)
    const { line } = open(store, { title: '申昊战略入股', evidence: '同一交易', at })
    attach(store, { lineId: line.id, ticketId: ticket.id, evidence: '盘点阶段', at })
    const call = serve({ store })
    expect(await call('GET', 'lines')).toMatchObject({ status: 200, body: { open: [{ id: line.id, title: '申昊战略入股',
      ticketCount: 1 }] } })
    expect(await call('GET', `lines/${line.id}`)).toMatchObject({ status: 200, body: {
      tickets: [{ title: '申昊战略入股：盘点' }], judgements: [{ action: 'opened' }, { action: 'attached' }] } })
    const to = open(store, { title: '独立的产品项目', evidence: '另一个具体目标', at }).line
    const path = `lines/${line.id}/membership`
    const change = { ticketId: ticket.id, targetLineId: to.id, evidence: '更正最初归属' }
    expect(await call('POST', path, { ...change, evidence: '' })).toMatchObject({ status: 400 })
    expect(await call('POST', path, change, { origin: 'https://example.com' })).toMatchObject({ status: 403 })
    expect(await call('POST', path, change)).toMatchObject({ status: 200, body: { changed: true } })
    expect(await call('POST', path, change)).toMatchObject({ status: 200, body: { changed: false } })
    expect(await call('GET', `lines/${to.id}`)).toMatchObject({ status: 200, body: {
      tickets: [{ id: ticket.id }], latestJudgement: { by: 'owner', fromLine: { id: line.id }, toLine: { id: to.id } } } })
    expect(await call('POST', path, { ...change, targetLineId: null })).toMatchObject({ status: 409 })
    expect(await call('POST', `lines/${to.id}/membership`, { ...change, targetLineId: null }))
      .toMatchObject({ status: 200, body: { changed: true } })
    close(store, { lineId: to.id, evidence: '结束空主线' })
    attach(store, { lineId: line.id, ticketId: ticket.id, evidence: '回归原目标' })
    expect(await call('POST', path, change)).toMatchObject({ status: 409 })
    expect(store.tickets.get(ticket.id)).toEqual(ticket)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
