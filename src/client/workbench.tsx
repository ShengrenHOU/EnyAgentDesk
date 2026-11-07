/** Native discussion action; the Host captures source history and owns delegation receipts. */
import { useEffect, useRef, useState } from 'react'
import type { WorkbenchRequest, WorkbenchUpdate, discussionTasks } from '../sources/workbench.ts'
import { when, type T } from './text.ts'
import { Button, Icon, Modal, Tag, type TagTone } from './controls.tsx'
import { ExternalLink } from './widgets.tsx'
import STYLES from './client.css?raw'

interface Discussion {
  sessionId: string; throughSeq: number | null; messageCount: number; partial: boolean; references: string[]
  requests: ReturnType<typeof discussionTasks>
  notices?: { id: string; ticketId?: string; text: string; kind: string }[]
}
type Request = Discussion['requests'][number]
type Task = Request['tickets'][number]
async function answer<T>(response: Response): Promise<T> {
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body as T
}

interface Summary { sessionId: string; active: number; attention: number }
/** One cheap request per Session, shared by every row for 30 seconds; a failed badge load stays silent. */
const summaries = new Map<string, { at: number; value: Promise<Summary> }>()
const SUMMARY_TTL = 30_000
function loadSummary(sessionId: string): Promise<Summary> {
  const cached = summaries.get(sessionId)
  if (cached && Date.now() - cached.at < SUMMARY_TTL) return cached.value
  const value = fetch(`/api/superagent-workbench/summary?sessionId=${encodeURIComponent(sessionId)}`)
    .then(response => answer<Summary>(response))
  summaries.set(sessionId, { at: Date.now(), value })
  value.catch(() => { if (summaries.get(sessionId)?.value === value) summaries.delete(sessionId) })
  return value
}
/** Keep the row badge aligned with the modal's latest projection without another request. */
function summarize(sessionId: string, discussion: Discussion): Summary {
  const tickets = discussion.requests.flatMap(request => request.tickets)
  return { sessionId, active: tickets.filter(ticket => !ticket.ended).length + discussion.requests.filter(request => !request.tickets.length).length,
    attention: tickets.filter(ticket => !!ticket.attention).length }
}

/** One label per Ticket state; the owner sees what the row waits for, not an internal status code. */
function taskStatus(t: T, task: Task): { tone: TagTone; label: string } {
  if (task.ended === 'stopped') return { tone: 'neutral', label: t('workbenchStatusStopped') }
  if (task.ended === 'completed') return { tone: 'success', label: t('workbenchStatusCompleted') }
  if (task.ended === 'merged') return { tone: 'success', label: t('workbenchStatusMerged') }
  if (task.ended === 'closed') return { tone: 'neutral', label: t('workbenchStatusClosed') }
  if (task.ended === 'dropped') return { tone: 'quiet', label: t('workbenchStatusDropped') }
  if (task.attention) return { tone: 'warning', label: t('workbenchStatusAttention') }
  if (task.paused) return { tone: 'warning', label: t('workbenchStatusPaused') }
  if (task.status?.stage === 'person') return { tone: 'warning', label: t(task.status.action === 'review' ? 'workbenchStatusReview' : 'workbenchStatusFailed') }
  if (task.status?.stage === 'idle') return { tone: 'quiet', label: t('workbenchStatusWaiting') }
  if (task.status?.stage === 'working' && task.status.action === 'queued') return { tone: 'neutral', label: t('workbenchStatusQueued') }
  return { tone: 'info', label: t('workbenchStatusWorking') }
}

function TaskRow({ task, t, busy, onOpen, onAct }: {
  task: Task; t: T; busy: boolean; onOpen: () => void; onAct: () => void
}) {
  const state = taskStatus(t, task)
  return <li className="dt-row">
    <div className="dt-row-main">
      <div className="dt-row-title">
        <Tag tone={state.tone}>{state.label}</Tag>
        <button type="button" className="dt-open" onClick={onOpen}>{task.title}</button>
      </div>
      {task.updatedAt && <div className="dt-row-meta">
        <span>{t('workbenchUpdated')}</span><time dateTime={task.updatedAt}>{when(task.updatedAt, t('lang'))}</time>
      </div>}
      {task.summary && <p className="dt-row-quote">{task.summary}</p>}
      {!task.ended && task.followupAt && <div className="dt-row-meta">
        <span>{t('workbenchNextFollowup')}</span><time dateTime={task.followupAt}>{when(task.followupAt, t('lang'))}</time>
      </div>}
      {task.attention && <div className="dt-banner">
        <span className="dt-banner-label">{t('attentionPrefix')}</span> {task.attention.question}
      </div>}
      {!!task.deliverables?.length && <ul className="dt-plain-list">
        {task.deliverables.map(item => <li key={item.url}><ExternalLink href={item.url}>{item.title}</ExternalLink></li>)}
      </ul>}
    </div>
    {task.ended !== 'stopped' && <div className="dt-row-actions">
      <Button size="sm" variant={task.attention ? 'primary' : 'outline'} disabled={busy}
        onClick={onAct}>{t(task.attention ? 'workbenchAnswer' : 'workbenchUpdate')}</Button>
    </div>}
  </li>
}

export function WorkbenchAction({ sessionId, t, openTicket }: { sessionId: string; t: T; openTicket(id: string): void }) {
  const [open, setOpen] = useState(false), [state, setState] = useState<Discussion>(), [error, setError] = useState('')
  const [instruction, setInstruction] = useState(''), [busy, setBusy] = useState(false), [received, setReceived] = useState(false)
  const [target, setTarget] = useState<{ ticketId: string; title: string; attentionId?: string }>()
  const [summary, setSummary] = useState<Summary>()
  const pending = useRef<WorkbenchRequest | WorkbenchUpdate>()
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    let live = true
    void loadSummary(sessionId).then(value => { if (live) setSummary(value) }, () => { if (live) setSummary(undefined) })
    return () => { live = false }
  }, [sessionId])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const current = await answer<Discussion>(await fetch(`/api/superagent-workbench/discussion?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal }))
        if (!controller.signal.aborted) { setState(current); setSummary(summarize(sessionId, current)) }
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)) }
      finally { if (!controller.signal.aborted) timer = setTimeout(refresh, 3000) }
    }
    setState(undefined); void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [open, sessionId])
  useEffect(() => { if (target) field.current?.focus() }, [target])
  const choose = (task: Task) => {
    setTarget({ ticketId: task.id, title: task.title, ...(task.attention ? { attentionId: task.attention.id } : {}) })
    setInstruction(''); setReceived(false); pending.current = undefined
  }
  const submit = async () => {
    if (!state || state.throughSeq === null || busy || (target && !instruction.trim())) return
    pending.current ??= { requestId: crypto.randomUUID(), sessionId, throughSeq: state.throughSeq,
      instruction: instruction.trim() || t('workbenchDefaultInstruction'),
      ...(target ? { ticketId: target.ticketId, ...(target.attentionId ? { attentionId: target.attentionId } : {}) } : {}) }
    setBusy(true); setError(''); setReceived(false)
    try {
      await answer(await fetch(`/api/superagent-workbench/${'ticketId' in pending.current ? 'update' : 'delegate'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pending.current) }))
      setReceived(true); pending.current = undefined; setInstruction('')
      summaries.delete(sessionId)
      void loadSummary(sessionId).then(setSummary, () => setSummary(undefined))
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const badge = summary && summary.attention > 0
    ? { tone: 'warning' as const, count: summary.attention, label: t('workbenchBadgeAttention', { count: String(summary.attention) }) }
    : summary && summary.active > 0
    ? { tone: 'info' as const, count: summary.active, label: t('workbenchBadgeActive', { count: String(summary.active) }) }
    : undefined
  const triggerLabel = badge ? `${t('workbenchTitle')} · ${badge.label}` : t('workbenchTitle')
  // Three sections instead of one flat list: what waits for the owner comes first, then what runs,
  // then what finished, so the thing that needs a person is never buried under recent history.
  const rows = state ? state.requests.flatMap(request => request.tickets.map(task => ({ request, task }))) : []
  const awaiting = state ? state.requests.filter(request => !request.tickets.length) : []
  const sections = [
    { key: 'attention', label: t('workbenchStatusAttention'), items: rows.filter(row => !!row.task.attention) },
    { key: 'active', label: t('workbenchSectionOpen'), items: rows.filter(row => !row.task.ended && !row.task.attention) },
    { key: 'done', label: t('workbenchSectionDone'), items: rows.filter(row => !!row.task.ended) },
  ].filter(section => section.items.length > 0)
  return <>
    <Button variant="ghost" size="sm" icon={<Icon name="inbox" size={14} />} aria-label={triggerLabel} title={triggerLabel}
      className="dt-workbench-trigger" onClick={event => { event.stopPropagation(); setOpen(true) }}>
      {badge && <span className="dt-workbench-badge" data-tone={badge.tone} aria-hidden>{badge.count > 9 ? '9+' : badge.count}</span>}
    </Button>
    {open && <style>{STYLES}</style>}
    <Modal open={open} onClose={() => setOpen(false)} title={t('workbenchTitle')} closeLabel={t('close')} description={t('workbenchDescription')}
      footer={<Button variant="primary" disabled={busy || !state || state.throughSeq === null || received || (!!target && !instruction.trim())} onClick={() => void submit()}>{busy ? t('workbenchSubmitting') : t(target ? 'workbenchSendUpdate' : 'workbenchDelegate')}</Button>}>
      {target && <div className="dt-banner dt-workbench-target">
        <span>{t('workbenchUpdateTarget', { title: target.title })}</span>
        <Button size="sm" disabled={busy} onClick={() => { setTarget(undefined); pending.current = undefined; setReceived(false); setInstruction('') }}>{t('workbenchNew')}</Button>
      </div>}
      <section className="dt-workbench-linked">
        {state ? (rows.length || awaiting.length ? <div className="dt-workbench-requests">
          {sections.map(section => <div key={section.key} className={section.key === 'attention' ? 'dt-workbench-request dt-workbench-decision' : 'dt-workbench-request'}>
            <h3 className="dt-workbench-heading">{section.label} · {section.items.length}</h3>
            <ul className="dt-list">{section.items.map(({ task }) => <TaskRow key={task.id} task={task}
              t={t} busy={busy} onOpen={() => { setOpen(false); openTicket(task.id) }} onAct={() => choose(task)} />)}</ul>
          </div>)}
          {awaiting.map(request => <div key={request.triggerId} className="dt-workbench-request">
            <h3 className="dt-workbench-heading">{t('workbenchStatusQueued')}</h3>
            <p className="dt-workbench-instruction">{request.instruction}</p>
            <p className="dt-hint">{t('workbenchPending')}</p>
          </div>)}
        </div> : <p className="dt-hint">{t('workbenchEmpty')}</p>) : <p className="dt-hint">{t('loading')}</p>}
      </section>
      <label className="dt-workbench-compose">{t('workbenchInstruction')}
        <textarea ref={field} aria-label={t('workbenchInstruction')} value={instruction} disabled={busy} maxLength={20000}
          style={{ width: '100%', minHeight: 90 }} onChange={event => { setInstruction(event.target.value); pending.current = undefined; setReceived(false) }} />
      </label>
      {state && <p className="dt-hint">{t('workbenchContext', { messages: String(state.messageCount), files: String(state.references.length) })}{state.partial ? ` ${t('workbenchPartial')}` : ''}</p>}
      {error && <p role="alert">{error}</p>}
      {received && <p role="status">{t(target ? 'workbenchUpdateReceived' : 'workbenchReceived')}</p>}
      {state?.notices?.slice(-5).map(notice => <p key={notice.id} role="status">{notice.text}</p>)}
    </Modal>
  </>
}
