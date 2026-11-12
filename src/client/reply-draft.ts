/** Unsent long replies stay with the exact destination they were written for, so reopening or switching cannot replace them. */
import { useRef } from 'react'

/** One editor destination: a Ticket, the Question it answers, and an optional correction record to drop after sending. */
export interface ReplyDraftTarget { ticketId: string; attentionId?: string; forgetAttentionId?: string }

/** A replaced Question gets its own key, so text written for the earlier one is never reused for the new one silently. */
export const replyDraftKey = (target: ReplyDraftTarget): string =>
  [target.ticketId, target.attentionId ?? '', target.forgetAttentionId ?? ''].join('\u0000')

/**
 * Write-through store of unsent reply text, keyed by destination and bounded to the mounted panel. It holds no business
 * state and sends nothing; successful submission or an explicit discard is what removes an entry.
 */
export function useReplyDrafts() {
  const stored = useRef(new Map<string, string>())
  return {
    read: (target: ReplyDraftTarget): string | undefined => stored.current.get(replyDraftKey(target)),
    write: (target: ReplyDraftTarget, text: string): void => {
      const key = replyDraftKey(target)
      if (text) stored.current.set(key, text)
      else stored.current.delete(key)
    },
    forget: (target: ReplyDraftTarget): void => { stored.current.delete(replyDraftKey(target)) },
  }
}
