import { expect, it, vi } from 'vitest'
import { scanWechatActivity } from '../src/sources/activity-wechat.ts'
import type { ActivityReaderContext, ActivityTools } from '../src/sources/activity-types.ts'

it('calls the selected MCP tool without projecting unrelated plugin schemas', async () => {
  const schemas = vi.fn(() => { throw new Error('Unrelated workbench schema cannot be projected') })
  const execute = vi.fn(async () => ({ isError: true, error: { message: 'Selected MCP unavailable' } }))
  const tools = { schemas, execute } as unknown as ActivityTools
  const ctx = { signal: new AbortController().signal, assertActive: () => {}, consumerId: 'test' } as ActivityReaderContext
  await expect(scanWechatActivity(ctx, tools, { serverName: 'wechat_readonly' },
    { start: '2026-11-01T00:00:00Z', end: '2026-11-02T00:00:00Z' })).rejects.toThrow('Selected MCP unavailable')
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'mcp__wechat_readonly__wechat_list_chats' }))
  expect(schemas).not.toHaveBeenCalled()
})
