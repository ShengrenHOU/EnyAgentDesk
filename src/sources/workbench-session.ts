/** Capture an immutable discussion prefix through the installed DSH Session Controller. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { WorkbenchContextSchema, type WorkbenchContext } from './workbench.ts'

/** Original user and assistant messages are evidence; injected notices and reasoning are excluded. */
export function discussionContext(inspection: SessionInspection, sessionId: string, throughSeq: number,
  store?: Pick<AttachmentStore, 'fileHostPath' | 'imageHostPath'>): WorkbenchContext {
  if (inspection.meta.id !== sessionId) throw new Error('Session inspection returned another discussion')
  // The Main Session is the owner's one face; worker Sessions and subagents remain managed execution.
  const managed = inspection.meta.agentPreset?.startsWith('dsh-superagent-')
    && inspection.meta.agentPreset !== 'dsh-superagent-router'
  if (inspection.meta.origin === 'subagent' || managed) {
    throw new Error('Managed worker and subagent Sessions are not owner discussions')
  }
  if (!Number.isSafeInteger(throughSeq) || throughSeq < 0 || !inspection.events.some(event => event.seq === throughSeq)) {
    throw new Error('The selected discussion boundary is unavailable')
  }
  const messages: WorkbenchContext['messages'] = []
  const attachments = new Map<string, WorkbenchContext['attachments'][number]>()
  let partial = false, remaining = 200_000
  // Start at the latest selected evidence so the user's most recent corrections survive the bounded capture.
  for (const event of [...inspection.events].reverse()) {
    if (event.seq > throughSeq || (event.type !== 'user/message' && event.type !== 'assistant/message')) continue
    const message = event.type === 'user/message' ? event.data : event.data.message
    if (event.type === 'user/message' && message.source.kind !== 'user') continue
    if (messages.length === 500 || remaining === 0) { partial = true; break }
    const text: string[] = [], references: string[] = []
    for (const block of message.content) {
      if (block.type === 'text') text.push(block.text)
      else if (block.type === 'file' || block.type === 'image') {
        const reference = `dsh-attachment:${block.attachment.attachmentId}`
        references.push(reference)
        const readonlyPath = block.type === 'file' ? store?.fileHostPath(block.attachment) : store?.imageHostPath(block.attachment)
        attachments.set(reference, { reference, kind: block.type, name: block.attachment.name ?? block.attachment.attachmentId,
          ...(readonlyPath ? { readonlyPath } : {}) })
        if (!readonlyPath) partial = true
        text.push(`[${block.type}: ${block.attachment.name ?? block.attachment.attachmentId}]`)
      }
    }
    const full = text.join('\n')
    if (!full && !references.length) continue
    const captured = full.slice(0, remaining)
    partial ||= captured.length !== full.length
    remaining -= captured.length
    messages.unshift({ seq: event.seq, role: event.type === 'user/message' ? 'user' : 'assistant',
      text: captured, at: new Date(event.time).toISOString(), references })
  }
  if (!messages.some(message => message.role === 'user')) throw new Error('No owner discussion is available at this boundary')
  return WorkbenchContextSchema.parse({ sessionId, throughSeq, messages, partial, attachments: [...attachments.values()] })
}

/** Read persisted or attached discussion history without starting another Agent or copying browser-provided history. */
export async function readDiscussion(controller: Pick<Context['sessionController'], 'inspect'>, sessionId: string,
  throughSeq: number, signal?: AbortSignal, attachments?: Pick<AttachmentStore, 'fileHostPath' | 'imageHostPath'>): Promise<WorkbenchContext> {
  return discussionContext(await controller.inspect(sessionId as SessionId, signal), sessionId, throughSeq, attachments)
}
