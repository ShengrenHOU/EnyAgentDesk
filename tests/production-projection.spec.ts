/** Full-history summary and stable bounded page traversal, without any source/business writes. */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { productionOverview, type ProductionBatch } from '../src/app/production-triage.ts'
import type { Trigger } from '../src/core/index.ts'
let store: Store, directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'projection-')); store = new Store(join(directory, 'state.sqlite')) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const evidence = (trigger: Trigger) => ({ provider: 'test', account: 'a', conversation: 'private chat', message: trigger.id, version: '1', partial: false, configuration: '1' })
function add(id: string, state: ProductionBatch['state'] = 'queued', kind = 'unknown', at = '2026-11-09T00:00:00.000Z') {
  const trigger: Trigger = { id, source: 'test', threads: [], at, actor: { source: 'test', id: 'person' }, human: true, text: 'private text', meta: {} }
  store.triggers.save(trigger)
  store.triggers.saveDisposition(id, { at, fanout: [], triage: { owner: id, generation: 1, heldAt: at, phase: state === 'completed' ? 'triaged' : 'production', batchId: id } })
  const batch = { id, owner: id, ownerGeneration: 1, generation: 1, state, createdAt: at, updatedAt: at,
    window: { start: at, end: at }, inputs: [{ triggerId: id, fingerprint: createHash('sha256').update(JSON.stringify({ trigger, evidence: evidence(trigger) })).digest('hex'), identity: evidence(trigger), text: trigger.text }],
    contexts: {}, result: { items: [{ triggerId: id, kind, reason: 'private reason' }], matters: [] } }
  store.db.prepare('INSERT INTO kv VALUES (?, ?)').run(`triage-production:${id}`, JSON.stringify(batch))
}
it('traverses more than 100 receipts without omissions even with inserts and updates between pages', () => {
  for (let i = 0; i < 107; i++) add(String(i))
  const first = productionOverview(store, evidence)
  expect(first.groups).toHaveLength(50); expect(first.total).toBe(107); expect(first.unresolved.messages).toBe(107)
  add('new')
  store.db.prepare("UPDATE kv SET value=json_set(value, '$.updatedAt', '2026-11-10') WHERE key='triage-production:70'").run()
  const second = productionOverview(store, evidence, { before: first.nextBefore! })
  const last = productionOverview(store, evidence, { before: second.nextBefore! })
  const ids = [...first.groups, ...second.groups, ...last.groups].map(group => group.id)
  expect(new Set(ids).size).toBe(107); expect(last.groups).toHaveLength(7); expect(last.nextBefore).toBeNull()
  expect(last.unresolved.messages).toBe(108)
})
it('counts all unresolved states and oldest current evidence, excluding transferred or resolved inputs', () => {
  add('queued', 'queued', 'unknown', '2026-10-01T00:00:00.000Z')
  add('preparing', 'preparing'); add('awaiting', 'awaiting'); add('blocked', 'blocked')
  add('unknown', 'completed'); add('suggested', 'completed', 'suggested_action')
  add('info', 'completed', 'informational'); add('none', 'completed', 'none'); add('rolled', 'rolled_back')
  add('old-owner', 'blocked', 'unknown', '2020-01-01T00:00:00.000Z')
  store.triggers.saveDisposition('old-owner', { at: '', fanout: [], triage: { owner: 'replacement', generation: 2, heldAt: '', batchId: 'old-owner', phase: 'production' } })
  const view = productionOverview(store, evidence, { limit: 1 })
  expect(view.unresolved).toEqual({ groups: 6, messages: 6, queued: 1, preparing: 1, awaiting: 1, blocked: 1, unknown: 1, suggested_action: 1, oldestAt: '2026-10-01T00:00:00.000Z' })
  expect(view.groups[0]).toMatchObject({ historical: true, messages: 0 })
})
it('retains non-content unresolved diagnostics on revocation while redacting every page', () => {
  add('unknown', 'completed'); add('blocked', 'blocked')
  const first = productionOverview(store, () => undefined, { limit: 1 })
  const second = productionOverview(store, () => undefined, { before: first.nextBefore!, limit: 1 })
  for (const page of [first, second]) {
    expect(page.unresolved.messages).toBe(2)
    expect(page.groups[0]!.redacted).toBe(true)
    expect(JSON.stringify(page)).not.toContain('private')
  }
})
it('reports no phantom next page at exactly the limit and rejects invalid cursors', () => {
  add('a'); add('b')
  expect(productionOverview(store, evidence, { limit: 2 })).toMatchObject({ limited: false, nextBefore: null })
  expect(() => productionOverview(store, evidence, { before: -1 })).toThrow('Invalid')
})

it('shows newer observed evidence without treating the old receipt as a fresh judgment', async () => {
  const { observeImEvidence } = await import('../src/app/im-evidence-revisions.ts')
  add('old', 'completed', 'informational')
  store.db.prepare("UPDATE kv SET value=json_set(value, '$.evidenceRevision', 0) WHERE key='triage-production:old'").run()
  expect(productionOverview(store, evidence).groups[0]!.newerKnownEvidence).toBe(false)
  observeImEvidence(store, { ...evidence(store.triggers.get('old')!), message: 'new' })
  const view = productionOverview(store, evidence)
  expect(view.groups[0]).toMatchObject({ state: 'completed', newerKnownEvidence: true, counts: { informational: 1 } })
  expect(view.unresolved.messages).toBe(0)
})
