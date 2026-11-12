/** Read-only semantic projection. Receipts, business ownership and sender authority are never rewritten. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { family } from '../kv.ts'
import type { Trigger } from '../core/index.ts'
import type { ImEvidence, ImMessageHeader } from '../sources/kind.ts'
import type { Store } from './store.ts'
import type { ProductionBatch } from './production-triage.ts'
import { evidenceRevision, imScope } from './im-evidence-revisions.ts'
import { findLineOf, readLine } from './lines.ts'
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const Id = z.string().min(1).max(200)
export const MatterEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('trigger'), batchId: Id, generation: z.number().int().positive(), triggerId: Id, version: Id }).strict(),
  z.object({ kind: z.literal('context'), batchId: Id, generation: z.number().int().positive(), triggerId: Id,
    revision: z.number().int().positive(), hash: z.string().length(64), messageId: Id, version: Id }).strict(),
])
type Evidence = z.infer<typeof MatterEvidenceSchema>
export const MatterProposalSchema = z.object({ localMatterId: Id, relation: z.enum(['new', 'continue', 'related']),
  targetId: Id.optional(), expectedRevision: z.number().int().positive().optional(),
  assessment: z.enum(['suggested_action', 'informational', 'unknown', 'no_further_action_suggested']),
  reason: z.string().trim().min(1).max(700), evidence: z.array(MatterEvidenceSchema).min(1).max(32),
}).strict()
type Proposal = z.infer<typeof MatterProposalSchema>
export interface MatterTarget { kind: 'ticket' | 'line'; id: string }
export interface MatterHandoffReceipt { matterId: string; revision: number; target: MatterTarget; reused: boolean; inputId?: string }
interface Matter {
  id: string; scope: string; revision: number; title: string; reason: string; assessment: Proposal['assessment']
  anchorBatchId: string; observedRevision?: number; createdAt: string; updatedAt: string; related?: string
  handoff?: MatterTarget & { at: string; reason: string; inputId?: string }
}
export interface Member { id: string; batchId: string; generation: number; localMatterId: string; matterId: string; originId: string }
export interface Event { id: string; matterId: string; revision: number; kind: 'new' | 'continue' | 'related' | 'split' | 'retract_related' | 'handoff'; at: string; memberId: string; reason: string; evidence: Evidence[]; dependencies?: string[]; handoff?: MatterTarget & { inputId?: string } }
interface Reads { dependencies?: Record<string, true>; candidates: Record<string, number>; contexts: Record<string, { hash: string; revision: number; next: number | null; complete?: boolean }> }
const matters = family<Matter>('triage-matter:')
const members = family<Member>('triage-matter-member:')
const events = family<Event>('triage-matter-event:')
const reads = family<Reads>('triage-matter-read:')
const imports = family<number>('triage-matter-import:')
const corrections = family<{ original: string; separated: string }>('triage-matter-correction:')
const key = (batch: ProductionBatch) => `${batch.id}:${batch.generation}`
const memberId = (batch: ProductionBatch, local: string) => hash([batch.id, batch.generation, local])
const canonicalId = (id: string) => hash(['semantic-matter-v1', id])
const workMatch = "EXISTS (SELECT 1 FROM json_each(?) work WHERE json_extract(work.value, '$.kind') = json_extract(kv.value, '$.handoff.kind') AND json_extract(work.value, '$.id') = json_extract(kv.value, '$.handoff.id'))"
type EvidenceResolver = (trigger: Trigger) => (ImEvidence & { configuration: string }) | undefined
/** Application-owned canonical read projection with immutable provenance and reversible semantic links. */
export class TriageMatters {
  constructor(private readonly store: Store, private readonly evidence: EvidenceResolver, private readonly header?: (trigger: Trigger) => ImMessageHeader) {}
  private workTargets(target: MatterTarget): MatterTarget[] {
    if (target.kind === 'ticket') {
      const line = findLineOf(this.store, target.id)
      return line ? [target, { kind: 'line', id: line.id }] : [target]
    }
    return [target, ...(readLine(this.store, target.id)?.tickets ?? []).map(id => ({ kind: 'ticket' as const, id }))]
  }
  private batch(id: string) { const batch = this.store.get<ProductionBatch>(`triage-production:${id}`); if (!batch) throw new Error('Unknown evidence receipt'); return batch }
  private scope(batch: ProductionBatch) { if (!batch.inputs[0]) throw new Error('Empty evidence receipt'); return imScope(batch.inputs[0].identity) }
  private readable(batch: ProductionBatch) {
    return batch.inputs.every(input => { const trigger = this.store.triggers.get(input.triggerId), current = trigger && this.evidence(trigger)
      return !!current && input.fingerprint === hash({ trigger, evidence: current }) })
  }
  /** Covers derived receipt prose too, including citations to earlier source configurations. */
  receiptReadable(batch: ProductionBatch, cache = new Map<string, boolean>()) {
    if (cache.has(batch.id)) return cache.get(batch.id)!
    const pending = [batch], visited = new Set<string>(), enqueued = new Set<string>([batch.id])
    while (pending.length) {
      const current = pending.pop()!; if (visited.has(current.id) || cache.get(current.id) === true) continue; visited.add(current.id)
      if (cache.get(current.id) === false || !this.readable(current)) { cache.set(batch.id, false); return false }
      for (const id of current.matterProvenance ?? []) {
        try { if (!enqueued.has(id) && cache.get(id) !== true) { enqueued.add(id); pending.push(this.batch(id)) } } catch { cache.set(batch.id, false); return false }
      }
      for (const proposal of current.result?.proposals ?? []) for (const ref of proposal.evidence) {
        try { if (!enqueued.has(ref.batchId) && cache.get(ref.batchId) !== true) { enqueued.add(ref.batchId); pending.push(this.batch(ref.batchId)) } } catch { cache.set(batch.id, false); return false }
      }
    }
    for (const id of visited) cache.set(id, true)
    return true
  }
  private assertReadable(batch: ProductionBatch, cache = new Map<string, boolean>()) { if (!this.receiptReadable(batch, cache)) throw new Error('Matter evidence source permission or configuration changed') }
  private get(id: string) { const matter = this.store.get(matters(id)); if (!matter) throw new Error('Unknown canonical matter'); return matter }
  private ledger(batch: ProductionBatch) { return this.store.get(reads(key(batch))) ?? { candidates: {}, contexts: {} } }
  private citationsReadable(event: Event, cache: Map<string, boolean>) { return [...event.evidence.map(ref => ref.batchId), ...(event.dependencies ?? [])].every(id => { try { return this.receiptReadable(this.batch(id), cache) } catch { return false } }) }
  private history(id: string) { return this.store.db.prepare("SELECT value FROM kv WHERE key LIKE 'triage-matter-event:%' AND json_extract(value, '$.matterId') = ? ORDER BY rowid").all(id).map(row => JSON.parse(String(row.value)) as Event) }
  private membership(id: string) { return this.store.db.prepare("SELECT value FROM kv WHERE key LIKE 'triage-matter-member:%' AND json_extract(value, '$.matterId') = ? ORDER BY rowid").all(id).map(row => JSON.parse(String(row.value)) as Member) }
  private isReadable(matter: Matter, cache = new Map<string, boolean>()) {
    try { return this.receiptReadable(this.batch(matter.anchorBatchId), cache) && this.membership(matter.id).every(member => this.receiptReadable(this.batch(member.batchId), cache)) && this.history(matter.id).every(event => this.citationsReadable(event, cache)) } catch { return false }
  }
  private contextWarnings(member: Member) {
    const batch = this.batch(member.batchId), local = batch.result?.matters.find(local => local.id === member.localMatterId)
    return (local?.triggerIds ?? []).map(triggerId => {
      const context = batch.contexts[triggerId], observed = context?.manifest.anchor.observed
      return { triggerId, gaps: context?.manifest.gaps ?? ['context_unavailable'], contextComplete: false as const,
        ...(context ? { revision: context.revision, hash: context.manifest.hash, anchorStatus: context.manifest.anchor.status } : {}),
        ...(observed?.versionBasis !== undefined ? { versionBasis: observed.versionBasis } : {}),
        ...(observed?.nativeVersion !== undefined ? { nativeVersion: observed.nativeVersion } : {}) }
    })
  }
  private view(matter: Matter, cache = new Map<string, boolean>()) {
    const readable = this.isReadable(matter, cache), batch = this.batch(matter.anchorBatchId), linked = this.membership(matter.id)
    const target = readable && matter.handoff && (matter.handoff.kind === 'ticket' ? this.store.tickets.get(matter.handoff.id) : readLine(this.store, matter.handoff.id))
    return { id: matter.id, revision: matter.revision, createdAt: matter.createdAt, updatedAt: matter.updatedAt,
      redacted: !readable, stale: matter.observedRevision === undefined || evidenceRevision(this.store, batch.inputs[0]!.identity) > matter.observedRevision,
      ...(readable ? { title: matter.title, reason: matter.reason, assessment: matter.assessment,
        conversation: batch.inputs[0]!.identity.conversation, ...(matter.related !== undefined ? { related: matter.related } : {}),
        ...(matter.handoff ? { handoff: { ...matter.handoff, ...(target ? { title: target.title } : {}) } } : {}) } : {}),
      memberCount: linked.length, members: readable ? linked.slice(0, 25).map(member => {
        const local = this.batch(member.batchId).result?.matters.find(local => local.id === member.localMatterId)
        return { ...member, ...(local ? { local } : {}), contexts: this.contextWarnings(member) }
      }) : [], membersLimited: readable && linked.length > 25,
      warning: 'Evidence-based suggestion only. Sender identity and authority are not established; no business obligation resolved.' }
  }
  /** Full-history keyset pagination. Archived empty projections remain available in history. */
  overview(page: { before?: number; limit?: number; scope?: string; active?: boolean; target?: MatterTarget } = {}) {
    const limit = page.limit ?? 25, before = page.before ?? Number.MAX_SAFE_INTEGER
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(before) || before < 1) throw new Error('Invalid matter page')
    const clauses = ["key LIKE 'triage-matter:%'"], args: (string | number)[] = []
    if (page.scope) { clauses.push("json_extract(value, '$.scope') = ?"); args.push(page.scope) }
    if (page.target) { clauses.push(workMatch); args.push(JSON.stringify(this.workTargets(page.target))) }
    if (page.active) clauses.push("EXISTS (SELECT 1 FROM kv m WHERE m.key LIKE 'triage-matter-member:%' AND json_extract(m.value, '$.matterId') = json_extract(kv.value, '$.id'))")
    const where = clauses.join(' AND ')
    const rows = this.store.db.prepare(`SELECT rowid AS cursor, value FROM kv WHERE ${where} AND rowid < ? ORDER BY rowid DESC LIMIT ?`).all(...args, before, limit + 1)
    const totals = this.store.db.prepare(`SELECT count(*) AS total, min(json_extract(value, '$.createdAt')) AS oldestAt FROM kv WHERE ${where}`).get(...args)!
    const unresolved = this.store.db.prepare(`SELECT count(*) AS total, min(json_extract(value, '$.createdAt')) AS oldestAt FROM kv WHERE ${where}
      AND json_extract(value, '$.assessment') IN ('unknown', 'suggested_action')
      AND EXISTS (SELECT 1 FROM kv m WHERE m.key LIKE 'triage-matter-member:%' AND json_extract(m.value, '$.matterId') = json_extract(kv.value, '$.id'))`).get(...args)!
    const selected = rows.slice(0, limit), readable = new Map<string, boolean>()
    return { unresolved: { total: Number(unresolved.total), oldestAt: unresolved.oldestAt ? String(unresolved.oldestAt) : null }, total: Number(totals.total), oldestAt: totals.oldestAt ? String(totals.oldestAt) : null,
      nextBefore: rows.length > limit ? Number(selected.at(-1)!.cursor) : null, groups: selected.map(row => this.view(JSON.parse(String(row.value)) as Matter, readable)) }
  }
  /** Import at most 25 receipt groups per requested scope page. Never infer semantic links or rewrite a receipt. */
  private importLegacy(batch: ProductionBatch) {
    const identity = batch.inputs[0]!.identity, scope = this.scope(batch), after = this.store.get(imports(scope)) ?? 0
    const rows = this.store.db.prepare(`SELECT rowid AS cursor, value FROM kv WHERE key LIKE 'triage-production:%' AND rowid > ?
      AND json_extract(value, '$.state') = 'completed' AND json_extract(value, '$.inputs[0].identity.provider') = ?
      AND json_extract(value, '$.inputs[0].identity.account') = ? AND json_extract(value, '$.inputs[0].identity.conversation') = ? ORDER BY rowid LIMIT 26`)
      .all(after, identity.provider, identity.account, identity.conversation)
    for (const row of rows.slice(0, 25)) { const old = JSON.parse(String(row.value)) as ProductionBatch; this.apply(old, [], true); this.store.set(imports(scope), Number(row.cursor)) }
    return { remaining: rows.length > 25, imported: Math.min(25, rows.length) }
  }
  private recordRead(ledger: Reads, matter: Matter) {
    ledger.dependencies ??= {}; ledger.candidates[matter.id] = matter.revision
    ledger.dependencies[matter.anchorBatchId] = true
    for (const member of this.membership(matter.id)) ledger.dependencies[member.batchId] = true
    for (const event of this.history(matter.id)) for (const id of [...event.evidence.map(ref => ref.batchId), ...(event.dependencies ?? [])]) ledger.dependencies[id] = true
  }
  candidates(batch: ProductionBatch, before?: number) {
    return this.store.atomic(() => { this.assertReadable(batch); const imported = this.importLegacy(batch), paginationRestartRequired = before !== undefined && imported.imported > 0
      const page = this.overview({ scope: this.scope(batch), before: paginationRestartRequired ? undefined : before, active: true }), ledger = this.ledger(batch)
      for (const matter of page.groups) if (!matter.redacted) this.recordRead(ledger, this.get(matter.id))
      this.store.set(reads(key(batch)), ledger)
      return { ...page, legacyRemaining: imported.remaining, paginationRestartRequired, legacyBoundary: 'Legacy local matters are imported in bounded pages without inferred links. Repeat candidates without before while legacyRemaining is true, then follow nextBefore. Imports during pagination restart at the latest page explicitly.' }
    })
  }
  /** Evidence is explicitly read in the current attempt, not borrowed from another attempt's read receipt. */
  context(batch: ProductionBatch, batchId: string, triggerId: string, offset = 0) {
    return this.store.atomic(() => {
      const source = this.batch(batchId); this.assertReadable(batch); this.assertReadable(source)
      if (this.scope(source) !== this.scope(batch) || (source.id !== batch.id && source.state !== 'completed')) throw new Error('Evidence receipt is not completed in this native scope')
      const context = source.contexts[triggerId]; if (!context) throw new Error('Unknown immutable evidence context')
      const ledger = this.ledger(batch), identity = `${source.id}:${source.generation}:${triggerId}`, previous = ledger.contexts[identity]
      if (!Number.isSafeInteger(offset) || offset < 0 || (offset !== 0 && (previous?.next !== offset || previous.hash !== context.manifest.hash || previous.revision !== context.revision))) throw new Error('Read matter evidence pages in order')
      const text = JSON.stringify(context.manifest), next = offset + 8000 < text.length ? offset + 8000 : null
      const same = !!previous && previous.hash === context.manifest.hash && previous.revision === context.revision
      const complete = same ? previous!.complete === true || previous!.next === null || next === null : next === null
      ledger.dependencies ??= {}; ledger.dependencies[source.id] = true
      ledger.contexts[identity] = { hash: context.manifest.hash, revision: context.revision, next, complete }; this.store.set(reads(key(batch)), ledger)
      return { batchId, generation: source.generation, triggerId, revision: context.revision, hash: context.manifest.hash, text: text.slice(offset, offset + 8000), next_offset: next }
    })
  }
  private validateEvidence(batch: ProductionBatch, refs: Evidence[], cache: Map<string, boolean>, complete: boolean) {
    const ledger = this.ledger(batch)
    for (const ref of refs) {
      const source = this.batch(ref.batchId), input = source.inputs.find(input => input.triggerId === ref.triggerId), context = source.contexts[ref.triggerId]
      this.assertReadable(source, cache)
      if (source.generation !== ref.generation || this.scope(source) !== this.scope(batch) || !input || !context || (source.id !== batch.id && source.state !== 'completed')) throw new Error('Foreign or stale matter evidence')
      const read = source.id === batch.id ? batch.reads?.[ref.triggerId] : ledger.contexts[`${source.id}:${source.generation}:${ref.triggerId}`]
      if (!read || !(read.complete === true || read.next === null) || read.hash !== context.manifest.hash || read.revision !== context.revision) throw new Error('Read exact matter evidence before linking')
      if (ref.kind === 'trigger') { if (ref.version !== input.identity.version || !['matched', 'unverified'].includes(context.manifest.anchor.status) || !context.manifest.anchor.contentMatch
        || complete && (input.identity.partial || context.manifest.anchor.observed?.partial)) throw new Error('Invalid, changed or insufficient trigger citation') }
      else {
        const message = context.manifest.messages.find(message => message.id === ref.messageId && message.version === ref.version)
          ?? (context.manifest.anchor.observed?.id === ref.messageId && context.manifest.anchor.observed.version === ref.version ? context.manifest.anchor.observed : undefined)
        if (ref.hash !== context.manifest.hash || ref.revision !== context.revision || !message || complete && message.partial || message.deleted || !message.text.trim()) throw new Error('Citation is not exact readable positive message evidence')
      }
    }
  }
  /** All observed summaries are potential model provenance, even when it proposes no explicit link. */
  provenance(batch: ProductionBatch) {
    // Keep direct roots, not a repeated transitive closure of a long continuation chain.
    const roots: string[] = [], visited = new Set<string>([batch.id])
    for (const id of Object.keys(this.ledger(batch).dependencies ?? {}).reverse()) {
      if (visited.has(id)) continue
      roots.push(id); const pending = [id]
      while (pending.length) {
        const current = pending.pop()!; if (visited.has(current)) continue; visited.add(current)
        const source = this.batch(current)
        for (const dependency of [...(source.matterProvenance ?? []), ...(source.result?.proposals ?? []).flatMap(proposal => proposal.evidence.map(ref => ref.batchId))]) if (!visited.has(dependency)) pending.push(dependency)
      }
    }
    return roots
  }
  /** Caller commits this projection and immutable coverage in one Store transaction. */
  apply(batch: ProductionBatch, proposals: Proposal[], legacy = false) {
    const local = batch.result?.matters ?? [], ids = new Set(proposals.map(proposal => proposal.localMatterId))
    if (ids.size !== proposals.length || proposals.some(proposal => !local.some(matter => matter.id === proposal.localMatterId))) throw new Error('Unknown or duplicate local matter proposal')
    const continued = proposals.filter(proposal => proposal.relation === 'continue').map(proposal => proposal.targetId)
    if (new Set(continued).size !== continued.length) throw new Error('One continue proposal per target per batch; combine local evidence before submitting')
    const readable = new Map<string, boolean>()
    if (!legacy) this.assertReadable(batch, readable)
    for (const item of local) {
      const id = memberId(batch, item.id); if (this.store.get(members(id))) { if (legacy) continue; throw new Error('Matter membership already committed') }
      const proposal = proposals.find(proposal => proposal.localMatterId === item.id)
      const refs: Evidence[] = proposal?.evidence ?? item.triggerIds.map(triggerId => ({ kind: 'trigger', batchId: batch.id, generation: batch.generation, triggerId, version: batch.inputs.find(input => input.triggerId === triggerId)!.identity.version }))
      const own = canonicalId(id), relation = proposal?.relation ?? 'new'
      let target: Matter | undefined
      if (proposal) {
        this.validateEvidence(batch, refs, readable, proposal.assessment === 'no_further_action_suggested')
        if (!refs.some(ref => ref.batchId === batch.id && item.triggerIds.includes(ref.triggerId))) throw new Error('Proposal requires current local matter evidence')
        if (relation !== 'new') {
          if (!proposal.targetId || !proposal.expectedRevision) throw new Error('Target and expected revision required')
          target = this.get(proposal.targetId)
          if (!this.isReadable(target, readable) || target.scope !== this.scope(batch)) throw new Error('Target scope or source permission changed')
          if (target.revision !== proposal.expectedRevision || this.ledger(batch).candidates[target.id] !== target.revision) throw new Error('Read current target revision before linking')
          const targetMembers = this.membership(target.id)
          if (!refs.some(ref => targetMembers.some(member => member.batchId === ref.batchId && this.batch(member.batchId).result?.matters.find(local => local.id === member.localMatterId)?.triggerIds.includes(ref.triggerId)))) throw new Error('Link requires exact prior target evidence')
        } else if (proposal.targetId || proposal.expectedRevision) throw new Error('New matter cannot specify a target')
      }
      const assessment = proposal?.assessment ?? (item.triggerIds.some(id => batch.result!.items.find(item => item.triggerId === id)?.kind === 'unknown') ? 'unknown' : item.triggerIds.some(id => batch.result!.items.find(item => item.triggerId === id)?.kind === 'suggested_action') ? 'suggested_action' : 'informational')
      if (proposal && assessment !== 'unknown' && item.triggerIds.some(id => batch.result!.items.find(item => item.triggerId === id)?.kind === 'unknown')) throw new Error('Unknown local evidence must remain an unknown projection')
      if (assessment === 'no_further_action_suggested' && !refs.some(ref => ref.kind === 'context' && ref.batchId === batch.id)) throw new Error('Changed suggestion requires cited positive current context evidence; absence cannot cancel')
      const matter: Matter = relation === 'continue' ? { ...target!, revision: target!.revision + 1, title: item.title, reason: proposal!.reason, assessment, updatedAt: batch.updatedAt }
        : { id: own, scope: this.scope(batch), revision: 1, title: item.title, reason: proposal?.reason ?? item.reason, assessment,
          anchorBatchId: batch.id, observedRevision: batch.evidenceRevision, createdAt: batch.createdAt, updatedAt: batch.updatedAt, ...(relation === 'related' ? { related: target!.id } : {}) }
      // Continuation intentionally retains the old observation watermark. Scalar revisions cannot prove all changes were read.
      const member: Member = { id, batchId: batch.id, generation: batch.generation, localMatterId: item.id, matterId: matter.id, originId: own }
      const event: Event = { id: hash([matter.id, matter.revision, id]), matterId: matter.id, revision: matter.revision, kind: relation, at: batch.updatedAt, memberId: id, reason: proposal?.reason ?? item.reason, evidence: refs }
      this.store.set(matters(matter.id), matter); this.store.set(members(id), member); this.store.set(events(event.id), event)
    }
  }
  private correctionDependencies(batch: ProductionBatch) {
    const dependencies = [...this.provenance(batch), batch.id], readable = new Map<string, boolean>()
    for (const id of dependencies) this.assertReadable(this.batch(id), readable)
    return dependencies
  }
  /** Undo one membership, preserving all original receipts. Split summaries are conservatively unknown. */
  split(batch: ProductionBatch, id: string, expectedRevision: number, member: string, reason: string) {
    return this.store.atomic(() => {
      this.assertReadable(batch)
      const operation = hash([key(batch), id, expectedRevision, member, reason]), previous = this.store.get(corrections(operation))
      if (previous) { const original = this.get(previous.original), separated = this.get(previous.separated); if (original.scope !== this.scope(batch) || !this.isReadable(original) || !this.isReadable(separated)) throw new Error('Correction evidence unavailable'); return { original: this.view(original), separated: this.view(separated) } }
      const target = this.get(id), link = this.store.get(members(member))
      if (!reason.trim() || reason.length > 700 || target.scope !== this.scope(batch) || !this.isReadable(target)) throw new Error('Invalid split scope or evidence')
      if (target.revision !== expectedRevision || this.ledger(batch).candidates[id] !== expectedRevision) throw new Error('Stale split revision')
      if (!link || link.matterId !== id || this.membership(id).length < 2) throw new Error('Split requires an existing multi-member matter')
      const dependencies = this.correctionDependencies(batch)
      const source = this.batch(link.batchId), local = source.result!.matters.find(item => item.id === link.localMatterId)!
      const newId = hash(['split', id, expectedRevision, member]), at = new Date().toISOString()
      const separate: Matter = { id: newId, scope: target.scope, revision: 1, title: local.title, reason: local.reason, assessment: 'unknown', anchorBatchId: source.id, createdAt: source.createdAt, updatedAt: at }
      link.matterId = newId; target.revision++; target.assessment = 'unknown'; target.title = 'Association revised; review evidence'; target.reason = reason; target.updatedAt = at; delete target.observedRevision
      const event: Event = { id: hash(['split', id, target.revision]), matterId: id, revision: target.revision, kind: 'split', at, memberId: member, reason, dependencies, evidence: [...new Map(this.history(id).flatMap(event => event.evidence).map(ref => [JSON.stringify(ref), ref])).values()] }
      this.store.set(matters(id), target); this.store.set(matters(newId), separate); this.store.set(members(member), link); this.store.set(events(event.id), event)
      this.store.set(events(hash([event.id, newId])), { ...event, id: hash([event.id, newId]), matterId: newId, revision: 1 })
      this.store.set(corrections(operation), { original: id, separated: newId })
      return { original: this.view(target), separated: this.view(separate) }
    })
  }
  retractRelated(batch: ProductionBatch, id: string, revision: number, reason: string) {
    return this.store.atomic(() => {
      this.assertReadable(batch); const matter = this.get(id), operation = hash([key(batch), id, revision, 'retract_related', reason])
      if (matter.scope !== this.scope(batch) || !this.isReadable(matter) || !reason.trim() || reason.length > 700) throw new Error('Related evidence unavailable')
      if (this.store.get(corrections(operation))) return this.view(matter)
      if (matter.revision !== revision || this.ledger(batch).candidates[id] !== revision || !matter.related) throw new Error('Stale or absent related link')
      const dependencies = this.correctionDependencies(batch)
      delete matter.related; matter.revision++; matter.updatedAt = new Date().toISOString()
      const event: Event = { id: operation, matterId: id, revision: matter.revision, kind: 'retract_related', at: matter.updatedAt, memberId: '', reason, dependencies, evidence: [...new Map(this.history(id).flatMap(event => event.evidence).map(ref => [JSON.stringify(ref), ref])).values()] }
      this.store.set(matters(id), matter); this.store.set(events(operation), event); this.store.set(corrections(operation), { original: id, separated: id })
      return this.view(matter)
    })
  }
  /** Keyset-page the immutable source receipts associated with work, across native conversation scopes. */
  workEvidence(target: MatterTarget, before = Number.MAX_SAFE_INTEGER, limit = 20) {
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid evidence page')
    const rows = this.store.db.prepare(`SELECT member.rowid AS cursor, member.value AS member, kv.value AS matter FROM kv AS member
      JOIN kv ON kv.key = 'triage-matter:' || json_extract(member.value, '$.matterId')
      WHERE member.key LIKE 'triage-matter-member:%' AND ${workMatch} AND member.rowid < ? ORDER BY member.rowid DESC LIMIT ?`)
      .all(JSON.stringify(this.workTargets(target)), before, limit + 1)
    const access = new Map<string, boolean>()
    return { items: rows.slice(0, limit).map(row => {
      const member = JSON.parse(String(row.member)) as Member, matter = JSON.parse(String(row.matter)) as Matter
      if (!access.has(matter.id)) access.set(matter.id, this.isReadable(matter))
      const readable = access.get(matter.id)!
      const batch = readable ? this.batch(member.batchId) : undefined
      const local = batch?.result?.matters.find(item => item.id === member.localMatterId)
      const input = batch?.inputs.find(item => local?.triggerIds.includes(item.triggerId))
      const trigger = input && this.store.triggers.get(input.triggerId)
      const anchor = input && batch?.contexts[input.triggerId]?.manifest.anchor
      return { reference: member.id, matterId: matter.id, revision: matter.revision, redacted: !readable,
        ...(readable ? { title: matter.title, assessment: matter.assessment } : {}),
        ...(input && trigger ? { provider: input.identity.provider, header: this.header?.(trigger) ?? { at: trigger.at },
          partial: input.partial || !!anchor?.observed?.partial, ...(anchor ? { anchorStatus: anchor.status } : {}),
          ...(anchor?.observed?.text ? { excerpt: anchor.observed.text.slice(0, 500) } : {}), ...(trigger.url ? { url: trigger.url } : {}) } : {}) }
    }), next_offset: rows.length > limit ? Number(rows[limit - 1]!.cursor) : null }
  }
  /** Read an immutable receipt after rechecking current Source access and its work association. */
  readEvidence(reference: string, target?: MatterTarget) {
    const member = this.store.get(members(reference))
    if (!member) throw new Error('Unknown evidence reference')
    const matter = this.get(member.matterId)
    if (!this.isReadable(matter)) throw new Error('Evidence Source access changed')
    if (target && !this.workTargets(target).some(work => work.kind === matter.handoff?.kind && work.id === matter.handoff.id)) throw new Error('Evidence is not associated with this work')
    const batch = this.batch(member.batchId), local = batch.result?.matters.find(item => item.id === member.localMatterId)
    if (batch.state !== 'completed' || batch.generation !== member.generation || !local) throw new Error('Evidence receipt changed')
    return { reference, batchId: batch.id, generation: batch.generation, recordedAt: batch.updatedAt,
      inputs: local.triggerIds.map(id => {
        const input = batch.inputs.find(item => item.triggerId === id), trigger = this.store.triggers.get(id), context = batch.contexts[id]
        if (!input || !trigger || !context) throw new Error('Evidence receipt is incomplete')
        return { triggerId: id, identity: input.identity, text: input.text, partial: input.partial,
          header: this.header?.(trigger) ?? { at: trigger.at }, ...(trigger.url ? { url: trigger.url } : {}), context: context.manifest }
      }) }
  }
  /** Atomically associate readable evidence and, for a Ticket, save its context note once. */
  handoff(id: string, revision: number, target: MatterTarget, reason: string, deliver?: () => string): MatterHandoffReceipt {
    return this.store.atomic(() => {
      const matter = this.get(id)
      if (!this.isReadable(matter) || !this.membership(id).length) throw new Error('Matter evidence is unavailable')
      if (!reason.trim() || reason.length > 2000) throw new Error('Provide a bounded handoff reason')
      const destination = target.kind === 'ticket' ? this.store.tickets.get(target.id) : readLine(this.store, target.id)
      if (!destination) throw new Error('Unknown handoff destination')
      const operation = hash(['handoff', id, revision, target.kind, target.id, reason]), previous = this.store.get(events(operation))
      if (previous?.handoff) return { matterId: id, revision: previous.revision, target, reused: true,
        ...(previous.handoff.inputId ? { inputId: previous.handoff.inputId } : {}) }
      if (matter.revision !== revision) throw new Error('Read the current matter revision before handoff')
      const inputId = deliver?.(), at = new Date().toISOString()
      matter.handoff = { ...target, at, reason, ...(inputId ? { inputId } : {}) }
      matter.revision++; matter.updatedAt = at
      this.store.set(matters(id), matter)
      this.store.set(events(operation), { id: operation, matterId: id, revision: matter.revision, kind: 'handoff', at,
        memberId: '', reason, evidence: [], handoff: { ...target, ...(inputId ? { inputId } : {}) } })
      return { matterId: id, revision: matter.revision, target, reused: false, ...(inputId ? { inputId } : {}) }
    })
  }
  detail(batch: ProductionBatch, id: string, before?: number) {
    return this.store.atomic(() => {
    const matter = this.get(id); this.assertReadable(batch)
    if (matter.scope !== this.scope(batch)) throw new Error('Foreign matter scope')
    const view = this.view(matter)
    if (view.redacted) return { ...view, events: [], nextBefore: null }
    const cursor = before ?? Number.MAX_SAFE_INTEGER
    if (!Number.isSafeInteger(cursor) || cursor < 1) throw new Error('Invalid matter history page')
    const ledger = this.ledger(batch); this.recordRead(ledger, matter); this.store.set(reads(key(batch)), ledger)
    const rows = this.store.db.prepare("SELECT rowid AS cursor, value FROM kv WHERE key LIKE 'triage-matter-event:%' AND json_extract(value, '$.matterId') = ? AND rowid < ? ORDER BY rowid DESC LIMIT 26").all(id, cursor)
    return { ...view, events: rows.slice(0, 25).map(row => {
      const event = JSON.parse(String(row.value)) as Event, member = this.store.get(members(event.memberId))
      const local = member ? this.batch(member.batchId).result?.matters.find(local => local.id === member.localMatterId) : undefined
      return { ...event, ...(member ? { member } : {}), contexts: member ? this.contextWarnings(member) : [], ...(local ? { local } : {}) }
    }), nextBefore: rows.length > 25 ? Number(rows[24]!.cursor) : null }
    })
  }
}
