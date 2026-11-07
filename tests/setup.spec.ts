import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Setup } from '../src/app/setup.ts'
import { Commands } from '../src/infra/commands.ts'
import { SettingsSchema } from '../src/policy.ts'
import { testMachine } from './fixtures/deployment.ts'
import { SetupError } from '../src/setup.ts'

let directory: string
let setup: Setup
/** Every variable `proxyVariables` writes; the run changes them in this process too. */
const PROXY_VARIABLES = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy'] as const
let environment: Record<string, string | undefined>
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'setup-'))
  environment = Object.fromEntries(PROXY_VARIABLES.map(name => [name, process.env[name]]))
})
afterEach(() => {
  setup?.restore()
  for (const name of PROXY_VARIABLES) {
    if (environment[name] === undefined) delete process.env[name]
    else process.env[name] = environment[name]
  }
  rmSync(directory, { recursive: true, force: true })
})

const settings = (proxy: string) => SettingsSchema.parse({ executor: { proxy } })
const noProxy = 'localhost,127.0.0.1,::1'

it('allows account recheck after GitHub-only degradation and clears stale problems on success', async () => {
  const restart = vi.fn()
  setup = new Setup({ context: {} as Context, machine: testMachine({ stateDir: directory }),
    lifetime: new AbortController().signal, restart })
  await setup.run(settings(''))
  setup.githubProblem = new SetupError('agentCliUnset').problem
  expect(() => setup.check()).not.toThrow()
  await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce())
  setup.feishuProblem = new SetupError('feishuNoBot').problem
  await setup.run(settings(''))
  expect(setup.githubProblem).toBeUndefined()
  expect(setup.feishuProblem).toBeUndefined()
  expect(() => setup.check()).toThrow()
})

it('updates the command environment that host commands already hold when setup applies a proxy', async () => {
  setup = new Setup({ context: {} as Context, machine: testMachine({ stateDir: directory }), lifetime: new AbortController().signal,
    restart: () => {} })
  // Runtime hands this object to `Commands` before setup runs; a snapshot here would leave host commands without the proxy.
  const commandEnvironment = setup.commandEnvironment
  const commands = new Commands(() => setup.deployment, commandEnvironment, new AbortController().signal)
  const seenProxy = async () => JSON.parse(await commands.run(process.execPath,
    ['-p', 'JSON.stringify(process.env.HTTPS_PROXY ?? null)'])) as string | null
  await expect(setup.run(settings('http://127.0.0.1:7897'))).resolves.toBe(true)
  expect(setup.commandEnvironment).toBe(commandEnvironment)
  // Both spellings are set because curl reads the lowercase one first; an inherited ALL_PROXY fallback is cleared.
  expect(commandEnvironment).toMatchObject({ HTTPS_PROXY: 'http://127.0.0.1:7897', HTTP_PROXY: 'http://127.0.0.1:7897',
    https_proxy: 'http://127.0.0.1:7897', http_proxy: 'http://127.0.0.1:7897', NO_PROXY: noProxy, no_proxy: noProxy })
  expect(commandEnvironment.ALL_PROXY).toBeUndefined()
  expect(process.env.ALL_PROXY).toBeUndefined()
  expect(process.env.HTTPS_PROXY).toBe('http://127.0.0.1:7897')
  // A host command spawned through the Commands built before setup uses the same value, as GitHub and Feishu polling do.
  expect(await seenProxy()).toBe('http://127.0.0.1:7897')
  await expect(setup.run(settings(''))).resolves.toBe(true)
  for (const name of PROXY_VARIABLES) expect(commandEnvironment[name]).toBeUndefined()
  expect(process.env.HTTPS_PROXY).toBeUndefined()
  expect(process.env.http_proxy).toBeUndefined()
  expect(await seenProxy()).toBeNull()
})
