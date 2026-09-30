---
name: ferry
description: Rules for working with Ferry, the CLI that keeps a remote Linux agent box in the same shape as the operator machine. Load it for any task about the Ferry box, `ferry sync`, `ferry status`, `ferry move`, `ferry auth`, installing skills with `ferry skills add`, or files under `~/.ferry`. Load it before you edit a skill, `AGENTS.md`, `CLAUDE.md`, `.claude/agents`, `.claude/commands`, or Claude or Codex settings on a machine that Ferry manages.
---

# Ferry

Ferry copies the agent setup of the operator machine to a remote Linux box. The operator machine is the source of truth. A private git repository, the snapshot, carries the setup. Both machines have a checkout of it at `~/.ferry/store`, and the managed paths are symlinks into that checkout. The `ferry` command runs on the operator machine. The box has a box install of Ferry that runs only `ferry expose` and `ferry whoami`.

## Rules

1. On the box, do not edit a Ferry-managed file: a skill, an instruction file such as `AGENTS.md`, `~/.claude/agents`, `~/.claude/commands`, a carried Claude or Codex settings key, or a carried MCP declaration. The `env` values of a carried stdio MCP server are the exception: set them on the box, and Ferry keeps them. Each sync resets the box checkout with `git reset --hard` and writes the carried keys again, so your change is lost. Tell the operator what to change on the operator machine instead.
2. Read state with `ferry status --json` before you change anything.
3. Add `--json` to each Ferry command whose output you read. Use the error `code`, not the message text. See [JSON output](#json-output).
4. Run `ferry sync --dry-run` before `ferry sync`. Do not pass `--force` unless the operator tells you to.
5. Do not start `ferry auth`. It needs a person with a browser. Tell the operator the exact command to run.
6. Do not pass `--yes` to `ferry install`, `ferry update`, `ferry uninstall`, `ferry box add`, `ferry box remove --uninstall`, or `ferry integrations enable|disable`, and do not answer their confirmation prompts. The operator confirms. With `--json`, such a command fails with the code `confirmation-required`. Then give the operator the command to run.
7. Pass `--accept-host-keys` to `ferry init` or `ferry box add` only after the operator accepts the fingerprints in this conversation. When the error has `details.hostKeys`, show each host, key type, and fingerprint to the operator.
8. Never work around a refusal. Do not rename, move, split, or encode a file to get past a deny rule. Do not copy a secret, a login, or a token to the box by other means.
9. Run `ferry move --dry-run` before `ferry move`. Add `--include-env` or `--remove` only when the operator asks for it. Never pass `--allow-secrets` or `--yes` to `ferry move` unless the operator asks for it in this conversation.
10. Install skills with `ferry skills add`, not with a plain `npx skills add`.

## Find out where you are

- The operator machine has `~/.ferry/config.toml` and the `ferry` command.
- The box has `~/.ferry/store` and `~/.ferry/box.json`, but no `~/.ferry/config.toml`. On the box, `ferry` is a box install: only `ferry expose`, `ferry whoami`, `ferry --version`, and the help run. The operator machine also runs the hidden `ferry scan` and `ferry redact` there. Do not run them yourself. A development build of Ferry ignores `~/.ferry/box.json`.
- On the box, the instruction files start with a header that names the box. On the operator machine, they have no header.
- When you are not sure, run `ferry whoami --json`. It prints `role` (`operator` or `box`), `box`, the box name, `instructions`, and `managedPaths`. On a box, `instructions.sources` lists the merged parts of the instruction file in order.

## What Ferry manages

These paths are managed on both machines. Each one is a symlink into `~/.ferry/store`:

| Item | Paths | Store target |
| --- | --- | --- |
| Skills | each entry in `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.pi/agent/skills`, `~/.cursor/skills`, and in custom `skill_root` entries of `~/.ferry/config.toml` | `~/.ferry/store/skills/<name>` |
| Instruction file | `~/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md`, and custom `instruction_file` entries | `~/.ferry/store/AGENTS.md`. On the box: `~/.ferry/box/AGENTS.md`, which sync merges from three parts (see [Instruction files on a box](#instruction-files-on-a-box)) |
| Claude subagents and commands | `~/.claude/agents`, `~/.claude/commands` (the whole directory) | `~/.ferry/store/roots/.claude/...` |

Ferry does not manage the `.system` directory in a skill root. Codex owns it on each machine.

### Instruction files on a box

On a box, each instruction file is a link to the generated file `~/.ferry/box/AGENTS.md`. Each sync merges it from three parts, in this order, with one blank line between them:

1. The Ferry header. It names the box.
2. The per-box instructions, from `~/.ferry/boxes/<name>/AGENTS.md` on the operator machine. Only the box `<name>` gets them. A `[host]` config has one box with the name `default`. A missing or empty file adds nothing.
3. The shared instructions, `~/AGENTS.md` of the operator machine, byte for byte.

- To change the instructions of all machines, edit `~/AGENTS.md` on the operator machine. To change the instructions of one box, edit `~/.ferry/boxes/<name>/AGENTS.md` on the operator machine. Then run `ferry sync`.
- Never edit `~/.ferry/box/AGENTS.md` on the box. Each sync writes it again, and the edit is lost.
- `ferry box add` creates the per-box file empty and prints its path, and its JSON result has the path in `instructionFile`. `ferry init` does not create the file.
- The per-box file is not in the snapshot and not in `~/.ferry/store`. It is a plain file, not a symlink.
- A box gets the generated file only when the operator machine has `~/AGENTS.md`. Without it, sync prints a warning and does not apply the per-box file.
- `ferry watch` syncs only the box of a changed per-box file, without a publish.

These items are not symlinks. Sync writes them into box files:

- Carried Claude settings keys: `enabledPlugins`, `extraKnownMarketplaces`, `permissions`, `hooks`, `attribution`, `includeCoAuthoredBy`, `model`, and `alwaysThinkingEnabled` in `~/.claude/settings.json`.
- Carried Codex settings keys: `model`, `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`, `features`, and `web_search` in `~/.codex/config.toml`.
- For both files, sync replaces the carried keys on the box. A key that the operator machine does not have is removed from the box. The box keeps its other keys. When a carried Codex key changes, sync writes `config.toml` again, and the comments in that file are lost.
- Remote MCP servers: the name and HTTPS URL of each server in `mcpServers` of `~/.claude.json`, `[mcp_servers]` of `~/.codex/config.toml`, and `mcpServers` of `~/.cursor/mcp.json`. Sync declares them on the box. It replaces a box declaration with a different URL. It never removes a box server.
- Stdio MCP servers from the same files: the name, `command`, `args`, and the names of the `env` keys, never their values. Sync adds them with `claude mcp add-json` for Claude and `codex mcp add` for Codex, and merges them into `~/.cursor/mcp.json` for Cursor Agent. The box does the merge with jq and keeps the `env` of the box entry. Ferry never reads an env value. Sync leaves a Codex entry with another command as it is and warns. Without jq on the box, sync adds only new servers and warns; `ferry update` installs jq. It never installs the command. A server whose command or arguments refer to a path in the operator home, as an absolute path, `~`, `$HOME`, or `${HOME}`, is not carried. A server that runs an inline script for a shell or an interpreter, such as `sh -c`, `bash -cl`, `node -e`, `node --eval=...`, `python -c`, `deno eval`, `npx -c`, `pwsh -Command`, `cmd /c`, or `env -S`, is not carried either, because Ferry cannot check the script. This includes a shell or an interpreter behind another command, as in `env bash -c` or `docker run <image> sh -c`. A script file is carried, as in `node /srv/server.js -c conf.json` or `python3 -m some_server`.

Ferry never carries logins, credential files, tokens, request headers, `.env` files, session history, caches, databases, or whole settings files.

## Tools and agents that are off

The policy `"off"` in `[tools]` or `[box.<name>.tools]` of `~/.ferry/config.toml` turns off `gh` or an agent CLI: `claude`, `codex`, `pi`, or `cursor`. A box policy can turn the tool on again for that box. For a tool that is off:

- `ferry install`, `ferry update`, and the daily watch update skip it. The plan step has the action `skip-off`.
- `ferry status` shows the state `off`, never `drift` or `missing`. Ferry does not uninstall the CLI from the box, and does not check its login.
- `ferry auth <tool>` fails with the code `refused`.
- `ferry tools` shows the policy `off`.

An agent that is off also turns off its harness (`.claude`, `.codex`, `.pi/agent`, or `.cursor`). Sync does not read the harness on the operator machine while the agent is off on every box. On a box where it is off, sync writes no links, settings keys, plugins, or MCP servers there, and removes the links that Ferry made there earlier (the links into `~/.ferry/store`). The sync plan names these harnesses in `offHarnesses`. Ferry never removes other files there, and it keeps the settings keys and MCP servers that it wrote before. The shared `.agents/skills` and `~/AGENTS.md` have no off switch.

## Recognize a managed path

Resolve the path. It is managed if the result is inside `~/.ferry/store`, or on the box, is `~/.ferry/box/AGENTS.md`:

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
| `boxOnlySkills.skills` | The skills on the box that the snapshot does not have, as `{ name, paths }`. `null` when the box is offline or Ferry could not read them. See [Install skills](#install-skills). |
| `tools` | The version state of each registry tool on the box, with Ferry itself last as `id: "ferry"`. Each row has `id`, `mode`, `policy`, `operator`, `target`, `box`, `state`, and a `reason` for `hidden`, `skipped`, `off`, and `unknown`. `off` is a tool with the policy `"off"`, not a problem. The operator fixes `drift` with `ferry update`, `missing` with `ferry install`, and `hidden` with `ferry sync`. |
| `integrations` | Present only when an integration is on for this box. |
| `errors` | Each inspection of this box that failed, with `origin`, `code`, and `message`. |

Each section also has an `error` field. A `null` value with an error means Ferry could not read it. It does not mean false.

`ferry status --brief --json` checks only the link, the free disk, memory, and load, the logins, the MCP logins, the carried stdio MCP servers, the tools, and the hooks that run a home file Ferry does not carry. Its `result` is `{ schemaVersion: 1, checkedAt, boxes }`. Each box has `name`, `host`, `online`, `error` (why the box is offline), `issues`, and `resources`. `resources` is `null` for an offline box, else `{ disk: { totalKiB, freeKiB }, memory: { totalKiB, availableKiB }, load: { one, five, fifteen, cpus } }`, and each part is `null` when the box does not report it. Each issue has `kind` (`login`, `mcp-login`, `mcp-server`, `tool`, `hook`, `resource`, or `check-failed`), `name`, `state`, `message`, and `command`, the Ferry command that fixes it, or `null` when a person must act on the box. `ferry watch` writes the same report to `~/.ferry/status.json` at the start, every 5 minutes, and after each sync. Read that file when it is recent, and run the command when it is old or missing. A `resource` issue has the name `disk` or `memory` and the state `low`: the free disk of the box home file system is below both 10% and 5 GiB, or the available memory is below 10%. `[status]` in `~/.ferry/config.toml` sets other limits with `disk_free_percent`, `disk_free_gib`, and `memory_available_percent`. A limit of 0 turns its part of the check off. When one disk limit is 0, the other decides. The load has no limit.

## Sync

`ferry sync` publishes the snapshot, updates the box checkout, links the managed paths, installs Claude plugins, merges the carried settings keys, and declares MCP servers.

- `ferry sync --dry-run` prints the plan and the deny list. It does not connect to the box and writes nothing.
- `ferry sync -m "<message>"` sets the snapshot commit message.
- `ferry sync --force` moves a live directory on the box, such as a real `~/.claude/agents`, to `~/.ferry/backups` and links it. Use it only when the operator says so.

Read these output lines:

- `operator: Manifest refused publisher <host>: <reason>: <path>` means a deny rule refused a file. The sync stopped and nothing was published. The message names the file, never the value. Tell the operator the path and the reason. The operator removes the secret from the file or removes the file from the managed set.
- `operator: Manifest refused the instructions of box <name>: <reason>: <path>` means a deny rule refused the per-box instruction file `~/.ferry/boxes/<name>/AGENTS.md`. Ferry did not connect to that box. The other boxes sync. The message names the file, never the value.
- A refusal that contains `clash <name>: <path>, <path>` means two harness roots hold different copies of a skill with the same name. The operator must keep one copy.
- `Skipped hook: <reason>: <location>` means Ferry left out one hook, because its command refers to a home path that the box will not have. The sync continues without that hook. To carry it, the operator moves the script into a carried directory or onto `PATH` on both machines.
- `Skipped MCP server: <reason>: <path>` means Ferry left out a server with a plain `http://` URL, a server with neither a URL nor a `command`, a stdio server whose command or arguments refer to a path in the operator home, as an absolute path, `~`, `$HOME`, or `${HOME}`, or a stdio server that runs an inline shell or interpreter script. Ferry also skips a shell or an interpreter that has a script option after an option that Ferry does not know. The sync continues. For an inline script, tell the user to put the script in a file that Ferry carries, or to run the server through a tool on the PATH.
- A stdio MCP server with a token or secret in its command or arguments stops the sync with the deny rule `mcp-argument`. The rule also covers a URL with a password or a secret query parameter, an `http` or `https` URL with a user and no password, also as `git+https` (`url-credential`), and a secret inside an inline script. Ferry decodes the percent escapes of a URL before the check, so `pa%73sword=` is `password=`. The error names the server and the rule, never the value. Tell the user to set secrets in the `env` of the server on the box.
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
   - The deny rules run on the source machine. With `--from-box`, the Ferry on the box runs them, and Ferry copies only the files that pass. `--dry-run` copies no file.
   - A `Refuse: <directory> (a file or directory in <directory> has a token in its name)` line means that a name there has the form of a token. Ferry does not print the name. In the output of a move from a box, `[token]` stands for such a text in a file name, a branch name, or a commit subject. Do not try to find the name.
   - `Ferry is not installed on <box>` or `The Ferry on <box> is too old to check the files there` means that the box has no release of Ferry with `ferry scan`. Tell the operator to run `ferry install` or `ferry update`. A development build of Ferry puts no Ferry on a box. Do not copy the files in another way.
   - `The Ferry on <box> has older deny rules than this machine` means that the check of the box can pass a file that the operator machine refuses. Ferry copied no file. Tell the operator to run `ferry update`. The same errors apply to `ferry adopt --from-box`.
   - `<file> changed on <box> after the check` means that a file changed between the check and the copy. Run the move again. A `WARNING: Ferry skips the session of <file> (a file changed after the check)` line names a session that stays on the source for the same reason, for example a session that is still in use.
4. Add `--include-env` only when the operator asks. It carries a `.env` file only if the file has no token and no secret key with a value.
5. Never pass `--allow-secrets` or `--yes` unless the operator asks for it in this conversation. With `--include-env --allow-secrets`, Ferry also carries a `.env` or `.env.*` file that has a token or a secret key. It still refuses a `.env` file with a private key or an executable, and all other files keep every deny rule.
   - First run `ferry move <path> --include-env --allow-secrets --dry-run`. Each such file shows on a `Carry with secrets: <path> (<kinds>)` line. The line names the kinds of secret, never the values.
   - Tell the operator which files have secrets, and that the box will then hold the same secrets. Anyone with access to the box user can read them.
   - On a terminal, Ferry asks before the transfer. Without a terminal, Ferry stops before any change unless `--yes` is set. Do not add `--yes` to get past this stop. Give the operator the command to run instead.
   - The destination gets these files with mode 600.
6. Add `--remove` only when the operator asks. Ferry refuses `--remove` if it refuses any local-only file. After verification, Ferry moves the source copy to `~/.Trash` on macOS or to `~/.ferry/trash` on Linux and on the box. It does not delete it.
7. Ferry also carries the Claude and Codex sessions of the project and the Claude project memory in `~/.claude/projects/<encoded path>/memory`. The dry run prints a `Carry sessions:` line. After the move, `claude --resume` and `codex resume` in the project on the destination list them. `--no-sessions` turns this off.
   - A session file that is only on the destination stays. A session on both machines gets the source copy. The source keeps its sessions.
   - Ferry applies the deny rules to each session and memory file. A `WARNING: Ferry skips the session of <file> (<rule>)` line names a session that stays on the source. Ferry carries it with `--allow-secrets` only, with the same rules as step 5, and never with a private key.
   - For a session transcript, Ferry reads each record. It applies the token rules, and it looks for a password or secret key with a value in tool inputs and tool results: in JSON, in config text such as `KEY=value` lines, and in command flags such as `--password <value>`. The `<rule>` is then `key <name> holds a password or secret`.
   - This scan has a limit. It finds a secret only by a token pattern or next to a secret key or flag. A secret in free prose, such as a password that the operator typed in a message, passes. In text, a value counts only when it looks like a literal, so a bare value of only letters, such as `password: swordfish`, also passes, unless the key is in the env form, such as `PASSWORD=swordfish`. A value that is a number also passes, so that a token count such as `input_tokens` is not a hit. Do not tell the operator that a carried session has no secret. If the operator says that a session can hold one, use `--no-sessions`.

## Install skills

Run `ferry skills add <source> [args...]` on the operator machine. It runs `npx skills add` and adds `-g` and `--copy`, so the skill lands in a global harness root, and the next sync links it into the store. Add `--project` to install into the current project instead. Put arguments after `--` to pass them through without Ferry reading them. Then run `ferry sync --dry-run` and `ferry sync`, or let `ferry watch` publish it.

For example:

```sh
ferry skills add owner/repo --skill some-skill
```

A skill that you write on a box stays on that box, and the next sync can refuse or shadow it. `ferry status` lists it under `Box-only skills`. Tell the operator to run `ferry adopt --from-box <box> <skill>` on the operator machine. Do not run it yourself.

- The Ferry on the box runs the deny rules on the skill. Ferry then copies the files that pass, and shows the file list of a new skill or the diff against the copy on the operator machine. Then it asks.
- A skill that fails a deny rule stays on the box, and Ferry copies no file of it to the operator machine. The error has the code `deny-rule-match`.
- The box needs a release of Ferry from `ferry install` or `ferry update`. Without it, the adopt fails with the code `refused` and names the command to run.
- Ferry skips the files that a skip rule covers, such as `node_modules`, and keeps the executable bit.
- After the confirmation, Ferry writes the skill to the same skill root on the operator machine and moves the box copy to `~/.ferry/backups/<time>/adopt` on the box.
- `ferry adopt` does not sync. The operator runs `ferry sync`, which publishes the skill and links it on all boxes.

## The Ferry skill

`ferry init` writes this skill to `~/.agents/skills/ferry` from the Ferry binary, and `ferry self-update` writes the skill of the new version. Ferry does not change the folder when it has local changes or another tool wrote it. `ferry init --no-skill` turns the install off. Do not edit this skill on the box.

## Integrations

An integration adds a service on the box, commands on the operator machine, or both. Paseo runs a service on the box, and takes a project that moves back into the Paseo of the operator machine. Sherlock adds commands on the operator machine. Each one is off by default. When it is off, Ferry prints nothing about it.

- `ferry integrations` lists each integration, shows if it is enabled, and shows the local app version that the box gets. It changes nothing.
- `ferry integrations enable paseo`, `ferry integrations disable paseo`, and the Paseo step of `ferry update` need the operator. Run them with `--dry-run` only, and tell the operator the command. An update restarts the Paseo daemon and stops the agents that run on the box.
- When Paseo is enabled, `ferry move` registers the project in the Paseo of the destination and imports each carried session as a Paseo agent. The destination is the box, or the operator machine for a move with `--from-box`. A session that already has an agent there is skipped. A `WARNING: Ferry could not register <path> in Paseo: <reason>. The move is complete.` line means that only the Paseo step failed. Do not run the move again for it.
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

### Sherlock

[Sherlock](https://github.com/michaelbromley/sherlock) is a read-only database query CLI on the operator machine. `ferry sherlock` exists only when `[integrations] sherlock = true` and `sherlock` is on the PATH. Without `sherlock`, `ferry integrations enable sherlock` stops and prints the install command.

- `ferry sherlock add <name> [--box <box>] --target <target> --type <type> [--database <name>] [--username <user>] [--ssl <mode>] [--password-stdin | --password-env <var>] [--force]` runs `sherlock connection add` with `--tunnel-command "ferry tunnel --box <box> <target>:{{port}}"`. The target is a box port, such as `5432`, or a host and port that the box can reach, such as `db.example:5432`.
- Do not type a password into a command. On a terminal, Ferry asks for it. Else tell the operator to run the command, or use `--password-env`.
- Then query with `sherlock -c <name> ...`. Sherlock opens the tunnel on the first query and closes it when idle.
- Ferry records `{ name, box, target }` in `~/.ferry/sherlock.json`. Do not edit it.
- Full `ferry status` has `Integrations on this machine:` with one line `<name>  <box>:<target>  <state>` for each recorded connection that `sherlock connection list` still has. `ferry status --json` has `integrations.sherlock.state.connections: [{ name, box, target, state, error }]`. `state` is `reachable`, `unreachable` (the box cannot connect to the target), `box-offline`, or `unknown-box`. `--brief` does not check Sherlock.

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

- A step that needs a confirmation fails with `confirmation-required`, unless the command has `--yes`. This applies to `install`, `update`, `uninstall`, `integrations enable|disable`, `box add` on a `[host]` config, `box remove --uninstall`, `.env` files and sessions with secrets in `move`, and `adopt`. The message of the error names what needs the confirmation.
- The SSH host keys of the snapshot host in `init` and `box add` need `--accept-host-keys`. `--yes` does not trust them. Without `--accept-host-keys`, the command fails with `confirmation-required`, and `error.details.hostKeys` is a list of `{ host, type, fingerprint }`. With `--accept-host-keys`, Ferry trusts the keys and writes the fingerprints to stderr.
- `ferry init --json` without the values that it needs fails with `missing-values`. The message lists the missing values, such as `host, sshUser, snapshotUrl`.
- `ferry auth <tool> --json` prints a `login` event before the envelope: `{ "type": "login", "provider", "url", "userCode", "codeRequired", "localPort", "timeoutMs" }`, and for `--mcp` also `server`. The login ends in the browser. When `codeRequired` is `true`, Ferry reads the code that the browser shows as one line on stdin. Without a line, it fails with `missing-values`.

### Error codes

| Code | Meaning |
| --- | --- |
| `usage` | An argument or an option is wrong, or does not apply to the command. |
| `config-missing` | There is no config, or it is not complete. The operator runs `ferry init`. When the message is `Ferry config has no box`, the operator runs `ferry box add <name>`. |
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
| `sync-busy` | Another sync, or a command that changes the box (`update`, `install`, `integrations enable\|disable`, `box remove --uninstall`), is active for the box. |
| `sync-failed` | The sync failed on one or more boxes, or the publish failed. |
| `update-failed` | One or more updates failed. |
| `login-failed` | The login on the box did not finish. |
| `command-failed` | A child command, such as `npx skills add`, failed. |
| `failed` | Any other error. |

### Results

| Command | `result` |
| --- | --- |
| `init` | `{ dryRun: false, leftovers, published, skill: { action, path, message } }`. `skill.action` is `installed`, `updated`, `unchanged`, `kept`, or `off`. With `--dry-run`: `{ dryRun: true, leftovers, plan: { operator, box, gitRemote, localCheckout, configPath, skills, instructions, links } }`. |
| `box list` | `{ boxes: [{ name, transport, destination, default }] }` |
| `box add` | `{ name, transport, destination, gitAuth, migrated, instructionFile }`. `instructionFile` is the per-box instruction file on the operator machine. |
| `box remove` | `{ name, defaultBoxRemoved, tunnelService, instructionFile }`. `tunnelService` is the file of the tunnel user service that Ferry removed from the operator machine, or `null`. `instructionFile` is the per-box instruction file that stays on the operator machine, or `null`. With `--uninstall`, also `uninstall: { dryRun, plan: { home, services, links: [{ path, link, backup }], profileBlock, paths }, remaining }`, or `null` when the operator cancels. The plan paths are relative to the box home. `backup` is the file that Ferry moves back to `path`, or `null`. `remaining` has the names that stay in `~/.ferry` on the box. A dry run changes nothing, so its `defaultBoxRemoved` is `false`, its `tunnelService` is `null`, and its `remaining` is empty. |
| `box default` | `{ defaultBox }` |
| `install` | `{ plan: [{ tool, policy, version, action, command, dependsOn }], gitIdentity: { name, email } or null }` |
| `update` | `{ dryRun, boxes: [{ name, ok, error, offline, skipped, plan, integrations: [{ id, plan }] }], operator: [{ tool, command } or { tool, reason }], updated, failed }`. A box with `skipped` has `ok: true`, but Ferry did not change it. `skipped` is the reason: a sync or another command held the lock of the box, or the box left the config or changed in it during the update. `updated` and `failed` name each update, such as `box gh`, `[a] box gh`, or `operator codex`. A box with `ok: false` has `error`: `box-offline`, or `update-failed` with its failed updates. Also on failure. |
| `sync` | `{ dryRun, published, boxes: [{ name, ok, step, error, skipped, plan, applyPlan, discarded }] }`. `plan` is the sync plan of the box, `applyPlan` its link changes (`null` for a dry run, a failed box, or a skipped box), and `discarded` the box checkout changes that the sync threw away. A box with `ok: false` has `step`, the step that failed, and `error`. A box with `skipped` has `ok: true`, but Ferry did not connect to it. `skipped` is the reason: the box left the config, or its target changed, during the sync. `warnings` has the same reason. With more than one box, also on failure. |
| `status` | The status report. With `--brief`, the brief report. See [Read state](#read-state). |
| `auth` | Without a tool: `{ providers: [{ id, login: "startable", "manual", or "off" }] }`. With a tool: the last login result, `{ kind, provider, ... }`, where `kind` is `logged-in`, `already-done`, `device-url`, `printed-url`, `local-port-forward`, or `manual-ssh`. |
| `tools` | `{ tools: [{ id, name, kind, install, policy: { policy, default }, boxes: [{ name, policy, default }], operatorVersion }] }` |
| `skills add` | `{ argv }`, the `npx skills add` command that ran. |
| `adopt` | `{ box, name, source, destination, replaces, files: [{ path, executable }], skipped: [{ path, code, reason }], diff, adopted, boxBackup }`, or `null` when the operator says no. `diff` is `null` for a new skill. `adopted` is `false` when the copy on the operator machine is already the same. `boxBackup` is `null` when Ferry could not move the box copy, and `warnings` then says so. |
| `move` | `{ path, source, destination, dryRun, git: { url, branch } or null, carry: [{ path, sha256, secrets }] (in a dry run from a box, `sha256` is null for a file with secrets, and `id` is null for a Codex session with secrets), refused: [{ path, code, reason }], skipped, notes, trash, sessions: { carry: [{ harness, id, files, secrets }], refused: [{ path, code, reason }] } }`. A memory file is a session with `id` null. |
| `tunnel --list` | `{ box, listeners: [{ port, address, process }] }` |
| `integrations` | `{ boxes: [{ name, destination, integrations: [{ id, description, enabled, localVersion, localSource, connectSteps }] }] }`. `name` is `null` for a `[host]` config. |
| `integrations enable`, `integrations disable` | `{ integration, action, dryRun, plan, output, enabled, connectSteps }`. `enabled` is the new config value, or `null` for a dry run. |
| `sherlock add` | `{ name, box, target, tunnelCommand }`. With `--json`, it needs `--password-stdin` or `--password-env`. |
| `watch install` | `{ manager: "launchd" or "systemd", path }` |
| `tunnel install` | `{ manager: "launchd" or "systemd", path }` |
| `tunnel uninstall` | `{ manager, path, removed }`. `removed` is `false` when the box had no service file. |
| `menubar install` | `{ app, path, version, ferryPath }`. `path` is the launchd agent. `version` is the release of the app, or `null` with `--app`. |
| `menubar uninstall` | `{ app, path, removed }`. `removed` is `false` when neither the app nor the agent was there. |
| `uninstall` | `{ removed, restored }` |
| `whoami` | `{ role: "operator" or "box", box, instructions, managedPaths: { instructionFiles, skillRoots, roots } }`. `box` is `null` on the operator machine and before the first sync of a box. `instructions` is `{ file, sources: [{ part, path }] }` on a box with the generated instruction file, else `null`. `sources` has the merged parts in order. `part` is `header`, `box`, or `shared`. `path` is the file on the operator machine, or `null` for the header. The `box` part is there only when the last sync applied a per-box file. |
| `self-update` | `{ current, latest, updated, services: [{ service, action, message }], skill }`. `skill` is the message of the skill update, or `null` when Ferry did not update. An action is `restarted`, `updated`, `skipped`, or `failed`. A failed service action is also in `warnings` and does not fail the binary update. `updated` is `false` when `current` is the latest release. The output of the installer goes to stderr. |

## Other commands

- `ferry --version` prints the Ferry version.
- `ferry self-update` updates Ferry on the operator machine. It restarts installed watch and tunnel services only when their service files point at this Ferry. On macOS, it updates an installed release menu bar app. It skips a menu bar app whose service marks it as a local `--app` build. Then `ferry update` puts the new version on the boxes. With `--json`, Ferry never asks to update before a command.
- On the box, `ferry expose [--port <n>] -- <command...>` runs a dev server and announces its port. The port is `--port`, else `$PASEO_PORT`. On the operator machine, `ferry tunnel --follow` opens a forward for each announced port until Ctrl-C. `ferry tunnel install [--box <name>]` runs `--follow` for one box as a user service, and `ferry tunnel uninstall [--box <name>]` removes it. `ferry tunnel install --help` names the service file and the log. Do not write to or remove files in `~/.ferry/exposed/` yourself.
- `ferry tunnel --follow` (also as the service) writes `~/.ferry/tunnels/<box>.json` when it connects, after each change of the forwards, and when the connection drops: `{ schemaVersion: 1, box, pid, connected, updatedAt, forwards: [{ name, cwd, boxPort, localPort }] }`. `name` and `cwd` are missing when the entry has none. `connected` is `false` with no forwards after a drop, until Ferry connects again. Ferry removes the file on Ctrl-C or SIGTERM. A file whose `pid` does not run is stale. Read the file to find the local port of a dev server. Do not write it yourself. A plain `ferry tunnel <port>` writes no file.
- `ferry box remove <name>` removes a box from the config and does not connect to it. `ferry box remove <name> --uninstall` removes Ferry from the box first: the `ferry-*.service` user services, the links into the Ferry checkout, the ferry PATH block of `~/.profile`, `~/.ferry/store`, `~/.ferry/box`, `~/.ferry/exposed`, the Ferry binary, and `~/.ferry/box.json`. It moves a backup of `ferry sync --force` back to its path. The logins, credentials, SSH keys, project directories, `~/.paseo`, the installed tools, and the values that sync merged into the config files of the box stay. Run it with `--dry-run` first, and show the plan to the operator. It runs only on the operator machine. When Ferry cannot reach the box, the box stays in the config.
- `ferry box remove <name>` without `--uninstall` refuses the last box. With `--uninstall`, Ferry removes the last box too. For a `[host]` config, the box name is `default`. Then the config has no box: no `[host]` table and no `[box.<name>]` table. The rest of the config stays. The result has the warning `the config has no box now`.
- With a config that has no box, `ferry sync`, `ferry status`, `ferry install`, and `ferry watch` fail with `Ferry config has no box. Add a box with ferry box add <name>.` The code is `config-missing`, and `config-invalid` for `ferry install`. `ferry box list` gives `{ boxes: [] }`. Tell the operator to run `ferry box add <name>`. `ferry init` also adds a box and keeps the rest of the config.
- With and without `--uninstall`, `ferry box remove <name>` stops and removes the tunnel user service of the box on the operator machine. The per-box instruction file `~/.ferry/boxes/<name>/AGENTS.md` stays, and the output names it. Do not delete it. It is the text of the operator.
- `ferry update`, `ferry install`, and `ferry integrations enable|disable` hold the sync lock of each box that they change, from after the confirmation to their end. `ferry update` skips a box whose lock is busy, or that left the config during the update, and does not fail for it. `ferry install` and `ferry integrations enable|disable` change one box, so they fail: with `sync-busy` for a busy box, and with `refused` for a box that left the config. `ferry move` takes no lock.
- `ferry box remove <name> --uninstall` holds the sync lock of the box until the box is out of the config. A sync that includes the box fails with `sync-busy` during that time. When a sync for the box runs, the command fails with `sync-busy` and changes nothing. Then wait and run it again. `--dry-run` takes no lock.
- `ferry update --dry-run` prints the update plan for the agent tools on both machines.
- `ferry init --dry-run` prints the init plan without writing or connecting.
- `ferry watch` syncs accepted changes in the foreground. `ferry watch install` installs it as a user service. A successful `ferry self-update` restarts the service when it points at the updated Ferry.
- On macOS, `ferry menubar install` installs a menu bar app that shows the report of `~/.ferry/status.json` and the ports of `~/.ferry/tunnels/*.json`. It needs `ferry watch`. A development build of Ferry needs `--app <path>`, a build of `macos/build.sh`. `ferry menubar uninstall` removes the app.
- `ferry <command> --help` has the details and the config formats. For example, `ferry tools --help` shows the `[tools]` tables, `ferry update --help` shows the sudo rule for the daily update, and `ferry box add --help` shows the `git_auth = "box"` deploy key step.
