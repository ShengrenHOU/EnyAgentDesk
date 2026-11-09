#!/usr/bin/env node
/**
 * Install one EnyAgentDesk profile from a single JSON config.
 *
 * The command is safe to re-run: it updates the profile patch and the two
 * Source settings from the config, and refuses a profile or state directory
 * that another installation owns. It never stores a credential; the GitHub and
 * Feishu wrappers and the model key environment stay the operator's own.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ConfigError, isManagedPatch, loadConfig, normalizeConfig, planLines, readReceipt,
  renderProfilePatch, settingsPayloads, stateDirConflicts,
} from './installer/config.mjs'
import { checkInstallation, failed } from './installer/check.mjs'
import { httpJson, isAlive, portInUse, run, spawnDetached, waitFor } from './installer/runtime.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WINDOWS = process.platform === 'win32'

function parseArgs(argv) {
  const options = { config: join(ROOT, 'enyagentdesk.install.json'), dryRun: false, noStart: false, noSettings: false, applyOnly: false, stop: false, selfCheck: false, skipBuild: false, noModelKey: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--config') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new ConfigError('--config needs a path')
      options.config = resolve(value)
    } else if (arg === '--dry-run' || arg === '--plan') options.dryRun = true
    else if (arg === '--no-start') options.noStart = true
    else if (arg === '--no-settings') options.noSettings = true
    else if (arg === '--apply-only') options.applyOnly = true
    else if (arg === '--stop') options.stop = true
    else if (arg === '--self-check') options.selfCheck = true
    else if (arg === '--skip-build') options.skipBuild = true
    else if (arg === '--no-model-key') options.noModelKey = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new ConfigError(`Unknown argument: ${arg}`)
  }
  return options
}

function log(line = '') {
  process.stdout.write(`${line}\n`)
}

function step(name) {
  log(`\n== ${name}`)
}

function writePrivate(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, text, { encoding: 'utf8' })
  try { chmodSync(temporary, 0o600) } catch { /* Windows has no POSIX mode */ }
  renameSync(temporary, path)
}

async function preflight(config, { noModelKey = false } = {}) {
  step('Preflight')
  if (!config.apiKeyPresent && !noModelKey) {
    throw new ConfigError(`The model provider needs ${config.apiKeyEnv}. Export it in this shell before installing; the installer never writes it to a file.`)
  }
  if (!config.apiKeyPresent) log(`  warning: ${config.apiKeyEnv} is not set; this profile must get its model from another provider configuration`)
  const checks = [
    ['node', [process.execPath, '--version']],
    ['pnpm', ['pnpm', '--version']],
    ['git', ['git', '--version']],
    ['dsh', ['dsh', '--version']],
  ]
  for (const [name, command] of checks) {
    const result = await run(command[0], command.slice(1), { capture: true })
    if (result.code !== 0) throw new ConfigError(`${name} is required but did not answer: ${result.stderr || result.stdout}`)
    log(`  ${name}: ${result.stdout.split(/\r?\n/)[0]}`)
  }
  if (existsSync(config.stateDir) && !statSync(config.stateDir).isDirectory()) throw new ConfigError(`stateDir is not a directory: ${config.stateDir}`)
  if (existsSync(config.profileDir)) {
    const patch = join(config.profileDir, 'cordis.patch.yml')
    const receipt = readReceipt(config.receiptPath)
    const managed = existsSync(patch) && isManagedPatch(readFileSync(patch, 'utf8'))
    if (!receipt && !managed) throw new ConfigError(`Profile ${config.profile} already exists and was not created by this installer (${config.profileDir}). Choose another profile name.`)
    if (receipt && receipt.stateDir !== config.stateDir) throw new ConfigError(`Profile ${config.profile} uses ${receipt.stateDir}; this config asks for ${config.stateDir}. Use a new profile for a new state directory.`)
  }
  const conflicts = stateDirConflicts(config)
  if (conflicts.length) throw new ConfigError(`stateDir ${config.stateDir} is already used by profile(s) ${conflicts.join(', ')}; each installation needs its own state directory.`)
  log('  preflight passed; no shared state was found')
}

async function installProfile(config, options) {
  step('Build')
  if (!options.skipBuild) {
    const installed = await run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: config.root })
    if (installed.code !== 0) throw new Error('pnpm install failed; fix the dependency error above and re-run')
    const built = await run('pnpm', ['build'], { cwd: config.root })
    if (built.code !== 0) throw new Error('pnpm build failed; fix the build error above and re-run')
  } else log('  skipped dependency install and build as requested')

  step('Profile and bundle')
  if (!existsSync(join(config.profileDir, 'package.json'))) {
    if (existsSync(config.profileDir)) throw new ConfigError(`Profile directory exists without package.json: ${config.profileDir}`)
    log(`  creating a new DSH profile ${config.profile} from the shipped web template`)
    const created = await run('dsh', [config.profile, '--from-default-profile', 'web', '--dump-config'], { env: { DSH_HOME: config.dshHome }, quiet: true })
    if (created.code !== 0) throw new Error(`Creating profile ${config.profile} failed; set DSH_HOME to a writable directory and try again`)
  } else {
    log(`  reusing profile ${config.profile}`)
  }

  log('  installing the bundle into the profile')
  const added = await run('dsh', ['plugin', '--profile', config.profile, 'add', `link:${config.root}`, '--ignore-scripts'], {
    env: { DSH_HOME: config.dshHome }, cwd: config.root,
  })
  if (added.code !== 0) throw new Error(`Installing the bundle into profile ${config.profile} failed`)

  const patchPath = join(config.profileDir, 'cordis.patch.yml')
  writePrivate(patchPath, renderProfilePatch(config))
  log(`  wrote ${patchPath}`)
  mkdirSync(config.stateDir, { recursive: true })
  mkdirSync(config.executor.directory, { recursive: true })

  const receipt = {
    version: 1,
    profile: config.profile,
    dshHome: config.dshHome,
    stateDir: config.stateDir,
    repository: config.github.repository,
    installedAt: new Date().toISOString(),
    pid: null,
    log: config.logPath,
  }
  const previous = readReceipt(config.receiptPath)
  if (previous?.pid && isAlive(previous.pid)) receipt.pid = previous.pid
  writePrivate(config.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  log(`  recorded ${config.receiptPath}`)
}

async function ensureService(config) {
  step('Start')
  const receipt = readReceipt(config.receiptPath) ?? {}
  if (receipt.pid && isAlive(receipt.pid)) {
    try {
      await httpJson(config.port, 'state', { timeoutMs: 2000 })
      log(`  reusing the running profile (pid ${receipt.pid})`)
      return receipt.pid
    } catch { /* a stale pid or a restart in progress: start a fresh process below */ }
  }
  if (await portInUse(config.port)) {
    throw new Error(`Port ${config.port} is already in use. Stop that process or set another port in the install config.`)
  }
  mkdirSync(config.stateDir, { recursive: true })
  mkdirSync(config.executor.directory, { recursive: true })
  writeFileSync(config.logPath, `\n# EnyAgentDesk install ${new Date().toISOString()} profile=${config.profile}\n`, { flag: 'a' })
  const pid = await spawnDetached('dsh', [config.profile, '--no-open'], {
    cwd: config.root,
    env: { DSH_HOME: config.dshHome },
    logFile: config.logPath,
  })
  log(`  started profile ${config.profile} as pid ${pid}; log ${config.logPath}`)
  receipt.pid = pid
  writePrivate(config.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  try {
    await waitFor('The DSH service', async () => {
      const state = await httpJson(config.port, 'state', { timeoutMs: 2000 })
      return state?.health?.runtime?.state === 'ready' ? state : null
    }, { timeoutMs: 180_000 })
  } catch (error) {
    const tail = readFileSync(config.logPath, 'utf8').split(/\r?\n/).slice(-25).join('\n')
    throw new Error(`${error.message}\nThe newest log lines follow:\n${tail}`)
  }
  log('  the service answers')
  return pid
}

async function verifyOwnedService(config) {
  const receipt = readReceipt(config.receiptPath)
  if (!receipt) throw new ConfigError(`No install receipt for profile ${config.profile}; run the installer first`)
  if (receipt.profile !== config.profile || resolve(receipt.stateDir) !== resolve(config.stateDir)) {
    throw new ConfigError(`The receipt for profile ${config.profile} does not describe ${config.stateDir}; refusing to change it`)
  }
  let state
  try {
    state = await httpJson(config.port, 'state')
  } catch (error) {
    throw new Error(`The service at http://127.0.0.1:${config.port} does not answer: ${error.message}`)
  }
  const running = state?.setup?.machine?.stateDir
  if (!running) throw new Error(`The service at http://127.0.0.1:${config.port} reports no state directory; refusing to change it`)
  if (resolve(running) !== resolve(config.stateDir)) {
    throw new Error(`Port ${config.port} belongs to another installation (stateDir ${running}); refusing to change it`)
  }
}

async function rememberPanelUrl(config) {
  try {
    const text = readFileSync(config.logPath, 'utf8')
    const match = [...text.matchAll(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s"'`]+/g)].at(-1)
    writePrivate(config.panelPath, `${match?.[0] ?? `http://127.0.0.1:${config.port}/`}\n`)
    log(`  panel URL written to ${config.panelPath}`)
  } catch { /* the URL is a convenience, not a readiness condition */ }
}

async function applySettings(config) {
  step('Both Sources')
  let settings = await httpJson(config.port, 'settings')
  for (const payload of settingsPayloads(config, settings)) {
    let result
    try {
      result = await httpJson(config.port, `settings/${encodeURIComponent(payload.block)}`, {
        method: 'PUT', body: { value: payload.value, revision: payload.revision }, timeoutMs: 30_000,
      })
    } catch (error) {
      if (error.status === 409) {
        settings = await httpJson(config.port, 'settings')
        const retry = settingsPayloads(config, settings).find(row => row.block === payload.block)
        result = await httpJson(config.port, `settings/${encodeURIComponent(payload.block)}`, {
          method: 'PUT', body: { value: retry.value, revision: retry.revision }, timeoutMs: 30_000,
        })
      } else if (error.status === 400 && error.body?.setup) {
        throw new Error(`The service refused ${payload.block} because its setup check failed:\n${JSON.stringify(error.body.setup, null, 2)}`)
      } else throw error
    }
    log(`  saved ${payload.block}`)
    if (result?.restarting) {
      log('  the service is restarting after this save')
      await waitFor('The DSH service after restart', async () => {
        const state = await httpJson(config.port, 'state', { timeoutMs: 2000 })
        return state?.health?.runtime?.state === 'ready' ? state : null
      }, { timeoutMs: 180_000 })
      settings = await httpJson(config.port, 'settings')
    }
  }
  log('  waiting for both Sources to become ready')
  await waitFor('Both Sources', async () => {
    const state = await httpJson(config.port, 'state')
    const ready = state?.health?.runtime?.state === 'ready'
      && state?.setup?.problem === null
      && state?.setup?.feishuProblem === null
    return ready ? state : null
  }, { timeoutMs: 240_000, intervalMs: 3_000 })
}

async function stopService(config) {
  const receipt = readReceipt(config.receiptPath)
  if (!receipt?.pid) {
    log(`No recorded process for profile ${config.profile}.`)
    return 0
  }
  if (!isAlive(receipt.pid)) {
    log(`Process ${receipt.pid} is already gone.`)
    receipt.pid = null
    writePrivate(config.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
    return 0
  }
  if (WINDOWS) await run('taskkill', ['/PID', String(receipt.pid), '/T', '/F'], { quiet: true })
  else {
    try { process.kill(-receipt.pid, 'SIGTERM') } catch { process.kill(receipt.pid, 'SIGTERM') }
  }
  const stopped = await waitFor('The service to stop', () => (isAlive(receipt.pid) ? null : true), { timeoutMs: 20_000, intervalMs: 500 }).catch(() => false)
  if (!stopped) {
    if (WINDOWS) await run('taskkill', ['/PID', String(receipt.pid), '/T', '/F'], { quiet: true })
    else { try { process.kill(-receipt.pid, 'SIGKILL') } catch { process.kill(receipt.pid, 'SIGKILL') } }
  }
  receipt.pid = null
  receipt.stoppedAt = new Date().toISOString()
  writePrivate(config.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  log(`Stopped profile ${config.profile}.`)
  return 0
}

async function report(config) {
  step('Self-check')
  const results = await checkInstallation(config)
  for (const result of results) log(`  ${result.ok ? 'ok  ' : 'FAIL'}  ${result.name}: ${result.detail}`)
  const problems = failed(results)
  if (problems.length) {
    log(`\n${problems.length} check(s) failed. The service stays running for inspection; see ${config.logPath}.`)
    return 1
  }
  log('\nAll checks passed.')
  log(`Open the panel URL in ${config.panelPath}. It contains a local login token; do not copy it into a public place.`)
  log(`Next: ask from GitHub as one of ${config.github.allowed.join(', ')} with @${config.github.agent}, or from Feishu in ${config.feishu.chat.name}.`)
  return 0
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    log(`Usage: node scripts/install.mjs --config <install.json> [--dry-run] [--no-start] [--no-settings]
       [--apply-only] [--stop] [--self-check] [--skip-build] [--no-model-key]
Read INSTALL.md for the operator steps. The config is the single source for this installation.`)
    return 0
  }
  if (!existsSync(options.config)) throw new ConfigError(`Install config not found: ${options.config}. Copy examples/install.minimal.json and fill in the placeholders.`)
  const raw = loadConfig(options.config)
  raw.configPath = options.config
  const config = normalizeConfig(raw, { root: ROOT })

  if (options.stop) return stopService(config)
  if (options.selfCheck) return report(config)
  if (options.applyOnly) {
    await verifyOwnedService(config)
    await applySettings(config)
    return report(config)
  }
  if (options.dryRun) {
    step('Plan')
    for (const line of planLines(config)) log(`  ${line}`)
    await preflight(config, { noModelKey: options.noModelKey })
    log('\nDry run complete; nothing was written.')
    return 0
  }

  await preflight(config, { noModelKey: options.noModelKey })
  await installProfile(config, options)
  if (options.noStart) {
    log('\nInstallation written. Start later with: node scripts/install.mjs --config <file>')
    return 0
  }
  await ensureService(config)
  await verifyOwnedService(config)
  await rememberPanelUrl(config)
  if (options.noSettings) {
    log('\nThe service is running with the profile patch only; Sources and policy were not saved.')
    return 0
  }
  await applySettings(config)
  await rememberPanelUrl(config)
  return report(config)
}

main().then(code => {
  process.exitCode = code ?? 0
}).catch(error => {
  process.stderr.write(`\ninstall: ${error instanceof ConfigError ? error.message : error.message}\n`)
  if (process.env.DSH_INSTALL_DEBUG && error.stack) process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
