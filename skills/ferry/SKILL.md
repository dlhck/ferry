---
name: ferry
description: Rules for working with Ferry, the CLI that keeps a remote Linux agent box in the same shape as the operator machine. Load it for any task about the Ferry box, `ferry sync`, `ferry status`, `ferry move`, `ferry auth`, installing skills with `ferry skills add`, or files under `~/.ferry`. Load it before you edit a skill, `AGENTS.md`, `CLAUDE.md`, `.claude/agents`, `.claude/commands`, or Claude or Codex settings on a machine that Ferry manages.
---

# Ferry

Ferry copies the agent setup of the operator machine to a remote Linux box. The operator machine is the source of truth. A private git repository, the snapshot, carries the setup. Both machines have a checkout of it at `~/.ferry/store`, and the managed paths are symlinks into that checkout. The `ferry` command runs on the operator machine. The box has a box install of Ferry that runs only `ferry expose`.

## Rules

1. On the box, do not edit a Ferry-managed file: a skill, an instruction file such as `AGENTS.md`, `~/.claude/agents`, `~/.claude/commands`, a carried Claude or Codex settings key, or a carried MCP declaration. The `env` values of a carried stdio MCP server are the exception: set them on the box, and Ferry keeps them. Each sync resets the box checkout with `git reset --hard` and writes the carried keys again, so your change is lost. Tell the operator what to change on the operator machine instead.
2. Read state with `ferry status --json` before you change anything.
3. Add `--json` to each Ferry command whose output you read. Use the error `code`, not the message text. See [JSON output](#json-output).
4. Run `ferry sync --dry-run` before `ferry sync`. Do not pass `--force` unless the operator tells you to.
5. Do not start `ferry auth`. It needs a person with a browser. Tell the operator the exact command to run.
6. Do not pass `--yes` to `ferry install`, `ferry update`, `ferry uninstall`, `ferry box add`, or `ferry integrations enable|disable`, and do not answer their confirmation prompts. The operator confirms. With `--json`, such a command fails with the code `confirmation-required`. Then give the operator the command to run.
7. Pass `--accept-host-keys` to `ferry init` or `ferry box add` only after the operator accepts the fingerprints in this conversation. When the error has `details.hostKeys`, show each host, key type, and fingerprint to the operator.
8. Never work around a refusal. Do not rename, move, split, or encode a file to get past a deny rule. Do not copy a secret, a login, or a token to the box by other means.
9. Run `ferry move --dry-run` before `ferry move`. Add `--include-env` or `--remove` only when the operator asks for it. Never pass `--allow-secrets` or `--yes` to `ferry move` unless the operator asks for it in this conversation.
10. Install skills with `ferry skills add`, not with a plain `npx skills add`.

## Find out where you are

- The operator machine has `~/.ferry/config.toml` and the `ferry` command.
- The box has `~/.ferry/store` and `~/.ferry/box.json`, but no `~/.ferry/config.toml`. On the box, `ferry` is a box install: only `ferry expose`, `ferry --version`, and the help run. A development build of Ferry ignores `~/.ferry/box.json`.

## What Ferry manages

These paths are managed on both machines. Each one is a symlink into `~/.ferry/store`:

| Item | Paths | Store target |
| --- | --- | --- |
| Skills | each entry in `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.pi/agent/skills`, `~/.cursor/skills`, and in custom `skill_root` entries of `~/.ferry/config.toml` | `~/.ferry/store/skills/<name>` |
| Instruction file | `~/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md`, and custom `instruction_file` entries | `~/.ferry/store/AGENTS.md` |
| Claude subagents and commands | `~/.claude/agents`, `~/.claude/commands` (the whole directory) | `~/.ferry/store/roots/.claude/...` |

Ferry does not manage the `.system` directory in a skill root. Codex owns it on each machine.

These items are not symlinks. Sync writes them into box files:

- Carried Claude settings keys: `enabledPlugins`, `extraKnownMarketplaces`, `permissions`, `hooks`, `attribution`, `includeCoAuthoredBy`, `model`, and `alwaysThinkingEnabled` in `~/.claude/settings.json`.
- Carried Codex settings keys: `model`, `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`, `features`, and `web_search` in `~/.codex/config.toml`.
- For both files, sync replaces the carried keys on the box. A key that the operator machine does not have is removed from the box. The box keeps its other keys. When a carried Codex key changes, sync writes `config.toml` again, and the comments in that file are lost.
- Remote MCP servers: the name and HTTPS URL of each server in `mcpServers` of `~/.claude.json`, `[mcp_servers]` of `~/.codex/config.toml`, and `mcpServers` of `~/.cursor/mcp.json`. Sync declares them on the box. It replaces a box declaration with a different URL. It never removes a box server.
- Stdio MCP servers from the same files: the name, `command`, `args`, and the names of the `env` keys, never their values. Sync adds them with `claude mcp add-json` for Claude and writes them into the MCP file of Codex and Cursor Agent. It keeps the `env` of the box entry. It never installs the command. A server whose command or arguments refer to a path in the operator home is not carried.

Ferry never carries logins, credential files, tokens, request headers, `.env` files, session history, caches, databases, or whole settings files.

## Tools and agents that are off

The policy `"off"` in `[tools]` or `[box.<name>.tools]` of `~/.ferry/config.toml` turns off `gh` or an agent CLI: `claude`, `codex`, `pi`, or `cursor`. A box policy can turn the tool on again for that box. For a tool that is off:

- `ferry install`, `ferry update`, and the daily watch update skip it. The plan step has the action `skip-off`.
- `ferry status` shows the state `off`, never `drift` or `missing`. Ferry does not uninstall the CLI from the box, and does not check its login.
- `ferry auth <tool>` fails with the code `refused`.
- `ferry tools` shows the policy `off`.

An agent that is off also turns off its harness (`.claude`, `.codex`, `.pi/agent`, or `.cursor`). Sync does not read the harness on the operator machine while the agent is off on every box. On a box where it is off, sync writes no links, settings keys, plugins, or MCP servers there, and removes the links that Ferry made there earlier (the links into `~/.ferry/store`). The sync plan names these harnesses in `offHarnesses`. Ferry never removes other files there, and it keeps the settings keys and MCP servers that it wrote before. The shared `.agents/skills` and `~/AGENTS.md` have no off switch.

## Recognize a managed path

Resolve the path. It is managed if the result is inside `~/.ferry/store`:

```sh
realpath ~/.claude/skills/some-skill
ls -l ~/AGENTS.md
```

A skill directory inside a project (for example `./.claude/skills`) is not managed. Edit it on either machine.

## Change a managed file

On the operator machine:

1. Edit the file through its managed path, for example `~/.claude/skills/<name>/SKILL.md`. The edit goes into `~/.ferry/store`. Edit carried settings keys and MCP servers in the operator's own files, such as `~/.claude/settings.json`.
2. Run `ferry sync --dry-run` and read the plan.
3. Run `ferry sync`. If the operator runs `ferry watch`, it syncs accepted changes after one second, so do not also run `ferry sync`.

On the box:

1. Do not edit the file. A change there is lost at the next sync, and sync prints `Discarded box change: <path>` for it.
2. Tell the operator which file to change and give the exact change. If you must keep a draft, write it outside the managed paths, for example in the project.

If `ferry status` shows `boxCheckout.dirty: true`, the box checkout has local changes. The next sync discards them. Tell the operator before the sync so they can copy anything they want to keep.

## Read state

Run `ferry status --json` on the operator machine. It changes nothing. Its stdout is one envelope (see [JSON output](#json-output)). The `result` of the envelope is the status report, with `schemaVersion: 2`, also for one box. Each `--box <name>` selects one box. The top level of `result` has the shared fields:

| Field | Meaning |
| --- | --- |
| `store.local`, `store.remote` | The snapshot commit on the operator machine and on the git remote. `null` means unknown. |
| `store.localMatchesRemote` | The local tip and the remote tip are the same. |
| `operator.gitIdentity` | `{ name, email }` of git on the operator machine. |
| `denyList` | The deny rules: `code`, `description`, and `behavior` (`refuse` or `skip`). |
| `boxes` | One entry for each box, in config order. With a `[host]` config, the one box has the name `default`. |
| `errors` | Each operator or git remote inspection that failed, with `origin`, `code`, and `message`. |

Each entry of `boxes` has these fields:

| Field | Meaning |
| --- | --- |
| `name`, `host` | The box name and its destination. |
| `gitAuth` | `agent`: Ferry forwards the operator SSH agent to the box git commands. `box`: the box reads the snapshot with its own deploy key, `~/.ssh/ferry_snapshot`, and gets no agent. |
| `link.online`, `link.address` | The box answers over SSH or Tailscale, and its address. |
| `tip` | The snapshot commit on the box. `null` means unknown. |
| `remoteMatchesBox`, `allMatch` | Tip comparisons. `allMatch: false` usually means a sync of this box is due. |
| `boxCheckout.dirty`, `boxCheckout.changes` | Local changes in the box checkout, as paths. The next sync discards them. |
| `gitIdentity.box` | `{ name, email }` of git on the box. |
| `gitIdentity.boxConfigured`, `gitIdentity.matchesOperator` | The box has a git identity, and it is the same as the operator's. |
| `boxSudo.passwordless` | `sudo` on the box runs without a password. |
| `boxSudo.watchUpdateBlocked` | `ferry watch` runs daily updates, but sudo asks for a password, so the `gh` update on the box fails. |
| `managedPaths.allHealthy`, `managedPaths.unhealthy` | Box links that are missing or wrong. A sync repairs them. A `refuse-live-directory` entry is a real directory on the box, and only `ferry sync --force` replaces it. |
| `auth.providers` | Login state per tool: `authenticated`, `login-required`, `manual` (with an `instruction`), or `unavailable`. |
| `auth.loginRequired` | Tools that need a login. |
| `mcpLogins.loginRequired` | Box MCP servers that need a login, as `tool/server`. |
| `tools` | The version state of each registry tool on the box, with Ferry itself last as `id: "ferry"`. Each row has `id`, `mode`, `policy`, `operator`, `target`, `box`, `state`, and a `reason` for `hidden`, `skipped`, `off`, and `unknown`. `off` is a tool with the policy `"off"`, not a problem. The operator fixes `drift` with `ferry update`, `missing` with `ferry install`, and `hidden` with `ferry sync`. |
| `integrations` | Present only when an integration is on for this box. |
| `errors` | Each inspection of this box that failed, with `origin`, `code`, and `message`. |

Each section also has an `error` field. A `null` value with an error means Ferry could not read it. It does not mean false.

`ferry status --brief --json` checks only the link, the logins, the MCP logins, the carried stdio MCP servers, the tools, and the hooks that run a home file Ferry does not carry. Its `result` is `{ schemaVersion: 1, checkedAt, boxes }`. Each box has `name`, `host`, `online`, `error` (why the box is offline), and `issues`. Each issue has `kind` (`login`, `mcp-login`, `mcp-server`, `tool`, `hook`, or `check-failed`), `name`, `state`, `message`, and `command`, the Ferry command that fixes it, or `null` when a person must act on the box. `ferry watch` writes the same report to `~/.ferry/status.json` at the start, every 5 minutes, and after each sync. Read that file when it is recent, and run the command when it is old or missing.

## Sync

`ferry sync` publishes the snapshot, updates the box checkout, links the managed paths, installs Claude plugins, merges the carried settings keys, and declares MCP servers.

- `ferry sync --dry-run` prints the plan and the deny list. It does not connect to the box and writes nothing.
- `ferry sync -m "<message>"` sets the snapshot commit message.
- `ferry sync --force` moves a live directory on the box, such as a real `~/.claude/agents`, to `~/.ferry/backups` and links it. Use it only when the operator says so.

Read these output lines:

- `operator: Manifest refused publisher <host>: <reason>: <path>` means a deny rule refused a file. The sync stopped and nothing was published. The message names the file, never the value. Tell the operator the path and the reason. The operator removes the secret from the file or removes the file from the managed set.
- A refusal that contains `clash <name>: <path>, <path>` means two harness roots hold different copies of a skill with the same name. The operator must keep one copy.
- `Skipped hook: <reason>: <location>` means Ferry left out one hook, because its command refers to a home path that the box will not have. The sync continues without that hook. To carry it, the operator moves the script into a carried directory or onto `PATH` on both machines.
- `Skipped MCP server: <reason>: <path>` means Ferry left out a server with a plain `http://` URL, a server with neither a URL nor a `command`, or a stdio server whose command or arguments refer to a path in the operator home. The sync continues.
- A stdio MCP server with a token or secret in its command or arguments stops the sync with the deny rule `mcp-argument`. The error names the server and the rule, never the value.
- `Updated store skill <name> from <path>` means an installer put a newer copy of a skill in one harness root, and sync published it.
- `Discarded box change: <path>` means sync threw away an edit on the box.
- `Box plugins: ...` and `Box MCP: ...` are warnings. The sync continues.

With `--json`, the `warnings` array of the envelope holds the `Skipped ...`, `Box plugins: ...`, `Box MCP: ...`, and `Warning: ...` lines. A deny rule refusal has the code `deny-rule-match`, and a clash has the code `refused`.

A skipped entry is expected. A refusal is a stop. Do not edit Ferry, its config, or the file only to get a sync through. Report it.

## Logins

`ferry auth <tool>` starts a vendor login on the box and prints a URL, and sometimes a code, that a person opens in a browser. Tools are `gh`, `claude`, `codex`, `cursor`, and each `[tools.<id>]` table with the `auth_status`, `auth_login`, and `auth_hosts` keys. `ferry auth` without a tool lists them. `ferry auth <tool> --mcp <server>` logs in to one MCP server on the box. `ferry auth --mcp <tool>/<server>` also works, with the name that `mcpLogins.loginRequired` gives.

Do not run these commands yourself. When `auth.loginRequired` or `mcpLogins.loginRequired` is not empty, tell the operator the command, for example `ferry auth claude --mcp linear`. Pi has no remote login. The operator runs `pi` on the box and uses `/login`. A tool with the policy `"off"` gets no login.

`ferry auth gh` also creates an SSH key on the box and adds it to the operator's GitHub account, so agents on the box can push. A box that cannot push to GitHub usually needs this login.

## Move a project

`ferry move <path>` continues a project on the box: `default_box` or the only box. `ferry move <path> --to-box <b>` continues it on box `b`. `ferry move <path> --from-box <a>` brings it back from box `a` to the operator machine. `ferry move <path> --from-box <a> --to-box <b>` moves it from box `a` to box `b` through the operator machine. The boxes do not connect to each other, and nothing stays on the operator machine. `ferry move` does not accept `--box`. The path must be inside the home directory. The destination uses the same path relative to its home.

1. Run `ferry move <path> --dry-run` first. It prints `Carry:`, `Refuse:`, `Skip:`, `Note:`, and `Problem:` lines and changes nothing.
2. Fix each `Problem:` line before the real move. Ferry refuses a move with unpushed commits, uncommitted changes to tracked files, or an existing destination path. Push or commit only if the operator agrees.
3. A `Refuse:` file stays on the source machine. Do not copy it yourself. The operator decides what to do with it.
4. Add `--include-env` only when the operator asks. It carries a `.env` file only if the file has no token and no secret key with a value.
5. Never pass `--allow-secrets` or `--yes` unless the operator asks for it in this conversation. With `--include-env --allow-secrets`, Ferry also carries a `.env` or `.env.*` file that has a token or a secret key. It still refuses a `.env` file with a private key or an executable, and all other files keep every deny rule.
   - First run `ferry move <path> --include-env --allow-secrets --dry-run`. Each such file shows on a `Carry with secrets: <path> (<kinds>)` line. The line names the kinds of secret, never the values.
   - Tell the operator which files have secrets, and that the box will then hold the same secrets. Anyone with access to the box user can read them.
   - On a terminal, Ferry asks before the transfer. Without a terminal, Ferry stops before any change unless `--yes` is set. Do not add `--yes` to get past this stop. Give the operator the command to run instead.
   - The destination gets these files with mode 600.
6. Add `--remove` only when the operator asks. Ferry refuses `--remove` if it refuses any local-only file. After verification, Ferry moves the source copy to `~/.Trash` on macOS or to `~/.ferry/trash` on Linux and on the box. It does not delete it.

## Install skills

Run `ferry skills add <source> [args...]` on the operator machine. It runs `npx skills add` and adds `-g` and `--copy`, so the skill lands in a global harness root, and the next sync links it into the store. Add `--project` to install into the current project instead. Put arguments after `--` to pass them through without Ferry reading them. Then run `ferry sync --dry-run` and `ferry sync`, or let `ferry watch` publish it.

For example, this installs this skill:

```sh
ferry skills add dlhck/ferry --skill ferry
```

## Integrations

An integration runs one extra service on the box. Paseo is the only integration. It is off by default. When it is off, Ferry prints nothing about it.

- `ferry integrations` lists each integration, shows if it is enabled, and shows the local app version that the box gets. It changes nothing.
- `ferry integrations enable paseo`, `ferry integrations disable paseo`, and the Paseo step of `ferry update` need the operator. Run them with `--dry-run` only, and tell the operator the command. An update restarts the Paseo daemon and stops the agents that run on the box.
- When Paseo is enabled, each sync carries the Paseo agent profiles to the box as its last step. Sync prints `Warning: Paseo agent profile <name> was not carried: provider <provider> is not available on the box.` for each profile that it skips. A profile with an `env` block or a secret stops the sync, as a deny rule does.

On the box, do not edit these files. Ferry writes them, and it overwrites your change:

- `~/.config/systemd/user/ferry-paseo.service`
- `daemon.agentProfiles` in `~/.paseo/config.json`

To change a profile, tell the operator to change it in Paseo on the operator machine and to run `ferry sync`.

When Paseo is enabled for a box, its `ferry status` block has an `Integrations` section, and its `ferry status --json` entry has `integrations.paseo`:

| Line or field | Meaning |
| --- | --- |
| `Service:`, `state.service` | `ferry-paseo.service` must be `active, enabled`. |
| `Daemon:`, `state.localDaemon` | The daemon must be `running`. |
| `Version:`, `state.daemonVersion`, `state.localVersion` | The box version and the local app version. `not pinned` means there is no local Paseo app. |
| `Listen:`, `state.listen`, `state.relay` | The daemon must listen on `127.0.0.1:6767` with the relay off. |
| `Providers:`, `state.providers` | The agent providers on the box. Sync skips a profile whose provider is `unavailable`. |
| `WARNING` lines, `warnings` | A problem that the operator must fix, such as a version difference or a daemon that is not running. Tell the operator. |

## JSON output

Each command accepts the global option `--json`. With it, stdout has only JSON. Progress and the text lines of the command go to stderr as plain lines. Ferry shows no prompt.

### Envelope

A command that runs and exits prints exactly one JSON object:

```json
{
  "schemaVersion": 1,
  "command": "sync",
  "ok": true,
  "result": {},
  "warnings": [],
  "error": null
}
```

- `command` is the command path, such as `sync`, `box add`, or `integrations enable`.
- `warnings` holds the warning lines of the run, also on failure.
- On failure, `ok` is `false`, the exit code is not 0, and `error` is `{ "code", "message", "hint" }`. `hint` is a string or `null`. Some errors also have `details`, such as `details.hostKeys`.
- `result` can be present when `ok` is `false`. A failed `sync` of more than one box and a failed `update` keep `result` with the outcome of each box. Each box then has `ok`, and a failed box has `error`. The top-level `error` names the failed boxes or updates. For the other failures, `result` is `null`.
- `status` does not fail for an offline box. The report shows it with `link.online: false` and the box `errors`.
- A usage error, such as an unknown option, also gives an envelope, with the code `usage`.
- `--dry-run --json` gives the plan in `result`.

### Commands that stay running

`ferry watch`, `ferry tunnel`, `ferry tunnel --follow`, and `ferry expose` print one JSON event for each line (NDJSON). Each event has `type`. An error event also has `code`, `message`, and `hint`. When the command fails, the last line is an `error` event. `ferry tunnel --list` runs and exits, so it prints an envelope.

| Command | Event | Fields |
| --- | --- | --- |
| `watch` | `watch-started` | `boxes` |
| `watch` | `synced` | `box`, `manifest` |
| `watch` | `sync-failed` (error) | `box` (`null` when the sync failed before the box steps), `retryInMs` |
| `watch` | `sync-refused` (error) | `box`. The watch does not retry this content. |
| `watch` | `content-refused` (error) | A deny rule or a clash refused the portable set. The watch waits for a change. |
| `watch` | `config-error` (error) | The watch cannot read the config. It tries again in the next cycle. |
| `watch` | `update-started`, `update-failed` (error) | The daily tool update. |
| `watch` | `status-failed` (error) | The watch cannot write `~/.ferry/status.json`. It tries again in 5 minutes. |
| `watch` | `watch-stopped` | The watch stopped after SIGINT or SIGTERM. |
| `tunnel` | `forward-opened` | `name` (`null` for a plain tunnel), `localPort`, `box`, `remotePort`, and with `--follow` also `pid`, `cwd` |
| `tunnel --follow` | `forward-closed` | the fields of `forward-opened` |
| `tunnel --follow` | `forward-failed` (error) | the fields of `forward-opened`. `localPort` is `null` when no local port is free. |
| `tunnel --follow` | `following` | `box`, `reconnected` |
| `tunnel --follow` | `connection-lost` (error) | `box`, `retryInMs` |
| `tunnel` | `tunnel-closed` | `box`. Ctrl-C closed the tunnel. |
| `expose` | `exposed` | `port`, `name`, `cwd`, `pid` |
| `expose` | `exited` | `port`, `exitCode`. Ferry exits with the same code. |
| all four | `error` (error) | The command failed. It is the last line. |

With `--json`, the stdout of the command of `ferry expose` goes to stderr.

### Prompts

With `--json`, Ferry never asks:

- A step that needs a confirmation fails with `confirmation-required`, unless the command has `--yes`. This applies to `install`, `update`, `uninstall`, `integrations enable|disable`, `box add` on a `[host]` config, and `.env` files with secrets in `move`. The message of the error names what needs the confirmation.
- The SSH host keys of the snapshot host in `init` and `box add` need `--accept-host-keys`. `--yes` does not trust them. Without `--accept-host-keys`, the command fails with `confirmation-required`, and `error.details.hostKeys` is a list of `{ host, type, fingerprint }`. With `--accept-host-keys`, Ferry trusts the keys and writes the fingerprints to stderr.
- `ferry init --json` without the values that it needs fails with `missing-values`. The message lists the missing values, such as `host, sshUser, snapshotUrl`.
- `ferry auth <tool> --json` prints a `login` event before the envelope: `{ "type": "login", "provider", "url", "userCode", "codeRequired", "localPort", "timeoutMs" }`, and for `--mcp` also `server`. The login ends in the browser. When `codeRequired` is `true`, Ferry reads the code that the browser shows as one line on stdin. Without a line, it fails with `missing-values`.

### Error codes

| Code | Meaning |
| --- | --- |
| `usage` | An argument or an option is wrong, or does not apply to the command. |
| `config-missing` | There is no config, or it is not complete. The operator runs `ferry init`. |
| `config-invalid` | The config or a tool table has an error, or this machine is not the publisher. |
| `unknown-box` | A box name is not in the config. |
| `box-required` | More than one box is configured, and the command changes one box. Name the box, or set `default_box`. |
| `box-offline` | Ferry cannot reach the box. |
| `box-command-failed` | A command on the box failed or timed out. |
| `forward-failed` | A port forward did not open or close. |
| `confirmation-required` | The step needs a confirmation, and `--yes` is not given. For SSH host keys, `--accept-host-keys` is not given, and `error.details.hostKeys` lists the keys. |
| `missing-values` | A value that the command needs is missing. |
| `deny-rule-match` | A deny rule refused a file. The message names the file, never the value. |
| `refused` | A safety check refused the change, such as a clash, a live path, an unpushed commit, or an untrusted host key. `ferry auth` of a tool that is off also has this code. |
| `sync-busy` | Another sync is active. |
| `sync-failed` | The sync failed on one or more boxes, or the publish failed. |
| `update-failed` | One or more updates failed. |
| `login-failed` | The login on the box did not finish. |
| `command-failed` | A child command, such as `npx skills add`, failed. |
| `failed` | Any other error. |

### Results

| Command | `result` |
| --- | --- |
| `init` | `{ dryRun: false, leftovers, published }`. With `--dry-run`: `{ dryRun: true, leftovers, plan: { operator, box, gitRemote, localCheckout, configPath, skills, instructions, links } }`. |
| `box list` | `{ boxes: [{ name, transport, destination, default }] }` |
| `box add` | `{ name, transport, destination, gitAuth, migrated }` |
| `box remove` | `{ name, defaultBoxRemoved }` |
| `box default` | `{ defaultBox }` |
| `install` | `{ plan: [{ tool, policy, version, action, command, dependsOn }], gitIdentity: { name, email } or null }` |
| `update` | `{ dryRun, boxes: [{ name, ok, error, offline, plan, integrations: [{ id, plan }] }], operator: [{ tool, command } or { tool, reason }], updated, failed }`. `updated` and `failed` name each update, such as `box gh`, `[a] box gh`, or `operator codex`. A box with `ok: false` has `error`: `box-offline`, or `update-failed` with its failed updates. Also on failure. |
| `sync` | `{ dryRun, published, boxes: [{ name, ok, step, error, plan, applyPlan, discarded }] }`. `plan` is the sync plan of the box, `applyPlan` its link changes (`null` for a dry run or a failed box), and `discarded` the box checkout changes that the sync threw away. A box with `ok: false` has `step`, the step that failed, and `error`. With more than one box, also on failure. |
| `status` | The status report. With `--brief`, the brief report. See [Read state](#read-state). |
| `auth` | Without a tool: `{ providers: [{ id, login: "startable", "manual", or "off" }] }`. With a tool: the last login result, `{ kind, provider, ... }`, where `kind` is `logged-in`, `already-done`, `device-url`, `printed-url`, `local-port-forward`, or `manual-ssh`. |
| `tools` | `{ tools: [{ id, name, kind, install, policy: { policy, default }, boxes: [{ name, policy, default }], operatorVersion }] }` |
| `skills add` | `{ argv }`, the `npx skills add` command that ran. |
| `move` | `{ path, source, destination, dryRun, git: { url, branch } or null, carry: [{ path, sha256, secrets }], refused: [{ path, code, reason }], skipped, notes, trash }` |
| `tunnel --list` | `{ box, listeners: [{ port, address, process }] }` |
| `integrations` | `{ boxes: [{ name, destination, integrations: [{ id, description, enabled, localVersion, localSource, connectSteps }] }] }`. `name` is `null` for a `[host]` config. |
| `integrations enable`, `integrations disable` | `{ integration, action, dryRun, plan, output, enabled, connectSteps }`. `enabled` is the new config value, or `null` for a dry run. |
| `watch install` | `{ manager: "launchd" or "systemd", path }` |
| `tunnel install` | `{ manager: "launchd" or "systemd", path }` |
| `tunnel uninstall` | `{ manager, path, removed }`. `removed` is `false` when the box had no service file. |
| `menubar install` | `{ app, path, version, ferryPath }`. `path` is the launchd agent. `version` is the release of the app, or `null` with `--app`. |
| `menubar uninstall` | `{ app, path, removed }`. `removed` is `false` when neither the app nor the agent was there. |
| `uninstall` | `{ removed, restored }` |
| `self-update` | `{ current, latest, updated, services: [{ service, action, message }] }`. An action is `restarted`, `updated`, `skipped`, or `failed`. A failed service action is also in `warnings` and does not fail the binary update. `updated` is `false` when `current` is the latest release. The output of the installer goes to stderr. |

## Other commands

- `ferry --version` prints the Ferry version.
- `ferry self-update` updates Ferry on the operator machine. It restarts installed watch and tunnel services only when their service files point at this Ferry. On macOS, it updates an installed release menu bar app. It skips a menu bar app whose service marks it as a local `--app` build. Then `ferry update` puts the new version on the boxes. With `--json`, Ferry never asks to update before a command.
- On the box, `ferry expose [--port <n>] -- <command...>` runs a dev server and announces its port. The port is `--port`, else `$PASEO_PORT`. On the operator machine, `ferry tunnel --follow` opens a forward for each announced port until Ctrl-C. `ferry tunnel install [--box <name>]` runs `--follow` for one box as a user service, and `ferry tunnel uninstall [--box <name>]` removes it. `ferry tunnel install --help` names the service file and the log. Do not write to or remove files in `~/.ferry/exposed/` yourself.
- `ferry tunnel --follow` (also as the service) writes `~/.ferry/tunnels/<box>.json` when it connects, after each change of the forwards, and when the connection drops: `{ schemaVersion: 1, box, pid, connected, updatedAt, forwards: [{ name, cwd, boxPort, localPort }] }`. `name` and `cwd` are missing when the entry has none. `connected` is `false` with no forwards after a drop, until Ferry connects again. Ferry removes the file on Ctrl-C or SIGTERM. A file whose `pid` does not run is stale. Read the file to find the local port of a dev server. Do not write it yourself. A plain `ferry tunnel <port>` writes no file.
- `ferry update --dry-run` prints the update plan for the agent tools on both machines.
- `ferry init --dry-run` prints the init plan without writing or connecting.
- `ferry watch` syncs accepted changes in the foreground. `ferry watch install` installs it as a user service. A successful `ferry self-update` restarts the service when it points at the updated Ferry.
- On macOS, `ferry menubar install` installs a menu bar app that shows the report of `~/.ferry/status.json` and the ports of `~/.ferry/tunnels/*.json`. It needs `ferry watch`. A development build of Ferry needs `--app <path>`, a build of `macos/build.sh`. `ferry menubar uninstall` removes the app.
- `ferry <command> --help` has the details and the config formats. For example, `ferry tools --help` shows the `[tools]` tables, `ferry update --help` shows the sudo rule for the daily update, and `ferry box add --help` shows the `git_auth = "box"` deploy key step.
