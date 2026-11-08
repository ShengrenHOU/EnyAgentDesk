/** The same required, multiline reply control for the daily, conversation and Ticket views. */
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'

export function ReplyForm({ value, onChange, onSubmit, busy, disabled = false, maxLength = 20000, autoFocus = false }: {
  value: string; onChange(value: string): void; onSubmit(): void; busy: boolean; disabled?: boolean; maxLength?: number; autoFocus?: boolean
}) {
  const { t } = usePanel()
  return <form className="dt-answer" onSubmit={event => { event.preventDefault(); if (value.trim() && !busy && !disabled) onSubmit() }}>
    <textarea autoFocus={autoFocus} value={value} maxLength={maxLength} disabled={busy} aria-label={t('workbenchReplyInstruction')}
      placeholder={t('ownerDeskReplyHint')} onChange={event => onChange(event.target.value)} />
    <div className="dt-answer-actions"><Button type="submit" size="sm" variant="primary" disabled={busy || disabled || !value.trim()}
      title={disabled ? t('masterNotReady') : undefined}>{t(busy ? 'workbenchSubmitting' : 'workbenchSendUpdate')}</Button></div>
  </form>
}
