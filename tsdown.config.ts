import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
// The artifact records the source it was built from, so the panel can name the running build and compare it with its source.
const git = (args: string[]): string => {
  try { return execFileSync('git', args, { encoding: 'utf8' }).trim() } catch { return '' }
}
const build = {
  commit: git(['rev-parse', '--short=12', 'HEAD']),
  // Repository names may contain periods; only the optional terminal `.git` is stripped.
  repository: (/github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(git(['remote', 'get-url', 'origin']))?.[1] ?? '')
    .toLowerCase(),
  builtAt: new Date().toISOString(),
}
// `?raw` imports a file as its text, as Vite and vitest do; tsdown refuses `.css` ids without @tsdown/css, so this loads them.
const raw = { name: 'raw',
  resolveId: (source: string, importer?: string) => source.endsWith('?raw') && importer ? resolve(dirname(importer), source) : undefined,
  load: (id: string) => id.endsWith('?raw') ? { code: `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`, moduleType: 'js' as const }
    : undefined }
const identity = { __DSH_SUPERAGENT_COMMIT__: JSON.stringify(build.commit),
  __DSH_SUPERAGENT_REPOSITORY__: JSON.stringify(build.repository), __DSH_SUPERAGENT_BUILT_AT__: JSON.stringify(build.builtAt) }
export default defineConfig([
  { entry: { index: 'src/index.ts', 'github-watch': 'src/sources/github.ts', 'feishu-watch': 'src/sources/feishu.ts', 'activity-watch': 'src/sources/activity.ts', 'workbench': 'src/sources/workbench-host.ts' }, outDir: 'lib', format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024', dts: true, clean: true, define: identity, deps: { neverBundle: [/^@deepseek-ai\//, 'zod', 'proper-lockfile'] } },
  { entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', dts: false, clean: false, plugins: [raw],
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: { entryFileNames: 'client.js', banner: 'window.__ModuleLoader__.load({ id: "dsh-superagent", factory: (require) => {', footer: 'return module.exports; } });', intro: 'var module = { exports: {} }; var exports = module.exports;' } },
])
