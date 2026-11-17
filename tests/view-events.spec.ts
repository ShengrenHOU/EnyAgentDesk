import { expect, it } from 'vitest'
import { ViewEvents } from '../src/app/view-events.ts'

const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value)
it('starts each subscription with current state and coalesces a slow reader without growing a queue', async () => {
  const events = new ViewEvents(), abort = new AbortController()
  const reader = events.response(abort.signal).body!.getReader()
  expect(decode((await reader.read()).value)).toContain('"revision":0')
  for (let i = 0; i < 100; i++) events.publish()
  await Promise.resolve()
  for (let i = 0; i < 100; i++) events.publish()
  await Promise.resolve()
  expect(decode((await reader.read()).value)).toContain('"revision":1')
  expect(decode((await reader.read()).value)).toContain('"revision":2')
  abort.abort()
  expect((await reader.read()).done).toBe(true)
  const reconnect = events.response(new AbortController().signal).body!.getReader()
  expect(decode((await reconnect.read()).value)).toContain('"revision":2')
  await reconnect.cancel()
  events.close()
  expect(events.response(new AbortController().signal).status).toBe(503)
})

it('closes a pending read on shutdown and handles an already aborted request', async () => {
  const events = new ViewEvents(), abort = new AbortController()
  abort.abort()
  expect((await events.response(abort.signal).body!.getReader().read()).done).toBe(true)
  const reader = events.response(new AbortController().signal).body!.getReader()
  await reader.read()
  const waiting = reader.read()
  events.close()
  expect((await waiting).done).toBe(true)
})
