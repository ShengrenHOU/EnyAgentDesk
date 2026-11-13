/** Normalized, read-only changes and reader contracts shared by the activity Source adapters. */
import type { Commands } from '../infra/commands.ts'
import type { SourceContext } from './host.ts'
import type { ContextPart, ContextPartName } from './kind.ts'
import type { Context } from '@deepseek-ai/cordis'

export type ActivityProvider = 'feishu-messages' | 'feishu-documents' | 'wechat'
export type ActivityLocator =
  | { provider: 'feishu-messages'; chatId: string; messageId: string }
  | { provider: 'feishu-documents'; token: string; type: string; url: string }
  | { provider: 'wechat'; contact: string; messageRef: string; start: string; end: string }

/** A source-native object version; source text is evidence and never an execution mandate. */
export interface ActivityEvent {
  provider: ActivityProvider
  accountId: string
  objectId: string
  id: string
  threadId?: string
  version: string
  at: string
  text: string
  reference: string
  locator: ActivityLocator
  label?: string
  senderId?: string
  senderLabel?: string
  senderType?: string
  senderIdType?: string
  contentType?: string
  parentId?: string
  /** Source-native direction evidence; never proof of sender identity or authority. */
  direction?: string
  url?: string
  contentPartial?: boolean
}
export interface ActivityRange { start: string; end: string }
export interface ActivityScan {
  records: number
  objects: number
  complete: boolean
  contentPartial?: number
  /** Messages this reader left to another Source so one conversation has one collector. */
  skipped?: number
  detail?: string
}
/** Readers confirm external batches only after emit has durably handed every version to the monitor ticket. */
export interface ActivityReaderContext {
  source: SourceContext
  signal: AbortSignal
  consumerId: string
  assertActive(): void
  emit(event: ActivityEvent): Promise<'stored' | 'duplicate'>
}
export interface LarkActivityBinding {
  configDir?: string
  /** Native lark-cli used for owner reads, independent of the Feishu bot Source. */
  cli?: string
  expectedUserId: string
}
export interface WechatActivityBinding { serverName: string }
export interface ActivityBindings { lark: LarkActivityBinding; wechat: WechatActivityBinding }
export type ActivityTools = Pick<Context['tools'], 'execute' | 'schemas'>
export type ActivityContextReader = (commands: Commands, event: ActivityEvent, part: ContextPartName,
  cursor?: string) => Promise<ContextPart>
