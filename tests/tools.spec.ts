/** Session tool registration, role-scoped resource reads, and routing/settings tool contracts. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TICKET_STATES } from '../src/app/cards.ts'
import { builtInBase, builtInParts, defaultPrompts } from '../src/app/prompts.ts'
import { UserError } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { RESOURCES } from '../src/app/resources.ts'
import { createHash } from 'node:crypto'
import type { ProductionBatch } from '../src/app/production-triage.ts'
import { attach, open } from '../src/app/lines.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { IM_WORDS, NOTE_WORDS } from '../src/infra/text.ts'
import { workbenchKind } from '../src/sources/workbench.ts'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
const words = (count: number) => Array.from({ length: count }, () => 'word').join(' ')

it('continues stopped Codex responsibility with DSH while keeping the same ticket and work directory', async () => {
  const { ticket } = await h.acceptedTicket(feishu('901', 'Keep watching the current project'))
  h.runtime.engine.stopTicket(ticket.id)
  const stopped = h.runtime.store.tickets.get(ticket.id)!
  h.runtime.store.tickets.save({ ...stopped, execution: { ...stopped.execution!, executor: 'codex' } })
  const result = h.runtime.continueStopped(ticket.id, 'Continue with DSH. The owner has already sent the document; follow up only.')
  const updated = h.runtime.store.tickets.get(ticket.id)!
  expect(result).toEqual({ continued: true, ticketId: ticket.id, executor: 'dsh' })
  expect(updated.execution).toMatchObject({ directory: stopped.execution!.directory, executor: 'dsh',
    handoffs: [expect.objectContaining({ from: 'codex', to: 'dsh' })] })
  expect(updated.inputs.at(-1)).toMatchObject({ kind: 'text', text: expect.stringContaining('already sent') })
  expect(() => h.runtime.continueStopped(ticket.id, 'Repeat')).toThrow('stopped task')
})
const read = (resource: string, page: { offset?: number; limit?: number } = {}) =>
  h.runTool(h.runtime.masterId, 'orchestrator_read', { resource, ...page })

it('reads a historical blocked information receipt through the main resource without restarting its judgment', async () => {
  const { sessionId } = await h.acceptedTicket(feishu('worker-scope', 'An existing task'))
  const trigger = feishu('retained-receipt', 'Retained private source message\n'.repeat(180))
  h.runtime.store.triggers.save(trigger)
  const evidence = { provider: 'feishu', account: 'test-owner', conversation: 'test-chat', message: trigger.id,
    version: 'v1', partial: false, configuration: 'test-scope' }
  const access = vi.spyOn(h.runtime.sources, 'imEvidence').mockReturnValue(evidence)
  const { configuration: _configuration, ...identity } = evidence
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const batch: ProductionBatch = { id: 'historical-information', owner: 'retained-owner', ownerGeneration: 1, generation: 3,
    state: 'blocked', version: 'earlier-version', createdAt: trigger.at, updatedAt: trigger.at,
    window: { start: trigger.at, end: trigger.at }, settingsRevision: 1, settingsFingerprint: 'earlier-settings',
    policy: 'earlier-policy', prompt: 'earlier-prompt', contexts: {}, problem: 'Judgment has not completed',
    inputs: [{ triggerId: trigger.id, triggerFingerprint: hash(trigger), fingerprint: hash({ trigger, evidence }), identity, text: trigger.text, partial: false }] }
  h.runtime.store.set(`triage-production:${batch.id}`, batch)
  h.runtime.store.triggers.saveDisposition(trigger.id, { fanout: [], at: trigger.at,
    triage: { owner: batch.owner, generation: 1, heldAt: trigger.at, phase: 'production', batchId: batch.id } })
  const resource = `triage/receipt/${batch.id}/3`
  const catalog = await read('triage/receipts')
  expect(catalog).toMatchObject({ groups: [expect.objectContaining({ id: batch.id, read: resource, redacted: false })] })
  expect(JSON.parse(JSON.stringify(catalog))).toStrictEqual(catalog)
  expect((await read(resource, { limit: 8000 }) as { text: string }).text).toContain('Retained private source message')
  expect(h.runtime.store.get(`triage-production:${batch.id}`)).toEqual(batch)
  h.runtime.store.set(`triage-production:${batch.id}`, { ...batch, state: 'awaiting' })
  type Chunk = { text: string; next_offset: number | null }
  const completeBefore = await read(resource, { limit: 8000 }) as Chunk
  expect(completeBefore.next_offset).toBeNull()
  expect(completeBefore.text.length).toBeGreaterThan(4000)
  const first = await read(resource, { limit: 1000 }) as Chunk
  expect(first.next_offset).not.toBeNull()
  expect(h.runtime.store.get<ProductionBatch>(`triage-production:${batch.id}`)?.state).toBe('awaiting')
  h.runtime.store.set(`triage-production:${batch.id}`, { ...batch, state: 'completed',
    result: { model: 'test-model', items: [{ triggerId: trigger.id, kind: 'informational', reason: 'A new judgment',
      context: { revision: 1, hash: 'a'.repeat(64) }, matterIds: ['new-matter'] }],
    matters: [{ id: 'new-matter', title: 'New judgment metadata', reason: 'Updated detail '.repeat(300), triggerIds: [trigger.id] }] } })
  expect(h.runtime.store.get<ProductionBatch>(`triage-production:${batch.id}`)?.state).toBe('completed')
  let combined = first.text, offset = first.next_offset
  while (offset !== null) {
    const page = await read(resource, { offset, limit: 1000 }) as Chunk
    combined += page.text; offset = page.next_offset
  }
  expect(combined).toBe(completeBefore.text)
  const snapshot = JSON.parse(combined)
  expect(snapshot.state).toBe('awaiting')
  expect(snapshot.inputs[0].text).toBe(trigger.text)
  await expect(read(`triage/receipt/${batch.id}/2`)).rejects.toThrow('Receipt changed')
  await expect(h.runTool(sessionId, 'orchestrator_read', { resource })).rejects.toThrow('main Session')
  access.mockReturnValue(undefined)
  await expect(read(resource, { offset: 1, limit: 8000 })).rejects.toThrow('Source access changed')
  const revoked = await read(resource, { limit: 8000 }) as { text: string }
  expect(revoked.text).not.toContain('Retained private source message')
  expect(revoked.text).toContain('"redacted":true')
})

it('lets a reached worker page plugin context without adding provider-specific tools', async () => {
  const { trigger, sessionId } = await h.acceptedTicket(feishu('context', 'Read the original'))
  const fetch = vi.fn(async (_commands, _part, cursor) => cursor
    ? { messages: [], body: { page: 2 }, status: 'partial' }
    : { messages: [], body: { page: 1 }, next: 'revision/page+2', status: 'partial' })
  vi.spyOn(h.runtime.sources, 'threadContext').mockReturnValue({ messageId: trigger.id, read: fetch,
    images: () => [], image: async () => undefined })
  const worker = (resource: string, offset = 0) => h.runTool(sessionId, 'orchestrator_read', { resource, offset, limit: 8000 })
  const resource = `trigger/${trigger.id}/context`
  expect(await worker(`trigger/${trigger.id}`)).toMatchObject({ source_context_read: resource })
  const first = JSON.parse((await worker(resource) as { text: string }).text)
  expect(first).toMatchObject({ status: 'partial', body: { page: 1 }, next_resource: `${resource}/revision%2Fpage%2B2` })
  await worker(resource, 1)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(JSON.parse((await worker(first.next_resource) as { text: string }).text)).toMatchObject({ body: { page: 2 }, status: 'partial' })
  expect(fetch.mock.calls[1]?.slice(1)).toEqual(['thread', 'revision/page+2'])
})

it('checks trigger ownership before reading or serving cached plugin context', async () => {
  const first = await h.acceptedTicket(feishu('context-one', 'First work'))
  const other = await h.acceptedTicket(feishu('context-two', 'Unrelated work'))
  const fetch = vi.fn(async () => ({ messages: [], body: {} }))
  vi.spyOn(h.runtime.sources, 'threadContext').mockReturnValue({ messageId: other.trigger.id, read: fetch,
    images: () => [], image: async () => undefined })
  const resource = `trigger/${other.trigger.id}/context`
  await read(resource)
  fetch.mockClear()
  for (const offset of [0, 1]) {
    await expect(h.runTool(first.sessionId, 'orchestrator_read', { resource, offset })).rejects.toThrow(new UserError('notReached'))
  }
  expect(fetch).not.toHaveBeenCalled()
})

it('preserves unsupported and failed plugin reads instead of reporting empty context', async () => {
  const { trigger } = await h.acceptedTicket(feishu('context-error', 'Read evidence'))
  const context = vi.spyOn(h.runtime.sources, 'threadContext').mockReturnValue(undefined)
  const resource = `trigger/${trigger.id}/context`
  await expect(read(resource)).rejects.toThrow('does not provide original context')
  context.mockReturnValue({ messageId: trigger.id, read: async () => { throw new Error('Source unavailable') },
    images: () => [], image: async () => undefined })
  await expect(read(resource)).rejects.toThrow('Source unavailable')
  await expect(read(resource, { offset: 1 })).rejects.toThrow('from offset 0 first')
  await expect(read(`${resource}/`)).rejects.toThrow('Unknown context resource')
})

it('keeps Codex reports readable without pretending its native history is a DSH transcript', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', 'Review the current change'))
  h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, execution: { ...ticket.execution!, executor: 'codex' } })
  h.runtime.store.set(KV.codex.binding(ticket.id), { threadId: 'native-thread' })
  h.runtime.engine.report(ticket.id, { state: 'progress', summary: 'Persisted review evidence.' })
  vi.mocked(h.controller.inspect).mockClear()
  for (const suffix of ['transcript', 'message/0']) {
    await expect(read(`ticket/${ticket.id}/${suffix}`)).rejects.toThrow('Codex transcript browsing is not supported')
  }
  expect(h.controller.inspect).not.toHaveBeenCalled()
  expect(await read(`ticket/${ticket.id}/result`)).toMatchObject({ text: 'Persisted review evidence.' })
})

it('requires a ready report to list the accepted skills and records a checked method', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('skills', 'Write the weekly review from the fixed method'))
  const stored = h.runtime.store.tickets.get(ticket.id)!
  h.runtime.store.tickets.save({ ...stored, execution: { ...stored.execution!, requiredSkills: ['review-weekly-role-progress'] } })
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Draft done' }))
    .rejects.toThrow(/must list the required skills/)
  // A claimed path the worker did not read is refused before anything is recorded.
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Looking',
    skills: [{ name: 'review-weekly-role-progress', path: join(tmpdir(), 'no-such-skill.md') }] }))
    .rejects.toThrow('no readable file')
  expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.skills).toBeUndefined()
  const skill = join(tmpdir(), `dsh-skill-${process.pid}-${Date.now()}.md`)
  writeFileSync(skill, '# Weekly review\n\nUse the existing sections.\n')
  try {
    await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Draft done', method: 'review-weekly-role-progress',
      skills: [{ name: 'review-weekly-role-progress', path: skill, template: '2026-10-26 weekly review outline' }] })
  } finally { rmSync(skill, { force: true }) }
  const report = h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report!
  expect(report).toMatchObject({ state: 'ready', method: 'review-weekly-role-progress',
    skills: [{ name: 'review-weekly-role-progress', path: skill, template: '2026-10-26 weekly review outline',
      revision: expect.stringMatching(/^[0-9a-f]{12}$/) }] })
  const assignments = await read(`ticket/${ticket.id}/assignments`) as { items: { report: { method: string; skills: { name: string }[] } }[] }
  expect(assignments.items[0]!.report).toMatchObject({ method: 'review-weekly-role-progress',
    skills: [expect.objectContaining({ name: 'review-weekly-role-progress', path: skill })] })
  const assignmentId = h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.id
  const reportPage = await read(`ticket/${ticket.id}/report/${assignmentId}`) as { text: string }
  expect(reportPage.text).toContain('Method: review-weekly-role-progress')
  expect(reportPage.text).toContain('Skills:')
  expect(reportPage.text).toContain(skill)
})

it('reads work lines and the open Tickets on none of them', async () => {
  const { ticket: linked } = await h.acceptedTicket(feishu('line-1', '申昊战略入股：盘点文档'))
  const { ticket: unlinked } = await h.acceptedTicket(feishu('line-2', '另一个独立目标'))
  const { line } = open(h.runtime.store, { title: '申昊战略入股', evidence: '同一交易' })
  attach(h.runtime.store, { lineId: line.id, ticketId: linked.id, evidence: '盘点文档是同一交易的准备阶段' })
  const lines = await read('lines') as { counts: { open: number; closed: number; unlinked: number }
    open: { id: string; read: string; active?: { id: string } }[]; recent_unlinked: { ticket_id: string; read: string }[] }
  expect(lines.counts).toEqual({ open: 1, closed: 0, unlinked: 1 })
  expect(lines.open).toEqual([expect.objectContaining({ id: line.id, title: '申昊战略入股', read: `line/${line.id}`,
    active: expect.objectContaining({ id: linked.id }) })])
  expect(lines.recent_unlinked).toEqual([expect.objectContaining({ ticket_id: unlinked.id, read: `ticket/${unlinked.id}` })])
  expect(await read(`line/${line.id}`)).toMatchObject({ id: line.id, tickets: [expect.objectContaining({ id: linked.id })] })
  await expect(read('line/unknown')).rejects.toThrow('Unknown line')
})

it('reads the lists, a ticket, a decision, the settings, the prompts and the models as resources', async () => {
  const { ticket, trigger } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.acceptedTicket(feishu('2', '@bot 再修一个'))
  const tickets = await read('tickets', { limit: 1 })
  expect(tickets).toEqual({ items: [expect.objectContaining({ ticket_id: expect.any(String), state: 'working' })], next_offset: 1 })
  expect(await read('tickets', { offset: 1 })).toMatchObject({ items: [expect.objectContaining({ ticket_id: ticket.id })], next_offset: null })
  const triggers = await read('triggers') as { items: { trigger_id: string }[] }
  expect(triggers.items.map(item => item.trigger_id)).toEqual([expect.any(String), trigger.id])
  expect(await read('threads')).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ tickets: [ticket.id] })]) })
  const decisions = await read('decisions') as { items: { decision_id: string; read: string }[] }
  const accepted = expect.objectContaining({ kind: 'accept', ticket_id: ticket.id, trigger_ids: [trigger.id], read: expect.stringMatching(/^decision\//) })
  expect(decisions.items).toContainEqual(accepted)
  expect(await read(decisions.items.at(-1)!.read)).toMatchObject({ kind: 'accept', ticket_id: ticket.id, mandate: { strength: 'explicit' } })
  expect(await read(`ticket/${ticket.id}`)).toMatchObject({ ticket_id: ticket.id, state: 'working', directory: ticket.execution!.directory,
    trigger_id: trigger.id, assignments: { items: [expect.objectContaining({ state: 'running' })] }, assignment: `ticket/${ticket.id}/assignment` })
  // The settings name each block's revision and hold the small blocks; a block reads whole by the name a save takes.
  const settings = await read('settings')
  expect(settings).toMatchObject({ eval: { value: { mode: 'auto' } }, policy: { revision: expect.any(Number), allowed: { feishu: 1, github: 1 }, read: 'settings/policy' },
    pause: { value: { paused: false } }, sources: expect.arrayContaining([expect.objectContaining({ id: 'github', read: 'settings/source:github' })]) })
  expect(JSON.stringify(settings)).not.toContain('ou_alice')
  for (const block of ['policy', 'eval', 'executor', 'pause', 'source:github']) {
    const page = await read(`settings/${block}`) as { text: string }
    expect(JSON.parse(page.text)).toEqual({ block, revision: h.runtime.store.blockRevision(block as 'policy'), value: h.runtime.settings.block(block).value })
  }
  expect(JSON.parse((await read('settings/policy') as { text: string }).text).value.sources.feishu.allowed).toEqual([{ id: 'ou_alice', name: 'Alice' }])
  await expect(read('settings/source:retired')).rejects.toThrow('Unknown settings block')
  const skills = { built_in: ['dsh-superagent-feishu', 'dsh-superagent-github'], team: [] }
  expect(await read('prompts')).toMatchObject({ revision: 0, read: 'prompts/0', skills, items: [expect.objectContaining({ revision: 0 })], next_offset: null })
  const models = [{ id: 'm1', name: 'One' }, { id: 'm2', name: 'Two' }]
  const catalog = { default: { provider: 'p', model: 'm1' }, groups: [{ id: 'p', name: 'Provider', models }], failures: [] }
  Object.assign(h.controller, { modelCatalog: vi.fn(async () => catalog) })
  expect(await read('models')).toMatchObject({ providers: [{ id: 'p', count: 2, read: 'models/p' }], roles: expect.any(Object) })
  expect(await read('models/p', { limit: 1 })).toEqual({ items: [models[0]], next_offset: 1 })
  await expect(read('ticket')).rejects.toThrow('Unknown context resource')
  // A list page holds at most 50 items, the prompt history too.
  const config = h.runtime.prompts.current().config
  for (let revision = 0; revision < 51; revision++) h.runtime.prompts.save({ ...config, scope: `Scope ${revision}.` }, revision, 'panel')
  expect(await read('prompts', { limit: 8000 })).toMatchObject({ items: expect.objectContaining({ length: 50 }), next_offset: 50 })
})

/** Register the native workbench and give it an owner, as its plugin does before the conversation resource reads. */
const configureWorkbench = () => {
  h.runtime.sources.register(workbenchKind)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, workbench: { enabled: true, config: { ownerId: 'local-owner' } } } })
}
const ownerMessage = (seq: number, text: string, at: number) => ({ type: 'user/message', seq, time: at,
  data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })

it('serves the owner conversation only while the native workbench is enabled with an owner', async () => {
  await expect(read('conversation')).rejects.toThrow('native workbench Source')
  configureWorkbench()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, workbench: { enabled: false, config: { ownerId: 'local-owner' } } } })
  await expect(read('conversation')).rejects.toThrow('native workbench Source')
})

it('lets a worker read the owner\'s last 24 hours newest first, without another ticket\'s private data', async () => {
  const first = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const second = await h.acceptedTicket(feishu('2', '@bot 再修一个'))
  configureWorkbench()
  const now = Date.now()
  vi.mocked(h.controller.inspect).mockResolvedValue({ meta: { id: h.runtime.masterId }, events: [
    ownerMessage(0, 'Old activation idea', now - 30 * 3_600_000),
    ownerMessage(1, 'The activation page is confusing.', now - 2 * 3_600_000),
    { type: 'assistant/message', seq: 2, time: now - 3_600_000, data: { message: { content: [{ type: 'text', text: 'Proposed workbench plan' }] } } },
    { type: 'user/message', seq: 3, time: now - 1_800_000, data: { content: [{ type: 'text', text: 'Automated relay' }], source: { kind: 'system-prompt' } } },
  ] } as never)
  const page = await h.runTool(first.sessionId, 'orchestrator_read', { resource: 'conversation' }) as
    { session_id: string; items: { seq: number; role: string; text: string }[]; attachments: unknown[]; next_offset: number | null }
  expect(page).toMatchObject({ session_id: h.runtime.masterId, through_seq: 3, partial: false, next_offset: null, attachments: [],
    items: [{ seq: 2, role: 'assistant', text: 'Proposed workbench plan' },
      { seq: 1, role: 'user', text: 'The activation page is confusing.' }] })
  const shown = JSON.stringify(page)
  for (const id of [first.ticket.id, second.ticket.id, first.ticket.decisionId!]) expect(shown).not.toContain(id)
})

it('pages the owner conversation newest first, 20 by default and 50 at most', async () => {
  configureWorkbench()
  const now = Date.now()
  const events = Array.from({ length: 60 }, (_, index) => ownerMessage(index, `Message ${index}`, now - (60 - index) * 1000))
  vi.mocked(h.controller.inspect).mockResolvedValue({ meta: { id: h.runtime.masterId }, events } as never)
  const first = await read('conversation') as { items: { text: string }[]; next_offset: number | null }
  expect([first.items.length, first.items[0]?.text, first.next_offset]).toEqual([20, 'Message 59', 20])
  expect(await read('conversation', { offset: 50 })).toMatchObject({ items: { length: 10 }, next_offset: null })
  expect(await read('conversation', { limit: 80 })).toMatchObject({ items: { length: 50 }, next_offset: 50 })
})

it('lists in prompts the built-in parts whose text changed since the team overrode them, and the built-in parts in prompts/defaults', async () => {
  const read = (resource: string, offset = 0) => h.runTool(h.runtime.masterId, 'orchestrator_read', { resource, offset, limit: 8000 })
  expect(await read('prompts')).not.toHaveProperty('default_changed')
  // An override edited from the built-in text of an earlier version.
  h.runtime.prompts.save({ ...defaultPrompts(), overrides: { 'runtime/dispatch': { text: '## dispatch\nOurs.', base: 'earlier' } } }, 0, 'panel')
  expect(await read('prompts')).toMatchObject({ default_changed: ['runtime/dispatch'] })
  // A text page at a time, which the whole text joins.
  let text = '', offset: number | null = 0
  while (offset !== null) {
    const page = await read('prompts/defaults', offset) as { text: string; next_offset: number | null }
    text += page.text; offset = page.next_offset
  }
  const defaults = JSON.parse(text) as { parts: Record<string, string> }
  expect(defaults.parts).toEqual(Object.fromEntries(Object.entries(builtInParts()).map(([key, part]) => [key, part.text])))
})

it('saves with the prompt save tool an override without its base, refuses a part no version has, and drops a removed one read back', async () => {
  const save = (overrides: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_prompts_save',
    { config: { ...defaultPrompts(), overrides }, baseRevision: h.runtime.prompts.current().revision })
  await expect(save({ constructor: { text: 'x' } })).rejects.toThrow(new UserError('unknownPromptPart', { part: 'constructor' }))
  await save({ 'runtime/dispatch': { text: '## dispatch\nOurs.' } })
  const dispatch = { text: '## dispatch\nOurs.', base: builtInBase(builtInParts()['runtime/dispatch'].text) }
  expect(h.runtime.prompts.current().config.overrides).toEqual({ 'runtime/dispatch': dispatch })
  // The saved version overrides a part this version no longer has: saving back the configuration as read drops it.
  const { revision } = h.runtime.prompts.current(), read = { ...defaultPrompts(), overrides: { 'runtime/dispatch': dispatch,
    'runtime/retired': { text: 'Old.', base: 'b' } } }
  h.runtime.store.set(KV.prompts.version(revision + 1), { revision: revision + 1, previousRevision: revision, savedAt: '', source: 'panel', config: read })
  h.runtime.store.set(KV.prompts.revision, revision + 1)
  await h.runTool(h.runtime.masterId, 'orchestrator_prompts_save', { config: read, baseRevision: revision + 1 })
  expect(h.runtime.prompts.current().config.overrides).toEqual({ 'runtime/dispatch': dispatch })
  // The tool describes the overrides once, in its schema.
  const tool = h.tools.get(h.runtime.masterId)!.get('orchestrator_prompts_save') as unknown as { description: string }
  expect(tool.description).not.toContain('overrides')
})

it('keeps the main Session\'s resources from an Executor Session, which lists only its own', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  for (const resource of ['tickets', 'triggers', 'threads', 'decisions', 'lines', 'settings', 'prompts', 'models']) {
    await expect(h.runTool(sessionId, 'orchestrator_read', { resource })).rejects.toThrow('belongs to the main Session')
  }
  await expect(h.runTool(sessionId, 'orchestrator_read', { resource: 'line/any' })).rejects.toThrow('belongs to the main Session')
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: `ticket/${ticket.id}` })).toMatchObject({ ticket_id: ticket.id })
  type Registered = { description: string; parameters: { properties: { resource: { description: string } } } }
  const registered = h.tools.get(sessionId)!.get('orchestrator_read') as unknown as Registered
  const offered = registered.description + registered.parameters.properties.resource.description
  for (const { name, executor } of RESOURCES) expect(offered.includes(`${name}:`), name).toBe(!!executor)
  expect(offered).not.toMatch(/preview/i)
})

it('answers every routing tool in one shape: the decision it recorded, why, and the ticket card', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const card = expect.objectContaining({ ticket_id: ticket.id })
  const run = (name: string, args: unknown) => h.runTool(h.runtime.masterId, name, args)
  const route = async (item: Record<string, unknown>) => ((await run('orchestrator_route', { decisions: [item] })).results as unknown[])[0]
  const other = feishu('3', '@bot 顺便看看这个')
  h.runtime.receive(other); await h.runtime.idle()
  expect(await route({ kind: 'attach', ticket_id: ticket.id, trigger_id: other.id })).toEqual({ trigger_id: other.id, kind: 'attach',
    reason: expect.any(String), ticket: card })
  const status = await run('orchestrator_ticket_request_status', { ticket_id: ticket.id })
  expect(status).toEqual({ reason: 'The worker is not waiting; nothing was sent', ticket: card })
  await h.runTool(sessionId, 'orchestrator_report', { state: 'failed', summary: 'The build broke.' })
  expect(await run('orchestrator_ticket_retry', { ticket_id: ticket.id })).toEqual({ reason: 'Started a new assignment', ticket: card })
  const chatter = feishu('4', '@bot 谢谢')
  h.runtime.receive(chatter); await h.runtime.idle()
  expect(await route({ kind: 'ignore', trigger_id: chatter.id, reason: 'thanks' })).toEqual({ trigger_id: chatter.id, kind: 'ignore', decision: 'ignore',
    reason: 'thanks' })
  // A stop needs the person's stop message, which the gate judges; the ticket keeps the reason given.
  await expect(run('orchestrator_route', { decisions: [{ kind: 'stop', ticket_id: ticket.id, reason: 'Not needed after all' }] })).rejects.toThrow()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  const request = feishu('5', '@bot 不用修了')
  h.runtime.receive(request); await h.runtime.idle()
  const stopped = await route({ kind: 'stop', ticket_id: ticket.id, trigger_id: request.id, reason: 'Not needed after all' }) as { ticket: { state: string } }
  const ended = expect.objectContaining({ by: 'human', reason: 'Not needed after all' })
  expect(stopped).toEqual({ trigger_id: request.id, kind: 'stop', decision: 'stop', reason: 'Not needed after all',
    ticket: expect.objectContaining({ ticket_id: ticket.id, state: 'stopped', ended }) })
  expect(TICKET_STATES).toContain(stopped.ticket.state)
})

it('carries required skills from an accept into the ticket execution', async () => {
  const request = feishu('skills-route', '@bot 写一份周评')
  h.runtime.receive(request); await h.runtime.idle()
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: request.id,
    title: 'Weekly review', worktree_name: 'weekly-review', acknowledgement: '收到。', required_skills: [' review-weekly-role-progress '] }] })
  const accepted = results as { ticket?: { ticket_id: string } }[]
  // A padded name is trimmed before it is stored, so a report that trims its own names can satisfy it.
  expect(h.runtime.store.tickets.get(accepted[0]!.ticket!.ticket_id)?.execution?.requiredSkills).toEqual(['review-weekly-role-progress'])
})

it('refuses only the routing item whose required skills are invalid', async () => {
  const bad = feishu('bad-skill', '@bot 写一份周评'), good = feishu('good-ignore', '@bot 谢谢')
  h.runtime.receive(bad); h.runtime.receive(good); await h.runtime.idle()
  const route = (required_skills: string[]) => h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { kind: 'accept', trigger_id: bad.id, title: 'Weekly review', worktree_name: 'weekly-review', acknowledgement: '收到。', required_skills },
    { kind: 'ignore', trigger_id: good.id, reason: 'Thanks only.' }] }) as Promise<{ results: Record<string, unknown>[] }>
  const invalidName = await route(['Not A Skill'])
  expect(invalidName.results[0]).toMatchObject({ trigger_id: bad.id, kind: 'accept', refused: expect.stringContaining('required_skills') })
  expect(invalidName.results[1]).toEqual({ trigger_id: good.id, kind: 'ignore', decision: 'ignore', reason: 'Thanks only.' })
  // The count limit is checked per item too, so the rest of the call still runs.
  const tooMany = await route(Array.from({ length: 11 }, (_, index) => `skill-${index}`))
  expect(tooMany.results[0]).toMatchObject({ trigger_id: bad.id, kind: 'accept', refused: expect.stringContaining('required_skills') })
})

it('routes several triggers in one call, in order, and answers a refused or failed item without undoing the others', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const thanks = feishu('2', '@bot 谢谢'), request = feishu('3', '@bot 另一个问题'), other = feishu('4', '@bot 顺便看看这个'), more = feishu('6', '@bot 还有这个')
  for (const trigger of [thanks, request, other, more]) h.runtime.receive(trigger)
  await h.runtime.idle()
  // One attach fails unexpectedly, as a busy database would.
  const attach = h.runtime.engine.attach.bind(h.runtime.engine)
  vi.spyOn(h.runtime.engine, 'attach').mockImplementation((ticketId, triggerId, note) => {
    if (triggerId === more.id) throw new Error('database is locked')
    return attach(ticketId, triggerId, note)
  })
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { kind: 'ignore', trigger_id: thanks.id, reason: 'Thanks only.' },
    // A stop without its ticket is refused, alone.
    { kind: 'stop', trigger_id: request.id },
    { kind: 'accept', trigger_id: request.id, title: 'Other', worktree_name: 'fix-other', acknowledgement: '收到。' },
    { kind: 'attach', trigger_id: other.id, ticket_id: 'no-such-ticket' },
    { kind: 'attach', trigger_id: more.id, ticket_id: ticket.id },
  ] }) as { results: Record<string, unknown>[] }
  expect(results).toEqual([
    { trigger_id: thanks.id, kind: 'ignore', decision: 'ignore', reason: 'Thanks only.' },
    { trigger_id: request.id, kind: 'stop', refused: 'stop needs ticket_id' },
    expect.objectContaining({ trigger_id: request.id, kind: 'accept', decision: 'accept', ticket: expect.objectContaining({ title: 'Other' }) }),
    { trigger_id: other.id, kind: 'attach', refused: 'Unknown ticket' },
    // An unexpected failure recorded nothing, which the item may be sent again for.
    { trigger_id: more.id, kind: 'attach', refused: 'Not recorded: database is locked; retry this item' },
  ])
  expect(h.runtime.store.tickets.list()).toHaveLength(2)
})

it('refuses alone an item that lacks a field its kind needs or breaks a field\'s limit, naming the field, and ignores unused fields', async () => {
  const triggers = ['2', '3', '4', '5', '6'].map(id => feishu(id, `@bot 请求 ${id}`))
  for (const trigger of triggers) h.runtime.receive(trigger)
  await h.runtime.idle()
  const [a, b, c, d, e] = triggers.map(trigger => trigger.id) as [string, string, string, string, string]
  const accept = { kind: 'accept', title: 'Fix', acknowledgement: '收到。' }
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { ...accept, trigger_id: a },
    { ...accept, trigger_id: b, worktree_name: 'one-two-three-four-five' },
    { ...accept, trigger_id: c, worktree_name: 'fix-c', note: words(NOTE_WORDS + 1) },
    { ...accept, trigger_id: d, worktree_name: 'fix-d', title: '' },
    // Fields of another kind, null or not, are left unread.
    { kind: 'ignore', trigger_id: e, reason: 'chat', ticket_id: null, title: null, note: null },
  ] }) as { results: Record<string, unknown>[] }
  expect(results).toEqual([
    { trigger_id: a, kind: 'accept', refused: 'accept needs worktree_name' },
    { trigger_id: b, kind: 'accept', refused: expect.stringMatching(/^worktree_name: /) },
    { trigger_id: c, kind: 'accept', refused: expect.stringMatching(new RegExp(`^note: .*${NOTE_WORDS} words`)) },
    { trigger_id: d, kind: 'accept', refused: 'accept needs title' },
    { trigger_id: e, kind: 'ignore', decision: 'ignore', reason: 'chat' },
  ])
  expect(h.runtime.store.tickets.list()).toEqual([])
})

it('decides a candidate\'s batch with its card\'s trigger: a second accept keeps the first, and no other decision contradicts it', async () => {
  await h.runtime.settings.pause(true, 'panel')
  const first = feishu('1', '@bot 首页的标题'), second = feishu('2', '@bot 改成“浏览网页”', { root_id: 'om_1' })
  h.runtime.receive(first); h.runtime.receive(second)
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.idle()
  const accept = { kind: 'accept', worktree_name: 'retitle', acknowledgement: '收到。' }
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { ...accept, trigger_id: first.id, title: 'Retitle' },
    { ...accept, trigger_id: second.id, title: 'Another title' },
    { kind: 'ignore', trigger_id: second.id, reason: 'chat' },
  ] }) as { results: { ticket?: { ticket_id: string } }[] }
  const ticketId = results[0]!.ticket!.ticket_id
  expect(results).toEqual([
    expect.objectContaining({ trigger_id: first.id, decision: 'accept' }),
    expect.objectContaining({ trigger_id: second.id, decision: 'accept', reason: `Already accepted as ${ticketId}; title and acknowledgement unchanged` }),
    { trigger_id: second.id, kind: 'ignore', refused: `Decided in this call with ${first.id}, whose Decision took its batch` },
  ])
  expect(h.runtime.store.tickets.get(ticketId)!.title).toBe('Retitle')
})

it('states each routing field\'s limit in its description, which the schema leaves to the item\'s check', () => {
  type Schema = { parameters: { properties: { decisions: { items: { properties: Record<string, { description?: string }> } } } } }
  const fields = (h.tools.get(h.runtime.masterId)!.get('orchestrator_route') as unknown as Schema).parameters.properties.decisions.items.properties
  const limits: Record<string, string[]> = { title: ['200 characters'], worktree_name: ['kebab-case', '32 characters'],
    acknowledgement: [`${IM_WORDS} words`], note: [`${NOTE_WORDS} words`, 'Never add implementation instructions'], reason: ['500 characters'] }
  for (const [field, phrases] of Object.entries(limits)) for (const phrase of phrases) expect(fields[field]!.description, field).toContain(phrase)
})

it('stops one follow-up for each ticket it reached, in one call', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const two = await h.acceptedTicket(feishu('3', '@bot 另一件事'))
  // The second ticket follows the first's thread too, so a person's stop there reaches both.
  h.runtime.engine.bindThread(two.ticket.id, { source: 'feishu', id: `${CHAT}:om_1` }, false)
  const stop = feishu('7', '都先停一下', { mentions: [], root_id: 'om_1' })
  h.runtime.receive(stop); await h.runtime.idle()
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { kind: 'stop', trigger_id: stop.id, ticket_id: one.ticket.id }, { kind: 'stop', trigger_id: stop.id, ticket_id: two.ticket.id }] }) as
    { results: Record<string, unknown>[] }
  expect(results.map(result => result.decision)).toEqual(['stop', 'stop'])
  expect([one, two].map(item => h.runtime.store.tickets.get(item.ticket.id)!.ended?.outcome)).toEqual(['stopped', 'stopped'])
})

it('ignores a proactive candidate from its card beside other decisions, marked so, and leaves accepting one to an assessment', async () => {
  const chat = feishu('2', '中午吃什么', { mentions: [] }), thanks = feishu('3', '@bot 谢谢'), proposal = feishu('4', '把标题改短一点', { mentions: [] })
  for (const trigger of [chat, thanks, proposal]) h.runtime.receive(trigger)
  await h.runtime.pump(); await h.runtime.idle()
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { kind: 'ignore', trigger_id: chat.id, reason: 'Lunch chat.' },
    { kind: 'ignore', trigger_id: thanks.id, reason: 'Thanks only.' },
    { kind: 'accept', trigger_id: proposal.id, title: 'Shorter title', worktree_name: 'short-title', acknowledgement: '收到。' },
  ] }) as { results: Record<string, unknown>[] }
  expect(results).toEqual([
    { trigger_id: chat.id, kind: 'ignore', decision: 'ignore', reason: 'Ignored from its card, without a rule assessment; Lunch chat.' },
    { trigger_id: thanks.id, kind: 'ignore', decision: 'ignore', reason: 'Thanks only.' },
    { trigger_id: proposal.id, kind: 'accept', refused: expect.stringContaining('assess proactive candidates with orchestrator_eval') },
  ])
})

it('returns where a reply stands: sent, or dropped when its conversation can no longer receive it', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.' })
  const reply = (text: string) => h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text })
  expect(await reply('修好了。')).toEqual({ status: 'sent' })
  vi.mocked(Commands.prototype.lark).mockRejectedValue(new CliError('the message was withdrawn', 230011))
  expect(await reply('修好了，请看 PR。')).toEqual({ status: 'dropped' })
})

it('checks an acknowledgement against the IM word limit, not a character count', async () => {
  const trigger = feishu('1', '@bot 修一下回归')
  h.runtime.receive(trigger); await h.runtime.idle()
  const accept = (acknowledgement: string) => h.route({ kind: 'accept', trigger_id: trigger.id, title: 'Fix', worktree_name: 'fix-regression', acknowledgement })
  await expect(accept(words(IM_WORDS + 1))).rejects.toThrow(`at most ${IM_WORDS} words`)
  expect(await accept(words(IM_WORDS))).toMatchObject({ decision: 'accept', ticket: { title: 'Fix' } })
})

it('saves a settings block by name, a Source\'s block with the Source\'s id', async () => {
  const save = (args: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_settings_save', args)
  const github = { config: h.runtime.store.settings().sources.github!.config, revision: h.runtime.store.blockRevision('source:github') }
  const off = { enabled: false, config: github.config }
  await expect(save({ block: 'source', value: off, revision: github.revision })).rejects.toThrow('source names the Source')
  await expect(save({ block: 'source:github', value: off, revision: github.revision })).rejects.toThrow()
  expect(await save({ block: 'source', source: 'github', value: off, revision: github.revision })).toMatchObject({ saved: true })
  expect(h.runtime.store.settings().sources.github?.enabled).toBe(false)
  expect(await save({ block: 'pause', value: { paused: true }, revision: 0 })).toEqual({ paused: true })
})

it('previews a prompt configuration without saving it, and saves one only against the revision it edits', async () => {
  const save = (args: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_prompts_save', args)
  const config = { ...h.runtime.prompts.current().config, scope: 'Finish what was asked.' }
  const preview = await save({ config, preview: true }) as { previews: { role: string; read: string }[] }
  expect(preview.previews.map(item => item.role)).toEqual(['orchestrator', 'worker'])
  let text = '', offset: number | null = 0
  while (offset !== null) {
    const page = await read(preview.previews[1]!.read, { offset, limit: 8000 }) as { text: string; next_offset: number | null }
    text += page.text; offset = page.next_offset
  }
  expect(text).toContain('## Ticket scope\nFinish what was asked.')
  expect(h.runtime.prompts.current().revision).toBe(0)
  await expect(save({ config })).rejects.toThrow('baseRevision')
  expect(await save({ config, baseRevision: 0 })).toMatchObject({ revision: 1 })
})

it('releases the tools it registered for a Session once its agent is disposed, and leaves the other Sessions\' tools', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const worker = `worker-${ticket.id}`
  expect(h.tools.get(worker)!.size).toBeGreaterThan(0)
  h.ctx.emit('agent/disposed', { agent: h.agents.get(worker) } as never)
  expect([h.tools.get(worker)!.size, h.tools.get(h.runtime.masterId)!.size > 0]).toEqual([0, true])
  // Releasing again, as at shutdown, finds nothing left of it.
  h.ctx.emit('agent/disposed', { agent: h.agents.get(worker) } as never)
  expect(h.tools.get(worker)!.size).toBe(0)
})

it('reads a thread by the key cards show: its label, tickets, latest decisions and triggers, newest first, also for its own worker', async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const key = `feishu:${CHAT}:om_1`
  const threads = await read('threads') as { items: { thread: string; label: string; read: string }[] }
  expect(threads.items[0]).toMatchObject({ thread: key, label: '@bot 修一下回归', read: `thread/${key}` })
  const thread = await read(`thread/${key}`)
  expect(thread).toMatchObject({ thread: key, label: '@bot 修一下回归', tickets: [expect.objectContaining({ ticket_id: ticket.id })],
    decisions: [expect.objectContaining({ kind: 'accept', ticket_id: ticket.id })], items: [expect.objectContaining({ trigger_id: trigger.id, read: `trigger/${trigger.id}` })],
    next_offset: null })
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: `thread/${key}` })).toMatchObject({ thread: key })
  const elsewhere = feishu('5', '@bot 别的事', { chat_id: 'oc_other' })
  h.runtime.store.triggers.save(elsewhere)
  h.runtime.store.threads.save({ key: `feishu:oc_other:om_5`, ref: { source: 'feishu', id: 'oc_other:om_5' }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {} })
  await expect(h.runTool(sessionId, 'orchestrator_read', { resource: 'thread/feishu:oc_other:om_5' })).rejects.toThrow('Unknown or inaccessible thread')
})

it('reads a ticket with the ids it is tied to, its reports by assignment, and its assignments and inputs a page at a time, each by the name its line gives or by its id', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const stored = h.runtime.store.tickets.get(ticket.id)!
  const at = (n: number) => `2026-10-05T00:${String(n).padStart(2, '0')}:00.000Z`
  const report = (n: number) => ({ state: 'progress' as const, summary: `Report ${n}: ${'checked the config and the build. '.repeat(46)}`.slice(0, 1500), at: at(n) })
  const assignments = [1, 2, 3, 4, 5, 6, 7].map(n => ({ ...stored.assignments[0]!, id: `a${n}`, state: n < 7 ? 'ended' as const : 'running' as const, report: report(n), createdAt: at(n) }))
  const inputs = Array.from({ length: 24 }, (_, n) => n === 23 ? { id: 'text:long', kind: 'text' as const, text: `Note: ${'check the margin on mobile as well. '.repeat(4)}`, at: at(n) }
    : n % 2 ? { id: `text:${n}`, kind: 'text' as const, text: `Note ${n}: check the margin.`, at: at(n) }
    : { id: `trigger:${n}`, kind: 'trigger' as const, triggerId: `trigger-${n}`, at: at(n) })
  h.runtime.store.tickets.save({ ...stored, assignments, inputs: [...stored.inputs, ...inputs] })
  type Page = { items: { read?: string; report: { read: string } }[]; next_resource?: string; next_offset?: number }
  const details = await read(`ticket/${ticket.id}`) as { inputs: Page; assignments: Page }
  expect(details).toMatchObject({ trigger_id: ticket.origin.triggerId, decision_id: ticket.decisionId, threads: [{ thread: `feishu:${CHAT}:om_1` }],
    inputs: { next_resource: `ticket/${ticket.id}/inputs`, next_offset: 10 }, assignments: { next_resource: `ticket/${ticket.id}/assignments`, next_offset: 3 } })
  expect([details.inputs.items.length, details.assignments.items.length]).toEqual([10, 3])
  // The earlier assignments read on, so a worker reaches every report it continues from.
  const earlier = await read(details.assignments.next_resource!, { offset: details.assignments.next_offset! }) as Page
  expect([earlier.items.map(item => (item as { id?: string }).id), earlier.next_offset]).toEqual([['a4', 'a3', 'a2'], 6])
  expect(await read(details.assignments.next_resource!, { offset: 6 })).toEqual({ next_offset: null,
    items: [expect.objectContaining({ id: 'a1', report: expect.objectContaining({ read: `ticket/${ticket.id}/report/a1` }) })] })
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: `ticket/${ticket.id}/report/a1` })).toMatchObject({ text: report(1).summary })
  expect(JSON.stringify(details).length).toBeLessThan(3000)
  const page = await read(details.inputs.items[0]!.read!) as { text: string }
  expect(page.text).toContain('check the margin on mobile as well.')
  // An Input also reads by the id it has on the ticket.
  expect(await read(`ticket/${ticket.id}/input/text:long`)).toMatchObject({ text: page.text })
  expect(await read(`ticket/${ticket.id}/inputs`, { offset: 20 })).toMatchObject({ items: expect.objectContaining({ length: 4 }), next_offset: null })
  expect(await read(details.assignments.items[0]!.report.read)).toMatchObject({ text: report(7).summary.slice(0, 4000) })
  vi.mocked(h.controller.inspect).mockResolvedValueOnce({ events: [{ type: 'assistant/message', data: { message: { role: 'assistant',
    content: [{ type: 'text', text: `I fixed the margin. ${'Details. '.repeat(20)}` }] } } }] } as never)
  const transcript = JSON.parse((await read(`ticket/${ticket.id}/transcript`) as { text: string }).text) as { preview: string; read: string }
  expect(transcript).toMatchObject({ preview: expect.stringMatching(/^I fixed the margin\./), read: `ticket/${ticket.id}/message/0` })
  expect(transcript.preview.length).toBeLessThanOrEqual(80)
})

it('reads the current DSH transcript after a transfer with the old Codex binding retained', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot summarize this'))
  const current = h.runtime.store.tickets.get(ticket.id)!
  h.runtime.store.tickets.save({ ...current, execution: { ...current.execution!, executor: 'dsh' } })
  h.runtime.store.set(KV.codex.binding(ticket.id), { threadId: 'retained-codex-thread', assignmentId: current.assignments[0]!.id })
  vi.mocked(h.controller.inspect).mockResolvedValueOnce({ events: [{ type: 'assistant/message', data: { message: { role: 'assistant',
    content: [{ type: 'text', text: 'Current DSH result' }] } } }] } as never)
  const transcript = await read(`ticket/${ticket.id}/transcript`) as { text: string }
  expect(transcript.text).toContain('Current DSH result')
  expect(h.runtime.store.get(KV.codex.binding(ticket.id))?.threadId).toBe('retained-codex-thread')
})

it('reads a trigger once with the message it replies to and the messages around it on its thread, without the CI runs', async () => {
  const at = (minute: number) => `2026-10-06T00:0${minute}:00.000Z`
  const message = (id: string, minute: number, overrides: Record<string, unknown> = {}) => ({ ...feishu(id, `message ${id}`, { root_id: 'om_root', ...overrides }), at: at(minute) })
  const ci = (id: string, minute: number) => ({ ...message(id, minute), source: 'github', human: false, text: '{"check":"build"}', meta: { ci: true } })
  const asked = message('asked', 1), replying = message('reply', 3, { parent_id: 'om_asked' })
  for (const item of [message('root', 0, { root_id: undefined }), asked, ci('ci-1', 2), replying, ci('ci-2', 4), message('later', 5)]) h.runtime.store.triggers.save(item)
  const page = await read(`trigger/${replying.id}`)
  expect(page).toMatchObject({ trigger_id: replying.id, replied_to: { trigger_id: asked.id, read: `trigger/${asked.id}` },
    around: { before: { trigger_id: asked.id }, after: { trigger_id: feishu('later', '').id } }, text: 'message reply' })
  // The page holds the text once, and no pointer to itself.
  expect(page).not.toHaveProperty('preview')
  expect(page).not.toHaveProperty('read')
})

const relaysOf = (kind: string) => h.relays(h.runtime.masterId).filter(item => item.kind === kind)
const notices = () => h.agents.get(h.runtime.masterId)!.inject.mock.calls
  .map(([message]) => JSON.parse(message.content.map(block => block.type === 'text' ? block.text : '').join('')) as Record<string, unknown>)

it('shows a candidate with its thread\'s tickets open first, the tickets it reached, those its text names, and a short next step', async () => {
  const first = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const a = first.ticket
  // Requests on its thread reach its worker, which hands back what is not its own; the main Session then routes them.
  const handBack = async (id: string) => {
    await h.runTool(first.sessionId, 'orchestrator_trigger_handback', { trigger_id: id, reason: 'Another change.' })
    await h.runtime.pump(); await h.runtime.idle()
    await h.consumeMain()
  }
  const second = feishu('2', '@bot 另一个问题', { root_id: 'om_1' })
  h.runtime.receive(second); await h.runtime.idle()
  h.consume()
  await handBack(second.id)
  h.consume()
  const b = (await h.route({ kind: 'accept', trigger_id: second.id, title: 'Other', worktree_name: 'fix-other', acknowledgement: '收到。' })).ticket as
    { ticket_id: string }
  h.runtime.engine.stopTicket(b.ticket_id)
  // A follow-up reaches the live ticket without an Eval; handed back, its candidate shows where it went.
  const more = feishu('3', '@bot 还有按钮', { root_id: 'om_1' })
  h.runtime.receive(more); await h.runtime.idle()
  h.consume()
  await handBack(more.id)
  const followup = relaysOf('candidate').at(-1)!
  expect((followup.related_tickets as { ticket_id: string }[]).map(card => card.ticket_id)).toEqual([a.id, b.ticket_id])
  expect(followup).toMatchObject({ tickets_total: 2, delivered_to: [a.id], thread: `feishu:${CHAT}:om_1` })
  expect(String(followup.next_action).length).toBeLessThanOrEqual(100)
  h.consume()
  // A message elsewhere that names a pull request reads the tickets that follow it.
  const thread = { key: 'github:123', ref: { source: 'github', id: '123' }, createdAt: '', subscriptions: [a.id], correlated: [], pending: [], meta: {} }
  h.runtime.store.threads.save(thread)
  h.runtime.receive(feishu('4', '@bot 看看 #123 的进展')); await h.runtime.idle()
  await h.consumeMain()
  expect(relaysOf('candidate').at(-1)).toMatchObject({ related_tickets: [], tickets_total: 0, referenced_tickets: [{ ticket_id: a.id }] })
})

it('relays a worker\'s report with its ticket card and the start of its summary, and a question with the card alone', async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Needs a decision.', human_action: 'Desktop too?' })
  await h.runtime.idle()
  expect(relaysOf('worker_attention').at(-1)).toEqual({ kind: 'worker_attention', state: 'progress', read: `ticket/${ticket.id}/result`,
    ticket: expect.objectContaining({ ticket_id: ticket.id, state: 'person/answer', attention: expect.objectContaining({ question: 'Desktop too?' }) }) })
  const summary = 'Done. ' + 'Evidence. '.repeat(100)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary, human_action: null })
  await h.runtime.idle()
  const report = relaysOf('worker_report').at(-1)!
  expect(report).toMatchObject({ ticket: { ticket_id: ticket.id, title: ticket.title }, trigger_id: trigger.id, state: 'ready', chars: summary.length,
    read: `ticket/${ticket.id}/result` })
  expect(String(report.summary)).toBe(summary.slice(0, 600))
  expect(report.ticket).not.toHaveProperty('preview')
  // The end of the ticket, which the ready report brought, comes with its card.
  expect(notices().at(-1)).toMatchObject({ ticket_ended: { ticket_id: ticket.id, state: 'completed' } })
})

it('preserves usable non-code deliverables outside a truncated report and continues feedback in the same ticket', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 整理阅读材料'))
  const deliverables = [{ title: 'Reading note', url: 'https://example.com/reading-note' }]
  const summary = 'Verified reading result. ' + 'Evidence. '.repeat(100)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Need the intended audience.', human_action: 'Who will read it?' })
  const attention = h.runtime.store.tickets.get(ticket.id)!.attention!
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Still waiting.', human_action: attention.question })
  expect(h.runtime.store.tickets.get(ticket.id)!.attention!.id).toBe(attention.id)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary, human_action: null, deliverables })
  await h.runtime.idle()
  const completed = h.runtime.store.tickets.get(ticket.id)!
  expect(completed.ended?.outcome).toBe('completed')
  expect(completed.attention).toBeUndefined()
  expect(completed.assignments.at(-1)!.report).toMatchObject({ summary, deliverables })
  expect(relaysOf('worker_report').at(-1)).toMatchObject({ summary: summary.slice(0, 600), deliverables })
  const page = await read(`ticket/${ticket.id}`) as { assignments: { items: { report: unknown }[] } }
  expect(page.assignments.items[0]!.report).toMatchObject({ deliverables })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result',
    text: `阅读记录已整理：[查看文档](${deliverables[0]!.url})` })).toEqual({ status: 'sent' })
  h.runtime.receive(feishu('2', '请补充结论依据', { root_id: 'om_1', mentions: [] }))
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  const revised = [{ title: 'Updated reading note', url: 'https://example.com/reading-note-v2' }]
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Added supporting evidence.', deliverables: revised })
  const final = h.runtime.store.tickets.get(ticket.id)!
  expect(final.assignments.at(-1)!.report?.deliverables).toEqual(revised)
  expect(final.assignments[0]!.report?.deliverables).toEqual(deliverables)
})

it('rejects unopenable or oversized deliverable references before changing a ticket', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 整理阅读材料'))
  const report = (deliverables: unknown) => h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.', deliverables })
  for (const url of ['javascript:alert(1)', 'file:///private/local-file', 'relative/result.md']) {
    await expect(report([{ title: 'Result', url }])).rejects.toThrow()
  }
  await expect(report(Array.from({ length: 11 }, () => ({ title: 'Result', url: 'https://example.com/result' })))).rejects.toThrow()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toBeUndefined()
})

it('reports non-code results without GitHub and refuses a PR claim when no GitHub account is configured', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 整理阅读材料'))
  const deployment = h.runtime.deployment, github = deployment.github
  Reflect.deleteProperty(deployment, 'github')
  try {
    await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.', pr_number: 1 }))
      .rejects.toThrow('This installation has no GitHub account')
    expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toBeUndefined()
    await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Reading note verified.',
      deliverables: [{ title: 'Reading note', url: 'https://example.com/reading-note' }] })
    expect(h.runtime.store.tickets.get(ticket.id)!.ended?.outcome).toBe('completed')
  } finally { deployment.github = github }
})

it('keeps a scheduled delegated task open until its follow-up fires or is cancelled', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 下周继续整理材料'))
  const followup = { id: 'check-later', at: '2099-01-01T00:00:00.000Z', reason: 'Check the new material.', createdAt: new Date().toISOString() }
  h.runtime.store.tickets.save({ ...h.runtime.store.tickets.get(ticket.id)!, followup })
  for (const state of ['ready', 'dropped']) {
    await expect(h.runTool(sessionId, 'orchestrator_report', { state, summary: 'Nothing left now.' })).rejects.toThrow('scheduled follow-up is pending')
  }
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Waiting for the next material update.' })
  const current = h.runtime.store.tickets.get(ticket.id)!
  delete current.followup
  h.runtime.store.tickets.save(current)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Material update is complete.' })
  expect(h.runtime.store.tickets.get(ticket.id)!.ended?.outcome).toBe('completed')
})

it('tells the main Session of the settings, prompts, requeues and unsubscriptions others made, never of its own', async () => {
  const save = (args: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_settings_save', args)
  const evaluation = h.runtime.store.settings().eval
  await h.runtime.settings.save('eval', { ...evaluation, mode: 'observe' }, h.runtime.store.blockRevision('eval'), 'panel')
  await h.runtime.idle()
  expect(notices().at(-1)).toEqual({ settings_saved: 'eval', changed: ['eval.mode'], read: 'settings/eval' })
  const before = notices().length
  expect(await save({ block: 'eval', value: { ...evaluation, mode: 'auto' }, revision: h.runtime.store.blockRevision('eval') })).not.toHaveProperty('context_delivery')
  const config = { ...h.runtime.prompts.current().config, scope: 'Finish what was asked.' }
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_prompts_save', { config, baseRevision: 0 })).not.toHaveProperty('context_delivery')
  await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const thanks = feishu('5', '@bot 谢谢')
  h.runtime.receive(thanks); await h.runtime.idle()
  await h.route({ kind: 'ignore', trigger_id: thanks.id, reason: 'thanks' })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_trigger_requeue', { trigger_id: thanks.id })).toEqual({ queued: true })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_thread_unsubscribe', { thread: `feishu:${CHAT}:om_1` })).toEqual({ removed: true, thread: `feishu:${CHAT}:om_1` })
  await h.runtime.idle()
  expect(notices().slice(before).filter(notice => !('ticket_ended' in notice))).toEqual([])
})

it('answers a policy sync with the counts and what changed, not the whole list', async () => {
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ users: [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_bob', name: 'Bob' }], has_more: false })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_policy_sync', { source: 'feishu' })).toEqual({ source: 'feishu', allowed: 2, added: ['Bob'], removed: [] })
})

it('shows an Executor Session no id it cannot read: no Decision, no other ticket, no Trigger its ticket did not reach', async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const another = feishu('2', '@bot 再修一个', { root_id: 'om_1' })
  h.runtime.receive(another); await h.runtime.idle()
  await h.runTool(sessionId, 'orchestrator_trigger_handback', { trigger_id: another.id, reason: 'Another fix.' })
  const other = await h.acceptedTicket(another)
  const worker = (resource: string) => h.runTool(sessionId, 'orchestrator_read', { resource })
  const thread = await worker(`thread/feishu:${CHAT}:om_1`)
  expect(thread).not.toHaveProperty('tickets')
  expect(thread).not.toHaveProperty('decisions')
  for (const page of [thread, await worker(`ticket/${ticket.id}`), await worker(`trigger/${trigger.id}`)]) {
    const shown = JSON.stringify(page)
    expect(shown).not.toContain(ticket.decisionId)
    expect(shown).not.toContain(other.ticket.id)
  }
  expect(await read(`thread/feishu:${CHAT}:om_1`)).toMatchObject({ tickets: expect.arrayContaining([expect.objectContaining({ ticket_id: other.ticket.id })]),
    decisions: expect.arrayContaining([expect.objectContaining({ decision_id: ticket.decisionId })]) })
  expect(await read(`ticket/${ticket.id}`)).toMatchObject({ decision_id: ticket.decisionId })
})

it('marks the threads a worker follows for context apart from those a Source bound its ticket to', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.runtime.engine.bindThread(ticket.id, { source: 'github', id: '12' }, true)
  await h.runTool(sessionId, 'orchestrator_thread_follow', { thread: 'github:9', reason: 'The Issue it fixes.' })
  const { threads } = await read(`ticket/${ticket.id}`) as { threads: { thread: string }[] }
  expect(threads).toEqual(expect.arrayContaining([{ thread: `feishu:${CHAT}:om_1` }, { thread: 'github:12', bound: true }, { thread: 'github:9', context: true }]))
  expect(threads).toHaveLength(3)
})

it('gives a worker the other messages of the request its ticket was accepted from, in its first message and on its ticket', async () => {
  // Pause while receiving two messages so they are evaluated as a single batch.
  await h.runtime.settings.pause(true, 'panel')
  const first = feishu('1', '@bot 首页的标题'), second = feishu('2', '@bot 改成“浏览网页”', { root_id: 'om_1' })
  await h.runtime.receive(first); await h.runtime.receive(second)
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.idle()
  const accepted = await h.route({ kind: 'accept', trigger_id: second.id, title: 'Retitle', worktree_name: 'retitle', acknowledgement: '收到。' })
  await h.runtime.idle()
  const ticket = h.runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
  const other = ticket.origin.triggerIds.find(id => id !== ticket.origin.triggerId)!
  expect(ticket.origin.triggerIds).toHaveLength(2)
  const message = h.relays(`worker-${ticket.id}`)[0]!
  expect(message.batch).toEqual([expect.objectContaining({ trigger_id: other, preview: expect.any(String), read: `trigger/${other}` })])
  const page = await h.runTool(`worker-${ticket.id}`, 'orchestrator_read', { resource: `ticket/${ticket.id}` })
  expect(page).toMatchObject({ batch: [{ trigger_id: other, read: `trigger/${other}` }] })
  expect(await h.runTool(`worker-${ticket.id}`, 'orchestrator_read', { resource: `trigger/${other}` })).toMatchObject({ trigger_id: other })
})

it('refuses a report that started in an assignment a retry replaced, before it claims the PR or ends the ticket', async () => {
  const { ticket, sessionId, trigger } = await h.acceptedTicket(feishu('report-race', 'Fix the report race'))
  expect(ticket.execution?.name).toContain('fix-regression')
  const branch = `agent/${ticket.execution!.name}`
  h.runtime.engine.report(ticket.id, { state: 'failed', summary: 'The turn broke.' })
  const oldId = h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.id
  // Hold the PR read so the retry lands after the tool call started, but before its commit transaction.
  const release = Promise.withResolvers<void>()
  let pullRead!: () => void
  const readStarted = new Promise<void>(resolve => { pullRead = resolve })
  vi.mocked(Commands.prototype.gh).mockImplementation(async args => {
    if (args[1]?.includes('/pulls/')) {
      pullRead()
      await release.promise
      return { state: 'open', user: { login: 'agent-bot' }, html_url: 'https://github.com/acme/widgets/pull/42',
        head: { sha: 'head-1', ref: branch, repo: { full_name: 'acme/widgets' } } }
    }
    return args[1] === 'user' ? { login: 'agent-bot' } : { default_branch: 'master', permissions: { push: true } }
  })
  const late = h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Old assignment result', pr_number: 42 })
  await readStarted
  h.runtime.engine.retryTicket(ticket.id)
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.id).not.toBe(oldId)
  release.resolve()
  await expect(late).rejects.toThrow(new UserError('assignmentEnded'))
  const after = h.runtime.store.tickets.get(ticket.id)!
  expect(after.ended).toBeUndefined()
  expect(after.assignments.at(-1)!.report).toBeUndefined()
  // The stale call did not bind PR 42 to the Ticket it no longer owns.
  expect(after.follows ?? []).toEqual([])
  expect(trigger.id).toBeTruthy()
})
