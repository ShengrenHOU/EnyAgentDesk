/** One browser-owned subscription invalidates mounted views and survives Connection reconnects through EventSource. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection/client'
export const VIEW_CHANGE = 'superagent:view-change'
let enabled = false
export const viewEventsEnabled = () => enabled

export function startViewEvents(ctx: Pick<Context, 'on'>): () => void {
  let source: EventSource | undefined, timer: ReturnType<typeof setTimeout> | undefined, delay = 1000, stopped = false
  enabled = true
  const changed = () => document.dispatchEvent(new Event(VIEW_CHANGE))
  const connect = () => {
    clearTimeout(timer); source?.close()
    const current = source = new EventSource('/api/superagent/changes')
    current.addEventListener('open', () => { if (!stopped && source === current) { delay = 1000; changed() } })
    current.addEventListener('change', () => { if (!stopped && source === current) changed() })
    current.addEventListener('error', () => {
      if (stopped || source !== current) return
      changed()
      // A startup 404 closes EventSource permanently; normal network retries remain browser-owned.
      if (current.readyState === EventSource.CLOSED) {
        clearTimeout(timer); timer = setTimeout(connect, delay); delay = Math.min(delay * 2, 30_000)
      }
    })
  }
  connect()
  const reset = ctx.on('connection/reset', connect)
  return () => { stopped = true; reset(); clearTimeout(timer); source?.close(); enabled = false }
}
