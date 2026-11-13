/** Shared read-only polling for the Lark workspace Sources: mail, Feishu tasks and the calendar. */
import { setTimeout as delay } from 'node:timers/promises'
import type { SourceContext } from './host.ts'
import { health } from './host.ts'

export type WorkspaceConfig = { pollSeconds: number; failuresBeforeError: number; events?: boolean }
/** Runs one round and returns the detail the Source reports while it is healthy. */
export type WorkspaceRound = (ctx: SourceContext, signal: AbortSignal) => Promise<string>
/**
 * Follows one Source's switch and configuration, keeps consecutive failures, and stops as soon as the plugin or the
 * Runtime aborts. A Source without configuration waits instead of reading with stale settings.
 */
export async function runWorkspaceSource(ctx: SourceContext, kind: string, signal: AbortSignal, round: WorkspaceRound,
  clock: () => number = Date.now): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent while it resolves the accounts; reading before that would use an unverified identity.
  if (!ctx.configured()) { ctx.report(kind, health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<WorkspaceConfig>(kind)
    if (!config) {
      ctx.report(kind, health('paused', 'sourceOff'))
      await delay(30_000, undefined, { signal }).catch(() => {})
      continue
    }
    try {
      const detail = await round(ctx, signal)
      failures = 0
      if (!signal.aborted) ctx.report(kind, { state: 'ready', detail, at: new Date(clock()).toISOString() })
    } catch (error) {
      if (signal.aborted) return
      failures += 1
      // One transient failure is retried; only a run of failures asks a person to look.
      if (failures >= config.failuresBeforeError) ctx.report(kind, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
      else ctx.report(kind, { state: 'starting', detail: `${failures} consecutive failed poll(s); last: ${String(error)}` })
    }
    await delay((config.events ? 5 : config.pollSeconds) * 1000, undefined, { signal }).catch(() => {})
  }
}
