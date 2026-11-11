/** Native discussion evidence comes from DSH records, not a browser-authored transcript. */
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, SessionLogOffset, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { expect, it, vi } from 'vitest'
import { discussionContext, discussionWindow, readDiscussion } from '../src/sources/workbench-session.ts'

const user = (seq: number, text: string): SessionEvent<'user/message'> => ({ type: 'user/message', seq: SessionSeq(seq), time: seq * 1000,
  surfaceOp: 'append', data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) })
const inspection = (events: SessionEvent[]): SessionInspection => ({
  meta: { id: SessionId('discussion'), version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false },
  inheritedEventCount: SessionLogOffset(0), events,
})

it('captures only the selected prefix, retaining user corrections and excluding reasoning', () => {
  const assistant: SessionEvent<'assistant/message'> = { type: 'assistant/message', seq: SessionSeq(1), time: 1000, surfaceOp: 'append',
    data: { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      content: [{ type: 'text', text: 'Proposed outline' }, { type: 'reasoning', text: 'private internal reasoning' }],
      source: { provider: 'test', model: 'test' } }) } }
  const context = discussionContext(inspection([user(0, 'Research this'), assistant, user(2, 'Use the revised scope'), user(3, 'Later unrelated question')]), 'discussion', 2)
  expect(context.messages.map(message => message.text)).toEqual(['Research this', 'Proposed outline', 'Use the revised scope'])
  expect(JSON.stringify(context)).not.toContain('private internal')
  expect(context.partial).toBe(false)
})

it('does not elevate injected notices to owner discussion', () => {
  const notice = { ...user(1, 'Automated relay'), data: createUserMessage({ content: [{ type: 'text', text: 'Automated relay' }], source: { kind: 'system-prompt' } }) }
  const context = discussionContext(inspection([user(0, 'Owner request'), notice]), 'discussion', 1)
  expect(context.messages).toHaveLength(1)
})

it('preserves durable file references without copying bytes or inventing a filesystem path', () => {
  const message = user(0, 'Use this file')
  const attached = { ...message, data: createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'text', text: 'Use this file' },
    { type: 'file', attachment: { attachmentId: AttachmentId('a'.repeat(64)), name: 'material.pdf', bytes: 42 } },
  ] }) }
  const result = discussionContext(inspection([attached]), 'discussion', 0)
  expect(result.messages[0]).toMatchObject({ text: 'Use this file\n[file: material.pdf]', references: [`dsh-attachment:${'a'.repeat(64)}`] })
  expect(result.partial).toBe(true)
  const fileHostPath = vi.fn(() => 'C:/private/attachments/material.pdf')
  const resolved = discussionContext(inspection([attached]), 'discussion', 0, { fileHostPath, imageHostPath: () => undefined })
  expect(resolved).toMatchObject({ partial: false, attachments: [{ kind: 'file', readonlyPath: 'C:/private/attachments/material.pdf' }] })
  expect(fileHostPath).toHaveBeenCalledWith({ attachmentId: 'a'.repeat(64), name: 'material.pdf', bytes: 42 })
})

it('rejects wrong sessions, unavailable boundaries and managed worker conversations', () => {
  const record = inspection([user(0, 'Request')])
  expect(() => discussionContext(record, 'another', 0)).toThrow('another discussion')
  expect(() => discussionContext(record, 'discussion', 10)).toThrow('unavailable')
  expect(() => discussionContext({ ...record, meta: { ...record.meta, agentPreset: 'dsh-superagent-worker' } }, 'discussion', 0)).toThrow('not owner discussions')
  // The Main Session is the owner's one face, not managed execution.
  expect(discussionContext({ ...record, meta: { ...record.meta, agentPreset: 'dsh-superagent-router' } }, 'discussion', 0))
    .toMatchObject({ sessionId: 'discussion', throughSeq: 0 })
  expect(() => discussionContext({ ...record, meta: { ...record.meta, origin: 'subagent', agentPreset: 'dsh-superagent-router' } }, 'discussion', 0))
    .toThrow('not owner discussions')
})

it('keeps the newest bounded evidence and marks omitted older discussion as partial', () => {
  const record = inspection(Array.from({ length: 501 }, (_, index) => user(index, `Message ${index}`)))
  const context = discussionContext(record, 'discussion', 500)
  expect(context).toMatchObject({ partial: true, messages: { length: 500 } })
  expect(context.messages[0]?.seq).toBe(1)
  expect(context.messages.at(-1)?.seq).toBe(500)
})

it('uses the public inspect API without creating or resuming another Session', async () => {
  const inspect = vi.fn(async () => inspection([user(0, 'Request')]))
  const signal = new AbortController().signal
  expect(await readDiscussion({ inspect }, 'discussion', 0, signal)).toMatchObject({ sessionId: 'discussion', throughSeq: 0 })
  expect(inspect).toHaveBeenCalledWith('discussion', signal)
})

const NOW = Date.parse('2026-11-09T10:00:00.000Z')
const hoursAgo = (hours: number) => NOW - hours * 3_600_000
const timed = (event: SessionEvent<'user/message'>, time: number) => ({ ...event, time })

it('reads only the owner\'s last 24 hours, newest first, without injected notices', () => {
  const notice = { ...user(2, 'Automated relay'), time: hoursAgo(1.5),
    data: createUserMessage({ content: [{ type: 'text', text: 'Automated relay' }], source: { kind: 'system-prompt' } }) }
  const record = inspection([timed(user(0, 'Old context'), hoursAgo(30)), timed(user(1, 'Yesterday correction'), hoursAgo(25)),
    timed(user(3, 'Recent question'), hoursAgo(2)), notice, timed(user(5, 'Latest note'), hoursAgo(1))])
  expect(discussionWindow(record, 'discussion', { now: new Date(NOW) })).toMatchObject({ sessionId: 'discussion', throughSeq: 5,
    windowStart: new Date(hoursAgo(24)).toISOString(), partial: false, nextOffset: null,
    messages: [{ seq: 5, text: 'Latest note' }, { seq: 3, text: 'Recent question' }] })
})

it('bounds a window page at 20 messages by default and 50 at most, and keeps at most 500', () => {
  const recent = inspection(Array.from({ length: 60 }, (_, index) => timed(user(index, `Message ${index}`), NOW - (60 - index) * 1000)))
  const first = discussionWindow(recent, 'discussion', { now: new Date(NOW) })
  expect([first.messages.length, first.messages[0]?.text, first.nextOffset]).toEqual([20, 'Message 59', 20])
  expect(discussionWindow(recent, 'discussion', { now: new Date(NOW), offset: 50 })).toMatchObject({ messages: { length: 10 }, nextOffset: null })
  expect(discussionWindow(recent, 'discussion', { now: new Date(NOW), limit: 80 }).messages).toHaveLength(50)
  const crowded = inspection(Array.from({ length: 501 }, (_, index) => timed(user(index, `Message ${index}`), NOW - (501 - index) * 1000)))
  const tail = discussionWindow(crowded, 'discussion', { now: new Date(NOW), offset: 480, limit: 50 })
  expect([tail.partial, tail.messages.length, tail.messages.at(-1)?.text, tail.nextOffset]).toEqual([true, 20, 'Message 1', null])
})

it('refuses another session and managed worker or subagent windows', () => {
  const record = inspection([timed(user(0, 'Request'), NOW)])
  expect(() => discussionWindow(record, 'another', { now: new Date(NOW) })).toThrow('another discussion')
  expect(() => discussionWindow({ ...record, meta: { ...record.meta, agentPreset: 'dsh-superagent-worker' } }, 'discussion'))
    .toThrow('not owner discussions')
  expect(() => discussionWindow({ ...record, meta: { ...record.meta, origin: 'subagent', agentPreset: 'dsh-superagent-router' } }, 'discussion'))
    .toThrow('not owner discussions')
})

it('keeps attachment references in the window and marks a path it cannot resolve', () => {
  const attached = { ...timed(user(0, 'Use this file'), NOW), data: createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'text', text: 'Use this file' },
    { type: 'file', attachment: { attachmentId: AttachmentId('a'.repeat(64)), name: 'material.pdf', bytes: 42 } },
  ] }) }
  expect(discussionWindow(inspection([attached]), 'discussion', { now: new Date(NOW) })).toMatchObject({ partial: true,
    messages: [{ text: 'Use this file\n[file: material.pdf]', references: [`dsh-attachment:${'a'.repeat(64)}`] }],
    attachments: [{ kind: 'file', name: 'material.pdf' }] })
  const imageHostPath = vi.fn(() => 'C:/private/attachments/screen.png')
  expect(discussionWindow(inspection([attached]), 'discussion', { now: new Date(NOW), attachments: { fileHostPath: () => undefined, imageHostPath } }))
    .toMatchObject({ partial: true, attachments: [{ kind: 'file', name: 'material.pdf' }] })
  expect(discussionWindow(inspection([attached]), 'discussion', { now: new Date(NOW),
    attachments: { fileHostPath: () => 'C:/private/attachments/material.pdf', imageHostPath: () => undefined } }))
    .toMatchObject({ partial: false, attachments: [{ kind: 'file', readonlyPath: 'C:/private/attachments/material.pdf' }] })
})

