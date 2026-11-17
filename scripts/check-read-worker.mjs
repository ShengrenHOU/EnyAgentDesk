/** Exercise the built read worker without the host loader or development peer dependencies. */
import assert from 'node:assert/strict'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'

const directory = mkdtempSync(join(tmpdir(), 'superagent-built-read-'))
try {
  copyFileSync(new URL('../lib/read-worker.js', import.meta.url), join(directory, 'read-worker.mjs'))
  copyFileSync(new URL('../package.json', import.meta.url), join(directory, 'package.json'))
  for (const assets of ['skills', 'prompts']) cpSync(new URL(`../${assets}`, import.meta.url), join(directory, assets), { recursive: true })
  mkdirSync(join(directory, 'node_modules'))
  const require = createRequire(import.meta.url)
  cpSync(dirname(require.resolve('zod/package.json')), join(directory, 'node_modules/zod'), { recursive: true })
  const path = join(directory, 'state.sqlite'), db = new DatabaseSync(path)
  db.exec('CREATE TABLE trigger (id TEXT, at TEXT, value TEXT); CREATE TABLE disposition (id TEXT, value TEXT); CREATE TABLE decision (id TEXT, value TEXT); CREATE TABLE outbox (id TEXT, value TEXT, dropped TEXT)')
  db.close()
  const worker = new Worker(join(directory, 'read-worker.mjs'), { workerData: { path, kind: 'stats', at: Date.now() }, env: {}, execArgv: [] })
  const result = await new Promise((resolve, reject) => {
    let value
    worker.once('message', frame => { value = frame })
    worker.once('error', reject)
    worker.once('exit', code => { if (code === 0) resolve(value); else reject(new Error(`Built read worker exited (${code})`)) })
  })
  assert.deepEqual(result, { ok: true, value: { received: 0, filtered: 0, triggers: 0, judged: 0, accepted: 0, dropped: 0 } })
  console.log('Built read worker passed with only its declared runtime dependency')
} finally { rmSync(directory, { recursive: true, force: true }) }
