/** Prepare an offline profile patch using Cordis's own YAML dialect; never start or overwrite a live profile. */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const cordis = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json'))
const include = cordis.resolve('@deepseek-ai/cordis-plugin-include')
const { entryListSchema } = await import(pathToFileURL(include).href)
const yaml = createRequire(include)('js-yaml')

export function migrateLarkAccount(text) {
  let patches
  try { patches = yaml.load(text, { schema: entryListSchema }) }
  catch { throw new Error('Invalid Cordis profile YAML; inspect the private input file') }
  if (!Array.isArray(patches)) throw new Error('Expected a Cordis profile patch list')
  const fields = { configDir: 'configDir', larkCli: 'larkCli', expectedOwner: 'expectedUserId', expectedUserId: 'expectedUserId', eventCommand: 'eventCommand' }
  const account = {}, old = new Set(['dsh-superagent-activity', 'dsh-superagent-lark-workspace'])
  const accountId = 'dsh-superagent-lark-account'
  const assign = (name, value) => {
    if (value === '' || Array.isArray(value) && value.length === 0) return
    if (name === 'eventCommand' ? !Array.isArray(value) || !value.every(v => typeof v === 'string' && v.length) : typeof value !== 'string') {
      throw new Error(`Resolve the ${name} account expression before migration`)
    }
    if (['configDir', 'larkCli'].includes(name) && win32.isAbsolute(value) && win32.parse(value).root.length > 1) value = win32.normalize(value)
    if (account[name] !== undefined && JSON.stringify(account[name]) !== JSON.stringify(value)) throw new Error(`Conflicting personal ${name}; select the intended account explicitly`)
    account[name] = value
  }
  const visit = rows => {
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid Cordis patch row')
      if (row.insert) visit(row.insert)
      if (row.group && Array.isArray(row.config)) visit(row.config)
      if (row.id !== accountId && !old.has(row.id)) continue
      if (row.config === undefined) continue
      if (!row.config || typeof row.config !== 'object' || Array.isArray(row.config)) throw new Error('Expected a literal account configuration')
      for (const [key, name] of Object.entries(fields)) if (Object.hasOwn(row.config, key)) {
        assign(name, row.config[key])
        if (old.has(row.id)) delete row.config[key]
      }
    }
  }
  visit(patches)
  if (!Object.keys(account).length) return text
  const existing = patches.filter(row => row.id === accountId)
  if (existing.length > 1) throw new Error('Consolidate duplicate account plugin overrides before migration')
  if (existing.length) existing[0].config = { ...existing[0].config, ...account }
  else patches.push({ id: accountId, config: account })
  return yaml.dump(patches, { schema: entryListSchema, lineWidth: -1, noRefs: true })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' } } })
    if (!values.input || !values.output) throw new Error('Supply --input and a new private --output path')
    const result = migrateLarkAccount(readFileSync(values.input, 'utf8'))
    writeFileSync(values.output, result, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    console.log('Candidate profile written; activation has not been attempted.')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
