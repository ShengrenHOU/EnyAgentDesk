/** Upgrade the original single-repository identities without changing ticket or receipt IDs. */
import type { Store } from './store.ts'
import { githubRepository } from '../sources/github-trigger.ts'

const marker = 'github-identity-repository'
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export function migrateGithubIdentity(store: Store, repository: string): void {
  const repo = repository.toLowerCase()
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Cannot migrate GitHub state without its original repository')
  if (store.get(marker)) return
  const threadKey = (value: string) => /^github:(?:[1-9]\d*|ci:.+)$/.test(value) ? `github:${repo}:${value.slice(7)}` : value
  const rewrite = (value: Json, field = ''): Json => {
    if (typeof value === 'string') return ['thread', 'threadKey', 'correlated', 'context'].includes(field) ? threadKey(value) : value
    if (Array.isArray(value)) return value.map(item => rewrite(item, field))
    if (!value || typeof value !== 'object') return value
    const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, key)]))
    if (value.source === 'github' && (field === 'ref' || field === 'threads') && typeof value.id === 'string'
      && /^(?:[1-9]\d*|ci:.+)$/.test(value.id)) result.id = `${repo}:${value.id}`
    if (value.source === 'github' && value.address && typeof value.address === 'object' && !Array.isArray(value.address)) {
      const address = value.address
      const named = typeof address.url === 'string' ? githubRepository(address.url) : undefined
      if (named && named !== repo) throw new Error('Legacy GitHub channel contradicts the original repository; reconcile before migration')
      result.address = { ...address, repository: repo }
    }
    return result
  }
  store.atomic(() => {
    for (const thread of store.threads.list()) {
      const next = threadKey(thread.key)
      if (next !== thread.key && store.threads.get(next)) throw new Error(`GitHub migration target already exists: ${next}`)
    }
    for (const table of ['thread', 'ticket', 'trigger', 'decision', 'outbox', 'effect'] as const) {
      for (const row of store.db.prepare(`SELECT rowid AS row, value FROM ${table}`).all()) {
        const previous = JSON.parse(String(row.value)) as { [key: string]: Json }
        const value = rewrite(previous) as { [key: string]: Json }
        if (table === 'thread' && typeof previous.key === 'string') {
          value.key = threadKey(previous.key)
          if (value.key !== previous.key) value.meta = { ...previous.meta as object, repository: repo } as Json
        }
        if (table === 'trigger' && previous.source === 'github') {
          const meta = previous.meta as { [key: string]: Json }
          const named = typeof previous.url === 'string' ? githubRepository(previous.url) : undefined
          if (named && named !== repo) throw new Error('Legacy GitHub trigger contradicts the original repository')
          value.meta = { ...meta, repository: repo }
        }
        if (table === 'thread') store.db.prepare('UPDATE thread SET key=?,value=? WHERE rowid=?').run(String(value.key), JSON.stringify(value), Number(row.row))
        else if (table === 'decision') store.db.prepare('UPDATE decision SET thread=?,value=? WHERE rowid=?').run(String(value.threadKey ?? value.thread ?? ''), JSON.stringify(value), Number(row.row))
        else store.db.prepare(`UPDATE ${table} SET value=? WHERE rowid=?`).run(JSON.stringify(value), Number(row.row))
      }
    }
    for (const row of store.db.prepare('SELECT rowid AS row, thread FROM trigger_thread').all()) {
      store.db.prepare('UPDATE trigger_thread SET thread=? WHERE rowid=?').run(threadKey(String(row.thread)), Number(row.row))
    }
    for (const key of store.keys('github-')) {
      if (!/^github-(?:since$|retry$|cursor:|stream:|branch-ci$|ci:)/.test(key)) continue
      const target = `github-repository:${repo}:${key}`
      if (store.get(target) !== undefined) throw new Error(`GitHub checkpoint already exists: ${target}`)
      store.set(target, store.get(key)); store.delete(key)
    }
    store.set(marker, repo)
  })
}
