/** Host intake uses the native authenticated carrier and persisted Session evidence. */
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { SessionId, SessionSeq, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apply } from '../src/sources/workbench-host.ts'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'
import { needsGithub } from '../src/app/setup.ts'
import { SettingsSchema } from '../src/policy.ts'
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

let h: Host
let route: ConnectionFetchRoute
let discussion: ConnectionFetchRoute
let summary: ConnectionFetchRoute
let update: ConnectionFetchRoute
let answer: ConnectionFetchRoute
let queue: ConnectionFetchRoute
let queueAction: ConnectionFetchRoute
let artifact: ConnectionFetchRoute
let inspect = vi.fn<Context['sessionController']['inspect']>()
let discussionTool: ToolDefinition
it('registers a plain JSON schema without Zod method metadata', () => {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') { expect(typeof value).not.toBe('function'); return }
    expect(Reflect.ownKeys(value).filter(key => key !== 'length')).toEqual(Object.keys(value))
    for (const child of Object.values(value)) visit(child)
  }
  visit(discussionTool.parameters)
  expect(discussionTool.parameters).toMatchObject({ type: 'object', additionalProperties: false })
})
beforeEach(async () => {
  h = await startRuntime()
  await h.controller.create({ sessionId: 'discussion' })
  Object.assign(h.ctx.webServer, { protocol: 'http:' })
  h.ctx.reflect.provide('tools', { register: (tool: ToolDefinition) => { discussionTool = tool; return () => {} } })
  inspect = vi.fn<Context['sessionController']['inspect']>()
  Object.assign(h.controller, { inspect })
  h.ctx.reflect.provide('connection', { fetch: { register: (value: ConnectionFetchRoute) => {
    if (value.path.endsWith('/artifact')) artifact = value
    else if (value.path.endsWith('/discussion')) discussion = value
    else if (value.path.endsWith('/summary')) summary = value
    else if (value.path.endsWith('/queue/action')) queueAction = value
    else if (value.path.endsWith('/queue')) queue = value
    else if (value.methods.includes('GET')) discussion = value
    else if (value.path.endsWith('/update')) update = value
    else if (value.path.endsWith('/answer')) answer = value
    else route = value
    return async () => {}
  } } })
  apply(h.ctx)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, workbench: { enabled: true, config: { ownerId: 'owner' } } },
    policy: { ...settings.policy, sources: { ...settings.policy.sources, workbench: { allowed: [{ id: 'owner' }], admission: {} } } } })
  inspect.mockResolvedValue({ meta: { version: SESSION_FORMAT_VERSION, id: SessionId('discussion'), createdAt: 0, isSeeded: false },
    inheritedEventCount: SessionLogOffset(0), events: [{ type: 'user/message', seq: SessionSeq(0), time: 0, surfaceOp: 'append',
      data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Original owner discussion' }] }) }] })
})
afterEach(async () => { await h.stop() })

it('publishes an observed-source task through its private owner channel and retains owner checks', async () => {
  const { ticket } = await h.acceptedTicket(feishu('observed-file', 'Prepare the business reading note'))
  const directory = join(h.directory, 'observed-delivery')
  mkdirSync(directory)
  writeFileSync(join(directory, 'note.md'), 'Business follow-up evidence', 'utf8')
  const current = h.runtime.store.tickets.get(ticket.id)!
  current.execution = { ...current.execution!, directory }
  current.channels = [{ source: 'workbench', thread: 'owner-inbox', address: { ownerId: 'owner', sessionId: 'discussion' } }]
  h.runtime.store.tickets.save(current)
  const origin = h.runtime.store.triggers.get(current.origin.triggerId)!
  const files = await h.runtime.sources.publishFiles(origin, current, [{ title: 'Business note', path: 'note.md' }])
  h.runtime.engine.report(current.id, { state: 'ready', summary: 'Note delivered', deliverables: files })
  const response = await artifact.fetch(new Request(files[0]!.url))
  expect(await response.text()).toBe('Business follow-up evidence')
  current.channels[0]!.address.ownerId = 'someone-else'
  await expect(h.runtime.sources.publishFiles(origin, current, [{ title: 'Wrong owner', path: 'note.md' }])).rejects.toThrow('another task owner')
})
const input = { sessionId: 'discussion', requestId: 'request-1', throughSeq: 0, instruction: 'Prepare a reading note' }
const send = (body: unknown) => route.fetch(new Request('http://localhost/api/superagent-workbench/delegate', { method: 'POST', body: JSON.stringify(body) }))

it('saves cross-source answers on the exact Ticket through the authenticated carrier, without inspecting a discussion', async () => {
  const { ticket } = await h.acceptedTicket(feishu('answer-1', 'Prepare the note'))
  const attention = h.runtime.engine.report(ticket.id, { state: 'blocked', summary: 'Waiting', question: 'Which scope?' }).attention!
  const submit = (body: unknown) => answer.fetch(new Request('http://localhost/api/superagent-workbench/answer', { method: 'POST', body: JSON.stringify(body) }))
  const body = { ticketId: ticket.id, attentionId: attention.id, instruction: 'Keep only the first section.' }
  const response = await submit(body)
  expect(response.status).toBe(200)
  const receipt = await response.json()
  expect(receipt.saved).toBe(true)
  expect(await (await submit(body)).json()).toEqual(receipt)
  expect(h.runtime.store.tickets.get(ticket.id)?.inputs.filter(input => input.kind === 'answer')).toEqual([
    expect.objectContaining({ question: 'Which scope?', text: body.instruction, by: { source: 'workbench', id: 'owner' } }),
  ])
  expect(h.runtime.store.tickets.get(ticket.id)?.attention).toBeUndefined()
  expect(inspect).not.toHaveBeenCalled()
  await h.runtime.idle()
  h.step(`worker-${ticket.id}`)
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)?.inputs.find(input => input.kind === 'answer')).toMatchObject({ readAt: expect.any(String) })
  h.runtime.engine.report(ticket.id, { state: 'waiting', summary: 'Scope applied; waiting for evidence.' })
  expect(h.runtime.store.tickets.get(ticket.id)?.inputs.find(input => input.kind === 'answer')).toMatchObject({ reportedAt: expect.any(String) })
  expect((await submit({ ...body, instruction: 'Different' })).status).toBe(409)
  expect((await submit({ ...body, ownerId: 'forged' })).status).toBe(400)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources,
    workbench: { allowed: [], admission: {} } } } })
  expect((await submit(body)).status).toBe(409)
})

it('reads the owner decision queue and applies defer, restore and “no action needed” through the authenticated carrier', async () => {
  const { ticket } = await h.acceptedTicket(feishu('queue-route', 'Prepare the note'))
  const advice = { summary: 'Send it', reason: 'The note is ready', risk: 'Recipients may be away', draft: 'Sending the note now.' }
  const attention = h.runtime.engine.report(ticket.id, { state: 'blocked', summary: 'Waiting', question: 'Send it now?', advice }).attention!
  const read = async () => (await queue.fetch(new Request('http://localhost/api/superagent-workbench/queue'))).json()
  expect(await read()).toMatchObject({ items: [{ ticketId: ticket.id, attentionId: attention.id, question: 'Send it now?', advice }],
    deferred: [], ignored: [], counts: { open: 1, deferred: 0, ignored: 0 } })
  const act = (body: unknown) => queueAction.fetch(new Request('http://localhost/api/superagent-workbench/queue/action',
    { method: 'POST', body: JSON.stringify(body) }))
  const until = new Date(Date.now() + 3_600_000).toISOString()
  expect(await (await act({ action: 'defer', ticketId: ticket.id, attentionId: attention.id, until })).json()).toEqual({ saved: true, until })
  // A deferral hides the row but does not answer the Question.
  expect(h.runtime.store.tickets.get(ticket.id)?.attention?.id).toBe(attention.id)
  expect(await read()).toMatchObject({ items: [], deferred: [{ attentionId: attention.id, until }], counts: { open: 0, deferred: 1 } })
  expect((await act({ action: 'restore', ticketId: ticket.id, attentionId: attention.id })).status).toBe(200)
  expect((await read()).deferred).toHaveLength(0)
  expect((await act({ action: 'ignore', ticketId: ticket.id, attentionId: attention.id, reason: 'Answered in person' })).status).toBe(200)
  expect(h.runtime.store.tickets.get(ticket.id)?.attention).toBeUndefined()
  expect(await read()).toMatchObject({ items: [], ignored: [{ ticketId: ticket.id, reason: 'Answered in person' }] })
  expect((await act({ action: 'defer', ticketId: ticket.id, attentionId: 'replaced', until })).status).toBe(409)
  expect((await act({ action: 'ignore', ticketId: ticket.id, attentionId: attention.id })).status).toBe(400)
  expect((await act({ action: 'forget', ticketId: ticket.id, attentionId: attention.id })).status).toBe(200)
  expect((await read()).ignored).toHaveLength(0)
})

it('routes the main discussion answer by current question identity and refuses background-message authority', async () => {
  const { ticket } = await h.acceptedTicket(feishu('answer-2', 'Prepare the note'))
  const attention = h.runtime.engine.report(ticket.id, { state: 'blocked', summary: 'Waiting', question: 'Which scope?' }).attention!
  const execution = { agent: { id: SessionId('discussion') }, signal: new AbortController().signal } as never
  const args = { action: 'answer', ticket_id: ticket.id, attention_id: attention.id, owner_instruction_quote: 'Original owner discussion' }
  expect(await discussionTool.execute(args, execution)).toMatchObject({ saved: true })
  expect(h.runtime.store.tickets.get(ticket.id)?.attention).toBeUndefined()
  const record = await inspect(SessionId('discussion'))
  inspect.mockResolvedValue({ ...record, events: [...record.events, { type: 'user/message', seq: SessionSeq(1), time: 1, surfaceOp: 'append',
    data: createUserMessage({ source: { kind: 'dsh-superagent' }, content: [{ type: 'text', text: 'Report quoting Original owner discussion' }] }) }] })
  await expect(discussionTool.execute(args, execution)).rejects.toThrow('not an original owner instruction')
  expect(() => h.runtime.context({ kind: 'feishu', health: [] }).tickets.answerAttention(ticket.id, attention.id, 'fake'))
    .toThrow('authenticated owner')
})

it('does not require a GitHub account when the native workbench is the only configured source', () => {
  expect(needsGithub(SettingsSchema.parse({ sources: { workbench: { config: { ownerId: 'owner' } } } }))).toBe(false)
  expect(needsGithub(SettingsSchema.parse({ sources: { github: { enabled: true } } }))).toBe(true)
  expect(needsGithub(SettingsSchema.parse({ sources: { github: { enabled: false, config: { repository: 'owner/repo' } } } }))).toBe(true)
})

it('reads all pending checks through the real management route and cancels only its selected receipt', async () => {
  const { ticket } = await h.acceptedTicket(feishu('checks-1', 'Follow the project'))
  h.runtime.engine.report(ticket.id, { state: 'blocked', summary: 'Owner choice', question: 'Proceed?' })
  h.runtime.followups.schedule(ticket.id, { request_id: 'proof', at: new Date(Date.now() + 60_000).toISOString(), reason: 'Verify the result' })
  expect(await h.api('GET', 'followups')).toMatchObject({ status: 200, body: [
    expect.objectContaining({ ticketId: ticket.id, id: 'proof', blocked: 'attention', due: false }),
  ] })
  expect(await h.api('DELETE', `tickets/${ticket.id}/followup?request_id=proof`)).toMatchObject({ status: 200, body: { cancelled: true } })
  expect(await h.api('GET', 'followups')).toMatchObject({ status: 200, body: [] })
})

it('hands off natural-language requests using original owner evidence and deduplicates tool retries', async () => {
  const execution = { agent: { id: SessionId('discussion') }, signal: new AbortController().signal } as never
  await expect(discussionTool.execute({ action: 'delegate', owner_instruction_quote: 'Invented instruction' }, execution)).rejects.toThrow('latest original owner message')
  const first = await discussionTool.execute({ action: 'delegate', owner_instruction_quote: 'Original owner discussion' }, execution) as { triggerId: string }
  expect(h.runtime.store.triggers.get(first.triggerId)?.text).toBe('Original owner discussion')
  expect(await discussionTool.execute({ action: 'delegate', owner_instruction_quote: 'Original owner discussion' }, execution))
    .toMatchObject({ triggerId: first.triggerId, received: 'duplicate' })
  const status = await discussionTool.execute({ action: 'status' }, execution)
  expect(status).toMatchObject({ requests: [{ triggerId: first.triggerId }] })
  const record = await inspect(SessionId('discussion'))
  inspect.mockResolvedValue({ ...record, meta: { ...record.meta, origin: 'subagent' } })
  await expect(discussionTool.execute({ action: 'delegate', owner_instruction_quote: 'Original owner discussion' }, execution)).rejects.toThrow('not owner discussions')
})

it('registers on DSH authenticated transport, uses stored history and routes into one persistent ticket', async () => {
  expect(route).toMatchObject({ path: '/api/superagent-workbench/delegate', methods: ['POST'], requestBody: 'buffered' })
  const response = await send(input)
  expect(response.status).toBe(200)
  const receipt = await response.json()
  expect(h.runtime.store.triggers.get(receipt.triggerId)).toMatchObject({ actor: { id: 'owner' },
    meta: { context: { messages: [{ text: 'Original owner discussion' }] } } })
  await h.runtime.idle()
  const decision = await h.route({ kind: 'accept', trigger_id: receipt.triggerId, title: 'Reading note', worktree_name: 'reading-note', acknowledgement: 'Preparing the reading note.' })
  expect(decision.ticket).toHaveProperty('ticket_id')
  await h.runtime.idle()
  const ack = await h.runTool(`worker-${(decision.ticket as { ticket_id: string }).ticket_id}`, 'orchestrator_ack',
    { trigger_id: receipt.triggerId, text: 'Preparing the reading note.' })
  expect(ack.acknowledgement).toBe('sent')
  expect(await (await send(input)).json()).toMatchObject({ triggerId: receipt.triggerId, received: 'duplicate' })
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  h.runtime.engine.report((decision.ticket as { ticket_id: string }).ticket_id, { state: 'progress', summary: 'Draft verified.',
    deliverables: [{ title: 'Reading note', url: 'https://example.test/note' }] })
  const current = await discussion.fetch(new Request('http://localhost/api/superagent-workbench/discussion?sessionId=discussion'))
  expect(await current.json()).toMatchObject({ throughSeq: 0, messageCount: 1, requests: [{ triggerId: receipt.triggerId,
    tickets: [{ id: (decision.ticket as { ticket_id: string }).ticket_id, summary: 'Draft verified.',
      deliverables: [{ title: 'Reading note', url: 'https://example.test/note' }] }] }] })
  const inbox = await (await discussion.fetch(new Request('http://localhost/api/superagent-workbench/discussion?sessionId=discussion'))).json()
  expect(inbox.notices).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Preparing the reading note.' })]))
  expect(h.agents.get('discussion')!.inject).toHaveBeenCalledOnce()
})

it('summarizes linked work for the Session row without reading discussion history', async () => {
  const receipt = await (await send(input)).json()
  await h.runtime.idle()
  const accepted = await h.route({ kind: 'accept', trigger_id: receipt.triggerId, title: 'Reading note', worktree_name: 'reading-note',
    acknowledgement: 'Preparing the note.' })
  const ticketId = (accepted.ticket as { ticket_id: string }).ticket_id
  await h.runtime.idle()
  const read = async () => (await summary.fetch(new Request('http://localhost/api/superagent-workbench/summary?sessionId=discussion'))).json()
  expect(await read()).toMatchObject({ sessionId: 'discussion', active: 1, attention: 0 })
  h.runtime.engine.report(ticketId, { state: 'waiting', summary: 'Need a decision', question: 'Which scope?' })
  expect(await read()).toMatchObject({ sessionId: 'discussion', active: 1, attention: 1 })
  inspect.mockClear()
  await read()
  expect(inspect).not.toHaveBeenCalled()
})

it('refuses caller-authored identity and history instead of promoting them into owner evidence', async () => {
  expect((await send({ ...input, ownerId: 'someone', context: { messages: [] } })).status).toBe(400)
  expect(inspect).not.toHaveBeenCalled()
})

it('does not report receipt success when Session lookup or source configuration fails', async () => {
  inspect.mockRejectedValueOnce(new Error('Session unavailable'))
  expect((await send(input)).status).toBe(409)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, workbench: { enabled: false, config: { ownerId: 'owner' } } } })
  expect((await send(input)).status).toBe(503)
})

it('delivers an explicit update only to its task and rejects stale decisions or stopped work', async () => {
  const receipt = await (await send(input)).json()
  await h.runtime.idle()
  const accepted = await h.route({ kind: 'accept', trigger_id: receipt.triggerId, title: 'Reading note', worktree_name: 'reading-note', acknowledgement: 'Preparing the note.' })
  const ticketId = (accepted.ticket as { ticket_id: string }).ticket_id
  const submit = (body: unknown) => update.fetch(new Request('http://localhost/api/superagent-workbench/update', { method: 'POST', body: JSON.stringify(body) }))
  const request = { ...input, requestId: 'update-1', ticketId, instruction: 'Use the revised scope.' }
  const first = await submit(request)
  expect(first.status).toBe(200)
  const saved = await first.json()
  expect(h.runtime.store.triggers.disposition(saved.triggerId)?.fanout).toEqual([ticketId])
  expect(await (await submit(request)).json()).toMatchObject({ received: 'duplicate', triggerId: saved.triggerId })
  expect((await submit({ ...request, requestId: 'stale', attentionId: 'old-question' })).status).toBe(409)
  h.runtime.engine.stopTicket(ticketId)
  expect((await submit({ ...request, requestId: 'stopped' })).status).toBe(409)
})

it('publishes verified task files and rejects unreported, escaped or changed file content', async () => {
  const receipt = await (await send(input)).json()
  await h.runtime.idle()
  const accepted = await h.route({ kind: 'accept', trigger_id: receipt.triggerId, title: 'Note', worktree_name: 'reading-note', acknowledgement: 'Preparing the note.' })
  const ticketId = (accepted.ticket as { ticket_id: string }).ticket_id
  await h.runtime.idle()
  const ticket = h.runtime.store.tickets.get(ticketId)!
  mkdirSync(ticket.execution!.directory, { recursive: true })
  const path = join(ticket.execution!.directory, 'result.md')
  writeFileSync(path, '# Verified result\n')
  const outside = join(h.directory, 'external-material')
  mkdirSync(outside); writeFileSync(join(outside, 'private.md'), 'Not a task deliverable')
  symlinkSync(outside, join(ticket.execution!.directory, 'linked-outside'), 'junction')
  await expect(h.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'progress', summary: 'Outside',
    files: [{ title: 'Outside', path: join(outside, 'private.md') }] })).rejects.toThrow('inside its task workspace')
  await expect(h.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'progress', summary: 'Linked outside',
    files: [{ title: 'Outside', path: 'linked-outside/private.md' }] })).rejects.toThrow('inside its task workspace')
  await h.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'progress', summary: 'Result prepared.', files: [{ title: 'Result', path: 'result.md' }] })
  const url = h.runtime.store.tickets.get(ticketId)!.assignments.at(-1)!.report!.deliverables![0]!.url
  const response = await artifact.fetch(new Request(url))
  expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  expect(response.headers.get('content-security-policy')).toContain('sandbox')
  expect(await response.text()).toBe('# Verified result\n')
  const unreported = new URL(url); unreported.searchParams.set('path', 'unreported.md')
  expect((await artifact.fetch(new Request(unreported))).status).toBe(409)
  writeFileSync(path, 'changed after publication')
  expect((await artifact.fetch(new Request(url))).status).toBe(409)
})

it('serves previewable deliverables inline and unknown binaries as downloads', async () => {
  const receipt = await (await send(input)).json()
  await h.runtime.idle()
  const accepted = await h.route({ kind: 'accept', trigger_id: receipt.triggerId, title: 'Preview', worktree_name: 'preview-note',
    acknowledgement: 'Preparing the preview.' })
  const ticketId = (accepted.ticket as { ticket_id: string }).ticket_id
  await h.runtime.idle()
  const directory = h.runtime.store.tickets.get(ticketId)!.execution!.directory
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'preview.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(directory, 'archive.bin'), Buffer.from([0, 1, 2]))
  await h.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'progress', summary: 'Previews prepared.',
    files: [{ title: 'Preview', path: 'preview.png' }, { title: 'Archive', path: 'archive.bin' }] })
  const deliverables = h.runtime.store.tickets.get(ticketId)!.assignments.at(-1)!.report!.deliverables!
  const image = await artifact.fetch(new Request(deliverables.find(item => item.title === 'Preview')!.url))
  expect(image.headers.get('content-type')).toBe('image/png')
  expect(image.headers.get('content-disposition')).toContain('inline')
  const archive = await artifact.fetch(new Request(deliverables.find(item => item.title === 'Archive')!.url))
  expect(archive.headers.get('content-type')).toBe('application/octet-stream')
  expect(archive.headers.get('content-disposition')).toContain('attachment')
})

it('reuses the same native task when an authorized Feishu follow-up is attached', async () => {
  const receipt = await (await send(input)).json()
  await h.runtime.idle()
  const accepted = await h.route({ kind: 'accept', trigger_id: receipt.triggerId, title: 'Cross-channel note', worktree_name: 'cross-channel-note', acknowledgement: 'Preparing the note.' })
  const ticketId = (accepted.ticket as { ticket_id: string }).ticket_id
  await h.runtime.idle()
  const feedback = feishu('fallback-1', `Continue existing task ${ticketId}: keep the original scope.`)
  await h.runtime.receive(feedback); await h.runtime.idle()
  await h.route({ kind: 'attach', trigger_id: feedback.id, ticket_id: ticketId })
  expect(h.runtime.store.triggers.disposition(feedback.id)?.fanout).toEqual([ticketId])
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  const nativeUpdate = { ...input, requestId: 'after-feishu', ticketId, instruction: 'Continue in the native workbench.' }
  expect((await update.fetch(new Request('http://localhost/api/superagent-workbench/update', { method: 'POST', body: JSON.stringify(nativeUpdate) }))).status).toBe(200)
  const current = await (await discussion.fetch(new Request('http://localhost/api/superagent-workbench/discussion?sessionId=discussion'))).json()
  expect(current.requests[0].tickets[0].id).toBe(ticketId)
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
})
