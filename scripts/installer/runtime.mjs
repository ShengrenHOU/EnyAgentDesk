/** Process and loopback helpers shared by the installer and the self-check. */
import { spawn, spawnSync } from 'node:child_process'
import { openSync } from 'node:fs'
import { connect } from 'node:net'

const WINDOWS = process.platform === 'win32'
const resolved = new Map()

function quoteArgument(value) {
  const text = String(value)
  if (WINDOWS) return `"${text.replaceAll('"', '\\"')}"`
  return `'${text.replaceAll("'", `'\\''`)}'`
}

export function commandLine(command, args = []) {
  return [command, ...args].map(quoteArgument).join(' ')
}

/** Resolve a Windows .cmd/.bat wrapper; everything else is spawned directly. */
function resolveCommand(command) {
  if (!WINDOWS || command.includes('/') || command.includes('\\') || /\.(exe|com)$/i.test(command)) {
    return { command, shell: WINDOWS && /\.(cmd|bat)$/i.test(command) }
  }
  if (resolved.has(command)) return resolved.get(command)
  const found = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true })
  const lines = (found.stdout ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const first = lines.find(line => /\.exe$/i.test(line)) ?? lines.find(line => /\.(cmd|bat)$/i.test(line)) ?? lines[0]
  const result = first ? { command: first, shell: /\.(cmd|bat)$/i.test(first) } : { command, shell: false }
  resolved.set(command, result)
  return result
}

/** Run a command and wait for it. Returns the exit code; never throws on a non-zero exit. */
export function run(command, args = [], { cwd, env, input, capture = false, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const piped = capture || quiet
    const target = resolveCommand(command)
    const options = {
      cwd, env: { ...process.env, ...env }, stdio: piped ? ['pipe', 'pipe', 'pipe'] : 'inherit', windowsHide: true,
    }
    const child = target.shell
      ? spawn(commandLine(target.command, args), { ...options, shell: true })
      : spawn(target.command, args, options)
    let stdout = ''
    let stderr = ''
    if (piped) {
      child.stdout?.on('data', chunk => { stdout += chunk })
      child.stderr?.on('data', chunk => { stderr += chunk })
    }
    child.on('error', reject)
    child.on('close', code => {
      if (capture) resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
      else if (quiet) {
        if (code !== 0) process.stderr.write(stderr)
        resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
      } else resolve({ code })
    })
    if (input !== undefined) child.stdin?.end(input)
    else child.stdin?.end()
  })
}

/** Start a detached process and return its pid; stdout and stderr go to `logFile`. */
export function spawnDetached(command, args, { cwd, env, logFile, append = true } = {}) {
  return new Promise((resolve, reject) => {
    const fd = openSync(logFile, append ? 'a' : 'w')
    const target = resolveCommand(command)
    const options = {
      cwd, env: { ...process.env, ...env }, detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
    }
    const child = target.shell
      ? spawn(commandLine(target.command, args), { ...options, shell: true })
      : spawn(target.command, args, options)
    child.on('error', reject)
    child.on('spawn', () => {
      child.unref()
      resolve(child.pid)
    })
  })
}

export async function httpJson(port, path, { method = 'GET', body, timeoutMs = 5000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/orchestrator/api/${path}`, {
      method,
      headers: { 'x-orchestrator-request': '1', connection: 'close', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    let value = null
    try { value = text ? JSON.parse(text) : null } catch { value = text }
    if (!response.ok) {
      const detail = value && typeof value === 'object' ? (value.error ?? JSON.stringify(value)) : String(value)
      const error = new Error(`${method} ${path} returned ${response.status}: ${detail}`)
      error.status = response.status
      error.body = value
      throw error
    }
    return value
  } finally {
    clearTimeout(timer)
  }
}

export async function waitFor(description, probe, { timeoutMs = 180_000, intervalMs = 2_000 } = {}) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      last = error
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(`${description} did not become ready within ${Math.round(timeoutMs / 1000)} s${last ? `: ${last.message}` : ''}`)
}

/** True when something accepts TCP connections on the loopback port. */
export function portInUse(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = value => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1500)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
