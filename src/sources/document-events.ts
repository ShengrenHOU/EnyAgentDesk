/** Read only configured document objects after their durable native notifications. */
import { z } from 'zod'
import { key } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { finishLarkEvent, pendingLarkEvents } from './lark-event-inbox.ts'
import { larkUserBinding, type LarkUserBinding } from './lark-user.ts'
import type { ActivityConfig } from './activity.ts'
import type { ActivityEvent } from './activity-types.ts'
import type { SourceContext } from './host.ts'

const Document = z.object({ document: z.object({ document_id: z.string(), revision_id: z.number(), content: z.string(), tips: z.string().optional() }) })

export async function documentEventChanges(ctx: SourceContext, binding: LarkUserBinding, config: ActivityConfig, signal: AbortSignal,
  deliver: (event: ActivityEvent) => Promise<void>): Promise<void> {
  const pending = pendingLarkEvents(ctx, binding.expectedUserId, 'documents')
  const failures: string[] = []
  const signature = JSON.stringify(config)
  const active = () => {
    signal.throwIfAborted()
    if (JSON.stringify(ctx.config<ActivityConfig>('activity')) !== signature) throw new Error('Document watch configuration changed')
  }
  let user: Awaited<ReturnType<typeof larkUserBinding>> | undefined
  const grouped = new Map<string, typeof pending>()
  for (const event of pending) {
    const token = z.string().min(1).safeParse(event.payload.file_token)
    if (!token.success) { failures.push(`${event.eventId}: invalid document identity`); continue }
    grouped.set(token.data, [...grouped.get(token.data) ?? [], event])
  }
  for (const [token, notifications] of grouped) {
    const watched = config.watchedDocuments.find(item => item.token === token)
    if (!watched) {
      active()
      for (const event of notifications) finishLarkEvent(ctx, binding.expectedUserId, 'documents', event, 'outside_scope')
      continue
    }
    try {
      const latest = notifications.at(-1)!
      if (latest.payload.file_type !== watched.type) throw new Error('Document notification type differs from its configured object')
      let text = `Document changed: ${watched.name ?? token}`, version = key(...notifications.map(event => event.eventId)), partial = true
      if (watched.type === 'docx' && latest.eventType !== 'drive.file.deleted_v1') {
        user ??= await larkUserBinding(ctx.commands.withSignal(signal), binding, active)
        const result = await user.read(Document, ['docs', '+fetch', '--doc', token, '--doc-format', 'markdown'])
        if (result.document.document_id !== token) throw new Error('Document read returned another identity')
        text = result.document.content; version = `revision:${result.document.revision_id}`
        partial = text.length > 20_000 || !!result.document.tips
      } else if (latest.eventType === 'drive.file.deleted_v1') text = `Document deletion event: ${watched.name ?? token}`
      active()
      await deliver({ provider: 'feishu-documents', accountId: binding.expectedUserId, objectId: `${watched.type}:${token}`,
        id: token, version: key(version, text), at: new Date(Number(latest.at)).toISOString(), text: text.slice(0, 20_000), reference: watched.url,
        locator: { provider: 'feishu-documents', token, type: watched.type, url: watched.url }, url: watched.url,
        label: watched.name ?? token, contentPartial: partial })
      active()
      ctx.atomic(() => { for (const event of notifications) finishLarkEvent(ctx, binding.expectedUserId, 'documents', event) })
    } catch (error) {
      active()
      failures.push(`${token}: ${error instanceof Error ? error.name : 'read or delivery failed'}${error instanceof CliError && error.code ? ` (${error.code})` : ''}`)
    }
  }
  if (failures.length) throw new Error(`Document notifications retained for retry (${failures.length}): ${failures.join('; ')}`)
}
