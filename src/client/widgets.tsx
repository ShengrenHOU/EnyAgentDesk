/** Context-aware shared UI widgets: page/section headers, timestamps, Markdown rendering, and confirmation actions. */
import { Fragment, memo, useEffect, useState, type ReactNode } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { SetupProblem } from '../setup.ts'
import { Button, Icon, InfoTip, Modal, StateDot, type DotState, type IconName } from './controls.tsx'
import { linkify, type Inline } from './markdown.ts'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { settingsRoute, type SettingsGroup } from './route.ts'
import { errorText, fullTime, readableMarkers, setupText, when } from './text.ts'

const external = { target: '_blank', rel: 'noopener noreferrer' } as const
/**
 * GFM tags only; static panel copy is trusted, but a report may quote arbitrary source text.
 * Inline images are excluded: a source-derived `img` would fetch an external URL outside the
 * artifact's no-network CSP, disclosing that the owner opened a private report. Verified files,
 * including images, stay available through the sandboxed artifact preview.
 */
const MARKDOWN_TAGS = ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'hr', 'input']
const MARKDOWN_ATTRIBUTES = ['href', 'title', 'colspan', 'rowspan', 'align', 'type', 'checked', 'disabled']
let sanitizerReady = false
/** Parses GFM (tables, fenced code, task lists) and removes every script, frame, arbitrary form control and style. */
export function markdownHtml(text: string): { __html: string } {
  if (!sanitizerReady) {
    DOMPurify.addHook('afterSanitizeAttributes', node => {
      if (node.tagName === 'A') { node.setAttribute('target', external.target); node.setAttribute('rel', external.rel) }
      // A task list may show its state; every other input is a form control the panel does not accept.
      if (node.tagName === 'INPUT') {
        if (node.getAttribute('type') === 'checkbox') node.setAttribute('disabled', '')
        else node.remove()
      }
    })
    sanitizerReady = true
  }
  const html = marked.parse(text, { async: false, gfm: true }) as string
  return { __html: DOMPurify.sanitize(html, { ALLOWED_TAGS: MARKDOWN_TAGS, ALLOWED_ATTR: MARKDOWN_ATTRIBUTES,
    FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'link', 'meta'],
    FORBID_ATTR: ['style'] }) }
}

export function When({ at }: { at: string | undefined }) {
  const { t } = usePanel()
  return <time dateTime={at} title={fullTime(at, t('lang'))}>{when(at, t('lang'))}</time>
}
export function SetupMessage({ problem, lead }: { problem: Pick<SetupProblem, 'code' | 'values'>; lead?: boolean }) {
  const { t } = usePanel()
  const text = setupText(t, problem)
  return <>
    {lead ? t('setupProblem', { detail: text }) : text}
    {problem.values.output && <span className="dt-detail dt-mono dt-clamp">{problem.values.output}</span>}
  </>
}
export function Section({ title, count, children, action, hint, badge, icon }: {
  title: string; count?: number | string; children: ReactNode; action?: ReactNode; hint?: string; badge?: ReactNode; icon?: IconName
}) {
  return <section className="dt-section">
    <h2 className="dt-section-title">
      {icon && <span className="dt-section-icon"><Icon name={icon} size={14} /></span>}<span className="dt-section-name">{title}</span>
      {count !== undefined && <span className="dt-count">{count}</span>}{hint && <InfoTip text={hint} />}{badge}
      {action && <span style={{ marginLeft: 'auto' }}>{action}</span>}
    </h2>
    {children}
  </section>
}
export function Hint({ children }: { children: ReactNode }) { return <p className="dt-hint">{children}</p> }
export function RefreshFailure({ error, updatedAt, retry }: { error: Error; updatedAt?: number; retry(): Promise<void> }) {
  const { t } = usePanel()
  return <div className="pw-stale" role="status">
    <div><p>{updatedAt === undefined ? errorText(error) : t('detailStaleNotice', { at: fullTime(new Date(updatedAt).toISOString(), t('lang')) })}</p>
      {updatedAt !== undefined && <p className="pw-muted">{errorText(error)}</p>}</div>
    <Button size="sm" variant="outline" onClick={() => void retry()}>{t('retry')}</Button>
  </div>
}
export function LabelValue({ label, value }: { label: string; value: ReactNode }) {
  return <span className="dt-lv"><span className="dt-lv-label">{label}</span> <span className="dt-lv-value">{value}</span></span>
}
export function KeyValues({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="dt-kv">{rows.map(([key, value], index) => <div key={index}
    style={{ display: 'contents' }}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
}

function Inlines({ parts }: { parts: Inline[] }) {
  return <>{parts.map((part, index) => part.kind === 'link'
    ? <a key={index} className="dt-inline-link" href={part.url} title={part.url} {...external}>{part.text}</a>
    : <Fragment key={index}>{part.text}</Fragment>)}</>
}
/** Renders report and question Markdown with GFM tables and fenced code; raw HTML is sanitized instead of trusted. */
export const MarkdownLite = memo(function MarkdownLite({ text }: { text: string }) {
  const { t } = usePanel()
  return <div className="dt-md" dangerouslySetInnerHTML={markdownHtml(readableMarkers(t, text))} />
})
const MARKDOWN_FILE = /\.(?:md|markdown|mdown|mkd)$/i
const MAX_MARKDOWN_PREVIEW = 2 * 1024 * 1024
/** Whether an artifact URL names a Markdown file, judged by the published path rather than its display title. */
export function isMarkdownArtifact(url: string): boolean {
  // Artifact links are same-origin relative addresses; the placeholder base only lets the parser read `path`.
  try { return MARKDOWN_FILE.test(new URL(url, 'http://localhost').searchParams.get('path') ?? '') } catch { return false }
}
/**
 * Shows one verified workbench artifact: Markdown through the panel's GFM renderer, every other type in the sandboxed frame.
 * The Markdown bytes travel on the same authenticated owner request that already serves the published file.
 */
export function ArtifactPreview({ title, url }: { title: string; url: string }) {
  const { t } = usePanel()
  const markdown = isMarkdownArtifact(url)
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'ready'; text: string }>(
    { kind: 'loading' })
  useEffect(() => {
    if (!markdown) return
    const abort = new AbortController()
    setState({ kind: 'loading' })
    void fetch(url, { credentials: 'same-origin', signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error(t('markdownPreviewFailed', { detail: `HTTP ${response.status}` }))
      const text = await response.text()
      if (text.length > MAX_MARKDOWN_PREVIEW) throw new Error(t('markdownPreviewFailed', { detail: t('markdownTooLarge') }))
      setState({ kind: 'ready', text })
    }).catch(error => { if (!abort.signal.aborted) setState({ kind: 'failed', message: errorText(error) }) })
    return () => abort.abort()
  }, [markdown, t, url])
  // The frame stays for images, PDFs and other verified files whose own viewer belongs to the browser.
  if (!markdown) return <iframe title={title} src={url} sandbox="" />
  return <div className="dt-artifact-preview">
    {state.kind === 'loading' && <p className="dt-hint" role="status">{t('markdownLoading')}</p>}
    {state.kind === 'failed' && <p className="dt-error" role="alert">{state.message}{' '}
      <ExternalLink href={url}>{t('openOriginal')}</ExternalLink></p>}
    {state.kind === 'ready' && <div className="dt-md dt-artifact-md" dangerouslySetInnerHTML={markdownHtml(state.text)} />}
  </div>
}
function MoreToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = usePanel()
  return <button type="button" className="dt-textlink dt-more" aria-expanded={open} onClick={onToggle}>{open ? t('collapse')
    : t('expand')}</button>
}
export function ClampText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 480 || text.split('\n').length > 8
  return <>
    <div className={long && !open ? 'dt-event-text dt-clamp-8' : 'dt-event-text'}><Inlines parts={linkify(text)} /></div>
    {long && <MoreToggle open={open} onToggle={() => setOpen(!open)} />}
  </>
}

export function ConfirmButton({ label, title, message, onConfirm, variant = 'ghost', icon }: {
  label: string; title: string; message: string; onConfirm: () => Promise<unknown>; variant?: 'ghost' | 'outline'; icon?: IconName
}) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const confirm = useAction(onConfirm)
  // Once the action is sent, closing the dialog would only hide work that still runs. Keep every exit path open until it settles.
  const close = () => { if (!confirm.busy) setOpen(false) }
  return <>
    <Button variant={variant} size="sm" icon={icon && <Icon name={icon} size={14} />} onClick={() => setOpen(true)}>{label}</Button>
    <Modal open={open} onClose={close} title={title} closeLabel={t('close')} description={message}
      footer={<>
        <Button variant="ghost" disabled={confirm.busy} onClick={close}>{t('cancel')}</Button>
        <Button variant="primary" disabled={confirm.busy}
          onClick={() => { void confirm.run().then(done => { if (done) setOpen(false) }) }}>
          {t(confirm.busy ? 'confirming' : 'confirm')}</Button>
      </>} />
  </>
}
/**
 * Ends a Ticket as stopped, with an optional reason. The confirmation says what closing does and that pausing is not
 * closing, so a failed or blocked Ticket can leave the owner-facing panel without losing its history and results.
 */
export function CloseTicketButton({ ticket, onStopped }: {
  ticket: { id: string; title: string }; onStopped?: () => Promise<unknown> | void
}) {
  const { t, call } = usePanel()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const close = () => { if (!busy) { setOpen(false); setFailure(undefined) } }
  const stop = async () => {
    if (busy) return
    setBusy(true); setFailure(undefined)
    try {
      await call('POST tickets/:id/stop', { id: ticket.id, body: { reason: reason.trim() || undefined } })
      setOpen(false); setReason('')
      await onStopped?.()
    } catch (error) { setFailure(errorText(error)) }
    finally { setBusy(false) }
  }
  return <>
    <Button variant="outline" size="sm" icon={<Icon name="stop" size={14} />} onClick={() => setOpen(true)}>
      {t('closeTicket')}</Button>
    <Modal open={open} onClose={close} title={t('closeTicketTitle', { title: ticket.title })} closeLabel={t('close')}
      description={t('closeTicketDescription')}
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={close}>{t('cancel')}</Button>
        <Button variant="primary" disabled={busy} onClick={() => void stop()}>{t(busy ? 'confirming' : 'closeTicketConfirm')}</Button>
      </>}>
      <label className="dt-field">{t('closeTicketReason')}
        <textarea className="dt-textarea" maxLength={500} value={reason} disabled={busy} aria-label={t('closeTicketReason')}
          placeholder={t('closeTicketReasonHint')} onChange={event => setReason(event.target.value)} />
      </label>
      {failure && <p role="alert" className="dt-error">{failure}</p>}
    </Modal>
  </>
}
export function SessionButton({ sessionId, label,
  variant = 'ghost' }: { sessionId: string; label?: string; variant?: 'ghost' | 'outline' }) {
  const { t, openSession, notify } = usePanel()
  return <Button variant={variant} size="sm" icon={<Icon name="session" size={14} />}
    onClick={() => { openSession(sessionId).catch(error => notify(errorText(error))) }}>{label ?? t('openSession')}</Button>
}
export function ExternalLink({ href, children, icon = 'external' }: { href: string; children: ReactNode; icon?: IconName }) {
  return <a className="dt-inline-link dt-icon-link" href={href} {...external}><Icon name={icon} size={13} />{children}</a>
}
export function ActionLink({ href, children, icon = 'external' }: { href: string; children: ReactNode; icon?: IconName }) {
  return <a className="dt-btn dt-btn-outline dt-btn-sm" href={href} {...external}><span className="dt-btn-icon"><Icon name={icon}
    size={14} /></span>{children}</a>
}
export function StageMark({ state, icon, label }: { state: DotState; icon: IconName; label: string }) {
  return <span className="dt-stage" data-state={state}>{state === 'ongoing' ? <StateDot state="ongoing" /> : <Icon name={icon}
    size={14} />}{label}</span>
}
export function LoadState({ error, loading }: { error?: Error | undefined; loading: boolean }) {
  const { t } = usePanel()
  if (error) return <p className="dt-error" role="alert">{error.message}</p>
  return loading ? <Hint>{t('loading')}</Hint> : null
}
export function LoadMore({ onMore }: { onMore: () => void }) {
  const { t } = usePanel()
  return <Button variant="outline" size="sm" icon={<Icon name="chevron-down" size={14} />} onClick={onMore}>{t('loadMore')}</Button>
}

export function StatusHead({ hint, settings }: { hint: string; settings?: SettingsGroup }) {
  const { t, navigate } = usePanel()
  return <div className="dt-status-head">
    <h2 className="dt-status-title">{t('statusTitle')}<InfoTip text={hint} /></h2>
    {settings && <Button variant="ghost" size="sm" icon={<Icon name="settings" />}
      onClick={() => navigate(settingsRoute(settings))}>{t('tab.settings')}</Button>}
  </div>
}
export function PageHead({ title, children }: { title: ReactNode; children?: ReactNode }) {
  const { back, backLabel } = usePanel()
  return <div className="dt-page-head">
    <Button variant="ghost" size="sm" icon={<Icon name="chevron-left" />} onClick={back}>{backLabel}</Button>
    <div className="dt-page-title"><h2>{title}</h2>{children && <span className="dt-actions">{children}</span>}</div>
  </div>
}
/** Trigger a host setup re-check and restart, prompting for confirmation when running Assignments would be interrupted. */
export function CheckSetupButton() {
  const { t, call, notify, restart } = usePanel()
  const { running } = usePanelData()
  const check = async () => { await call('POST setup/check'); notify(t('setupChecking')); restart() }
  const action = useAction(check)
  if (running > 0) {
    const message = t('setupCheckInterrupts', { count: running })
    return <ConfirmButton variant="outline" icon="refresh" label={t('setupCheck')} title={t('setupCheck')} message={message}
      onConfirm={check} />
  }
  const icon = <Icon name="refresh" size={14} />
  return <Button variant="outline" size="sm" icon={icon} disabled={action.busy}
    onClick={() => { void action.run() }}>{t('setupCheck')}</Button>
}
