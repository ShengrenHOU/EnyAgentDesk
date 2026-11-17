/** Owner-visible invalidation stream carried by DSH's authenticated Fetch registry. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'

interface Viewer {
  controller: ReadableStreamDefaultController<Uint8Array>
  signal: AbortSignal
  abort(): void
  dirty: boolean
}
/** Coalesces slow readers to the latest revision; reconnect always begins with a fresh invalidation. */
export class ViewEvents {
  private readonly epoch = randomUUID()
  private revision = 0
  private readonly viewers = new Set<Viewer>()
  private readonly encoder = new TextEncoder()
  private closed = false
  private scheduled = false

  publish(): void {
    if (this.closed) return
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.closed) return
      this.revision++
      for (const viewer of this.viewers) { viewer.dirty = true; this.flush(viewer) }
    })
  }
  response(signal: AbortSignal): Response {
    if (this.closed) return new Response(null, { status: 503 })
    let viewer: Viewer
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        viewer = { controller, signal, dirty: true, abort: () => {
          this.remove(viewer)
          controller.close()
        } }
        this.viewers.add(viewer)
        signal.addEventListener('abort', viewer.abort, { once: true })
        if (signal.aborted) viewer.abort()
        else this.flush(viewer)
      },
      pull: () => { this.flush(viewer) },
      cancel: () => { this.remove(viewer) },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
  }
  private flush(viewer: Viewer): void {
    if (!viewer.dirty || (viewer.controller.desiredSize ?? 0) <= 0) return
    viewer.dirty = false
    viewer.controller.enqueue(this.encoder.encode(`event: change\ndata: ${JSON.stringify({ epoch: this.epoch, revision: this.revision })}\n\n`))
  }
  private remove(viewer: Viewer): void {
    this.viewers.delete(viewer)
    viewer.signal.removeEventListener('abort', viewer.abort)
  }
  close(): void {
    this.closed = true
    for (const viewer of [...this.viewers]) viewer.abort()
  }
}

/** DSH applies owner authentication and transport trust before this exact route is reached. */
export function registerViewEvents(ctx: Context, events: ViewEvents): () => Promise<void> {
  const fiber = ctx.inject(['connection'], child => {
    child.effect(() => child.connection.fetch.register({ path: '/api/superagent/changes', methods: ['GET'], requestBody: 'buffered',
      fetch: async request => events.response(request.signal) }))
  })
  return async () => { events.close(); await fiber.dispose() }
}
