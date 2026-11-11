/** Explicit shadow IM triage: bounded transport batches, semantic results and per-message coverage, with no routing effects. */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import { family, record, KV } from '../kv.ts'
import { collectImContext, ImContextWindowSchema, type ImContextManifest, type ImContextReader } from '../sources/im-context.ts'
import type { ImEvidence } from '../sources/kind.ts'
import type { Store } from './store.ts'

const VERSION = 'im-shadow-v1'
const MAX_MESSAGES = 32, MAX_CHARS = 32_000, MESSAGE_CHARS = 8_000, MAX_ACTIVE = 4, LEASE_MS = 300_000
const Bucket = z.enum(['reply', 'act', 'know', 'none', 'unknown'])
export const TriageResultSchema = z.object({
  model: z.string().trim().min(1).max(200).describe('Reported model label for audit; not a host-verified model identity.'),
  items: z.array(z.object({ triggerId: z.string().min(1), bucket: Bucket, reason: z.string().trim().min(1).max(700),
    matterIds: z.array(z.string().min(1)).max(16) }).strict()).min(1).max(MAX_MESSAGES),
  matters: z.array(z.object({ id: z.string().min(1).max(80), title: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(1).max(700), triggerIds: z.array(z.string().min(1)).min(1).max(MAX_MESSAGES) }).strict()).max(32),
}).strict()
type Result = z.infer<typeof TriageResultSchema>
type Evidence = ImEvidence & { configuration: string }
interface Input { triggerId: string; triggerFingerprint: string; fingerprint: string; identity: ImEvidence; text: string; at: string; partial: boolean; url?: string }
export interface TriageBatch {
  id: string; mode: 'shadow'; contextComplete: false; version: string; generation: number; state: 'claimed' | 'completed';
  createdAt: string; claimedAt: string; leaseUntil: string; settingsRevision: number; inputs: Input[];
  completedAt?: string; result?: Result
  context?: { generation: number; settingsRevision: number; revision: number; inputFingerprint: string; manifest: ImContextManifest }
}
const batches = family<TriageBatch>('triage-shadow-batch:')
const activeClaims = record<string[]>('triage-shadow-active')
const coverage = family<{ batchId: string }>('triage-shadow-coverage:')
interface Host {
  store: Pick<Store, 'get' | 'set' | 'atomic' | 'triggers'>
  evidence(trigger: Trigger): Evidence | undefined
  context?(trigger: Trigger): ImContextReader
  paused(): boolean
  now?(): number
}
const unique = (items: string[]) => new Set(items).size === items.length
const conversation = (trigger: Trigger, evidence: Evidence) => key(trigger.source, evidence.provider, evidence.account, evidence.conversation)

/**
 * Owns only opt-in shadow batch and coverage KV records. It never mutates Trigger, Thread, Decision, Ticket, source ACK or Outbox.
 * Stable message membership survives restart; expiring leases advance generations so late results cannot overwrite another claim.
 */
export class ShadowTriage {
  constructor(private readonly host: Host) {}
  private now() { return this.host.now?.() ?? Date.now() }
  private revision() { return this.host.store.get(KV.settings.revision) ?? 0 }
  private resolve(id: string) {
    const trigger = this.host.store.triggers.get(id)
    const evidence = trigger && this.host.evidence(trigger)
    if (!trigger || !evidence) throw new Error(`IM evidence unavailable or outside current source scope: ${id}`)
    if (![evidence.provider, evidence.account, evidence.conversation, evidence.message, evidence.version].every(value => typeof value === 'string' && value.length)) {
      throw new Error('Source returned incomplete native IM identity')
    }
    return { trigger, evidence, fingerprint: key(JSON.stringify(trigger), JSON.stringify(evidence)) }
  }
  /** Explicitly select up to 200 stored records for a shadow replay; groups by native conversation and bounded event-time windows. */
  claim(ids: string[]) {
    if (this.host.paused()) throw new Error('Processing is paused')
    if (!ids.length || ids.length > 200 || !unique(ids)) throw new Error('Choose 1..200 distinct trigger IDs')
    return this.host.store.atomic(() => {
      const now = this.now(), iso = new Date(now).toISOString()
      // Validate the complete request before claiming anything; no partial success hidden behind an invalid source ID.
      const selected = ids.map(id => this.resolve(id)).sort((a, b) => a.trigger.at.localeCompare(b.trigger.at) || a.trigger.id.localeCompare(b.trigger.id))
      const live = (this.host.store.get(activeClaims) ?? []).filter(id => {
        const batch = this.host.store.get(batches(id))
        return batch?.state === 'claimed' && Date.parse(batch.leaseUntil) > now
      })
      let active = live.length
      const ready: TriageBatch[] = [], completed: string[] = [], deferred: string[] = [], handled = new Set<string>()
      const fresh: typeof selected = []
      for (const item of selected) {
        const previous = this.host.store.get(coverage(item.trigger.id))
        if (!previous) { fresh.push(item); continue }
        const batch = this.host.store.get(batches(previous.batchId))
        if (!batch) throw new Error('Shadow coverage points to a missing batch')
        if (handled.has(batch.id)) continue
        handled.add(batch.id)
        if (batch.state === 'completed') { this.validateInputs(batch); completed.push(batch.id); continue }
        // A retry uses the complete original membership, even if the caller supplied only one of its IDs.
        if (Date.parse(batch.leaseUntil) <= now) {
          if (active >= MAX_ACTIVE) { deferred.push(...batch.inputs.map(input => input.triggerId)); continue }
          this.validateInputs(batch, 'refresh')
          delete batch.context
          batch.generation++; batch.claimedAt = iso; batch.leaseUntil = new Date(now + LEASE_MS).toISOString()
          batch.settingsRevision = this.revision(); this.host.store.set(batches(batch.id), batch); live.push(batch.id); active++
        }
        else this.validateInputs(batch, 'commit')
        ready.push(batch)
      }
      const groups = new Map<string, typeof selected>()
      for (const item of fresh) {
        const group = conversation(item.trigger, item.evidence)
        const items = groups.get(group) ?? []; items.push(item); groups.set(group, items)
      }
      for (const items of groups.values()) {
        let chunk: Input[] = [], chars = 0
        const flush = () => {
          if (!chunk.length) return
          if (active >= MAX_ACTIVE) deferred.push(...chunk.map(input => input.triggerId))
          else {
            const id = key(VERSION, ...chunk.map(input => input.triggerId))
            const batch: TriageBatch = { id, mode: 'shadow', contextComplete: false, version: VERSION, generation: 1, state: 'claimed',
              createdAt: iso, claimedAt: iso, leaseUntil: new Date(now + LEASE_MS).toISOString(), settingsRevision: this.revision(), inputs: chunk }
            this.host.store.set(batches(id), batch)
            for (const input of chunk) this.host.store.set(coverage(input.triggerId), { batchId: id })
            ready.push(batch); live.push(id); active++
          }
          chunk = []; chars = 0
        }
        for (const { trigger, evidence, fingerprint } of items) {
          const text = trigger.text.slice(0, MESSAGE_CHARS)
          if (chunk.length && (chunk.length >= MAX_MESSAGES || chars + text.length > MAX_CHARS
            || Date.parse(trigger.at) - Date.parse(chunk[0]!.at) > 900_000)) flush()
          const { configuration: _configuration, ...identity } = evidence
          chunk.push({ triggerId: trigger.id, triggerFingerprint: key(JSON.stringify(trigger)), fingerprint, identity, text, at: trigger.at,
            partial: evidence.partial || trigger.text.length > MESSAGE_CHARS, ...(trigger.url ? { url: trigger.url } : {}) })
          chars += text.length
        }
        flush()
      }
      this.host.store.set(activeClaims, live)
      return { mode: 'shadow' as const, batches: ready, completed, deferred,
        warning: 'Selected evidence only, not complete conversation history. Compare later replies/cancellations before claiming current actionability. No business disposition, Ticket or notification is produced.' }
    })
  }
  private validateInputs(batch: TriageBatch, mode: 'snapshot' | 'commit' | 'refresh' = 'snapshot') {
    for (const input of batch.inputs) {
      const current = this.resolve(input.triggerId)
      const { configuration: _configuration, ...identity } = current.evidence
      if (key(JSON.stringify(current.trigger)) !== input.triggerFingerprint || JSON.stringify(identity) !== JSON.stringify(input.identity)) {
        throw new Error('Shadow input or native identity changed; immutable evidence must use a new Trigger version')
      }
      if (mode === 'commit' && current.fingerprint !== input.fingerprint) throw new Error('Source configuration changed; renew this claim after expiry')
      if (mode === 'refresh') input.fingerprint = current.fingerprint
    }
  }
  /** Read a durable batch without extending its lease. Disabled/changed source scope still gates its saved evidence. */
  read(id: string) {
    const batch = this.host.store.get(batches(id))
    if (!batch) throw new Error('Unknown shadow batch')
    this.validateInputs(batch)
    if (batch.context) {
      this.validateInputs(batch, 'commit')
      if (batch.context.generation !== batch.generation || batch.context.settingsRevision !== this.revision()) throw new Error('Saved context belongs to stale source settings or generation')
    }
    return batch
  }
  /** Fetch native bounded context outside Store transactions, then attach with exact generation/configuration CAS. */
  async prepareContext(id: string, generation: number, anchorId: string, window: { start: string; end: string }, signal?: AbortSignal) {
    const selected = ImContextWindowSchema.parse(window)
    const validate = () => {
      const batch = this.read(id)
      if (batch.state !== 'claimed') throw new Error('Completed shadow judgments cannot receive new context')
      if (batch.generation !== generation) throw new Error('Stale shadow generation')
      this.validateInputs(batch, 'commit')
      if (this.host.paused()) throw new Error('Processing is paused')
      if (Date.parse(batch.leaseUntil) <= this.now()) throw new Error('Shadow lease expired; claim again')
      if (batch.settingsRevision !== this.revision()) throw new Error('Settings changed; claim must be renewed after lease expiry')
      signal?.throwIfAborted()
      return batch
    }
    const batch = validate(), input = batch.inputs.find(item => item.triggerId === anchorId)
    if (!input) throw new Error('Context anchor must be an exact input of this shadow batch')
    if (!this.host.context) throw new Error('IM context consumer is unavailable')
    const fingerprint = key(JSON.stringify(batch.inputs)), revision = batch.context?.revision ?? 0
    const { trigger } = this.resolve(anchorId), reader = this.host.context(trigger)
    const manifest = await collectImContext({ assertActive: () => { reader.assertActive(); validate() }, read: reader.read },
      { ...selected, anchor: input.identity, anchorText: reader.anchorText ?? trigger.text }, signal)
    return this.host.store.atomic(() => {
      const current = validate(); reader.assertActive()
      if (key(JSON.stringify(current.inputs)) !== fingerprint || (current.context?.revision ?? 0) !== revision) throw new Error('Shadow context changed during the read')
      current.context = { generation, settingsRevision: current.settingsRevision, revision: revision + 1, inputFingerprint: fingerprint, manifest }
      this.host.store.set(batches(id), current)
      return current
    })
  }
  /** Commit exhaustive per-message coverage plus 0..N semantic matters atomically; a matter never authorizes work. */
  submit(id: string, generation: number, value: Result) {
    const result = TriageResultSchema.parse(value)
    return this.host.store.atomic(() => {
      const batch = this.read(id)
      if (batch.generation !== generation) throw new Error('Stale shadow generation')
      if (batch.state === 'completed') {
        if (JSON.stringify(batch.result) !== JSON.stringify(result)) throw new Error('Shadow result already committed; cannot overwrite')
        return batch
      }
      this.validateInputs(batch, 'commit')
      if (this.host.paused()) throw new Error('Processing is paused')
      if (Date.parse(batch.leaseUntil) <= this.now()) throw new Error('Shadow lease expired; claim again')
      if (batch.settingsRevision !== this.revision()) throw new Error('Settings changed; claim must be renewed after lease expiry')
      const expected = new Set(batch.inputs.map(input => input.triggerId))
      if (!unique(result.items.map(item => item.triggerId)) || result.items.length !== expected.size
        || result.items.some(item => !expected.has(item.triggerId))) throw new Error('Every input needs exactly one coverage item; no missing or foreign IDs')
      if (!unique(result.matters.map(matter => matter.id))) throw new Error('Duplicate semantic matter IDs')
      const matters = new Map(result.matters.map(matter => [matter.id, matter]))
      for (const item of result.items) {
        if (!unique(item.matterIds) || item.matterIds.some(id => !matters.get(id)?.triggerIds.includes(item.triggerId))) throw new Error('Coverage and matter evidence disagree')
        if (batch.inputs.find(input => input.triggerId === item.triggerId)!.partial && item.bucket !== 'unknown') throw new Error('Partial evidence must remain unknown in this shadow slice')
      }
      for (const matter of result.matters) {
        if (!unique(matter.triggerIds) || matter.triggerIds.some(id => !expected.has(id)
          || !result.items.find(item => item.triggerId === id)?.matterIds.includes(matter.id))) throw new Error('Matter references missing or foreign coverage')
      }
      batch.state = 'completed'; batch.completedAt = new Date(this.now()).toISOString(); batch.result = result
      this.host.store.set(batches(id), batch)
      this.host.store.set(activeClaims, (this.host.store.get(activeClaims) ?? []).filter(active => active !== id))
      return batch
    })
  }
}
