/** Local observations are monotonically versioned; neither timestamps nor a native thread prove matter identity. */
import { createHash } from 'node:crypto'
import { family } from '../kv.ts'
import type { ImEvidence } from '../sources/kind.ts'
import type { Store } from './store.ts'
import type { ProductionBatch } from './production-triage.ts'
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const imScope = (identity: ImEvidence) => hash([identity.provider, identity.account, identity.conversation])
const revisions = family<number>('im-observation-revision:')
const seen = family<boolean>('im-observation-seen:')
export const evidenceRevision = (store: Store, identity: ImEvidence) => store.get(revisions(imScope(identity))) ?? 0
/** Exact identity/version dedupe, even when historical messages arrive late or replay via a second Trigger. */
export function observeImEvidence(store: Store, identity: ImEvidence) {
  const object = seen(hash([imScope(identity), identity.message, identity.version]))
  if (store.get(object)) return
  store.set(object, true)
  store.set(revisions(imScope(identity)), evidenceRevision(store, identity) + 1)
}
export function newerKnownEvidence(store: Store, batch: ProductionBatch) {
  return batch.evidenceRevision !== undefined && !!batch.inputs[0] && evidenceRevision(store, batch.inputs[0].identity) > batch.evidenceRevision
}
