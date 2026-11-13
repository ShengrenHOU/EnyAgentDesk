/** User-identity lark-cli reads shared by the owner-delegated Sources; the bot identity is never used here. */
import { z } from 'zod'
import { CliError, type Commands } from '../infra/commands.ts'

export interface LarkUserBinding {
  /** Absolute path or command name of the native lark-cli; empty falls back to the deployment's Feishu CLI. */
  cli?: string
  /** `strictMode=user` configuration directory; empty inherits the process configuration. */
  configDir?: string
  expectedUserId: string
}
const AuthStatus = z.object({ identities: z.object({ user: z.object({ status: z.enum(['ready', 'needs_refresh']), openId: z.string().min(1) }) }) })
const Envelope = z.object({ ok: z.boolean(), identity: z.string().optional(), data: z.unknown().optional(),
  error: z.object({ code: z.number().optional(), type: z.string().optional(), subtype: z.string().optional() }).optional() })
/** Parses lark-cli JSON, refusing HTML or diagnostics that would otherwise look like an empty result. */
export function parseLarkJson(value: string): unknown {
  try { return JSON.parse(value) }
  catch { throw new Error('Lark returned invalid JSON') }
}
/** Throws the CLI's own code for an error envelope so a transient failure retries and a permission failure stays visible. */
export function larkEnvelope(output: string): unknown {
  const envelope = Envelope.parse(parseLarkJson(output))
  if (!envelope.ok) throw new CliError(`Lark read failed: ${envelope.error?.subtype ?? envelope.error?.type ?? 'unknown'}`, envelope.error?.code)
  if (envelope.identity !== 'user') throw new Error('Lark returned an unexpected identity')
  return envelope.data
}
/**
 * Binds reads to the configured user without making the bot CLI or worker environment user-capable. The resolved
 * account is checked before the first read and after every read, so a configuration swap cannot silently reach another account.
 * `read` parses an `{ok, identity, data}` envelope; `raw` parses a shortcut that prints its payload directly.
 */
export async function larkUserBinding(commands: Commands, binding: LarkUserBinding, active = () => {}) {
  const scoped = commands.withEnvironment({ LARKSUITE_CLI_CONFIG_DIR: binding.configDir })
  // Owner reads resolve their own CLI so they keep working when the Feishu bot Source is off.
  const cli = binding.cli || scoped.deployment.feishu?.cli
  if (!cli) throw new Error('A Lark user-identity read requires the configured native lark-cli executable')
  active()
  // The CLI refreshes a needs_refresh token on its next user API call.
  const auth = AuthStatus.parse(parseLarkJson(await scoped.run(cli, ['auth', 'status', '--json'])))
  active()
  if (auth.identities.user.openId !== binding.expectedUserId) throw new Error('Lark user does not match the configured account')
  return {
    commands: scoped,
    cli,
    async read<T>(schema: z.ZodType<T>, args: string[]): Promise<T> {
      active()
      const data = schema.parse(larkEnvelope(await scoped.run(cli, [...args, '--as', 'user', '--format', 'json'])))
      active()
      return data
    },
    async raw<T>(schema: z.ZodType<T>, args: string[]): Promise<T> {
      active()
      const data = schema.parse(parseLarkJson(await scoped.run(cli, [...args, '--as', 'user', '--json'])))
      active()
      return data
    },
  }
}
export type LarkUserBindings = Awaited<ReturnType<typeof larkUserBinding>>
export const larkUserReader = async (commands: Commands, binding: LarkUserBinding, active = () => {}) =>
  (await larkUserBinding(commands, binding, active)).read
export type LarkUserRead = Awaited<ReturnType<typeof larkUserReader>>
/** Returns the continuation cursor of a page and refuses a pagination that did not advance. */
export function nextPage(result: { has_more: boolean; page_token?: string | undefined }, seen: Set<string>): string | undefined {
  if (!result.has_more) return undefined
  const token = result.page_token
  if (!token || seen.has(token)) throw new Error('Lark pagination did not advance; coverage is incomplete')
  seen.add(token)
  return token
}
