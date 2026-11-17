/** One read transaction, followed by resource release and worker exit. */
import { MessagePort, parentPort, receiveMessageOnPort, workerData } from 'node:worker_threads'
import { z } from 'zod'
import { Store } from './store.ts'
import { readModel, type EvidenceAccess, type ReadAccess } from './read-models.ts'

const input = z.object({ path: z.string(), kind: z.enum(['stats', 'lines', 'matters', 'production', 'history', 'evidence', 'line']), at: z.number().int(),
  page: z.object({ before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).optional(),
    active: z.boolean().optional(), unresolved: z.boolean().optional(), id: z.string().min(1).optional(),
    target: z.object({ kind: z.enum(['ticket', 'line']), id: z.string().min(1) }).optional() }).optional(),
  access: z.object({ port: z.instanceof(MessagePort), signal: z.instanceof(SharedArrayBuffer) }).optional() }).parse(workerData)
if (!parentPort) throw new Error('Read worker requires its parent channel')
const store = new Store(input.path, () => {}, () => {}, { readOnly: true })
const grants = new Map<string, EvidenceAccess>()
const access: ReadAccess = trigger => {
  if (!input.access) throw new Error('Evidence reads require the live Source owner')
  const current = grants.get(trigger.id)
  if (current) return current
  const signal = new Int32Array(input.access.signal)
  Atomics.store(signal, 0, 0)
  input.access.port.postMessage(trigger)
  // Only this computation thread waits; the host resolves one live Source check per message.
  Atomics.wait(signal, 0, 0)
  const reply = receiveMessageOnPort(input.access.port)?.message as { value: EvidenceAccess } | { error: string } | undefined
  if (!reply) throw new Error('Source owner did not acknowledge the access check')
  if ('error' in reply) throw new Error(reply.error)
  grants.set(trigger.id, reply.value)
  return reply.value
}
try {
  store.db.exec('BEGIN')
  const value = readModel(store, input.kind, input.at, input.page, access)
  store.db.exec('COMMIT')
  parentPort.postMessage({ ok: true, value })
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
} finally { store.close(); input.access?.port.close(); parentPort.close() }
