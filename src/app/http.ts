/** Loopback-only management HTTP routes with same-origin enforcement for the web panel. */
import { TriageMatters } from './triage-matters.ts'
import { productionOverview } from './production-triage.ts'
import type { ProductionTriage } from './production-triage.ts'
import type { AutomaticTriage } from './automatic-triage.ts'
import { AutomaticRecoverySchema } from './automatic-triage.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { ExecutorTransferSchema, type ExecutorTransfer } from './tools/routing.ts'
import { FollowupRequestSchema, type Followups } from './followups.ts'
import { THREAD_FILTERS, TICKET_FILTERS, type Api, type ApiResponse, type RouteParams } from './api.ts'
import { sourceSkills } from './context.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import { policyVersion } from '../policy.ts'
import { KV } from '../kv.ts'
import { packageIdentity, runtimeVersion } from '../infra/version.ts'
import { repositoryStatePrefix } from '../sources/github-context.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { UserError, type EngineForPeople, type Ticket } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Health } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { overview } from './views/overview.ts'
import { settingsView } from './views/settings.ts'
import { sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from './views/tickets.ts'
import { ManagementPatchSchema, updateTicketManagement } from './management.ts'
import { detail as lineDetail, linesView, MembershipConflict, reassign } from './lines.ts'

export interface HttpHost {
  readonly automaticTriage: Pick<AutomaticTriage, 'status' | 'recover'>
  readonly productionTriage: Pick<ProductionTriage, 'retry'>
  continueStopped?(id: string, instruction: string): { continued: true; ticketId: string; executor: 'dsh' }
  readonly store: Store
  /** Feishu message links resolved since startup, used by search to match AppLink URLs. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels'>
  transferExecutor?(id: string, request: ExecutorTransfer): Promise<{ changed: boolean; executor: 'codex' | 'dsh' }>
  readonly followups: Pick<Followups, 'schedule' | 'cancel' | 'list' | 'pending' | 'migrate' | 'automations' | 'cancelAutomation'>
  readonly engine: EngineForPeople
  readonly executor: Pick<DshExecutor, 'activeCount'>
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** When this dsh-superagent instance started, the activation time of the running artifact. */
  readonly startedAt: string
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  /** Resolved deployment; throws if read while waiting for setup (`!configured()`). */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  readonly githubProblem?: SetupProblem | undefined
  configured(): boolean
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  requestPass(): void
  models(): Promise<ModelCatalog>
}
/**
 * Represents a client-facing 400 or 404 error raised during management route parsing or lookup.
 * Route handlers throw it when request bodies are malformed or target records are missing, and registerHttp serializes its status and message in the HTTP response.
 */
class RouteError extends Error { constructor(readonly status: 400 | 404 | 409, message: string) { super(message) } }
async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  // An empty payload is no body, so a route whose body is optional can accept it; a malformed non-empty body is still 400.
  if (!text.trim()) return undefined
  try { return JSON.parse(text) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}
/** Maps errors to HTTP status codes and structured payloads that the panel localizes in the interface language. */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError) return [error.status, { error: error.message }]
  if (error instanceof UserError) return [error.missing ? 404 : 400, { error: error.message, code: error.code, values: error.values }]
  if (error instanceof SettingsConflict || error instanceof PromptConflict) return [409, { error: error.message }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function machineView({ stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, codex }: Machine) {
  return { stateDir, promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get(),
    executor: { kind: codex ? 'codex' as const : 'dsh' as const, model: codex?.model ?? null },
    prepareShell: process.platform === 'win32' ? 'powershell' as const : 'sh' as const }
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.configured() ? runtime.deployment : undefined
  return {
    machine: machineView(runtime.machine), problem: runtime.setupProblem ?? null, feishuProblem: runtime.feishuProblem ?? null,
    githubProblem: runtime.githubProblem ?? null,
    accounts: resolved ? { repository: resolved.repository, agent: resolved.github?.login ?? null, feishu: resolved.feishu ? { appId: resolved.feishu.appId, brand: resolved.feishu.brand, botId: resolved.feishu.botId, name: resolved.feishu.name } : null } : null,
  }
}
/** The default-branch commit the GitHub Source last reported, compared with the running build's recorded source. */
export function sourceHead(runtime: HttpHost) {
  if (!runtime.configured()) return undefined
  const { repository, githubRepositories } = runtime.deployment
  // A multi-repository deployment scopes every Source checkpoint by repository, as the GitHub poller does.
  const prefix = githubRepositories?.length ? repositoryStatePrefix(repository) : ''
  const ci = runtime.store.get(`${prefix}${KV.github.branchCi}` as typeof KV.github.branchCi)
  return ci ? { repository, branch: ci.branch, head: ci.head, observedAt: ci.observedAt } : undefined
}
/** Build the `/orchestrator/api/state` response consumed by the management panel and `scripts/dsh-superagent status` (`docs/006-deployment.md`). */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings()
  return { setup: setupView(runtime), load: { ...executorLoad(runtime.store, runtime.executor.activeCount()),
    maxWorkers: settings.executor.maxWorkers },
    triageHandoff: runtime.store.triageHandoffStatus(),
    ...(runtime.machine.triageHandoff || runtime.machine.triageProduction ? { triageRecovery: {
      intake: !!runtime.machine.triageHandoff, production: !!runtime.machine.triageProduction } } : {}),
    masterId: runtime.masterId, paused: settings.paused, health: runtime.health,
    runtime: runtimeVersion(packageIdentity(), runtime.startedAt, sourceHead(runtime)) }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem, feishuProblem: runtime.feishuProblem, githubProblem: runtime.githubProblem })
export type StateView = ReturnType<typeof stateView>
/** Builds a ticket's detail view; `environment` is empty while waiting for setup because it requires the resolved deployment. */
function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  return { ...detail, environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [] }
}
export type TicketPageView = ReturnType<typeof ticketPage>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number) {
  const current = runtime.prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(revision)
  // Each built-in part with the key of its text, which an override records as its base, and for the overrides shown whose
  // built-in text changed since, the text they were edited from when known.
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, current: shown, defaults: defaultPrompts(), sections: TEAM_SECTIONS, skillName: SKILL_NAME.source,
    builtin: Object.keys(sourceSkills), skillPrefix: SKILL_PREFIX, parts, defaultChanged: runtime.prompts.defaultChanged(shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

interface Input<K extends keyof Api> {
  params: RouteParams<K>; query: Record<string, string>; body: (maxBytes?: number) => Promise<unknown>
}
type Routes = { [K in keyof Api]: (input: Input<K>) => ApiResponse<K> | Promise<ApiResponse<K>> }
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), offset, limit: limit(20, 1000) })
const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const count = z.coerce.number().int().nonnegative()
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const SourceBlock = z.templateLiteral(['source:', z.string().regex(/^[a-z][a-z0-9-]*$/)])
const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor']), SourceBlock])
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })

function routes(runtime: HttpHost): Routes {
  const { store } = runtime
  const matterViews = new TriageMatters(store, trigger => runtime.sources.imEvidence(trigger), trigger => runtime.sources.imHeader(trigger))
  const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const promptBody = (input: { body: (maxBytes?: number) => Promise<unknown> }) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  return {
    'GET state': () => stateView(runtime),
    'GET automatic-triage': ({ query }) => {
      if (!runtime.machine.triageHandoff) throw new RouteError(400, 'Triage handoff is disabled')
      return runtime.automaticTriage.status(z.object({ after: count.default(0) }).parse(query).after)
    },
    'POST automatic-triage/recover': async ({ body }) => {
      if (!runtime.machine.triageHandoff) throw new RouteError(400, 'Triage handoff is disabled')
      const input = AutomaticRecoverySchema.parse(await body())
      const result = runtime.automaticTriage.recover(input.owners, input.action)
      runtime.requestPass()
      return result
    },
    'POST production-triage/:id/retry': async ({ params, body }) => {
      if (!runtime.machine.triageProduction) throw new RouteError(400, 'Production triage is disabled')
      const { generation } = z.object({ generation: z.number().int().positive() }).strict().parse(await body())
      const result = runtime.productionTriage.retry(params.id, generation)
      runtime.requestPass()
      return { id: result.id, generation: result.generation, state: result.state }
    },
    'GET followups': () => runtime.followups.pending(),
    'GET followups/automations': () => runtime.followups.automations(),
    'GET production-triage': ({ query }) => productionOverview(store, trigger => runtime.sources.imEvidence(trigger),
      z.object({ before: z.coerce.number().int().positive().optional(), limit: limit(50, 100),
        unresolved: z.enum(['true', 'false']).transform(value => value === 'true').optional() }).parse(query),
      trigger => runtime.sources.imHeader(trigger)),
    'GET triage-matters': ({ query }) => matterViews.overview(
      z.object({ before: z.coerce.number().int().positive().optional(), limit: limit(25, 100),
        active: z.enum(['true', 'false']).transform(value => value === 'true').optional() }).parse(query)),
    'GET overview': () => overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.feishuProblem),
    'GET search': ({ query }) => search(views(runtime), query.q ?? '', runtime.sourceLinks),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime), runtime.machine.stateDir),
    'POST sources/:id/labels': ({ params }) => runtime.settings.refreshLabels(params.id),
    'GET threads': ({ query }) => {
      const { filter, offset, limit } = ThreadsQuery.parse(query)
      return threadList(views(runtime), filter, offset, limit)
    },
    'GET threads/:key': ({ params, query }) => {
      const { limit, before, around } = ThreadQuery.parse(query)
      const detail = threadDetail(views(runtime), params.key, before, limit, around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': async ({ params }) => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    },
    'POST triggers/:id/requeue': ({ params }) => {
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    },
    'GET decisions': ({ query }) => {
      const { kind, window, offset, limit } = DecisionsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), kind.split(',').filter(Boolean), offset, limit, since)
    },
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'GET tickets': ({ query }) => {
      const { state, offset, limit } = TicketsQuery.parse(query)
      return ticketList(views(runtime), state, offset, limit)
    },
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'GET tickets/:id/evidence': ({ params, query }) => {
      if (!store.tickets.get(params.id)) throw new RouteError(404, 'Ticket not found')
      const { before } = z.object({ before: z.coerce.number().int().positive().optional() }).parse(query)
      return matterViews.workEvidence({ kind: 'ticket', id: params.id }, before)
    },
    'GET lines': () => linesView(store),
    'GET lines/:id/evidence': ({ params, query }) => {
      if (!lineDetail(store, params.id)) throw new RouteError(404, 'Line not found')
      const { before } = z.object({ before: z.coerce.number().int().positive().optional() }).parse(query)
      return matterViews.workEvidence({ kind: 'line', id: params.id }, before)
    },
    'GET lines/:id': ({ params }) => {
      const line = lineDetail(store, params.id)
      if (!line) throw new RouteError(404, 'Line not found')
      return line
    },
    'POST lines/:id/membership': async ({ params, body }) => {
      const input = z.object({ ticketId: z.string().trim().min(1), targetLineId: z.string().trim().min(1).nullable(),
        evidence: z.string().trim().min(1).max(1000) }).strict().parse(await body())
      try { return reassign(store, { lineId: params.id, ...input, by: 'owner' }) }
      catch (error) {
        if (error instanceof MembershipConflict) throw new RouteError(409, error.message)
        throw error
      }
    },
    'PUT tickets/:id/management': async ({ params, body }) => {
      const result = updateTicketManagement(runtime.engine, params.id, ManagementPatchSchema.parse(await body()))
      runtime.requestPass()
      return result
    },
    'POST tickets/:id/executor': async ({ params, body }) => {
      if (!runtime.transferExecutor) throw new RouteError(400, 'Executor transfer is unavailable')
      return runtime.transferExecutor(ticket(params.id), ExecutorTransferSchema.parse(await body()))
    },
    'POST tickets/:id/followup': async ({ params, body }) => runtime.followups.schedule(ticket(params.id), FollowupRequestSchema.parse(await body())),
    'DELETE tickets/:id/followup': ({ params, query }) => {
      const id = ticket(params.id)
      const args = z.object({ request_id: z.string().trim().min(1).max(200).optional(), all: z.literal('true').optional() }).strict()
        .refine(value => !(value.request_id && value.all), 'Choose one request_id or all').parse(query)
      if (!args.request_id && !args.all && runtime.followups.list(id).length > 1) throw new RouteError(400, 'Multiple checks are pending; specify request_id')
      return runtime.followups.cancel(id, args.request_id)
    },
    'POST tickets/:id/followup/migrate': async ({ params, body }) => {
      const id = ticket(params.id)
      const { request_id } = z.object({ request_id: z.string().trim().min(1).max(200) }).strict().parse(await body())
      return runtime.followups.migrate(id, request_id)
    },
    'DELETE tickets/:id/followup/automation': async ({ params, query }) => {
      const id = ticket(params.id)
      const { request_id } = z.object({ request_id: z.string().trim().min(1).max(200) }).strict().parse(query)
      return runtime.followups.cancelAutomation(id, request_id)
    },
    'POST tickets/:id/retry': ({ params }) => { const id = ticket(params.id); runtime.engine.retryTicket(id); return { retried: true } },
    'POST tickets/:id/continue': async ({ params, body }) => {
      if (!runtime.continueStopped) throw new RouteError(400, 'DSH continuation is unavailable')
      const request = z.object({ instruction: z.string().trim().min(1).max(20000) }).strict().parse(await body())
      return runtime.continueStopped(ticket(params.id), request.instruction)
    },
    'POST tickets/:id/stop': async ({ params, body }) => {
      const input = await body()
      // The stop route predates the close reason, so an absent body still stops the Ticket.
      const { reason } = input === undefined ? {} : z.object({ reason: z.string().max(500).optional() }).strict().parse(input)
      const id = ticket(params.id)
      runtime.engine.stopTicket(id, reason?.trim() || undefined)
      return { stopped: true }
    },
    'POST executor/pause': async ({ body }) => runtime.settings.pause(z.object({ paused: z.boolean() }).parse(await body()).paused, 'panel'),
    'PUT settings/:block': async ({ params, body }) => {
      const block = SettingsBlockSchema.parse(params.block)
      const known = !block.startsWith('source:') || runtime.sources.instances().some(instance => `source:${instance.id}` === block)
      if (!known) throw new RouteError(404, 'Source not found')
      const request = SaveRequest.parse(await body())
      return runtime.settings.save(block, request.value, request.revision, 'panel')
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    'GET models': () => runtime.models(),
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      return savePrompts(runtime, request.config, request.baseRevision, 'panel')
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
  }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
function match(table: Routes, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { run: run as (input: Input<keyof Api>) => unknown, params }
  }
  return undefined
}
export function registerHttp(ctx: Context, runtime: HttpHost): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
  const table = routes(runtime)
  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      try {
        await runtime.ready
        const route = match(table, req.method ?? 'GET', url.pathname.slice('/orchestrator/api/'.length).split('/'))
        if (!route) throw new RouteError(404, 'Unknown operation')
        const query = Object.fromEntries(url.searchParams)
        json(res, 200, await route.run({ params: route.params as never, query, body: maxBytes => readBody(req, maxBytes) }))
      } catch (error) { json(res, ...failure(error)) }
    } })]
  return () => { for (const dispose of disposers) dispose() }
}
