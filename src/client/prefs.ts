/** Browser-local display preferences that survive reloads. */
import { useState } from 'react'

/** A remembered on/off choice; an unavailable store keeps the choice for this page only. */
export function useStoredFlag(key: string, fallback: boolean): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(() => {
    try { const stored = localStorage.getItem(key); return stored === null ? fallback : stored === 'true' }
    catch { return fallback }
  })
  return [value, (next: boolean) => {
    setValue(next)
    try { localStorage.setItem(key, String(next)) } catch { /* A display preference is a convenience. */ }
  }]
}
