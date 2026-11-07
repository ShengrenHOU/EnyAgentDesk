/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  // A stopped process leaves the plugin's state lock behind; it is only stale after 30 s, and the
  // constructor takes the lock synchronously. Waiting here turns a force-stop into a slow start
  // instead of a failed activation that leaves the whole panel and its Sources down.
  let runtime: Runtime | undefined
  for (let attempt = 0; runtime === undefined; attempt++) {
    try { runtime = new Runtime(ctx, machine, restart) }
    catch (error) {
      const locked = error instanceof Error && /already being held/i.test(error.message)
      if (!locked || attempt >= 16) throw error
      ctx.logger.warn('dsh-superagent waits for the previous state lock (%d/16)', attempt + 1)
      await new Promise(resolve => setTimeout(resolve, 2_500))
    }
  }
  const created = runtime
  ctx.effect(() => async () => { await created.stop() })
  await created.ready
  ctx.logger.info(created.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${created.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
