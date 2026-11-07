/** A coordinator omission cannot silently pick a different persistent executor or model stage. */
import { expect, it, vi } from 'vitest'
import { mainTools, type MainToolsHost } from '../src/app/tools/main.ts'

function routing(requirements?: { executor: boolean; stage: boolean }, previousDecision?: string, accepted = false) {
  const decide = vi.fn((_triggerId: string, _outcome: unknown) => ({ id: previousDecision ?? 'decision', kind: accepted ? 'accept' : 'ignore', reason: [],
    ...accepted ? { ticketId: 'existing' } : {} }))
  const host = { ...requirements ? { routingRequirements: () => requirements } : {}, engine: { decide },
    requestPass: () => {}, quietly: (run: () => unknown) => run(),
    store: { triggers: { disposition: () => previousDecision ? { decisionId: previousDecision } : undefined },
      tickets: { list: () => accepted ? [{ origin: { triggerId: 'trigger', triggerIds: ['trigger'] } }] : [], get: () => undefined } } } as unknown as MainToolsHost
  const route = mainTools(host, {} as never).find(tool => tool.name === 'orchestrator_route')!
  const invoke = (extra: object) => route.execute(route.schema.parse({ decisions: [{ kind: 'accept', trigger_id: 'trigger',
    title: 'Read the design', worktree_name: 'read-design', acknowledgement: 'Reading the design.', ...extra }] }), new AbortController().signal)
  return { decide, invoke }
}

it('refuses a missing stage, including the old DSH choice, without creating work', async () => {
  const { decide, invoke } = routing({ executor: true, stage: true })
  for (const extra of [{}, { executor: 'codex' }, { executor: 'dsh', stage: null }]) {
    expect(await invoke(extra)).toMatchObject({ results: [{ refused: expect.stringContaining('needs stage') }] })
  }
  expect(decide).not.toHaveBeenCalled()
})

it.each(['research', 'implementation', 'documentation'])('maps %s to Codex without a separate executor choice', async stage => {
  const { decide, invoke } = routing({ executor: true, stage: true })
  await invoke({ stage })
  expect(decide).toHaveBeenCalledWith('trigger', expect.objectContaining({ executor: 'codex', stage }))
})

it('maps auxiliary to DSH without passing a Codex stage to the Engine', async () => {
  const { decide, invoke } = routing({ executor: true, stage: true })
  await invoke({ stage: 'auxiliary' })
  const outcome = decide.mock.calls[0]![1]
  expect(outcome).toMatchObject({ executor: 'dsh' })
  expect(outcome).not.toHaveProperty('stage')
})

it.each([{ executor: 'dsh', stage: 'documentation' }, { executor: 'codex', stage: 'auxiliary' }])(
  'refuses the contradictory executor hint $executor for $stage before creating work', async extra => {
    const { decide, invoke } = routing({ executor: true, stage: true })
    expect(await invoke(extra)).toMatchObject({ results: [{ refused: expect.stringContaining('omit executor') }] })
    expect(decide).not.toHaveBeenCalled()
  })

it('preserves legacy single-path routing without introducing a new stage requirement', async () => {
  for (const requirements of [undefined, { executor: false, stage: false }]) {
    const legacy = routing(requirements)
    await legacy.invoke({})
    expect(legacy.decide).toHaveBeenCalledOnce()
    expect(legacy.decide.mock.calls[0]![1]).not.toHaveProperty('executor')
    expect(legacy.decide.mock.calls[0]![1]).not.toHaveProperty('stage')
  }
})

it('still selects the executor by stage with a fixed instance model', async () => {
  const fixed = routing({ executor: true, stage: false })
  expect(await fixed.invoke({ executor: 'codex' })).toMatchObject({ results: [{ refused: expect.stringContaining('needs stage') }] })
  await fixed.invoke({ stage: 'documentation' })
  expect(fixed.decide).toHaveBeenCalledWith('trigger', expect.objectContaining({ executor: 'codex', stage: 'documentation' }))
})

it('still requires a choice when retrying a previously ignored candidate', async () => {
  const { decide, invoke } = routing({ executor: true, stage: true }, 'earlier-ignore')
  expect(await invoke({ executor: 'dsh', stage: null })).toMatchObject({ results: [{ refused: expect.stringContaining('needs stage') }] })
  expect(decide).not.toHaveBeenCalled()
  await invoke({ stage: 'documentation' })
  expect(decide).toHaveBeenCalledWith('trigger', expect.objectContaining({ executor: 'codex', stage: 'documentation' }))
})

it('does not require new routing fields or reinterpret the executor of already accepted work', async () => {
  const { decide, invoke } = routing({ executor: true, stage: true }, 'earlier-accept', true)
  expect(await invoke({})).toMatchObject({ results: [{ reason: 'Already accepted as existing; title and acknowledgement unchanged' }] })
  expect(await invoke({ executor: 'dsh', stage: 'documentation' })).toMatchObject({ results: [
    { reason: 'Already accepted as existing; title and acknowledgement unchanged' }] })
  expect(decide).toHaveBeenCalledTimes(2)
})
