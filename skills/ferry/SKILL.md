---
name: ferry
description: Rules for working with Ferry, the CLI that keeps a remote Linux agent box in the same shape as the operator machine. Load it for any task about the Ferry box, `ferry sync`, `ferry status`, `ferry move`, `ferry auth`, installing skills with `ferry skills add`, or files under `~/.ferry`. Load it before you edit a skill, `AGENTS.md`, `CLAUDE.md`, `.claude/agents`, `.claude/commands`, or Claude settings on a machine that Ferry manages.
---

# Ferry

Ferry copies the agent setup of the operator machine to a remote Linux box. The operator machine is the source of truth. A private git repository, the snapshot, carries the setup. Both machines have a checkout of it at `~/.ferry/store`, and the managed paths are symlinks into that checkout. The `ferry` command runs only on the operator machine. The box does not run Ferry.

## Rules

1. On the box, do not edit a Ferry-managed file: a skill, an instruction file such as `AGENTS.md`, `~/.claude/agents`, `~/.claude/commands`, a carried Claude settings key, or a carried MCP declaration. Each sync resets the box checkout with `git reset --hard` and writes the carried keys again, so your change is lost. Tell the operator what to change on the operator machine instead.
2. Read state with `ferry status --json` before you change anything.
3. Run `ferry sync --dry-run` before `ferry sync`. Do not pass `--force` unless the operator tells you to.
4. Do not start `ferry auth`. It needs a person with a browser. Tell the operator the exact command to run.
5. Do not pass `--yes` to `ferry install`, `ferry update`, or `ferry uninstall`, and do not answer their confirmation prompts. The operator confirms.
6. Never work around a refusal. Do not rename, move, split, or encode a file to get past a deny rule. Do not copy a secret, a login, or a token to the box by other means.
7. Run `ferry move --dry-run` before `ferry move`. Add `--include-env` or `--remove` only when the operator asks for it. Never pass `--allow-secrets` or `--yes` to `ferry move` unless the operator asks for it in this conversation.
8. Install skills with `ferry skills add`, not with a plain `npx skills add`.

## Find out where you are

- The operator machine has `~/.ferry/config.toml` and the `ferry` command.
- The box has `~/.ferry/store` but no `~/.ferry/config.toml`. On the box, you cannot run `ferry`.

## What Ferry manages

These paths are managed on both machines. Each one is a symlink into `~/.ferry/store`:

| Item | Paths | Store target |
| --- | --- | --- |
| Skills | each entry in `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.pi/agent/skills`, `~/.cursor/skills`, and in custom `skill_root` entries of `~/.ferry/config.toml` | `~/.ferry/store/skills/<name>` |
| Instruction file | `~/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md`, and custom `instruction_file` entries | `~/.ferry/store/AGENTS.md` |
| Claude subagents and commands | `~/.claude/agents`, `~/.claude/commands` (the whole directory) | `~/.ferry/store/roots/.claude/...` |

Ferry does not manage the `.system` directory in a skill root. Codex owns it on each machine.

These items are not symlinks. Sync writes them into box files:

- Carried Claude settings keys: `enabledPlugins`, `extraKnownMarketplaces`, `permissions`, and `hooks` in `~/.claude/settings.json`. Sync replaces these keys on the box. A key that the operator machine does not have is removed from the box. The box keeps its other keys.
- Remote MCP servers: the name and HTTPS URL of each server in `mcpServers` of `~/.claude.json`, `[mcp_servers]` of `~/.codex/config.toml`, and `mcpServers` of `~/.cursor/mcp.json`. Sync declares them on the box. It replaces a box declaration with a different URL. It never removes a box server.

Ferry never carries logins, credential files, tokens, request headers, `.env` files, session history, caches, databases, or whole settings files.

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

Run `ferry status --json` on the operator machine. It changes nothing. Its stdout is one JSON object with `schemaVersion: 1`. These fields matter most:

| Field | Meaning |
| --- | --- |
| `link.online`, `link.address` | The box answers over SSH or Tailscale, and its address. |
| `gitAuth` | `agent`: Ferry forwards the operator SSH agent to the box git commands. `box`: the box reads the snapshot with its own deploy key, `~/.ssh/ferry_snapshot`, and gets no agent. |
| `store.local`, `store.remote`, `store.box` | The snapshot commit on the operator machine, the git remote, and the box. `null` means unknown. |
| `store.localMatchesRemote`, `store.remoteMatchesBox`, `store.allMatch` | Tip comparisons. `allMatch: false` usually means a sync is due. |
| `boxCheckout.dirty`, `boxCheckout.changes` | Local changes in the box checkout, as paths. The next sync discards them. |
| `gitIdentity.box`, `gitIdentity.operator` | `{ name, email }` of git on each machine. |
| `gitIdentity.boxConfigured`, `gitIdentity.matchesOperator` | The box has a git identity, and it is the same as the operator's. |
| `boxSudo.passwordless` | `sudo` on the box runs without a password. |
| `boxSudo.watchUpdateBlocked` | `ferry watch` runs daily updates, but sudo asks for a password, so the `gh` update on the box fails. |
| `managedPaths.allHealthy`, `managedPaths.unhealthy` | Box links that are missing or wrong. A sync repairs them. A `refuse-live-directory` entry is a real directory on the box, and only `ferry sync --force` replaces it. |
| `auth.providers` | Login state per tool: `authenticated`, `login-required`, `manual` (with an `instruction`), or `unavailable`. |
| `auth.loginRequired` | Tools that need a login. |
| `mcpLogins.loginRequired` | Box MCP servers that need a login, as `tool/server`. |
| `denyList` | The deny rules: `code`, `description`, and `behavior` (`refuse` or `skip`). |
| `errors` | Each inspection that failed, with `origin`, `code`, and `message`. |

Each section also has an `error` field. A `null` value with an error means Ferry could not read it. It does not mean false.

## Sync

`ferry sync` publishes the snapshot, updates the box checkout, links the managed paths, installs Claude plugins, merges the carried settings keys, and declares MCP servers.

- `ferry sync --dry-run` prints the plan and the deny list. It does not connect to the box and writes nothing.
- `ferry sync -m "<message>"` sets the snapshot commit message.
- `ferry sync --force` moves a live directory on the box, such as a real `~/.claude/agents`, to `~/.ferry/backups` and links it. Use it only when the operator says so.

Read these output lines:

- `operator: Manifest refused publisher <host>: <reason>: <path>` means a deny rule refused a file. The sync stopped and nothing was published. The message names the file, never the value. Tell the operator the path and the reason. The operator removes the secret from the file or removes the file from the managed set.
- A refusal that contains `clash <name>: <path>, <path>` means two harness roots hold different copies of a skill with the same name. The operator must keep one copy.
- `Skipped hook: <reason>: <location>` means Ferry left out one hook, because its command refers to a home path that the box will not have. The sync continues without that hook. To carry it, the operator moves the script into a carried directory or onto `PATH` on both machines.
- `Skipped MCP server: <reason>: <path>` means Ferry left out a local server (it has a `command`) or a server with a plain `http://` URL. The sync continues. Only remote HTTPS servers are carried.
- `Updated store skill <name> from <path>` means an installer put a newer copy of a skill in one harness root, and sync published it.
- `Discarded box change: <path>` means sync threw away an edit on the box.
- `Box plugins: ...` and `Box MCP: ...` are warnings. The sync continues.

A skipped entry is expected. A refusal is a stop. Do not edit Ferry, its config, or the file only to get a sync through. Report it.

## Logins

`ferry auth <tool>` starts a vendor login on the box and prints a URL, and sometimes a code, that a person opens in a browser. Tools are `gh`, `claude`, `codex`, and `cursor`. `ferry auth` without a tool lists them. `ferry auth <tool> --mcp <server>` logs in to one MCP server on the box.

Do not run these commands yourself. When `auth.loginRequired` or `mcpLogins.loginRequired` is not empty, tell the operator the command, for example `ferry auth claude --mcp linear`. Pi has no remote login. The operator runs `pi` on the box and uses `/login`.

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

When Paseo is enabled, `ferry status` has an `Integrations` section, and `ferry status --json` has `integrations.paseo`:

| Line or field | Meaning |
| --- | --- |
| `Service:`, `state.service` | `ferry-paseo.service` must be `active, enabled`. |
| `Daemon:`, `state.localDaemon` | The daemon must be `running`. |
| `Version:`, `state.daemonVersion`, `state.localVersion` | The box version and the local app version. `not pinned` means there is no local Paseo app. |
| `Listen:`, `state.listen`, `state.relay` | The daemon must listen on `127.0.0.1:6767` with the relay off. |
| `Providers:`, `state.providers` | The agent providers on the box. Sync skips a profile whose provider is `unavailable`. |
| `WARNING` lines, `warnings` | A problem that the operator must fix, such as a version difference or a daemon that is not running. Tell the operator. |

## Other commands

- `ferry --version` prints the Ferry version.
- `ferry update --dry-run` prints the update plan for the agent tools on both machines.
- `ferry init --dry-run` prints the init plan without writing or connecting.
- `ferry watch` syncs accepted changes in the foreground. `ferry watch install` installs it as a user service.
