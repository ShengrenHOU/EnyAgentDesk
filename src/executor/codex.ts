/** Codex workers share the upstream Engine, Effects, tools and Outbox. */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { ExecutionStage, StageHandoff, stageModels } from './execution-stage.ts'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import { z } from 'zod'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { key, latestAssignment, liveTicket, runningAssignment, waitsForPerson, type Assignment, type AssessmentOutcome, type Ticket } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Store } from '../app/store.ts'
import type { Tool } from '../app/tools/tool.ts'
import { Later } from '../app/effects.ts'
import { prepareCommand, runAsWorker, verifyDirectory } from '../infra/environment.ts'
import { inputMessage, mandateInstructions, ticketExecution, WorkerSlots, type ExecutorHost } from './dsh.ts'
import { CodexRpc } from './codex-rpc.ts'
import { reportRelay } from '../app/notices.ts'

export interface CodexConfig { command: string; model?: string; readOnly?: boolean; networkAccess?: boolean; hostAccess?: boolean }
export interface CodexHost extends Omit<ExecutorHost, 'store'> {
  readonly store: ExecutorHost['store'] & Pick<Store, 'get'>
  readonly codex: CodexConfig
  tools(ticket: Ticket): Tool[]
  prompt(ticket: Ticket): string
}
const Thread = z.object({ thread: z.object({ id: z.string() }) })
const Turn = z.object({ turn: z.object({ id: z.string() }) })
const Completed = z.object({ threadId: z.string(), turn: z.object({ id: z.string(), status: z.string(),
  error: z.object({ message: z.string() }).nullable().optional() }) })
const ToolCall = z.object({ threadId: z.string(), turnId: z.string(), callId: z.string(), tool: z.string(), arguments: z.unknown() })
type Worker = { rpc: CodexRpc; threadId: string; assignmentId: string; turnId?: string; requestedModel?: string; launching: boolean; completing?: string; completedTurnId?: string; completed?: unknown }

/** Missing or changing rollout telemetry leaves the actual model unknown. */
async function rolloutModel(path: string, threadId: string, turnId: string): Promise<string | undefined> {
  const input = createReadStream(path)
  const lines = createInterface({ input, crlfDelay: Infinity })
  let bound = false, model: string | undefined
  try {
    for await (const line of lines) {
      let value: unknown
      try { value = JSON.parse(line) } catch { continue }
      const meta = z.object({ type: z.literal('session_meta'), payload: z.object({ id: z.string() }) }).safeParse(value)
      if (meta.success) { if (meta.data.payload.id !== threadId) return undefined; bound = true }
      const context = z.object({ type: z.literal('turn_context'), payload: z.object({ turn_id: z.string(), model: z.string() }) }).safeParse(value)
      if (bound && context.success && context.data.payload.turn_id === turnId) model = context.data.payload.model
    }
    return model
  } catch { return undefined } finally { lines.close(); input.destroy() }
}

/** Executes durable upstream assignments in ticket-bound local Codex threads. */
export class CodexExecutor {
  private readonly connecting = new Map<string, Promise<Worker>>()
  private readonly workers = new Map<string, Worker>()
  private readonly slots: WorkerSlots
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly handling = new Set<Promise<void>>()
  private generation = 0
  constructor(private readonly host: CodexHost) {
    this.slots = host.slots ?? new WorkerSlots(() => this.activeTicketIds(),
      () => host.store.settings().executor.maxWorkers)
    host.effects.handle('launch', payload => this.launch(payload.ticketId, payload.assignmentId),
      { limit: () => host.paused() ? 0 : this.slots.launches(), retry: [5000, 300_000] })
    host.effects.handle('codexStage', async payload => {
      if (host.ticketPaused?.(payload.ticketId)) throw new Later('Ticket is paused')
      const ticket = this.current(payload.ticketId, payload.assignmentId)
      if (!ticket) return
      if (waitsForPerson(ticket) || ticket.attention) throw new Later('Stage handoff awaits a person')
      this.slots.reserve(ticket.id, 'launch')
      try {
        const worker = await this.connect(ticket, payload.assignmentId)
        if (worker.turnId || worker.launching || worker.completing) throw new Later('Previous Codex turn is still active')
        worker.launching = true
        try {
          await this.reconcile(ticket, worker)
          await this.continueStage(ticket.id, worker, payload.turnId)
        } finally { worker.launching = false; await this.flushCompletion(ticket.id, worker) }
      } catch (error) {
        if (error instanceof Later || this.host.closing()) throw error
        this.failed(ticket.id, payload.assignmentId, error)
      } finally { this.slots.free(ticket.id) }
    }, { limit: () => host.paused() ? 0 : this.slots.launches(), retry: [5000, 300_000] })
    host.effects.handle('delivery', payload => this.deliverQueued(payload.ticketId),
      { limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    if (outcome.stage && !this.host.codex.model) this.host.store.set(KV.codex.stages(ticket.id), { current: outcome.stage, history: [{ stage: outcome.stage, model: stageModels[outcome.stage], at: new Date().toISOString() }], turns: [] })
    return { ...ticket, execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir) }
  }
  install(): void { /* App Server notifications are installed with each connection. */ }
  activeCount(): number { return this.slots.used() }
  activeTicketIds(): string[] { return [...this.workers].filter(([, worker]) => worker.launching || worker.turnId || worker.completing).map(([id]) => id) }
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }
  private current(id: string, assignmentId?: string): Ticket | undefined {
    const ticket = this.host.store.tickets.get(id)
    return ticket && liveTicket(ticket) && (!assignmentId || latestAssignment(ticket)?.id === assignmentId) ? ticket : undefined
  }
  private failed(id: string, assignmentId: string, error: unknown): void {
    if (!this.current(id, assignmentId) || this.host.closing()) return
    const summary = error instanceof Error ? error.message : String(error)
    const report = { state: 'failed' as const, summary,
      question: summary.includes('already has an active writer')
        ? 'Another Codex service owns this trial thread. Release that idle trial thread through Codex before retrying; do not delete its lock or stop the desktop application.'
        : 'Codex execution stopped. Inspect the work and retry this ticket when the failure is resolved.' }
    this.host.store.atomic(() => {
      const updated = this.host.engine.report(id, report)
      const relay = reportRelay(updated, report)
      if (relay) this.host.sessions.relay(relay.id, relay.text)
    })
  }
  private async directory(ticket: Ticket): Promise<string> {
    const directory = resolve(ticket.execution!.directory)
    const root = resolve(this.host.store.settings().executor.directory || resolve(this.host.machine.stateDir, 'work'))
    const child = relative(root, directory)
    if (!child || child === '..' || child.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(child)) {
      throw new Error('Codex workspace is outside the configured ticket root')
    }
    const exists = await stat(directory).then(value => value.isDirectory()).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    const transferred = ticket.execution?.handoffs?.some(item => item.from === 'dsh' && item.to === 'codex')
    if (exists && !this.host.store.get(KV.codex.workspace(ticket.id)) && !transferred) throw new Error('Existing Codex workspace has no successful preparation receipt')
    if (!exists) {
      await mkdir(dirname(directory), { recursive: true })
      const command = this.host.store.settings().executor.prepare.trim()
      if (command) {
        await runAsWorker(this.host.context.subprocess, prepareCommand(command), dirname(directory),
          AbortSignal.any([this.host.lifetime, AbortSignal.timeout(600_000)]),
          Object.fromEntries(this.host.environment(ticket).map(value => [value.key, value.value])))
      }
      await mkdir(directory, { recursive: true })
    }
    await verifyDirectory(directory, this.host.context.subprocess, this.host.lifetime)
    this.host.store.set(KV.codex.workspace(ticket.id), true)
    return directory
  }
  private async connect(ticket: Ticket, assignmentId: string): Promise<Worker> {
    const connectionKey = key(ticket.id, assignmentId)
    const pending = this.connecting.get(connectionKey)
    if (pending) return pending
    const connection = this.openConnection(ticket, assignmentId)
    this.connecting.set(connectionKey, connection)
    try { return await connection } finally { if (this.connecting.get(connectionKey) === connection) this.connecting.delete(connectionKey) }
  }
  private async openConnection(ticket: Ticket, assignmentId: string): Promise<Worker> {
    const previous = this.workers.get(ticket.id)
    if (previous) { previous.assignmentId = assignmentId; return previous }
    const generation = this.generation
    const current = () => generation === this.generation && !this.host.closing() && !!this.current(ticket.id, assignmentId)
    const directory = await this.directory(ticket)
    if (!current()) throw new Later('Codex connection was superseded')
    const tools = [...this.host.tools(ticket), {
      name: 'orchestrator_stage',
      description: 'Request a necessary execution stage change after saving a complete handoff. End this turn after requesting; do not report ready. The next stage starts only after a successful turn completion.',
      schema: z.object({ request_id: z.string().min(1), stage: ExecutionStage, handoff: StageHandoff }).strict(),
      execute: async (args: unknown) => {
        const request = z.object({ request_id: z.string().min(1), stage: ExecutionStage, handoff: StageHandoff }).strict().parse(args)
        const state = this.host.store.get(KV.codex.stages(ticket.id))
        const worker = this.workers.get(ticket.id)
        if (!state || !worker?.turnId) throw new Error('Stage routing is not enabled for this ticket')
        const previous = state.history.find(entry => entry.requestId === request.request_id)
        if (previous) {
          if (previous.stage === request.stage && JSON.stringify(previous.handoff) === JSON.stringify(request.handoff)) return { queued: false, completed: true }
          throw new Error('Stage request ID was already used with different contents')
        }
        if (state.pending && state.pending.turnId === worker.turnId) {
          if (state.pending.requestId === request.request_id && JSON.stringify(state.pending.handoff) === JSON.stringify(request.handoff) && state.pending.stage === request.stage) return { queued: true }
          throw new Error('Another stage handoff is pending')
        }
        if (request.stage === state.current) throw new Error('Already executing this stage')
        this.host.store.set(KV.codex.stages(ticket.id), { ...state, pending: { stage: request.stage, handoff: request.handoff, turnId: worker.turnId, requestId: request.request_id } })
        return { queued: true }
      },
    }]
    const rpc = await CodexRpc.connect({ command: this.host.codex.command, cwd: directory,
      env: { ...scrubbedParentEnv(), ...Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value])) },
      notification: (method, params) => {
        const work = this.notification(ticket.id, method, params).catch(error =>
          this.failed(ticket.id, this.workers.get(ticket.id)?.assignmentId ?? assignmentId, error))
        this.handling.add(work); void work.finally(() => this.handling.delete(work))
      },
      request: (method, params) => this.toolRequest(ticket.id, method, params, tools),
      disconnected: error => {
        const currentAssignment = this.workers.get(ticket.id)?.assignmentId
        if (!currentAssignment) return // A failed connection attempt is reported by its launch/delivery caller.
        this.workers.delete(ticket.id)
        this.failed(ticket.id, currentAssignment, error)
      },
    })
    try {
      if (!current()) throw new Later('Codex connection was superseded')
      const saved = this.host.store.get(KV.codex.binding(ticket.id))
      const common = { cwd: directory, approvalPolicy: 'never', sandbox: this.host.codex.readOnly ? 'read-only' : this.host.codex.hostAccess ? 'danger-full-access' : 'workspace-write',
        config: { 'sandbox_workspace_write.network_access': !this.host.codex.readOnly && this.host.codex.networkAccess === true },
        ...(this.host.codex.model ? { model: this.host.codex.model } : {}),
        developerInstructions: this.host.prompt(ticket) + '\n' + mandateInstructions(ticket.mandate) + '\n' +
          'When stage routing is active, use orchestrator_stage to request a necessary stage transition with purpose, accepted decisions, results, evidence and remaining work. Finish the current turn after requesting the handoff; the executor resumes the same ticket in the selected stage. Stay in the current stage for follow-ups and retries; simple tasks need no extra stages. A stage request or requested model is not evidence of the actual model: retain unknown or mismatched runtime receipts honestly.',
      }
      const result = await rpc.call(saved ? 'thread/resume' : 'thread/start', saved
        ? { ...common, threadId: saved.threadId }
        : { ...common, dynamicTools: tools.map(tool => ({ name: tool.name, description: tool.description,
          inputSchema: z.toJSONSchema(tool.schema, { unrepresentable: 'any', io: 'input' }) })) })
      const threadId = Thread.parse(result).thread.id
      if (!current()) throw new Later('Codex connection was superseded')
      if (saved && saved.threadId !== threadId) throw new Error('Codex resumed a different thread')
      this.host.store.set(KV.codex.binding(ticket.id), { ...saved, threadId })
      const worker: Worker = { rpc, threadId, assignmentId, launching: false }
      this.workers.set(ticket.id, worker)
      return worker
    } catch (error) { await rpc.close(); throw error }
  }
  private turnModel(ticketId: string): { model?: string } {
    const state = this.host.store.get(KV.codex.stages(ticketId))
    const model = this.host.codex.model ?? (state ? stageModels[state.current] : undefined)
    return model ? { model } : {}
  }
  private recordTurn(ticketId: string, turnId: string, model: string | undefined): void {
    const state = this.host.store.get(KV.codex.stages(ticketId))
    if (!state || !model || state.turns.some(turn => turn.turnId === turnId)) return
    const last = state.history.at(-1)
    this.host.store.set(KV.codex.stages(ticketId), { ...state,
      history: last?.stage === state.current && last.model === model ? state.history
        : [...state.history, { stage: state.current, model, at: new Date().toISOString() }],
      turns: [...state.turns, { turnId, requestedModel: model }] })
  }
  private invalidSource(ticketId: string, turnId: string): boolean {
    const receipt = this.host.store.get(KV.codex.stages(ticketId))?.turns.find(turn => turn.turnId === turnId)
    return !!receipt?.actualModel && receipt.actualModel !== receipt.requestedModel
  }
  private clearHandoff(ticketId: string, turnId: string): void {
    const state = this.host.store.get(KV.codex.stages(ticketId))
    if (state?.pending?.turnId === turnId) this.host.store.set(KV.codex.stages(ticketId), { ...state, pending: undefined })
  }
  private async continueStage(ticketId: string, worker: Worker, completedTurnId: string): Promise<boolean> {
    const state = this.host.store.get(KV.codex.stages(ticketId))
    if (!state?.pending || state.pending.turnId !== completedTurnId) return false
    const ticket = this.current(ticketId, worker.assignmentId)
    if (!ticket || this.workers.get(ticketId) !== worker) return false
    if (this.host.paused() || this.host.ticketPaused?.(ticketId) || waitsForPerson(ticket) || ticket.attention) throw new Later('Stage handoff is held')
    const assignment = latestAssignment(ticket), report = assignment?.report
    const busy = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
    if (report && report.state !== 'progress' && !busy) return false
    const next = state.pending
    const saved = this.host.store.get(KV.codex.binding(ticketId))!
    const model = this.host.codex.model ?? stageModels[next.stage]
    const marker = `superagent-stage:${next.requestId}`
    this.host.store.atomic(() => {
      this.host.store.set(KV.codex.stages(ticketId), { ...state, current: next.stage, pending: undefined,
        history: [...state.history, { stage: next.stage, model, at: new Date().toISOString(), requestId: next.requestId, handoff: next.handoff }] })
      this.host.store.set(KV.codex.binding(ticketId), { ...saved, pending: { marker, inputIds: [], model } })
    })
    worker.launching = true
    worker.requestedModel = model
    try {
      const result = Turn.parse(await worker.rpc.call('turn/start', { threadId: worker.threadId, model,
        input: [{ type: 'text', text: `${marker}\nContinue this same task in stage ${next.stage}. Handoff: ${JSON.stringify(next.handoff)}` }] }))
      worker.turnId = result.turn.id
      this.recordTurn(ticketId, worker.turnId, model)
      this.host.store.set(KV.codex.binding(ticketId), { threadId: worker.threadId, assignmentId: worker.assignmentId, turnId: worker.turnId })
      return true
    } finally { worker.launching = false; await this.flushCompletion(ticketId, worker) }
  }
  private async launch(ticketId: string, assignmentId: string): Promise<void> {
    await this.stopping.get(ticketId)
    const ticket = this.current(ticketId, assignmentId)
    if (!ticket || latestAssignment(ticket)?.state !== 'pending') return
    this.host.beforeLaunch?.(ticketId)
    this.slots.reserve(ticketId, 'launch')
    try {
      await this.host.guardExecution?.(ticket)
      if (!this.current(ticketId, assignmentId)) return
      const worker = await this.connect(ticket, assignmentId)
      await this.reconcile(ticket, worker)
      if (!this.current(ticketId, assignmentId)) return
      if (this.host.paused() || this.host.ticketPaused?.(ticketId)) throw new Later('Ticket is paused')
      const stage = this.host.store.get(KV.codex.stages(ticketId))
      if (stage?.pending) {
        const history = z.object({ thread: z.object({ turns: z.array(z.object({ id: z.string(), status: z.string() })) }) }).parse(await worker.rpc.call('thread/read', { threadId: worker.threadId, includeTurns: true }))
        const receipt = history.thread.turns.find(turn => turn.id === stage.pending!.turnId)
        if (!receipt || !['completed', 'interrupted', 'failed'].includes(receipt.status)) throw new Error('Stage handoff has no terminal source-turn receipt; inspect the existing thread before retrying')
        if (receipt.status === 'completed' && !this.invalidSource(ticketId, receipt.id)) {
          this.host.engine.assignmentStarted(ticketId, assignmentId)
          await this.continueStage(ticketId, worker, receipt.id)
          return
        }
        this.clearHandoff(ticketId, receipt.id)
      }
      const saved = this.host.store.get(KV.codex.binding(ticketId))!
      if (saved.assignmentId === assignmentId) {
        // A crash between the accepted turn and assignmentStarted must not replay that turn.
        this.host.engine.assignmentStarted(ticketId, assignmentId)
        this.host.engine.assignmentInterrupted(ticketId, assignmentId)
        return
      }
      {
        worker.launching = true
        const marker = `superagent-assignment:${assignmentId}`
        const first = ticket.assignments.length === 1
        const triggers = first ? ticket.origin.triggerIds.map(id => this.host.store.triggers.get(id)).filter(Boolean) : []
        const text = `${marker}\n${JSON.stringify({ ticket_id: ticket.id, title: ticket.title,
          assignment: ticket.execution?.assignment, ...ticket.execution?.requiredSkills?.length
            ? { required_skills: ticket.execution.requiredSkills } : {},
          original_requests: triggers,
          execution_stage: this.host.store.get(KV.codex.stages(ticketId)),
          ...(first ? {} : { recovery: 'Continue this ticket from its existing files and history. Do not repeat completed external actions. Pending inputs follow.' }) })}`
        const selected = this.turnModel(ticketId)
        worker.requestedModel = selected.model
        this.host.store.set(KV.codex.binding(ticketId), { ...saved, pending: { marker, inputIds: [], assignmentId, ...selected } })
        const result = Turn.parse(await worker.rpc.call('turn/start', { threadId: worker.threadId, ...selected, input: [{ type: 'text', text }] }))
        worker.turnId = result.turn.id
        this.recordTurn(ticketId, worker.turnId, selected.model)
        this.host.store.set(KV.codex.binding(ticketId), { threadId: worker.threadId, turnId: worker.turnId, assignmentId })
        worker.launching = false
      }
      this.host.engine.assignmentStarted(ticketId, assignmentId)
    } catch (error) {
      if (this.host.closing() || error instanceof Later) throw error
      this.failed(ticketId, assignmentId, error)
    } finally {
      const worker = this.workers.get(ticketId)
      if (worker) { worker.launching = false; await this.flushCompletion(ticketId, worker) }
      this.slots.free(ticketId)
    }
  }
  private async reconcile(ticket: Ticket, worker: Worker): Promise<void> {
    const saved = this.host.store.get(KV.codex.binding(ticket.id))
    if (!saved?.pending) return
    const read = await worker.rpc.call('thread/read', { threadId: worker.threadId, includeTurns: true })
    const history = z.object({ thread: z.object({ turns: z.array(z.object({ id: z.string(), status: z.string(), items: z.array(z.unknown()) })) }) }).parse(read)
    const userInput = z.object({ type: z.literal('userMessage'), content: z.array(z.object({ type: z.string(), text: z.string().optional() })) })
    const found = history.thread.turns.find(turn => turn.items.some(item => {
      const parsed = userInput.safeParse(item)
      return parsed.success && parsed.data.content.some(content => content.type === 'text' && content.text?.includes(saved.pending!.marker))
    }))
    if (found) {
      // Keep the unresolved intent until the server has a completed receipt; a running turn may still write.
      if (found.status !== 'completed') throw new Error('Previous Codex turn has no completed receipt; inspect it before retrying')
      this.host.store.atomic(() => {
        this.recordTurn(ticket.id, found.id, saved.pending!.model)
        this.host.engine.inputsDelivered(ticket.id, worker.assignmentId, saved.pending!.inputIds)
        this.host.engine.inputsRead(ticket.id, saved.pending!.inputIds)
        this.host.store.set(KV.codex.binding(ticket.id), { threadId: worker.threadId,
          assignmentId: saved.pending!.assignmentId ?? saved.assignmentId })
      })
    } else throw new Error('Unconfirmed Codex input delivery; inspect thread history before retrying')
  }
  private async deliverQueued(ticketId: string): Promise<void> {
    if (this.host.ticketPaused?.(ticketId)) throw new Later('Ticket is paused')
    await this.stopping.get(ticketId)
    let ticket = this.current(ticketId)
    const assignment = ticket && runningAssignment(ticket)
    if (!ticket || !assignment || !ticket.undelivered.length) return
    const worker = await this.connect(ticket, assignment.id)
    if (worker.launching || worker.completing) throw new Later('Codex turn is starting or completing')
    try {
      await this.reconcile(ticket, worker)
      ticket = this.current(ticketId, assignment.id)
      if (!ticket || !ticket.undelivered.length) return
      // A dedicated next turn gives answers an unambiguous read/report boundary; a current report may still be stale.
      if (worker.turnId && ticket.inputs.some(input => input.kind === 'answer' && ticket!.undelivered.includes(input.id))) return
      if (this.host.paused() || ticket.paused || this.host.ticketPaused?.(ticketId)) throw new Later('Ticket is paused')
      if (!worker.turnId) this.slots.reserve(ticketId, 'wake')
      worker.launching = true
      const inputIds = [...ticket.undelivered]
      const messages = inputIds.map(id => ticket!.inputs.find(input => input.id === id)).filter(input => input !== undefined).map(input => {
        const trigger = input.kind === 'trigger' ? this.host.store.triggers.get(input.triggerId) : undefined
        return inputMessage(input, trigger ? { trigger_id: trigger.id, from: trigger.actor.id, text: trigger.text, at: trigger.at } : undefined)
      }).filter(text => text !== undefined)
      const marker = `superagent-input:${key(ticketId, ...inputIds)}`
      const required = ticket.execution?.requiredSkills?.length ? `\nRequired skills: ${ticket.execution.requiredSkills.join(', ')}` : ''
      const text = `${marker}\nTicket: ${ticketId}\n${ticket.execution?.assignment ?? ''}${required}\n${messages.join('\n\n')}`
      const selected = this.turnModel(ticketId)
      if (!worker.turnId) worker.requestedModel = selected.model
      this.host.store.set(KV.codex.binding(ticketId), { threadId: worker.threadId, assignmentId: assignment.id, pending: { marker, inputIds, model: worker.requestedModel } })
      const result = worker.turnId
        ? await worker.rpc.call('turn/steer', { threadId: worker.threadId, expectedTurnId: worker.turnId, input: [{ type: 'text', text }] })
        : await worker.rpc.call('turn/start', { threadId: worker.threadId, ...selected, input: [{ type: 'text', text }] })
      const turnId = worker.turnId ? z.object({ turnId: z.string() }).parse(result).turnId : Turn.parse(result).turn.id
      if (!worker.turnId) this.recordTurn(ticketId, turnId, selected.model)
      worker.turnId = turnId
      this.host.store.atomic(() => {
        this.host.engine.inputsDelivered(ticketId, assignment.id, inputIds)
        this.host.store.set(KV.codex.binding(ticketId), { threadId: worker.threadId, turnId, assignmentId: assignment.id })
      })
    } catch (error) {
      if (this.host.closing() || error instanceof Later) throw error
      this.host.engine.deliveryFailed(ticketId, assignment.id, error instanceof Error ? error.message : String(error))
      throw error
    } finally { worker.launching = false; await this.flushCompletion(ticketId, worker); this.slots.free(ticketId) }
  }
  private async toolRequest(ticketId: string, method: string, raw: unknown, tools: Tool[]): Promise<unknown> {
    if (method !== 'item/tool/call') throw new Error('Approval or unsupported server request requires human handling')
    const call = ToolCall.parse(raw)
    const worker = this.workers.get(ticketId)
    let ticket = worker && this.current(ticketId, worker.assignmentId)
    if (!worker || !ticket || call.threadId !== worker.threadId || (worker.turnId && call.turnId !== worker.turnId)) throw new Error('Tool request does not own this ticket')
    if (call.tool === 'orchestrator_report' && z.object({ state: z.literal('ready') }).safeParse(call.arguments).success && this.host.store.get(KV.codex.stages(ticketId))?.pending) throw new Error('A pending stage handoff must finish before reporting ready')
    const tool = tools.find(tool => tool.name === call.tool)
    if (!tool) throw new Error('Tool is not available to this worker')
    const pending = this.host.store.get(KV.codex.binding(ticketId))?.pending?.inputIds ?? []
    const answers = ticket.inputs.filter(input => input.kind === 'answer' && !input.readAt
      && (input.deliveredTo === worker.assignmentId || (worker.launching && !worker.turnId && pending.includes(input.id)))).map(input => input.id)
    if (answers.length) {
      const notDelivered = answers.filter(id => ticket!.undelivered.includes(id))
      this.host.store.atomic(() => {
        if (notDelivered.length) this.host.engine.inputsDelivered(ticketId, worker.assignmentId, notDelivered)
        this.host.engine.inputsRead(ticketId, answers)
      })
      ticket = this.current(ticketId, worker.assignmentId)
      if (!ticket) throw new Error('Ticket ended while recording its owner answer')
    }
    try {
      if (call.tool === 'orchestrator_report' && z.object({ state: z.literal('ready') }).safeParse(call.arguments).success && this.host.store.get(KV.codex.stages(ticketId))) {
        const assignmentId = worker.assignmentId, deliveredAt = latestAssignment(ticket)?.deliveredAt
        await this.collectModelEvidence(ticketId, worker, call.turnId, assignmentId)
        const refreshed = this.current(ticketId, assignmentId)
        if (!refreshed || this.workers.get(ticketId) !== worker || worker.assignmentId !== assignmentId || worker.completing || (worker.turnId !== call.turnId && !(worker.launching && !worker.turnId))) throw new Error('Ready report was superseded while collecting model evidence')
        if (latestAssignment(refreshed)?.deliveredAt !== deliveredAt || refreshed.inputs.length !== ticket.inputs.length || refreshed.undelivered.length !== ticket.undelivered.length) throw new Error('New input arrived while collecting model evidence; handle it before reporting ready')
        if (this.host.store.get(KV.codex.stages(ticketId))?.pending) throw new Error('A pending stage handoff must finish before reporting ready')
        if (this.invalidSource(ticketId, call.turnId)) {
          const evidence = this.host.store.get(KV.codex.stages(ticketId))!.turns.find(turn => turn.turnId === call.turnId)!
          const error = new Error(`Requested model ${evidence.requestedModel}, actual model ${evidence.actualModel}; ready report rejected`)
          this.failed(ticketId, assignmentId, error)
          throw error
        }
      }
      const result = await tool.execute(tool.schema.parse(call.arguments), this.host.lifetime)
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] }
    } catch (error) {
      return { success: false, contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : String(error) }] }
    }
  }
  private async notification(ticketId: string, method: string, params: unknown): Promise<void> {
    if (method === 'model/rerouted') {
      const event = z.object({ threadId: z.string(), turnId: z.string(), fromModel: z.string(), toModel: z.string(), reason: z.string() }).parse(params)
      const worker = this.workers.get(ticketId), state = this.host.store.get(KV.codex.stages(ticketId))
      if (worker?.threadId === event.threadId && (worker.turnId === event.turnId || (worker.launching && !worker.turnId)) && state) this.host.store.set(KV.codex.stages(ticketId), { ...state,
        turns: [...state.turns.filter(turn => turn.turnId !== event.turnId), { turnId: event.turnId,
          requestedModel: state.turns.find(turn => turn.turnId === event.turnId)?.requestedModel ?? worker.requestedModel ?? event.fromModel, actualModel: event.toModel, evidence: `model/rerouted: ${event.reason}` }] })
      return
    }
    if (method !== 'turn/completed') return
    const event = Completed.parse(params)
    const worker = this.workers.get(ticketId)
    if (!worker || worker.threadId !== event.threadId || (!worker.launching && worker.turnId !== event.turn.id) || (worker.turnId && worker.turnId !== event.turn.id)) return
    if (worker.launching) { worker.completed = params; return }
    if (worker.completing || worker.completedTurnId === event.turn.id) return
    worker.completing = event.turn.id
    try { await this.completeTurn(ticketId, worker, event, worker.assignmentId); worker.completedTurnId = event.turn.id }
    finally {
      if (worker.completing === event.turn.id) worker.completing = undefined
      const ticket = this.current(ticketId, worker.assignmentId)
      const assignment = ticket && runningAssignment(ticket)
      if (ticket && assignment && event.turn.status === 'completed' && ticket.inputs.some(input => input.kind === 'answer'
        && ticket.undelivered.includes(input.id))) this.deliver(ticket, assignment)
    }
  }
  private async collectModelEvidence(ticketId: string, worker: Worker, turnId: string, assignmentId: string): Promise<void> {
    let stages = this.host.store.get(KV.codex.stages(ticketId))
    if (stages) {
      let path: string | undefined
      try {
        path = z.object({ thread: z.object({ path: z.string().nullable().optional() }) }).parse(await worker.rpc.call('thread/read', { threadId: worker.threadId, includeTurns: false })).thread.path ?? undefined
      } catch { /* The actual model stays unknown when telemetry is unavailable. */ }
      if (this.workers.get(ticketId) !== worker || worker.assignmentId !== assignmentId) return
      stages = this.host.store.get(KV.codex.stages(ticketId))!
      const rerouted = stages.turns.find(turn => turn.turnId === turnId)
      let actualModel: string | undefined = rerouted?.actualModel
      if (path && !rerouted?.actualModel) actualModel = await rolloutModel(path, worker.threadId, turnId)
      if (this.workers.get(ticketId) !== worker || worker.assignmentId !== assignmentId) return
      stages = this.host.store.get(KV.codex.stages(ticketId))!
      const latestEvidence = stages.turns.find(turn => turn.turnId === turnId)
      actualModel = latestEvidence?.actualModel ?? actualModel
      this.host.store.set(KV.codex.stages(ticketId), { ...stages, turns: [...stages.turns.filter(turn => turn.turnId !== turnId),
        { turnId: turnId, requestedModel: latestEvidence?.requestedModel ?? worker.requestedModel ?? stageModels[stages.current], ...(actualModel ? { actualModel, evidence: latestEvidence?.evidence ?? 'rollout turn_context' } : {}) }] })
    }
  }
  private async completeTurn(ticketId: string, worker: Worker, event: z.infer<typeof Completed>, assignmentId: string): Promise<void> {
    await this.collectModelEvidence(ticketId, worker, event.turn.id, assignmentId)
    if (this.workers.get(ticketId) !== worker || worker.assignmentId !== assignmentId || (worker.turnId && worker.turnId !== event.turn.id)) return
    const evidence = this.host.store.get(KV.codex.stages(ticketId))?.turns.find(turn => turn.turnId === event.turn.id)
    if (evidence?.actualModel && evidence.actualModel !== evidence.requestedModel) {
      worker.turnId = undefined
      this.failed(ticketId, worker.assignmentId, new Error(`Requested model ${evidence.requestedModel}, actual model ${evidence.actualModel}; stage handoff stopped`))
      return
    }
    worker.turnId = undefined
    this.host.store.set(KV.codex.binding(ticketId), { threadId: worker.threadId, assignmentId: worker.assignmentId })
    const ticket = this.current(ticketId, worker.assignmentId)
    if (!ticket) {
      this.workers.delete(ticketId)
      const closing = worker.rpc.close().finally(() => { if (this.stopping.get(ticketId) === closing) this.stopping.delete(ticketId) })
      this.stopping.set(ticketId, closing)
      await closing
      return
    }
    const delivered = ticket.inputs.filter(input => (input.kind === 'trigger' || input.kind === 'answer') && input.deliveredTo === worker.assignmentId).map(input => input.id)
    this.host.engine.inputsRead(ticketId, delivered)
    this.host.engine.turnEnded(ticketId, worker.assignmentId)
    const assignment = latestAssignment(ticket)
    if (event.turn.status !== 'completed') {
      this.clearHandoff(ticketId, event.turn.id)
      this.failed(ticketId, worker.assignmentId, new Error(event.turn.error?.message ?? `Codex turn ${event.turn.status}`))
    } else if (this.host.store.get(KV.codex.stages(ticketId))?.pending?.turnId === event.turn.id) {
      this.host.effects.enqueue('codexStage', ticketId, { ticketId, assignmentId: worker.assignmentId, turnId: event.turn.id })
      return
    } else if (!assignment?.report || (assignment.deliveredAt ?? '') >= assignment.report.at) {
      this.host.engine.report(ticketId, { state: 'waiting', summary: 'Codex turn ended without an explicit work report; completion is unverified.' })
    }
  }
  private async flushCompletion(ticketId: string, worker: Worker): Promise<void> {
    if (worker.completed === undefined) return
    const completed = worker.completed
    worker.completed = undefined
    await this.notification(ticketId, 'turn/completed', completed)
  }
  stop(ticket: Ticket, assignment: Assignment, _reason: string): void {
    this.host.store.afterCommit(() => {
      const worker = this.workers.get(ticket.id)
      if (!worker) return
      const busy = !!assignment.deliveredAt && !!assignment.report && assignment.deliveredAt >= assignment.report.at
      if (ticket.ended?.by !== 'human' && (assignment.report?.state === 'ready' || assignment.report?.state === 'dropped') && !busy) return
      const stopping = (async () => {
        try { if (worker.turnId) await worker.rpc.call('turn/interrupt', { threadId: worker.threadId, turnId: worker.turnId }) }
        finally {
          await worker.rpc.close()
          if (this.workers.get(ticket.id) === worker) this.workers.delete(ticket.id)
        }
      })()
      this.stopping.set(ticket.id, stopping)
      void stopping.finally(() => {
        if (this.stopping.get(ticket.id) === stopping) this.stopping.delete(ticket.id)
      }).catch(error => this.host.health.set({ state: 'error', detail: String(error) }))
    })
  }
  resume(): void {
    for (const ticket of this.host.store.tickets.open()) {
      const running = runningAssignment(ticket)
      if (running) this.host.engine.assignmentInterrupted(ticket.id, running.id)
      const current = this.current(ticket.id), latest = current && latestAssignment(current)
      if (current && latest?.state === 'pending' && !waitsForPerson(current)) this.start(current, latest)
    }
  }
  async shutdown(): Promise<void> {
    this.generation++
    await Promise.allSettled([...this.workers.values()].map(async worker => {
      try { if (worker.turnId) await worker.rpc.call('turn/interrupt', { threadId: worker.threadId, turnId: worker.turnId }) }
      finally { await worker.rpc.close() }
    }))
    await Promise.allSettled([...this.stopping.values(), ...this.handling])
    this.workers.clear()
  }
  /** Close only an idle transport, retaining the native thread and workspace receipts for a later return. */
  async releaseTicket(ticketId: string): Promise<void> {
    const worker = this.workers.get(ticketId)
    if (this.activeTicketIds().includes(ticketId) || this.stopping.has(ticketId)) throw new Error('Codex execution is still active')
    if (!worker) return
    await worker.rpc.close()
    if (this.workers.get(ticketId) === worker) this.workers.delete(ticketId)
  }
  dispose(): void {
    this.generation++
    for (const worker of this.workers.values()) void worker.rpc.close().catch(error => this.host.health.set({ state: 'error', detail: String(error) }))
    this.workers.clear()
  }
}
