# SETUP

Instructions for an agent that sets up EnyAgentDesk with its operator. If you are a person, ask your coding agent to read this file and follow it. [INSTALL.md](INSTALL.md) owns the exact commands, config fields and limits; read it before acting.

This installation connects **both** GitHub and Feishu for one person. Do not drop a Source to make setup easier. If the operator cannot provide one, stop and report the missing prerequisite.

## How to run the setup

The setup follows [docs/000-philosophy.md](docs/000-philosophy.md): it takes as little of the operator's attention as possible.

- **Before the first question,** read this file, `INSTALL.md` and `docs/000-philosophy.md`, and run the probe once.
- **Ask one question per message,** about one thing. Wait for the answer before the next one. Skip a question the probe already answers.
- **Keep each message under 300 words.** Give each question a recommended answer the operator can accept with one word, and one sentence on why it matters.
- **Never ask for a secret in the chat.** Account creation, CLI sign-in, the Feishu app secret and the model key go into one message with the exact commands the operator runs in their own terminal.
- **Do not execute while asking.** Collect every answer, write the plan once, and execute only after the operator confirms it.
- **Do not configure a second Source later.** Both Sources are part of this install; a later enablement starts from the same config and re-runs the installer.

## 1. Probe

Run once from this checkout and keep the result to yourself:

```sh
node -v; pnpm -v; git --version; python3 --version; dsh --version
gh --version | head -1
command -v lark-cli
grep -l -E 'id: dsh-superagent\b' "${DSH_HOME:-$HOME/.dsh}"/profiles/*/cordis.patch.yml 2>/dev/null
```

- **Prerequisites:** Node.js 22.19+ or 24+, pnpm, git 2.32+, Python 3.8+, GitHub CLI 2.48+, and DSH within the `engines.dsh` range of `package.json`. tmux is only needed by the POSIX service script, not by the installer. A missing item becomes part of the plan, not a question.
- **Model key:** the profile needs a model provider key in its environment, by default `DEEPSEEK_API_KEY`. Do not ask for the value; ask the operator to export it in the shell that starts the profile.
- **Existing profile:** a profile with a `dsh-superagent` entry is an earlier installation. The installer refuses to overwrite it, and `--apply-only` needs that profile's install receipt. Ask whether to keep it and configure it manually as in `docs/006-deployment.md`, or to choose a new profile name.
- **Operator login:** the `gh api user --jq .login` result, run as the operator, is the recommendation for the allowed GitHub list. It is not the agent account.

## 2. Questions

Ask in this order, one per message.

1. **Repository.** Which github.com repository should the agent work on, as `owner/name`?
2. **Agent account.** Which GitHub user account will the agent act as? [A dedicated account, never the operator's own: everything the agent writes appears under this name.] It may not exist yet; creating it is an operator step.
3. **Who may ask on GitHub.** Which GitHub logins may ask for work? [Only the operator's own login. Start narrow.]
4. **Feishu chat.** Which one Feishu chat should the bot read? [The operator's private chat with the bot, or one small team chat.] The agent needs the chat id (`oc_…`) and its name.
5. **Who may ask in Feishu.** Which Feishu user ids may ask for work? [Only the operator, as an open id (`ou_…`).]
6. **Commit identity.** Which name and email should the agent's commits use? [The agent account and its GitHub noreply email.]
7. **Port and state.** The installer uses port `3082`, profile `enyagentdesk`, state `<DSH_HOME>/state/enyagentdesk`, worker directories under that state, and `maxWorkers` 2. Ask only if the operator has a conflict.

Do not ask about values with a good default. Do not ask about auto-merge: the installer does not enable it.

## 3. Plan

Send one message, under 300 words: the profile and port, the repository and two allowed lists, the two CLI wrappers, the state directory and its one-installation rule, the operator steps, and the limits from `INSTALL.md` section 6. Ask for one confirmation.

## 4. Execute

1. **Operator steps first.** Send one message with what only the operator can do:
   - create the agent GitHub account and give it write access to the repository;
   - create a wrapper signed in only as that account, per `INSTALL.md`;
   - create and publish the Feishu bot app, configure a bot-only `lark-cli` wrapper, and add the bot to the chat;
   - export the model key in the shell that starts the profile.
   Wait until the operator confirms, then check each login with `<wrapper> api user --jq .login` and the bot configuration with `<lark-wrapper> config strict-mode`.
2. **Write the config.** Copy `examples/install.minimal.json` to `enyagentdesk.install.json` and fill every field from the answers. The file is the single source; keep it out of Git. Never put a token or app secret in it.
3. **Preview.** Run `node scripts/install.mjs --config enyagentdesk.install.json --dry-run`. Send the operator the plan lines that matter: profile, port, repository, both allowed lists and the state directory.
4. **Install.** Run the same command without `--dry-run`, after the operator confirms. The installer builds the bundle, creates the profile, starts it and saves both Sources through the local management API.
5. **Failures.** A setup refusal names the Source and the problem. Fix what you can. Ask the operator only for what needs their hands or their decision. Do not skip a failed Source or call a partial install complete.
6. **Re-run is safe.** After a credential or config change, edit the config and re-run the installer. Do not delete the profile or state directory.

## 5. Verify and hand over

Run `node scripts/self-check.mjs --config enyagentdesk.install.json`. Every line must be `ok`; use `--json` when you need the machine-readable form. Then send one message, under 300 words:

- The panel URL is in `<stateDir>/panel-url.txt`; it contains a local login token, so do not paste it into a public place. The **Superagent** entry in the sidebar is the workbench.
- How to try it: from an allowed GitHub account, comment `@<agent login> <request>` on an issue; or mention the bot in the configured Feishu chat. A Ticket appears within about a minute.
- Three rules from `docs/000-philosophy.md`: start narrow, tune for less noise, own what the agent says.
- The limits from `INSTALL.md` section 6 that change daily use: one person and one machine, workers run as the operator's OS user, no automatic upgrade, keep the state directory backed up.
- Where to read more: `INSTALL.md`, then the numbered documents in `docs/`.
