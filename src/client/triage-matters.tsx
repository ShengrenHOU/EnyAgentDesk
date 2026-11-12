/** Cross-receipt model suggestions are a read-only projection, never business obligation state. */
import { useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { useHistoryPage } from './api.ts'
import type { T } from './text.ts'
type View = ApiResponse<'GET triage-matters'>
export function CanonicalMatters({ view, t, loadPage, openWork }: { view: View; t: T; loadPage?: (before: number) => Promise<View>;
  openWork?: (kind: 'ticket' | 'line', id: string) => void }) {
  const [before, setBefore] = useState<number>()
  // The selected page refreshes on its own cursor-scoped schedule; latest overview changes no longer gate its freshness.
  const { page, error, reload } = useHistoryPage(before, loadPage)
  const busy = before !== undefined && !page && !error
  const shown = before === undefined ? view : page ?? { ...view, groups: [], nextBefore: null }
  if (!shown.groups.length && !shown.total && before === undefined) return null
  const zh = t('lang').startsWith('zh')
  const label = (en: string, cn: string) => zh ? cn : en
  return <section className="pw-section" aria-label={label('Canonical IM matters', '跨回执 IM 事项')}>
    <h2>{label('Information and work', '信息与事项')}</h2>
    <p className="pw-muted">{label('Evidence retains its sources and gaps. Linked work follows the existing Ticket authorization.', '线索保留来源与缺口，关联后的推进沿用原工单授权。')}</p>
    <p>{label('All canonical groups', '全部归一事项组')}: {shown.total}
      {shown.oldestAt && <> · {label('Oldest recorded group', '最早记录组')}: {shown.oldestAt}</>}</p>
    <p>{label('Active suggestions awaiting review', '待复核的模型建议组')}: {shown.unresolved.total}
      {shown.unresolved.oldestAt && <> · {label('Oldest awaiting review', '最早待复核记录')}: {shown.unresolved.oldestAt}</>}</p>
    {shown.groups.map(group => <details key={group.id} className="pw-queue-fold">
      <summary>{group.redacted ? label('Content hidden', '内容已隐藏') : group.title}
        {' · '}{label('Receipt members', '回执成员')}: {group.memberCount}</summary>
      <p className="pw-muted">{label('Matter', '事项')}: {group.id} · {label('Revision', '修订')}: {group.revision} · {group.updatedAt}</p>
      {group.redacted ? <p>{label('Source permission or configuration changed; all source content is hidden.', '来源权限或配置已变更，全部来源内容已隐藏。')}</p> : <>
        <p>{group.conversation}</p><p>{group.reason}</p>
        {group.handoff && <p>{label('Linked work', '关联事项')}{' '}
          {openWork ? <button type="button" className="pw-title-button" onClick={() => openWork(group.handoff!.kind, group.handoff!.id)}>
            {group.handoff.title ?? label('View linked work', '查看关联事项')}</button>
            : <span>{group.handoff.title ?? label('Linked work recorded', '已记录关联事项')}</span>}
          {group.handoff.inputId && <small> · {label('Saved in Ticket context', '已保存到工单上下文')}</small>}
        </p>}
        <p>{label('Model assessment', '模型判断')}: {group.assessment}</p>
        {group.assessment === 'no_further_action_suggested' && <p>{label('Model no longer suggests action based on these citations. This covers bounded observed evidence only, not owner confirmation, cancellation, completion or resolution of an obligation.', '模型据这些引用不再建议行动。仅涵盖已观察的有界证据，不代表本人确认、取消、完成或解除义务。')}</p>}
        {group.related && <p>{label('Related matter', '相关事项')}: {group.related}</p>}
        <details><summary>{label('Receipt membership audit', '回执成员审计')}</summary><ul>{group.members.map(member => <li key={member.id}>
          {member.batchId} · {label('Attempt', '轮次')} {member.generation} · {member.localMatterId}
          {member.local && <><strong>{member.local.title}</strong><p>{member.local.reason}</p></>}
          {member.contexts.map(context => <div key={context.triggerId}>
            <p>{label('Context evidence', '上下文证据')}: {context.triggerId} · {label('Revision', '修订')}: {context.revision ?? label('Unknown', '未知')}</p>
            {context.hash && <small>{context.hash}</small>}
            <p>{label('Anchor status', '锚点状态')}: {context.anchorStatus ?? label('Unknown', '未知')}
              {' · '}{label('Version basis', '版本依据')}: {context.versionBasis ?? label('Unknown', '未知')}</p>
            <p>{context.nativeVersion ? `${label('Native version', '原生版本')}: ${context.nativeVersion}`
              : label('Native version unavailable; source edit/version ordering is uncertain.', '缺少原生版本，来源编辑及版本先后关系不确定。')}</p>
            <p>{label('Context gaps', '上下文缺口')}: {context.gaps.length ? context.gaps.join(', ') : label('None recorded; completeness is not established.', '未记录缺口，不代表已完整。')}</p>
            <p>{label('Context is bounded and not established as complete.', '上下文有界，尚未确认为完整。')}</p>
          </div>)}
        </li>)}</ul>{group.membersLimited && <p>{label('Only the first 25 memberships are shown.', '仅展示前 25 个回执成员。')}</p>}</details>
      </>}
      {group.stale && <p role="status">{label('Evidence may have changed or was not reconciled. This suggestion is not verified as current.', '证据可能已变化或尚未核对，不能视为当前有效建议。')}</p>}
      <p className="pw-muted">{label('Read-only evidence does not identify the owner or confer authority. Sender identity and authority are not established; no business obligation resolved.', '只读证据不能确认责任人或赋予权限。发送者身份及权限未经确认，不代表业务义务已解决。')}</p>
    </details>)}
    {shown.nextBefore !== null && loadPage && <button type="button" disabled={busy} onClick={() => setBefore(shown.nextBefore!)}>{label('Older matters', '更早事项')}</button>}
    {before !== undefined && <button type="button" onClick={() => setBefore(undefined)}>{label('Latest matters', '最新事项')}</button>}
    {busy && !error && <p role="status">{label('Refreshing matters…', '正在刷新事项…')}</p>}
    {error && <><p role="alert">{label('Matters could not be refreshed; the selected page stays hidden until it is verified again.', '事项刷新失败，重新核验前不展示所选页面。')} {error}</p>
      <button type="button" onClick={() => void reload()}>{label('Retry matters', '重试事项')}</button></>}
  </section>
}
