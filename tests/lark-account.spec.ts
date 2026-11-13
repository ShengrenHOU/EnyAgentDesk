/** Native Cordis ownership, resource counters and event connection teardown. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import * as plugin from '../src/sources/lark-account.ts'
import { consumeLarkBridge, type BridgeEvent } from '../src/sources/lark-events.ts'

vi.mock('../src/sources/lark-events.ts', () => ({ consumeLarkBridge: vi.fn() }))
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose(); vi.resetAllMocks() })
const config = { expectedUserId: 'ou_owner', configDir: '/user', larkCli: '/cli', eventCommand: ['broker', 'sdk'] }
function context() { const ctx = new Context(); contexts.push(ctx); return ctx }
function event(eventType: string): BridgeEvent {
  return { type: 'event', deliveryId: '00000000-0000-4000-8000-000000000001', eventId: 'native-id', eventType, at: '1794500000000', payload: {} }
}

it('keeps one account, one event owner and independent resource counters', async () => {
  const ctx = context(), account = new plugin.LarkAccount(ctx, config)
  const im = vi.fn(), docs = vi.fn(), recovered = vi.fn()
  const unsubscribe = account.subscribe(['im'], async () => true, im)
  account.subscribe(['edit', 'delete'], async () => false, docs, recovered)
  account.connection('ready', 'Connected')
  await account.deliver(event('im')); await account.deliver(event('edit'))
  expect(im).toHaveBeenLastCalledWith(expect.objectContaining({ received: 1, accepted: 1, failed: 0 }))
  expect(docs).toHaveBeenLastCalledWith(expect.objectContaining({ received: 1, accepted: 0, failed: 0 }))
  expect(recovered).toHaveBeenCalledOnce()
  expect(() => account.subscribe(['edit'], async () => true, docs)).toThrow('already has')
  expect(() => account.checkLegacy({ expectedUserId: 'ou_other' })).toThrow('Move the personal')
  expect(() => account.checkLegacy({ expectedUserId: 'ou_owner', configDir: '/user' }, config.eventCommand)).not.toThrow()
  unsubscribe()
  account.subscribe(['im'], async () => { throw new Error('Disk unavailable') }, im)
  await expect(account.deliver(event('im'))).rejects.toThrow('Disk unavailable')
  expect(im).toHaveBeenLastCalledWith(expect.objectContaining({ received: 1, accepted: 0, failed: 1 }))
  expect(docs).toHaveBeenLastCalledWith(expect.objectContaining({ received: 1, failed: 0 }))
})

it('joins the old transport before reloading the account and renews dependent Source bindings', async () => {
  const ctx = context(), changes: string[] = [], bindings: string[] = []
  let live = 0, maximum = 0
  vi.mocked(consumeLarkBridge).mockImplementation(async (command, signal) => {
    live++; maximum = Math.max(maximum, live); changes.push(`start:${command[1]}`)
    await new Promise<void>(resolve => signal.addEventListener('abort', () => setTimeout(resolve, 5), { once: true }))
    live--; changes.push(`stop:${command[1]}`)
  })
  ctx.reflect.provide('orchestrator', {
    context: () => ({ ready: Promise.resolve(), configured: () => true }),
    runSource: (run: (signal: AbortSignal) => Promise<void>) => {
      const controller = new AbortController(), running = run(controller.signal)
      return async () => { controller.abort(); await running }
    },
  } as never)
  const source = ctx.inject(['larkAccount'], source => {
    bindings.push(source.larkAccount.binding.expectedUserId)
    source.effect(() => source.larkAccount.subscribe(['im'], async () => true, () => {}))
  })
  const owner = await ctx.plugin(plugin, config)
  await source
  await vi.waitFor(() => expect(live).toBe(1))
  await owner.update({ ...config, expectedUserId: 'ou_next', eventCommand: ['broker', 'next'] })
  await vi.waitFor(() => expect(bindings).toEqual(['ou_owner', 'ou_next']))
  expect(maximum).toBe(1)
  expect(changes).toEqual(['start:sdk', 'stop:sdk', 'start:next'])
  await source.dispose()
  expect(live).toBe(1)
  await owner.dispose()
  expect(live).toBe(0)
  expect(ctx.get('larkAccount')).toBeUndefined()
})
