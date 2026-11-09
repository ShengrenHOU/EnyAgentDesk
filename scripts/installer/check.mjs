/** Verification shared by `scripts/self-check.mjs` and the install command. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isManagedPatch, readReceipt, stateDirConflicts } from './config.mjs'
import { httpJson, run } from './runtime.mjs'

function entry(name, ok, detail) {
  return { name, ok, detail }
}

function patchCheck(config) {
  const patch = join(config.profileDir, 'cordis.patch.yml')
  if (!existsSync(patch)) return entry('profile patch', false, `missing ${patch}`)
  const text = readFileSync(patch, 'utf8')
  if (!isManagedPatch(text)) return entry('profile patch', false, `${patch} is not managed by this installer`)
  for (const id of ['- id: dsh-superagent\n', '- id: dsh-superagent-feishu\n']) {
    if (!text.includes(id)) return entry('profile patch', false, `${patch} does not contain ${JSON.stringify(id.trim())}`)
  }
  if (!text.includes('- id: dsh-superagent-feishu\n  disabled: false')) return entry('profile patch', false, `${patch} does not enable the Feishu Source`)
  if (!text.includes(`port: ${config.port}`)) return entry('profile patch', false, `${patch} does not contain port ${config.port}`)
  if (!text.includes(config.stateDir)) return entry('profile patch', false, `${patch} does not contain stateDir ${config.stateDir}`)
  return entry('profile patch', true, `${patch} enables both Sources on port ${config.port}`)
}

function receiptCheck(config) {
  const receipt = readReceipt(config.receiptPath)
  if (!receipt) return entry('install receipt', false, `missing ${config.receiptPath}`)
  if (receipt.profile !== config.profile) return entry('install receipt', false, `receipt names profile ${receipt.profile}`)
  if (receipt.stateDir !== config.stateDir) return entry('install receipt', false, `receipt names stateDir ${receipt.stateDir}`)
  return entry('install receipt', true, `${config.receiptPath} matches this config`)
}

function stateIsolationCheck(config) {
  if (!existsSync(config.stateDir)) return entry('state directory', false, `missing ${config.stateDir}`)
  const conflicts = stateDirConflicts(config)
  if (conflicts.length) return entry('state isolation', false, `profiles ${conflicts.join(', ')} use the same stateDir`)
  return entry('state isolation', true, `${config.stateDir} is used by ${config.profile} only`)
}

function modelKeyCheck(config) {
  return config.apiKeyPresent
    ? entry('model key', true, `${config.apiKeyEnv} is present in this process`)
    : entry('model key', false, `${config.apiKeyEnv} is not set; export it before starting or installing`)
}

async function githubCliCheck(config) {
  const result = await run(config.github.cli, ['api', 'user', '--jq', '.login'], { capture: true, quiet: true })
  if (result.code !== 0) return entry('GitHub CLI', false, `${config.github.cli} cannot read its account: ${result.stderr || result.stdout}`)
  const login = result.stdout.trim()
  if (login !== config.github.agent) return entry('GitHub CLI', false, `${config.github.cli} answers as ${login}, expected ${config.github.agent}`)
  return entry('GitHub CLI', true, `${config.github.cli} is signed in as ${login}`)
}

function settingsEntries(config, settings) {
  const entries = []
  const github = settings.sources?.find(source => source.kind === 'github')
  const feishu = settings.sources?.find(source => source.kind === 'feishu')
  if (!github?.value?.enabled) entries.push(entry('GitHub Source', false, 'Source is disabled'))
  else if (github.value.config?.repository !== config.github.repository) {
    entries.push(entry('GitHub Source', false, `repository is ${github.value.config?.repository}, expected ${config.github.repository}`))
  } else entries.push(entry('GitHub Source', true, github.value.config.repository))

  if (!feishu?.value?.enabled) entries.push(entry('Feishu Source', false, 'Source is disabled'))
  else if (feishu.value.config?.chats?.[0]?.chatId !== config.feishu.chat.id) {
    entries.push(entry('Feishu Source', false, `chat is ${feishu.value.config?.chats?.[0]?.chatId}, expected ${config.feishu.chat.id}`))
  } else entries.push(entry('Feishu Source', true, config.feishu.chat.name))

  const policy = settings.blocks.policy.value
  const githubAllowed = new Set((policy.sources?.github?.allowed ?? []).map(row => row.id))
  const missingGitHub = config.github.allowed.filter(id => !githubAllowed.has(id))
  entries.push(missingGitHub.length
    ? entry('GitHub policy', false, `allowed list misses ${missingGitHub.join(', ')}`)
    : entry('GitHub policy', true, [...githubAllowed].join(', ')))
  const feishuAllowed = new Set((policy.sources?.feishu?.allowed ?? []).map(row => row.id))
  const missingFeishu = config.feishu.allowed.filter(user => !feishuAllowed.has(user.id))
  entries.push(missingFeishu.length
    ? entry('Feishu policy', false, `allowed list misses ${missingFeishu.map(user => user.name).join(', ')}`)
    : entry('Feishu policy', true, config.feishu.allowed.map(user => user.name).join(', ')))

  const executor = settings.blocks.executor.value
  const executorOk = executor.directory === config.executor.directory
    && executor.maxWorkers === config.executor.maxWorkers
    && JSON.stringify([...(executor.blockedCommands ?? [])].sort()) === JSON.stringify([...config.executor.blockedCommands].sort())
  entries.push(executorOk
    ? entry('executor', true, `${executor.directory}, max ${executor.maxWorkers}`)
    : entry('executor', false, `expected ${config.executor.directory}, max ${config.executor.maxWorkers}`))
  return entries
}

/**
 * Collect every check. `offline` skips the loopback API and CLI identity
 * checks; `credentials` false skips only the CLI identity checks.
 */
export async function checkInstallation(config, { offline = false, credentials = true } = {}) {
  const results = [patchCheck(config), receiptCheck(config), modelKeyCheck(config)]
  results.push(stateIsolationCheck(config))
  if (!offline && credentials) results.push(await githubCliCheck(config))
  if (offline) return results

  try {
    const state = await httpJson(config.port, 'state')
    const runtime = state.health?.runtime?.state ?? 'missing'
    results.push(runtime === 'ready' ? entry('runtime', true, 'ready') : entry('runtime', false, `runtime is ${runtime}`))
    results.push(state.setup?.problem === null
      ? entry('GitHub setup', true, 'no problem')
      : entry('GitHub setup', false, state.setup?.problem?.detail ?? state.setup?.problem ?? 'missing setup state'))
    results.push(state.setup?.feishuProblem === null
      ? entry('Feishu setup', true, 'no problem')
      : entry('Feishu setup', false, state.setup?.feishuProblem?.detail ?? state.setup?.feishuProblem ?? 'missing setup state'))

    const settings = await httpJson(config.port, 'settings')
    results.push(...settingsEntries(config, settings))
    const sources = await httpJson(config.port, 'sources')
    for (const kind of ['github', 'feishu']) {
      const source = sources.find(row => row.id === kind || row.kind === kind)
      const status = source?.state ?? 'missing'
      results.push(status === 'ready'
        ? entry(`${kind} health`, true, 'ready')
        : entry(`${kind} health`, false, `state is ${status}${source?.problem?.detail ? `: ${source.problem.detail}` : ''}`))
    }
  } catch (error) {
    results.push(entry('service', false, error.message))
  }
  return results
}

export function failed(results) {
  return results.filter(result => !result.ok)
}
