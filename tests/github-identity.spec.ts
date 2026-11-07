import { afterEach, expect, it, vi } from 'vitest'
import { githubKind } from '../src/sources/github.ts'
import { githubChannel, githubRepository, githubThread } from '../src/sources/github-trigger.ts'
import { githubLink, sendGithub } from '../src/sources/github-channel.ts'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { pullsOf } from '../src/sources/github-pull.ts'

afterEach(() => vi.restoreAllMocks())

it('admits owned object and PR CI observations while keeping trusted bots within their configured repository', () => {
  const config = githubKind.schema.parse({ repository: 'acme/widgets', cli: 'gh', routing: 'tasks', observePulls: true,
    taskAuthors: [{ id: 'alice' }, { id: 'dependabot[bot]', repository: 'acme/widgets' }], autoMerge: true })
  const scope = (prAuthor: string, repository = 'acme/widgets') => githubKind.scope!({ meta: { repository, isPr: true, ci: true, prAuthor, routing: 'tasks' } }, config)
  expect(scope('alice')).toMatchObject({ listened: true, observed: true, row: 'pulls' })
  expect(scope('dependabot[bot]')).toMatchObject({ observed: true })
  expect(scope('dependabot[bot]', 'acme/other')).toMatchObject({ observed: false })
  expect(scope('another-person')).toMatchObject({ observed: false })
  expect(githubKind.scope!({ meta: { isPr: true, ci: true, prAuthor: 'alice' } }, { ...config, routing: 'monitor' })).toMatchObject({ observed: false })
})

it('selects only the current repository PRs from a cross-repository ticket', () => {
  const ticket = { follows: [{ thread: 'github:acme/one:7', own: true }, { thread: 'github:acme/two:7', own: true },
    { thread: 'github:acme/two:8', own: true, closed: { at: '2026-11-04T00:00:00Z', outcome: 'merged' as const } }] }
  expect(pullsOf(ticket, true, 'acme/one')).toEqual([7])
  expect(pullsOf(ticket, true, 'acme/two')).toEqual([7])
  expect(pullsOf(ticket, false, 'acme/two')).toEqual([7, 8])
  expect(pullsOf(ticket, true, 'acme/unrelated')).toEqual([])
})

it('keeps same-number repository links distinct and normalizes GitHub case', () => {
  expect(githubKind.find!('https://github.com/Acme/One/pull/7').threads).toEqual(['github:acme/one:7'])
  expect(githubKind.find!('https://github.com/acme/two/issues/7').threads).toEqual(['github:acme/two:7'])
  expect(githubKind.find!('https://evil.test/github.com/acme/one/pull/7').threads).toEqual([])
  expect(githubKind.find!('#7').threads).toEqual(['github:7'])
  expect(githubThread('ACME/one', 7)).toBe('github:acme/one:7')
  expect(() => githubThread('acme/one/../../other', 7)).toThrow()
  expect(githubRepository('https://github.com/acme/one/pull/7#discussion_r2')).toBe('acme/one')
})

it('renders an explicit repository channel without borrowing the deployment repository', () => {
  const channel = githubChannel(7, undefined, 'acme/other')
  expect(channel.thread).toBe('github:acme/other:7')
  expect(githubLink(channel.address, { repository: 'acme/widgets' }).url).toBe('https://github.com/acme/other/issues/7')
})

it('refuses mismatched queued replies before any read or write to GitHub', async () => {
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const run = vi.spyOn(commands, 'run')
  for (const channel of [githubChannel(7, undefined, 'acme/other'), githubChannel(7, 'https://github.com/acme/other/pull/7'),
    githubChannel(7, 'https://github.com/acme/widgets/issues/8')]) {
    await expect(sendGithub({ commands }, { id: 'reply', channel, text: 'done', kind: 'reply' })).rejects.toThrow(/repository|number/i)
  }
  expect(run).not.toHaveBeenCalled()
})

it('routes replies to a configured additional repository without changing the default command scope', async () => {
  const commands = new Commands(() => testDeployment({ githubRepositories: ['acme/widgets', 'acme/other'] }), {}, new AbortController().signal)
  const run = vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) => args.includes('--slurp') ? '[[]]' : '{}')
  await sendGithub({ commands }, { id: 'reply-other', channel: githubChannel(7, 'https://github.com/acme/other/issues/7', 'acme/other'), text: 'done', kind: 'reply' })
  expect(run.mock.calls.every(([, args]) => args[1] === 'repos/acme/other/issues/7/comments')).toBe(true)
  expect(run).toHaveBeenCalledTimes(2)
  expect(commands.repository).toBe('acme/widgets')
  expect(() => commands.forRepository('acme/unlisted')).toThrow('not configured')
})

it('does not promote a read-only resource allowlist into an outbound repository', () => {
  const commands = new Commands(() => testDeployment({ githubReadRepositories: ['acme/read-only'] }), {}, new AbortController().signal)
  expect(commands.forReadRepository('acme/read-only').repository).toBe('acme/read-only')
  expect(() => commands.forRepository('acme/read-only')).toThrow('not configured')
})
