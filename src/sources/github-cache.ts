/**
 * Short-lived reuse of read-only GitHub check and review reads, keyed by repository, pull request and head.
 *
 * This cache only saves repeated inspection work within one model turn. It is never a source of truth for a merge, an
 * authorization decision or any other write: those re-read the current head with `gh` and the comment above `cachedRead`
 * states the same boundary in every result it serves. A changed head or a new repository is a different key, and an entry
 * expires after `GITHUB_READ_TTL_MS`, so a stale answer cannot outlive one short turn.
 */

/** How long a read-only check or review result may be reused. */
export const GITHUB_READ_TTL_MS = 60_000
/** Bound the map so a long-lived runtime cannot grow it without limit. */
const MAX_ENTRIES = 256
interface Entry { at: number; value: unknown }
const entries = new Map<string, Entry>()

export interface CachedRead<T> { value: T; cached: boolean; ageSeconds: number }

/** Note attached to every cached read result, so a model cannot mistake reuse for a final, pre-write check. */
export const CACHE_NOTE = 'Read-only reuse for one short turn; it never replaces the real-time check with gh before a merge, '
  + 'authorization or any other write.'

/**
 * Returns `run`'s value, reused from an entry younger than `ttlMs`. The entry is stored only after a successful read, and a
 * failing read leaves no entry behind.
 */
export async function cachedRead<T>(key: string, ttlMs: number, run: () => Promise<T>): Promise<CachedRead<T>> {
  const at = Date.now()
  const hit = entries.get(key)
  if (hit && at - hit.at < ttlMs) return { value: hit.value as T, cached: true, ageSeconds: Math.floor((at - hit.at) / 1000) }
  const value = await run()
  entries.delete(key)
  entries.set(key, { at: Date.now(), value })
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
  return { value, cached: false, ageSeconds: 0 }
}

/** Drop every entry; used by tests and after a source configuration change. */
export function clearGithubReadCache(): void { entries.clear() }
