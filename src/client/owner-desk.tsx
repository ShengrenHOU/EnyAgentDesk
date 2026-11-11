/** Owner work beside the native conversation, projected from the existing overview. */
import { useState } from 'react'
import { answerAttention, usePoll, type TicketRow } from './api.ts'
import { Button, Icon, Tag } from './controls.tsx'
import { ticketMark } from './marks.ts'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { useStoredFlag } from './prefs.ts'
import { QuickReply } from './quick-reply.tsx'
import { ReplyForm } from './reply-form.tsx'
import { PendingFollowups } from './rows.tsx'
import { errorText, fullTime, when, type T } from './text.ts'
import { ExternalLink, MarkdownLite } from './widgets.tsx'

interface Props {
  sessionId: string; t: T; send(text: string): Promise<void>; openTicket(id: string): void
}
type Group = 'person' | 'deferred' | 'working' | 'waiting' | 'delivered'
/** A Ticket row in the desk; a deferred Question carries the time it returns to the immediate queue. */
type DeskItem = TicketRow & { until?: string }

function Desk({ sessionId, send, openTicket }: Omit<Props, 't'>) {
  const { t, call } = usePanel()
  const { state, error: stateError } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET overview'), [])
  const [group, setGroup] = useState<Group>()
  const [target, setTarget] = useState<TicketRow>()
  const [instruction, setInstruction] = useState('')
  const [quick, setQuick] = useState<Record<string, { text: string; questionId: string }>>({})
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [receipt, setReceipt] = useState<string>()
  const [preview, setPreview] = useState<{ title: string; url: string }>()
  // The desk sits above the composer; keeping it collapsed stops a long agenda from covering the conversation.
  const [open, setOpen] = useStoredFlag('dsh-superagent/owner-desk-open', false)
  if (!state || sessionId !== state.masterId) return null
  const deferred = data?.personDeferred ?? []
  const groups: Record<Group, { label: string; items: DeskItem[]; total: number }> = {
    person: { label: t('ownerDeskNeedsYou'), items: data?.person ?? [], total: data?.person.length ?? 0 },
    deferred: { label: t('ownerDeskDeferred'), items: deferred, total: deferred.length },
    working: { label: t('workInProgress'), items: data?.work?.working ?? [], total: data?.work?.workingTotal ?? 0 },
    waiting: { label: t('workWaiting'), items: data?.work?.waiting ?? [], total: data?.work?.waitingTotal ?? 0 },
    delivered: { label: t('workDelivered'), items: data?.work?.delivered ?? [], total: data?.work?.deliveredTotal ?? 0 },
  }
  // A deferred tab appears only while this Ticket has one, so the tabs do not imply a standing bucket.
  const tabs = (Object.keys(groups) as Group[]).filter(key => key !== 'deferred' || groups.deferred.total > 0)
  const current = group && groups[group]
  const choose = (ticket: TicketRow) => {
    // A pending reply owns this editor until it settles; reading other cards can still continue.
    if (busy) return
    setTarget(ticket); setInstruction(''); setFailure(undefined); setReceipt(undefined); setOpen(true)
  }
  const submit = async () => {
    if (!target || !instruction.trim() || busy) return
    setBusy(true); setFailure(undefined)
    try {
      if (target.attention) await answerAttention(t, target.id, target.attention.id, instruction.trim())
      else await send(`对已有事项「${target.title}」（工单 ${target.id}）补充要求或修改成果。请继续这件事。\n\n${instruction.trim()}`)
      setReceipt(t(target.attention ? 'ticketAnswerSent' : 'ownerDeskSent')); setInstruction(''); setTarget(undefined)
      await reload()
    } catch (error) { setFailure(errorText(error)) }
    finally { setBusy(false) }
  }
  /**
   * Non-empty text stays with the Question it was written for, so a replaced Question never receives it. A cleared line
   * starts over, so the next answer binds to the Question now shown.
   */
  const draftAnswer = (ticketId: string, questionId: string, text: string) => setQuick(drafts => {
    const remaining = { ...drafts }
    if (text) remaining[ticketId] = { text, questionId: drafts[ticketId]?.questionId ?? questionId }
    else delete remaining[ticketId]
    return remaining
  })
  /** One-line answer on the card itself; it answers the Question the draft was written for, like the full editor. */
  const answerQuick = async (ticket: TicketRow) => {
    const drafted = quick[ticket.id]
    const answer = drafted?.text.trim() ?? ''
    if (!ticket.attention || !drafted || !answer || busy) return
    setBusy(true); setFailure(undefined)
    try {
      await answerAttention(t, ticket.id, drafted.questionId, answer)
      // Release the binding with the answer, so a later Question on the same Ticket starts from its own identity.
      setQuick(drafts => {
        const remaining = { ...drafts }
        delete remaining[ticket.id]
        return remaining
      })
      setReceipt(t('ticketAnswerSent')); await reload()
    } catch (error) { setFailure(errorText(error)) }
    finally { setBusy(false) }
  }
  return <aside className="dt-owner-desk" aria-label={t('ownerDeskTitle')}>
    <div className="dt-owner-bar">
      <button type="button" className="dt-owner-toggle" aria-expanded={open}
        title={t(open ? 'collapse' : 'ownerDeskShow')} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={15} />
        <span className="dt-owner-name"><Icon name="inbox" size={15} />{t('ownerDeskTitle')}</span>
      </button>
      <div className="dt-owner-tabs">{tabs.map(key => <Button key={key} size="sm"
        data-needs-attention={key === 'person' && groups[key].total > 0 || undefined}
        variant={group === key ? 'outline' : 'ghost'} aria-expanded={group === key}
        onClick={() => { setGroup(group === key ? undefined : key); setPreview(undefined); setOpen(true) }}>
        {groups[key].label}<span className={key === 'person' && groups[key].total ? 'dt-owner-count dt-owner-attention' : 'dt-owner-count'}>
          {data ? groups[key].total : '…'}</span>
      </Button>)}</div>
    </div>
    {(error || stateError) && <p role="alert" className="dt-error">{errorText(error ?? stateError)}</p>}
    {open && <div className="dt-owner-body">
      <PendingFollowups openTicket={openTicket} />
      {current && <div className="dt-owner-content">
        <div className="dt-owner-section-head"><strong>{current.label}</strong><Button variant="ghost" size="sm"
          aria-label={t('close')} onClick={() => setGroup(undefined)}><Icon name="close" size={14} /></Button></div>
        {current.items.length ? <ul className="dt-list">{current.items.map(ticket => {
          const question = ticket.attention
          return <li key={ticket.id} className="dt-owner-task">
            <div className="dt-owner-task-head"><button type="button" className="dt-open" onClick={() => openTicket(ticket.id)}>{ticket.title}</button>
              <Tag tone={ticket.attention && group !== 'deferred' ? 'warning' : 'quiet'}>{ticketMark(t, ticket).label}</Tag></div>
            <p className={ticket.attention && group !== 'deferred' ? 'dt-owner-question' : 'dt-owner-summary'}>{ticket.attention?.question ?? ticket.summary}</p>
            {group === 'deferred' && ticket.until && <p className="dt-hint">{t('queueDeferredUntil',
              { at: fullTime(ticket.until, t('lang')) })}</p>}
            {question && <QuickReply value={quick[ticket.id]?.text ?? ''}
              onChange={text => draftAnswer(ticket.id, question.id, text)} busy={busy}
              placeholder={t('quickReplyTicket')} onSubmit={() => void answerQuick(ticket)} />}
            {(ticket.followups ?? (ticket.followup ? [ticket.followup] : [])).map(item => <p key={item.id} className="dt-hint">
              {t('ticketFollowupAt')} {when(item.at, t('lang'))} · {item.reason}</p>)}
            <div className="dt-owner-actions">
              <Button size="sm" variant="outline" disabled={busy} title={busy ? t('workbenchSubmitting') : undefined}
                onClick={() => choose(ticket)}>{t(ticket.attention ? 'workbenchAnswer' : 'ownerDeskRevise')}</Button>
              <Button size="sm" variant="ghost" onClick={() => openTicket(ticket.id)}>{t('ticketAllActions')}</Button>
              {ticket.deliverables?.map(item => {
                const url = new URL(item.url, location.href)
                return <span key={item.url}>{url.origin === location.origin && url.pathname === '/api/superagent-workbench/artifact'
                  ? <Button size="sm" variant="ghost" onClick={() => setPreview(item)}>{item.title}</Button>
                  : <ExternalLink href={item.url}>{item.title}</ExternalLink>}</span>
              })}
            </div>
          </li>
        })}</ul> : <p className="dt-hint">{t('ownerDeskEmpty')}</p>}
        {current.total > current.items.length && <p className="dt-hint">{t('ownerDeskMore')}</p>}
      </div>}
      {preview && <section className="dt-owner-preview"><div className="dt-owner-section-head"><strong>{preview.title}</strong>
        <ExternalLink href={preview.url}>{t('details')}</ExternalLink><Button size="sm" variant="ghost" onClick={() => setPreview(undefined)}>{t('close')}</Button></div>
        <iframe src={preview.url} title={preview.title} sandbox="" />
      </section>}
      {target && <section className="dt-owner-response">
        <div className="dt-owner-section-head"><strong>{t('workbenchUpdateTarget', { title: target.title })}</strong>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setTarget(undefined)}>{t('cancel')}</Button></div>
        {target.attention && <MarkdownLite text={target.attention.question} />}
        <ReplyForm autoFocus value={instruction} onChange={setInstruction} maxLength={16000} busy={busy} onSubmit={() => void submit()} />
      </section>}
      {failure && <p role="alert" className="dt-error">{failure}</p>}
      {receipt && <p role="status" className="dt-hint">{receipt}</p>}
      {!group && !target && !receipt && <p className="dt-owner-hint">{t('ownerDeskHint')}</p>}
    </div>}
  </aside>
}

export function OwnerDesk(props: Props) {
  return <PanelProvider t={props.t} openSession={async () => {}} navigate={route => {
    if (route.page === 'execution' && route.id) props.openTicket(route.id)
  }} back={() => {}} backLabel={props.t('ownerDeskTitle')}>
    <Desk {...props} />
  </PanelProvider>
}
