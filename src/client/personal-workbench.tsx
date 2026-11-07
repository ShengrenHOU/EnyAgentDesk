/** Daily work index with a one-line supplement for one matter; full discussion stays in the main Session. */
import { useEffect, useRef, useState } from 'react'
import type { readFocus } from '../sources/workbench-focus.ts'
import { usePoll, type TicketRow } from './api.ts'
import { Button, Icon, Tag } from './controls.tsx'
import { ticketMark } from './marks.ts'
import { ProblemList } from './overview.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { errorText, localized, valueLabel, when, type T } from './text.ts'
import { ConfirmButton, ExternalLink, LoadState, MarkdownLite } from './widgets.tsx'

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

export function Workbench(props: Props) {
  const { t, call } = usePanel()
  const { state, error: stateError } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET overview'), [])
  const ready = !!state?.masterId
  const focus = usePoll(() => read<ReturnType<typeof readFocus>>('focus'), [])
  const sources = usePoll(() => call('GET sources'), [])
  const [domainId, setDomainId] = useState('')
  const [chatOpen, setChatOpen] = useState(false)
  const [selected, setSelected] = useState<string>()
  const [reply, setReply] = useState<Pick<TicketRow, 'id' | 'title' | 'attention'>>()
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [focusSending, setFocusSending] = useState(false)
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState<string>()
  const [preview, setPreview] = useState<{ title: string; url: string }>()
  const requested = useRef(false)
  const detail = usePoll(() => selected ? call('GET tickets/:id', { id: selected }) : Promise.resolve(null), [selected])
  const refreshing = !!focus.data?.requested && (!focus.data.focus || focus.data.requested.at > focus.data.focus.generatedAt)
  const refresh = async () => {
    if (focusSending) return
    setFocusSending(true); setFailure(undefined)
    try { await read('focus/refresh', { method: 'POST' }); await focus.reload() }
    catch (error) { setFailure(errorText(error)) }
    finally { setFocusSending(false) }
  }
  useEffect(() => {
    if (!focus.data || requested.current) return
    const current = focus.data.focus
    const nextDay = current && new Date(current.generatedAt).toDateString() !== new Date().toDateString()
    if (current && !nextDay && !current.items.some(item => item.stale)) return
    requested.current = true
    const freshRequest = focus.data.requested && Date.now() - Date.parse(focus.data.requested.at) < 120_000
    if (!freshRequest) void refresh()
  }, [focus.data])
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
  const respond = (ticket: Pick<TicketRow, 'id' | 'title' | 'attention'>) => { setReply(ticket); setInstruction(''); setNotice(''); setPreview(undefined); setChatOpen(true) }
  const stop = async (ticket: Pick<TicketRow, 'id' | 'title'>) => {
    await call('POST tickets/:id/stop', { id: ticket.id })
    if (reply?.id === ticket.id) { setReply(undefined); setInstruction('') }
    setSelected(ticket.id)
    setNotice(t('homeStopped', { title: ticket.title }))
    await Promise.all([reload(), detail.reload(), focus.reload()])
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
        message={t('homeCancelFollowupConfirm', { reason: item.reason })} onConfirm={async () => {
          await call('DELETE tickets/:id/followup', { id: ticket.id, query: { request_id: item.id } })
          setNotice(t('homeFollowupCancelled')); await Promise.all([reload(), detail.reload(), focus.reload()])
        }} />
    </div>)}
    <div className="pw-task-evidence">{[...new Set(ticket.threads.map(thread => thread.source))].slice(0, 3).map(id => {
      const source = sources.data?.find(source => source.id === id)
      return <span key={id}>{source ? localized(t, source.title) : valueLabel(t, 'source', id)}</span>
    })}
      <time dateTime={ticket.updatedAt}>{when(ticket.updatedAt, t('lang'))}</time></div>
    <div className="pw-actions"><Button size="sm" variant="outline" onClick={() => respond(ticket)}>{t(ticket.attention ? 'workbenchAnswer' : 'ownerDeskRevise')}</Button>
      {stopButton(ticket)}
      {ticket.deliverables?.map(item => {
        const url = new URL(item.url, location.href)
        return url.origin === location.origin && url.pathname === '/api/superagent-workbench/artifact'
          ? <Button size="sm" variant="ghost" key={item.url} onClick={() => setPreview(item)} icon={<Icon name="review" size={14} />}>{item.title}</Button>
          : <ExternalLink key={item.url} href={item.url}>{item.title}</ExternalLink>
      })}</div>
  </article>
  const section = (title: string, items: TicketRow[], empty?: string, total = items.length, filter: 'open' | 'ended' = 'open') => <section className="pw-section">
    <div className="pw-section-title"><h2>{title}</h2><span>{total}</span></div>
    {items.length ? <div className="pw-task-grid">{items.map(card)}</div> : empty && <p className="pw-empty">{empty}</p>}
    {total > items.length && <Button size="sm" variant="ghost" onClick={() => props.openWorkList(filter)}>
      {t('homeMoreWork', { shown: items.length, total })}</Button>}
  </section>
  const active = [...(data?.work?.working ?? []), ...(data?.work?.waiting ?? [])]
  const domains = focus.data?.domains?.filter(domain => domain.state === 'active') ?? []
  const selectedDomain = domains.find(domain => domain.id === domainId)
  const suggestions = focus.data?.focus?.items.filter(item => !selectedDomain || item.domainId === selectedDomain.id) ?? []
  return <div className="pw-shell" data-chat={chatOpen}>
    <div className="pw-layout"><main className="pw-main">
      <header className="pw-daily-heading"><div><h2>{t('homeDailyTitle')}</h2><p>{t('homeFocusHint')}</p></div>
        <Button variant="primary" disabled={!ready} icon={<Icon name="message" size={17} />}
          title={ready ? undefined : t('masterNotReady')}
          onClick={() => { if (state) void props.openSession(state.masterId).catch(error => setFailure(errorText(error))) }}>{t('mainConversationEntry')}</Button></header>
      <section className="pw-domains" aria-label={t('homeDomains')}><div className="pw-section-title"><h2>{t('homeDomains')}</h2>
        <div className="pw-actions"><Button size="sm" variant="ghost" onClick={props.openDomainSettings}>{t('homeManageDomains')}</Button>
          <Button size="sm" variant="ghost" onClick={props.openGithubSettings}>{t('homeGithubSettings')}</Button></div></div>
        <div className="pw-domain-grid"><button type="button" className="pw-domain" aria-pressed={!selectedDomain} onClick={() => setDomainId('')}>
          <strong>{t('homeAllDomains')}</strong><span>{focus.data?.focus ? t('homeDomainSuggestions', { count: focus.data.focus.items.length }) : t('homeDomainPending')}</span></button>
          {domains.map(domain => {
            const count = focus.data?.focus?.items.filter(item => item.domainId === domain.id).length ?? 0
            return <button type="button" className="pw-domain" key={domain.id} aria-pressed={selectedDomain?.id === domain.id} onClick={() => setDomainId(domain.id)}>
              <strong>{domain.name}</strong><span>{!focus.data?.focus ? t('homeDomainPending') : count ? t('homeDomainSuggestions', { count }) : t('homeDomainNoSuggestions')}</span></button>
          })}</div>
      </section>
      {(stateError || error) && <LoadState error={stateError ?? error} loading={false} />}
      {state && !ready && <p className="pw-muted" role="status">{t('masterNotReady')}</p>}
      {failure && <p className="dt-error" role="alert">{failure}</p>}
      {notice && <p className="pw-notice" role="status">{notice}</p>}
      {preview && <section className="pw-preview"><div className="pw-section-title"><h2>{preview.title}</h2>
        <div className="pw-actions"><ExternalLink href={preview.url}>{t('details')}</ExternalLink><Button size="sm" variant="ghost" onClick={() => setPreview(undefined)}>{t('close')}</Button></div></div>
        <iframe title={preview.title} src={preview.url} sandbox="" /></section>}
      {selected ? <section className="pw-section"><Button size="sm" variant="ghost" onClick={() => setSelected(undefined)} icon={<Icon name="chevron-left" />}>{t('homeBack')}</Button>
        {detail.data?.id === selected ? <><h2>{detail.data.title}</h2><Tag>{ticketMark(t, detail.data).label}</Tag><MarkdownLite text={detail.data.attention?.question ?? detail.data.summary} />
          <div className="pw-actions">{detail.data.ended?.by !== 'human' && <Button variant="primary" onClick={() => respond(detail.data!)}>{t(detail.data.attention ? 'workbenchAnswer' : 'ownerDeskRevise')}</Button>}
            {stopButton(detail.data)}
            <Button variant="ghost" onClick={() => props.openManagement(selected)}>{t('homeFullRecord')}</Button></div>
          {detail.data.deliverables?.map(item => <ExternalLink key={item.url} href={item.url}>{item.title}</ExternalLink>)}
        </> : <LoadState error={detail.error} loading />}</section>
      : !data ? <LoadState loading error={error} /> : <>
        <>
          {!!data.person.length && <div className="pw-decisions">{section(t('ownerDeskNeedsYou'), data.person)}</div>}
          <section className="pw-focus"><div className="pw-section-title"><div><div className="pw-kicker">{t('homeFocusKicker')}</div><h2>{t('homeFocus')}</h2></div>
            <Button variant="ghost" size="sm" disabled={focusSending}
              onClick={() => void refresh()} icon={<Icon name="refresh" size={14} />}>{t(focusSending ? 'homeRefreshing' : 'homeRefresh')}</Button></div>
            {refreshing && <p className="pw-muted" role="status">{t('homeRefreshPending')}</p>}
            {focus.error && <LoadState error={focus.error} loading={false} />}
            {focus.data?.focus ? <><p className="pw-focus-headline">{focus.data.focus.headline}</p><p className="pw-muted">{t('homeJudgmentAt')} {when(focus.data.focus.generatedAt, t('lang'))}</p>
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
              : <div className="pw-focus-empty"><Icon name="running" size={24} /><h3>{t(refreshing ? 'homePreparing' : 'homeFocusEmpty')}</h3><p>{t('homeFocusExplanation')}</p></div>}
          </section>
          {!data.person.length && <p className="pw-empty">{t('homeNoDecisions')}</p>}
          <div className="pw-section-title"><h2>{t('homeProgress')}</h2><span>{(data.work?.workingTotal ?? 0) + (data.work?.waitingTotal ?? 0)}</span><button type="button" className="dt-textlink" onClick={() => props.openWorkList('open')}>{t('homeAllWork')}</button></div>
          <div className="pw-task-grid">{active.slice(0, 4).map(card)}</div>
          {section(t('homeResults'), data.work?.delivered.slice(0, 3) ?? [], t('homeNoResults'), data.work?.deliveredTotal, 'ended')}
          <p className="pw-muted">{t('homeResultsHint')}</p>
          <Button size="sm" variant="outline" onClick={() => props.openWorkList('ended')}>{t('homeFullHistory')}</Button>
        </>
        {data.problems.length > 0 && <details className="pw-runtime-note"><summary>{t('homeRuntimeIssues', { count: data.problems.length })}</summary>
          <ProblemList problems={data.problems} onChanged={reload} /></details>}
      </>}
      <footer className="pw-sources"><span>{t('homeSourceCaption')}</span>{sources.data?.filter(source => source.enabled).map(source => <span key={source.id}
        title={source.health.map(item => item.detail).filter(Boolean).join('\n')}><i data-state={source.state} />{localized(t, source.title)}{source.stats.lastAt && <small>{when(source.stats.lastAt, t('lang'))}</small>}</span>)}</footer>
    </main><aside className="pw-collaboration" aria-label={t('homeDiscussion')}><header><div><Icon name="message" size={17} /><strong>{t('homeDiscussion')}</strong></div>
      <Button variant="ghost" size="sm" disabled={!ready} title={ready ? undefined : t('masterNotReady')} onClick={() => { if (state) void props.openSession(state.masterId).catch(error => setFailure(errorText(error))) }}>{t('homeFullConversation')}</Button>
      <Button variant="ghost" size="sm" className="pw-chat-toggle" onClick={() => setChatOpen(false)}>{t('homeBack')}</Button></header>
      <p className="pw-chat-hint">{t('homeSupplementHint')}</p>
      {reply ? <form className="pw-supplement" onSubmit={event => { event.preventDefault(); if (instruction.trim()) void send(`请继续已有工单 ${reply.id}。${reply.attention ? `针对问题 ${reply.attention.id}，本人的答复如下。` : '本人补充或修改要求如下。'}\n\n${instruction.trim()}`) }}>
        <div className="pw-section-title"><h2>{t('workbenchUpdateTarget', { title: reply.title })}</h2>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setReply(undefined); setChatOpen(false) }}>{t('cancel')}</Button></div>
        {reply.attention && <MarkdownLite text={reply.attention.question} />}
        <input autoFocus value={instruction} disabled={busy} maxLength={16000} aria-label={t('workbenchInstruction')}
          placeholder={t('ownerDeskReplyHint')} onChange={event => setInstruction(event.target.value)} />
        <Button type="submit" variant="primary" disabled={busy || !instruction.trim() || !ready} title={ready ? undefined : t('masterNotReady')}>{t('workbenchSendUpdate')}</Button>
      </form> : <p className="pw-supplement-empty">{t('homeSupplementEmpty')}</p>}
    </aside></div>
  </div>
}
