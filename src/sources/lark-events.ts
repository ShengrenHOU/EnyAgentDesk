/** Native event transport with parent-side durable confirmation. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'

export const BridgeEventSchema = z.object({ type: z.literal('event'), deliveryId: z.string().uuid(),
  eventType: z.string().min(1), eventId: z.string().min(1), at: z.string().regex(/^\d{13}$/), payload: z.record(z.string(), z.unknown()) })
export type BridgeEvent = z.infer<typeof BridgeEventSchema>
const systemCodes = ['ENOENT', 'EACCES', 'EPERM', 'EPIPE', 'ENOSPC', 'EIO', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE', 'ECONNABORTED'] as const
const Diagnostic = z.object({ stage: z.enum(['sdk', 'startup', 'ack']), code: z.number().int().optional(), httpStatus: z.number().int().min(100).max(599).optional(),
  systemCode: z.enum(systemCodes).optional(), deliveryId: z.string().uuid().optional(),
  reason: z.enum(['failure', 'timeout', 'connection', 'invalid_ack', 'unconfirmed']).optional() })
const Status = z.object({ type: z.literal('status'), state: z.enum(['starting', 'ready', 'error', 'reconnecting']), diagnostic: Diagnostic.optional() })
/** Keep machine-readable root causes, never raw provider messages, stderr, URLs or event bodies. */
export function larkErrorCode(error: unknown): string {
  const name = error instanceof Error && ['Error', 'TypeError', 'SyntaxError', 'RangeError', 'ZodError', 'AbortError', 'AxiosError'].includes(error.name) ? error.name : 'Error'
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const safe = typeof code === 'number' && Number.isSafeInteger(code) || typeof code === 'string' && systemCodes.some(value => value === code)
  const reasons = new Map([
    ['Lark user does not match the configured account', 'account_mismatch'],
    ['Lark returned an unexpected identity', 'unexpected_identity'],
    ['Lark returned invalid JSON', 'invalid_json'],
    ['A Lark user-identity read requires the configured native lark-cli executable', 'missing_user_cli'],
  ])
  const reason = error instanceof Error ? reasons.get(error.message) : undefined
  return `${name}${safe ? ` code=${code}` : ''}${reason ? ` reason=${reason}` : ''}`
}
const diagnosticText = (value: z.infer<typeof Diagnostic>): string =>
  `${value.stage}:${value.reason ?? 'failure'}${value.code === undefined ? '' : ` code=${value.code}`}${value.httpStatus ? ` HTTP=${value.httpStatus}` : ''}${value.systemCode ? ` ${value.systemCode}` : ''}${value.deliveryId ? ` delivery=${value.deliveryId}` : ''}`

/** The configured broker command owns credential injection into this child only. */
export async function consumeLarkBridge(command: readonly string[], signal: AbortSignal,
  receive: (event: BridgeEvent) => Promise<void>, report: (state: 'ready' | 'error' | 'starting', detail: string) => void): Promise<void> {
  if (!command.length || !command.every(Boolean)) throw new Error('Configure the Feishu event command')
  while (!signal.aborted) {
    const child = spawn(command[0]!, command.slice(1), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const output = createInterface({ input: child.stdout }), errors = createInterface({ input: child.stderr })
    let lastFailure = ''
    const failed = (detail: string) => { lastFailure = detail; report('error', detail) }
    let termination: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      if (termination) return
      child.stdin.end()
      // EOF reaches the brokered SDK child so it can close its connection before the wrapper exits.
      termination = setTimeout(() => child.kill('SIGTERM'), 5000)
    }
    signal.addEventListener('abort', stop, { once: true })
    child.stdin.on('error', error => { if (!signal.aborted) failed(`Feishu ack failed (${larkErrorCode(error)}); reconnecting`); stop() })
    let chain = Promise.resolve()
    output.on('line', line => {
      let stage = 'frame', event: BridgeEvent | undefined
      chain = chain.then(async () => {
        if (line.length > 1_048_576) throw new Error('Event exceeds frame budget')
        const value = JSON.parse(line)
        stage = 'schema'
        if (value?.type === 'status') {
          const status = Status.parse(value)
          if (status.state === 'ready') { lastFailure = ''; report('ready', 'Feishu event transport ready') }
          else if (status.state === 'error') failed(`Feishu ${status.diagnostic ? diagnosticText(status.diagnostic) : 'transport error'}`)
          else report('starting', `Feishu event transport ${status.state}${lastFailure ? `; last failure: ${lastFailure}` : ''}`)
          return
        }
        event = BridgeEventSchema.parse(value)
        stage = 'persistence'
        await receive(event)
        stage = 'ack'
        if (!signal.aborted && !child.stdin.destroyed) child.stdin.write(JSON.stringify({ type: 'ack', deliveryId: event.deliveryId }) + '\n')
      }).catch(error => {
        if (!signal.aborted) failed(`Feishu ${stage} failed (${larkErrorCode(error)})${event ? `; delivery=${event.deliveryId}` : ''}; upstream confirmation withheld`)
        stop()
      })
    })
    errors.on('line', line => {
      let diagnostic: z.infer<typeof Diagnostic> | undefined
      try { diagnostic = Diagnostic.parse(JSON.parse(line)) } catch { /* Unknown child output is never copied to health. */ }
      if (!signal.aborted) failed(`Feishu ${diagnostic ? diagnosticText(diagnostic) : 'SDK diagnostic unavailable (unstructured child error)'}`)
    })
    try {
      if (signal.aborted) stop()
      await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', (code, stopped) => {
        if (!signal.aborted && !lastFailure) failed(`Feishu child exit=${code ?? 'unknown'} signal=${stopped ?? 'none'}`)
        resolve()
      }) })
    } catch (error) { if (!signal.aborted) failed(`Feishu spawn failed (${larkErrorCode(error)})`) }
    finally { clearTimeout(termination); signal.removeEventListener('abort', stop); output.close(); errors.close(); await chain }
    if (!signal.aborted) report('starting', `Feishu event command stopped; reconnecting${lastFailure ? `; last failure: ${lastFailure}` : ''}`)
    await delay(30_000, undefined, { signal }).catch(() => {})
  }
}
