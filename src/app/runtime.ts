/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { ExecutorRouter } from '../executor/router.ts'
import { reportExcerpt, ticketCard } from './cards.ts'
import { AutomaticTriage } from './automatic-triage.ts'
import { automaticTriageTools } from './tools/automatic-triage.ts'
import { ProductionTriage, productionOverview } from './production-triage.ts'
import { productionTriageTools } from './tools/production-triage.ts'
import { ShadowTriage } from './triage.ts'
import { TriageHandoffs } from './triage-handoffs.ts'
import { triageHandoffTools } from './tools/triage-handoffs.ts'
import { triageTools } from './tools/triage.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { migrateGithubIdentity } from './github-migration.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects, Later } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { relatedLines } from './cards.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Followups, type SchedulePort } from './followups.ts'
import { followupTools } from './tools/followup.ts'
import { managementTools } from './tools/management.ts'
import { routingTools, type ExecutorTransfer } from './tools/routing.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor | ExecutorRouter
  readonly assessor: MasterAssessor
  readonly automaticTriage: AutomaticTriage
  readonly productionTriage: ProductionTriage
  readonly triage: ShadowTriage
  readonly triageHandoffs: TriageHandoffs
  readonly outbox: Outbox
  readonly engine: Engine
  readonly followups: Followups
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  /** When this instance started, reported as the running artifact's activation time. */
  readonly startedAt = new Date().toISOString()
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private readonly sourceRuns = new Set<Promise<unknown>>()
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    let adopted = false
    using lockOnFailure = { [Symbol.dispose]() { if (!adopted) release() } }
    super(ctx, 'orchestrator')
    adopted = true
    const runtime = this
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      this.triage = new ShadowTriage({ store, evidence: trigger => sources.imEvidence(trigger),
        context: trigger => sources.imContext(trigger, commands), paused: () => store.settings().paused })
      const links: LinkHost = { store, lines: store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, sources, masterId, context: ctx,
        productionOverview: page => productionOverview(store, trigger => sources.imEvidence(trigger), page, trigger => sources.imHeader(trigger)),
        get matters() { return runtime.productionTriage?.matters },
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        assessmentsPaused: () => this.paused(),
        assessmentCurrent: notice => {
          if (notice.kind === 'im_production_judgment') return this.productionTriage?.noticeCurrent(notice.id, notice.generation!) ?? false
          return store.threads.active().some(thread => thread.evaluating?.id === notice.id)
        },
        tools: (agent, ticket) => ticket ? [...executorTools(this.toolHost, ticket), ...followupTools(this.followups, ticket.id), ...managementTools((id, patch) => runtime.engine.updateTicketManagement(id, patch), () => this.passes.request(), ticket.id)] : [...mainTools(this.toolHost, agent), ...(machine.triageHandoff ? automaticTriageTools(this.automaticTriage) : []), ...(machine.triageProduction ? productionTriageTools(this.productionTriage) : []), ...(machine.triageShadow ? triageTools(this.triage) : []), ...(machine.triageHandoff ? triageHandoffTools(this.triageHandoffs) : []), ...followupTools(this.followups), ...managementTools((id, patch) => runtime.engine.updateTicketManagement(id, patch), () => this.passes.request()), ...machine.codex ? routingTools((id, request) => this.transferExecutor(id, request)) : []] })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      const executorHost = { context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        guardExecution: async (ticket: Ticket) => { await sources.guardExecution(store.triggers.get(ticket.origin.triggerId), commands, ticket) },
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), launchReady: (id: string) => effects.launchReady(id), ticketPaused: (id: string) => !!store.tickets.get(id)?.paused, environment, sourceLink: link,
        repliedTo: (trigger: Trigger) => repliedTo({ store, sources }, trigger) }
      this.executor = machine.codex ? new ExecutorRouter({ ...executorHost, get engine() { return runtime.engine }, codex: machine.codex,
        tools: ticket => [...executorTools(this.toolHost, ticket), ...followupTools(this.followups, ticket.id), ...managementTools((id, patch) => runtime.engine.updateTicketManagement(id, patch), () => this.passes.request(), ticket.id)],
        prompt: ticket => prompts.compose(prompts.current().config, 'worker', environment(ticket))
          + '\n\nThe dsh-superagent source skills referred to above are supplied inline below.\n'
          + prompts.skills(prompts.current().config).map(([name, text]) => `## dsh-superagent-${name}\n${text}`).join('\n\n') }) : new DshExecutor(executorHost)
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        // A candidate must wake a main Session that has no turn running: a steer is only taken at a
        // running turn's next step, so a quiet coordinator would never decide and the Eval would expire.
        // The deadline starts after durable consumption, before unrelated unread input can delay acknowledgement.
        deliver: async (id, text) => { await sessions.assessment(id, text, () => { if (this.paused()) throw new Later('Assessments are paused'); if (!store.threads.active().some(thread => `candidate:${thread.evaluating?.id}` === id)) throw new Error('Assessment no longer current') }) },
        candidateState: id => sessions.candidateState(id), candidateCard: candidate => candidateCard(links, candidate),
        relatedLines: text => relatedLines(store, text) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, externalAssessments: () => this.productionTriage?.activeCount() ?? 0, deferEvaluation: trigger => this.automaticTriage?.defer(trigger) ?? false, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended) {
            this.followups?.cancel(ended.id)
            void this.followups?.cancelAutomations(ended.id).catch(error => {
              ctx.logger.warn('dsh-superagent could not remove migrated automations for %s: %s', ended.id, String(error))
            })
          }
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      const followups = this.followups = new Followups({ store, engine, paused: () => this.paused(),
        masterId, schedule: () => ctx.get('schedule') as SchedulePort | undefined,
        authorized: ticket => policy().revalidate(ticket.mandate) })
      this.triageHandoffs = new TriageHandoffs({ store, engine, evidence: trigger => sources.imEvidence(trigger),
        policyVersion: () => policy().version, enabled: () => !!machine.triageHandoff })
      this.productionTriage = new ProductionTriage({ store, engine, handoffs: this.triageHandoffs, effects,
        header: trigger => sources.imHeader(trigger),
        evidence: trigger => sources.imEvidence(trigger), context: trigger => sources.imContext(trigger, commands),
        enabled: () => !!machine.triageProduction, automaticEnabled: () => !!machine.triageAutomatic, paused: () => this.paused(), policy: () => policy().version,
        prompt: () => String(prompts.current().revision),
        timeoutMs: () => policy().evalTimeoutMs, prune: () => sessions.pruneAssessments(),
        deliver: (id, text, authorize) => sessions.assessment(id, text, authorize) })
      this.automaticTriage = new AutomaticTriage({ store, engine, handoffs: this.triageHandoffs, production: this.productionTriage,
        evidence: trigger => sources.imEvidence(trigger), enabled: () => !!machine.triageAutomatic,
        historical: () => !!machine.triageHistorical, paused: () => this.paused(), policy: () => policy().version, prompt: () => String(prompts.current().revision) })
      // Bind tickets created by an earlier version to the executor that owned them before any work is dispatched.
      if (this.executor instanceof ExecutorRouter) this.executor.migrateLegacyBindings()
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => {
        this.productionTriage.maintain(); this.automaticTriage.maintain(); sessions.pruneAssessments(); engine.evaluateDue(); followups.runDue(); evals.set(evalsHealth(store))
        void followups.maintain().catch(error => ctx.logger.warn('dsh-superagent could not reconcile automations: %s', String(error)))
      }
      const passes = this.passes = new Passes({ engine: { receive: trigger => this.automaticTriage.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        matters: this.productionTriage.matters,
        routingRequirements: () => ({ executor: !!machine.codex, stage: !!machine.codex && !machine.codex.model }),
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> {
    const { held, owners } = this.store.triageHandoffStatus()
    return { ...this.board.all, ...(held ? { triageHandoff: { state: 'error' as const,
      detail: `${held} IM evidence held awaiting context and production judgment (not processed). Owners: ${owners.join(', ')}. Explicit release required before downgrade.` } } : {}) }
  }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  runSource(run: (signal: AbortSignal) => Promise<unknown>): () => Promise<void> {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.lifetime])
    const running = Promise.resolve().then(() => signal.aborted ? undefined : run(signal))
    const settled = running.then(() => {}, error => {
      this.ctx.logger.warn('Source stopped with an error: %s', String(error))
    })
    this.sourceRuns.add(settled)
    void settled.then(() => { this.sourceRuns.delete(settled) })
    return async () => { controller.abort(); await settled }
  }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  async transferExecutor(id: string, request: ExecutorTransfer) {
    if (!(this.executor instanceof ExecutorRouter)) throw new Error('This profile has only a DSH executor')
    const result = await this.executor.transfer(id, request.executor, request.handoff,
      (ticketId, text) => { this.engine.note(ticketId, text) }, request.stage)
    this.passes.request()
    return result
  }
  continueStopped(id: string, instruction: string) {
    if (this.machine.codex) throw new Error('This continuation path requires the DSH-only profile')
    const ticket = this.store.tickets.get(id)
    if (!ticket?.execution || ticket.ended?.outcome !== 'stopped') throw new Error('Select a stopped task with an existing workspace')
    const previous = ticket.execution.executor ?? 'codex'
    // The handoff carries conclusions and key figures; every full report stays behind its ticket report resource.
    const reports = ticket.assignments.flatMap(assignment => {
      const excerpt = assignment.report && assignment.report.state !== 'failed' ? reportExcerpt(ticket, assignment) : undefined
      return excerpt ? [JSON.stringify(excerpt)] : []
    }).slice(-3)
    const handoff = { purpose: ticket.title, decisions: 'Retain the original mandate and recorded owner decisions; inspect ticket history before acting.',
      results: reports.join('\n\n') || 'No successful report recorded; inspect existing artifacts before continuing.',
      evidence: `Original ticket ${id}; workspace ${ticket.execution.directory}; original messages and execution records remain available.`, remaining: instruction }
    const result = this.engine.continueStoppedTicket(id, `${instruction}\n\nExecution handoff to DSH:\n${JSON.stringify(handoff)}`,
      { from: previous, to: 'dsh', at: new Date().toISOString(), handoff })
    this.passes.request()
    return { continued: true as const, ticketId: result.id, executor: 'dsh' as const }
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    const deployment = this.setup.deployment
    if (deployment.github && (deployment.githubRepositories?.length || this.store.get('github-identity-repository'))) {
      deployment.githubRepositories ??= [deployment.repository.toLowerCase()]
      const original = this.store.settingsHistory(10000).find(version => {
        const config = version.settings.sources.github?.config
        return typeof config?.repository === 'string' && config.repository && (!Array.isArray(config.repositories) || !config.repositories.length)
      })?.settings.sources.github?.config.repository
      migrateGithubIdentity(this.store, typeof original === 'string' ? original : deployment.repository)
    }
    this.sessions.install()
    this.executor.install()
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'Superagent 主对话', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, get health() { return runtime.health }, machine, masterId, startedAt: this.startedAt, ready, sourceLinks,
      get deployment() { return setup.deployment }, followups: this.followups, transferExecutor: (id, request) => this.transferExecutor(id, request),
      continueStopped: (id, instruction) => this.continueStopped(id, instruction),
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      get githubProblem() { return setup.githubProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    try {
      await Promise.allSettled(this.sourceRuns)
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
