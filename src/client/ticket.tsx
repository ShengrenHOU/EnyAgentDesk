/** Ticket detail page: stage and actions, Mandate details, undelivered/delivered Inputs, subscribed Threads, and Assignments. */
import { useReducer, useRef, useState, type ReactNode } from 'react'
import { WorkEvidence } from './work-evidence.tsx'
import { answerAttention, ApiError, usePoll, type TicketPageView } from './api.ts'
import { Button, DisclosureRow, Dot, Icon, Input, Tag, type IconName } from './controls.tsx'
import { conflicts, dirtyFields, initialManagement, managementPatch, managementReducer, managementValues, sameManagement, shownValues,
  unsavedFields, unsavedValues, type ManagementField, type ManagementPriority, type ManagementValues } from './management-draft.ts'
import { decisionMark, reportDot, ticketMark } from './marks.ts'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { ReplyForm } from './reply-form.tsx'
import { Field } from './settings-kit.tsx'
import { settingsRoute } from './route.ts'
import { Earlier, ThreadLine, automatedRuns } from './rows.tsx'
import { actorName, errorText, fullTime, localized, readableMarkers, reasonLabel, valueLabel, when, type T } from './text.ts'
import { ActionLink, ConfirmButton, ExternalLink, Hint, KeyValues, LabelValue, LoadState, MarkdownLite, PageHead, Section, SessionButton,
  StageMark, When } from './widgets.tsx'

type Input = TicketPageView['inputs'][number]
function ContinueStopped({ id, reload }: { id: string; reload: () => Promise<void> }) {
  const { t, call } = usePanel()
  const [instruction, setInstruction] = useState('')
  const action = useAction(() => call('POST tickets/:id/continue', { id, body: { instruction: instruction.trim() } }), { reload })
  return <Section title={t('continueStopped')} icon="refresh">
    <Hint>{t('continueStoppedHint')}</Hint>
    <form className="dt-form" onSubmit={event => { event.preventDefault(); if (instruction.trim()) void action.run() }}>
      <textarea aria-label={t('continueStopped')} value={instruction} maxLength={20000} disabled={action.busy}
        style={{ width: '100%', minHeight: 90 }} onChange={event => setInstruction(event.target.value)} />
      <Button type="submit" variant="primary" disabled={action.busy || !instruction.trim()}>{t('continueStopped')}</Button>
    </form>
  </Section>
}
type AnswerRequest = { requestId: string; sessionId: string; throughSeq: number; ticketId: string; attentionId?: string;
  instruction: string }
async function readJson<T>(response: Response): Promise<T> {
  const body: unknown = await response.json()
  if (!response.ok) throw new Error(body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
    ? body.error : `Request failed (${response.status})`)
  return body as T
}
/** Owner answers use the shared command; other supplements retain their original discussion and retry identity. */
function AnswerComposer({ ticket, sessionId, reload }: { ticket: TicketPageView; sessionId?: string; reload: () => Promise<void> }) {
  const { t } = usePanel()
  const [question, setQuestion] = useState(ticket.attention)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [sent, setSent] = useState(false)
  const pending = useRef<AnswerRequest>()
  const submit = async () => {
    const attention = question
    const text = instruction.trim()
    if (!text || busy) return
    setBusy(true); setFailure(undefined); setSent(false)
    try {
      if (attention) await answerAttention(t, ticket.id, attention.id, text)
      else {
        if (!sessionId) throw new Error(t('ticketAnswerUnavailable'))
        if (pending.current?.instruction !== text) {
          const discussion = await readJson<{ throughSeq: number | null }>(await fetch(
            `/api/superagent-workbench/discussion?sessionId=${encodeURIComponent(sessionId)}`))
          if (discussion.throughSeq === null) throw new Error(t('ticketAnswerUnavailable'))
          pending.current = { requestId: crypto.randomUUID(), sessionId, throughSeq: discussion.throughSeq,
            ticketId: ticket.id, instruction: text }
        }
        await readJson(await fetch('/api/superagent-workbench/update', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(pending.current) }))
      }
      pending.current = undefined
      setInstruction(''); setSent(true)
      await reload()
    } catch (error) {
      // Keep the text for a retry; the component keeps the same request until the text changes.
      setFailure(errorText(error))
    } finally { setBusy(false) }
  }
  return <>
    {question && ticket.attention && question.id !== ticket.attention.id && <div role="status">
      <Hint>{t('ticketAnswerChanged')}</Hint><Button size="sm" variant="outline"
        onClick={() => { setQuestion(ticket.attention); setFailure(undefined) }}>{t('ticketAnswerUseCurrent')}</Button>
    </div>}
    <ReplyForm value={instruction} busy={busy} onChange={value => { setInstruction(value); setSent(false) }} onSubmit={() => void submit()} />
    {sent && <span className="dt-hint" role="status">{t('ticketAnswerSent')}</span>}
    {failure && <p className="dt-error" role="alert">{failure}</p>}
  </>
}
const managementLabel = (t: T, field: ManagementField): string => field === 'priority' ? t('ticketPriority')
  : field === 'dueAt' ? t('ticketDueAt') : t('ticketPaused')
const managementValue = (t: T, field: ManagementField, value: ManagementValues[ManagementField] | undefined): string => {
  if (field === 'priority') return value === undefined ? t('unsetValue') : t(`priority.${value as ManagementPriority}`)
  if (field === 'dueAt') return value ? String(value) : t('unsetValue')
  return t(value ? 'yes' : 'no')
}
/**
 * The management editor keeps one component identity for a Ticket and holds local edits in its own draft. A poll that
 * brings another entry's change updates the fields the owner did not edit, while a field edited in both places waits for a
 * choice; only edited fields are sent, so an unedited field saved elsewhere is not overwritten.
 */
function TicketManagement({ ticket, reload, ended }: { ticket: TicketPageView; reload: () => Promise<void>; ended: boolean }) {
  const { t, call } = usePanel()
  const [state, dispatch] = useReducer(managementReducer, managementValues(ticket), initialManagement)
  const remote = managementValues(ticket)
  // Follow server values between polls without touching the local draft; this adjusts state during render by design.
  // While a save is in flight its reducer ignores polls, so this dispatch must wait or it would re-render forever.
  if (state.phase !== 'saving' && !sameManagement(state.remote, remote)) dispatch({ type: 'server', remote })
  const [failure, setFailure] = useState<string>()
  const [saving, setSaving] = useState(false)
  const values = shownValues(state)
  const dirty = dirtyFields(state)
  const unsaved = unsavedFields(state)
  const disputed = conflicts(state)
  const busy = saving || state.phase === 'saving'
  const canEdit = !ended && !busy
  const save = async () => {
    // A field changed in both places needs the owner's choice; saving would silently pick the local side.
    if (busy || !unsaved.length || disputed.length) return
    let patch: ReturnType<typeof managementPatch>
    try { patch = managementPatch(state.remote, unsavedValues(state)) }
    catch { setFailure(t('ticketDueAtInvalid')); return }
    setFailure(undefined); setSaving(true); dispatch({ type: 'submit' })
    try {
      await call('PUT tickets/:id/management', { id: ticket.id, body: patch })
      dispatch({ type: 'saved' })
      await reload()
    } catch (error) { dispatch({ type: 'failed' }); setFailure(errorText(error)) }
    finally { setSaving(false) }
  }
  // An ended Ticket keeps a clean editor from coming back after the next poll; an active draft stays visible and copyable.
  if (ended && !dirty.length) return null
  return <Details icon="queue" title={t('taskManagement')}>
    <form className="dt-form" onSubmit={event => { event.preventDefault(); void save() }}>
      {ended && <Hint>{t('ticketManagementEnded')}</Hint>}
      <Field label={t('ticketPriority')}><select className="dt-select" value={values.priority} disabled={!canEdit}
        onChange={event => dispatch({ type: 'priority', value: event.target.value as ManagementValues['priority'] })}>
        {(['low', 'normal', 'high', 'urgent'] as const).map(value => <option key={value} value={value}>{t(`priority.${value}`)}</option>)}
      </select></Field>
      <Field label={t('ticketDueAt')}><Input type="datetime-local" value={values.dueAt} disabled={!canEdit}
        onChange={event => dispatch({ type: 'dueAt', value: event.target.value })} /></Field>
      <label><input type="checkbox" checked={values.paused} disabled={!canEdit}
        onChange={event => dispatch({ type: 'paused', value: event.target.checked })} /> {t('ticketPaused')}</label>
      <Hint>{t('ticketPausedHint')}</Hint>
      {!ended && <Button type="submit" variant="outline" disabled={busy || !unsaved.length || disputed.length > 0}>{t('managementSave')}</Button>}
      {disputed.map(field => <div key={field} className="dt-banner" role="alert">
        <p>{t('ticketManagementConflict', { field: managementLabel(t, field) })}</p>
        <KeyValues rows={[[t('ticketManagementBase'), managementValue(t, field, state.base[field])],
          [t('ticketManagementLocal'), managementValue(t, field, state.mine[field])],
          [t('ticketManagementRemote'), managementValue(t, field, state.remote[field])]]} />
        <div className="dt-banner-actions">
          <Button type="button" size="sm" variant="outline" disabled={busy}
            onClick={() => dispatch({ type: 'useRemote', field })}>{t('ticketManagementUseRemote')}</Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy}
            onClick={() => dispatch({ type: 'keepMine', field })}>{t('ticketManagementKeepMine')}</Button>
        </div>
      </div>)}
      {ended && !!dirty.length && <KeyValues rows={dirty.map(field => [managementLabel(t, field), managementValue(t, field,
        state.mine[field])])} />}
      {busy ? <Hint>{t('ticketManagementSaving')}</Hint> : <>
        {!disputed.length && state.notice === 'merged' && <Hint>{t('ticketManagementRemoteUpdated')}</Hint>}
        {!disputed.length && !!unsaved.length && <Hint>{t('ticketManagementEditing')}</Hint>}
        {!disputed.length && !unsaved.length && state.notice === 'saved' && <span className="dt-hint" role="status">{t('saved')}</span>}
      </>}
      {failure && <p className="dt-error" role="alert">{failure}</p>}
    </form>
  </Details>
}

function FollowupEditor({ ticket, reload }: { ticket: TicketPageView; reload: () => Promise<void> }) {
  const { t, call } = usePanel()
  const [at, setAt] = useState('')
  const [reason, setReason] = useState('')
  const pending = useRef<{ request_id: string; at: string; reason: string }>()
  const schedule = useAction(async () => {
    const time = new Date(at).getTime()
    if (!Number.isFinite(time) || time <= Date.now()) throw new Error(t('ticketFollowupFuture'))
    const request = { at: new Date(time).toISOString(), reason: reason.trim() }
    if (pending.current?.at !== request.at || pending.current.reason !== request.reason) {
      pending.current = { ...request, request_id: crypto.randomUUID() }
    }
    await call('POST tickets/:id/followup', { id: ticket.id, body: pending.current })
    pending.current = undefined; setAt(''); setReason('')
  }, { reload })
  return <Details icon="clock" title={t('ticketScheduleFollowup')}>
    <Hint>{t('ticketScheduleFollowupHint')}</Hint>
    <form className="dt-form" onSubmit={event => { event.preventDefault(); if (at && reason.trim()) void schedule.run() }}>
      <Field label={t('ticketFollowupTime')}><Input type="datetime-local" value={at} disabled={schedule.busy}
        onChange={event => setAt(event.target.value)} /></Field>
      <Field label={t('ticketFollowupReason')}><textarea value={reason} maxLength={2000} disabled={schedule.busy}
        onChange={event => setReason(event.target.value)} /></Field>
      <Button type="submit" size="sm" variant="outline" disabled={schedule.busy || !at || !reason.trim()}>{t('ticketSaveFollowup')}</Button>
    </form>
  </Details>
}
function InputLine({ input, earlier = [] }: { input: Input; earlier?: { id: string; at: string; preview: string }[] }) {
  const { t, navigate } = usePanel()
  const trigger = input.kind === 'trigger' ? input.trigger : undefined
  return <li className="dt-row">
    <Dot state={input.delivered ? 'idle' : 'warning'} label={input.delivered ? t('inputDelivered') : t('inputUndelivered')} />
    <div className="dt-row-main">
      {trigger ? <div className="dt-row-title"><button type="button" className="dt-open" onClick={() => navigate({ page: 'trigger',
        id: trigger.thread, query: { trigger: trigger.id } })}>
        {actorName(t, trigger.actor)}{t('labelSeparator')}{readableMarkers(t, trigger.preview) || t('empty')}
      </button></div> : <div className="dt-row-title">{valueLabel(t, 'input', input.kind)}</div>}
      <div className="dt-row-meta">{input.kind === 'trigger' && <span>{valueLabel(t, 'input', input.kind)}</span>}<When
        at={input.at} /></div>
      {input.kind === 'answer' && <p className="dt-hint">{input.question}</p>}
      {(input.kind === 'text' || input.kind === 'note' || input.kind === 'answer') && input.text && <div className="dt-row-quote"><MarkdownLite text={input.text} /></div>}
      {trigger?.handback && <Hint>{t('inputHandedBack', { reason: trigger.handback.reason })}</Hint>}
      <Earlier items={earlier} />
    </div>
  </li>
}
function InputList({ inputs }: { inputs: Input[] }) {
  const sender = (input: Input) => input.kind === 'trigger' && input.trigger && !input.trigger.human
    ? `${input.trigger.actor.source}:${input.trigger.actor.id}` : undefined
  const shown = (input: Input) => ({ id: input.id, at: input.at, preview: input.kind === 'trigger' ? input.trigger?.preview ?? '' : '' })
  return <ul className="dt-list">{automatedRuns(inputs, sender).map(run => <InputLine key={run.item.id} input={run.item}
    earlier={run.earlier.map(shown)} />)}</ul>
}

function Details({ icon, title, open = false, children }: { icon: IconName; title: ReactNode; open?: boolean; children: ReactNode }) {
  const [shown, setShown] = useState(open)
  return <DisclosureRow icon={<Icon name={icon} />} title={title} open={shown} onToggle={() => setShown(!shown)}>
    <div className="dt-disclosure-body">{children}</div>
  </DisclosureRow>
}
type Report = NonNullable<TicketPageView['assignments'][number]['report']>
/** The professional method and the skills a report recorded, so the result's basis is visible without asking the worker. */
function MethodSkills({ report }: { report: Report }) {
  const { t } = usePanel()
  if (!report.method && !report.skills?.length) return null
  return <div className="dt-report-method">
    {report.method && <KeyValues rows={[[t('reportMethod'), report.method]]} />}
    {!!report.skills?.length && <div>
      <span className="dt-stat-label">{t('reportSkills')}</span>
      <ul className="dt-plain-list">{report.skills.map(skill => <li key={`${skill.name}:${skill.path ?? ''}`}>
        <span className="dt-mono">{skill.name}</span>
        {skill.path && <span className="dt-mono"> · {skill.path}</span>}
        {skill.revision && <span> · {t('reportSkillRevision', { revision: skill.revision })}</span>}
        {skill.template && <span> · {t('reportSkillTemplate', { template: skill.template })}</span>}
      </li>)}</ul>
    </div>}
  </div>
}
function Assignments({ ticket }: { ticket: TicketPageView }) {
  const { t } = usePanel()
  const report = (state: string) => t('assignmentReportShort', { state: valueLabel(t, 'report', state) })
  return <ul className="dt-list">{ticket.assignments.slice().reverse().map((item, index) => <li key={item.id} className="dt-row">
    <Dot state={item.state === 'running' ? reportDot(item.report?.state) : 'idle'} label={valueLabel(t, 'assignment', item.state)} />
    <div className="dt-row-main">
      <div className="dt-row-title">{t('assignmentNumber', { number: ticket.assignments.length - index })}</div>
      <div className="dt-row-meta">
        {/* A running Assignment whose worker reported a non-progress state has ended its turn; show that report as its tag and end its span there. */}
        {item.turnEndedAt && item.report ? <Tag tone="neutral">{report(item.report.state)}</Tag> : <Tag tone={item.state === 'running'
          ? 'info'
          : 'neutral'}>{valueLabel(t, 'assignment', item.state)}</Tag>}
        {item.state !== 'running' && item.report && <span>{report(item.report.state)}</span>}
        <span>{t('assignmentSpan', { from: when(item.startedAt ?? item.createdAt, t('lang')), to: when(item.endedAt ?? item.turnEndedAt,
          t('lang')) || t('now') })}</span>
        {item.endedReason && <span>{reasonLabel(t, item.endedReason)}</span>}
      </div>
      {item.report && <MethodSkills report={item.report} />}
    </div>
    {item.ref && item.ref !== ticket.sessionId && <div className="dt-row-actions"><SessionButton variant="outline"
      sessionId={item.ref} /></div>}
  </li>)}</ul>
}
function MandateDetails({ ticket, actor }: { ticket: TicketPageView; actor: string }) {
  const { t, navigate } = usePanel()
  const { mandate, decision } = ticket
  const fact = (item: TicketPageView['basis']['facts'][number]): string => {
    if (item.name === 'legacyAuthority') return valueLabel(t, 'legacy', item.value)
    if (item.name === 'mode' || item.name === 'addressed') return valueLabel(t, item.name, item.value)
    if (item.name === 'admission') return valueLabel(t, 'admissionCell', item.value)
    if (item.name === 'rules') return item.value.map(rule => rule.name).join(t('listSeparator'))
    return item.name === 'sender' ? item.value : t('yes')
  }
  const { legacy } = ticket.basis
  // Omit `sender` when it matches `actor`, which is already shown on the status line.
  const facts = ticket.basis.facts.filter(item => !(item.name === 'sender' && item.value === actor))
  const direction = decision?.direction
  const rows: [string, ReactNode][] = decision ? [
    [t('term.trigger'), <button type="button" className="dt-trigger-link" onClick={() => navigate({ page: 'trigger', id: decision.thread,
      query: { trigger: decision.triggerIds[0] ?? '' } })}>
      <span className="dt-trigger-text">{readableMarkers(t, decision.preview) || t('empty')}</span>
      <span className="dt-row-meta"><span>{valueLabel(t, 'source', mandate.actor.source)} · {actor}</span><When at={decision.at} /></span>
    </button>],
    [t('term.decision'), <div className="dt-kv-stack">
      <span>{decisionMark(t, decision.outcome).label}</span>
      <Hint>{reasonLabel(t, decision.reason)}</Hint>
      {decision.rules.map(rule => <Hint key={rule.id}>{t(rule.matched ? 'ruleMatched' : 'ruleUnmatched', { rule: rule.name,
        reason: rule.reason })}</Hint>)}
      {direction && <Hint>{t('directionLine', { intent: t(direction.implementation_requested ? 'intentYes' : 'intentNo'),
        basis: valueLabel(t, 'targetBasis', direction.target_basis),
        design: t(direction.requires_design_decision ? 'designNeeded' : 'designNotNeeded') })} {t('directionEvidence',
          { evidence: direction.evidence })}</Hint>}
    </div>],
  ] : []
  const version = <button type="button" className="dt-textlink dt-mono" onClick={() => navigate(settingsRoute('eval',
    { version: mandate.policyVersion }))}>{mandate.policyVersion.slice(0, 8)}</button>
  return <Section title={t('mandateDetails')} icon="shield">
    <KeyValues rows={[...rows, [t('term.scope'), legacy ? t('legacyScopeShort') : mandate.scope || t('empty')],
      ...ticket.requiredSkills?.length ? [[t('requiredSkills'), ticket.requiredSkills.join(t('listSeparator'))] as [string, ReactNode]] : [],
      ...facts.map((item): [string, string] => [valueLabel(t, 'basis', item.name), fact(item)]),
      ...legacy ? [] : [[t('policyVersion'), version] as [string, ReactNode]]]} />
  </Section>
}

export function TicketPage({ id }: { id: string }) {
  const { t, call } = usePanel()
  const { setup } = usePanelData()
  const [preview, setPreview] = useState<{ title: string; url: string }>()
  const { data, error, reload } = usePoll(() => call('GET tickets/:id', { id }), [id])
  const after = async (request: Promise<unknown>) => { await request; await reload() }
  if (!data) return <><PageHead
    title={t('term.ticket')} />{error instanceof ApiError && error.missing ? <Hint>{t('ticketNotFound')}</Hint> : <LoadState
      error={error} loading />}</>
  const status = ticketMark(t, data)
  const actor = actorName(t, data.mandate.actor)
  const { legacy } = data.basis
  const undelivered = data.inputs.filter(input => !input.delivered)
  const failedText = /^(?:\w+Error|Error)\b[:：]/.test(data.summary)
  const failed = data.stage === 'person' && data.action === 'failed'
  const latest = data.assignments.findLast(item => item.report)?.report
  const opening = data.threads.find(thread => thread.url)
  const ended = data.ended && (() => {
    const outcome = valueLabel(t, 'outcome', data.ended.outcome), reason = reasonLabel(t, data.ended.reason), time = when(data.ended.at,
      t('lang'))
    return reason ? t('endedAt', { time, outcome, reason }) : t('endedAtShort', { time, outcome })
  })()
  const channel = data.channels[0]
  // A Ticket started in the owner discussion can take its answer there; a source Ticket keeps its source link.
  const workbench = data.mandate.actor.source === 'workbench'
    ? data.channels.find(item => item.source === 'workbench' && item.sessionId) : undefined
  return <>
    <PageHead title={data.title}>
      {opening?.url && <ActionLink href={opening.url}>{t('openThread', { source: valueLabel(t, 'source', opening.source) })}</ActionLink>}
      {data.actions.retry && <ConfirmButton variant="outline" icon="refresh" label={t('retry')} title={t('retryTitle')}
        message={t('retryConfirm', { title: data.title })}
        onConfirm={() => after(call('POST tickets/:id/retry', { id }))} />}
      {data.sessionId && <SessionButton variant="outline" sessionId={data.sessionId} />}
      {data.codexThreadId && <code title="Codex thread">Codex: {data.codexThreadId}</code>}
    </PageHead>
    {error && <LoadState error={error} loading={false} />}
    <WorkEvidence key={id} t={t} load={before => call('GET tickets/:id/evidence', { id, query: { before } })} />
    <div className="dt-row-meta dt-status-line">
      <StageMark state={status.dot} icon={status.icon} label={status.label} />
      {data.executor && <LabelValue label={t('term.executor')} value={t(`executorKind.${data.executor}`)} />}
      <LabelValue label={t('ticketMandateLabel')} value={valueLabel(t, 'strength', data.mandate.strength)} />
      <LabelValue label={t('ticketActorLabel')} value={`${valueLabel(t, 'source', data.mandate.actor.source)} · ${actor}`} />
      <LabelValue label={t('ticketUpdatedLabel')} value={when(data.updatedAt, t('lang'))} />
    </div>
    {ended && <Hint>{ended}</Hint>}
    {data.attention && <div className="dt-banner dt-attention" role="group" aria-label={t('attentionPrefix')}>
      <span className="dt-banner-label">{t('attentionPrefix')}</span><MarkdownLite text={data.attention.question} />
      <AnswerComposer key={`${data.id}:answer`} ticket={data} reload={reload} />
      {channel && <div className="dt-banner-actions">
        {channel.sessionId ? <SessionButton sessionId={channel.sessionId} label={t('workbenchReturnDiscussion')} />
          : <ActionLink href={channel.url} icon="message">{t('answerIn', { source: valueLabel(t, 'source', channel.source) })}</ActionLink>}
      </div>}
    </div>}
    {/* A halted Ticket is the second thing to see: its reason and the retry action stay next to the pending question. */}
    {data.actions.retry && data.summary && <p className={`dt-banner${failed ? ' dt-danger' : ''}${failedText ? ' dt-mono' : ''}`}>
      <span className="dt-banner-label">{t(failed ? 'failedPrefix' : 'blockedPrefix')}</span>{data.summary}
    </p>}
    {data.deliveryError && <p className="dt-banner dt-danger dt-mono">
      <span className="dt-banner-label">{t('deliveryFailedPrefix')}</span>{data.deliveryError}
    </p>}
    {data.ended?.outcome === 'stopped' && setup?.machine.executor.kind === 'dsh' && <ContinueStopped id={id} reload={reload} />}
    {(!data.ended || data.followups?.length || data.followup) && <Section title={t('ticketFollowupAt')} icon="clock">
      {(data.followups ?? (data.followup ? [data.followup] : [])).map(item => <div key={item.id}>
        <KeyValues rows={[[t('ticketFollowupAt'), fullTime(item.at, t('lang'))], [t('ticketFollowupReason'), item.reason]]} />
        {!data.ended && <ConfirmButton label={t('homeCancelFollowup')} title={t('homeCancelFollowupTitle')}
          message={t('homeCancelFollowupConfirm', { title: data.title, at: fullTime(item.at, t('lang')), reason: item.reason })}
          onConfirm={() => after(call('DELETE tickets/:id/followup', { id, query: { request_id: item.id } }))} />}
      </div>)}
      {!data.ended && <FollowupEditor ticket={data} reload={reload} />}
    </Section>}
    {!!data.deliverables?.length && <Section title={t('ticketDeliverables')}>
      <ul className="dt-plain-list">{data.deliverables.map(item => {
        const url = new URL(item.url, location.href)
        return <li key={item.url}><ExternalLink href={item.url}>{item.title}</ExternalLink>
          {url.origin === location.origin && url.pathname === '/api/superagent-workbench/artifact' && <Button size="sm" variant="ghost"
            onClick={() => setPreview(item)}>{t('ticketPreview')}</Button>}</li>
      })}</ul>
      {preview && <div className="dt-owner-preview"><div className="dt-owner-section-head"><strong>{preview.title}</strong>
        <Button size="sm" variant="ghost" onClick={() => setPreview(undefined)}>{t('close')}</Button></div>
        <iframe src={preview.url} title={preview.title} sandbox="" />
      </div>}
    </Section>}
    {!data.attention && workbench?.sessionId && data.ended?.by !== 'human' && <Section title={t('ownerDeskRevise')} icon="message">
      <AnswerComposer key={`${data.id}:update`} ticket={data} sessionId={workbench.sessionId} reload={reload} />
    </Section>}
    {data.executionStages && <Section title={t('executionStages')} icon="clock">
      <KeyValues rows={[[t('executionStage'), data.executionStages.current],
        [t('executionPending'), data.executionStages.pending?.stage ?? t('empty')]]} />
      <ul className="dt-list">{data.executionStages.turns.map(turn => <li key={turn.turnId} className="dt-row">
        <KeyValues rows={[[t('executionRequested'), turn.requestedModel],
          [t('executionActual'), turn.actualModel ?? t('executionUnknown')],
          [t('executionEvidence'), turn.evidence ?? t('executionUnknown')]]} />
      </li>)}</ul>
      <ul className="dt-list">{data.executionStages.history.map((entry, index) => <li key={index} className="dt-row">
        <div><span>{entry.stage} · {entry.model}</span> <When at={entry.at} />
          {entry.handoff && <KeyValues rows={Object.entries(entry.handoff)} />}</div>
      </li>)}</ul>
    </Section>}
    {!!data.executorHandoffs?.length && <Section title={t('executorHandoffs')} icon="history">
      {data.executorHandoffs.map((entry, index) => <Details key={index} icon="history" title={<>
        {t(`executorKind.${entry.from}`)} → {t(`executorKind.${entry.to}`)} · <When at={entry.at} />
      </>}><KeyValues rows={Object.entries(entry.handoff)} /></Details>)}
    </Section>}
      {data.summary && !data.actions.retry && (data.codexThreadId || data.stage === 'ended' || data.stage === 'idle'
        || data.stage === 'person' && data.action === 'review') && <div className="dt-details">
      <Details icon="message" title={t('latestExecutionReport')} open>
        <MarkdownLite text={data.summary} />
        {latest && <MethodSkills report={latest} />}
        {data.codexThreadId && <Hint>{t('codexReportHistoryHint')}</Hint>}
      </Details>
    </div>}
    <TicketManagement key={data.id} ticket={data} reload={reload} ended={!!data.ended} />
    <MandateDetails ticket={data} actor={actor} />
    {undelivered.length > 0 && <Section title={t('undeliveredInputs')} count={undelivered.length}>
      <Hint>{data.deliveryError ? t('inputRetryHint') : data.paused ? t('inputPausedHint') : t('inputWaitingHint')}</Hint>
      <InputList inputs={undelivered} />
    </Section>}
    {data.threads.length > 0 && <Section title={t('subscribedThreads')} count={data.threads.length}>
      <ul className="dt-list">{data.threads.map(thread => <ThreadLine key={thread.key} thread={thread} ticketId={data.id}
        context={thread.context} />)}</ul>
    </Section>}
    <div className="dt-details">
      {/* A single Assignment adds nothing beyond the status line; list Assignments only once work has been resumed or handed over. */}
      {data.assignments.length > 1 && <Details icon="queue" title={`${t('term.assignment')} · ${data.assignments.length}`} open><Assignments
        ticket={data} /></Details>}
      {data.environment.length > 0 && <Details icon="settings" title={t('term.environment')}>
        <table className="dt-table"><tbody>{data.environment.map(variable => <tr key={variable.key} title={localized(t,
          variable.description)}>
          <td className="dt-mono">{variable.key}</td><td className="dt-mono">{variable.value || <span
            className="dt-hint">{t('empty')}</span>}</td>
        </tr>)}</tbody></table>
      </Details>}
      <Details icon="message" title={t('term.channel')}>
        <ul className="dt-plain-list">{data.channels.map((item, index) => <li key={index}>
          <ExternalLink href={item.url} icon={item.source === 'github' ? 'pull' : 'message'}>{localized(t, item.label)}</ExternalLink>
        </li>)}</ul>
      </Details>
      {data.inputs.length > undelivered.length && <Details icon="inbox" title={t('deliveredInputs',
        { count: data.inputs.length - undelivered.length })}>
        <InputList inputs={data.inputs.filter(input => input.delivered)} />
      </Details>}
      <Details icon="hash" title={t('identifiers')}>
        <KeyValues rows={[[t('ticketId'), <span className="dt-mono">{data.id}</span>], [t('executionDirectory'), <span
          className="dt-mono">{data.directory ?? t('empty')}</span>],
          ...legacy && data.mandate.scope ? [[t('legacyAssignment'), <span
            className="dt-mono dt-clamp">{data.mandate.scope}</span>] as [string, ReactNode]] : []]} />
      </Details>
    </div>
    {data.actions.stop && <div className="dt-danger-zone">
      <span className="dt-hint">{t('stopHint')}</span>
      <ConfirmButton variant="outline" label={t('stop')} title={t('stopConfirmTitle')} message={t('stopConfirm', { title: data.title })}
        onConfirm={() => after(call('POST tickets/:id/stop', { id, body: {} }))} />
    </div>}
  </>
}
