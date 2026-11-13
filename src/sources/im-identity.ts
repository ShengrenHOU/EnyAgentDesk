/**
 * Canonical, read-only identity for IM evidence.
 *
 * A reader account is how an observation reached this system, not what the observed object is. The same Feishu
 * message seen through the bot channel and the user-identity collector therefore keeps one object, one message and
 * one version key; each observation still records its own account, source configuration and Trigger.
 */
import { createHash } from 'node:crypto'
import type { ImEvidence } from './kind.ts'

const digest = (value: readonly string[]): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** A native conversation, independent of which configured reader observed it. */
export interface ImObjectRef { provider: string; conversation: string }

/** Stable identity of the conversation itself. */
export const imObjectId = (ref: ImObjectRef): string => digest(['im-object-v1', ref.provider, ref.conversation])

/** Stable identity of one native message across edits and reader channels. */
export const imMessageId = (ref: ImObjectRef, message: string): string =>
  digest(['im-message-v1', imObjectId(ref), message])

/** The exact native version of one message; repeated reads of this version deduplicate. */
export const imDedupKey = (ref: ImObjectRef, message: string, version: string): string =>
  digest(['im-version-v1', imMessageId(ref, message), version])

/**
 * Observation scope used by existing evidence watermarks and matter grouping. It intentionally retains the
 * original formula (provider, account, conversation) so persisted revisions keep their meaning; it is provenance,
 * not the object identity above.
 */
export const imObservationScope = (identity: Pick<ImEvidence, 'provider' | 'account' | 'conversation'>): string =>
  digest([identity.provider, identity.account, identity.conversation])

/** Per-observation version key, retaining the original formula for persisted evidence records. */
export const imObservationDedup = (scope: string, message: string, version: string): string =>
  digest([scope, message, version])
