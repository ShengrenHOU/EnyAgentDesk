/** Optional DSH memory tools shared with managed Sessions through their native tool scope. */
import type { Context } from '@deepseek-ai/cordis'

const MEMORY_TOOLS = ['memory_read', 'memory_add', 'memory_update', 'memory_delete', 'memory_search', 'memory_review',
  'memory_merge', 'memory_stats', 'memory_browse', 'memory_history', 'memory_rollback']

/** Share only installed memory capabilities; a removed or replaced provider cannot keep executing through an old binding. */
export function registerMemoryTools(host: Context, scope: Context): (() => void)[] {
  const tools = host.get('tools'), disposers: (() => void)[] = []
  if (!tools) return disposers
  for (const name of MEMORY_TOOLS) {
    const definition = tools.get(name)
    if (!definition) continue
    disposers.push(scope.tools.register({ ...definition, execute: async (args, execution) => {
      if (tools.get(name) !== definition) throw new Error('Memory plugin changed; restart this Session before using its memory tools')
      return definition.execute(args, execution)
    } }))
  }
  return disposers
}
