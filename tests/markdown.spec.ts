import { expect, it } from 'vitest'
import { linkify } from '../src/client/markdown.ts'

it('turns bare web addresses into links by host and short path, leaving punctuation outside', () => {
  const log = 'https://ci.example.com/runs/123456789012345678901234/log'
  expect(linkify(`log at ${log}.`)).toEqual([
    { kind: 'text', text: 'log at ' }, { kind: 'link', text: 'ci.example.com/runs/123456789012345678…', url: log }, { kind: 'text', text: '.' }])
  expect(linkify('See https://example.com/a. Then (https://example.com/b) and https://example.com/c?')).toEqual([
    { kind: 'text', text: 'See ' }, { kind: 'link', text: 'example.com/a', url: 'https://example.com/a' }, { kind: 'text', text: '. Then (' },
    { kind: 'link', text: 'example.com/b', url: 'https://example.com/b' }, { kind: 'text', text: ') and ' },
    { kind: 'link', text: 'example.com/c', url: 'https://example.com/c' }, { kind: 'text', text: '?' }])
})

it('never turns raw HTML or a non-web address into markup', () => {
  expect(linkify('<b>not bold</b>')).toEqual([{ kind: 'text', text: '<b>not bold</b>' }])
  for (const text of ['[x](javascript:alert(1))', '[x](data:text/html,<b>hi</b>)']) {
    expect(linkify(text).every(part => part.kind === 'text')).toBe(true)
    expect(linkify(text).map(part => part.text).join('')).toBe(text)
  }
})
