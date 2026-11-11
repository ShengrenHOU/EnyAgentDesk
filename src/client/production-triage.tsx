/** Read-only grouped information judgments. Coverage is audit detail, not a new per-message task queue. */
import { useEffect, useState } from 'react'
import type { productionOverview } from '../app/production-triage.ts'
import type { T } from './text.ts'
type View = ReturnType<typeof productionOverview>
export function ProductionJudgments({ view, t, loadPage }: { view: View; t: T; loadPage?: (before: number) => Promise<View> }) {
  const [before, setBefore] = useState<number>()
  const [loaded, setLoaded] = useState<{ base: View; before: number; page: View }>()
  const [error, setError] = useState('')
  const current = before !== undefined && loaded?.base === view && loaded.before === before ? loaded.page : undefined
  // Poll the selected page again on overview refresh; hide cached source content until revalidated.
  useEffect(() => {
    if (before === undefined || !loadPage) return
    let cancelled = false
    setError('')
    void loadPage(before).then(page => { if (!cancelled) setLoaded({ base: view, before, page }) },
      error => { if (!cancelled) setError(String(error)) })
    return () => { cancelled = true }
  }, [view, before])
  const busy = before !== undefined && !current
  const shown = before === undefined ? view : current ?? { ...view, groups: [], nextBefore: null }
  if (!shown.groups.length && !shown.total) return null
  const zh = t('lang').startsWith('zh')
  const label = (en: string, cn: string) => zh ? cn : en
  return <section className="pw-section" aria-label={label('IM judgments', 'IM 分诊')}>
    <h2>{label('IM information judgments', 'IM 信息分诊')}</h2>
    <p className="pw-muted">{label('Bounded judgments, not resolved obligations. Suggested actions are for review only; unknowns await another read. No automatic work or replies.', '仅完成有界判断，不代表事项已解决。建议行动仅供复核，未知项待补读，不自动派工或回复。')}</p>
    <p>{label('All receipt groups', '全部回执组')}: {shown.total} · {label('Unresolved information / review', '待判断／复核')}: {shown.unresolved.messages} ({shown.unresolved.groups} {label('groups', '组')})</p>
    <p className="pw-muted">{Object.entries(shown.unresolved).filter(([key]) => ['queued', 'preparing', 'awaiting', 'blocked', 'unknown', 'suggested_action'].includes(key)).map(([key, value]) => `${key}: ${value}`).join(' · ')}
      {shown.unresolved.oldestAt && <> · {label('Oldest unresolved evidence', '最早待处理证据')}: {shown.unresolved.oldestAt}</>}</p>
    {shown.groups.map(group => <details key={group.id} className="pw-queue-fold">
      <summary>{group.conversation} · {group.messages} {label('messages', '条消息')} · {group.state}
        {' · '}{label('Information', '信息')} {group.counts.informational ?? 0}
        {' · '}{label('Suggested actions', '建议行动')} {group.counts.suggested_action ?? 0}
        {' · '}{label('Unknown', '未知')} {group.counts.unknown ?? 0}</summary>
      {group.newerKnownEvidence && <p>{label('Newer evidence is known; this receipt has not been rejudged.', '已有更新证据，此回执尚未重新判断。')}</p>}
      {group.redacted && <p>{label('Source permission or configuration changed; content is hidden.', '来源权限或配置已变更，内容已隐藏。')}</p>}
      {group.historical && <p>{label('Historical receipt, not a current pending item.', '历史回执，不是当前待处理项。')}</p>}
      <p>{group.window.start} – {group.window.end}</p>
      <p className="pw-muted">{label('Receipt', '回执')}: {group.id} · {label('Attempt', '轮次')} {group.generation} · {group.at}</p>
      {group.problem && <p role="status">{group.problem}</p>}
      <ul>{group.matters.map(matter => <li key={matter.id}><strong>{matter.title}</strong><p>{matter.reason}</p></li>)}</ul>
      <details><summary>{label('Per-message audit', '逐消息审计')}</summary><ul>{group.items.map(item => <li key={item.triggerId}>
        {item.triggerId} · {item.kind ?? group.state}<p>{item.reason}</p>
        <p>{item.gaps.join(', ')}</p><small>{item.contextHash}</small>
      </li>)}</ul></details>
    </details>)}
    {shown.nextBefore !== null && loadPage && <button type="button" disabled={busy} onClick={() => setBefore(shown.nextBefore!)}>{label('Older receipts', '更早回执')}</button>}
    {before !== undefined && <button type="button" onClick={() => { setBefore(undefined); setError('') }}>{label('Latest receipts', '最新回执')}</button>}
    {busy && !error && <p role="status">{label('Refreshing receipts…', '正在刷新回执…')}</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}
