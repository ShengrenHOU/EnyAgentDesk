/** One-line replies on a Ticket that needs you, or quoting a selected main-conversation Turn. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button } from './controls.tsx'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { errorText, type T } from './text.ts'

/** Sends on Enter and keeps the text when the send fails, so a short answer is never typed twice. */
export function QuickReply({ value, onChange, onSubmit, busy, disabled = false, placeholder, maxLength = 2000, onFocus, autoFocus }: {
  value: string; onChange(value: string): void; onSubmit(): void; busy: boolean; disabled?: boolean; placeholder: string
  maxLength?: number; onFocus?(): void; autoFocus?: boolean
}) {
  const { t } = usePanel()
  return <form className="dt-quick" onSubmit={event => {
    event.preventDefault()
    if (value.trim() && !busy && !disabled) onSubmit()
  }}>
    <input value={value} maxLength={maxLength} disabled={busy} aria-label={placeholder} placeholder={placeholder} autoFocus={autoFocus} onFocus={onFocus}
      onChange={event => onChange(event.target.value)} />
    <Button type="submit" size="sm" variant="outline" disabled={busy || disabled || !value.trim()}
      title={disabled ? t('masterNotReady') : undefined}>{t(busy ? 'quickReplySending' : 'quickReplySend')}</Button>
  </form>
}

/** DSH owns the immutable message identity; this store only holds browser editing state. */
interface ReplyTarget { turn: number; seq: number; quote: string }
const newestTurn = new Map<string, ReplyTarget>()
const selectedTurn = new Map<string, ReplyTarget>()
let mainSessionId: string | undefined
const watchers = new Set<() => void>()
const announce = () => { for (const watcher of watchers) watcher() }
function reportTurn(sessionId: string, target: ReplyTarget): void {
  if ((newestTurn.get(sessionId)?.turn ?? -1) >= target.turn) return
  newestTurn.set(sessionId, target)
  announce()
}
const watchTurns = (watcher: () => void) => { watchers.add(watcher); return () => { watchers.delete(watcher) } }
const none = () => false
function selectTurn(sessionId: string, target?: ReplyTarget): void {
  if (target) selectedTurn.set(sessionId, target)
  else selectedTurn.delete(sessionId)
  announce()
}

/** A new Turn cannot inherit text written for an earlier message. */
const sessionDrafts = new Map<string, Map<number, string>>()
const sessionSending = new Set<string>()
function writeDraft(sessionId: string, seq: number, text: string): void {
  const drafts = sessionDrafts.get(sessionId) ?? new Map<number, string>()
  if (text) drafts.set(seq, text)
  else drafts.delete(seq)
  if (drafts.size) sessionDrafts.set(sessionId, drafts)
  else sessionDrafts.delete(sessionId)
  announce()
}
/** One in-flight submission per Session, even if another Turn is being viewed. */
function writeSending(sessionId: string, sending: boolean): void {
  if (sending) sessionSending.add(sessionId)
  else sessionSending.delete(sessionId)
  announce()
}
const turnReplyEditing = (sessionId: string): boolean => sessionSending.has(sessionId) || !!sessionDrafts.get(sessionId)?.size
export const useTurnReplyEditing = (sessionId: string): boolean => useSyncExternalStore(watchTurns, () => turnReplyEditing(sessionId), none)
const useSessionDraft = (sessionId: string, seq: number) =>
  useSyncExternalStore(watchTurns, () => sessionDrafts.get(sessionId)?.get(seq) ?? '', () => '')
const useSessionSending = (sessionId: string) =>
  useSyncExternalStore(watchTurns, () => sessionSending.has(sessionId), none)

/** Queue a new owner reply with an explicit, bounded quote; never replay or overwrite an older Turn. */
function TurnReply({ sessionId, target, send }: { sessionId: string; target: ReplyTarget; send(text: string): Promise<void> }) {
  const { t } = usePanel()
  const { state } = usePanelData()
  const text = useSessionDraft(sessionId, target.seq)
  const busy = useSessionSending(sessionId)
  const [sent, setSent] = useState(false)
  const [failure, setFailure] = useState<string>()
  const quote = target.quote.length > 4000 ? `${target.quote.slice(0, 1990)}\n[…]\n${target.quote.slice(-1990)}` : target.quote
  useEffect(() => {
    if (!state?.masterId || state.masterId === mainSessionId) return
    mainSessionId = state.masterId; announce()
  }, [state?.masterId])
  const submit = async () => {
    const answer = text.trim()
    if (!answer || busy) return
    selectTurn(sessionId, target)
    writeSending(sessionId, true); setFailure(undefined)
    const reference = `${t('quickReplyContext', { turn: target.turn + 1, seq: target.seq })}\n${quote.split('\n').map(line => `> ${line}`).join('\n')}`
    try {
      await send(`${reference}${target.quote.length > 4000 ? `\n${t('quickReplyExcerpt')}` : ''}\n\n${t('quickReplyAnswer')}\n${answer}`)
      writeDraft(sessionId, target.seq, ''); setSent(true)
      selectTurn(sessionId)
    }
    catch (error) { setFailure(errorText(error)) }
    finally { writeSending(sessionId, false) }
  }
  if (state?.masterId !== sessionId && !text && !busy) return null
  return <div className="dt-turn-reply">
    <div className="dt-reply-target">
      <details><summary>{t('quickReplyTarget', { turn: target.turn + 1 })} · {target.quote.slice(0, 100) || t('quickReplyNoText')}</summary>
        <blockquote>{quote || t('quickReplyNoText')}</blockquote></details>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => selectTurn(sessionId)}>{t('quickReplyLatest')}</Button>
    </div>
    <QuickReply value={text} busy={busy} placeholder={t('quickReplyHere')}
      autoFocus={selectedTurn.get(sessionId)?.seq === target.seq} onFocus={() => selectTurn(sessionId, target)}
      onChange={value => { selectTurn(sessionId, target); writeDraft(sessionId, target.seq, value); setSent(false) }} onSubmit={() => void submit()} />
    {failure && <p className="dt-error" role="alert">{failure}</p>}
    {sent && !failure && <p className="dt-hint" role="status">{t('quickReplySent')}</p>}
  </div>
}

/** Historical Turns expose only a button; only the active editor mounts a polling panel. */
type TurnReplyProps = {
  sessionId: string; turn: number; seq: number; quote: string; t: T; send(text: string): Promise<void>
}
export function TurnQuickReply(props: TurnReplyProps) {
  if (props.sessionId.startsWith('worker-')) return null
  return <MainTurnReply {...props} />
}

/** Confirm the short Ticket record from the original assistant reply without sending a new chat turn. */
export function WorkerDiscussionSave({ sessionId, throughSeq, t }: { sessionId: string; throughSeq: number; t: T }) {
  const [open, setOpen] = useState(false)
  const [summary, setSummary] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [failure, setFailure] = useState<string>()
  const submit = async () => {
    if (!summary.trim() || busy) return
    setBusy(true); setFailure(undefined)
    try {
      const response = await fetch('/api/superagent-workbench/worker-discussion', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, throughSeq, summary: summary.trim() }) })
      const receipt = await response.json()
      if (!response.ok) throw new Error(receipt.error ?? t('discussionConclusionFailed'))
      if (receipt.sessionId !== sessionId || receipt.throughSeq !== throughSeq) throw new Error(t('discussionConclusionFailed'))
      setSaved(true); setOpen(false)
    } catch (error) { setFailure(errorText(error)) }
    finally { setBusy(false) }
  }
  if (saved) return <p className="dt-hint" role="status">{t('discussionConclusionSaved')}</p>
  if (!open) return <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>{t('discussionConclusionSave')}</Button>
  return <form className="dt-turn-reply dt-fields" onSubmit={event => { event.preventDefault(); void submit() }}>
    <label className="dt-field">
      <span>{t('discussionConclusionLabel')}</span>
      <textarea autoFocus rows={3} maxLength={600} value={summary} disabled={busy}
        placeholder={t('discussionConclusionHint')} onChange={event => setSummary(event.target.value)} />
    </label>
    <div className="pw-actions">
      <Button size="sm" variant="outline" type="submit" disabled={busy || !summary.trim()}>{t('save')}</Button>
      <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => setOpen(false)}>{t('cancel')}</Button>
    </div>
    {failure && <p role="alert" className="dt-error">{failure}</p>}
  </form>
}

function MainTurnReply({ sessionId, turn, seq, quote, t, send }: TurnReplyProps) {
  const target = { turn, seq, quote }
  const current = useSyncExternalStore(watchTurns, () => (selectedTurn.get(sessionId) ?? newestTurn.get(sessionId))?.seq === seq, none)
  const main = useSyncExternalStore(watchTurns, () => mainSessionId === sessionId, none)
  const busy = useSessionSending(sessionId), editing = useTurnReplyEditing(sessionId)
  useEffect(() => { reportTurn(sessionId, { turn, seq, quote }) }, [sessionId, turn, seq, quote])
  if (!current) return main || editing ? <Button size="sm" variant="ghost" disabled={busy}
    onClick={() => selectTurn(sessionId, target)}>{t('quickReplySelect')}</Button> : null
  return <PanelProvider t={t}><TurnReply sessionId={sessionId} target={target} send={send} /></PanelProvider>
}
