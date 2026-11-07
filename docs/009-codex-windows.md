# 009 Codex on Windows

This page covers running the bundle on Windows with the optional local Codex App Server executor. The DSH executor remains the default. Setting `codexCommand` lets new Tickets run on a local Codex instead, and a Ticket keeps its executor until an explicit handoff. This is a single-owner local tool, not a multi-user service or a production security boundary.

## Requirements

- Node.js 24, or 22.19 and later, plus the `pnpm` version pinned in `package.json`
- Python 3 and PowerShell 7 for the owner launcher and supervisor
- DeepSeek Harness with a configured model provider
- The Codex desktop application, installed and signed in
- GitHub CLI 2.48 or later when the GitHub Source is enabled
- A bot-only `lark-cli` configuration when the Feishu Source is enabled
- A dedicated `DSH_HOME` and `stateDir`; do not reuse an existing personal profile

Use the **same Codex executable version as the running desktop application**. A stale generic Codex path can reject the desktop configuration, and changing the global Codex configuration to fit an older executable breaks the desktop app. Point `codexCommand` at the current executable instead.

## Install

Install dependencies from the committed lockfile, then run the checks:

```sh
pnpm install --frozen-lockfile
pnpm check:native
pnpm build
```

Create the dedicated profile and link the bundle as described in [006 Deployment](006-deployment.md). Keep the profile separate from the one you work in: the plugin changes process-wide `PATH` and git settings, and the runtime restarts independently.

## Configure

Copy [the Windows profile example](../examples/windows.cordis.patch.yml) over the profile's `cordis.patch.yml` and replace every placeholder.

| Entry | Meaning |
| --- | --- |
| `webserver.port` | Local panel port. The example uses `3083` |
| `agent-default-model` / `llm-pi-ai` | Model provider used by the coordinator. The API key is read from `DEEPSEEK_API_KEY` |
| `dsh-superagent.config.stateDir` | Absolute state directory. It holds the database, lock, command shims, git configuration and Ticket directories |
| `dsh-superagent.config.codexCommand` | Absolute path to the Codex executable. An empty value keeps the DSH executor |
| `dsh-superagent.config.codexModel` | Optional model override. Omit it to use the local Codex configuration |
| `dsh-superagent-feishu` | Optional Feishu Source |

Configure the native `gh.exe` and `lark-cli.exe` absolute paths through the panel or the management API described in [006 Deployment](006-deployment.md). Keep Lark in a dedicated **bot-only** configuration; do not copy user tokens into it.

The management endpoint is `http://127.0.0.1:3083/orchestrator/api/state` with the header `x-orchestrator-request: 1`. Healthy operation requires `setup.problem=null` and runtime health `ready`; with Feishu enabled, also require `setup.feishuProblem=null`. The authenticated launch URL contains a login token. Do not print it, copy it into shortcuts or expose the listener to another machine.

## Worker permissions

The Codex executor uses the profile's machine configuration. The defaults are deliberately narrow.

- `codexReadOnly` starts and resumes workers in Codex `read-only`. It takes precedence over every other permission flag.
- `codexHostAccess` selects `danger-full-access` so native OS credentials remain usable. It grants host filesystem and network capabilities, not repository-level isolation.
- `codexNetworkAccess` is off by default and stays off in read-only profiles.
- A change to these settings requires an idle runtime and a controlled restart. Chat authorization alone does not change the host configuration.

Workers run as your Windows user. If you need isolation from your own files and credentials, use a separate Windows account that contains only the agent's credentials.

## Start and stop

### Foreground script

[`scripts/start-windows.ps1`](../scripts/start-windows.ps1) runs the profile in the current console:

```powershell
scripts/start-windows.ps1 -DshHome C:\absolute\dsh-home -DshCli C:\absolute\dsh-home\node_modules\@deepseek-ai\dsh\lib\bin.js -LarkConfigDir C:\absolute\bot-only-lark
```

The script requires an existing bot-only Lark configuration directory even when Feishu is disabled; an empty directory is enough. It expects `DEEPSEEK_API_KEY` in its process environment. Supply it from your own secret store or a wrapper process; never write the key into a tracked file, the launcher JSON or this repository.

### Owner launcher

[`scripts/owner-launcher.py`](../scripts/owner-launcher.py) owns instance identity, the launch lock, the stop marker and the browser handoff. It is optional, and it needs a small JSON file outside the repository:

```json
{
  "runtime": "C:/absolute/runtime",
  "node": "C:/absolute/node/node.exe",
  "python": "C:/absolute/python/python.exe",
  "broker": "C:/absolute/bin/secret-broker.exe",
  "port": 3083,
  "repository": "owner/repo",
  "stateDir": "C:/absolute/state"
}
```

`runtime`, `node`, `python` and `broker` must be existing absolute paths. `stateDir` is optional; when present, the launcher compares it with the running instance instead of only the repository. The launcher never stores a secret.

`broker` is a command with the contract `run --map DEEPSEEK_API_KEY=DEEPSEEK_API_KEY -- <command>`. A one-line wrapper that exports the key and then executes its arguments is enough. The launcher calls it to start the runtime and passes `DEEPSEEK_API_KEY` in the child environment.

```powershell
python scripts\owner-launcher.py --config C:\absolute\launcher.json          # start, or reuse the verified listener
python scripts\owner-launcher.py --config C:\absolute\launcher.json --status # read state without starting
python scripts\owner-launcher.py --config C:\absolute\launcher.json --mark-stopped
python scripts\owner-launcher.py --config C:\absolute\launcher.json --start-only --respect-stop
```

`--mark-stopped` records an intentional stop before stopping the owned process. `--start-only --respect-stop` is the recovery path: it starts a missing instance but preserves a manual stop. The marker changes share the launch lock with normal starts.

For scheduled recovery, point one Windows Task Scheduler entry at [`scripts/owner-supervisor.ps1`](../scripts/owner-supervisor.ps1) with the same config. Configure no execution time limit and ignore overlapping instances. Do not add separate force-stop, cleanup, rename or upgrade jobs against the same profile.

## Persistence and recovery

- Ticket-to-Codex-thread bindings and delivery intents live in the existing SQLite store. Codex owns its own session history.
- A restart resumes the bound thread. Inspect existing files and external results before continuing.
- An uncertain delivery is checked against Codex thread history. If the outcome cannot be established, leave the work failed or blocked for inspection instead of retrying external writes.
- Keep the state directory and worktrees. Back them up before upgrades, and do not delete a live state lock or reset unrelated branches as recovery.
- The executor removes the launching desktop chat's identity and app-tool pipe from its child environment, while retaining the Codex home and authentication. It closes App Server through stdin EOF and never terminates the shared desktop service.

## Verification and limits

`pnpm check:native` covers typechecking, native transport and executor tests, Windows environment checks, core admission and Engine behavior, documentation checks and the build. Run the complete `pnpm check` in Linux or WSL, where the shell-fixture suites are supported. A passing subset on one platform is not a substitute for the other.

The Codex adapter is tested against deterministic fixtures and a bounded live run. A requested model is not proof of the model actually used; a matching Codex rollout `turn_context` supplies that evidence, and missing evidence stays unknown.
