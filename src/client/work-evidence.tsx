/** On-demand source receipts for existing work, with bounded polling while expanded. */
import { useState } from 'react'
import { usePoll } from './api.ts'
import type { ApiResponse } from '../app/api.ts'
import type { T } from './text.ts'
import { Button } from './controls.tsx'
import { ExternalLink, When } from './widgets.tsx'

type Page = ApiResponse<'GET tickets/:id/evidence'>
interface Props { t: T; load: (before?: number) => Promise<Page> }
function EvidencePage({ t, load }: Props) {
  const [before, setBefore] = useState<number>()
  const { data, error, reload } = usePoll(async () => ({ before, page: await load(before) }), [before], 30_000)
  const page = data?.before === before ? data?.page : undefined
  const zh = t('lang').startsWith('zh'), label = (en: string, cn: string) => zh ? cn : en
  return <>
    <Button size="sm" variant="ghost" onClick={() => { void reload() }}>{label('Refresh', '刷新')}</Button>
    {error ? <p role="alert">{label('Evidence could not be refreshed.', '来源信息暂时无法刷新。')}</p>
      : !page ? <p role="status">{label('Loading evidence…', '正在读取来源信息…')}</p>
      : <>
        {!page.items.length && <p>{label('No source receipts are linked yet.', '暂未关联来源记录。')}</p>}
        <ul className="pw-plain-list">{page.items.map(item => <li key={item.reference}>
          {item.redacted ? <p>{label('Source access changed; content is hidden.', '来源权限已变更，内容已隐藏。')}</p> : <>
            <strong>{item.title}</strong>
            <p className="pw-muted">{item.provider === 'wechat' ? label('WeChat', '微信') : item.provider === 'feishu-messages' ? label('Feishu', '飞书') : item.provider}
              {item.header?.conversationLabel && <> · {item.header.conversationLabel}</>}
              {' · '}<When at={item.header?.at} /></p>
            {item.excerpt && <blockquote>{item.excerpt}</blockquote>}
            {item.partial && <p className="pw-muted">{label('Includes unread or truncated content.', '含未读取或截断内容。')}</p>}
            {item.url && <ExternalLink href={item.url}>{label('Open source message', '打开原消息')}</ExternalLink>}
          </>}
        </li>)}</ul>
        {page.next_offset !== null && <Button size="sm" onClick={() => setBefore(page.next_offset!)}>{label('Older evidence', '更早记录')}</Button>}
      </>}
    {before !== undefined && <Button size="sm" variant="ghost" onClick={() => setBefore(undefined)}>{label('Latest evidence', '最新记录')}</Button>}
  </>
}
export function WorkEvidence(props: Props) {
  const [open, setOpen] = useState(false)
  return <details className="pw-queue-fold" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{props.t('lang').startsWith('zh') ? '来源信息' : 'Source evidence'}</summary>
    {open && <EvidencePage {...props} />}
  </details>
}
