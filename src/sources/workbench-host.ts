/** Authenticated DSH owner entry into the native workbench Source. */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type {} from '@deepseek-ai/dsh-client-connection'
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createWorkbenchKind, delegateDiscussion, discussionSummary, discussionTasks, discussionNotices, updateDiscussionTask, workbenchKind, WorkbenchRequestSchema, WorkbenchUpdateSchema, type WorkbenchConfig } from './workbench.ts'
import { discussionContext, readDiscussion } from './workbench-session.ts'
import { publishWorkbenchFiles, readWorkbenchFile } from './workbench-files.ts'
import { registerWorkbenchTool } from './workbench-tools.ts'
import { AgentDelivery } from '../app/delivery.ts'
import { KV } from '../kv.ts'
import { focusRequestKey, readFocus } from './workbench-focus.ts'

export const name = 'dsh-superagent-workbench'
export const inject = ['orchestrator', 'connection', 'sessionController', 'sessionPersistence', 'agents', 'attachments', 'webServer', 'tools']

/** Register under DSH's authenticated owner-only API carrier instead of trusting a browser-provided identity. */
export function apply(ctx: Context): void {
  const base = `${ctx.webServer.protocol}//127.0.0.1:${ctx.webServer.port}`
  const delivery = new AgentDelivery(ctx)
  const stopped = new AbortController()
  ctx.effect(() => () => stopped.abort())
  ctx.effect(() => ctx.orchestrator.sources.register(createWorkbenchKind(ctx.orchestrator.context(workbenchKind),
    (ticket, files, config) => publishWorkbenchFiles(base, ticket, files, config), async message => {
      const target = await ctx.sessionController.resolveAgent(message.channel.address.sessionId as SessionId)
      if ('error' in target) throw target.error
      const text = JSON.stringify({ workbench_notification: { ticketId: message.ticketId, text: message.text },
        instruction: 'Show this workbench update concisely. This is system-delivered evidence, not a new owner instruction. Do not execute the task again, poll, or investigate browser authentication. Artifact links are for the authenticated owner browser.' })
      await delivery.send(target.agent, `workbench:${message.id}`, text,
        message.kind === 'acknowledgement' ? { inject: 'Workbench received your delegation' } : 'queue',
        AbortSignal.any([stopped.signal, AbortSignal.timeout(30_000)]), () => {
          const config = ctx.orchestrator.context(workbenchKind).config<WorkbenchConfig>('workbench')
          if (!config || config.ownerId !== message.channel.address.ownerId) throw new Error('Native discussion delivery was withdrawn')
        })
    })))
  ctx.effect(() => registerWorkbenchTool(ctx))
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/superagent-workbench/focus', methods: ['GET'], requestBody: 'buffered',
    async fetch() {
      const source = ctx.orchestrator.context(workbenchKind)
      await source.ready
      if (!source.config<WorkbenchConfig>('workbench')?.ownerId) return Response.json({ error: 'Native workbench is disabled' }, { status: 503 })
      return Response.json(readFocus(source), { headers: { 'cache-control': 'no-store' } })
    },
  }))
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/superagent-workbench/focus/refresh', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const source = ctx.orchestrator.context(workbenchKind)
      await source.ready
      if (!source.config<WorkbenchConfig>('workbench')?.ownerId) return Response.json({ error: 'Native workbench is disabled' }, { status: 503 })
      const id = source.state.get(KV.runtime.masterId)
      if (!id) return Response.json({ error: 'Main Session is unavailable' }, { status: 503 })
      const target = await ctx.sessionController.resolveAgent(id as SessionId)
      if ('error' in target) throw target.error
      const at = new Date().toISOString(), requestId = `workbench-focus:${randomUUID()}`
      await delivery.send(target.agent, requestId,
        'Workbench read-only refresh. Call workbench action focus_context to read current tickets, their report evidenceAt and the configured business focus domains. Use ticket_id or thread_key with focus_context for a specific source. Classify each suggestion into one active domain by its business scope using domainId. Preserve separate MLE forecast and Quant strategy attribution. Engineering follow-up concerns the owner/agent own Issues and PRs or explicitly delegated objects; other authors work is evidence, not a takeover. Prioritize actual owner business responsibilities and meaningful recent changes; distinguish internal tests/system maintenance from business priorities. Publish action focus with a Chinese headline and up to five useful next-action suggestions, each citing its actual ticketId or threadKey and copying evidenceAt from the evidence just read. Preserve the actual evidenceAt read; do not substitute a newer timestamp. Concurrent changes are marked in the reading view; any business execution still rechecks current facts and authority. Distinguish model recommendations, source gaps and human decisions. This request only refreshes a reading projection. Do not create or execute work, change authorization, send external messages or ask the owner to invent a task. End after publishing.',
        'queue', request.signal)
      source.state.set(focusRequestKey, { id: requestId, at })
      return Response.json({ queued: true, at })
    },
  }))
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/superagent-workbench/artifact', methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      try { return await readWorkbenchFile(ctx.orchestrator.context(workbenchKind), base, request) }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Deliverable unavailable' }, { status: 409 }) }
    } }))
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/superagent-workbench/discussion', methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      const source = ctx.orchestrator.context(workbenchKind)
      await source.ready
      if (!source.config<WorkbenchConfig>('workbench')?.ownerId) return Response.json({ error: 'Native workbench is not configured' }, { status: 503 })
      try {
        const sessionId = z.string().min(1).max(200).parse(new URL(request.url).searchParams.get('sessionId'))
        const inspection = await ctx.sessionController.inspect(sessionId as SessionId, request.signal)
        const throughSeq = inspection.events.at(-1)?.seq
        const context = throughSeq === undefined ? undefined : discussionContext(inspection, sessionId, throughSeq, ctx.attachments)
        return Response.json({ sessionId, throughSeq: throughSeq ?? null, messageCount: context?.messages.length ?? 0,
          partial: context?.partial ?? false, references: context?.messages.flatMap(message => message.references) ?? [],
          requests: discussionTasks(source, sessionId), notices: discussionNotices(source, sessionId) }, { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : 'Discussion unavailable' }, { status: 409 })
      }
    },
  }))
  /** Counts only: the Session row must not read discussion history just to draw a badge. */
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/superagent-workbench/summary', methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      const source = ctx.orchestrator.context(workbenchKind)
      await source.ready
      if (!source.config<WorkbenchConfig>('workbench')?.ownerId) return Response.json({ error: 'Native workbench is not configured' }, { status: 503 })
      try {
        const sessionId = z.string().min(1).max(200).parse(new URL(request.url).searchParams.get('sessionId'))
        return Response.json(discussionSummary(source, sessionId), { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        const status = error instanceof z.ZodError ? 400 : 409
        return Response.json({ error: error instanceof Error ? error.message : 'Summary unavailable' }, { status })
      }
    },
  }))
  for (const action of ['delegate', 'update'] as const) ctx.effect(() => ctx.connection.fetch.register({
    path: `/api/superagent-workbench/${action}`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const source = ctx.orchestrator.context(workbenchKind)
        await source.ready
        const owner = source.config<WorkbenchConfig>('workbench')?.ownerId
        if (!owner) return Response.json({ error: 'Native workbench owner is not configured' }, { status: 503 })
        const body = await request.text()
        if (Buffer.byteLength(body) > 32_768) return Response.json({ error: 'Delegation request is too large' }, { status: 413 })
        const parsed: unknown = JSON.parse(body)
        const update = action === 'update' ? WorkbenchUpdateSchema.parse(parsed) : undefined
        const input = update ?? WorkbenchRequestSchema.parse(parsed)
        const context = await readDiscussion(ctx.sessionController, input.sessionId, input.throughSeq, request.signal, ctx.attachments)
        const receipt = update
          ? await updateDiscussionTask(source, owner, update, context, new Date().toISOString())
          : await delegateDiscussion(source, owner, input, context, new Date().toISOString())
        return Response.json(receipt, { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: 'Invalid delegation request' }, { status: 400 })
        return Response.json({ error: error instanceof Error ? error.message : 'Delegation failed' }, { status: 409 })
      }
    },
  }))
}
