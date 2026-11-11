// @vitest-environment jsdom
// The Ticket management editor keeps a local draft across polls and reconciles fields changed elsewhere.
import { act } from 'react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { acknowledgedFields, conflicts, dirtyFields, initialManagement, managementPatch, managementReducer, shownValues, unsavedFields,
  unsavedValues } from '../src/client/management-draft.ts'
import { zh } from '../src/client/locales.ts'
import { at, click, field, mount, settle, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const due = () => field<HTMLInputElement>(zh.ticketDueAt)
const priority = () => field<HTMLSelectElement>(zh.ticketPriority)
const poll = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(5000) }); await settle() }
const open = async () => { at({ page: 'execution', id: 't1' }); await mount(); await click(zh.taskManagement) }

it('keeps an unsaved deadline when a poll brings another entry\'s priority change, and saves only the edited field', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  await open()
  await type(due(), '2026-11-08T10:00')
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, priority: 'high' }
  await poll()
  // The editor stays open, the deadline draft survives, and the untouched priority follows the server.
  expect(due().value).toBe('2026-11-08T10:00')
  expect(priority().value).toBe('high')
  expect(text()).toContain(zh.ticketManagementRemoteUpdated)
  await click(zh.managementSave)
  expect(server.requests.find(request => request.path === 'tickets/t1/management')).toMatchObject({ method: 'PUT',
    body: { dueAt: new Date('2026-11-08T10:00').toISOString() } })
  expect(text()).toContain(zh.saved)
})

it('shows base, local and remote values when the same field changed in both places', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  await open()
  await type(priority(), 'urgent')
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, priority: 'high' }
  await poll()
  expect(priority().value).toBe('urgent')
  expect(text()).toContain(zh.ticketManagementConflict.replace('{field}', zh.ticketPriority))
  expect(text()).toContain(zh.ticketManagementBase)
  expect(text()).toContain(zh.ticketManagementLocal)
  expect(text()).toContain(zh.ticketManagementRemote)
  // Saving would silently pick the local side, so it waits for an explicit choice.
  expect(document.querySelector<HTMLButtonElement>('.dt-disclosure-body button[type="submit"]')?.disabled).toBe(true)
  await click(zh.managementSave)
  expect(server.requests.some(request => request.path === 'tickets/t1/management')).toBe(false)
  await click(zh.ticketManagementUseRemote)
  expect(priority().value).toBe('high')
  expect(text()).not.toContain(zh.ticketManagementConflict.replace('{field}', zh.ticketPriority))
})

it('keeps the owner\'s local value after an explicit choice and submits it', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  await open()
  await type(priority(), 'urgent')
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, priority: 'high' }
  await poll()
  await click(zh.ticketManagementKeepMine)
  expect(priority().value).toBe('urgent')
  expect(text()).not.toContain(zh.ticketManagementUseRemote)
  expect(document.querySelector<HTMLButtonElement>('.dt-disclosure-body button[type="submit"]')?.disabled).toBe(false)
  await click(zh.managementSave)
  expect(server.requests.find(request => request.path === 'tickets/t1/management')).toMatchObject({ body: { priority: 'urgent' } })
})

it('removes a deadline when the owner clears the input', async () => {
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, dueAt: '2026-11-20T10:00:00.000Z' }
  at({ page: 'execution', id: 't1' }); await mount(); await click(zh.taskManagement)
  expect(due().value).not.toBe('')
  await type(due(), '')
  await click(zh.managementSave)
  expect(server.requests.find(request => request.path === 'tickets/t1/management')).toMatchObject({ body: { dueAt: null } })
  expect(server.ticketDetails.t1?.dueAt).toBeUndefined()
})

it('follows a remote update when nothing was edited, without a draft notice', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  await open()
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, priority: 'high' }
  await poll()
  expect(priority().value).toBe('high')
  expect(text()).not.toContain(zh.ticketManagementConflict.replace('{field}', zh.ticketPriority))
  expect(text()).not.toContain(zh.ticketManagementRemoteUpdated)
})

it('does not revert a saved value while the server still reports the old one, and adopts a later remote change', () => {
  const remote = { priority: 'normal' as const, dueAt: '', paused: false }
  let state = managementReducer(initialManagement(remote), { type: 'dueAt', value: '2026-11-08T10:00' })
  state = managementReducer(state, { type: 'submit' })
  state = managementReducer(state, { type: 'saved' })
  // The next poll still carries the pre-save value: keep showing what was saved instead of stepping back.
  state = managementReducer(state, { type: 'server', remote })
  expect(state.phase).toBe('saved')
  expect(shownValues(state).dueAt).toBe('2026-11-08T10:00')
  expect(dirtyFields(state)).toEqual(['dueAt'])
  // The poll that carries the saved value confirms it and clears the draft.
  state = managementReducer(state, { type: 'server', remote: { ...remote, dueAt: '2026-11-08T10:00' } })
  expect(dirtyFields(state)).toEqual([])
  expect(shownValues(state).dueAt).toBe('2026-11-08T10:00')
})

it('adopts a remote change made after a successful save instead of reviving the saved value as unsaved work', () => {
  const remote = { priority: 'normal' as const, dueAt: '', paused: false }
  let state = managementReducer(initialManagement(remote), { type: 'priority', value: 'urgent' })
  state = managementReducer(state, { type: 'submit' })
  state = managementReducer(state, { type: 'saved' })
  // Another entry sets high after the save succeeded: high is current, and the saved urgent is not unsaved work again.
  state = managementReducer(state, { type: 'server', remote: { ...remote, priority: 'high' } })
  expect(shownValues(state).priority).toBe('high')
  expect(unsavedFields(state)).toEqual([])
  expect(conflicts(state)).toEqual([])
  expect(acknowledgedFields(state)).toEqual([])
})

it('keeps the pending edit when a poll reports the same field while the save is still in flight', () => {
  const remote = { priority: 'normal' as const, dueAt: '', paused: false }
  let state = managementReducer(initialManagement(remote), { type: 'priority', value: 'urgent' })
  state = managementReducer(state, { type: 'submit' })
  // The poll arrives before the PUT is acknowledged: the in-flight write owns the outcome, so the local value stays.
  state = managementReducer(state, { type: 'server', remote: { ...remote, priority: 'high' } })
  expect(shownValues(state).priority).toBe('urgent')
  expect(state.remote.priority).toBe('normal')
  expect(state.phase).toBe('saving')
  // Once acknowledged, the reload's newer value wins instead of reviving the saved value as a conflict.
  state = managementReducer(state, { type: 'saved' })
  state = managementReducer(state, { type: 'server', remote: { ...remote, priority: 'high' } })
  expect(shownValues(state).priority).toBe('high')
  expect(unsavedFields(state)).toEqual([])
  expect(acknowledgedFields(state)).toEqual([])
})

it('keeps a reversal of an acknowledged value as unsaved work when the reload is stale', () => {
  const remote = { priority: 'normal' as const, dueAt: '', paused: false }
  let state = managementReducer(initialManagement(remote), { type: 'priority', value: 'urgent' })
  state = managementReducer(state, { type: 'submit' })
  state = managementReducer(state, { type: 'saved' })
  // The reload failed, so the snapshot still says normal; picking normal is a reversal of the saved urgent, not a no-op.
  state = managementReducer(state, { type: 'priority', value: 'normal' })
  expect(shownValues(state).priority).toBe('normal')
  expect(unsavedFields(state)).toEqual(['priority'])
  expect(acknowledgedFields(state)).toEqual([])
  expect(managementPatch(state.remote, unsavedValues(state))).toEqual({ priority: 'normal' })
})

it('sends only edited fields so a field saved elsewhere is not overwritten', () => {
  expect(managementPatch({ priority: 'high', dueAt: '', paused: false }, { dueAt: '2026-11-08T10:00' }))
    .toEqual({ dueAt: new Date('2026-11-08T10:00').toISOString() })
  expect(managementPatch({ priority: 'high', dueAt: '', paused: false }, { paused: true })).toEqual({ paused: true })
  // Clearing a datetime input removes the deadline instead of failing to parse an empty string.
  expect(managementPatch({ priority: 'high', dueAt: '2026-11-08T10:00', paused: false }, { dueAt: '' })).toEqual({ dueAt: null })
  expect(() => managementPatch({ priority: 'high', dueAt: '', paused: false }, { dueAt: 'not-a-time' })).toThrow('invalid-due-at')
})

it('keeps the input after a failed save and explains an ended Ticket while retaining the values', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  await open()
  await type(due(), '2026-11-08T10:00')
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, ended: { at: '2026-11-09T00:00:00Z', by: 'human', outcome: 'stopped' } }
  await click(zh.managementSave)
  expect(due().value).toBe('2026-11-08T10:00')
  expect(text()).toContain(zh['userError.ticketEnded'])
  await poll()
  expect(text()).toContain(zh.ticketManagementEnded)
  expect(text()).toContain('2026-11-08T10:00')
})

it('does not re-render forever when a poll arrives while a save is in flight', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  await open()
  await type(priority(), 'urgent')
  const previous = globalThis.fetch
  const gate = Promise.withResolvers<void>()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT' && url.includes('/tickets/t1/management')) { await gate.promise; return Response.json({ saved: true }) }
    return previous(url, init)
  }))
  const form = document.querySelector<HTMLFormElement>('.dt-disclosure-body form')!
  await act(async () => { form.requestSubmit() })
  // The poll arrives before the PUT is acknowledged; the reducer ignores it and the dispatch must not repeat forever.
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, priority: 'high' }
  await poll()
  expect(priority().value).toBe('urgent')
  gate.resolve()
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); await settle()
  // The acknowledged save is followed by the reload, which adopts the newer remote value.
  expect(priority().value).toBe('high')
})
