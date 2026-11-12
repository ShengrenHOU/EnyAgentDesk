/** One work line's existing detail: goal, recorded judgements, stages and membership correction, reachable from the
 * Today list and from the global search's Line results. */
import { useState } from 'react'
import { usePoll, type LinePageView, type LineRow } from './api.ts'
import { Button, Icon, Tag } from './controls.tsx'
import { ticketMark } from './marks.ts'
import { usePanel } from './provider.tsx'
import { errorText, when } from './text.ts'
import { LoadState } from './widgets.tsx'
import { WorkEvidence } from './work-evidence.tsx'

interface LineDetailProps {
  /** The materialized detail; absent while it loads, and its `error` is shown instead when the read fails. */
  line?: LinePageView | undefined
  error?: Error | undefined
  /** Open lines the caller already polls, offered as membership destinations. */
  destinations?: LineRow[] | undefined
  destinationsError?: Error | undefined
  onBack: () => void
  backLabel?: string | undefined
  onOpenTicket: (ticketId: string) => void
  /** Reloads the caller's line reads after a membership correction. */
  onChanged?: (() => void | Promise<void>) | undefined
}
export function LineDetail({ line, error, destinations, destinationsError, onBack, backLabel, onOpenTicket, onChanged }: LineDetailProps) {
  const { t, call } = usePanel()
  const [membership, setMembership] = useState<{ ticketId: string; targetLineId: string; evidence: string }>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [notice, setNotice] = useState('')
  const back = <Button size="sm" variant="ghost" onClick={onBack} icon={<Icon name="chevron-left" />}>{backLabel || t('homeBack')}</Button>
  if (!line) return <section className="pw-section">{back}<LoadState error={error} loading={!error} /></section>
  const lineTicketMark = (ticket: NonNullable<LineRow['active']> | LinePageView['tickets'][number]) =>
    ticketMark(t, ticket as Parameters<typeof ticketMark>[1])
  const saveMembership = async () => {
    if (!membership || busy || !membership.evidence.trim() || membership.targetLineId === line.id) return
    setBusy(true); setFailure(undefined); setNotice('')
    try {
      await call('POST lines/:id/membership', { id: line.id, body: { ticketId: membership.ticketId,
        targetLineId: membership.targetLineId || null, evidence: membership.evidence.trim() } })
      await onChanged?.()
      setMembership(undefined); setNotice(t('lineMembershipSaved'))
    } catch (error) { setFailure(errorText(error)) }
    finally { setBusy(false) }
  }
  const membershipTrail = (item: LinePageView['judgements'][number]) => item.fromLine && <p className="pw-muted">
    {item.fromLine.title} → {item.toLine?.title ?? t('lineDetached')}{item.by ? ` · ${t(`lineActor.${item.by}`)}` : ''}</p>
  return <section className="pw-section pw-line-detail">
    {back}
    <div className="pw-line-head"><h2>{line.title}</h2><Tag tone={line.status === 'open' ? 'info' : 'quiet'}>
      {t(line.status === 'open' ? 'lineOpen' : 'lineClosed')}</Tag></div>
    <p className="pw-muted">{t('lineDetailHint', { count: line.ticketCount })}</p>
    {line.status === 'closed' && line.openCount > 0 && <p className="pw-muted" role="status">{t('lineClosedOpen')}</p>}
    {line.latestJudgement && <div className="pw-line-evidence">
      <p className="pw-advice-label">{t('lineLatestJudgement')}</p>
      <p className="pw-muted">{t(`lineAction.${line.latestJudgement.action}`)} · {when(line.latestJudgement.at, t('lang'))}</p>
      <p>{line.latestJudgement.evidence}</p>
      {membershipTrail(line.latestJudgement)}
    </div>}
    <WorkEvidence key={line.id} t={t} load={before => call('GET lines/:id/evidence', { id: line.id, query: { before } })} />
    <div className="pw-section-title"><h3>{t('lineTickets')}</h3><span>{line.tickets.length}</span></div>
    {line.tickets.length ? <ul className="pw-plain-list pw-line-tickets">{line.tickets.map(ticket => <li key={ticket.id}>
      <button type="button" className="dt-open" onClick={() => onOpenTicket(ticket.id)}>{ticket.title}</button>
      <Tag tone="quiet">{lineTicketMark(ticket).label}</Tag>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMembership({ ticketId: ticket.id,
        targetLineId: line.id, evidence: '' })}>{t('lineCorrectMembership')}</Button>
      {ticket.report && <p className="pw-clamp">{ticket.report.summary}</p>}
      {membership?.ticketId === ticket.id && <form className="pw-membership"
        onSubmit={event => { event.preventDefault(); void saveMembership() }}>
        <label>{t('lineDestination')}<select aria-label={t('lineDestination')} disabled={busy} value={membership.targetLineId}
          onChange={event => setMembership({ ...membership, targetLineId: event.target.value })}>
          <option value={line.id}>{t('lineKeepMembership')}</option>
          <option value="">{t('lineDetached')}</option>
          {(destinations ?? []).filter(item => item.id !== line.id).map(item =>
            <option key={item.id} value={item.id}>{item.title}</option>)}
        </select></label>
        <LoadState error={destinationsError} loading={!destinations} />
        <label>{t('lineMembershipReason')}<textarea aria-label={t('lineMembershipReason')} required maxLength={1000}
          disabled={busy} value={membership.evidence} onChange={event => setMembership({ ...membership, evidence: event.target.value })} /></label>
        <div className="pw-actions"><Button size="sm" type="submit" disabled={busy || !membership.evidence.trim()
          || membership.targetLineId === line.id}>{t('save')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMembership(undefined)}>{t('cancel')}</Button></div>
      </form>}
    </li>)}</ul> : <p className="pw-muted">{t('lineNoTickets')}</p>}
    <details className="pw-queue-fold"><summary>{t('lineJudgements')}</summary>
      <ul className="pw-plain-list">{line.judgements.map((item, index) => <li key={`${item.at}-${index}`}>
        <strong>{t(`lineAction.${item.action}`)}</strong> <span className="pw-muted">{when(item.at, t('lang'))}</span>
        <p>{item.evidence}</p>
        {membershipTrail(item)}
        {item.ticketId && <span className="pw-muted">{item.ticketId}</span>}
      </li>)}</ul></details>
    {notice && <p className="pw-notice" role="status">{notice}</p>}
    {failure && <p className="dt-error" role="alert">{failure}</p>}
  </section>
}
/** The line detail as its own page, reached from the global search; reads the existing line view, not a search copy. */
export function LinePage({ id }: { id: string }) {
  const { call, back, backLabel, navigate } = usePanel()
  const detail = usePoll(() => call('GET lines/:id', { id }), [id])
  const lines = usePoll(() => call('GET lines'), [])
  const line = detail.data && detail.data.id === id ? detail.data : undefined
  const reload = async () => { await Promise.all([detail.reload(), lines.reload()]) }
  return <LineDetail key={id} line={line} error={detail.error} destinations={lines.data?.open} destinationsError={lines.error}
    backLabel={backLabel} onBack={back} onOpenTicket={ticketId => navigate({ page: 'execution', id: ticketId })} onChanged={reload} />
}
