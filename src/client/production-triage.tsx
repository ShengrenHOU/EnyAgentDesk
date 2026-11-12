/** Read-only grouped information judgments. Coverage is audit detail, not a new per-message task queue. */
import { useState } from 'react'
import type { productionOverview } from '../app/production-triage.ts'
import { useHistoryPage } from './api.ts'
import type { T } from './text.ts'
type View = ReturnType<typeof productionOverview>
export function ProductionJudgments({ view, t, loadPage, onDiscuss, discussionDisabled = false }: {
  view: View; t: T; loadPage?: (before: number, unresolved?: boolean) => Promise<View>
  onDiscuss?: (id: string, generation: number) => void; discussionDisabled?: boolean
}) {
  const [before, setBefore] = useState<number>()
  const [unresolved, setUnresolved] = useState(false)
  // The selected page refreshes on its own cursor-scoped schedule; latest overview changes no longer gate its freshness.
  const { page, error, reload } = useHistoryPage(before, loadPage && (cursor => unresolved ? loadPage(cursor, true) : loadPage(cursor)))
  const busy = before !== undefined && !page && !error
  const shown = before === undefined ? view : page ?? { ...view, groups: [], nextBefore: null }
  if (!view.total && !unresolved) return null
  const zh = t('lang').startsWith('zh')
  const label = (en: string, cn: string) => zh ? cn : en
  const stateLabels: Record<string, string> = { queued: label('Queued', '等待判断'), preparing: label('Reading context', '补充上下文'),
    awaiting: label('Awaiting judgment', '正在判断'), blocked: label('Needs follow-up', '处理受阻'),
    completed: label('Judgment recorded', '已记录判断'), rolled_back: label('Returned', '已退回'),
    unknown: label('Needs more information', '待补充信息'), suggested_action: label('Suggested follow-up', '建议跟进'),
    informational: label('Reference information', '参考信息'), none: label('Recorded', '已记录') }
  const stateLabel = (state: string) => stateLabels[state] ?? state
  return <section className="pw-section" aria-label={label('IM judgments', 'IM 分诊')}>
    <h2>{label('Information follow-up', '信息跟进')}</h2>
    <p className="pw-muted">{label('Review unfinished judgments and suggested follow-ups, then discuss their next step in the main conversation.', '查看尚待判断、补充或复核的信息，可沿原记录到主对话讨论下一步。')}</p>
    {loadPage && <div className="pw-actions">
      <button type="button" className="dt-textlink" aria-pressed={unresolved} onClick={() => { setUnresolved(true); setBefore(Number.MAX_SAFE_INTEGER) }}>
        {label('Unresolved information', '查看待处理信息')}</button>
      {unresolved && <button type="button" className="dt-textlink" onClick={() => { setUnresolved(false); setBefore(undefined) }}>{label('Latest receipts', '最新回执')}</button>}
    </div>}
    <p>{unresolved ? label('Unresolved groups', '待处理记录组') : label('All receipt groups', '全部回执组')} {shown.total} · {label('Unresolved information / review', '待判断／复核')} {shown.unresolved.messages} ({shown.unresolved.groups} {label('groups', '组')})</p>
    <p className="pw-muted">{Object.entries(shown.unresolved).filter(([key]) => ['queued', 'preparing', 'awaiting', 'blocked', 'unknown', 'suggested_action'].includes(key)).map(([key, value]) => `${stateLabel(key)} ${value}`).join(' · ')}
      {shown.unresolved.oldestAt && <> · {label('Oldest unresolved evidence', '最早待处理证据')}: {shown.unresolved.oldestAt}</>}</p>
    {shown.groups.map(group => <details key={group.id} className="pw-queue-fold">
      <summary>{group.redacted ? label('Content hidden', '内容已隐藏') : group.header?.conversationLabel || group.conversation} · {group.messages} {label('messages', '条消息')} · {stateLabel(group.state)}
        {' · '}{label('Information', '信息')} {group.counts.informational ?? 0}
        {' · '}{label('Suggested actions', '建议行动')} {group.counts.suggested_action ?? 0}
        {' · '}{label('Unknown', '未知')} {group.counts.unknown ?? 0}</summary>
      {group.newerKnownEvidence && <p>{label('Newer evidence is known; this receipt has not been rejudged.', '已有更新证据，此回执尚未重新判断。')}</p>}
      {group.redacted && <p>{label('Source permission or configuration changed; content is hidden.', '来源权限或配置已变更，内容已隐藏。')}</p>}
      {group.historical && <p>{label('Historical receipt, not a current pending item.', '历史回执，不是当前待处理项。')}</p>}
      <p>{group.window.start} – {group.window.end}</p>
      <p className="pw-muted">{label('Receipt', '回执')}: {group.id} · {label('Attempt', '轮次')} {group.generation} · {group.at}</p>
      {!group.redacted && <>
        {group.problem && <p role="status">{group.problem}</p>}
        {onDiscuss && !group.historical && <button type="button" className="dt-textlink" disabled={discussionDisabled}
          onClick={() => onDiscuss(group.id, group.generation)}>{label('Discuss in main conversation', '到主对话讨论')}</button>}
        <ul>{group.matters.map(matter => <li key={matter.id}><strong>{matter.title}</strong><p>{matter.reason}</p></li>)}</ul>
        <details><summary>{label('Per-message audit', '逐消息审计')}</summary><ul>{group.items.map(item => <li key={item.triggerId}>
          {item.provider} · {item.header?.senderLabel || item.sender || label('Unidentified sender', '发送者未识别')} · {item.direction} · {item.header?.at}
          <small>{item.triggerId} · {stateLabel(item.kind ?? group.state)}</small><p>{item.reason}</p>
          <p>{item.gaps.join(', ')}</p><small>{item.contextHash}</small>
        </li>)}</ul></details>
      </>}
    </details>)}
    {shown.nextBefore !== null && loadPage && <button type="button" disabled={busy} onClick={() => setBefore(shown.nextBefore!)}>{label('Older receipts', '更早回执')}</button>}
    {before !== undefined && !unresolved && <button type="button" onClick={() => setBefore(undefined)}>{label('Latest receipts', '最新回执')}</button>}
    {unresolved && page && !page.groups.length && <p role="status">{label('No unresolved information', '当前没有待处理信息')}</p>}
    {busy && !error && <p role="status">{label('Refreshing receipts…', '正在刷新回执…')}</p>}
    {error && <><p role="alert">{label('Receipts could not be refreshed; the selected page stays hidden until it is verified again.', '回执刷新失败，重新核验前不展示所选页面。')} {error}</p>
      <button type="button" onClick={() => void reload()}>{label('Retry receipts', '重试回执')}</button></>}
  </section>
}
