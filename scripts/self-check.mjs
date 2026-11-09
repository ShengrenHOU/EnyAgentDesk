#!/usr/bin/env node
/** Verify one installed profile against its single install config. */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigError, loadConfig, normalizeConfig } from './installer/config.mjs'
import { checkInstallation, failed } from './installer/check.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const options = { config: join(ROOT, 'enyagentdesk.install.json'), offline: false, credentials: true, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--config') {
      const value = argv[++index]
      if (!value) throw new ConfigError('--config needs a path')
      options.config = resolve(value)
    } else if (arg === '--offline') options.offline = true
    else if (arg === '--no-credentials') options.credentials = false
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new ConfigError(`Unknown argument: ${arg}`)
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write('Usage: node scripts/self-check.mjs --config <install.json> [--offline] [--no-credentials] [--json]\n')
    return 0
  }
  if (!existsSync(options.config)) throw new ConfigError(`Install config not found: ${options.config}`)
  const raw = loadConfig(options.config)
  raw.configPath = options.config
  const config = normalizeConfig(raw, { root: ROOT })
  const results = await checkInstallation(config, { offline: options.offline, credentials: options.credentials })
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ profile: config.profile, port: config.port, ok: failed(results).length === 0, results }, null, 2)}\n`)
  } else {
    for (const result of results) process.stdout.write(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.name}: ${result.detail}\n`)
  }
  return failed(results).length ? 1 : 0
}

main().then(code => {
  process.exitCode = code ?? 0
}).catch(error => {
  process.stderr.write(`self-check: ${error.message}\n`)
  if (process.env.DSH_INSTALL_DEBUG && error.stack) process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
