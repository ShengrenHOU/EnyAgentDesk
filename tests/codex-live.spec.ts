import { feishu, startRuntime } from './fixtures/host.ts'
import { KV } from '../src/kv.ts'
import { expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { CodexRpc } from '../src/executor/codex-rpc.ts'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

it.skipIf(!process.env.CODEX_LIVE_BINARY)('executes a real bounded Codex file task and resumes its thread', async () => {
  const cwd = resolve('.artifacts/codex-live')
  await mkdir(cwd, { recursive: true })
  const completions: { resolve(value: unknown): void; reject(error: Error): void }[] = []
  let commandStarted: ReturnType<typeof Promise.withResolvers<void>> | undefined
  const options = { command: process.env.CODEX_LIVE_BINARY!, cwd, env: scrubbedParentEnv(),
    notification(method: string, params: unknown) {
      if (method === 'turn/completed') completions.shift()?.resolve(params)
      if (method === 'item/started' && z.object({ item: z.object({ type: z.literal('commandExecution') }) }).safeParse(params).success) commandStarted?.resolve()
    },
    async request() { throw new Error('Live smoke does not approve extra capabilities') },
    disconnected(error: Error) { completions.shift()?.reject(error) },
  }
  let rpc = await CodexRpc.connect(options)
  const run = async (threadId: string, text: string) => {
    const done = Promise.withResolvers<unknown>()
    completions.push(done)
    await rpc.call('turn/start', { threadId, input: [{ type: 'text', text }] })
    const event = z.object({ turn: z.object({ status: z.string() }) }).parse(await done.promise)
    expect(event.turn.status).toBe('completed')
  }
  try {
    const first = z.object({ thread: z.object({ id: z.string() }) }).parse(await rpc.call('thread/start', {
      cwd, sandbox: 'workspace-write', approvalPolicy: 'never',
      developerInstructions: 'This is a bounded integration test. Work only in the provided directory. Do not access the network, credentials, other repositories or external applications.',
    }))
    await run(first.thread.id, 'Write smoke.txt with exactly native-ok, without a newline. Then reply DONE.')
    expect(await readFile(resolve(cwd, 'smoke.txt'), 'utf8')).toBe('native-ok')
    await rpc.close()
    rpc = await CodexRpc.connect(options)
    const resumed = z.object({ thread: z.object({ id: z.string() }) }).parse(await rpc.call('thread/resume', {
      threadId: first.thread.id, cwd, sandbox: 'workspace-write', approvalPolicy: 'never',
    }))
    expect(resumed.thread.id).toBe(first.thread.id)
    await run(first.thread.id, 'Append exactly -resumed to the file you created in the previous turn. Do not create any other file.')
    expect(await readFile(resolve(cwd, 'smoke.txt'), 'utf8')).toBe('native-ok-resumed')
    commandStarted = Promise.withResolvers<void>()
    const interrupted = Promise.withResolvers<unknown>()
    completions.push(interrupted)
    const started = z.object({ turn: z.object({ id: z.string() }) }).parse(await rpc.call('turn/start', {
      threadId: first.thread.id, input: [{ type: 'text', text: 'Run a local PowerShell command that waits 30 seconds and then creates cancelled.txt. Do not do any other work.' }],
    }))
    await Promise.race([commandStarted.promise, interrupted.promise.then(() => { throw new Error('Turn ended before a command started') })])
    await rpc.call('turn/interrupt', { threadId: first.thread.id, turnId: started.turn.id })
    expect(z.object({ turn: z.object({ status: z.string() }) }).parse(await interrupted.promise).turn.status).toBe('interrupted')
    await expect(readFile(resolve(cwd, 'cancelled.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rpc.close() }
}, 240_000)

// Sources, acknowledgement transport and Outbox are simulated; only Codex execution is real.
it.skipIf(!process.env.CODEX_STAGE_LIVE_BINARY)('executes three real stages through CodexExecutor in one durable thread', async () => {
  const host = await startRuntime(undefined, { codex: { command: process.env.CODEX_STAGE_LIVE_BINARY! } })
  try {
    const trigger = feishu('live-stage-1', `Bounded local integration test. Do not use GitHub, Feishu CLI, network, or external applications. No PR is required. Work only in the assigned directory.
Research: write design.txt containing decision=add. Then call orchestrator_stage with request_id=design-done, stage=implementation and a full handoff.
Implementation: read design.txt, write result.txt containing 2+3=5. Then request documentation with request_id=code-done and a full handoff.
Documentation: read both files and write summary.txt containing decision=add;result=5. Report ready with orchestrator_report. Use all five handoff fields purpose, decisions, results, evidence and remaining. After each stage request end the turn immediately without reporting ready.`)
    host.runtime.receive(trigger); await host.runtime.idle()
    await host.route({ kind: 'accept', trigger_id: trigger.id, title: 'Bounded three-stage executor validation', executor: 'codex', worktree_name: 'stage-live', acknowledgement: 'Received: validating the three local stages.', stage: 'research' })
    const ticket = host.runtime.store.tickets.open()[0]!
    await expect.poll(() => host.runtime.store.get(KV.codex.stages(ticket.id))?.turns.filter(turn => turn.actualModel).length, { timeout: 300_000, interval: 1000 }).toBe(3)
    await expect.poll(() => host.runtime.executor.activeCount(), { timeout: 60_000, interval: 500 }).toBe(0)
    const finished = host.runtime.store.tickets.get(ticket.id)!
    expect(finished.assignments.at(-1)?.report?.state).toBe('ready')
    expect(finished.ended).toBeDefined()
    const state = host.runtime.store.get(KV.codex.stages(ticket.id))!
    expect(state.history.map(item => item.stage)).toEqual(['research', 'implementation', 'documentation'])
    expect(state.turns.map(item => item.actualModel)).toEqual(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra'])
    expect(await readFile(resolve(ticket.execution!.directory, 'summary.txt'), 'utf8')).toContain('result=5')
    const page = await host.api('GET', `tickets/${ticket.id}`)
    expect(page.body).toMatchObject({ executionStages: { current: 'documentation', turns: state.turns } })
    await mkdir(resolve('.artifacts'), { recursive: true })
    await writeFile(resolve('.artifacts/stage-live-receipt.json'), JSON.stringify({
      threadId: host.runtime.store.get(KV.codex.binding(ticket.id))?.threadId, stages: state.history.map(item => ({ stage: item.stage, model: item.model })), turns: state.turns,
      artifacts: Object.fromEntries(await Promise.all(['design.txt', 'result.txt', 'summary.txt'].map(async name => [name, await readFile(resolve(ticket.execution!.directory, name), 'utf8')]))),
    }, null, 2))
  } finally { await host.stop() }
}, 360_000)
