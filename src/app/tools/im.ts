/** The shared read-only IM window tool for the Main Session and ticket workers. */
import { z } from 'zod'
import { readImWindow, type ImReadHost } from '../im-read.ts'
import { tool, type Tool } from './tool.ts'

export function imReadTool(host: ImReadHost): Tool {
  return tool({
    name: 'orchestrator_im_read',
    description: 'Read one bounded, read-only Feishu or WeChat conversation window by native ID or exact display name. '
      + 'Returns messages with stable identity, source gaps and a continuation cursor; an ambiguous name returns candidates. '
      + 'At most seven days. It never sends, acknowledges, attaches evidence or grants authority.',
    schema: z.object({
      provider: z.enum(['feishu-messages', 'wechat']).describe('feishu-messages or wechat.'),
      conversation: z.string().trim().min(1).max(200).describe('Native conversation ID or an exact display name.'),
      start: z.string().datetime({ offset: true }).describe('Inclusive ISO start with offset.'),
      end: z.string().datetime({ offset: true }).describe('Exclusive ISO end with offset; at most seven days.'),
      keyword: z.string().trim().min(1).max(200).optional().describe('Optional keyword filter for this window.'),
      cursor: z.string().max(16384).optional().describe('Copy next from the previous page.'),
    }).strict(),
    execute: async (args, signal) => readImWindow(host, args, signal),
  })
}
