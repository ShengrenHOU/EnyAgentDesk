import { afterEach, expect, it, vi } from 'vitest'
import { DshExecutor, type ExecutorHost } from '../src/executor/dsh.ts'
import type { Ticket } from '../src/core/index.ts'

afterEach(() => { vi.useRealTimers() })

/** Isolate executor recovery callbacks; no model, filesystem or external service runs. */
function fixture() {
  let ticket = { id: 'ticket', title: 'Recovery test', inputs: [], undelivered: [],
    origin: { triggerId: 'trigger', triggerIds: ['trigger'] }, mandate: { strength: 'explicit' },
    updatedAt: '2026-11-15T00:00:00.000Z',
    assignments: [{ id: 'old', state: 'running' }] } as unknown as Ticket
  let closed = false
  const callbacks = new Map<string, (event: unknown) => void>()
  const prompt = Promise.withResolvers<void>()
  let beforeInsert: (() => void) | undefined
  const report = vi.fn((_id: string, value: unknown, expected?: string) => {
    expect(expected).toBe(ticket.assignments.at(-1)!.id)
    Object.assign(ticket.assignments.at(-1)!, { report: value })
    return ticket
  })
  const relay = vi.fn()
  const host = {
    context: {
      on: (name: string, callback: (event: unknown) => void) => { callbacks.set(name, callback); return () => {} },
      agents: { get: () => ({ status: 'idle' }) },
    },
    store: { tickets: { get: () => ticket }, atomic: (fn: () => unknown) => fn() },
    slots: { reserve() {}, free() {} }, effects: { handle() {} }, health: { get: () => undefined, set() {} },
    lifetime: new AbortController().signal, paused: () => false, closing: () => closed,
    sessions: {
      prompt: vi.fn((_session: string, _id: string, _text: string, _delivery: unknown, validate?: () => void) => {
        beforeInsert = validate; return prompt.promise
      }),
      relay,
    },
    engine: { report },
  } as unknown as ExecutorHost
  const executor = new DshExecutor(host)
  executor.install()
  const fail = (error: Error) => callbacks.get('agent/error')!({ agent: { id: 'worker-ticket' }, error })
  return {
    executor, prompt, report, relay, host, fail,
    current: () => ticket, validate: () => beforeInsert?.(),
    replace: () => {
      ticket = { ...ticket, assignments: [{ ...ticket.assignments[0]!, state: 'ended' },
        { id: 'new', state: 'pending', createdAt: new Date().toISOString() }] }
    },
    close: () => { closed = true },
  }
}

it('ignores an old retry prompt rejection after its Assignment was replaced', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = fixture()
  try {
    f.fail(Object.assign(new Error('Service Unavailable'), { status: 503 }))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(f.host.sessions.prompt).toHaveBeenCalledOnce()
    f.replace()
    expect(() => f.validate()).toThrow('Retry assignment changed')
    f.prompt.reject(new Error('old persistence failure'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.report).not.toHaveBeenCalled()
    expect(f.relay).not.toHaveBeenCalled()
    expect(f.current().assignments.at(-1)?.report).toBeUndefined()
  } finally { f.executor.dispose() }
})

it('still reports a retry prompt failure belonging to the current Assignment', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = fixture()
  try {
    f.fail(Object.assign(new Error('Service Unavailable'), { status: 503 }))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(() => f.validate()).not.toThrow()
    f.prompt.reject(new Error('current persistence failure'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.report).toHaveBeenCalledWith('ticket', { state: 'failed', summary: 'Error: current persistence failure' }, 'old')
    expect(f.relay).toHaveBeenCalledOnce()
  } finally { f.executor.dispose() }
})

it('ignores a queued non-transient error after Assignment replacement', async () => {
  const f = fixture()
  try {
    f.fail(new Error('permanent provider failure'))
    f.replace()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.report).not.toHaveBeenCalled()
    expect(f.relay).not.toHaveBeenCalled()
  } finally { f.executor.dispose() }
})

it('does not write failure state while the host is closing', async () => {
  const f = fixture()
  try {
    f.fail(new Error('permanent provider failure'))
    f.close()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.report).not.toHaveBeenCalled()
  } finally { f.executor.dispose() }
})
