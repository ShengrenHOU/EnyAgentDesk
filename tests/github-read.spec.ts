import { afterEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { readGithub, pullChecks, ciSummary } from '../src/sources/github-read.ts'
import { clearGithubReadCache, GITHUB_READ_TTL_MS } from '../src/sources/github-cache.ts'

const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
afterEach(() => { vi.restoreAllMocks(); clearGithubReadCache() })

it('does not present skipped, neutral, stale, unknown or absent checks as successful executions', () => {
  const head = 'b99f799'
  const checks = ['success', 'skipped', 'neutral', 'stale', null].map((conclusion, i) => ({ name: `job${i}`, status: 'completed', conclusion }))
  expect(ciSummary({ head, checks, statuses: [] }, 'PR #81', 'github/pulls/81/checks'))
    .toContain('1/5 passed; job1=skipped, job2=neutral, job3=stale, job4=unknown')
  expect(ciSummary({ head, checks: [], statuses: [] }, 'PR #81', 'github/pulls/81/checks')).toMatch(/^No CI checks reported/)
})

it('reads a bounded comment page and exposes the next page reference', async () => {
  const gh = vi.spyOn(commands, 'gh').mockResolvedValue(Array.from({ length: 20 }, (_, id) => ({ id, body: 'comment' })))
  expect(await readGithub(commands, 'github/issues/123/comments/2')).toMatchObject({ next_resource: 'github/issues/123/comments/3' })
  expect(gh).toHaveBeenCalledWith(['api', 'repos/acme/widgets/issues/123/comments?per_page=20&page=2'])
})

it('restricts additional repository reads and preserves repository identity across pages', async () => {
  const allowed = new Commands(() => testDeployment({ githubReadRepositories: ['company/service'] }), {}, new AbortController().signal)
  const gh = vi.spyOn(Commands.prototype, 'gh').mockResolvedValue(Array.from({ length: 20 }, () => ({ filename: 'src/main.ts', status: 'modified', additions: 1, deletions: 0, patch: '+new' })))
  expect(await readGithub(allowed, 'github/repos/company/service/pulls/3/files/1')).toMatchObject({ next_resource: 'github/repos/company/service/pulls/3/files/2' })
  expect(gh).toHaveBeenCalledWith(['api', 'repos/company/service/pulls/3/files?per_page=20&page=1'])
  gh.mockClear()
  for (const resource of ['github/repos/elsewhere/service/pulls/3', 'github/repos/company/service/repos/acme/widgets/pulls/3', 'github/repos/company/service/pulls/3/merge']) {
    await expect(readGithub(allowed, resource)).rejects.toThrow()
  }
  expect(gh).not.toHaveBeenCalled()
})

it('reads a complete source file only at a full immutable SHA and encodes the path', async () => {
  const run = vi.spyOn(commands, 'run').mockResolvedValue('source')
  const sha = 'a'.repeat(40)
  expect(await readGithub(commands, `github/commits/${sha}/file/.github/workflows/check.yml`)).toEqual({ head: sha, path: '.github/workflows/check.yml', content: 'source' })
  expect(run).toHaveBeenCalledWith('/bin/false', ['api', `repos/acme/widgets/contents/.github/workflows/check.yml?ref=${sha}`, '-H', 'Accept: application/vnd.github.raw'])
  for (const path of ['../secret', 'a/./b', 'a\\b', '.git/config']) await expect(readGithub(commands, `github/commits/${sha}/file/${path}`)).rejects.toThrow()
})

it('rejects unsupported or escaping paths without making a request', async () => {
  const gh = vi.spyOn(commands, 'gh')
  for (const resource of ['github/../outside', 'github/issues/1/reviews', 'github/pulls/1/checks/2', 'github/issues/1?repo=other']) {
    await expect(readGithub(commands, resource)).rejects.toThrow()
  }
  expect(gh).not.toHaveBeenCalled()
})

it('reads checks across pages and canonicalizes the latest status per context', async () => {
  vi.spyOn(commands, 'gh').mockResolvedValue([{ check_runs: [{ name: 'z', status: 'completed', conclusion: 'success', id: 1, head_sha: 'abc', details_url: 'https://github.com/acme/widgets/actions/runs/42/job/1' }] }, { check_runs: [{ name: 'a', status: 'in_progress', conclusion: null }] }])
  vi.spyOn(commands, 'pages').mockResolvedValue([{ context: 'build', state: 'success' }, { context: 'build', state: 'failure' }])
  const result = await pullChecks(commands, 'abc')
  expect(result.checks.map((check: { name: string }) => check.name)).toEqual(['a', 'z'])
  expect(result.statuses).toEqual([{ context: 'build', state: 'success' }])
  expect(result.checks[1]).toMatchObject({ id: 1, head_sha: 'abc', details_url: 'https://github.com/acme/widgets/actions/runs/42/job/1' })
})

it('reads any requested PR’s CI on demand without restricting the author', async () => {
  const gh = vi.spyOn(commands, 'gh').mockResolvedValueOnce({ head: { sha: 'abc' }, user: { login: 'another-author' } }).mockResolvedValueOnce([{ check_runs: [] }])
  vi.spyOn(commands, 'pages').mockResolvedValue([])
  expect(await readGithub(commands, 'github/pulls/123/checks')).toEqual({ head: 'abc', checks: [], statuses: [] })
  expect(gh).toHaveBeenCalledTimes(2)
})

/** Fake GitHub REST API pull request review comment payload. */
const reviewComment = (id: number, reply?: number) => ({ id, url: `https://api.github.com/repos/acme/widgets/pulls/comments/${id}`,
  pull_request_review_id: 77, node_id: 'PRRC_x', path: 'src/render.ts', line: 43, original_line: 43, side: 'RIGHT', commit_id: 'abc',
  diff_hunk: '@@ -40,6 +40,8 @@\n   const title = view.title\n   const margin = 12\n+  const padding = 8',
  user: { login: id === 2 ? 'review-bot[bot]' : 'carol', id: 5, type: id === 2 ? 'Bot' : 'User', avatar_url: 'https://avatars/5', html_url: 'https://github.com/carol' },
  body: `comment ${id}`, created_at: `2026-09-09T00:00:0${id}Z`, updated_at: `2026-09-09T00:00:0${id}Z`,
  html_url: `https://github.com/acme/widgets/pull/9#discussion_r${id}`, author_association: 'MEMBER', reactions: { total_count: 0 },
  _links: { self: { href: 'x' } }, ...reply ? { in_reply_to_id: reply } : {} })
it('reads a page of review comments as messages: id, author, time, text, the comment each answers, and the file and line', async () => {
  vi.spyOn(commands, 'gh').mockResolvedValue([reviewComment(1), reviewComment(2, 1)])
  expect(await readGithub(commands, 'github/pulls/9/comments/1')).toEqual({ messages: [
    { id: '1', from: 'carol', at: '2026-09-09T00:00:01Z', text: 'comment 1', url: 'https://github.com/acme/widgets/pull/9#discussion_r1',
      path: 'src/render.ts', line: 43 },
    { id: '2', from: 'review-bot[bot]', at: '2026-09-09T00:00:02Z', text: 'comment 2', bot: true, reply_to: '1',
      url: 'https://github.com/acme/widgets/pull/9#discussion_r2', path: 'src/render.ts', line: 43 }] })
})
it('reads a review thread from any of its comments, the first with its file, line and diff lines', async () => {
  vi.spyOn(commands, 'pages').mockResolvedValue([reviewComment(3), reviewComment(2, 1), reviewComment(1), reviewComment(4, 3)].map(item => ({
    ...item, user: { login: item.user.login, type: item.user.type } })))
  const thread = await readGithub(commands, 'github/pulls/9/thread/2') as { messages: { id: string; text: string; reply_to?: string }[] }
  expect(thread.messages.map(message => [message.id, message.reply_to])).toEqual([['1', undefined], ['2', '1']])
  expect(thread.messages[0]!.text).toBe('src/render.ts:43\n   const title = view.title\n   const margin = 12\n+  const padding = 8\n\ncomment 1')
  await expect(readGithub(commands, 'github/issues/9/thread/2')).rejects.toThrow('require a pull request')
})
it('reads an Issue or PR as its author, time, title, state, description and a PR\'s branches', async () => {
  vi.spyOn(commands, 'gh').mockResolvedValue({ number: 9, id: 1, title: 'Fix the margin', state: 'open', body: 'Details', draft: true,
    user: { login: 'carol', type: 'User' }, created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/widgets/pull/9',
    head: { ref: 'agent/fix', sha: 'abc', repo: {} }, base: { ref: 'main' }, labels: [{ name: 'ui', color: 'fff' }], node_id: 'x', _links: {} })
  expect(await readGithub(commands, 'github/pulls/9')).toEqual({ number: 9, title: 'Fix the margin', state: 'open', draft: true, head: 'agent/fix',
    base: 'main', head_sha: 'abc', labels: ['ui'], id: '9', from: 'carol', at: '2026-09-09T00:00:00Z', text: 'Details', url: 'https://github.com/acme/widgets/pull/9' })
})

it('reads a PR state in one call: head, mergeability, CI counts and latest reviews', async () => {
  const description = (head: string) => ({ number: 9, id: 1, title: 'Fix the margin', state: 'open', body: 'Details', draft: false,
    user: { login: 'carol', type: 'User' }, created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/widgets/pull/9',
    head: { ref: 'agent/fix', sha: head }, base: { ref: 'main', sha: 'base1' }, mergeable: true, mergeable_state: 'clean',
    changed_files: 2, labels: [], node_id: 'x', _links: {} })
  const gh = vi.spyOn(commands, 'gh').mockImplementation(async args => {
    const path = args[1]!
    if (path === 'repos/acme/widgets/pulls/9') return description('abc')
    if (path.startsWith('repos/acme/widgets/commits/abc/check-runs')) return [{ check_runs: [
      { name: 'build', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'completed', conclusion: 'failure' }] }]
    if (path.includes('/statuses')) return [[{ context: 'deploy', state: 'success' }]]
    // Two review pages, so the latest entries must be chosen after flattening every page.
    if (path.startsWith('repos/acme/widgets/pulls/9/reviews')) return [[reviewComment(1)], [{ ...reviewComment(2, 1), state: 'CHANGES_REQUESTED' }]]
    throw new Error(`unexpected ${path}`)
  })
  const state = await readGithub(commands, 'github/pulls/9/state') as Record<string, unknown>
  expect(state).toMatchObject({ number: 9, head: 'agent/fix', head_sha: 'abc', base: 'main', base_sha: 'base1',
    mergeable: true, mergeable_state: 'clean', changed_files: 2,
    ci: { head: 'abc', failed: 1, running: 0, failed_checks: ['lint'] },
    reviews: { total: 2, cached: false, latest: [{ id: '2', from: 'review-bot[bot]', bot: true, state: 'CHANGES_REQUESTED' }, { id: '1', from: 'carol' }] },
    read: { description: 'github/pulls/9', checks: 'github/pulls/9/checks', reviews: 'github/pulls/9/reviews/1' },
    cache: { ttl_seconds: GITHUB_READ_TTL_MS / 1000, reused: false, note: expect.stringContaining('never replaces the real-time check') } })
  // A second read reuses the checks and reviews for the same head but always reads the current description.
  const before = gh.mock.calls.length
  await readGithub(commands, 'github/pulls/9/state')
  const later = gh.mock.calls.slice(before).map(([args]) => args[1])
  expect(later).toEqual(['repos/acme/widgets/pulls/9'])
})
it('expires cached review results after the short TTL and re-reads a changed head', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    let head = 'abc'
    let reviews = 0
    vi.spyOn(commands, 'gh').mockImplementation(async args => {
      const path = args[1]!
      if (path === 'repos/acme/widgets/pulls/9') return { number: 9, id: 1, title: 'Fix', state: 'open', body: '', user: { login: 'carol', type: 'User' },
        created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/widgets/pull/9', head: { ref: 'fix', sha: head },
        base: { ref: 'main', sha: 'b' }, mergeable: true, labels: [], node_id: 'x', _links: {} }
      if (path.includes('/statuses')) return [[]]
      if (path.startsWith('repos/acme/widgets/commits/')) return [{ check_runs: [] }]
      if (path.startsWith('repos/acme/widgets/pulls/9/reviews')) { reviews++; return [[]] }
      throw new Error(`unexpected ${path}`)
    })
    await readGithub(commands, 'github/pulls/9/state')
    await readGithub(commands, 'github/pulls/9/state')
    expect(reviews).toBe(1)
    // A changed head is a different key, so its reviews are read again even inside the TTL.
    head = 'def'
    await readGithub(commands, 'github/pulls/9/state')
    expect(reviews).toBe(2)
    // The new head's entry expires after the TTL.
    vi.setSystemTime(Date.now() + GITHUB_READ_TTL_MS + 1000)
    await readGithub(commands, 'github/pulls/9/state')
    expect(reviews).toBe(3)
  } finally { vi.useRealTimers() }
})
it('pins workflow job pagination to the observed attempt and preserves skipped steps', async () => {
  const gh = vi.spyOn(commands, 'gh').mockResolvedValueOnce({ id: 42, name: 'Check', head_sha: 'abc', head_branch: 'fix',
    run_attempt: 2, event: 'pull_request', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/widgets/actions/runs/42', secret: 'not exposed' })
  expect(await readGithub(commands, 'github/actions/runs/42')).toEqual({ id: 42, name: 'Check', head_sha: 'abc', head_branch: 'fix',
    run_attempt: 2, event: 'pull_request', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/widgets/actions/runs/42',
    next_resource: 'github/actions/runs/42/attempts/2/jobs/1' })
  gh.mockResolvedValue({ total_count: 21, jobs: [{ id: 1, run_id: 42, head_sha: 'abc', name: 'overlay', status: 'completed', conclusion: 'skipped',
    html_url: 'https://github.com/acme/widgets/actions/runs/42/job/1', steps: [{ name: 'Build', number: 1, status: 'completed', conclusion: 'skipped' }] }] })
  expect(await readGithub(commands, 'github/actions/runs/42/attempts/2/jobs/1')).toMatchObject({ run_attempt: 2,
    jobs: [{ conclusion: 'skipped', steps: [{ conclusion: 'skipped' }] }], next_resource: 'github/actions/runs/42/attempts/2/jobs/2' })
  expect(gh).toHaveBeenLastCalledWith(['api', 'repos/acme/widgets/actions/runs/42/attempts/2/jobs?per_page=20&page=1'])
  gh.mockClear()
  await expect(readGithub(commands, 'github/actions/runs/42/attempts/2/jobs/1?repo=other')).rejects.toThrow()
  expect(gh).not.toHaveBeenCalled()
})
