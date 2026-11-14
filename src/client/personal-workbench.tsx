/** Personal workspace: the open Lines lead, then the decision queue and the work that still runs; detailed discussion stays in the main Session. */
import { CanonicalMatters } from './triage-matters.tsx'
import { ProductionJudgments } from './production-triage.tsx'
import { useEffect, useRef, useState } from 'react'
import type { readFocus } from '../sources/workbench-focus.ts'
import { answerAttention, usePoll, type LineRow, type TicketRow } from './api.ts'
import { Button, Icon, Tag } from './controls.tsx'
import { ticketMark } from './marks.ts'
import { ProblemList } from './overview.tsx'
import { LineDetail } from './line.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { ReplyForm } from './reply-form.tsx'
import { replyDraftKey, useReplyDrafts } from './reply-draft.ts'
import { PendingFollowups } from './rows.tsx'
import { errorText, fullTime, localized, valueLabel, when, type T } from './text.ts'
import { CloseTicketButton, ConfirmButton, ExternalLink, LoadState, MarkdownLite } from './widgets.tsx'

interface QueueAdvice { summary: string; reason?: string; risk?: string; draft?: string }
interface QueueItem {
  id: string; ticketId: string; attentionId: string; title: string; question: string
  advice?: QueueAdvice; source?: string; at: string; priority?: 'low' | 'normal' | 'high' | 'urgent'
}
interface QueueView {
  items: QueueItem[]
  deferred: (QueueItem & { until: string })[]
  ignored: (QueueItem & { ignoredAt: string; reason: string })[]
  counts: { open: number; deferred: number; ignored: number }
}
/** The fields a failed or blocked Ticket needs for its close action, shared by list rows and their detail. */
type CloseTarget = { id: string; title: string; actions: { retry: boolean; stop: boolean }; stage: string; action?: string }
interface Props {
  t: T
  send(id: string, text: string): Promise<void>
  openSession(id: string): Promise<void>; openManagement(id?: string, threadKey?: string): void
  openDomainSettings(): void
  openGithubSettings(): void
  openWorkList(filter: 'open' | 'ended'): void
}
async function read<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/superagent-workbench/${path}`, init)
  if (!response.ok) throw new Error((await response.json()).error ?? `Workbench request failed (${response.status})`)
  return response.json()
}
/** A one-click decision still passes through the authenticated owner answer route, not a browser-supplied identity. */
interface ReplyTarget { ticketId: string; title: string; attentionId?: string; question?: string
  /** A folded “no action needed” record to drop only after the correction is actually sent. */
  forgetAttentionId?: string }

export function Workbench(props: Props) {
  const { t, call } = usePanel()
  const { state, error: stateError } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET overview'), [])
  const queue = usePoll(() => read<QueueView>('queue'), [])
  const ready = !!state?.masterId
  const focus = usePoll(() => read<ReturnType<typeof readFocus>>('focus'), [])
  const sources = usePoll(() => call('GET sources'), [])
  const [domainId, setDomainId] = useState('')
  const [chatOpen, setChatOpen] = useState(false)
  const [selected, setSelected] = useState<string>()
  const [selectedLine, setSelectedLine] = useState<string>()
  const [reply, setReply] = useState<ReplyTarget>()
  const [instruction, setInstruction] = useState('')
  const drafts = useReplyDrafts()
  const [ignoring, setIgnoring] = useState<string>()
  const [ignoreReason, setIgnoreReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [focusSending, setFocusSending] = useState(false)
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState<string>()
  const [actionFailure, setActionFailure] = useState<string>()
  const [preview, setPreview] = useState<{ title: string; url: string }>()
  const previewPanel = useRef<HTMLElement | null>(null)
  const previewTrigger = useRef<HTMLElement | null>(null)
  // The inline preview renders above the list, so open it in view and give it focus; closing returns focus to its trigger.
  useEffect(() => {
    if (!preview) return
    previewPanel.current?.scrollIntoView?.({ block: 'nearest' })
    previewPanel.current?.focus()
  }, [preview])
  const openPreview = (item: { title: string; url: string }, trigger: HTMLElement) => { previewTrigger.current = trigger; setPreview(item) }
  const closePreview = () => {
    setPreview(undefined)
    const trigger = previewTrigger.current
    previewTrigger.current = null
    if (trigger?.isConnected) trigger.focus()
  }
  const detail = usePoll(() => selected ? call('GET tickets/:id', { id: selected }) : Promise.resolve(null), [selected])
  const lines = usePoll(() => call('GET lines'), [])
  const lineDetail = usePoll(() => selectedLine ? call('GET lines/:id', { id: selectedLine }) : Promise.resolve(null), [selectedLine])
  const refreshing = !!focus.data?.requested && (!focus.data.focus || focus.data.requested.at > focus.data.focus.generatedAt)
  const change = async () => { await Promise.all([reload(), queue.reload(), detail.reload(), lines.reload(), lineDetail.reload()]) }
  const refresh = async () => {
    if (focusSending) return
    setFocusSending(true); setFailure(undefined)
    try { await read('focus/refresh', { method: 'POST' }); await focus.reload() }
    catch (error) { setFailure(errorText(error)) }
    finally { setFocusSending(false) }
  }
  /** Sends one line to the main Session; a decision or supplement still belongs to the selected matter. */
  const send = async (text: string): Promise<boolean> => {
    if (busy) return false
    if (!state?.masterId) { setFailure(t('masterNotReady')); return false }
    setBusy(true); setFailure(undefined)
    try {
      await props.send(state.masterId, text)
      setNotice(t('homeSent')); setReply(undefined); setInstruction(''); setChatOpen(false)
      return true
    } catch (error) { setFailure(errorText(error)); return false }
    finally { setBusy(false) }
  }
  /** Detailed discussion belongs to the main Session, so open it once the message was accepted. */
  const discuss = async (text: string) => {
    if (!await send(text) || !state?.masterId) return
    await props.openSession(state.masterId).catch(error => setFailure(errorText(error)))
  }
  /** The exact Question the host now shows for a Ticket, so a draft left on an earlier one can warn instead of failing. */
  const liveAttention = (ticketId: string): { id: string; question: string } | undefined => {
    const decision = queue.data && [...queue.data.items, ...queue.data.deferred].find(item => item.ticketId === ticketId)
    if (decision) return { id: decision.attentionId, question: decision.question }
    const row = [...(data?.person ?? []), ...(data?.work?.working ?? []), ...(data?.work?.waiting ?? []),
      ...(data?.work?.delivered ?? [])].find(ticket => ticket.id === ticketId)
    if (row?.attention) return { id: row.attention.id, question: row.attention.question }
    const shown = detail.data?.id === ticketId ? detail.data : undefined
    return shown?.attention ? { id: shown.attention.id, question: shown.attention.question } : undefined
  }
  const respond = (target: ReplyTarget, prefilled = '') => {
    // A pending action owns the editor; the same destination keeps typed text, and a different one restores its own draft.
    if (busy) return
    if (reply) {
      // Reopening the same destination, or a Question replaced on the same Ticket, keeps the editor and its text; only
      // the explicit "use for the new question" action binds the draft to the replacement.
      const kept = replyDraftKey(reply) === replyDraftKey(target) || (reply.ticketId === target.ticketId
        && !!reply.attentionId && !!target.attentionId && reply.attentionId !== target.attentionId)
      if (kept) { setNotice(''); setPreview(undefined); setChatOpen(true); return }
      drafts.write(reply, instruction)
    }
    setReply(target); setInstruction(drafts.read(target) ?? prefilled); setNotice(''); setPreview(undefined); setChatOpen(true)
  }
  const adoptAttention = (question: { id: string; question: string }) => {
    // An in-flight answer owns the editor until it settles, so its target cannot move to another Question meanwhile.
    if (!reply || busy) return
    drafts.forget(reply)
    const target = { ...reply, attentionId: question.id, question: question.question }
    drafts.write(target, instruction)
    setReply(target)
  }
  /** A Question that replaced the edited one on the same Ticket; the draft is kept until the owner moves or discards it. */
  const replacedQuestion = (() => {
    if (!reply?.attentionId) return undefined
    const live = liveAttention(reply.ticketId)
    return live && live.id !== reply.attentionId ? live : undefined
  })()
  const submitReply = async () => {
    if (!reply || !instruction.trim() || busy) return
    const target = reply
    if (!target.attentionId) {
      // Keep the folded record until the correction actually leaves: cancelling or a failed send must not erase it.
      if (!await send(`请继续已有工单 ${target.ticketId}。本人补充或修改要求如下。\n\n${instruction.trim()}`)) return
      drafts.forget(target)
      if (target.forgetAttentionId) {
        try {
          await read('queue/action', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'forget', ticketId: target.ticketId, attentionId: target.forgetAttentionId }) })
          setNotice(t('queueReopenedNotice')); await queue.reload()
        } catch (error) { setFailure(errorText(error)) }
      }
      return
    }
    setBusy(true); setFailure(undefined)
    try {
      await answerAttention(t, target.ticketId, target.attentionId, instruction.trim())
      drafts.forget(target)
      setNotice(t('ticketAnswerSent')); setReply(undefined); setInstruction(''); setChatOpen(false)
      await change()
    } catch (error) { setFailure(errorText(error)) }
    finally { setBusy(false) }
  }
  /** Accepting advice sends the reviewed draft (or the recommendation itself) as the owner's answer. */
  const accept = async (item: QueueItem) => {
    const text = item.advice?.draft?.trim() || item.advice?.summary.trim()
    if (!text || busy) return
    setBusy(true); setFailure(undefined)
    try {
      await answerAttention(t, item.ticketId, item.attentionId, text)
      setNotice(t('queueAccepted')); await change()
    } catch (error) { setFailure(errorText(error)) }
    finally { setBusy(false) }
  }
  /** Returns whether the queue action was saved, so a form keeps its text when the host refused it. */
  const queueAction = async (body: Record<string, unknown>, success: string): Promise<boolean> => {
    if (busy) return false
    setBusy(true); setFailure(undefined); setActionFailure(undefined)
    try { await read('queue/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      setNotice(success); await change(); return true
    } catch (error) { setActionFailure(errorText(error)); return false }
    finally { setBusy(false) }
  }
  const tomorrowMorning = () => {
    const at = new Date(); at.setDate(at.getDate() + 1); at.setHours(9, 0, 0, 0); return at.toISOString()
  }
  const defer = (item: QueueItem) => {
    const until = tomorrowMorning()
    return queueAction({ action: 'defer', ticketId: item.ticketId, attentionId: item.attentionId, until },
      t('queueDeferredNotice', { at: fullTime(until, t('lang')) }))
  }
  const ignore = async (item: QueueItem) => {
    const reason = ignoreReason.trim()
    if (!reason) return
    // Close the form and discard the reason only after the host confirms the decision was saved.
    if (!await queueAction({ action: 'ignore', ticketId: item.ticketId, attentionId: item.attentionId, reason }, t('queueIgnoredNotice'))) return
    setIgnoring(undefined); setIgnoreReason('')
  }
  /** Open the correction editor first; the folded record is dropped only when the correction is sent. */
  const reclassify = (item: QueueView['ignored'][number]) => {
    setSelected(item.ticketId)
    respond({ ticketId: item.ticketId, title: item.title, forgetAttentionId: item.attentionId })
  }
  const stop = async (ticket: Pick<TicketRow, 'id' | 'title'>) => {
    await call('POST tickets/:id/stop', { id: ticket.id, body: {} })
    if (reply?.ticketId === ticket.id) { drafts.forget(reply); setReply(undefined); setInstruction('') }
    setSelected(ticket.id)
    setNotice(t('homeStopped', { title: ticket.title }))
    await change()
  }
  const stopButton = (ticket: Pick<TicketRow, 'id' | 'title' | 'actions'>) => ticket.actions.stop && <ConfirmButton
    label={t('homeStopMatter')} title={t('homeStopTitle')} message={t('homeStopConfirm', { title: ticket.title })}
    icon="stop" onConfirm={() => stop(ticket)} />
  /** Failed or blocked work leaves the owner-facing panel only by an explicit close, which can record why. */
  const closeButton = (ticket: CloseTarget) => ticket.actions.stop
    && ticket.stage === 'person' && (ticket.action === 'failed' || ticket.action === 'blocked') && <CloseTicketButton
      ticket={ticket} onStopped={async () => {
        if (reply?.ticketId === ticket.id) { drafts.forget(reply); setReply(undefined); setInstruction('') }
        setSelected(ticket.id)
        setNotice(t('closeTicketDone', { title: ticket.title }))
        await change()
      }} />
  const workingLine = (working: NonNullable<TicketRow['working']>) => {
    const minutes = Math.max(1, Math.round((Date.now() - Date.parse(working.since)) / 60_000))
    return working.step ? t('workbenchWorkingStep', { step: working.step, minutes }) : t('workbenchWorkingWait', { minutes })
  }
  const card = (ticket: TicketRow) => <article className="pw-task" key={ticket.id}>
    <div className="pw-task-top"><button type="button" className="pw-title-button" onClick={() => setSelected(ticket.id)}>{ticket.title}</button>
      <Tag tone={ticket.attention ? 'warning' : 'quiet'}>{ticketMark(t, ticket).label}</Tag></div>
    {ticket.working && <p className="pw-muted pw-working">{workingLine(ticket.working)}</p>}
    {ticket.attention ? <MarkdownLite text={ticket.attention.question} /> : <p className="pw-clamp">{ticket.summary || ticket.note?.text}</p>}
    {(ticket.followups ?? (ticket.followup ? [ticket.followup] : [])).map(item => <div className="pw-actions" key={item.id}>
      <p className="pw-muted">{t('ticketFollowupAt')} {when(item.at, t('lang'))} · {item.reason}</p>
      <ConfirmButton label={t('homeCancelFollowup')} title={t('homeCancelFollowupTitle')}
        message={t('homeCancelFollowupConfirm', { title: ticket.title, at: fullTime(item.at, t('lang')), reason: item.reason })} onConfirm={async () => {
          await call('DELETE tickets/:id/followup', { id: ticket.id, query: { request_id: item.id } })
          setNotice(t('homeFollowupCancelled')); await change()
        }} />
    </div>)}
    <div className="pw-task-evidence">{[...new Set(ticket.threads.map(thread => thread.source))].slice(0, 3).map(id => {
      const source = sources.data?.find(source => source.id === id)
      return <span key={id}>{source ? localized(t, source.title) : valueLabel(t, 'source', id)}</span>
    })}
      <time dateTime={ticket.updatedAt}>{when(ticket.updatedAt, t('lang'))}</time></div>
    <div className="pw-actions"><Button size="sm" variant="outline" disabled={busy} title={busy ? t('workbenchSubmitting') : undefined}
      onClick={() => respond({ ticketId: ticket.id, title: ticket.title,
      ...(ticket.attention ? { attentionId: ticket.attention.id, question: ticket.attention.question } : {}) })}>
      {t(ticket.attention ? 'workbenchAnswer' : 'ownerDeskRevise')}</Button>
      {ticket.actions.retry && <ConfirmButton label={t('retry')} title={t('retryTitle')}
        message={t('retryConfirm', { title: ticket.title })} icon="refresh" onConfirm={async () => {
          await call('POST tickets/:id/retry', { id: ticket.id })
          setNotice(t('queueRetried')); await change()
        }} />}
      {closeButton(ticket) || stopButton(ticket)}
      <Button size="sm" variant="ghost" onClick={() => props.openManagement(ticket.id)}>{t('ticketAllActions')}</Button>
      {ticket.deliverables?.map(item => {
        const url = new URL(item.url, location.href)
        return url.origin === location.origin && url.pathname === '/api/superagent-workbench/artifact'
          ? <Button size="sm" variant="ghost" key={item.url} onClick={event => openPreview(item, event.currentTarget)}
            icon={<Icon name="review" size={14} />}>{item.title}</Button>
          : <ExternalLink key={item.url} href={item.url}>{item.title}</ExternalLink>
      })}</div>
  </article>
  /** One pending decision: who asks, what it is, the agent's advice and draft, and the four one-click outcomes. */
  const decision = (item: QueueItem) => <article className="pw-decision" key={item.id} aria-label={item.title}>
    <div className="pw-decision-head">
      <div>
        <div className="pw-decision-source">{item.source ? valueLabel(t, 'source', item.source) : t('queueInternalSource')}
          <time dateTime={item.at}>{when(item.at, t('lang'))}</time></div>
        <button type="button" className="pw-title-button" onClick={() => setSelected(item.ticketId)}>{item.title}</button>
      </div>
      {item.priority && item.priority !== 'normal' && <Tag tone={item.priority === 'urgent' ? 'danger' : 'info'}>{t(`priority.${item.priority}`)}</Tag>}
    </div>
    <div className="pw-decision-question"><MarkdownLite text={item.question} /></div>
    {item.advice ? <div className="pw-advice">
      <p className="pw-advice-label">{t('queueRecommendation')}</p>
      <p className="pw-advice-summary">{item.advice.summary}</p>
      {item.advice.reason && <p className="pw-advice-note"><span className="pw-advice-field">{t('queueReason')}</span>{item.advice.reason}</p>}
      {item.advice.risk && <p className="pw-advice-risk"><span className="pw-advice-field">{t('queueRisk')}</span>{item.advice.risk}</p>}
      {item.advice.draft && <><p className="pw-advice-label">{t('queueDraft')}</p><pre className="pw-draft" tabIndex={0}>{item.advice.draft}</pre></>}
    </div> : <p className="pw-muted">{t('queueNoAdvice')}</p>}
    <div className="pw-actions">
      <Button size="sm" variant="primary" disabled={busy || !item.advice} onClick={() => void accept(item)}
        title={item.advice?.draft ? t('queueAcceptDraft') : t('queueAcceptAdvice')}>{t('queueAccept')}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => respond({ ticketId: item.ticketId, title: item.title,
        attentionId: item.attentionId, question: item.question }, item.advice?.draft ?? '')}>{t('queueRevise')}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void defer(item)} title={t('queueDeferHint')}>{t('queueDefer')}</Button>
      {ignoring === item.id ? <span className="pw-ignore-form">
        <input value={ignoreReason} maxLength={500} autoFocus aria-label={t('queueIgnoreReason')}
          placeholder={t('queueIgnorePlaceholder')} onChange={event => setIgnoreReason(event.target.value)} />
        <Button size="sm" variant="outline" disabled={busy || !ignoreReason.trim()} onClick={() => void ignore(item)}>{t('queueIgnoreConfirm')}</Button>
        <Button size="sm" variant="ghost" onClick={() => { setIgnoring(undefined); setIgnoreReason(''); setActionFailure(undefined) }}>{t('cancel')}</Button>
        {actionFailure && <span className="dt-error" role="alert">{actionFailure}</span>}
      </span> : <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setIgnoring(item.id); setIgnoreReason('')
        setActionFailure(undefined) }}>{t('queueIgnore')}</Button>}
      <Button size="sm" variant="ghost" onClick={() => props.openManagement(item.ticketId)}>{t('ticketAllActions')}</Button>
    </div>
  </article>
  const section = (title: string, items: TicketRow[], empty?: string, total = items.length, filter: 'open' | 'ended' = 'open') => <section className="pw-section">
    <div className="pw-section-title"><h2>{title}</h2><span>{total}</span></div>
    {items.length ? <div className="pw-task-grid">{items.map(card)}</div> : empty && <p className="pw-empty">{empty}</p>}
    {total > items.length && <Button size="sm" variant="ghost" onClick={() => props.openWorkList(filter)}>
      {t('homeMoreWork', { shown: items.length, total })}</Button>}
  </section>
  const active = [...(data?.work?.working ?? []), ...(data?.work?.waiting ?? [])]
  /** Tickets waiting for a person without a current Question: recovery, retry or stop, not a decision with advice. */
  const stalled = (data?.person ?? []).filter(ticket => !ticket.attention)
  // An ignore form is only on screen while its row is; otherwise its error must stay at the queue level.
  const ignoringShown = !!queue.data?.items.some(item => item.id === ignoring)
  const domains = focus.data?.domains?.filter(domain => domain.state === 'active') ?? []
  const selectedDomain = domains.find(domain => domain.id === domainId)
  const suggestions = focus.data?.focus?.items.filter(item => !selectedDomain || item.domainId === selectedDomain.id) ?? []
  const lineTicketMark = (ticket: NonNullable<LineRow['active']>) =>
    ticketMark(t, ticket as Parameters<typeof ticketMark>[1])
  /** One line is one long-lived goal; Tickets are its stages, and a completed stage remains as evidence. */
  const lineCard = (line: LineRow) => <article className="pw-line" key={line.id}>
    <div className="pw-line-head">
      <button type="button" className="pw-title-button" onClick={() => { setSelected(undefined); setSelectedLine(line.id) }}>{line.title}</button>
      <Tag tone={line.active ? 'info' : 'quiet'}>{t(line.active ? 'lineActive' : 'lineDormant')}</Tag>
    </div>
    {line.active ? <p className="pw-muted">{line.active.title} · {lineTicketMark(line.active).label}</p>
      : <p className="pw-muted">{t('lineNoOpenTicket')}</p>}
    {line.status === 'closed' && line.openCount > 0 && <p className="pw-muted" role="status">{t('lineClosedOpen')}</p>}
    {line.lastResult && <p className="pw-clamp">{line.lastResult.summary}</p>}
    <div className="pw-task-evidence"><span>{t('lineTicketCount', { count: line.ticketCount })}</span>
      {line.nextFollowup && <span>{t(line.nextFollowup.overdue ? 'lineOverdue' : 'lineNextFollowup')} {when(line.nextFollowup.at, t('lang'))}</span>}
      <time dateTime={line.updatedAt}>{when(line.updatedAt, t('lang'))}</time></div>
  </article>
  /** The whole line: goal, recorded judgements, and every stage in order. */
  const lineView = lineDetail.data && lineDetail.data.id === selectedLine ? lineDetail.data : undefined
  const lineList = <section className="pw-section pw-lines">
    <div className="pw-section-title"><h2>{t('lineTitle')}</h2><span>{lines.data?.open.length ?? '…'}</span></div>
    {lines.error && <div role="alert"><LoadState error={lines.error} loading={false} />
      <Button size="sm" variant="outline" onClick={() => void lines.reload()}>{t('retry')}</Button></div>}
    {!lines.data && !lines.error && <LoadState loading />}
    {lines.data && (lines.data.open.length ? <div className="pw-task-grid pw-line-grid">{lines.data.open.map(lineCard)}</div>
      : <p className="pw-muted">{t('lineEmpty')}</p>)}
    {lines.data && lines.data.closed.length > 0 && <details className="pw-queue-fold">
      <summary>{t('lineClosedTitle', { count: lines.data.closed.length })}</summary>
      <ul className="pw-plain-list">{lines.data.closed.map(line => <li key={line.id}>
        <button type="button" className="dt-open" onClick={() => setSelectedLine(line.id)}>{line.title}</button>
        <span className="pw-muted">{line.closedAt ? when(line.closedAt, t('lang')) : ''}{line.openCount > 0 ? ` · ${t('lineClosedOpen')}` : ''}</span>
      </li>)}</ul></details>}
  </section>
  return <div className="pw-shell" data-chat={chatOpen}>
    <div className="pw-layout"><main className="pw-main">
      <header className="pw-daily-heading"><div><h2>{t('homeTitle')}</h2></div>
        <Button variant="primary" disabled={!ready} icon={<Icon name="message" size={17} />}
          title={ready ? undefined : t('masterNotReady')}
          onClick={() => { if (state) void props.openSession(state.masterId).catch(error => setFailure(errorText(error))) }}>{t('mainConversationEntry')}</Button></header>
      {(stateError || error) && <LoadState error={stateError ?? error} loading={false} />}
      {state && !ready && <p className="pw-muted" role="status">{t('masterNotReady')}</p>}
      {!chatOpen && failure && <p className="dt-error" role="alert">{failure}</p>}
      {notice && <p className="pw-notice" role="status">{notice}</p>}
      {preview && <section className="pw-preview" ref={previewPanel} tabIndex={-1} aria-label={preview.title}>
        <div className="pw-section-title"><h2>{preview.title}</h2>
        <div className="pw-actions"><ExternalLink href={preview.url}>{t('details')}</ExternalLink><Button size="sm" variant="ghost" onClick={closePreview}>{t('close')}</Button></div></div>
        <iframe title={preview.title} src={preview.url} sandbox="" /></section>}
      {selectedLine ? <LineDetail key={selectedLine} line={lineView} error={lineDetail.error} destinations={lines.data?.open}
        destinationsError={lines.error} backLabel={t('homeBack')} onBack={() => setSelectedLine(undefined)}
        onOpenTicket={id => { setSelectedLine(undefined); setSelected(id) }} onChanged={change} /> : selected ? <section className="pw-section"><Button size="sm" variant="ghost" onClick={() => setSelected(undefined)} icon={<Icon name="chevron-left" />}>{t('homeBack')}</Button>
        {detail.data?.id === selected ? <><h2>{detail.data.title}</h2><Tag>{ticketMark(t, detail.data).label}</Tag><MarkdownLite text={detail.data.attention?.question ?? detail.data.summary} />
          <div className="pw-actions">{detail.data.ended?.by !== 'human' && <Button variant="primary" disabled={busy}
            title={busy ? t('workbenchSubmitting') : undefined} onClick={() => respond({ ticketId: detail.data!.id,
            title: detail.data!.title, ...(detail.data!.attention ? { attentionId: detail.data!.attention.id, question: detail.data!.attention.question } : {}) })}>
            {t(detail.data.attention ? 'workbenchAnswer' : 'ownerDeskRevise')}</Button>}
            {closeButton(detail.data) || stopButton(detail.data)}
            <Button variant="ghost" onClick={() => props.openManagement(selected)}>{t('homeFullRecord')}</Button></div>
          {detail.data.deliverables?.map(item => <ExternalLink key={item.url} href={item.url}>{item.title}</ExternalLink>)}
        </> : <LoadState error={detail.error} loading />}</section>
      : <>{lineList}{!queue.data ? <LoadState loading error={queue.error} /> : <>
        <section className="pw-queue" aria-label={t('queueTitle')}>
          <div className="pw-section-title"><h2>{t('queueTitle')}</h2></div><p className="pw-muted">{t('queueHint')}</p>
          {queue.error && queue.data && <div className="pw-stale" role="status">
            <p>{t('queueStaleNotice', { at: queue.updatedAt ? fullTime(new Date(queue.updatedAt).toISOString(), t('lang')) : t('empty') })}</p>
            <Button size="sm" variant="outline" onClick={() => void queue.reload()}>{t('retry')}</Button>
          </div>}
          {actionFailure && !ignoringShown && <p className="dt-error" role="alert">{actionFailure}</p>}
          {queue.data.items.length ? <div className="pw-decision-list">{queue.data.items.map(decision)}</div>
            : !stalled.length && <div className="pw-quiet"><Icon name="decision" size={22} /><p>{t('queueEmpty')}</p><p className="pw-muted">{t('queueEmptyHint')}</p></div>}
        </section>
        {(queue.data.deferred.length > 0 || queue.data.ignored.length > 0) && <section className="pw-queue-fold">
          {queue.data.deferred.length > 0 && <details><summary>{t('queueDeferredTitle', { count: queue.data.deferred.length })}</summary>
            <ul className="pw-plain-list">{queue.data.deferred.map(item => <li key={item.id}>
              <button type="button" className="dt-open" onClick={() => setSelected(item.ticketId)}>{item.title}</button>
              <span className="pw-muted">{t('queueDeferredUntil', { at: fullTime(item.until, t('lang')) })}</span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void queueAction({ action: 'restore', ticketId: item.ticketId,
                attentionId: item.attentionId }, t('queueRestoredNotice'))}>{t('queueRestore')}</Button>
            </li>)}</ul></details>}
          {queue.data.ignored.length > 0 && <details><summary>{t('queueIgnoredTitle', { count: queue.data.ignored.length })}</summary>
            <ul className="pw-plain-list">{queue.data.ignored.map(item => <li key={item.id}>
              <button type="button" className="dt-open" onClick={() => setSelected(item.ticketId)}>{item.title}</button>
              <span className="pw-muted">{item.reason}</span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reclassify(item)}>{t('queueReclassify')}</Button>
            </li>)}</ul></details>}
        </section>}
      </>}
      {/* A failed, blocked or delivery-failed Ticket has no Question, but still needs a person; it stays visible for retry or stop. */}
      {!!stalled.length && <section className="pw-section pw-recovery" aria-label={t('queueRecovery')}>
        <div className="pw-section-title"><h2>{t('queueRecovery')}</h2><span>{stalled.length}</span></div>
        <div className="pw-task-grid">{stalled.map(card)}</div>
      </section>}
      {queue.data && !queue.data.items.length && !stalled.length && <p className="pw-muted">{t('queueSilence')}</p>}
      {data?.triageMatters && <CanonicalMatters view={data.triageMatters} t={t} loadPage={before => call('GET triage-matters', { query: { before } })}
        openWork={(kind, id) => { setSelected(kind === 'ticket' ? id : undefined); setSelectedLine(kind === 'line' ? id : undefined) }} />}
      {data?.productionTriage && <ProductionJudgments view={data.productionTriage} t={t}
        onRetry={state?.triageRecovery?.production ? async (id, generation) => { await call('POST production-triage/:id/retry', { id, body: { generation } }); await reload() } : undefined}
        onRecoverIntake={state?.triageRecovery?.intake ? async () => {
          const owners: { owner: string; generation: number }[] = []
          const unavailable: string[] = []
          let after = 0
          while (owners.length < 10) {
            const page = await call('GET automatic-triage', { query: { after } })
            unavailable.push(...page.owners.filter(owner => owner.state === 'blocked' && !owner.recoverable).map(owner => `${owner.source}: ${owner.owner}`))
            owners.push(...page.owners.filter(owner => owner.state === 'blocked' && owner.recoverable).slice(0, 10 - owners.length)
              .map(({ owner, generation }) => ({ owner, generation })))
            if (page.next === null) break
            after = page.next
          }
          if (owners.length) await call('POST automatic-triage/recover', { body: { owners, action: 'retry' } })
          await reload()
          return t('lang').startsWith('zh')
            ? `已提交恢复 ${owners.length} 组，不代表判断或业务已完成。${unavailable.length ? `当前读取范围内有 ${unavailable.length} 组来源或归属不可用，继续保留：${unavailable.join('；')}` : ''}`
            : `Recovery submitted for ${owners.length} groups; judgments and business work are not complete.${unavailable.length ? ` ${unavailable.length} unavailable owners in the inspected pages remain retained: ${unavailable.join('; ')}` : ''}`
        } : undefined}
        loadPage={(before, unresolved) => call('GET production-triage', { query: { before, unresolved } })}
        discussionDisabled={busy || !ready || !!reply && !!instruction.trim()}
        onDiscuss={(id, generation) => void discuss(`请用 orchestrator_read 读取 triage/receipt/${id}/${generation}，只读核对这组信息及原始来源。说明当前判断、未完成原因和已有工作线关联，结合证据建议下一步；已有事项沿原工作线继续讨论。若回执已变更，先读取 triage/receipts 获取当前引用。此请求用于核对与讨论，执行动作沿已有授权。`)} />}
        <PendingFollowups openTicket={setSelected} />
        <div className="pw-section-title"><h2>{t('homeProgress')}</h2><span>{(data?.work?.workingTotal ?? 0) + (data?.work?.waitingTotal ?? 0)}</span>
          <button type="button" className="dt-textlink" onClick={() => props.openWorkList('open')}>{t('homeAllWork')}</button></div>
        <div className="pw-task-grid">{active.slice(0, 4).map(card)}</div>
        {section(t('homeResults'), data?.work?.delivered.slice(0, 3) ?? [], t('homeNoResults'), data?.work?.deliveredTotal, 'ended')}
        <p className="pw-muted">{t('homeResultsHint')}</p>
        <Button size="sm" variant="outline" onClick={() => props.openWorkList('ended')}>{t('homeFullHistory')}</Button>
        <details className="pw-queue-fold pw-reference"><summary>{t('queueReference')}</summary>
          <section className="pw-domains" aria-label={t('homeDomains')}><div className="pw-section-title"><h2>{t('homeDomains')}</h2>
            <div className="pw-actions"><Button size="sm" variant="ghost" onClick={props.openDomainSettings}>{t('homeManageDomains')}</Button>
              <Button size="sm" variant="ghost" onClick={props.openGithubSettings}>{t('homeGithubSettings')}</Button>
              <Button size="sm" variant="ghost" disabled={focusSending} onClick={() => void refresh()} icon={<Icon name="refresh" size={14} />}>
                {t(focusSending ? 'homeRefreshing' : 'homeRefresh')}</Button></div></div>
            <div className="pw-domain-grid"><button type="button" className="pw-domain" aria-pressed={!selectedDomain} onClick={() => setDomainId('')}>
              <strong>{t('homeAllDomains')}</strong><span>{focus.data?.focus ? t('homeDomainSuggestions', { count: focus.data.focus.items.length }) : t('homeDomainPending')}</span></button>
              {domains.map(domain => { const count = focus.data?.focus?.items.filter(item => item.domainId === domain.id).length ?? 0
                return <button type="button" className="pw-domain" key={domain.id} aria-pressed={selectedDomain?.id === domain.id} onClick={() => setDomainId(domain.id)}>
                  <strong>{domain.name}</strong><span>{!focus.data?.focus ? t('homeDomainPending') : count ? t('homeDomainSuggestions', { count }) : t('homeDomainNoSuggestions')}</span></button> })}</div>
          </section>
          {refreshing && <p className="pw-muted" role="status">{t('homeRefreshPending')}</p>}
          {focus.error && <LoadState error={focus.error} loading={false} />}
          {focus.data?.focus ? <><p className="pw-muted">{t('homeJudgmentAt')} {when(focus.data.focus.generatedAt, t('lang'))}</p>
            {selectedDomain && <p className="pw-muted">{selectedDomain.scope}</p>}
            <div className="pw-focus-list">{suggestions.map((item, index) => <article className="pw-suggestion" key={`${item.ticketId ?? item.threadKey}-${index}`}>
              <span className="pw-rank">{String(index + 1).padStart(2, '0')}</span><div><h3>{item.title}</h3><p>{item.reason}</p>
                <p className="pw-next"><strong>{t('homeNextStep')}</strong>{item.nextAction}</p><div className="pw-actions"><Tag tone={item.stale ? 'warning' : 'quiet'}>{t(item.stale ? 'homeEvidenceChanged' : 'homeSuggestion')}</Tag>
                  {domains.find(domain => domain.id === item.domainId) && <Tag>{domains.find(domain => domain.id === item.domainId)!.name}</Tag>}
                  {item.ticketId && <Button size="sm" variant="ghost" className="pw-evidence" onClick={() => setSelected(item.ticketId)}>
                    <span>{t('homeLinkedMatter')}</span>{item.evidence}</Button>}
                  {item.threadKey && <Button size="sm" variant="ghost" className="pw-evidence" onClick={() => props.openManagement(undefined, item.threadKey)}>
                    <span>{t('homeSourceUpdate')}</span>{item.ticketId ? t('homeEvidence') : item.evidence}</Button>}
                  <Button size="sm" variant="outline" disabled={busy || !ready} title={ready ? undefined : t('masterNotReady')} onClick={() => void discuss(`请先讨论这条建议及其当前依据，不启动执行。${item.ticketId ? `关联工单 ${item.ticketId}` : `关联来源线程 ${item.threadKey}`}。建议内容为以下引用材料。\n${item.title}\n${item.reason}\n${item.nextAction}`)}>{t('homeDiscuss')}</Button>
                </div></div></article>)}</div>
            {selectedDomain && !suggestions.length && <div className="pw-focus-empty"><p>{t('homeDomainEmpty')}</p>
              <Button size="sm" variant="outline" disabled={busy || !ready} title={ready ? undefined : t('masterNotReady')} onClick={() => void discuss(`请先只读讨论关注域“${selectedDomain.name}”的进展和下一步，不启动业务执行。关注范围作为引用材料如下。\n${selectedDomain.scope}`)}>{t('homeDiscussDomain')}</Button></div>}</>
            : <div className="pw-focus-empty"><h3>{t(refreshing ? 'homePreparing' : 'homeFocusEmpty')}</h3><p>{t('homeFocusExplanation')}</p></div>}
        </details>
        {data && data.problems.length > 0 && <details className="pw-runtime-note"><summary>{t('homeRuntimeIssues', { count: data.problems.length })}</summary>
          <ProblemList problems={data.problems} onChanged={reload} /></details>}
      </>}
      <footer className="pw-sources"><span>{t('homeSourceCaption')}</span>{sources.data?.filter(source => source.enabled).map(source => <span key={source.id}
        title={source.health.map(item => item.detail).filter(Boolean).join('\n')}><i data-state={source.state} />{localized(t, source.title)}{source.stats.lastAt && <small>{when(source.stats.lastAt, t('lang'))}</small>}</span>)}</footer>
    </main><aside className="pw-collaboration" aria-label={t('homeDiscussion')}><header><div><Icon name="message" size={17} /><strong>{t('homeDiscussion')}</strong></div>
      <Button variant="ghost" size="sm" disabled={!ready} title={ready ? undefined : t('masterNotReady')} onClick={() => { if (state) void props.openSession(state.masterId).catch(error => setFailure(errorText(error))) }}>{t('homeFullConversation')}</Button>
      <Button variant="ghost" size="sm" className="pw-chat-toggle" onClick={() => setChatOpen(false)}>{t('homeBack')}</Button></header>
      {/* On a narrow page this aside is the visible panel; a failure here must not be rendered only in the hidden main column. */}
      {chatOpen && failure && <p className="dt-error pw-aside-error" role="alert">{failure}</p>}
      <p className="pw-chat-hint">{t('homeSupplementHint')}</p>
      {reply ? <section className="pw-supplement">
        <div className="pw-section-title"><h2>{t('workbenchUpdateTarget', { title: reply.title })}</h2>
          {busy ? <Button variant="ghost" size="sm" disabled>{t('cancel')}</Button>
            : instruction.trim()
              ? <ConfirmButton label={t('homeDiscardDraft')} title={t('homeDiscardDraftTitle')} message={t('homeDiscardDraftConfirm')}
                onConfirm={async () => { drafts.forget(reply); setReply(undefined); setInstruction(''); setChatOpen(false) }} />
              : <Button variant="ghost" size="sm" onClick={() => { drafts.forget(reply); setReply(undefined); setChatOpen(false) }}>{t('cancel')}</Button>}</div>
        {reply.question && <MarkdownLite text={reply.question} />}
        {replacedQuestion && <div className="pw-actions">
          <p className="dt-hint" role="status">{t('homeDraftAttentionChanged')}</p>
          <Button size="sm" variant="outline" disabled={busy} title={busy ? t('workbenchSubmitting') : undefined}
            onClick={() => adoptAttention(replacedQuestion)}>{t('homeDraftUseNewQuestion')}</Button>
        </div>}
        <ReplyForm autoFocus value={instruction} onChange={value => { setInstruction(value); drafts.write(reply, value) }}
          maxLength={16000} busy={busy} disabled={!ready} onSubmit={() => void submitReply()} />
      </section> : <p className="pw-supplement-empty">{t('homeSupplementEmpty')}</p>}
    </aside></div>
  </div>
}
