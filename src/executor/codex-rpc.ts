/** Local Codex App Server JSON-RPC transport. No shell, credential copying, or request retries. */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { z } from 'zod'

const Id = z.union([z.string(), z.number()])
const Message = z.union([
  z.object({ id: Id, method: z.string(), params: z.unknown().optional() }),
  z.object({ method: z.string(), params: z.unknown().optional() }),
  z.object({ id: Id, result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).optional() }),
])
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export interface CodexRpcOptions {
  command: string
  args?: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  notification(method: string, params: unknown): void
  request(method: string, params: unknown): Promise<unknown>
  disconnected(error: Error): void
}

/** Owns one App Server subprocess and rejects unresolved operations when its connection is lost. */
export class CodexRpc {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string | number, Pending>()
  private nextId = 0
  private buffer = ''
  private ended = false
  private closing = false
  private readonly exited = Promise.withResolvers<void>()
  private closePromise?: Promise<void>
  private constructor(private readonly options: CodexRpcOptions) {
    const env = { ...options.env ?? process.env }
    // A standalone executor must not attach to the launching desktop chat's tool pipe or identity.
    for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_TOOL_CALL_ID', 'CODEX_APP_TOOLS_PIPE_PATH',
      'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY', 'CODEX_PERMISSION_PROFILE']) delete env[key]
    this.child = spawn(options.command, options.args ?? ['app-server'], {
      cwd: options.cwd, env, stdio: 'pipe', windowsHide: true, shell: false,
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk))
    // Drain diagnostics without retaining potentially sensitive tool output.
    this.child.stderr.resume()
    this.child.on('error', error => this.fail(error))
    this.child.on('exit', (code, signal) => {
      this.exited.resolve()
      this.fail(new Error(`Codex App Server exited (${code ?? signal ?? 'unknown'})`))
    })
    this.child.on('close', () => this.exited.resolve())
    this.child.stdin.on('error', error => this.fail(error))
  }
  static async connect(options: CodexRpcOptions): Promise<CodexRpc> {
    const rpc = new CodexRpc(options)
    try {
      await rpc.call('initialize', { clientInfo: { name: 'enyagentdesk', version: '0.1.0' },
        capabilities: { experimentalApi: true } })
      rpc.write({ method: 'initialized' })
      return rpc
    } catch (error) { await rpc.close(); throw error }
  }
  call(method: string, params: unknown): Promise<unknown> {
    if (this.ended || this.closing) return Promise.reject(new Error('Codex App Server is disconnected'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // An unanswered mutation has an unknown outcome. End the connection; never resend it implicitly.
        this.fail(new Error(`Codex App Server ${method} timed out; outcome is unknown`))
      }, this.options.timeoutMs ?? 60_000)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }
  private write(message: unknown): void {
    if (this.ended) return
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }
  private consume(chunk: string): void {
    if (this.ended) return
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) { this.fail(new Error('Codex protocol frame exceeds 32 MiB')); return }
    for (;;) {
      const end = this.buffer.indexOf('\n')
      if (end < 0) return
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (!line) continue
      try {
        const message = Message.parse(JSON.parse(line))
        if ('method' in message) {
          if ('id' in message) {
            void this.options.request(message.method, message.params).then(
              result => this.write({ id: message.id, result }),
              () => this.write({ id: message.id, error: { code: -32603, message: 'Host rejected the request' } }),
            )
          } else this.options.notification(message.method, message.params)
        } else {
          const pending = this.pending.get(message.id)
          if (!pending) continue
          clearTimeout(pending.timer); this.pending.delete(message.id)
          if (message.error) pending.reject(new Error(`Codex ${message.error.code}: ${message.error.message}`))
          else pending.resolve(message.result)
        }
      } catch { this.fail(new Error('Invalid Codex protocol message')); return }
    }
  }
  private fail(error: Error): void {
    if (this.ended) return
    this.ended = true
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    if (!this.closing) this.options.disconnected(error)
    void this.close().catch(error => this.options.disconnected(error instanceof Error ? error : new Error(String(error))))
  }
  close(): Promise<void> {
    return this.closePromise ??= this.shutdown()
  }
  private async shutdown(): Promise<void> {
    this.closing = true
    this.ended = true
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Codex App Server connection closed')) }
    this.pending.clear()
    // EOF lets App Server release its thread writer and tool-runtime descendants before the next resume.
    this.child.stdin.end()
    const wait = async (ms: number): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { return await Promise.race([this.exited.promise.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms) })]) }
      finally { if (timer) clearTimeout(timer) }
    }
    const closeStreams = () => { this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy() }
    if (await wait(5000)) { closeStreams(); return }
    if (process.platform === 'win32' && this.child.pid && this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise<void>((resolve, reject) => execFile('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true }, error => {
        if (error && this.child.exitCode === null && this.child.signalCode === null) reject(new Error('Could not stop the owned Codex process tree'))
        else resolve()
      }))
    } else if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
    const stopped = await wait(5000)
    closeStreams()
    if (!stopped) throw new Error('Codex process did not finish closing')
  }
}
