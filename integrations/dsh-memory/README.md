# Native memory adapter

This directory retains the reviewed upstream MIT package `@dsh-external/dsh-memory` 0.5.7
(upstream commit `d0dea8e119eb34678d4fd33b503009d61d0770a5`) and a small pnpm patch.
The original archive SHA256 is
`8e82bcbb6af0aab9d953b0de38faa529dc33e5f43c0589cedc81105e53e9ac6a`.
`LICENSE.upstream` preserves its license. This is a locally patched 0.5.7, not a new upstream release.

`main-role.patch` introduces the opt-in `parentedRootPresets` setting. A trusted
coordinator preset may retain parent lineage across segments and still distill
its own turns. A native `origin: subagent` always stays excluded. Defaults,
memory paths, scope derivation, tools and the existing asynchronous pipeline stay unchanged.
`memory_stats.autoSummaryEligible` reports the caller's role eligibility; it does
not assert that a model call or consolidation succeeded.

First-time distillation starts at the latest native turn instead of truncating
the beginning of a long journal. Runtime-context snapshots (including injected
memory) are not fed back as new facts. The curator is prompted to keep provenance and separate durable preferences/facts
from temporary procedures; this remains model judgment, not a factual guarantee.
Memory never grants authority.

Keep the patch in pnpm's profile-level patched dependencies, not as edits to
installed node_modules. Stop the selected profile before changing its dependency tree:

The profile installer validates the original/patched file hashes, copies this
patch into the profile's `patches` directory, and declares it in pnpm's native
`patchedDependencies`. A reviewed install refreshes the profile lock with lifecycle
scripts disabled. The existing memory loader override declares
`parentedRootPresets: ["dsh-superagent-router"]`; unrelated fields stay intact.
Preserve the patch, pnpm-workspace.yaml, lock and profile override together.
The `pnpm patch` extractor itself tries npm for this file-only upstream package,
so installation uses the native patch configuration directly.

Keep the existing `memoryDir`, `seedFromAgentsMd`, budgets and source/authority
settings. The adapter does not import Codex chats. When upgrading upstream,
review and retire this exact-version patch before adopting a replacement.

Sidebar grouping is not a memory identity: the existing plugin derives workspace
memory from the native Session's cwd, and project memory from its git root.
DSH 0.2.2 validates Workspace attachment against the immutable native cwd. A sidebar
group is not a directory migration, and mismatched historical headers need separate recovery.

Existing upstream limits remain: consolidation is rate-limited to ten minutes per
scope and requires the configured number of new blocks. Completed summaries survive
restart, but pending per-session debounce/retry timers are process-local. First-time
extraction is a bounded latest-turn window, not a lossless replay of earlier turns.
The adapter does not claim perfect recall or durable capture of every interrupted turn.
