/** Today: the owner's decision queue, with the work that still runs below it; detailed discussion stays in the main Session. */
import { useState } from 'react'
import type { readFocus } from '../sources/workbench-focus.ts'
import { answerAttention, usePoll, type TicketRow } from './api.ts'
import { Button, Icon, Tag } from './controls.tsx'
import { ticketMark } from './marks.ts'
import { ProblemList } from './overview.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { ReplyForm } from './reply-form.tsx'
import { PendingFollowups } from './rows.tsx'
import { errorText, fullTime, localized, valueLabel, when, type T } from './text.ts'
import { ConfirmButton, ExternalLink, LoadState, MarkdownLite } from './widgets.tsx'

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
  const [reply, setReply] = useState<ReplyTarget>()
  const [instruction, setInstruction] = useState('')
  const [ignoring, setIgnoring] = useState<string>()
  const [ignoreReason, setIgnoreReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [focusSending, setFocusSending] = useState(false)
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState<string>()
  const [preview, setPreview] = useState<{ title: string; url: string }>()
  const detail = usePoll(() => selected ? call('GET tickets/:id', { id: selected }) : Promise.resolve(null), [selected])
  const refreshing = !!focus.data?.requested && (!focus.data.focus || focus.data.requested.at > focus.data.focus.generatedAt)
  const change = async () => { await Promise.all([reload(), queue.reload(), detail.reload()]) }
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
  const respond = (target: ReplyTarget, prefilled = '') => {
    setReply(target); setInstruction(prefilled); setNotice(''); setPreview(undefined); setChatOpen(true)
  }
  const submitReply = async () => {
    if (!reply || !instruction.trim() || busy) return
    const target = reply
    if (!target.attentionId) {
      // Keep the folded record until the correction actually leaves: cancelling or a failed send must not erase it.
      if (await send(`请继续已有工单 ${target.ticketId}。本人补充或修改要求如下。\n\n${instruction.trim()}`) && target.forgetAttentionId) {
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
  const queueAction = async (body: Record<string, unknown>, success: string) => {
    if (busy) return
    setBusy(true); setFailure(undefined)
    try { await read('queue/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      setNotice(success); await change()
    } catch (error) { setFailure(errorText(error)) }
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
    await queueAction({ action: 'ignore', ticketId: item.ticketId, attentionId: item.attentionId, reason }, t('queueIgnoredNotice'))
    setIgnoring(undefined); setIgnoreReason('')
  }
  /** Open the correction editor first; the folded record is dropped only when the correction is sent. */
  const reclassify = (item: QueueView['ignored'][number]) => {
    setSelected(item.ticketId)
    respond({ ticketId: item.ticketId, title: item.title, forgetAttentionId: item.attentionId })
  }
  const stop = async (ticket: Pick<TicketRow, 'id' | 'title'>) => {
    await call('POST tickets/:id/stop', { id: ticket.id })
    if (reply?.ticketId === ticket.id) { setReply(undefined); setInstruction('') }
    setSelected(ticket.id)
    setNotice(t('homeStopped', { title: ticket.title }))
    await change()
  }
  const stopButton = (ticket: Pick<TicketRow, 'id' | 'title' | 'actions'>) => ticket.actions.stop && <ConfirmButton
    label={t('homeStopMatter')} title={t('homeStopTitle')} message={t('homeStopConfirm', { title: ticket.title })}
    icon="stop" onConfirm={() => stop(ticket)} />
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
    <div className="pw-actions"><Button size="sm" variant="outline" onClick={() => respond({ ticketId: ticket.id, title: ticket.title,
      ...(ticket.attention ? { attentionId: ticket.attention.id, question: ticket.attention.question } : {}) })}>
      {t(ticket.attention ? 'workbenchAnswer' : 'ownerDeskRevise')}</Button>
      {ticket.actions.retry && <ConfirmButton label={t('retry')} title={t('retryTitle')}
        message={t('retryConfirm', { title: ticket.title })} icon="refresh" onConfirm={async () => {
          await call('POST tickets/:id/retry', { id: ticket.id })
          setNotice(t('queueRetried')); await change()
        }} />}
      {stopButton(ticket)}
      <Button size="sm" variant="ghost" onClick={() => props.openManagement(ticket.id)}>{t('ticketAllActions')}</Button>
      {ticket.deliverables?.map(item => {
        const url = new URL(item.url, location.href)
        return url.origin === location.origin && url.pathname === '/api/superagent-workbench/artifact'
          ? <Button size="sm" variant="ghost" key={item.url} onClick={() => setPreview(item)} icon={<Icon name="review" size={14} />}>{item.title}</Button>
          : <ExternalLink key={item.url} href={item.url}>{item.title}</ExternalLink>
      })}</div>
  </article>
  /** One pending decision: who asks, what it is, the agent's advice and draft, and the four one-click outcomes. */
  const decision = (item: QueueItem) => <article className="pw-decision" key={item.id}>
    <div className="pw-decision-head">
      <div>
        <div className="pw-decision-source">{item.source ? valueLabel(t, 'source', item.source) : t('queueInternalSource')}
          <time dateTime={item.at}>{when(item.at, t('lang'))}</time></div>
        <button type="button" className="pw-title-button" onClick={() => setSelected(item.ticketId)}>{item.title}</button>
      </div>
      {item.priority && item.priority !== 'normal' && <Tag tone={item.priority === 'urgent' ? 'danger' : 'info'}>{t(`priority.${item.priority}`)}</Tag>}
    </div>
    <MarkdownLite text={item.question} />
    {item.advice ? <div className="pw-advice">
      <p className="pw-advice-label">{t('queueRecommendation')}</p>
      <p className="pw-advice-summary">{item.advice.summary}</p>
      {item.advice.reason && <p className="pw-muted">{t('queueReason')}{item.advice.reason}</p>}
      {item.advice.risk && <p className="pw-muted">{t('queueRisk')}{item.advice.risk}</p>}
      {item.advice.draft && <><p className="pw-advice-label">{t('queueDraft')}</p><pre className="pw-draft">{item.advice.draft}</pre></>}
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
        <Button size="sm" variant="ghost" onClick={() => { setIgnoring(undefined); setIgnoreReason('') }}>{t('cancel')}</Button>
      </span> : <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setIgnoring(item.id); setIgnoreReason('') }}>{t('queueIgnore')}</Button>}
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
  const domains = focus.data?.domains?.filter(domain => domain.state === 'active') ?? []
  const selectedDomain = domains.find(domain => domain.id === domainId)
  const suggestions = focus.data?.focus?.items.filter(item => !selectedDomain || item.domainId === selectedDomain.id) ?? []
  return <div className="pw-shell" data-chat={chatOpen}>
    <div className="pw-layout"><main className="pw-main">
      <header className="pw-daily-heading"><div><h2>{t('queueTitle')}</h2><p>{t('queueHint')}</p></div>
        <Button variant="primary" disabled={!ready} icon={<Icon name="message" size={17} />}
          title={ready ? undefined : t('masterNotReady')}
          onClick={() => { if (state) void props.openSession(state.masterId).catch(error => setFailure(errorText(error))) }}>{t('mainConversationEntry')}</Button></header>
      {(stateError || error) && <LoadState error={stateError ?? error} loading={false} />}
      {state && !ready && <p className="pw-muted" role="status">{t('masterNotReady')}</p>}
      {failure && <p className="dt-error" role="alert">{failure}</p>}
      {notice && <p className="pw-notice" role="status">{notice}</p>}
      {preview && <section className="pw-preview"><div className="pw-section-title"><h2>{preview.title}</h2>
        <div className="pw-actions"><ExternalLink href={preview.url}>{t('details')}</ExternalLink><Button size="sm" variant="ghost" onClick={() => setPreview(undefined)}>{t('close')}</Button></div></div>
        <iframe title={preview.title} src={preview.url} sandbox="" /></section>}
      {selected ? <section className="pw-section"><Button size="sm" variant="ghost" onClick={() => setSelected(undefined)} icon={<Icon name="chevron-left" />}>{t('homeBack')}</Button>
        {detail.data?.id === selected ? <><h2>{detail.data.title}</h2><Tag>{ticketMark(t, detail.data).label}</Tag><MarkdownLite text={detail.data.attention?.question ?? detail.data.summary} />
          <div className="pw-actions">{detail.data.ended?.by !== 'human' && <Button variant="primary" onClick={() => respond({ ticketId: detail.data!.id,
            title: detail.data!.title, ...(detail.data!.attention ? { attentionId: detail.data!.attention.id, question: detail.data!.attention.question } : {}) })}>
            {t(detail.data.attention ? 'workbenchAnswer' : 'ownerDeskRevise')}</Button>}
            {stopButton(detail.data)}
            <Button variant="ghost" onClick={() => props.openManagement(selected)}>{t('homeFullRecord')}</Button></div>
          {detail.data.deliverables?.map(item => <ExternalLink key={item.url} href={item.url}>{item.title}</ExternalLink>)}
        </> : <LoadState error={detail.error} loading />}</section>
      : <>{!queue.data ? <LoadState loading error={queue.error} /> : <>
        <section className="pw-queue" aria-label={t('queueTitle')}>
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
      <p className="pw-chat-hint">{t('homeSupplementHint')}</p>
      {reply ? <section className="pw-supplement">
        <div className="pw-section-title"><h2>{t('workbenchUpdateTarget', { title: reply.title })}</h2>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setReply(undefined); setChatOpen(false) }}>{t('cancel')}</Button></div>
        {reply.question && <MarkdownLite text={reply.question} />}
        <ReplyForm autoFocus value={instruction} onChange={setInstruction} maxLength={16000} busy={busy} disabled={!ready}
          onSubmit={() => void submitReply()} />
      </section> : <p className="pw-supplement-empty">{t('homeSupplementEmpty')}</p>}
    </aside></div>
  </div>
}
