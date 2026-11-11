/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { latestAssignment, liveTicket, runningAssignment, ticketFollowups, UserError, type EngineForExecutor, type ReportedSkill,
  type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import { repositoryContext } from '../../sources/github-context.ts'
import type { SourceContext } from '../../sources/host.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  sendReplies(): Promise<void>
}
/** The skills a report names, with each existing file's content revision recorded so the panel shows the text actually read. */
function reportedSkills(skills: { name: string; path?: string; revision?: string; template?: string }[], root: string): ReportedSkill[] {
  return skills.map(skill => {
    if (!skill.path) return skill
    const path = isAbsolute(skill.path) ? skill.path : resolve(root, skill.path)
    try {
      if (!statSync(path).isFile()) throw new Error('not a file')
      const revision = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)
      return { ...skill, path, revision }
    } catch {
      throw new Error(`Reported skill ${skill.name} has no readable file at ${path}. List the skill file you actually read, or omit its path.`)
    }
  })
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  return [
    readTool('Read this ticket\'s resources. Follow next_offset for text, next_resource for source pages.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, waiting, ready, blocked, failed or dropped, as the work and handoff sections say. '
        + 'A ready report records the method and skills actually used and lists every required skill the assignment names. '
        + 'state=waiting says the only remaining work is an external condition such as CI or a review; the turn then ends and its '
        + 'shell jobs are parked, so the Ticket holds no worker slot while it waits.',
      schema: z.object({
        state: z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        deliverables: z.array(z.object({ title: z.string().trim().min(1).max(160),
          url: z.url({ protocol: /^https?$/ }).max(2048) }).strict()).max(10).optional()
          .describe('Verified result links in the agreed destination, including documents or research notes.'),
        files: z.array(z.object({ title: z.string().trim().min(1).max(160), path: z.string().min(1).max(4096) }).strict()).max(10).optional()
          .describe('Task-local files for Sources supporting file delivery.'),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.'),
        recommendation: z.string().trim().min(1).max(600).optional()
          .describe('With human_action: the action you recommend the person take, one sentence. Advice only; it never authorizes sending or execution.'),
        recommendation_reason: z.string().trim().min(1).max(1200).optional()
          .describe('With recommendation: the evidence you actually read and why this is the best option; state what is unknown instead of inventing a reason.'),
        risk: z.string().trim().min(1).max(600).optional()
          .describe('With recommendation: the known risk or uncertainty the person should weigh.'),
        draft: z.string().trim().min(1).max(4000).optional()
          .describe('With recommendation: a ready-to-review reply, message or answer the person may send or submit. Never send it yourself; the person decides.'),
        method: z.string().trim().min(1).max(300).optional()
          .describe('The professional method or framework you actually followed, when the result depends on one.'),
        skills: z.array(z.object({
          name: z.string().trim().min(1).max(120).describe('The registered skill name, such as review-weekly-role-progress.'),
          path: z.string().trim().min(1).max(4096).optional()
            .describe('The skill file you read; a relative path resolves against the ticket directory. The host records its content revision.'),
          revision: z.string().trim().min(1).max(120).optional().describe('A revision to show when no file path applies.'),
          template: z.string().trim().min(1).max(500).optional().describe('The historical template or document the work followed, when one applies.'),
        }).strict()).max(20).optional()
          .describe('Skills actually loaded for this result. A ready report must list every required skill the assignment names.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        pr_number: z.number().int().positive().nullish().describe('Source PR, a ticket-branch PR, or an existing owned PR with pr_adoption_reason.'),
        pr_repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).optional().describe('Repository of pr_number. Required for multi-repository work without a GitHub origin.'),
        pr_adoption_reason: z.string().trim().min(1).max(500).optional().describe('Why this existing PR belongs to the accepted goal.'),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        // The Assignment this call starts in owns its write; the Engine refuses a report after a retry or hand-over replaces it.
        const assignmentId = (runningAssignment(current) ?? latestAssignment(current))?.id
        if (!assignmentId) throw new UserError('unknownAssignment')
        if (args.pr_number != null && !host.github.deployment.github) throw new Error('This installation has no GitHub account; report the task result without pr_number')
        if (args.pr_repository && args.pr_number == null) throw new Error('pr_repository requires pr_number')
        if (args.pr_adoption_reason && args.pr_number == null) throw new Error('pr_adoption_reason requires pr_number')
        const skills = args.skills?.length ? reportedSkills(args.skills, current.execution?.directory ?? process.cwd()) : undefined
        const origin = host.github.triggers.get(current.origin.triggerId)
        const repository = args.pr_repository ?? (typeof origin?.meta.repository === 'string' ? origin.meta.repository : undefined)
        if (args.pr_number != null && host.github.deployment.githubRepositories?.length && !repository) {
          throw new Error('Name pr_repository explicitly; this workbench monitors multiple repositories')
        }
        const github = repository ? repositoryContext(host.github, repository) : host.github
        const pull = args.pr_number != null ? await readPull(github, args.pr_number, signal) : undefined
        if (args.files?.length && !origin) throw new Error('Task origin is unavailable for file delivery')
        const files = args.files?.length ? await host.resources.sources.publishFiles(origin!, current, args.files) : []
        const deliverables = [...args.deliverables ?? [], ...files]
        if (deliverables.length > 10) throw new Error('At most 10 deliverables per report')
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        return host.store.atomic(() => {
          const pending = host.store.tickets.get(ticketId)
          if (!pending || !liveTicket(pending)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
          // Recheck inside the commit transaction, before any claim or relay, so a replaced Assignment owns no write from this call.
          if ((runningAssignment(pending) ?? latestAssignment(pending))?.id !== assignmentId) throw new UserError('assignmentEnded')
          if ((args.state === 'ready' || args.state === 'dropped') && ticketFollowups(pending).length) {
            throw new Error('The scheduled follow-up is pending. End the turn to wait, or cancel the follow-up before reporting ready or dropped.')
          }
          const refused = pull && claimPull(github, ticketId, pull, args.pr_adoption_reason)
          if (refused) throw new Error(refused)
          if ((args.recommendation || args.recommendation_reason || args.risk || args.draft) && !args.human_action) {
            throw new Error('recommendation, recommendation_reason, risk and draft require human_action')
          }
          const advice = args.recommendation ? { summary: args.recommendation,
            ...(args.recommendation_reason ? { reason: args.recommendation_reason } : {}),
            ...(args.risk ? { risk: args.risk } : {}), ...(args.draft ? { draft: args.draft } : {}) } : undefined
          const report = { state: args.state, summary: args.summary, ...(args.deliverables || args.files ? { deliverables } : {}),
            ...(args.method ? { method: args.method } : {}), ...(skills?.length ? { skills } : {}),
            ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(advice ? { advice } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}) }
          const updated = host.engine.report(ticketId, report, assignmentId)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}) }
        })
      },
    }),
  ]
}
