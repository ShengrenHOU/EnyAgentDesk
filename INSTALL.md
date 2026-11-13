# Install EnyAgentDesk

This page is for the coding agent that installs EnyAgentDesk. A person should give the agent this repository link and this file. The agent prepares one config file and runs one command; the person only creates accounts, signs CLIs in and supplies the model key.

EnyAgentDesk installs one private DeepSeek Harness profile. That profile serves the local panel and connects **both** Sources, GitHub and Feishu, for one person. It does not install a shared package, a hosted service or a second DSH instance for each user.

## 1. Operator steps

These need the person's hands. Never ask for a secret in the chat.

1. **DeepSeek Harness and a model key.** Install DSH within the `engines.dsh` range of `package.json`, for example `npm install -g @deepseek-ai/dsh@0.2.1-rc.3`. Export a model key in the shell that starts the profile:

   ```sh
   export DEEPSEEK_API_KEY=...
   ```

   The installer reads the variable and never writes the key to a file.

2. **GitHub agent account and wrapper.** Create a GitHub user account for the agent, give it write access to the repository, and sign a private CLI in as that account:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

3. **Feishu bot and wrapper.** Create a self-built Feishu or Lark app with the bot capability, grant it message, chat and member read permissions, and publish it. Keep the bot in its own CLI configuration:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-enyagentdesk" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-enyagentdesk" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-enyagentdesk"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   Add the bot to the chat, then collect the chat id (`oc_…`) and the operator's Feishu open id (`ou_…`). The panel shows them once the bot is configured; `lark-cli` can also list chats.

**Windows.** Use PowerShell and `.cmd` wrappers instead of the POSIX snippets. Set the key with `$env:DEEPSEEK_API_KEY = '...'`; write `gh-agent.cmd` with `@echo off`, `set GH_CONFIG_DIR=%USERPROFILE%\.config\gh-agent`, `gh %*`; write `lark-bot.cmd` with `set LARKSUITE_CLI_CONFIG_DIR=%USERPROFILE%\.lark-cli-enyagentdesk` and `lark-cli %*`; point the config at those absolute `.cmd` paths. Node, pnpm, git, Python, DSH and the installer run the same way. `docs/009-codex-windows.md` covers the Codex executor and the owner launcher.

## 2. One config file

Copy the example and replace every placeholder. This file is the single source for the installation; it holds no secret.

```sh
cp examples/install.minimal.json enyagentdesk.install.json
```

| Field | Meaning |
| --- | --- |
| `profile` | A new DSH profile name, such as `enyagentdesk`. Do not reuse the profile you work in. |
| `dshHome` | Absolute `DSH_HOME`, normally `~/.dsh`. The installer creates the profile there. |
| `port` | Local panel port. The default example uses `3082`. |
| `stateDir` | Absolute private state directory. One installation per directory; never share it with another profile. |
| `git.name`, `git.email` | Commit author for work the agent does. Use the agent account. |
| `github.repository` | The `owner/name` repository the agent works on. |
| `github.cli` | Absolute path to the `gh-agent` wrapper. |
| `github.agent` | The agent account login. |
| `github.allowed` | The GitHub logins allowed to ask for work. Start with the operator only. |
| `feishu.cli` | Absolute path to the bot-only `lark-bot` wrapper. |
| `feishu.chat` | One chat id, its name, and `mentions` or `all`. |
| `feishu.allowed` | The Feishu open ids allowed to ask for work. Start with the operator only. |
| `executor.directory` | Absolute directory for Ticket work, outside this checkout. |
| `executor.maxWorkers` | Concurrent workers, 1–8. Start with 2. |
| `executor.blockedCommands` | Personal commands the agent must not run, for example a CLI signed in as the operator. |
| `apiKeyEnv` | Environment variable that holds the model key. Default `DEEPSEEK_API_KEY`. |

Both `github` and `feishu` are required. If the operator cannot provide one, stop and report it instead of silently installing a single-Source profile.

## 3. One command

From this checkout:

```sh
node scripts/install.mjs --config enyagentdesk.install.json
```

Preview without writing first:

```sh
node scripts/install.mjs --config enyagentdesk.install.json --dry-run
```

The command:

1. checks Node, pnpm, git, DSH and the model key;
2. installs dependencies, builds the bundle and creates the private profile;
3. writes a managed `cordis.patch.yml` with the state directory, commit identity and both Source plugins;
4. starts the profile and waits for the runtime;
5. saves the GitHub Source, the Feishu Source, the allowed lists and the executor settings through the local management API;
6. runs the self-check and prints one pass or fail line per check.

The panel URL contains a local login token. The installer writes it to `<stateDir>/panel-url.txt` with a restricted mode where the operating system supports one, instead of printing it into chat or logs.

## 4. Self-check

Run it again after changing credentials or settings:

```sh
node scripts/self-check.mjs --config enyagentdesk.install.json
node scripts/self-check.mjs --config enyagentdesk.install.json --json
```

It checks the profile patch, the install receipt, the model key, that no other profile shares the state directory, the GitHub CLI identity, runtime health, both Source setup states, both Source health states, the allowed lists, and the executor directory and limits.

`--offline` checks only the local files and skips the running service. `--no-credentials` skips the GitHub CLI identity check.

## 5. Re-run, stop, upgrade

- Re-run the same command after editing the config. It updates the managed profile patch and both Source settings; it refuses a profile or state directory that belongs to another installation.
- Stop the process that the installer started: `node scripts/install.mjs --config enyagentdesk.install.json --stop`.
- Upgrade: pull the new release, then re-run the installer. Back up `stateDir` first; a database migrated by a newer version may need that backup to roll back.
- The installer starts the profile as a detached process for the current user. For start-at-boot, add the same command to the operating system's scheduler. The profile still runs as the operator's OS user.

## 6. Limits

- **One person, one machine.** There is no account system, tenant isolation, quota or cloud scheduling. Each installation needs its own profile and `stateDir`.
- **Both Sources are required by this flow.** A Feishu-only or GitHub-only profile is outside this install guide.
- **Credentials stay the operator's.** The installer stores no token and no app secret. The GitHub wrapper, the Lark configuration and the model key remain in the operator's own configuration. Do not reuse another person's wrappers or state.
- **The worker is not sandboxed from the operator.** It runs as the operator's OS user and can read the home directory. Use a separate OS account that contains only the agent's credentials if isolation matters.
- **Local only.** The panel listens on `127.0.0.1`. Do not expose the management port or the token URL to a network.
- **Early software.** Versions are 0.x; interfaces, settings and the database can change. Pin a release and read its notes before upgrading.
- **No automatic upgrade or recovery.** The installer starts the process; it does not install a watchdog, a service manager or a scheduled check.
- **A running model key is required.** Evals and workers fail without a reachable model provider. The model provider and its cost are the operator's responsibility.
- **Approval is not a security boundary.** Allowed lists and `observe` mode limit who may ask and what the agent does, but they do not sandbox the process. Keep the allowed lists short and review the first Tickets.

## 7. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Install config not found` | Copy `examples/install.minimal.json` and pass its absolute path with `--config`. |
| `github is required` or `feishu is required` | This installation connects both Sources; add the missing block and real values. |
| `github.cli does not exist` | Use the absolute path of the wrapper, not a shell alias. |
| `The model provider needs DEEPSEEK_API_KEY` | Export the variable in the same shell, or name another variable in `apiKeyEnv`. |
| `stateDir is already used by profile(s) …` | Every installation needs its own state directory. Choose a new one or stop the other profile. |
| `Profile … already exists and was not created by this installer` | Choose another profile name. Do not overwrite a personal DSH profile. |
| `Port … is already in use` | Stop that process or choose another port. |
| `The service refused source:github because its setup check failed` | Read the printed setup detail; usually the agent account cannot push, or the wrapper is signed in as someone else. |
| Feishu setup reports the bot is not in the chat | Add the bot to the configured chat, then re-run the installer. |
| The panel does not open | Open the URL in `<stateDir>/panel-url.txt`; the token changes on restart. Read `install.log` in the same directory for the startup error. |
| `status`/self-check fails after a credential change | Re-run the installer, then the self-check. |

## Personal resource account and upgrade

Optional activity, mailbox, task and calendar Sources share the `dsh-superagent-lark-account` plugin. Configure the owner's `configDir`, native `larkCli` and `expectedUserId` there. Keep the bot's CLI configuration separate; the host and workers can keep their normal user default. Resource scope and event switches stay in each Source's settings.

The account's optional `eventCommand` selects one SDK transport for this profile. Supply a trusted credential-broker argument array invoking `node <package>/scripts/lark-event-bridge.mjs <app-id>`, with only `FEISHU_APP_SECRET` injected into its child environment. Without this command, the bot uses its existing CLI event consumer. Remove a former external CLI consumer only after checking who uses it. Publish application events and subscribe the selected resources; a connected socket is not proof that a resource has delivered an event.

When upgrading a profile that configured personal credentials in the activity or workspace plugin, prepare a migrated patch before activation:

```sh
node scripts/migrate-lark-account.mjs --input <profile>/cordis.patch.yml --output <private-staging>/cordis.patch.yml
```

The helper moves account settings into their single owner, preserves native expressions, refuses conflicting accounts and writes only a new candidate file. Review and back up the existing patch before applying it to a stopped profile. No user authorization, bot configuration, Source scope or stored progress is changed. Existing bot-only installations need no account migration.

## Updating an owner-managed Windows installation

For an installation already using `owner-launcher.py`, the versioned `scripts/activate-release.py` replaces per-version activation scripts. This is a separate operation from installation or merging source. Run it from the reviewed release archive's `scripts` directory in an external developer terminal, so stopping DSH does not stop the activator itself:

```sh
python scripts/activate-release.py --config <private-launcher.json> --release <immutable-release-directory> --pnpm-js <pinned-pnpm-cli.mjs> --receipt <new-private-receipt.json> --preflight-only
```

The release directory must contain the archive and its SHA256/commit/version `release.json`. The launcher configuration must identify this installation's `stateDir`, profile, existing DSH installation and separate personal/bot CLI configurations. Remove `--preflight-only` to activate; use `--candidate-patch <reviewed-patch.yml>` when a release requires configuration migration. The activator never chooses new source scope or authorization. This flow currently supports the existing Windows owner launcher; it does not install a new service manager.

Activation pauses new dispatch, waits for existing workers, takes a consistent database backup and stops only the PID and executable matching the launcher's receipt and listener. A busy timeout restores the original pause state without stopping work. It installs with lifecycle scripts disabled in the profile's existing pnpm store, validates peer resolution, starts through the credential broker and verifies the owned runtime build/setup. Source catch-up and provider incidents are recorded separately in the receipt's health observation; installation success does not claim those readers have completed or recovered. Pending work and tickets remain stored.

Failed validation restores the prior package and configuration while keeping current business records. If the database schema changed, automatic rollback stops and retains the current data for explicit recovery; it never silently replaces it with an old snapshot. An OS lock excludes concurrent activators through recovery and receipt writing. Keep the immutable release directory and private receipt/backup; the launcher uses its verified helper there on future starts.

For an older scheduled supervisor, point its existing action to this release's `activation-helpers/owner-supervisor.ps1` once. This supervisor follows the verified `launcherPath` in the private configuration on subsequent upgrades and rollbacks. A missing configured launcher fails visibly; it does not silently reuse a different version. No new scheduled task is installed by activation.

## What has been verified

The installer, the self-check and the settings payloads have deterministic tests in `tests/test_install.py`. They replace `dsh`, `pnpm` and `git` with fixtures and serve the loopback API from memory, so they run without an account or a real Feishu app. The activator's tests cover drain timeout, retained backlog, artifact validation, configuration recovery and preservation of new data on rollback. A real installation additionally needs the operator's accounts and a model key; run the self-check on that machine before trusting the result.
