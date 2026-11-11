import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { packageIdentity, runtimeVersion, type PackageIdentity } from '../src/infra/version.ts'
import { packagePath } from '../src/infra/paths.ts'

const identity = (fields: Partial<PackageIdentity> = {}): PackageIdentity =>
  ({ packageVersion: '0.5.19', commit: 'abc123def456', repository: 'acme/widgets', builtAt: '2026-11-09T00:00:00.000Z', ...fields })

it('reports the packaged version and keeps the build-time identity', () => {
  const manifest = JSON.parse(readFileSync(packagePath('package.json'), 'utf8')) as { version: string }
  const identity = packageIdentity()
  expect(identity.packageVersion).toBe(manifest.version)
  // Source runs have no build-time definitions; a bundle records them.
  expect(typeof identity.commit).toBe('string')
  expect(identity.builtAt).toBeTypeOf('string')
})

it('marks the running build behind only when the same source reports a newer default-branch commit', () => {
  const running = runtimeVersion(identity(), '2026-11-09T01:00:00.000Z',
    { repository: 'acme/widgets', branch: 'main', head: 'abc123def4567890', observedAt: '2026-11-09T00:30:00.000Z' })
  expect(running).toMatchObject({ packageVersion: '0.5.19', startedAt: '2026-11-09T01:00:00.000Z' })
  expect(running.behind).toBeUndefined()
  expect(runtimeVersion(identity(), 'start', { repository: 'acme/widgets', branch: 'main', head: 'def456789012',
    observedAt: '2026-11-09T00:30:00.000Z' }).behind).toEqual({ branch: 'main', head: 'def456789012' })
  // A checkpoint written before the build, as after an upgrade, still holds the previous head and proves nothing.
  expect(runtimeVersion(identity(), 'start', { repository: 'acme/widgets', branch: 'main', head: 'def456789012',
    observedAt: '2026-11-08T23:30:00.000Z' }).behind).toBeUndefined()
  // Another repository, an unknown build commit, or no reported head cannot establish that the build is behind.
  expect(runtimeVersion(identity(), 'start', { repository: 'other/repo', branch: 'main', head: 'def',
    observedAt: '2026-11-09T00:30:00.000Z' }).behind).toBeUndefined()
  expect(runtimeVersion(identity({ commit: '' }), 'start', { repository: 'acme/widgets', branch: 'main', head: 'def',
    observedAt: '2026-11-09T00:30:00.000Z' }).behind).toBeUndefined()
  expect(runtimeVersion(identity(), 'start', { repository: 'acme/widgets' }).behind).toBeUndefined()
})
