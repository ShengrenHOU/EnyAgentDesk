/** Repository scoping for the existing GitHub reader, checkpoints and subscriptions. */
import { family } from '../kv.ts'
import type { SourceContext } from './host.ts'
import { githubThread } from './github-trigger.ts'

export const scopedRepository = (ctx: SourceContext): string | undefined =>
  ctx.deployment.githubRepositories?.length ? ctx.deployment.repository.toLowerCase() : undefined
/** KV key prefix of one monitored repository's Source state; multi-repository deployments scope every key by repository. */
export const repositoryStatePrefix = (repository: string): string => `github-repository:${repository.toLowerCase()}:`
export const githubThreadKey = (ctx: SourceContext, number: number): string =>
  scopedRepository(ctx) ? githubThread(ctx.deployment.repository, number) : `github:${number}`
export const githubThreadId = (ctx: SourceContext, number: number): string => githubThreadKey(ctx, number).slice(7)
export function githubObject(thread: string): { repository?: string; number: number } | undefined {
  const match = /^github:(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+):)?([1-9]\d*)$/.exec(thread)
  if (!match || !Number.isSafeInteger(Number(match[2]))) return undefined
  return { ...(match[1] ? { repository: match[1].toLowerCase() } : {}), number: Number(match[2]) }
}

export function repositoryContext(ctx: SourceContext, repository: string): SourceContext {
  const commands = ctx.commands.forRepository(repository)
  const name = repository.toLowerCase()
  const prefix = repositoryStatePrefix(repository)
  return { ...ctx, deployment: commands.deployment, commands,
    receive: trigger => {
      const legacy = typeof trigger.meta.legacyId === 'string' ? ctx.triggers.get(trigger.meta.legacyId) : undefined
      if (legacy?.meta.repository === name) return 'duplicate'
      return ctx.receive(trigger)
    },
    state: {
      get: key => ctx.state.get(prefix + key),
      set: (key, value) => ctx.state.set(prefix + key, value),
      keys: group => ctx.state.keys(family(prefix + group.prefix)).map(key => key.slice(prefix.length)),
    },
    threads: { ...ctx.threads,
      subscribed: source => ctx.threads.subscribed(source).filter(thread => thread.ref.id.startsWith(`${name}:`)),
    },
  }
}
