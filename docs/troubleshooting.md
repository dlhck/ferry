---
title: Troubleshooting
description: Find a problem with ferry doctor, and fix the common errors of sync, move, and the boxes.
---

# Troubleshooting

## Start with `ferry doctor`

`ferry doctor` runs each check, also after a check fails, and changes nothing. It prints a fix for each failed check. The exit code is 1 when a check fails.

| Check | What it tests | Fix when it fails |
| --- | --- | --- |
| `ssh-agent` | The SSH agent has a key. | `ssh-add` |
| `tailscale` | Tailscale runs on the operator machine. Only for a Tailscale box. | `tailscale up` |
| `snapshot-read` | The operator machine can read the snapshot. | For an SSH URL: `ssh-add`, with a key that can read the repository. Without a snapshot URL: `ferry init` |
| `snapshot-push` | The operator machine can push to the snapshot (`git push --dry-run`). | For an SSH URL: `ssh-add`, with a key that has write access. |
| Services | The installed watch and tunnel services run this Ferry. | `ferry watch install`, or `ferry tunnel install --box <name>` |
| `box-ssh` | The box responds over SSH with host key checks on. | For a host key: `ssh <destination>`, and check the fingerprint. For a refused key: `ssh-copy-id <destination>` |
| `box-tailscale` | Tailscale reaches a Tailscale box. | `sudo tailscale up` on the box |
| `box-snapshot` | The box can read the snapshot, with the forwarded agent or the deploy key of `git_auth = "box"`. | Add the public key that the fix prints as a read-only deploy key. |
| `box-linger` | Linger is on when a Ferry service runs on the box. | `sudo loginctl enable-linger "$USER"` on the box |
| `box-lock` | The lock of the box on the operator machine. A held lock shows the command that holds it and its pid. This is not a failure. The check fails only for a lock of a Ferry version before 0.10.0 whose pid is alive. | `ferry watch install` when the watch service is installed. If not, `kill <pid>` |

Then run `ferry status`, or `ferry status --brief` for only the items that need action. See [Status and the menu bar](status.md).

## Sync

### A deny rule stops the sync

```text
operator: Manifest refused publisher <host>: <reason>: <path>
```

A deny rule refused a file. Nothing was published. The message names the file, never the value. Remove the secret from the file, or remove the file from the carried set. Do not rename or encode the file to get past the rule. See the [Security model](security-model.md#deny-rules).

`Manifest refused the instructions of box <name>` means that a rule refused the per-box instruction file of that box. The other boxes sync.

### A box is busy

One Ferry command at a time changes a box. A second command stops with the code `sync-busy` and names the box and the command that holds the lock:

```text
operator: The watch service syncs box fsn1 now (pid 1234). Try again in a moment.
operator: ferry update works on box fsn1 now (pid 1234). Wait for it to end, then try again.
```

Run the command again. A sync of `ferry watch` takes some seconds, for example after `ferry self-update` starts the watch service again. `ferry watch` tries its own sync again without your help.

Do not remove a lock file in `~/.ferry`. Ferry replaces the lock of a process that stopped.

```text
operator: A process of an earlier Ferry version holds the lock of box fsn1 (pid 1234). ...
```

A Ferry version before 0.10.0 wrote this lock. Ferry keeps it while a process has that pid. If the lock stays, run `ferry doctor`. The `box-lock` check gives the fix: `ferry watch install` starts the watch service with this version, or you stop the process.

A message without a command, `A sync or another Ferry command works on box fsn1 now (pid 1234)`, is the lock of Ferry 0.10.0. Wait for that command to end.

### Two copies of a skill

A refusal with `clash <name>: <path>, <path>` means that two harness roots hold different copies of a skill with the same name. Keep one copy.

### A stdio MCP server stops the sync

The deny rule `mcp-argument` or `url-credential` means that a command or an argument of a stdio MCP server has a token, a secret flag with a value, or a URL with a credential. Remove the credential from the arguments, and set it in the `env` of the server on the box.

### Skipped entries

A skipped entry is expected. The sync continues.

| Line | Meaning | What to do |
| --- | --- | --- |
| `Skipped hook: <reason>: <location>` | The hook command refers to a home path that the box will not have. | Move the script into `~/.claude/hooks` or onto the `PATH` of both machines. |
| `Skipped MCP server: <reason>: <path>` | The server has a plain `http://` URL, refers to a home path, or runs an inline script. | Put the script in a file that Ferry carries, or run the server through a tool on the `PATH`. |
| `Discarded box change: <path>` | Sync threw away an edit on the box. | Change the file on the operator machine. |
| `Box plugins: ...`, `Box MCP: ...` | A warning about a plugin or an MCP server on the box. | Read the warning. For a missing jq, run `ferry update`. |

### A real directory on the box

A `refuse-live-directory` entry in `ferry status` is a real directory on the box, such as `~/.claude/agents`, where Ferry wants a link. `ferry sync --force` moves it to `~/.ferry/backups` and links it.

### An MCP server does not work on the box

Run `ferry status --brief`. It names each missing env key and each command that is not on the box.

- For a missing env key, set the value in the `env` of the server on the box. Ferry keeps it.
- For a missing command, install it on the box. Ferry never installs a command.
- For a remote server that needs a login, run `ferry auth <tool> --mcp <server>`.

## Error codes

With `--json`, a failed command has `error.code`. The text output has the same errors as messages.

| Code | Meaning | What to do |
| --- | --- | --- |
| `config-missing` | There is no config, or it is not complete. | `ferry init`. For `Ferry config has no box`: `ferry box add <name>` |
| `config-invalid` | The config or a tool table has an error. | Correct `~/.ferry/config.toml`. `ferry tools --help` shows the tool tables. |
| `unknown-box` | A box name is not in the config. | `ferry box list` |
| `box-required` | More than one box is configured, and the command changes one box. | Add `--box <name>`, or `ferry box default <name>` |
| `box-offline` | Ferry cannot reach the box. | `ferry doctor` |
| `box-command-failed` | A command on the box failed or timed out. | Run the command again. Then `ferry doctor` |
| `forward-failed` | A port forward did not open or close. | Check that the local port is free. |
| `confirmation-required` | The step needs a confirmation. | Run the command on a terminal. For SSH host keys, check the fingerprints, then add `--accept-host-keys` |
| `deny-rule-match` | A deny rule refused a file. | Remove the secret from the file. |
| `refused` | A safety check refused the change, such as a clash, a live path, or an unpushed commit. | Read the message. |
| `sync-busy` | Another sync, or a command that changes the box, works on the box. The message names the box and that command. | Run the command again. See [A box is busy](#a-box-is-busy). |
| `sync-failed` | The sync failed on one or more boxes, or the publish failed. | `ferry doctor` |
| `update-failed` | One or more updates failed. | Read the failed updates in the output. |
| `login-failed` | The login on the box did not finish. | Run `ferry auth <tool>` again. |

## Moves and adopted skills

| Message | What to do |
| --- | --- |
| `Ferry is not installed on <box>` | `ferry install` |
| `The Ferry on <box> is too old to check the files there` | `ferry update` |
| `The Ferry on <box> has older deny rules than this machine` | `ferry update` |
| `Skip: <path> (too large for Ferry to check)` | The file has more than 128 MiB. Copy it by hand. |
| `The origin URL has a credential. Ferry carries the URL without it` | Log in on the destination, for example with `ferry auth gh`. |

See [Moving a project](moving-a-project.md).

## Boxes

### A tool shows `hidden`

A login shell on the box does not find the tool. Run `ferry sync`. It writes the ferry PATH block in `~/.profile` on the box.

### The daily update fails for `gh`

`ferry watch` runs the daily update without a terminal, and `sudo apt` asks for a password. Add the sudoers rule that [`ferry update`](commands.md#ferry-update) shows. `ferry status` shows `Box sudo: PASSWORDLESS` when the rule works.

### A box cannot push to GitHub

Run `ferry auth gh`. It logs `gh` in on the box, creates an SSH key there if it is missing, and adds the key to your GitHub account.

### Agents stop when you log out of the box

A user service on the box stops without linger. Run `ferry doctor`. It prints the `loginctl enable-linger` command for the box.

### The box checkout has local changes

`boxCheckout.dirty: true` in `ferry status --json` means that the box checkout has local changes. The next sync discards them. Copy what you want to keep first.

## Services after an update

`ferry self-update` restarts installed watch and tunnel services that point at the updated Ferry. It leaves a service that uses another Ferry unchanged. After you move Ferry, run `ferry watch install`, `ferry tunnel install`, and on macOS `ferry menubar install` again.

After an update from a release before v0.10.0, run `ferry menubar install` one time on macOS, so the app gets the SSH agent of the watch service. Run `ferry update` for each box, because `ferry adopt --from-box` and `ferry move --from-box` refuse a box with an older Ferry.

## Get help

`ferry <command> --help` has the options, the config formats, and the details of each command. The [Commands](commands.md) page has the same text. Report a bug in the [issue tracker](https://github.com/dlhck/ferry/issues). Report a security problem privately. See the [Security model](security-model.md#report-a-vulnerability).
