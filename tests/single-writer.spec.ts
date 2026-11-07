/** The single-writer rule: only the Engine's core parts and the supported startup migration write Tickets. */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
/** `src/core` holds the Engine's parts; the startup migration is its only supported other writer. */
const ALLOWED = [/^src\/core\//, /^src\/app\/migration\.ts:/]

it('writes Tickets only in the Engine, apart from the startup migration', () => {
  const callSites = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter(path => /\.tsx?$/.test(path)).flatMap(path => {
    const file = `src/${path.replaceAll('\\', '/')}`
    return readFileSync(join(SRC, path), 'utf8').split(/\r?\n/).flatMap((line, index) =>
      [...line.matchAll(/tickets\.save\(/g)].map(() => `${file}:${index + 1}: ${line.trim()}`))
  })
  expect(callSites.filter(site => !ALLOWED.some(pattern => pattern.test(site)))).toEqual([])
  // The rule is not vacuous: the Engine's parts write Tickets here, and the migration does too.
  expect(callSites.filter(site => site.startsWith('src/core/')).length).toBeGreaterThan(0)
  expect(callSites.filter(site => site.startsWith('src/app/migration.ts:')).length).toBeGreaterThan(0)
})
