/** Existing projections reused by isolated read jobs over the canonical database. */
import type { Store } from './store.ts'
import { detail, linesView, type LinesView } from './lines.ts'
import { TriageMatters, type MatterTarget } from './triage-matters.ts'
import { productionOverview } from './production-triage.ts'
import type { Trigger } from '../core/model.ts'
import type { ImEvidence, ImMessageHeader } from '../sources/kind.ts'

export interface HistoricalStats {
  received: number; filtered: number; triggers: number; judged: number; accepted: number; dropped: number
}
export interface ReadResults {
  stats: HistoricalStats; lines: LinesView
  matters: ReturnType<TriageMatters['overview']>; production: ReturnType<typeof productionOverview>
  history: { stats: HistoricalStats; matters: ReadResults['matters']; production: ReadResults['production'] }
  evidence: ReturnType<TriageMatters['workEvidence']>; line: ReturnType<typeof detail>
}
export interface ReadPage { before?: number; limit?: number; unresolved?: boolean; active?: boolean; target?: MatterTarget; id?: string }
export interface EvidenceAccess { evidence?: ImEvidence & { configuration: string }; header?: ImMessageHeader }
export type ReadAccess = (trigger: Trigger) => EvidenceAccess
export function historicalStats(store: Store, at = Date.now()): HistoricalStats {
  const since = new Date(at - 86_400_000).toISOString(), rows = Object.values(store.read.triggerStats(since))
  const received = rows.reduce((total, row) => total + row.received, 0), filtered = rows.reduce((total, row) => total + row.filtered, 0)
  return { received, filtered, triggers: received - filtered, ...store.read.flow(since), dropped: store.read.droppedSince(since) }
}
export function readModel(store: Store, kind: keyof ReadResults, at: number, page: ReadPage = {}, access: ReadAccess = () => ({})): ReadResults[keyof ReadResults] {
  const evidence = (trigger: Trigger) => access(trigger).evidence, header = (trigger: Trigger) => access(trigger).header ?? { at: trigger.at }
  switch (kind) {
    case 'stats': return historicalStats(store, at)
    case 'lines': return linesView(store, new Date(at))
    case 'matters': return new TriageMatters(store, evidence, header).overview(page)
    case 'production': return productionOverview(store, evidence, page, header)
    case 'evidence': {
      if (!page.target) throw new Error('Evidence view requires a work target')
      return new TriageMatters(store, evidence, header).workEvidence(page.target, page.before)
    }
    case 'line': {
      if (!page.id) throw new Error('Line view requires its identity')
      return detail(store, page.id, new Date(at))
    }
    case 'history': return { stats: historicalStats(store, at), matters: new TriageMatters(store, evidence, header).overview(),
      production: productionOverview(store, evidence, {}, header) }
  }
}
