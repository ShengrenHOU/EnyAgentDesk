/** Automatic read-only IM ownership, bounded accumulation and restart-safe legacy capture. */
import { createHash } from 'node:crypto'
import type { Engine, Trigger } from '../core/index.ts'
import { family, record } from '../kv.ts'
import type { ImEvidence } from '../sources/kind.ts'
import type { Store } from './store.ts'
import type { TriageHandoffs } from './triage-handoffs.ts'
import type { ProductionTriage } from './production-triage.ts'
import { imScope, observeImEvidence } from './im-evidence-revisions.ts'
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Lane = 'live' | 'historical'
interface Group {
  owner: string; scope: string; source: string; lane: Lane; state: 'open' | 'sealed' | 'transferred' | 'blocked' | 'released'
  ids: string[]; firstAt: string; lastAt: string; oldestAt: string; newestAt: string; chars: number; fingerprint: string; problem?: string
}
interface Scan { highwater: number; nextHighwater?: number; cursor: number; scanned: number; captured: number; skipped: Record<string, number>; completedAt?: string; nextSweep?: string }
const scanKey = record<Scan>('automatic-triage-scan')
const turnKey = record<{ lane: Lane; sequence: number }>('automatic-triage-turn')
const groups = family<Group>('automatic-triage-group:')
const claimed = family<string>('automatic-triage-claimed:')
const served = family<number>('automatic-triage-served:')
interface Host {
  store: Store; engine: Engine; handoffs: TriageHandoffs; production: ProductionTriage
  evidence(trigger: Trigger): (ImEvidence & { configuration: string }) | undefined
  enabled(): boolean; historical(): boolean; paused(): boolean; policy(): string; prompt(): string; now?(): string
}
const PAGE = 32, MAX_INPUTS = 8, MAX_CHARS = 32_000, DEBOUNCE = 2000, MAX_WAIT = 10_000
/** Owns automatic C1 accumulation and bounded historical capture; all model work stays in ProductionTriage. */
export class AutomaticTriage {
  constructor(private readonly host: Host) {
    if (!host.engine.usesRepositories(host.store)) throw new Error('Automatic triage requires one Store')
    // Capture a fixed epoch boundary before new source input; an unfinished epoch never moves on restart.
    if (host.enabled()) host.store.atomic(() => {
      const previous = host.store.get(scanKey), highwater = Number(host.store.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM trigger').get()!.n)
      if (!previous) host.store.set(scanKey, { highwater, cursor: 0, scanned: 0, captured: 0, skipped: {} })
      else if (previous.cursor >= previous.highwater && highwater > previous.highwater) host.store.set(scanKey, { highwater, cursor: previous.highwater, scanned: 0, captured: 0, skipped: {} })
      else if (highwater > previous.highwater) host.store.set(scanKey, { ...previous, nextHighwater: Math.max(previous.nextHighwater ?? 0, highwater) })
    })
  }
  private now() { return this.host.now?.() ?? new Date().toISOString() }
  private snapshot(ids: string[]) {
    return hash({ settings: { ...this.host.store.settings(), paused: false }, policy: this.host.policy(), prompt: this.host.prompt(),
      inputs: ids.map(id => { const trigger = this.host.store.triggers.get(id); return { trigger, evidence: trigger && this.host.evidence(trigger) } }) })
  }
  /** Called inside receive's Store transaction, before Passes can synchronously request an Eval. */
  receive(trigger: Trigger) {
    return this.host.store.atomic(() => {
      const result = this.host.engine.receive(trigger)
      if (result !== 'stored') return result
      const stored = this.host.store.triggers.get(trigger.id)!, evidence = this.host.evidence(stored)
      if (evidence) observeImEvidence(this.host.store, evidence)
      if (!this.host.enabled()) return result
      // Pausing suspends dispatch, not durable ownership of arriving passive evidence.
      this.capture(stored.id, Date.parse(stored.at) < Date.parse(this.now()) - 3_600_000 ? 'historical' : 'live')
      return result
    })
  }
  /** Per-trigger scheduling fence; explicit messages on the same core Thread still enter their reserved lane. */
  defer(trigger: Trigger) {
    if (!this.host.enabled() || !this.host.historical() || this.host.store.get(claimed(trigger.id))) return false
    const scan = this.host.store.get(scanKey)
    const row = this.host.store.db.prepare('SELECT rowid FROM trigger WHERE id=?').get(trigger.id)
    return !!scan && !!row && Number(row.rowid) <= Math.max(scan.highwater, scan.nextHighwater ?? 0) && this.host.handoffs.preview([trigger.id]).entries[0]?.eligible === true
  }
  private capture(id: string, lane: Lane) {
    const { store, handoffs } = this.host
    if (store.get(claimed(id))) return 'previous_capture'
    const preview = handoffs.preview([id])
    if (!preview.entries[0]?.eligible) return preview.entries[0]?.reason ?? 'missing'
    const trigger = store.triggers.get(id)!, evidence = this.host.evidence(trigger)!
    const scope = imScope(evidence), source = hash([evidence.provider, evidence.account]), now = this.now()
    const row = store.db.prepare("SELECT value FROM kv WHERE key LIKE 'automatic-triage-group:%' AND value ->> '$.scope' = ? AND value ->> '$.lane' = ? AND value ->> '$.state' = 'open' ORDER BY rowid LIMIT 1").get(scope, lane)
    let group = row ? JSON.parse(String(row.value)) as Group : undefined
    if (group && (group.fingerprint !== this.snapshot(group.ids) || handoffs.read(group.owner).state !== 'held')) {
      group.state = handoffs.read(group.owner).state === 'released' ? 'released' : 'blocked'; group.problem = 'Source, settings, policy, prompt or ownership changed; explicit recovery required'
      store.set(groups(group.owner), group); group = undefined
    }
    const chars = Buffer.byteLength(trigger.text.slice(0, 4000), 'utf8')
    if (group && (group.ids.length >= MAX_INPUTS || group.chars + chars > MAX_CHARS ||
      Math.max(Date.parse(trigger.at), Date.parse(group.newestAt)) - Math.min(Date.parse(trigger.at), Date.parse(group.oldestAt)) > 6 * 86_400_000 || Date.parse(now) - Date.parse(group.firstAt) >= MAX_WAIT)) {
      group.state = 'sealed'; store.set(groups(group.owner), group); group = undefined
    }
    if (!group) {
      const owner = `auto_${hash([id, preview.fingerprint])}`
      handoffs.adopt(owner, [id], preview.fingerprint)
      group = { owner, scope, source, lane, state: 'open', ids: [id], firstAt: now, lastAt: now, oldestAt: trigger.at, newestAt: trigger.at, chars, fingerprint: this.snapshot([id]) }
    } else {
      handoffs.append(group.owner, [id], preview.fingerprint); group.ids.push(id); group.chars += chars
      group.oldestAt = [group.oldestAt, trigger.at].sort()[0]!; group.newestAt = [group.newestAt, trigger.at].sort()[1]!
      group.lastAt = now; group.fingerprint = this.snapshot(group.ids)
    }
    if (group.ids.length >= MAX_INPUTS || group.chars >= MAX_CHARS) group.state = 'sealed'
    store.set(claimed(id), group.owner)
    store.set(groups(group.owner), group); observeImEvidence(store, evidence)
    return 'captured'
  }
  /** One bounded local page, no native/network/model reads and no whole-backlog transaction. */
  private migrate() {
    if (!this.host.historical()) return
    this.host.store.atomic(() => {
      const { store } = this.host, scan = store.get(scanKey)
      if (!scan) return
      const now = this.now()
      if (scan.cursor >= scan.highwater && (scan.nextHighwater ?? 0) > scan.highwater) {
        scan.highwater = scan.nextHighwater!; delete scan.nextHighwater; delete scan.completedAt; delete scan.nextSweep
        scan.scanned = 0; scan.captured = 0; scan.skipped = {}
      }
      if (scan.cursor >= scan.highwater) {
        if (!scan.completedAt) { scan.completedAt = now; scan.nextSweep = new Date(Date.parse(now) + 60_000).toISOString(); store.set(scanKey, scan); return }
        if (scan.nextSweep && scan.nextSweep > now) return
        scan.highwater = Number(store.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM trigger').get()!.n)
        scan.cursor = 0; scan.scanned = 0; scan.captured = 0; scan.skipped = {}; delete scan.completedAt
      }
      const rows = store.db.prepare('SELECT rowid,id FROM trigger WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?').all(scan.cursor, scan.highwater, PAGE)
      const deadline = performance.now() + 25
      let processed = 0
      for (const row of rows) {
        if (processed && performance.now() >= deadline) break
        processed++
        const outcome = this.capture(String(row.id), 'historical')
        scan.cursor = Number(row.rowid); scan.scanned++
        if (outcome === 'captured') scan.captured++; else scan.skipped[outcome] = (scan.skipped[outcome] ?? 0) + 1
      }
      if ((rows.length < PAGE && processed === rows.length) || scan.cursor >= scan.highwater) { scan.cursor = scan.highwater; scan.completedAt = now; scan.nextSweep = new Date(Date.parse(now) + 60_000).toISOString() }
      store.set(scanKey, scan)
    })
  }
  /** Fair sealed accumulation dispatch, with at most one waiting production batch ahead of the active one. */
  maintain() {
    if (!this.host.enabled() || this.host.paused()) return
    this.migrate()
    this.host.store.atomic(() => {
      const { store, handoffs, production } = this.host
      if (store.db.prepare("SELECT 1 FROM kv WHERE key LIKE 'triage-production:%' AND value ->> '$.state' = 'queued' LIMIT 1").get()) return
      const turn = store.get(turnKey) ?? { lane: 'historical' as Lane, sequence: 0 }, now = this.now()
      const debounce = new Date(Date.parse(now) - DEBOUNCE).toISOString(), maxWait = new Date(Date.parse(now) - MAX_WAIT).toISOString()
      const row = store.db.prepare(`SELECT g.value FROM kv g
        LEFT JOIN kv source ON source.key = 'automatic-triage-served:source:' || (g.value ->> '$.source')
        LEFT JOIN kv conversation ON conversation.key = 'automatic-triage-served:conversation:' || (g.value ->> '$.scope')
        WHERE g.key LIKE 'automatic-triage-group:%' AND (g.value ->> '$.state' = 'sealed' OR
          (g.value ->> '$.state' = 'open' AND (g.value ->> '$.lastAt' <= ? OR g.value ->> '$.firstAt' <= ?)))
        ORDER BY (g.value ->> '$.lane' = ?) ASC, COALESCE(CAST(source.value AS INTEGER),0),
          COALESCE(CAST(conversation.value AS INTEGER),0), g.value ->> '$.oldestAt', g.key LIMIT 1`).get(debounce, maxWait, turn.lane)
      if (!row) return
      const group = JSON.parse(String(row.value)) as Group
      if (handoffs.read(group.owner).state === 'released') { group.state = 'released'; store.set(groups(group.owner), group); return }
      if (group.fingerprint !== this.snapshot(group.ids)) {
        group.state = 'blocked'; group.problem = 'Source, settings, policy or prompt changed; held evidence retained for explicit recovery'
        store.set(groups(group.owner), group); return
      }
      const end = new Date(Math.max(Date.parse(group.newestAt) + 1000, Math.min(Date.parse(now), Date.parse(group.oldestAt) + 6 * 86_400_000))).toISOString()
      const start = new Date(Date.parse(group.oldestAt) - 86_400_000 + 1000).toISOString()
      production.start(group.owner, handoffs.read(group.owner).generation, { start, end }, true)
      group.state = 'transferred'; store.set(groups(group.owner), group)
      store.set(turnKey, { lane: group.lane, sequence: turn.sequence + 1 })
      store.set(served(`source:${group.source}`), turn.sequence + 1); store.set(served(`conversation:${group.scope}`), turn.sequence + 1)
    })
  }
  /** Explicit bounded operator recovery, never an automatic reclassification or source acknowledgment. */
  recover(owners: { owner: string; generation: number }[], action: 'retry' | 'release') {
    if (!owners.length || owners.length > 20 || new Set(owners.map(item => item.owner)).size !== owners.length) throw new Error('Choose 1..20 distinct owners')
    return this.host.store.atomic(() => owners.map(({ owner, generation }) => {
      const { store, handoffs } = this.host, group = store.get(groups(owner)), manifest = handoffs.read(owner)
      if (!group || manifest.generation !== generation || manifest.state !== 'held' || !['open', 'sealed', 'blocked'].includes(group.state)) throw new Error('Owner is not an unfinished accumulation; use production recovery if transferred')
      if (action === 'release') { handoffs.release(owner, generation); group.state = 'released' }
      else {
        for (const id of group.ids) {
          const trigger = store.triggers.get(id), marker = store.triggers.disposition(id)?.triage
          if (!trigger || !this.host.evidence(trigger) || marker?.owner !== owner || marker.generation !== generation || marker.phase) throw new Error('Source or exclusive owner is unavailable')
        }
        group.fingerprint = this.snapshot(group.ids); group.state = 'sealed'; delete group.problem
      }
      store.set(groups(owner), group)
      return { owner, generation, state: group.state, messages: group.ids.length }
    }))
  }
  status(after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid intake cursor')
    const { store } = this.host
    const rows = store.db.prepare("SELECT value ->> '$.state' AS state, COUNT(*) AS groups, SUM(json_array_length(value,'$.ids')) AS messages, MIN(value ->> '$.oldestAt') AS oldestAt FROM kv WHERE key LIKE 'automatic-triage-group:%' GROUP BY state").all()
    const page = store.db.prepare("SELECT rowid,value FROM kv WHERE key LIKE 'automatic-triage-group:%' AND value ->> '$.state' IN ('open','sealed','blocked') AND rowid > ? ORDER BY rowid LIMIT 51").all(after)
    const owners = page.slice(0, 50).map(row => { const group = JSON.parse(String(row.value)) as Group; return { owner: group.owner, generation: this.host.handoffs.read(group.owner).generation, state: group.state, lane: group.lane, messages: group.ids.length, oldestAt: group.oldestAt, problem: group.problem } })
    return { owners, next: page.length > 50 ? Number(page[49]!.rowid) : null, enabled: this.host.enabled(), historical: this.host.historical(), scan: store.get(scanKey), groups: rows, contextComplete: false as const }
  }
}
