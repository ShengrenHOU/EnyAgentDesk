import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import { registerMemoryTools } from '../src/app/memory-tools.ts'

it('shares installed memory tools across intersecting native masks without exposing imports or unrelated tools', async () => {
  const host = new Context()
  host.reflect.provide('systemPrompt', { tools: () => () => {} })
  const tools = new ToolRuntime(host)
  const execute = vi.fn(async () => ({ remembered: true }))
  const definition = (name: string) => ({ name, description: name, parameters: { type: 'object' as const },
    output: { schema: { type: 'object' as const, additionalProperties: true }, render: () => [{ type: 'text' as const, text: 'done' }] }, execute })
  tools.register(definition('read'))
  const removeMemory = tools.register(definition('memory_add'))
  tools.register(definition('memory_import'))
  tools.register(definition('schedule_create'))
  const key = {}, scope = createScope(host, key)
  scope.ctx.tools.restrict({ allow: ['read'] })
  scope.ctx.tools.restrict({ deny: ['memory_add'] })
  expect(tools.get('memory_add', key)).toBeUndefined()
  const release = registerMemoryTools(host, scope.ctx)
  try {
    const memory = tools.get('memory_add', key)
    expect(memory).toBeDefined()
    expect(tools.get('memory_import', key)).toBeUndefined()
    expect(tools.get('schedule_create', key)).toBeUndefined()
    await expect(memory!.execute({}, {} as never)).resolves.toEqual({ remembered: true })
    removeMemory()
    await expect(memory!.execute({}, {} as never)).rejects.toThrow('Memory plugin changed')
    expect(execute).toHaveBeenCalledOnce()
  } finally {
    for (const dispose of release.reverse()) dispose()
    await scope.dispose()
  }
})

it('does not add tools when no memory provider is installed', () => {
  const host = new Context(), scope = new Context()
  expect(registerMemoryTools(host, scope)).toEqual([])
})
