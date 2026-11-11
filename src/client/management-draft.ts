/**
 * Draft state for a Ticket's management fields: local edits survive polling, unedited fields follow the server, and a field
 * changed in both places keeps both values until the owner chooses.
 */
import type { TicketPageView } from './api.ts'

export type ManagementPriority = 'low' | 'normal' | 'high' | 'urgent'
export interface ManagementValues { priority: ManagementPriority; dueAt: string; paused: boolean }
export type ManagementField = keyof ManagementValues
export const MANAGEMENT_FIELDS: readonly ManagementField[] = ['priority', 'dueAt', 'paused']
export type ManagementPhase = 'clean' | 'editing' | 'saving' | 'saved'
export interface ManagementState {
  /** The latest values the server reported. */
  remote: ManagementValues
  /** The remote value each edited field had when its local edit started. */
  base: Partial<ManagementValues>
  /** Local edits; a field also in `sent` was acknowledged by a successful save. */
  mine: Partial<ManagementValues>
  /** The values a successful save submitted, kept only until the server reports them. */
  sent?: Partial<ManagementValues>
  /** The remote values when the save was acknowledged: a poll still showing these is stale, a different one is newer. */
  sentBase?: Partial<ManagementValues>
  phase: ManagementPhase
  notice?: 'saved' | 'merged'
}
export type ManagementAction =
  | { type: 'priority'; value: ManagementPriority }
  | { type: 'dueAt'; value: string }
  | { type: 'paused'; value: boolean }
  | { type: 'server'; remote: ManagementValues }
  | { type: 'submit' } | { type: 'saved' } | { type: 'failed' }
  | { type: 'useRemote'; field: ManagementField } | { type: 'keepMine'; field: ManagementField }

/** The form value of a Ticket's management fields; an unset deadline stays empty. */
export function localDateTime(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
export function managementValues(ticket: Pick<TicketPageView, 'priority' | 'dueAt' | 'taskPaused'>): ManagementValues {
  return { priority: ticket.priority ?? 'normal', dueAt: localDateTime(ticket.dueAt), paused: !!ticket.taskPaused }
}
export function sameManagement(a: ManagementValues, b: ManagementValues): boolean {
  return a.priority === b.priority && a.dueAt === b.dueAt && a.paused === b.paused
}
export function initialManagement(remote: ManagementValues): ManagementState {
  return { remote, base: {}, mine: {}, phase: 'clean' }
}
export const dirtyFields = (state: Pick<ManagementState, 'mine'>): ManagementField[] =>
  MANAGEMENT_FIELDS.filter(field => state.mine[field] !== undefined)
/** Fields a successful save already submitted, still waiting for the server to report the new value. */
export const acknowledgedFields = (state: Pick<ManagementState, 'sent'>): ManagementField[] =>
  MANAGEMENT_FIELDS.filter(field => state.sent?.[field] !== undefined)
/** Edited fields the owner still has to save; an acknowledged save is not unsaved work. */
export const unsavedFields = (state: Pick<ManagementState, 'mine' | 'sent'>): ManagementField[] =>
  dirtyFields(state).filter(field => state.sent?.[field] === undefined)
/** The patch for the next save: only fields the owner edited and has not already saved. */
export const unsavedValues = (state: Pick<ManagementState, 'mine' | 'sent'>): Partial<ManagementValues> =>
  Object.fromEntries(unsavedFields(state).map(field => [field, state.mine[field]])) as Partial<ManagementValues>
export const shownValues = (state: Pick<ManagementState, 'remote' | 'mine'>): ManagementValues => ({ ...state.remote, ...state.mine })
/** Unsaved fields whose remote value changed since the edit began, so the owner must choose. */
export const conflicts = (state: Pick<ManagementState, 'remote' | 'mine' | 'base' | 'sent'>): ManagementField[] =>
  unsavedFields(state).filter(field => state.remote[field] !== state.base[field] && state.mine[field] !== state.remote[field])

const set = <F extends ManagementField>(values: Partial<ManagementValues>, field: F, value: ManagementValues[F]): void => {
  values[field] = value
}
const phaseOf = (state: Pick<ManagementState, 'mine' | 'sent'>): ManagementPhase => unsavedFields(state).length ? 'editing'
  : acknowledgedFields(state).length ? 'saved' : 'clean'
const edited = (state: ManagementState, field: ManagementField, value: ManagementValues[ManagementField]): ManagementState => {
  const acknowledged = state.sent?.[field]
  // Re-selecting the value a successful save already submitted keeps waiting for the server to report it.
  if (acknowledged !== undefined && value === acknowledged) return state
  const mine = { ...state.mine }, base = { ...state.base }, sent = { ...state.sent }, sentBase = { ...state.sentBase }
  // With an acknowledged value the remote snapshot may predate our save, so equality with it is still an unsaved reversal.
  if (value === state.remote[field] && acknowledged === undefined) {
    delete mine[field]; delete base[field]; delete sent[field]; delete sentBase[field]
  } else {
    // Remember the remote value the local edit started from; a later remote change is then visible as a conflict.
    if (mine[field] === undefined) set(base, field, state.remote[field])
    set(mine, field, value)
    // A new edit is unsaved work again, even if an earlier value for this field was acknowledged.
    delete sent[field]; delete sentBase[field]
  }
  const next = { ...state, mine, base, sent, sentBase }
  return { ...next, phase: phaseOf(next), notice: undefined }
}
/**
 * Reduce draft actions. A server update follows remote values for fields the owner did not edit, converges an
 * unsaved edit whose remote value now equals it, and keeps a differing unsaved edit (a conflict). A value the owner
 * already saved stays visible until the server reports it; a later remote change wins instead of reviving that save.
 */
export function managementReducer(state: ManagementState, action: ManagementAction): ManagementState {
  switch (action.type) {
    case 'priority': return edited(state, 'priority', action.value)
    case 'dueAt': return edited(state, 'dueAt', action.value)
    case 'paused': return edited(state, 'paused', action.value)
    case 'server': {
      // A save in flight owns the outcome: an arriving poll is stale until its reload reads the committed value.
      if (state.phase === 'saving') return state
      if (sameManagement(state.remote, action.remote)) return state
      const mine = { ...state.mine }, base = { ...state.base }, sent = { ...state.sent }, sentBase = { ...state.sentBase }
      for (const field of MANAGEMENT_FIELDS) {
        if (sent[field] !== undefined) {
          // Confirmed, or the remote moved away from both the saved value and the value seen at the save: the later
          // change is current. A poll that still shows `sentBase` may predate the write, so keep the saved value.
          const before = sentBase[field] ?? state.remote[field]
          if (action.remote[field] === sent[field] || action.remote[field] !== before) {
            delete mine[field]; delete base[field]; delete sent[field]; delete sentBase[field]
          }
          continue
        }
        if (mine[field] !== undefined && mine[field] === action.remote[field]) { delete mine[field]; delete base[field] }
      }
      const next = { ...state, remote: action.remote, mine, base, sent, sentBase }
      const dirty = dirtyFields(next).length > 0
      // A remote change to a field the owner did not edit was folded into the draft; say so once.
      const changedElsewhere = MANAGEMENT_FIELDS.some(field => action.remote[field] !== state.remote[field])
      const notice = state.notice === 'saved' && !dirty ? 'saved' : dirty && changedElsewhere ? 'merged' : state.notice
      return { ...next, notice, phase: phaseOf(next) }
    }
    case 'submit': return state.phase === 'editing'
      ? { ...state, phase: 'saving', sent: { ...state.mine }, sentBase: undefined, notice: undefined } : state
    case 'saved': return state.phase === 'saving' ? { ...state, phase: 'saved', sentBase: state.remote, notice: 'saved' } : state
    case 'failed': return state.phase === 'saving' ? { ...state, phase: 'editing', sent: undefined, sentBase: undefined } : state
    case 'useRemote': {
      const mine = { ...state.mine }, base = { ...state.base }, sent = { ...state.sent }, sentBase = { ...state.sentBase }
      delete mine[action.field]; delete base[action.field]; delete sent[action.field]; delete sentBase[action.field]
      const next = { ...state, mine, base, sent, sentBase }
      return { ...next, phase: phaseOf(next) }
    }
    case 'keepMine': {
      const sent = { ...state.sent }, sentBase = { ...state.sentBase }
      delete sent[action.field]; delete sentBase[action.field]
      return { ...state, sent, sentBase, base: { ...state.base, [action.field]: state.remote[action.field] } }
    }
  }
}
/** The fields a save must send: only what the owner edited, so an unedited field saved elsewhere is not overwritten. */
export function managementPatch(remote: ManagementValues, mine: Partial<ManagementValues>):
  { priority?: ManagementPriority; dueAt?: string | null; paused?: boolean } {
  const values = shownValues({ remote, mine })
  const patch: { priority?: ManagementPriority; dueAt?: string | null; paused?: boolean } = {}
  if (mine.priority !== undefined) patch.priority = values.priority
  if (mine.dueAt !== undefined) {
    // An emptied datetime input removes the deadline; only a non-empty value is parsed.
    if (!values.dueAt) patch.dueAt = null
    else {
      const time = Date.parse(values.dueAt)
      if (!Number.isFinite(time)) throw new Error('invalid-due-at')
      patch.dueAt = new Date(time).toISOString()
    }
  }
  if (mine.paused !== undefined) patch.paused = values.paused
  return patch
}
