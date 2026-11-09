/**
 * Shared pieces of the one-command installation.
 *
 * One JSON file names the profile, the two Sources and their credentials;
 * everything else is derived from it. The installer and the self-check import
 * this module so both apply the same rules.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

export const PROFILE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/
export const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
export const CHAT_PATTERN = /^oc_[A-Za-z0-9_-]{8,}$/
export const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{8,}$/
export const RECEIPT_NAME = '.enyagentdesk-install.json'
export const PATCH_MARKER = 'Managed by the EnyAgentDesk installer.'

export class ConfigError extends Error {}

function fail(message) {
  throw new ConfigError(message)
}

function string(value, name, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(`${name} is required`)
    return undefined
  }
  if (typeof value !== 'string') fail(`${name} must be a string`)
  return value.trim()
}

function list(value, name, { minimum = 1 } = {}) {
  if (!Array.isArray(value) || value.length < minimum) fail(`${name} must list at least ${minimum} entry`)
  if (value.some(entry => typeof entry !== 'string' || entry.trim() === '')) fail(`${name} entries must be non-empty strings`)
  return value.map(entry => entry.trim())
}

export function expandPath(value, name) {
  let result = string(value, name)
  if (result === '~') result = homedir()
  else if (result.startsWith('~/') || result.startsWith('~\\')) result = join(homedir(), result.slice(2))
  result = result.replaceAll('\\', '/')
  if (!isAbsolute(result)) fail(`${name} must be an absolute path: ${value}`)
  return resolve(result)
}

function existingFile(value, name) {
  const path = expandPath(value, name)
  if (!existsSync(path)) fail(`${name} does not exist: ${path}`)
  return path
}

export function loadConfig(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    fail(`Cannot read the install config: ${path}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    fail(`The install config is not valid JSON: ${error.message}`)
  }
}

/**
 * Validate and normalize one install config.
 *
 * `root` is the checkout that contains scripts/install.mjs. Derived defaults
 * never point inside it: worker directories belong to the installation, not
 * to the source checkout.
 */
export function normalizeConfig(raw, { root, home = homedir(), env = process.env } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('The install config must be a JSON object')
  if (!root || !isAbsolute(root)) fail('The installer needs its absolute checkout path')
  const profile = string(raw.profile, 'profile')
  if (!PROFILE_PATTERN.test(profile)) fail(`profile must match ${PROFILE_PATTERN}: ${profile}`)
  if (profile === 'web' || profile === 'base' || profile === 'headless') fail(`profile ${profile} is a shipped DSH profile; choose another name`)
  const port = raw.port ?? 3082
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('port must be an integer between 1024 and 65535')

  const dshHome = expandPath(raw.dshHome ?? env.DSH_HOME ?? join(home, '.dsh'), 'dshHome')
  const stateDir = expandPath(raw.stateDir, 'stateDir')
  if (stateDir === root || stateDir.startsWith(`${root}${sep}`)) fail('stateDir must be outside the source checkout; it holds private runtime state')
  if (stateDir === dshHome) fail('stateDir must be a directory for this installation, not dshHome itself')

  const github = raw.github
  if (!github || typeof github !== 'object') fail('github is required: this installation connects both GitHub and Feishu')
  const repository = string(github.repository, 'github.repository')
  if (!REPOSITORY_PATTERN.test(repository)) fail(`github.repository must be owner/name: ${repository}`)
  const githubCli = existingFile(github.cli, 'github.cli')
  const agent = string(github.agent, 'github.agent')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(agent)) fail(`github.agent is not a GitHub login: ${agent}`)
  const allowedLogins = list(github.allowed, 'github.allowed')
  for (const login of allowedLogins) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) fail(`github.allowed contains a value that is not a GitHub login: ${login}`)
  }

  const feishu = raw.feishu
  if (!feishu || typeof feishu !== 'object') fail('feishu is required: this installation connects both GitHub and Feishu')
  const feishuCli = existingFile(feishu.cli, 'feishu.cli')
  const chat = feishu.chat
  if (!chat || typeof chat !== 'object') fail('feishu.chat is required')
  const chatId = string(chat.id, 'feishu.chat.id')
  if (!CHAT_PATTERN.test(chatId)) fail(`feishu.chat.id must be a Feishu chat id (oc_…): ${chatId}`)
  const chatName = string(chat.name, 'feishu.chat.name', { required: false }) ?? chatId
  const listen = chat.listen ?? 'mentions'
  if (listen !== 'mentions' && listen !== 'all') fail('feishu.chat.listen must be "mentions" or "all"')
  if (!Array.isArray(feishu.allowed) || feishu.allowed.length === 0) fail('feishu.allowed must list at least one Feishu user')
  const allowedUsers = feishu.allowed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') fail(`feishu.allowed[${index}] must be an object`)
    const id = string(entry.id, `feishu.allowed[${index}].id`)
    if (!OPEN_ID_PATTERN.test(id)) fail(`feishu.allowed[${index}].id must be a Feishu open id (ou_…): ${id}`)
    return { id, name: string(entry.name, `feishu.allowed[${index}].name`, { required: false }) ?? id }
  })

  const executor = raw.executor ?? {}
  const directory = expandPath(executor.directory ?? join(stateDir, 'work'), 'executor.directory')
  if (directory === root || directory.startsWith(`${root}${sep}`)) fail('executor.directory must be outside the source checkout')
  const maxWorkers = executor.maxWorkers ?? 2
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 8) fail('executor.maxWorkers must be an integer between 1 and 8')
  const blockedCommands = executor.blockedCommands === undefined ? [] : list(executor.blockedCommands, 'executor.blockedCommands', { minimum: 0 })
  const prepare = executor.prepare === undefined || executor.prepare === null
    ? null
    : string(executor.prepare, 'executor.prepare')
  let model = null
  if (executor.model !== undefined && executor.model !== null) {
    const value = executor.model
    if (typeof value !== 'object' || Array.isArray(value)) fail('executor.model must be an object with provider and model')
    model = {
      provider: string(value.provider, 'executor.model.provider'),
      model: string(value.model, 'executor.model.model'),
    }
    if (value.reasoningEffort !== undefined) model.reasoningEffort = string(value.reasoningEffort, 'executor.model.reasoningEffort')
  }

  const git = raw.git
  if (!git || typeof git !== 'object') fail('git is required: workers need a commit identity')
  const gitName = string(git.name, 'git.name')
  const gitEmail = string(git.email, 'git.email')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(gitEmail)) fail(`git.email is not an email address: ${gitEmail}`)

  const apiKeyEnv = raw.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) fail('apiKeyEnv must be an environment variable name')
  const apiKeyPresent = typeof env[apiKeyEnv] === 'string' && env[apiKeyEnv] !== ''

  return {
    configPath: raw.configPath ?? null,
    profile,
    port,
    dshHome,
    stateDir,
    root,
    github: { repository, cli: githubCli, agent, allowed: allowedLogins },
    feishu: {
      cli: feishuCli,
      chat: { id: chatId, name: chatName, listen },
      allowed: allowedUsers,
      directMessages: feishu.directMessages !== false,
    },
    executor: { directory, maxWorkers, blockedCommands, prepare, model },
    git: { name: gitName, email: gitEmail },
    apiKeyEnv,
    apiKeyPresent,
    profileDir: join(dshHome, 'profiles', profile),
    receiptPath: join(dshHome, 'profiles', profile, RECEIPT_NAME),
    logPath: join(stateDir, 'install.log'),
    panelPath: join(stateDir, 'panel-url.txt'),
  }
}

function yaml(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

/** A complete managed patch file; these are the only machine values. */
export function renderProfilePatch(config) {
  return [
    `# ${PATCH_MARKER} Re-run scripts/install.mjs after editing the install config;`,
    '# do not edit this file by hand. Other profile entries stay in the DSH profile, not here.',
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    `    port: ${config.port}`,
    '- id: dsh-superagent',
    '  config:',
    `    stateDir: ${yaml(config.stateDir)}`,
    `    gitName: ${yaml(config.git.name)}`,
    `    gitEmail: ${yaml(config.git.email)}`,
    '- id: dsh-superagent-workbench',
    '  disabled: false',
    '- id: dsh-superagent-feishu',
    '  disabled: false',
    '',
  ].join('\n')
}

/** The settings blocks to save, given a current `GET settings` answer. */
export function settingsPayloads(config, current) {
  const policy = current.blocks.policy.value
  const executor = current.blocks.executor.value
  return [
    {
      block: 'executor',
      revision: current.blocks.executor.revision,
      value: {
        ...executor,
        model: config.executor.model ?? executor.model ?? null,
        maxWorkers: config.executor.maxWorkers,
        directory: config.executor.directory,
        prepare: config.executor.prepare ?? '',
        blockedCommands: [...config.executor.blockedCommands],
      },
    },
    {
      block: 'policy',
      revision: current.blocks.policy.revision,
      value: {
        ...policy,
        rules: Array.isArray(policy.rules) ? policy.rules : [],
        sources: {
          ...(policy.sources ?? {}),
          github: {
            ...(policy.sources?.github ?? {}),
            allowed: config.github.allowed.map(id => ({ id })),
            bots: policy.sources?.github?.bots ?? [],
          },
          feishu: {
            ...(policy.sources?.feishu ?? {}),
            allowed: config.feishu.allowed.map(user => ({ id: user.id, name: user.name })),
            syncChat: '',
            admission: policy.sources?.feishu?.admission ?? {},
          },
        },
      },
    },
    {
      block: 'source:github',
      revision: sourceRevision(current, 'github'),
      value: { enabled: true, config: { repository: config.github.repository, cli: config.github.cli } },
    },
    {
      block: 'source:feishu',
      revision: sourceRevision(current, 'feishu'),
      value: {
        enabled: true,
        config: {
          cli: config.feishu.cli,
          chats: [{ chatId: config.feishu.chat.id, name: config.feishu.chat.name, listen: config.feishu.chat.listen }],
          directMessages: config.feishu.directMessages,
        },
      },
    },
  ]
}

export function sourceRevision(current, kind) {
  return current.sources.find(entry => entry.kind === kind)?.revision ?? 0
}

export function readReceipt(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function isManagedPatch(text) {
  return text.includes(PATCH_MARKER)
}

/** Secret-free summary used by --dry-run and by the operator before a write. */
export function planLines(config) {
  return [
    `profile: ${config.profile}`,
    `DSH home: ${config.dshHome}`,
    `panel: http://127.0.0.1:${config.port}`,
    `state: ${config.stateDir}`,
    `worker directories: ${config.executor.directory} (max ${config.executor.maxWorkers})`,
    `GitHub: ${config.github.repository} as agent ${config.github.agent}; allowed: ${config.github.allowed.join(', ')}`,
    `Feishu: ${config.feishu.chat.name} (${config.feishu.chat.id}, ${config.feishu.chat.listen}); allowed: ${config.feishu.allowed.map(user => user.name).join(', ')}`,
    `prepare command: ${config.executor.prepare ? 'configured' : 'none'}`,
    `model key: ${config.apiKeyEnv} ${config.apiKeyPresent ? 'is set' : 'is NOT set'}`,
  ]
}

/** The `stateDir` value in one profile patch, or null when it declares none. */
export function patchStateDir(text) {
  const match = text.match(/^\s*stateDir:\s*(['"])(.*?)\1\s*$/m) ?? text.match(/^\s*stateDir:\s*(\S+)\s*$/m)
  return match ? (match[2] ?? match[1]) : null
}

/** Other profiles that point at the same state directory, which would share state. */
export function stateDirConflicts(config) {
  const profiles = join(config.dshHome, 'profiles')
  if (!existsSync(profiles)) return []
  const conflicts = []
  for (const entry of readdirSync(profiles, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === config.profile) continue
    const patch = join(profiles, entry.name, 'cordis.patch.yml')
    if (!existsSync(patch)) continue
    const other = patchStateDir(readFileSync(patch, 'utf8'))
    if (other && resolve(other) === resolve(config.stateDir)) conflicts.push(entry.name)
  }
  return conflicts
}
