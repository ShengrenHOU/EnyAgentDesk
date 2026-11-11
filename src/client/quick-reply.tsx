/** One-line replies in place of the composer: on a Ticket that needs you, and under the newest main-conversation Turn. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button } from './controls.tsx'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { errorText, type T } from './text.ts'

/** Sends on Enter and keeps the text when the send fails, so a short answer is never typed twice. */
export function QuickReply({ value, onChange, onSubmit, busy, disabled = false, placeholder, maxLength = 2000 }: {
  value: string; onChange(value: string): void; onSubmit(): void; busy: boolean; disabled?: boolean; placeholder: string
  maxLength?: number
}) {
  const { t } = usePanel()
  return <form className="dt-quick" onSubmit={event => {
    event.preventDefault()
    if (value.trim() && !busy && !disabled) onSubmit()
  }}>
    <input value={value} maxLength={maxLength} disabled={busy} aria-label={placeholder} placeholder={placeholder}
      onChange={event => onChange(event.target.value)} />
    <Button type="submit" size="sm" variant="outline" disabled={busy || disabled || !value.trim()}
      title={disabled ? t('masterNotReady') : undefined}>{t(busy ? 'quickReplySending' : 'quickReplySend')}</Button>
  </form>
}

/**
 * Newest completed Turn of each Session. Only that Turn offers the one-line reply, so one control stays at the conversation
 * end instead of one per Turn; the largest Turn number seen never decreases, so scrolling history does not move it.
 */
const newestTurn = new Map<string, number>()
const watchers = new Set<() => void>()
function reportTurn(sessionId: string, turn: number): void {
  if ((newestTurn.get(sessionId) ?? -1) >= turn) return
  newestTurn.set(sessionId, turn)
  for (const watcher of watchers) watcher()
}
const watchTurns = (watcher: () => void) => { watchers.add(watcher); return () => { watchers.delete(watcher) } }
const none = () => false

/** One draft per Session, so a Turn that newly takes the control keeps what the owner already typed. */
const sessionDrafts = new Map<string, string>()
const sessionSending = new Set<string>()
const draftWatchers = new Set<() => void>()
const announceDraft = () => { for (const watcher of draftWatchers) watcher() }
function writeDraft(sessionId: string, text: string): void {
  if (text) sessionDrafts.set(sessionId, text)
  else sessionDrafts.delete(sessionId)
  announceDraft()
}
/** A send already in flight belongs to the Session, so a Turn handover cannot offer the same line again. */
function writeSending(sessionId: string, sending: boolean): void {
  if (sending) sessionSending.add(sessionId)
  else sessionSending.delete(sessionId)
  announceDraft()
}
const watchDrafts = (watcher: () => void) => { draftWatchers.add(watcher); return () => { draftWatchers.delete(watcher) } }
const useSessionDraft = (sessionId: string) =>
  useSyncExternalStore(watchDrafts, () => sessionDrafts.get(sessionId) ?? '', () => '')
const useSessionSending = (sessionId: string) =>
  useSyncExternalStore(watchDrafts, () => sessionSending.has(sessionId), none)

/** One-line answer under the newest Turn: the text reaches the same main Session the composer would. */
function TurnReply({ sessionId, send }: { sessionId: string; send(text: string): Promise<void> }) {
  const { t } = usePanel()
  const { state } = usePanelData()
  const text = useSessionDraft(sessionId)
  const busy = useSessionSending(sessionId)
  const [sent, setSent] = useState(false)
  const [failure, setFailure] = useState<string>()
  const submit = async () => {
    const answer = text.trim()
    if (!answer || busy) return
    writeSending(sessionId, true); setFailure(undefined)
    try { await send(answer); writeDraft(sessionId, ''); setSent(true) }
    catch (error) { setFailure(errorText(error)) }
    finally { writeSending(sessionId, false) }
  }
  if (state?.masterId !== sessionId) return null
  return <div className="dt-turn-reply">
    <QuickReply value={text} busy={busy} placeholder={t('quickReplyHere')}
      onChange={value => { writeDraft(sessionId, value); setSent(false) }} onSubmit={() => void submit()} />
    {failure && <p className="dt-error" role="alert">{failure}</p>}
    {sent && !failure && <p className="dt-hint" role="status">{t('quickReplySent')}</p>}
  </div>
}

/** Registers one completed Turn; only a Session's newest Turn mounts the reply, and only for the main Session. */
export function TurnQuickReply({ sessionId, turn, t, send }: {
  sessionId: string; turn: number; t: T; send(text: string): Promise<void>
}) {
  const current = useSyncExternalStore(watchTurns, () => newestTurn.get(sessionId) === turn, none)
  useEffect(() => { reportTurn(sessionId, turn) }, [sessionId, turn])
  if (!current) return null
  return <PanelProvider t={t}><TurnReply sessionId={sessionId} send={send} /></PanelProvider>
}
