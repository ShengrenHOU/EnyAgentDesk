/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, proxyVariables, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

const accountFields = (settings: Settings) =>
  JSON.stringify(Object.entries(SETUP_FIELDS).map(([id, keys]) => keys.map(key => settings.sources[id]?.config[key] ?? (id === 'github' && key === 'repositories' ? [] : ''))))
export const accountsChanged = (before: Settings, after: Settings): boolean => accountFields(before) !== accountFields(after)
export const setupChanged = (before: Settings, after: Settings): boolean => accountsChanged(before, after)
  || before.sources.github?.enabled !== after.sources.github?.enabled
  || before.executor.proxy !== after.executor.proxy
/** An absent Source imposes no account requirement on a native-only workbench. */
export const needsGithub = (settings: Settings) => settings.sources.github?.enabled === true
  || !!settings.sources.github?.config.repository || !!settings.sources.github?.config.cli

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  /** A GitHub account or repository problem that leaves the rest of the deployment usable. */
  githubProblem?: SetupProblem
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  /** Outbound proxy of the last resolved settings, reused by host commands between setup runs. */
  private proxy = ''
  /**
   * Host command environment with agent git variables and the configured proxy, and the worker shim
   * directory excluded from PATH. `Commands` holds this object for the process lifetime, so a later
   * setup run updates the proxy entries in place instead of replacing the object it already has.
   */
  readonly commandEnvironment: Record<string, string | undefined>
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
    this.commandEnvironment = { ...this.variables, ...proxyVariables(this.proxy), PATH: this.path }
  }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem && !this.githubProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    const check = block === 'source:feishu' ? resolveFeishuBot(machine, settings.sources.feishu?.config, this.probe(settings))
      : resolveDeployment(machine, settings.sources.github?.config, this.probe(settings), undefined, needsGithub(settings))
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === block.slice(7)) throw error })
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe(settings: Settings) {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime, proxyVariables(settings.executor.proxy))
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe(settings)
    this.problem = undefined
    this.githubProblem = undefined
    this.feishuProblem = undefined
    // GitHub is one Source, not the deployment gate: an unreadable account or an unreachable API
    // leaves Feishu, the workbench and local execution usable, so it degrades instead of blocking.
    const deployment = await resolveDeployment(machine, settings.sources.github?.config, probe, undefined, needsGithub(settings))
      .catch(async (error: unknown) => {
        if (!(error instanceof SetupError) || error.place !== 'github') throw error
        this.githubProblem = error.problem
        context.logger.warn('dsh-superagent leaves GitHub out: %s', error.message)
        return resolveDeployment(machine, settings.sources.github?.config, probe, undefined, false)
      })
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    // The proxy belongs to the settings, not the launching shell: a save therefore re-applies it without
    // a process restart, and an empty value removes whatever the host process inherited.
    this.proxy = settings.executor.proxy
    Object.assign(this.commandEnvironment, proxyVariables(this.proxy))
    this.restoreEnvironment = applyEnvironment({ ...this.variables, ...proxyVariables(this.proxy) }, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
