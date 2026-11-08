/** Shared list rows for Tickets, Threads, and Decisions, plus Source fact chips and automated-message run folding. */
import { useState } from 'react'
import { usePoll, type DecisionRow, type ThreadFacts, type ThreadRow, type TicketRow } from './api.ts'
import { Icon, Tag } from './controls.tsx'
import { decisionMark, threadMark, ticketMark } from './marks.ts'
import { usePanel } from './provider.tsx'
import { actorName, fullTime, localized, readableMarkers, reasonLabel, valueLabel } from './text.ts'
import { ActionLink, ConfirmButton, LabelValue, LoadState, SessionButton, StageMark, When } from './widgets.tsx'

/** Read-only global projection; cancellation uses the Ticket's existing command and receipt. */
export function PendingFollowups({ openTicket }: { openTicket(id: string): void }) {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET followups'), [])
  return <details className="dt-followup-agenda" open><summary>{t('followupAgenda')} · {data?.length ?? '…'}</summary>
    {error && <LoadState loading={false} error={error} />}
    {!data ? !error && <LoadState loading /> : data.length ? <ul className="dt-list">{data.map(item => <li key={`${item.ticketId}:${item.id}`}>
      <div className="dt-owner-task-head"><button className="dt-open" type="button" onClick={() => openTicket(item.ticketId)}>{item.title}</button>
        <Tag tone={item.due || item.blocked ? 'warning' : 'quiet'}>{t(item.due ? 'followupDue' : 'followupScheduled')}</Tag></div>
      <p><time dateTime={item.at}>{fullTime(item.at, t('lang'))}</time> · {item.reason}</p>
      {item.blocked && <p className="dt-error">{t(`followupBlock.${item.blocked}`)}</p>}
      <ConfirmButton variant="ghost" icon="close" label={t('homeCancelFollowup')}
        title={t('homeCancelFollowupTitle')} message={t('homeCancelFollowupConfirm', { title: item.title,
          at: fullTime(item.at, t('lang')), reason: item.reason })} onConfirm={async () => {
          await call('DELETE tickets/:id/followup', { id: item.ticketId, query: { request_id: item.id } }); await reload()
        }} />
    </li>)}</ul> : <p className="dt-hint">{t('followupAgendaEmpty')}</p>}
  </details>
}

export function TicketLine({ ticket, question, onChanged, context }: {
  ticket: TicketRow; question?: boolean; onChanged?: () => Promise<void>; context?: boolean
}) {
  const { t, call, navigate } = usePanel()
  const status = ticketMark(t, ticket)
  const after = async (request: Promise<unknown>) => { await request; await onChanged?.() }
  const note = (question || ticket.stage === 'idle') && ticket.note && { ...ticket.note, text: readableMarkers(t, ticket.note.text) }
  const answer = ticket.reply && ticket.stage === 'person' && ticket.action === 'answer' ? ticket.reply : undefined
  return <li className="dt-row dt-link dt-ticket" data-state={question ? status.dot : undefined}>
    <div className="dt-ticket-stage"><StageMark state={status.dot} icon={status.icon} label={status.label} /></div>
    <div className="dt-ticket-body">
      <div className="dt-row-title"><button type="button" className="dt-open" onClick={() => navigate({ page: 'execution',
        id: ticket.id })}>{ticket.title}</button></div>
      <div className="dt-row-meta dt-ticket-meta">
        {ticket.threads.map(thread => <ThreadChip key={thread.key} thread={thread} />)}
        {context && <ContextTag />}
        {ticket.executor && <Tag tone="quiet">{t(`executorKind.${ticket.executor}`)}</Tag>}
        {ticket.taskPaused && <Tag tone="warning">{t('ticketPaused')}</Tag>}
        {ticket.priority && ticket.priority !== 'normal' && <Tag tone={ticket.priority === 'urgent' ? 'danger' : 'info'}>
          {t(`priority.${ticket.priority}`)}</Tag>}
        {ticket.dueAt && <LabelValue label={t('ticketDueAt')} value={<When at={ticket.dueAt} />} />}
        {ticket.undelivered > 0 && <LabelValue label={t('ticketUndeliveredLabel')} value={ticket.undelivered} />}
        {note ? <span className={note.error ? 'dt-ticket-note dt-ticket-note-error' : 'dt-ticket-note'} title={note.text}>{note.text}</span>
          : <When at={ticket.updatedAt} />}
      </div>
      {(ticket.followups ?? (ticket.followup ? [ticket.followup] : [])).map(item => <div className="dt-row-meta" key={item.id}><LabelValue label={t('ticketFollowupAt')}
        value={<When at={item.at} />} /><span>{item.reason}</span></div>)}
      {!!ticket.deliverables?.length && <div className="dt-ticket-actions">{ticket.deliverables.map(item => <ActionLink
        key={item.url} href={item.url}>{item.title}</ActionLink>)}</div>}
      {/* Always render the actions container so every Ticket row keeps a uniform three-line height. */}
      <div className="dt-ticket-actions">{onChanged && <>
        {answer && (answer.sessionId ? <SessionButton sessionId={answer.sessionId} label={t('workbenchReturnDiscussion')} />
          : <ActionLink href={answer.url} icon="message">{t('answerIn', { source: valueLabel(t, 'source', answer.source) })}</ActionLink>)}
        {ticket.actions.retry && <ConfirmButton variant="outline" icon="refresh" label={t('retry')} title={t('retryTitle')}
          message={t('retryConfirm', { title: ticket.title })}
          onConfirm={() => after(call('POST tickets/:id/retry', { id: ticket.id }))} />}
        {ticket.actions.retry && ticket.sessionId && <SessionButton variant="outline" sessionId={ticket.sessionId} />}
        {ticket.actions.stop && <ConfirmButton variant="outline" icon="stop" label={t('stop')} title={t('stopConfirmTitle')}
          message={t('stopConfirm', { title: ticket.title })}
          onConfirm={() => after(call('POST tickets/:id/stop', { id: ticket.id }))} />}
      </>}</div>
    </div>
  </li>
}

function ContextTag() {
  const { t } = usePanel()
  return <Tag tone="quiet" title={t('contextOnlyHint')}>{t('contextOnly')}</Tag>
}
/** Thread list row; on a Ticket page, `ticketId` omits that Ticket from fanout targets and `context` marks context-only threads. */
export function ThreadLine({ thread, ticketId, context }: { thread: ThreadRow; ticketId?: string; context?: boolean }) {
  const { t, navigate } = usePanel()
  const live = thread.tickets.filter(ticket => ticket.state === 'open' && ticket.id !== ticketId)
  const { dot, icon, label } = threadMark(t, thread)
  const reaches = live.length > 0 && `${live[0]!.title}${live.length > 1 ? t('andMore', { count: live.length - 1 }) : ''}`
  return <li className="dt-row dt-link dt-ticket">
    <div className="dt-ticket-stage"><StageMark state={dot} icon={icon} label={label} /></div>
    <div className="dt-ticket-body">
      <div className="dt-row-title">
        <button type="button" className="dt-open" title={thread.pollError} onClick={() => navigate({ page: 'trigger',
          id: thread.key })}>{readableMarkers(t, thread.title)}</button>
      </div>
      <div className="dt-row-quote dt-line">
        {thread.latest && <>{actorName(t, thread.latest.actor)}{t('labelSeparator')}{readableMarkers(t, thread.latest.preview)
          || t('empty')}</>}
      </div>
      <div className="dt-row-meta dt-line">
        <ThreadChip thread={thread} />
        {context && <ContextTag />}
        {thread.pollError ? <span className="dt-line-text dt-error-text">{thread.pollError}</span> : reaches && <LabelValue
          label={t('fanoutTo')} value={reaches} />}
        <When at={thread.lastAt} />
      </div>
    </div>
  </li>
}

export function DecisionLine({ decision }: { decision: DecisionRow }) {
  const { t, navigate } = usePanel()
  const matched = decision.rules.filter(rule => rule.matched).map(rule => rule.name)
  const mark = decisionMark(t, decision.outcome)
  const preview = readableMarkers(t, decision.preview)
  const reason = decision.reason ? reasonLabel(t, decision.reason) : ''
  const open = () => decision.ticketId ? navigate({ page: 'execution', id: decision.ticketId })
    : navigate({ page: 'trigger', id: decision.thread, query: { trigger: decision.triggerIds[0] ?? '' } })
  return <li className="dt-row dt-link dt-ticket">
    <div className="dt-ticket-stage"><StageMark state={mark.dot} icon={mark.icon} label={mark.label} /></div>
    <div className="dt-ticket-body">
      <div className="dt-row-title">
        <button type="button" className="dt-open" title={reason || undefined} onClick={open}>
          {decision.ticketTitle ?? (decision.threadTitle ? readableMarkers(t, decision.threadTitle) : preview || t('empty'))}
        </button>
      </div>
      <div className="dt-row-quote dt-line">{preview}</div>
      <div className="dt-row-meta dt-line">
        {reason && <span className="dt-line-text">{reason}</span>}
        {matched.length > 0 && <LabelValue label={t('ruleLabel')} value={matched.join(t('listSeparator'))} />}
        <When at={decision.at} />
      </div>
    </div>
  </li>
}

function ThreadChip({ thread }: { thread: Pick<ThreadFacts, 'source' | 'facts' | 'url' | 'title'> }) {
  const { t } = usePanel()
  const cells = <>
    <span className="dt-chip-source">{valueLabel(t, 'source', thread.source)}</span>
    {Object.entries(thread.facts).map(([id, fact]) => <span key={id} className={fact.problem ? 'dt-chip-fact dt-chip-problem'
      : 'dt-chip-fact'}>
      {fact.label && <span className="dt-chip-label">{localized(t, fact.label)}</span>}{localized(t, fact.value)}
    </span>)}
  </>
  return thread.url ? <a className="dt-chip dt-chip-link" href={thread.url} target="_blank" rel="noopener noreferrer" title={thread.title}>
    {cells}<span className="dt-chip-open"><Icon name="external" size={11} /></span>
  </a> : <span className="dt-chip">{cells}</span>
}

type Run<I> = { item: I; earlier: I[] }
/** Group consecutive automated items from the same sender so only the newest is shown by default. */
export function automatedRuns<I>(items: I[], sender: (item: I) => string | undefined): Run<I>[] {
  const runs: Run<I>[] = []
  for (const item of items) {
    const last = runs.at(-1), from = sender(item)
    if (last && from !== undefined && sender(last.item) === from) last.earlier.push(item)
    else runs.push({ item, earlier: [] })
  }
  return runs
}
export function Earlier({ items }: { items: { id: string; at: string; preview: string }[] }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  if (!items.length) return null
  return <div>
    <button type="button" className="dt-textlink" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? t('collapse') : t('automatedEarlier', { count: items.length })}
    </button>
    {open && <ul className="dt-plain-list dt-hint">{items.map(item => <li key={item.id}><When
      at={item.at} /> · {readableMarkers(t, item.preview) || t('empty')}</li>)}</ul>}
  </div>
}
