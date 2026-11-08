#!/usr/bin/env node
/**
 * Read-only Feishu calendar + mailbox digest.
 *
 * This runner is deliberately outside the Superagent candidate flow: it only
 * calls the existing lark-cli read commands, writes a Markdown digest and
 * keeps its own checkpoint under this directory. It never sends mail, replies,
 * changes a calendar event, or creates a ticket.
 *
 * Usage:
 *   node digest.mjs                 run once for the current time
 *   node digest.mjs --now <ISO>     deterministic run (tests)
 *   node digest.mjs --config <path> alternate config (tests)
 *   node digest.mjs --scheduled     same as a normal run, for Task Scheduler
 */
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url))
const cliArgs = process.argv.slice(2)

function flag(name) {
  const index = cliArgs.indexOf(name)
  return index >= 0 ? cliArgs[index + 1] : undefined
}

const configPath = resolve(flag('--config') ?? join(SCRIPT_ROOT, 'config.json'))
const ROOT = dirname(configPath)
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const now = flag('--now') ? new Date(flag('--now')) : new Date()
if (Number.isNaN(now.getTime())) throw new Error(`Invalid --now value: ${flag('--now')}`)

const tz = config.timeZone
const statePath = join(ROOT, config.stateFile)
const healthPath = join(ROOT, config.healthFile)
const outputDir = join(ROOT, config.outputDir)
const logDir = join(ROOT, config.logDir)
const runStartedAt = now.toISOString()

mkdirSync(outputDir, { recursive: true })
mkdirSync(logDir, { recursive: true })
mkdirSync(dirname(statePath), { recursive: true })

// ---------------------------------------------------------------------------
// time helpers

const zonedFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})

function zoned(date) {
  return Object.fromEntries(zonedFormat.formatToParts(date).map(part => [part.type, part.value]))
}

function offsetString(date) {
  const z = zoned(date)
  const wallAsUtc = Date.UTC(+z.year, +z.month - 1, +z.day, +z.hour, +z.minute, +z.second)
  const offsetMinutes = Math.round((wallAsUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000)
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}

function isoWithOffset(date) {
  const z = zoned(date)
  return `${z.year}-${z.month}-${z.day}T${z.hour}:${z.minute}:${z.second}${offsetString(date)}`
}

function localDay(date) {
  const z = zoned(date)
  return `${z.year}-${z.month}-${z.day}`
}

function startOfLocalDay(date) {
  return new Date(`${localDay(date)}T00:00:00${offsetString(date)}`)
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

function clock(date) {
  const z = zoned(date)
  return `${z.hour}:${z.minute}`
}

function localStamp(date) {
  const z = zoned(date)
  return `${z.year}-${z.month}-${z.day} ${z.hour}:${z.minute}`
}

function shortStamp(date) {
  const z = zoned(date)
  return `${z.month}-${z.day} ${z.hour}:${z.minute}`
}

function safeDate(value) {
  if (!value) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

const runId = `${localDay(now).replaceAll('-', '')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`

// ---------------------------------------------------------------------------
// CLI + file helpers

let ownerIdentity
async function runLark(args, timeoutMs = 60_000) {
  ownerIdentity ??= (async () => {
    const auth = parseJsonOutput(await invokeLark(['auth', 'status', '--json']))
    const user = auth.identities?.user
    if (!['ready', 'needs_refresh'].includes(user?.status) || user.openId !== config.expectedUserId) {
      throw new Error('Digest user binding does not match the authorized owner; inspect the dedicated user CLI configuration')
    }
  })()
  await ownerIdentity
  return invokeLark(args, timeoutMs)
}

function invokeLark(args, timeoutMs = 60_000) {
  if (!config.larkConfigDir || !config.expectedUserId) {
    throw new Error('Configure larkConfigDir and expectedUserId for the existing authorized user; do not change the global bot policy')
  }
  const identity = args.indexOf('--as')
  if (identity >= 0 && args[identity + 1] !== 'user') throw new Error('The digest only supports the bound user identity')
  const command = identity < 0 ? [...args, '--as', 'user'] : args
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (action, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action(value)
    }
    const child = execFile(config.larkCli, command, {
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, LARKSUITE_CLI_CONFIG_DIR: config.larkConfigDir,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr ?? '').trim() || String(error.message ?? error)
        finish(reject, new Error(detail.slice(0, 800)))
        return
      }
      finish(resolve, String(stdout ?? ''))
    })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* already gone */ }
      finish(reject, new Error(`lark-cli timed out after ${timeoutMs} ms: ${args.slice(0, 3).join(' ')}`))
    }, timeoutMs)
  })
}

function parseJsonOutput(text) {
  const cleaned = String(text).split(/\r?\n/).filter(line => !line.startsWith('tip:')).join('\n')
  const start = cleaned.search(/[[{]/)
  if (start < 0) throw new Error('lark-cli returned no JSON')
  return JSON.parse(cleaned.slice(start))
}

/**
 * lark-cli reports failures as a JSON envelope on the error stream. Keep the
 * digest readable: show one short line instead of the raw 800-char payload that
 * used to be truncated mid-object and rendered as broken JSON.
 */
function errorText(error) {
  const raw = String(error?.message ?? error ?? '').trim()
  const start = raw.search(/[[{]/)
  if (start >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(start))
      const detail = parsed?.error ?? parsed
      const type = String(detail?.type ?? '').trim()
      const subtype = String(detail?.subtype ?? '').trim()
      const message = String(detail?.message ?? detail?.msg ?? '').replace(/\s+/g, ' ').trim()
      const label = [type, subtype].filter(Boolean).join('/')
      if (message) return `${label ? `[${label}] ` : ''}${message}`.slice(0, 240)
    } catch {
      // fall through to the compact raw text
    }
  }
  return raw.replace(/\s+/g, ' ').slice(0, 240) || '未知错误'
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    writeJsonAtomic(healthPath, { version: 1, status: 'error', lastRunAt: runStartedAt,
      error: 'Digest checkpoint is unreadable; no source or delivery request was made',
      delivery: { ok: false, skipped: true, reason: 'checkpoint_invalid' } })
    throw new Error('Digest checkpoint is unreadable; preserve it and inspect before retrying')
  }
}

function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

function writeTextAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, value, 'utf8')
  renameSync(temporary, path)
}

function appendLog(line) {
  const path = join(logDir, `${localDay(now)}.log`)
  try {
    const existing = readFileSync(path, 'utf8')
    writeFileSync(path, `${existing}${line}\n`, 'utf8')
  } catch {
    writeFileSync(path, `${line}\n`, 'utf8')
  }
}

// ---------------------------------------------------------------------------
// sources

function normalizeEvent(event) {
  const allDay = !event.start_time?.datetime
  const start = allDay
    ? safeDate(`${event.start_time?.date ?? localDay(now)}T00:00:00${offsetString(now)}`)
    : safeDate(event.start_time?.datetime)
  const end = allDay
    ? addDays(safeDate(`${event.end_time?.date ?? event.start_time?.date ?? localDay(now)}T00:00:00${offsetString(now)}`), 0)
    : safeDate(event.end_time?.datetime)
  return {
    id: event.event_id ?? '',
    summary: String(event.summary ?? '').trim() || '(无标题)',
    allDay,
    start,
    end,
    location: String(event.location?.name ?? event.location?.address ?? '').trim(),
    meeting: String(event.vchat?.meeting_url ?? '').trim(),
    organizer: String(event.event_organizer?.display_name ?? '').trim(),
    rsvp: String(event.self_rsvp_status ?? '').trim(),
  }
}

async function readCalendar() {
  const start = startOfLocalDay(now)
  const end = addDays(start, 1)
  const output = await runLark([
    'calendar', '+agenda', '--format', 'json', '--as', 'user',
    '--start', isoWithOffset(start), '--end', isoWithOffset(end),
  ])
  const parsed = parseJsonOutput(output)
  const events = (parsed.data ?? parsed)
    .map(normalizeEvent)
    .filter(event => event.start)
    .sort((a, b) => a.start - b.start)
  return { start, end, events }
}

function normalizeMail(message) {
  const raw = String(message.date ?? '').trim()
  let at
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    at = safeDate(raw)
  } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw)) {
    const day = raw.slice(0, 10)
    at = safeDate(`${raw.replace(' ', 'T')}:00${offsetString(new Date(`${day}T12:00:00Z`))}`)
  } else {
    at = safeDate(raw)
  }
  const labels = String(message.labels ?? '').split(',').map(value => value.trim()).filter(Boolean)
  const from = String(message.from ?? '').replace(/\u0026amp;/g, '&').trim()
  const subject = String(message.subject ?? '').replace(/\u0026amp;/g, '&').trim() || '(无主题)'
  return {
    id: String(message.message_id ?? ''),
    at,
    from,
    subject,
    unread: labels.includes('UNREAD'),
    important: labels.includes('IMPORTANT') || labels.includes('FLAGGED'),
    labels,
  }
}

function parseMailList(output) {
  const parsed = parseJsonOutput(output)
  const data = parsed.data ?? parsed
  if (!Array.isArray(data.messages)) throw new Error('Mail response has no messages array; coverage is unknown')
  return {
    messages: data.messages.map(normalizeMail),
    hasMore: Boolean(data.has_more),
    count: Number(data.count ?? data.messages.length),
    pageToken: String(data.page_token ?? ''),
  }
}

async function readMailWindow(since) {
  const querySince = new Date(Math.max(
    since.getTime() - config.mail.overlapMinutes * 60_000,
    now.getTime() - config.mail.maxLookbackHours * 3_600_000,
  ))
  const output = await runLark([
    'mail', '+triage', '--format', 'json', '--as', 'user',
    '--max', String(config.mail.pageSize), '--folder', 'INBOX',
  ])
  const page = parseMailList(output)
  const inWindow = page.messages.filter(message => message.at && message.at >= querySince)
  const oldest = page.messages.reduce((earliest, message) => {
    if (!message.at) return earliest
    return !earliest || message.at < earliest ? message.at : earliest
  }, undefined)
  const truncated = page.hasMore && Boolean(oldest) && oldest > querySince
  return { messages: page.messages, inWindow, querySince, truncated }
}

async function readUnread() {
  const output = await runLark([
    'mail', '+triage', '--format', 'json', '--as', 'user',
    '--max', String(config.mail.pageSize), '--folder', 'INBOX', '--is-unread',
  ])
  const page = parseMailList(output)
  return { messages: page.messages.filter(message => message.unread), truncated: page.hasMore }
}

/** Read plain-text bodies for the triage sections; failures degrade to subject-only advice. */
async function readBodies(messages) {
  const ids = [...new Set(messages.map(message => message.id).filter(Boolean))]
    .slice(0, TRIAGE.maxEmails ?? 30)
  const bodies = new Map()
  let error
  for (let index = 0; index < ids.length; index += 20) {
    const batch = ids.slice(index, index + 20)
    try {
      const output = await runLark([
        'mail', '+messages', '--message-ids', batch.join(','), '--html=false', '--as', 'user',
      ], 90_000)
      const parsed = parseJsonOutput(output)
      const list = parsed.data?.messages ?? parsed.messages ?? []
      for (const message of list) {
        bodies.set(String(message.message_id ?? ''), String(message.body_plain_text ?? ''))
      }
    } catch (batchError) {
      error = errorText(batchError)
      break
    }
  }
  return { bodies, error }
}

// ---------------------------------------------------------------------------
// rendering

function eventLine(event, conflict) {
  const prefix = event.allDay ? '全天' : `${clock(event.start)}–${clock(event.end ?? event.start)}`
  const ended = !event.allDay && event.end && event.end < now
  const details = [
    event.location,
    event.meeting,
    event.organizer ? `组织者：${event.organizer}` : '',
    event.rsvp === 'accept' ? '已接受' : event.rsvp === 'decline' ? '已拒绝' : event.rsvp === 'tentative' ? '待定' : '',
  ].filter(Boolean).join(' · ')
  const marks = [
    conflict ? '⚠ 时间冲突' : '',
    ended ? '（已结束）' : '',
  ].filter(Boolean).join(' ')
  return `- \`${prefix}\` ${event.summary}${details ? ` · ${details}` : ''}${marks ? ` ${marks}` : ''}`
}

// ---------------------------------------------------------------------------
// email triage

const TRIAGE = config.triage ?? {}

const GROUPS = [
  { key: 'reply', title: '需要你回复' },
  { key: 'action', title: '需要你处理' },
  { key: 'judge', title: '待你判断' },
  { key: 'ignore', title: '可忽略/推广' },
]

const CATEGORIES = {
  internal: { group: 'reply', label: '内部来信' },
  business: { group: 'reply', label: '外部业务' },
  self: { group: 'action', label: '自己转发' },
  security: { group: 'action', label: '安全/验证' },
  notification: { group: 'action', label: '账号/服务通知' },
  unknown: { group: 'judge', label: '陌生发件人' },
  newsletter: { group: 'ignore', label: '订阅/推广' },
}

function addressOf(from) {
  const text = String(from ?? '').trim()
  const angle = text.match(/<([^>]+)>/)
  return (angle ? angle[1] : text).trim().toLowerCase()
}

function displayNameOf(from) {
  const text = String(from ?? '').trim()
  const named = text.match(/^(.+?)\s*<[^>]+>$/)
  return (named ? named[1] : text).replace(/^"|"$/g, '').trim() || addressOf(text)
}

function matchesDomain(address, domains) {
  const at = address.lastIndexOf('@')
  if (at < 0) return false
  const domain = address.slice(at + 1).toLowerCase()
  return (Array.isArray(domains) ? domains : []).some(value => {
    const wanted = String(value ?? '').trim().toLowerCase()
    return Boolean(wanted) && (domain === wanted || domain.endsWith(`.${wanted}`))
  })
}

function cleanText(value, limit) {
  const text = String(value ?? '')
    .replace(/&nbsp;|\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= limit) return text
  const clipped = text.slice(0, limit)
  const boundary = Math.max(
    clipped.lastIndexOf('。'),
    clipped.lastIndexOf('！'),
    clipped.lastIndexOf('？'),
    clipped.lastIndexOf('. '),
    clipped.lastIndexOf('! '),
    clipped.lastIndexOf('? '),
    clipped.lastIndexOf(' '),
  )
  return `${clipped.slice(0, boundary > limit * 0.6 ? boundary : limit).trim()}…`
}

function deadlineOf(text) {
  const source = String(text ?? '')
  const iso = source.match(/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})/)
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`
  const cn = source.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
  if (cn) return `${cn[1]} 月 ${cn[2]} 日`
  const days = source.match(/(\d{1,3})\s*天内/)
  if (days) return `${days[1]} 天内`
  return ''
}

function classifyEmail(message, body) {
  const address = addressOf(message.from)
  const subject = String(message.subject ?? '')
  const text = `${subject} ${body}`
  if ((TRIAGE.selfAddresses ?? []).some(value => String(value).toLowerCase() === address)) return 'self'
  if (matchesDomain(address, TRIAGE.securityDomains)
    && /two-factor|two factor|security|sign[ -]?in|login|verification|验证码/i.test(text)) return 'security'
  if (/验证码\s*[:：]\s*\d{4,8}/.test(body) || /verification code|login code/i.test(subject)) return 'security'
  if (matchesDomain(address, TRIAGE.newsletterDomains)) return 'newsletter'
  if (matchesDomain(address, TRIAGE.notificationDomains)) return 'notification'
  if (matchesDomain(address, TRIAGE.internalDomains)) return 'internal'
  if (matchesDomain(address, TRIAGE.knownDomains)) return 'business'
  return 'unknown'
}

function adviceFor(category, body) {
  const deadline = deadlineOf(body)
  switch (category) {
    case 'self':
      return deadline
        ? `你自己转发的提醒；截止 ${deadline}，请在对应服务商后台处理，不要点邮件里的付款链接。无需邮件回复。`
        : '你自己转发的备忘；按正文要求处理。无需邮件回复。'
    case 'security':
      return '先确认是否本人操作；如果不是，立即改密并检查登录记录。无需邮件回复。'
    case 'notification':
      return deadline
        ? `账号/服务通知；截止 ${deadline}，按提示在对应后台处理。无需邮件回复。`
        : '账号/服务通知；按提示在对应后台处理，一般无需邮件回复。'
    case 'newsletter':
      return '订阅/推广；无需回复，可退订或归档。'
    case 'internal':
      return '内部来信，通常需要你回复；建议先读正文，再给出结论和下一步时间。'
    case 'business':
      return '外部业务来信，建议 24–48 小时内回复；先确认对方诉求、下一步和保密/NDA 安排。'
    case 'unknown':
      return '不认识的发件人；先判断是否与业务有关。推销、招聘、投资推介类可直接归档，不要点链接、不要回复。'
    default:
      return '需要你判断是否回复。'
  }
}

function buildTriage(messageLists, bodies) {
  const items = []
  const seen = new Set()
  for (const message of messageLists.flat()) {
    if (!message.id || seen.has(message.id)) continue
    seen.add(message.id)
    const body = bodies.get(message.id) ?? ''
    const category = classifyEmail(message, body)
    const deadline = category === 'self' || category === 'notification' ? deadlineOf(body) : ''
    items.push({ message, body, category, deadline })
  }
  return items
}

function excerptOf(body, category) {
  let text = cleanText(body, 2_000)
  if (category === 'internal' || category === 'business') {
    const cut = text.search(/(?:^|\s)(?:发件人|From)\s*[:：]/)
    if (cut > 60) text = text.slice(0, cut).trim()
  }
  return cleanText(text, TRIAGE.bodyChars ?? 220)
}

/** Email headers and bodies are untrusted; do not let them inject markdown links or images. */
function safeLabel(value) {
  return String(value ?? '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function safeExcerpt(body, category) {
  return excerptOf(body, category)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function renderEmailItem(item) {
  const { message, category, body, deadline } = item
  const marks = [message.unread ? '未读' : '', message.important ? '重要' : ''].filter(Boolean).join('/')
  const details = [
    `类型：${CATEGORIES[category].label}`,
    deadline ? `截止：${deadline}` : '',
    marks ? `标记：${marks}` : '',
  ].filter(Boolean).join(' ｜ ')
  const excerpt = safeExcerpt(body, category)
  return [
    `- **${safeLabel(displayNameOf(message.from))} · ${shortStamp(message.at)} · ${safeLabel(message.subject)}**`,
    `  ${details}`,
    `  建议：${adviceFor(category, body)}`,
    excerpt ? `  摘要：${excerpt}` : '  摘要：（正文未读取）',
  ].join('\n')
}

function renderDigest({
  calendar, mail, unread, calendarError, mailError, unreadError, mailSince,
  mailTruncated, unreadTruncated, bodies, bodyError,
}) {
  const lines = []
  lines.push('# 邮件分诊 + 今日日程')
  lines.push('')
  lines.push(`生成时间：${localStamp(now)}（${tz}）`)
  if (calendar) lines.push(`日程范围：${localDay(calendar.start)} 全天`)
  if (mail) lines.push(`邮件范围：自 ${localStamp(mailSince)} 起；含当前未读`)
  lines.push('')

  lines.push(`## 今日日程（${calendar ? calendar.events.length : '未读取'}）`)
  if (calendarError) {
    lines.push(`- ⚠ 日历读取失败：${calendarError}`)
  } else if (calendar.events.length === 0) {
    lines.push('今天没有日程。')
  } else {
    let previousEnd
    for (const event of calendar.events) {
      const conflict = Boolean(previousEnd && event.start < previousEnd)
      lines.push(eventLine(event, conflict))
      if (!previousEnd || (event.end && event.end > previousEnd)) previousEnd = event.end
    }
  }
  lines.push('')

  if (mailError) {
    lines.push('## 邮件分诊（未读取）')
    lines.push(`- ⚠ 邮箱读取失败：${mailError}`)
    lines.push('')
  } else {
    const items = buildTriage([mail ?? [], unread], bodies)
    lines.push(`## 邮件分诊（${items.length} 封）`)
    if (items.length === 0) {
      lines.push('这段时间没有新邮件，也没有未读邮件。')
    } else {
      for (const group of GROUPS) {
        const groupItems = items
          .filter(item => CATEGORIES[item.category].group === group.key)
          .sort((a, b) => (b.message.at?.getTime() ?? 0) - (a.message.at?.getTime() ?? 0))
        if (groupItems.length === 0) continue
        lines.push('')
        lines.push(`### ${group.title}（${groupItems.length}）`)
        for (const item of groupItems) lines.push(renderEmailItem(item))
      }
      if (mailTruncated) lines.push('', `> 新邮件窗口已截断：超过单次读取上限（${config.mail.pageSize} 封），更早的新邮件可能未覆盖。`)
      if (unreadTruncated) lines.push('', `> 未读列表已截断：单页最多 ${config.mail.pageSize} 封。`)
    }
    lines.push('')
  }

  lines.push('## 数据健康')
  lines.push(`- 日历：${calendarError ? `⚠ 失败：${calendarError}` : `成功（${calendar.events.length} 条）`}`)
  lines.push(`- 邮箱：${mailError ? `⚠ 失败：${mailError}` : `成功（新邮件 ${(mail ?? []).length} 条；未读 ${unread.length} 条；正文 ${bodies.size} 封${bodyError ? `；正文读取不完整：${bodyError}` : ''}）`}`)
  if (unreadError) lines.push(`- 未读：⚠ 失败：${unreadError}`)
  lines.push('')
  lines.push('> 只读：没有发送、回复、删除或标记邮件，也没有修改日程。')
  return `${lines.join('\n')}\n`
}

/** Sends the digest once per day to the owner's verified self-chat, matching the daily-brief delivery channel. */
async function sendDigest(text) {
  const delivery = config.delivery
  if (!delivery || delivery.mode !== 'self-chat') return { ok: false, error: 'delivery is not configured' }
  if (!delivery.chatId || !delivery.userId) return { ok: false, error: 'delivery chat/user is missing' }
  if (state.delivery?.sentDay === localDay(now) && state.delivery?.messageId) {
    return { ok: true, skipped: true, reason: 'already sent today', messageId: state.delivery.messageId, chatId: delivery.chatId }
  }
  const idempotencyKey = `cal-mail-${localDay(now).replaceAll('-', '')}`
  const output = await runLark([
    'im', '+messages-send', '--chat-id', delivery.chatId, '--markdown', text.trim(),
    '--idempotency-key', idempotencyKey, '--as', 'user',
  ], 90_000)
  const parsed = parseJsonOutput(output)
  const data = parsed.data ?? parsed
  const messageId = String(data.message_id ?? '')
  if (!messageId) throw new Error('send returned no message_id')
  return { ok: true, messageId, chatId: delivery.chatId, idempotencyKey }
}

// ---------------------------------------------------------------------------
// main

const state = readJson(statePath, {
  version: 1,
  lastRunAt: undefined,
  lastSuccessAt: undefined,
  consecutiveFailures: 0,
  mail: { since: undefined, seen: [] },
  calendar: { lastWindowStart: undefined, lastWindowEnd: undefined },
})
const defaultSince = new Date(now.getTime() - config.mail.lookbackHours * 3_600_000)
let mailSince = safeDate(state.mail?.since) ?? defaultSince
if (mailSince > now) mailSince = defaultSince
if (now.getTime() - mailSince.getTime() > config.mail.maxLookbackHours * 3_600_000) {
  mailSince = new Date(now.getTime() - config.mail.maxLookbackHours * 3_600_000)
}

const seen = new Set(Array.isArray(state.mail?.seen) ? state.mail.seen : [])

let calendar
let calendarError
let mail
let mailError
let unread = []
let unreadTruncated = false
let mailTruncated = false
let bodies = new Map()
let bodyError

try {
  calendar = await readCalendar()
} catch (error) {
  calendarError = errorText(error)
}

let unreadError
try {
  const window = await readMailWindow(mailSince)
  mail = window.inWindow.filter(message => !seen.has(message.id))
  mailTruncated = window.truncated
  try {
    const unreadPage = await readUnread()
    unread = unreadPage.messages
    unreadTruncated = unreadPage.truncated
  } catch (error) {
    unreadError = errorText(error)
  }
} catch (error) {
  mailError = errorText(error)
}

if (!mailError) {
  const bodyResult = await readBodies([...(mail ?? []), ...unread])
  bodies = bodyResult.bodies
  bodyError = bodyResult.error
}

const generationFailed = Boolean(calendarError || mailError || unreadError)

if (!calendarError) {
  state.calendar = { lastWindowStart: calendar.start.toISOString(), lastWindowEnd: calendar.end.toISOString() }
}
state.version = 1
state.lastRunAt = runStartedAt
state.consecutiveFailures = generationFailed ? (Number(state.consecutiveFailures ?? 0) + 1) : 0
if (!generationFailed) state.lastSuccessAt = runStartedAt
state.lastError = generationFailed ? (calendarError ?? mailError ?? unreadError) : undefined

const digest = renderDigest({
  calendar, mail, unread, calendarError, mailError, unreadError, mailSince,
  mailTruncated, unreadTruncated, bodies, bodyError,
})
const dayPath = join(outputDir, `${localDay(now)}.md`)
const latestPath = join(outputDir, 'latest.md')
const lastGoodPath = join(outputDir, 'last-good.md')
writeTextAtomic(dayPath, digest)
writeTextAtomic(latestPath, digest)
if (!generationFailed) writeTextAtomic(lastGoodPath, digest)

let delivery
if (cliArgs.includes('--send')) {
  try {
    delivery = await sendDigest(digest)
  } catch (error) {
    delivery = { ok: false, error: errorText(error) }
  }
} else {
  delivery = { ok: true, skipped: true }
}

if (delivery.ok && !delivery.skipped) {
  state.delivery = { sentDay: localDay(now), messageId: delivery.messageId }
  if (!mailError) state.mail = {
    since: runStartedAt,
    seen: [...new Set([...seen, ...mail.map(message => message.id)])].slice(-1000),
  }
}

const deliveryFailed = !delivery.ok
const failed = generationFailed || deliveryFailed
const status = calendarError && mailError ? 'error' : (failed || bodyError) ? 'partial' : 'ok'

const healthValue = {
  version: 1,
  status,
  runId,
  lastRunAt: runStartedAt,
  lastSuccessAt: state.lastSuccessAt,
  consecutiveFailures: state.consecutiveFailures,
  error: failed ? (calendarError ?? mailError ?? unreadError ?? delivery.error) : undefined,
  sources: {
    calendar: { ok: !calendarError, count: calendar ? calendar.events.length : 0, error: calendarError },
    mail: {
      ok: !mailError,
      newCount: mail ? mail.length : 0,
      unreadCount: unread.length,
      truncated: mailTruncated,
      bodyCount: bodies.size,
      bodyError,
      error: mailError,
    },
    unread: { ok: !mailError && !unreadError, skipped: Boolean(mailError), truncated: unreadTruncated, error: mailError ?? unreadError },
  },
  delivery,
  output: { day: dayPath, latest: latestPath, lastGood: lastGoodPath },
}
writeJsonAtomic(statePath, state)
writeJsonAtomic(healthPath, healthValue)

appendLog(`${runStartedAt} ${status} calendar=${calendar ? calendar.events.length : 'ERR'} new=${mail ? mail.length : 'ERR'} unread=${unread.length} delivery=${delivery.skipped ? 'skipped' : delivery.ok ? `sent:${delivery.messageId}` : `ERR:${delivery.error}`}${calendarError ? ` calendarError=${calendarError}` : ''}${mailError ? ` mailError=${mailError}` : ''}${unreadError ? ` unreadError=${unreadError}` : ''}`)

process.stdout.write(digest)
process.exitCode = failed ? 1 : 0
