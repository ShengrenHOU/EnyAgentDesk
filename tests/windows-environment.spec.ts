import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeEnvironment } from '../src/infra/environment.ts'

let directory: string | undefined
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })
describe.skipIf(process.platform !== 'win32')('Windows worker environment', () => {
  it('recognizes and replaces its own CRLF command shims on restart', async () => {
    directory = await mkdtemp(join(tmpdir(), 'codex-native-environment-'))
    const deployment = { stateDir: directory, repository: 'owner/trial',
      github: { cli: process.execPath, login: 'owner', noreply: 'owner@example.invalid' } }
    await writeEnvironment(deployment, [])
    await writeEnvironment(deployment, [])
    const shim = await readFile(join(directory, 'worker-bin', 'gh.cmd'), 'utf8')
    expect(shim).toContain(`"${process.execPath}" %*`)
    expect(shim).toContain('rem # Written by dsh-superagent')
    expect(await readFile(join(directory, 'worker-bin', 'lark-cli.cmd'), 'utf8')).toContain('exit /b 1')
  })
})
