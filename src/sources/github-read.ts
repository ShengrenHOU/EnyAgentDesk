/** Read-only GitHub repository, conversation, and CI check inspection for assessments and workers. */
import { z } from 'zod'
import type { ThreadFact } from '../core/index.ts'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
import { CACHE_NOTE, GITHUB_READ_TTL_MS, cachedRead } from './github-cache.ts'
import { CommentSchema, IssueSchema, isHumanLogin, reviewPlace, type GithubComment } from './github-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

const CheckSchema = z.looseObject({ name: z.string(), status: z.string(), conclusion: z.string().nullable(),
  id: z.number().optional(), head_sha: z.string().optional(), details_url: z.string().nullable().optional() })
const StatusSchema = z.looseObject({ context: z.string(), state: z.string() })
const RunSchema = z.object({ id: z.number(), name: z.string().nullable(), head_sha: z.string(), head_branch: z.string().nullable(),
  run_attempt: z.number().int().positive(), event: z.string(), status: z.string(), conclusion: z.string().nullable(), html_url: z.string() })
const JobSchema = z.object({ id: z.number(), run_id: z.number(), head_sha: z.string(), name: z.string(), status: z.string(),
  conclusion: z.string().nullable(), html_url: z.string(), steps: z.array(z.object({ name: z.string(), number: z.number(),
    status: z.string(), conclusion: z.string().nullable() })).optional() })
type Check = Pick<z.infer<typeof CheckSchema>, 'name' | 'status' | 'conclusion' | 'id' | 'head_sha' | 'details_url'>
type Status = Pick<z.infer<typeof StatusSchema>, 'context' | 'state'>

export interface CiSnapshot { head: string; checks: Check[]; statuses: Status[] }
/** Check conclusions and status states that count as failures; `success`, `neutral`, `skipped`, and `stale` do not. */
const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'error'])
export function ciCounts(snapshot: CiSnapshot): { failed: number; running: number } {
  const statuses = snapshot.statuses ?? []
  return {
    failed: snapshot.checks.filter(check => FAILING.has(check.conclusion ?? '')).length + statuses.filter(status => FAILING.has(status.state)).length,
    running: snapshot.checks.filter(check => check.status !== 'completed').length + statuses.filter(status => status.state === 'pending').length,
  }
}
export function ciSummary(snapshot: CiSnapshot, where: string, read: string): string {
  const checks = snapshot.checks.map(check => ({ name: check.name, failed: FAILING.has(check.conclusion ?? ''), running: check.status !== 'completed', outcome: check.conclusion ?? 'unknown' }))
  const statuses = (snapshot.statuses ?? []).map(status => ({ name: status.context, failed: FAILING.has(status.state), running: status.state === 'pending', outcome: status.state }))
  const results = [...checks, ...statuses]
  const failed = results.filter(result => result.failed).map(result => result.name)
  const running = results.filter(result => result.running).map(result => result.name)
  const passed = results.filter(result => !result.running && result.outcome === 'success')
  const other = results.filter(result => !result.running && !result.failed && result.outcome !== 'success')
  const names = (list: string[]) => list.slice(0, 5).join(', ') + (list.length > 5 ? `, and ${list.length - 5} more` : '')
  const at = `on ${where} at ${snapshot.head.slice(0, 7)}`
  const still = running.length ? `; ${running.length} still running` : ''
  const line = failed.length ? `CI failed ${failed.length}/${results.length} ${at}: ${names(failed)}${still}`
    : running.length ? `CI running ${running.length}/${results.length} ${at}: ${names(running)}`
      : !results.length ? `No CI checks reported ${at}`
        : other.length ? `CI completed ${at}: ${passed.length}/${results.length} passed; ${other.map(result => `${result.name}=${result.outcome}`).join(', ')}`
          : `CI passed ${passed.length}/${results.length} ${at}`
  return `${line}\nRead ${read} for every check.`
}
export function ciFailures(snapshot: CiSnapshot): string[] {
  return [...snapshot.checks.filter(check => FAILING.has(check.conclusion ?? '')).map(check => check.name),
    ...(snapshot.statuses ?? []).filter(status => FAILING.has(status.state)).map(status => status.context)].sort()
}
export function ciFact(counts: { failed: number; running: number }): ThreadFact {
  if (counts.failed) return { label: { zh: 'CI 失败', en: 'CI failed' }, value: String(counts.failed), problem: true }
  if (counts.running) return { label: { zh: 'CI 进行中', en: 'CI running' }, value: String(counts.running) }
  return { label: 'CI', value: { zh: '未见失败', en: 'no failures reported' } }
}

/** Reads a non-hidden file or directory listing from the repository's default branch via the GitHub API; hidden entries and `node_modules` are rejected. */
export async function readRepositoryPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  const resource = `contents/${parts.map(encodeURIComponent).join('/')}`
  if (kind === 'file') return commands.api(resource, '-H', 'Accept: application/vnd.github.raw')
  // GitHub returns an entry array for a directory and a single object for a file.
  const entries = await commands.api(z.union([z.array(z.looseObject({ name: z.string() })), z.looseObject({})]), resource)
  if (!Array.isArray(entries)) throw new Error(`${path} is not a directory`)
  return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}

/** Reads check runs and commit statuses for a commit without emitting a trigger. */
export async function pullChecks(commands: Commands, head: string, tally?: Tally): Promise<CiSnapshot> {
  const page = z.looseObject({ check_runs: z.array(z.unknown()) })
  const pages = await commands.api(z.array(page), `commits/${head}/check-runs?per_page=100`, '--paginate', '--slurp')
  const runs = validItems(CheckSchema, pages.flatMap(page => page.check_runs), tally)
  const statuses = await commands.pages(StatusSchema, `commits/${head}/statuses?per_page=100`, tally)
  const latest = new Map<string, string>()
  for (const status of statuses) if (!latest.has(status.context)) latest.set(status.context, status.state)
  const checks = runs.map(({ name, status, conclusion, id, head_sha, details_url }) => ({ name, status, conclusion, id, head_sha, details_url }))
  return { head, checks: checks.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    statuses: [...latest].map(([context, state]) => ({ context, state })).sort((a, b) => a.context.localeCompare(b.context)) }
}

/**
 * Reads the facts a review or merge decision looks at, in one call: the pull request's current head and base, mergeability,
 * its latest CI counts and its latest reviews. Checks and reviews are fetched in parallel and reused for a short TTL keyed by
 * the current head; the description itself is always read fresh, so a new head is never described by an old cache. The result
 * says so: reuse only saves repeated inspection and never replaces the real-time check with gh before a merge or authorization.
 */
export async function pullState(commands: Commands, number: number, tally?: Tally) {
  const path = `pulls/${number}`
  const item = await commands.api(DescriptionSchema, path)
  const head = item.head?.sha
  const [checks, reviews] = await Promise.all([
    head ? cachedRead(`checks:${commands.repository}:${head}`, GITHUB_READ_TTL_MS, () => pullChecks(commands, head, tally)) : undefined,
    // Every review page, flattened before choosing the latest: a PR with more than 100 reviews must not report an old tail.
    // The cache keeps only the total and the latest three, so a large review history cannot grow the cache.
    cachedRead(`reviews:${commands.repository}:${number}:${head ?? 'none'}`, GITHUB_READ_TTL_MS, async () => {
      const all = await commands.pages(CommentSchema, `${path}/reviews?per_page=100`, tally)
      return { total: all.length, latest: all.slice(-3).reverse() }
    }),
  ])
  const ci = checks?.value
  return {
    number: item.number, title: item.title, state: item.state, ...item.merged ? { merged: true } : {},
    ...item.draft ? { draft: true } : {}, ...item.changed_files !== undefined ? { changed_files: item.changed_files } : {},
    ...item.head?.ref ? { head: item.head.ref } : {}, ...item.base?.ref ? { base: item.base.ref } : {},
    ...head ? { head_sha: head } : {}, ...item.base?.sha ? { base_sha: item.base.sha } : {},
    ...item.mergeable !== undefined ? { mergeable: item.mergeable } : {},
    ...item.mergeable_state ? { mergeable_state: item.mergeable_state } : {},
    ...ci ? { ci: { head: ci.head, ...ciCounts(ci), failed_checks: ciFailures(ci), read: `github/pulls/${number}/checks`, cached: checks!.cached } } : {},
    reviews: { total: reviews.value.total, cached: reviews.cached,
      latest: reviews.value.latest.map(review => ({ id: String(review.id), from: review.user.login,
        at: review.submitted_at ?? review.created_at ?? '', ...review.state ? { state: review.state } : {},
        ...!isHumanLogin(review.user) ? { bot: true } : {}, ...review.html_url ? { url: review.html_url } : {} })) },
    read: { description: `github/pulls/${number}`, checks: `github/pulls/${number}/checks`, reviews: `github/pulls/${number}/reviews/1` },
    cache: { ttl_seconds: GITHUB_READ_TTL_MS / 1000, reused: !!checks?.cached || reviews.cached, note: CACHE_NOTE },
  }
}

/** Formats a GitHub comment, review, or issue as a model-facing ContextMessage, marking bots and GitHub Apps because bot messages never authorize work. */
function githubMessage(item: GithubComment, text: string, id: string): ContextMessage {
  const line = item.line ?? item.original_line
  return { id, from: item.user.login, at: item.created_at ?? item.submitted_at ?? '', text,
    ...!isHumanLogin(item.user) ? { bot: true } : {}, ...item.html_url ? { url: item.html_url } : {},
    ...item.path ? { path: item.path, ...line != null ? { line } : {} } : {} }
}
const reviewText = (review: GithubComment): string =>
  [review.state && review.state !== 'COMMENTED' ? review.state : '', review.body ?? ''].filter(Boolean).join('\n\n')
const DescriptionSchema = IssueSchema.extend({
  changed_files: z.number().optional(),
  labels: z.array(z.looseObject({ name: z.string() })).nullish(), draft: z.boolean().nullish(), merged: z.boolean().nullish(),
  head: z.looseObject({ ref: z.string(), sha: z.string().optional() }).nullish(), base: z.looseObject({ ref: z.string(), sha: z.string().optional() }).nullish(),
  mergeable: z.boolean().nullable().optional(), mergeable_state: z.string().optional(),
})
async function reviewThread(commands: Commands, number: number, comment: number, tally?: Tally): Promise<GithubComment[]> {
  const comments = await commands.pages(CommentSchema, `pulls/${number}/comments?per_page=100`, tally)
  const root = comments.find(item => item.id === comment)?.in_reply_to_id ?? comment
  return comments.filter(item => item.id === root || item.in_reply_to_id === root)
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
}
function threadMessages(thread: GithubComment[], id: (comment: GithubComment) => string): ContextMessage[] {
  const [first] = thread
  return thread.map(item => item === first
    ? githubMessage(item, [reviewPlace(item), item.body ?? ''].filter(Boolean).join('\n\n'), id(item))
    : { ...githubMessage(item, item.body ?? '', id(item)), ...first ? { reply_to: id(first) } : {} })
}

/**
 * Reads an Issue or PR, a page of its comments or reviews, a review thread, or a CI snapshot as model-facing
 * `{ id, from, at, text, reply_to?, path?, line?, url }` messages rather than raw GitHub API records.
 */
export async function readGithub(commands: Commands, resource: string): Promise<unknown> {
  const scoped = /^github\/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(.+)$/.exec(resource)
  if (scoped) {
    if (scoped[2]!.startsWith('repos/')) throw new Error('Nested repository selection is not supported')
    const result = await readGithub(commands.forReadRepository(scoped[1]!), `github/${scoped[2]}`)
    if (result && typeof result === 'object' && 'next_resource' in result && typeof result.next_resource === 'string') {
      return { ...result, next_resource: result.next_resource.replace(/^github\//, `github/repos/${scoped[1]}/`) }
    }
    return result
  }
  const files = /^github\/pulls\/([1-9]\d*)\/files\/([1-9]\d*)$/.exec(resource)
  if (files) {
    const items = await commands.api(z.array(z.object({ filename: z.string(), status: z.string(), additions: z.number(), deletions: z.number(),
      patch: z.string().optional(), previous_filename: z.string().optional() })), `pulls/${files[1]}/files?per_page=20&page=${files[2]}`)
    return { files: items, note: 'GitHub limits this list to 3000 files and may omit or truncate patches; compare the PR changed_files count and read full files at the head/base SHA.',
      ...items.length === 20 ? { next_resource: `github/pulls/${files[1]}/files/${Number(files[2]) + 1}` } : {} }
  }
  const file = /^github\/commits\/([0-9a-f]{40})\/file\/(.+)$/.exec(resource)
  if (file) {
    const parts = file[2]!.split('/')
    if (parts.some(part => !part || part === '.' || part === '..' || part === '.git' || part.includes('\\'))) throw new Error('Invalid repository file path')
    return { head: file[1], path: file[2], content: await commands.api(`contents/${parts.map(encodeURIComponent).join('/')}?ref=${file[1]}`, '-H', 'Accept: application/vnd.github.raw') }
  }
  const run = /^github\/actions\/runs\/([1-9]\d*)(?:\/attempts\/([1-9]\d*)\/jobs\/([1-9]\d*))?$/.exec(resource)
  if (run) {
    const [, id, attempt, page] = run
    if (!attempt) {
      const item = await commands.api(RunSchema, `actions/runs/${id}`)
      return { ...item, next_resource: `github/actions/runs/${id}/attempts/${item.run_attempt}/jobs/1` }
    }
    const result = await commands.api(z.object({ total_count: z.number(), jobs: z.array(JobSchema) }),
      `actions/runs/${id}/attempts/${attempt}/jobs?per_page=20&page=${page}`)
    return { run_id: Number(id), run_attempt: Number(attempt), ...result,
      ...Number(page) * 20 < result.total_count ? { next_resource: `github/actions/runs/${id}/attempts/${attempt}/jobs/${Number(page) + 1}` } : {} }
  }
  // A commit's CI, such as the default branch's, which no PR names.
  const commit = /^github\/commits\/([0-9a-f]{7,40})\/checks$/.exec(resource)
  if (commit) return pullChecks(commands, commit[1]!)
  // One read for the facts a review or merge decision looks at: head and base, mergeability, checks and reviews.
  const state = /^github\/pulls\/([1-9]\d*)\/state$/.exec(resource)
  if (state) return pullState(commands, Number(state[1]))
  const match = /^github\/(issues|pulls)\/([1-9]\d*)(?:\/(comments|reviews|checks|thread)(?:\/([1-9]\d*))?)?$/.exec(resource)
  if (!match) {
    throw new Error('Use github/issues/<number>, github/pulls/<number>, github/pulls/<number>/state, or append /comments/<page>, '
      + '/reviews/<page>, /thread/<comment-id> or /checks; or github/commits/<sha>/checks')
  }
  const [, kind, number, section, page = '1'] = match
  if (kind === 'issues' && (section === 'reviews' || section === 'checks' || section === 'thread')) {
    throw new Error('Reviews, review threads and checks require a pull request')
  }
  const path = `${kind}/${number}`
  if (section === 'checks') {
    if (match[4]) throw new Error('Checks do not take a page number')
    const pr = await commands.api(z.looseObject({ head: z.looseObject({ sha: z.string() }) }), path)
    return pullChecks(commands, pr.head.sha)
  }
  if (section === 'thread') {
    if (!match[4]) throw new Error('Name the review thread by one of its comments: github/pulls/<number>/thread/<comment-id>')
    const thread = await reviewThread(commands, Number(number), Number(match[4]))
    if (!thread.length) throw new Error('No review comment of this PR has that id')
    return { messages: threadMessages(thread, item => String(item.id)) }
  }
  if (!section) {
    const item = await commands.api(DescriptionSchema, path)
    const branches = item.head && item.base ? { head: item.head.ref, base: item.base.ref,
      head_sha: item.head.sha, base_sha: item.base.sha, mergeable: item.mergeable, mergeable_state: item.mergeable_state } : {}
    const labels = item.labels?.length ? { labels: item.labels.map(label => label.name) } : {}
    return { number: item.number, title: item.title, state: item.state, ...item.merged ? { merged: true } : {},
      ...item.changed_files !== undefined ? { changed_files: item.changed_files } : {},
      ...item.draft ? { draft: true } : {}, ...branches, ...labels, ...githubMessage(item, item.body ?? '', String(item.number)) }
  }
  const listed = await commands.api(z.array(z.unknown()), `${path}/${section}?per_page=20&page=${page}`)
  const tally = { skipped: 0 }
  const items = validItems(CommentSchema, listed, tally)
  const messages = items.map(item => section === 'reviews'
    ? githubMessage({ ...item, created_at: item.submitted_at ?? item.created_at }, reviewText(item), String(item.id))
    : { ...githubMessage(item, item.body ?? '', String(item.id)), ...item.in_reply_to_id ? { reply_to: String(item.in_reply_to_id) } : {} })
  return { messages, ...tally.skipped ? { skipped: tally.skipped } : {},
    ...listed.length === 20 ? { next_resource: `github/${kind}/${number}/${section}/${Number(page) + 1}` } : {} }
}
/** Reads one page of an Issue or PR conversation (with the Issue/PR description first on page 1), using comment URLs as message IDs. */
async function conversationPage(commands: Commands, number: number, page: number) {
  const messages: ContextMessage[] = []
  if (page === 1) {
    const issue = await commands.api(IssueSchema, `issues/${number}`)
    messages.push(githubMessage(issue, `${issue.title}\n\n${issue.body ?? ''}`, issue.html_url))
  }
  const listed = await commands.api(z.array(z.unknown()), `issues/${number}/comments?per_page=100&page=${page}`)
  const tally = { skipped: 0 }
  const comments = validItems(CommentSchema, listed, tally)
  messages.push(...comments.map(comment => githubMessage(comment, comment.body ?? '', comment.html_url ?? String(comment.id))))
  return { messages, next_resource: listed.length === 100 ? String(page + 1) : null, ...tally.skipped ? { skipped: tally.skipped } : {} }
}
/**
 * Context reader for a GitHub Trigger: reads the review thread for an inline review comment (whose first comment is its
 * root and parent), or the Issue/PR conversation by page otherwise (whose first page is its root and parent).
 */
export const githubThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.url ?? '',
  read: async (commands, trigger, part, cursor) => {
    if (typeof trigger.meta.repository === 'string') commands = commands.forRepository(trigger.meta.repository)
    // The default branch's CI has no conversation; its Trigger is its context.
    if (typeof trigger.meta.branch === 'string') {
      const message = { id: trigger.url ?? trigger.id, from: 'CI', at: trigger.at, text: trigger.text, bot: true as const }
      return { messages: [message], body: { status: 'branch_ci', messages: [message] }, status: 'branch_ci' }
    }
    const number = Number(trigger.meta.number)
    if (trigger.meta.kind === 'inline' && typeof trigger.meta.commentId === 'number') {
      const thread = await reviewThread(commands, number, trigger.meta.commentId)
      const messages = threadMessages(thread, item => item.html_url ?? String(item.id))
      const read = part === 'thread' ? messages : messages.slice(0, 1)
      return { messages: read, body: { status: 'review_thread', messages: read }, status: 'review_thread' }
    }
    const body = await conversationPage(commands, number, Number(cursor ?? '1'))
    return { messages: body.messages, next: body.next_resource ?? undefined, body }
  },
}
