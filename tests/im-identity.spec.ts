/** Canonical IM identity is independent of the reader channel but keeps observation provenance for existing records. */
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { imDedupKey, imMessageId, imObjectId, imObservationDedup, imObservationScope } from '../src/sources/im-identity.ts'

const sha = (parts: readonly string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const feishu = { provider: 'feishu-messages', conversation: 'oc_one' }
const wechat = { provider: 'wechat', conversation: 'wxid_one' }

it('keeps one object, message and version identity across reader accounts', () => {
  const bot = { provider: 'feishu-messages', account: 'cli_bot', conversation: 'oc_one', message: 'om_one', version: 'v1', partial: false }
  const user = { ...bot, account: 'ou_owner' }
  expect(imObservationScope(bot)).not.toBe(imObservationScope(user))
  expect(imObjectId(bot)).toBe(imObjectId(user))
  expect(imMessageId(bot, bot.message)).toBe(imMessageId(user, user.message))
  expect(imDedupKey(bot, bot.message, bot.version)).toBe(imDedupKey(user, user.message, user.version))
})

it('keeps a message identity across versions and changes the dedup key on an actual edit', () => {
  expect(imMessageId(feishu, 'om_one')).toBe(imMessageId(feishu, 'om_one'))
  expect(imDedupKey(feishu, 'om_one', 'v1')).not.toBe(imDedupKey(feishu, 'om_one', 'v2'))
  expect(imDedupKey(feishu, 'om_one', 'v1')).toBe(imDedupKey(feishu, 'om_one', 'v1'))
})

it('separates providers, conversations, messages and versions', () => {
  const keys = new Set([imObjectId(feishu), imObjectId(wechat),
    imMessageId(feishu, 'om_one'), imMessageId(feishu, 'om_two'),
    imDedupKey(feishu, 'om_one', 'v1'), imDedupKey(feishu, 'om_one', 'v2')])
  expect(keys.size).toBe(6)
  for (const key of keys) expect(key).toMatch(/^[a-f0-9]{64}$/)
})

it('retains the persisted observation formulas so existing revision watermarks keep their meaning', () => {
  const identity = { provider: 'wechat', account: 'wx-account', conversation: 'wxid_one', message: 'wx1.one', version: 'v1', partial: false }
  const scope = sha(['wechat', 'wx-account', 'wxid_one'])
  expect(imObservationScope(identity)).toBe(scope)
  expect(imObservationDedup(scope, 'wx1.one', 'v1')).toBe(sha([scope, 'wx1.one', 'v1']))
})
