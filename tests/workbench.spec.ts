/** Native delegation preserves source evidence and uses real Runtime intake deduplication. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { delegateDiscussion, delegateDiscussionTasks, workbenchKind, type WorkbenchContext, type WorkbenchRequest } from '../src/sources/workbench.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host
const owner = 'local-owner'
const at = '2026-11-04T10:00:00.000Z'
const request: WorkbenchRequest = { sessionId: 'discussion', throughSeq: 4, requestId: 'delegate-1', instruction: 'Prepare the agreed research report.' }
const snapshot: WorkbenchContext = { sessionId: 'discussion', throughSeq: 4, partial: false, attachments: [],
  messages: [{ seq: 1, role: 'user', text: 'Use the attached material.', at, references: ['session-file:material.pdf'] },
    { seq: 4, role: 'assistant', text: 'The agreed outline.', at, references: [] }] }
beforeEach(async () => {
  h = await startRuntime()
  h.runtime.sources.register(workbenchKind)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, workbench: { enabled: true, config: { ownerId: owner } } },
    policy: { ...settings.policy, sources: { ...settings.policy.sources, workbench: { allowed: [{ id: owner }], admission: {} } } } })
})
afterEach(async () => { await h.stop() })
const delegate = (input = request, context = snapshot, actor = owner) => delegateDiscussion(h.runtime.context(workbenchKind), actor, input, context, at)

it('preserves the original discussion prefix and references on explicit delegation', async () => {
  const result = await delegate()
  expect(result.received).toBe('stored')
  const trigger = h.runtime.store.triggers.get(result.triggerId)!
  expect(trigger).toMatchObject({ human: true, addressed: 'direct', actor: { source: 'workbench', id: owner },
    text: request.instruction, meta: { context: snapshot } })
  const context = h.runtime.sources.threadContext(trigger)!
  expect(await context.read(h.runtime.commands, 'thread')).toMatchObject({ status: 'available',
    messages: [{ text: 'Use the attached material.' }, { text: 'The agreed outline.' }],
    body: { references: ['session-file:material.pdf'], throughSeq: 4 } })
})

it('deduplicates a retried delegation and refuses changed input under the same request ID', async () => {
  const first = await delegate()
  expect(await delegate()).toEqual({ triggerId: first.triggerId, received: 'duplicate' })
  await expect(delegate({ ...request, instruction: 'A different task' })).rejects.toThrow('different input')
})

it('keeps two delegations in the same discussion on separate task threads', async () => {
  const first = await delegate()
  const second = await delegate({ ...request, requestId: 'delegate-2' })
  expect(h.runtime.store.triggers.get(first.triggerId)!.threads)
    .not.toEqual(h.runtime.store.triggers.get(second.triggerId)!.threads)
})

it('decomposes explicitly named goals and recovers partial intake without duplicating accepted work', async () => {
  const source = h.runtime.context(workbenchKind)
  const input = { ...request, instruction: 'Read the model report. Check the dependency update.' }
  const tasks = [{ id: 'model', owner_instruction_quote: 'Read the model report.' },
    { id: 'dependency', owner_instruction_quote: 'Check the dependency update.' }]
  const receive = source.receive
  const intake = vi.spyOn(source, 'receive').mockImplementationOnce(receive).mockImplementationOnce(() => { throw new Error('connection lost') })
  await expect(delegateDiscussionTasks(source, owner, input, snapshot, tasks, at)).rejects.toThrow('connection lost')
  intake.mockRestore()
  const result = await delegateDiscussionTasks(source, owner, input, snapshot, tasks, at)
  expect(result.tasks.map(item => item.received)).toEqual(['duplicate', 'stored'])
  const triggers = result.tasks.map(item => h.runtime.store.triggers.get(item.triggerId)!)
  expect(triggers.map(item => item.text)).toEqual(tasks.map(item => item.owner_instruction_quote))
  expect(triggers[0]!.threads).not.toEqual(triggers[1]!.threads)
  expect(triggers.every(item => item.meta.context === undefined || (item.meta.context as WorkbenchContext).throughSeq === snapshot.throughSeq)).toBe(true)
  expect((await delegateDiscussionTasks(source, owner, input, snapshot, [tasks[1]!, tasks[0]!], at)).tasks.map(item => item.received))
    .toEqual(['duplicate', 'duplicate'])
  await expect(delegateDiscussion(source, owner, input, snapshot, at)).rejects.toThrow('already has a task plan')
})

it('rejects invented batch goals before any intake', async () => {
  const source = h.runtime.context(workbenchKind)
  const receive = vi.spyOn(source, 'receive')
  await expect(delegateDiscussionTasks(source, owner, request, snapshot,
    [{ id: 'outside', owner_instruction_quote: 'Publish production changes' }], at)).rejects.toThrow('original owner instruction')
  expect(receive).not.toHaveBeenCalled()
  receive.mockRestore()
})

it('appends goals confirmed together without replacing earlier receipts', async () => {
  const source = h.runtime.context(workbenchKind)
  const first = { id: 'first', owner_instruction_quote: request.instruction }
  const second = { id: 'second', owner_instruction_quote: request.instruction }
  const receipt = await delegateDiscussionTasks(source, owner, request, snapshot, [first], at)
  expect((await delegateDiscussionTasks(source, owner, request, snapshot, [second], at)).tasks[0]!.received).toBe('stored')
  const retry = await delegateDiscussionTasks(source, owner, request, snapshot, [first, second], at)
  expect(retry.tasks.map(item => item.received)).toEqual(['duplicate', 'duplicate'])
  expect(retry.tasks[0]!.triggerId).toBe(receipt.tasks[0]!.triggerId)
  expect(retry.tasks.map(item => h.runtime.store.triggers.get(item.triggerId)!.meta.task)).toEqual([first, second])
  await expect(delegateDiscussionTasks(source, owner, request, snapshot,
    [{ ...first, owner_instruction_quote: 'research report' }], at)).rejects.toThrow('different task plan')
})

it('refuses wrong owners, mismatched sessions, and context beyond the selected boundary', async () => {
  await expect(delegate(request, snapshot, 'other-owner')).rejects.toThrow('another owner')
  await expect(delegate(request, { ...snapshot, sessionId: 'unrelated' })).rejects.toThrow('does not match')
  await expect(delegate(request, { ...snapshot, messages: [{ ...snapshot.messages[0]!, seq: 5 }] })).rejects.toThrow('boundary')
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, workbench: { enabled: false, config: { ownerId: owner } } } })
  await expect(delegate()).rejects.toThrow('disabled')
})

it('pages captured context and retains the partial marker without rereading later discussion', async () => {
  const messages = Array.from({ length: 55 }, (_, seq) => ({ seq, role: 'user' as const, text: `Message ${seq}`, at, references: [] }))
  const result = await delegate({ ...request, throughSeq: 54 }, { ...snapshot, throughSeq: 54, messages, partial: true })
  const reader = h.runtime.sources.threadContext(h.runtime.store.triggers.get(result.triggerId)!)!
  expect(await reader.read(h.runtime.commands, 'thread')).toMatchObject({ status: 'partial', messages: { length: 50 }, next: '50' })
  expect(await reader.read(h.runtime.commands, 'thread', '50')).toMatchObject({ status: 'partial', messages: { length: 5 } })
  await expect(reader.read(h.runtime.commands, 'thread', '-1')).rejects.toThrow('cursor')
})
