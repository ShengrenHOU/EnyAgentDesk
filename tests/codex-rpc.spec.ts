import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { CodexRpc } from '../src/executor/codex-rpc.ts'

const fixture = fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url))
const clients: CodexRpc[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map(rpc => rpc.close())) })
async function connect(timeoutMs = 3000) {
  const notification = vi.fn(), disconnected = vi.fn(), request = vi.fn(async () => ({ accepted: true }))
  const rpc = await CodexRpc.connect({ command: process.execPath, args: [fixture], cwd: process.cwd(),
    timeoutMs, notification, disconnected, request })
  clients.push(rpc)
  return { rpc, notification, disconnected, request }
}
describe('Codex App Server transport', () => {
  it('keeps the Codex home but removes the launching desktop chat identity and tool pipe', async () => {
    const rpc = await CodexRpc.connect({ command: process.execPath, args: [fixture], cwd: process.cwd(),
      env: { ...process.env, CODEX_HOME: 'fixture-home', CODEX_THREAD_ID: 'parent-thread', CODEX_APP_TOOLS_PIPE_PATH: 'parent-pipe' },
      notification: () => {}, request: async () => ({}), disconnected: () => {} })
    clients.push(rpc)
    expect(await rpc.call('environment', {})).toEqual({ parentThread: false, parentPipe: false, home: 'fixture-home' })
  })
  it('handshakes, correlates concurrent responses, and answers server tool requests', async () => {
    const { rpc, notification, request } = await connect()
    expect(await Promise.all([rpc.call('echo', { value: 'one' }), rpc.call('echo', { value: 'two' })]))
      .toEqual([{ value: 'one' }, { value: 'two' }])
    await rpc.call('tool', {})
    await vi.waitFor(() => expect(notification).toHaveBeenCalledWith('fixture/toolResult', { accepted: true }))
    expect(request).toHaveBeenCalledWith('item/tool/call', { name: 'test' })
  })
  it('rejects pending calls and reports a disconnect on process exit', async () => {
    const { rpc, disconnected } = await connect()
    await expect(rpc.call('exit', {})).rejects.toThrow('exited')
    expect(disconnected).toHaveBeenCalledTimes(1)
    await expect(rpc.call('echo', {})).rejects.toThrow('disconnected')
  })
  it('fails closed on malformed output', async () => {
    const { rpc, disconnected } = await connect()
    await expect(rpc.call('invalid', {})).rejects.toThrow('Invalid Codex protocol')
    expect(disconnected).toHaveBeenCalledTimes(1)
  })
  it('does not retry an operation whose response timed out', async () => {
    const { rpc, disconnected } = await connect(500)
    await expect(rpc.call('hold', {})).rejects.toThrow('outcome is unknown')
    expect(disconnected).toHaveBeenCalledTimes(1)
  })
})
