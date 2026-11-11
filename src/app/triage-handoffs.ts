/** Controlled passive-pending migration receipts. Separate from shadow model results and executor handoffs. */
import { createHash } from 'node:crypto'
import { Engine, type Trigger } from '../core/index.ts'
import type { HeldInput } from '../core/triage-handoffs.ts'
import { family, KV } from '../kv.ts'
import type { ImEvidence } from '../sources/kind.ts'
import type { Store } from './store.ts'

interface Manifest {
  owner: string; generation: number; state: 'held' | 'transferred' | 'released'; fingerprint: string;
  heldAt: string; releasedAt?: string; inputs: HeldInput[]
}
const manifests = family<Manifest>('triage-handoff:')
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
interface Host {
  store: Store
  /** Must be the Engine constructed over this same Store. Verified at construction. */
  engine: Engine
  evidence(trigger: Trigger): (ImEvidence & { configuration: string }) | undefined
  policyVersion(): string
  enabled(): boolean
  now?(): string
}
/** Owns bounded handoff manifests, version checks and idempotent receipts, never business Decisions. */
export class TriageHandoffs {
  constructor(private readonly host: Host) {
    if (!host.engine.usesRepositories(host.store)) throw new Error('Triage handoff requires the Engine and manifest to share one Store')
  }
  private enabled() { if (!this.host.enabled()) throw new Error('Enable triageHandoff controls explicitly; held evidence remains fenced while disabled') }
  private now() { return this.host.now?.() ?? new Date().toISOString() }
  /** No saved plaintext, no inferred completion, and no shadow result consumed. */
  preview(ids: string[]) {
    this.enabled()
    return this.host.store.atomic(() => {
      const entries = this.host.engine.previewHandoff(ids)
      const identities = ids.map((id, index) => {
        const trigger = this.host.store.triggers.get(id)
        const evidence = trigger && this.host.evidence(trigger)
        if (!evidence || ![evidence.provider, evidence.account, evidence.conversation, evidence.message, evidence.version, evidence.configuration]
          .every(value => typeof value === 'string' && value.length)) {
          entries[index] = { ...entries[index]!, eligible: false, reason: 'source_unavailable' }
        }
        return { trigger, evidence, disposition: this.host.store.triggers.disposition(id) }
      })
      const fingerprint = digest({ entries, identities, revision: this.host.store.get(KV.settings.revision) ?? 0, policy: this.host.policyVersion() })
      return { fingerprint, entries, contextComplete: false as const, warning: 'Holding only; no production judgment or backlog completion.' }
    })
  }
  adopt(owner: string, ids: string[], fingerprint: string) {
    this.enabled()
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(owner)) throw new Error('Choose a stable handoff owner ID of 1..100 letters, digits, underscore or dash')
    return this.host.store.atomic(() => {
      const previous = this.host.store.get(manifests(owner))
      if (previous) {
        if (previous.fingerprint !== fingerprint || JSON.stringify(previous.inputs.map(input => input.triggerId)) !== JSON.stringify(ids)) throw new Error('Handoff owner already used for a different selection')
        return previous
      }
      const preview = this.preview(ids)
      if (preview.fingerprint !== fingerprint) throw new Error('Selection, source, settings or policy changed; preview again')
      if (preview.entries.some(item => !item.eligible)) throw new Error('Handoff refused: selection is not entirely eligible')
      const inputs = this.host.engine.holdForTriage(ids, owner, 1)
      const manifest: Manifest = { owner, generation: 1, state: 'held', fingerprint, heldAt: this.now(), inputs }
      this.host.store.set(manifests(owner), manifest)
      return manifest
    })
  }
  /** Internal automatic accumulation only: append exact fresh eligible members while the owner is still held. */
  append(owner: string, ids: string[], fingerprint: string) {
    this.enabled()
    return this.host.store.atomic(() => {
      const manifest = this.read(owner)
      if (manifest.state !== 'held' || manifest.inputs.length + ids.length > 8) throw new Error('Automatic accumulation owner is sealed')
      const preview = this.preview(ids)
      if (preview.fingerprint !== fingerprint || preview.entries.some(item => !item.eligible)) throw new Error('Automatic selection changed')
      manifest.inputs.push(...this.host.engine.holdForTriage(ids, owner, manifest.generation))
      this.host.store.set(manifests(owner), manifest)
      return manifest
    })
  }
  /** Exact saved membership only. Source disable does not prevent rollback. Never starts work or acknowledges messages. */
  release(owner: string, generation: number) {
    this.enabled()
    return this.host.store.atomic(() => {
      const manifest = this.host.store.get(manifests(owner))
      if (!manifest || manifest.generation !== generation) throw new Error('Unknown owner or stale handoff generation')
      if (manifest.state === 'released') return manifest
      if (manifest.state === 'transferred') throw new Error('Production owns this manifest; use production rollback for unfinished batches')
      this.host.engine.releaseFromTriage(manifest.inputs, owner, generation)
      manifest.state = 'released'; manifest.releasedAt = this.now()
      this.host.store.set(manifests(owner), manifest)
      return manifest
    })
  }
  /** Transfer only inside the production Store transaction; completed members never return to C1 release. */
  transferred(owner: string, generation: number) {
    const manifest = this.read(owner)
    if (manifest.generation !== generation || manifest.state !== 'held') throw new Error('Stale handoff transfer')
    manifest.state = 'transferred'; this.host.store.set(manifests(owner), manifest)
  }
  /** A complete production rollback closes the original manifest; partial rollback stays transferred. */
  reconcile(owner: string) {
    const manifest = this.read(owner)
    if (manifest.state === 'transferred' && manifest.inputs.every(input => !this.host.store.triggers.disposition(input.triggerId)?.triage)) {
      manifest.state = 'released'; manifest.releasedAt = this.now(); this.host.store.set(manifests(owner), manifest)
    }
  }
  /** Bounded, plaintext-free reference read; usable even when source scope or controls are disabled. */
  read(owner: string) {
    const manifest = this.host.store.get(manifests(owner))
    if (!manifest) throw new Error('Unknown handoff')
    return manifest
  }
}
