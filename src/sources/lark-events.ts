/** Native event transport with parent-side durable confirmation. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'

export const BridgeEventSchema = z.object({ type: z.literal('event'), deliveryId: z.string().uuid(),
  eventType: z.string().min(1), eventId: z.string().min(1), at: z.string().regex(/^\d{13}$/), payload: z.record(z.string(), z.unknown()) })
export type BridgeEvent = z.infer<typeof BridgeEventSchema>

/** The configured broker command owns credential injection into this child only. */
export async function consumeLarkBridge(command: readonly string[], signal: AbortSignal,
  receive: (event: BridgeEvent) => Promise<void>, report: (state: 'ready' | 'error' | 'starting', detail: string) => void): Promise<void> {
  if (!command.length || !command.every(Boolean)) throw new Error('Configure the Feishu event command')
  while (!signal.aborted) {
    const child = spawn(command[0]!, command.slice(1), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const output = createInterface({ input: child.stdout }), errors = createInterface({ input: child.stderr })
    let termination: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      if (termination) return
      child.stdin.end()
      // EOF reaches the brokered SDK child so it can close its connection before the wrapper exits.
      termination = setTimeout(() => child.kill('SIGTERM'), 5000)
    }
    signal.addEventListener('abort', stop, { once: true })
    child.stdin.on('error', () => { report('error', 'Feishu acknowledgment channel closed; reconnecting'); stop() })
    let chain = Promise.resolve()
    output.on('line', line => {
      chain = chain.then(async () => {
        if (line.length > 1_048_576) throw new Error('Event exceeds frame budget')
        const value = JSON.parse(line)
        if (value.type === 'status') { report(value.state === 'ready' ? 'ready' : value.state === 'error' ? 'error' : 'starting', 'Feishu event transport ' + String(value.state)); return }
        const event = BridgeEventSchema.parse(value)
        await receive(event)
        if (!signal.aborted && !child.stdin.destroyed) child.stdin.write(JSON.stringify({ type: 'ack', deliveryId: event.deliveryId }) + '\n')
      }).catch(() => { report('error', 'Event persistence failed; upstream confirmation withheld'); stop() })
    })
    errors.on('line', () => report('error', 'Feishu SDK transport needs attention; inspect its private runtime'))
    try {
      if (signal.aborted) stop()
      await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()) })
    } catch { if (!signal.aborted) report('error', 'Feishu event command could not start') }
    finally { clearTimeout(termination); signal.removeEventListener('abort', stop); output.close(); errors.close(); await chain }
    if (!signal.aborted) report('starting', 'Feishu event command stopped; reconnecting')
    await delay(30_000, undefined, { signal }).catch(() => {})
  }
}
