/** The running package identity: packaged version, and the source commit, repository and build time recorded when it was built. */
import { readFileSync } from 'node:fs'
import { packagePath } from './paths.ts'

/** Injected by tsdown at build time; tests and unbundled imports read them as absent. */
declare const __DSH_SUPERAGENT_COMMIT__: string | undefined
declare const __DSH_SUPERAGENT_REPOSITORY__: string | undefined
declare const __DSH_SUPERAGENT_BUILT_AT__: string | undefined
// `typeof` keeps an undefined identifier readable when the source runs without the build-time definitions.
const COMMIT = typeof __DSH_SUPERAGENT_COMMIT__ === 'string' ? __DSH_SUPERAGENT_COMMIT__ : ''
const REPOSITORY = typeof __DSH_SUPERAGENT_REPOSITORY__ === 'string' ? __DSH_SUPERAGENT_REPOSITORY__ : ''
const BUILT_AT = typeof __DSH_SUPERAGENT_BUILT_AT__ === 'string' ? __DSH_SUPERAGENT_BUILT_AT__ : ''

/** What a build records about itself; empty strings are unknown, as in an unbundled test run. */
export interface PackageIdentity {
  /** The packaged version, which a release changes. */
  packageVersion: string
  /** The source commit the artifact was built from, abbreviated to 12 characters. */
  commit: string
  /** The GitHub repository of that source, `owner/name`, lower case. */
  repository: string
  /** When the artifact was built. */
  builtAt: string
}
let cached: PackageIdentity | undefined
/** Reads the packaged version once; the other fields were fixed when the artifact was built. */
export function packageIdentity(): PackageIdentity {
  if (cached) return cached
  const manifest: unknown = JSON.parse(readFileSync(packagePath('package.json'), 'utf8'))
  const version = manifest && typeof manifest === 'object' && 'version' in manifest && typeof manifest.version === 'string' ? manifest.version : ''
  return cached = { packageVersion: version, commit: COMMIT, repository: REPOSITORY, builtAt: BUILT_AT }
}
/** The default branch the monitored repository last reported, used to compare the running build with its source. */
export interface MainCommit {
  repository?: string | undefined
  branch?: string | undefined
  head?: string | undefined
  /** When that head was observed, which must be later than the build for the comparison to prove anything. */
  observedAt?: string | undefined
}
/** The running build as the panel shows it, with `behind` when the build is not the source's current default-branch commit. */
export interface RuntimeVersion extends PackageIdentity {
  /** When this dsh-superagent instance started, the activation time of the running artifact. */
  startedAt: string
  behind?: { branch: string; head: string }
}
/**
 * Compares the running build with the default-branch commit the repository's GitHub Source last read. The comparison needs
 * the same repository and an observation later than the build: a checkpoint written before this artifact was built, as after
 * an upgrade, still holds the previous head and cannot show that the build is behind.
 */
export function runtimeVersion(identity: PackageIdentity, startedAt: string, main?: MainCommit): RuntimeVersion {
  const head = main?.head?.toLowerCase(), commit = identity.commit.toLowerCase()
  const sameSource = !!head && !!commit && !!identity.repository
    && identity.repository.toLowerCase() === main?.repository?.toLowerCase()
  const observedAt = Date.parse(main?.observedAt ?? ''), builtAt = Date.parse(identity.builtAt)
  const observedAfterBuild = Number.isFinite(observedAt) && Number.isFinite(builtAt) && observedAt > builtAt
  const behind = sameSource && observedAfterBuild && !head!.startsWith(commit)
    ? { branch: main?.branch ?? 'main', head: main!.head! } : undefined
  return { ...identity, startedAt, ...behind ? { behind } : {} }
}
