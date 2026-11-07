/** Verify the installed bundle shares the host's peer modules under native DSH profile resolution. */
import assert from 'node:assert/strict'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [installation, directory] = process.argv.slice(2)
assert(installation && directory, 'Usage: node scripts/check-runtime-peers.mjs <dsh/package.json> <profile-directory>')
const installAnchor = resolve(installation), profileDir = resolve(directory)
const hostRequire = createRequire(installAnchor)
const { Context } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')).href)
const { loadProfileDirectory, createRuntimeResolution, PluginPackages } = await import(
  pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-app-boot')).href)
const profile = loadProfileDirectory('dsh', profileDir, installAnchor, { userLayer: false })
const resolution = await createRuntimeResolution({ installAnchor, profile, home: resolve(profileDir, '../..') })
const packages = new PluginPackages(new Context(), { resolution })
const bundle = packages.packageOf('dsh-superagent', pathToFileURL(join(profileDir, 'package.json')).href)
assert(bundle, 'The profile does not resolve dsh-superagent')
const importer = pathToFileURL(join(bundle.dir, 'lib/index.js')).href
const modulesPath = join(bundle.dir, 'node_modules')
const localModules = existsSync(modulesPath) ? { path: modulesPath, realPath: realpathSync(modulesPath),
  isLink: lstatSync(modulesPath).isSymbolicLink() } : null
const checks = Object.keys(bundle.manifest.peerDependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/')).flatMap(name => {
  const expected = resolution.entries.find(entry => entry.name === name && entry.scope === 'installation')
  if (!expected) return []
  const actual = packages.packageOf(name, importer)
  return [{ name, expectedVersion: expected.version, actualVersion: actual?.version,
    shared: !!actual && realpathSync(actual.dir) === realpathSync(expected.packageDir) }]
})
assert(checks.some(check => check.name === '@deepseek-ai/dsh-scope'), 'The host does not expose its scope runtime')
const failures = checks.filter(check => !check.shared)
console.log(JSON.stringify({ package: bundle.name, version: bundle.version, localModules, checks, passed: failures.length === 0 }, null, 2))
process.exitCode = failures.length ? 1 : 0
