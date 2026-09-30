---
title: Boxes
description: Add a box, install and update its tools, write instructions for one box, open its ports, and remove Ferry from it.
---

# Boxes

A box is a Linux machine where remote agents run. Ferry connects to each box from the operator machine, over Tailscale or plain OpenSSH. Boxes do not connect to each other.

## Add a box

`ferry init` records the first box. `ferry box add <name>` checks a new box like `ferry init`, then adds a `[box.<name>]` table to `~/.ferry/config.toml`.

```sh
ferry box add b --ssh-destination user@box-b.example
ferry install --box b
ferry sync
```

- A box name has 1 to 32 characters from `a-z`, `0-9`, and `-`.
- The first `box add` on a `[host]` config moves `[host]` to `[box.default]` and sets `default_box = "default"`. Ferry asks before it writes.
- `ferry box list` lists the boxes, their transport and destination, and the default box.
- `ferry box default <name>` sets `default_box`. It is the box of `install`, `auth`, `move`, `tunnel`, and `integrations enable|disable` without `--box`.
- `sync`, `status`, and `update` work on all boxes, or on the boxes of `--box`. Repeat `--box` to select more boxes.

### A box without your SSH agent

By default, Ferry forwards your SSH agent to the box for the git commands that read the snapshot. With `ferry box add <name> --git-auth box`, Ferry never forwards your SSH agent to that box:

1. Ferry creates `~/.ssh/ferry_snapshot` on the box and tests read access to the snapshot with it.
2. If the test fails, Ferry prints the public key and does not change the config.
3. Add the key as a read-only deploy key on the snapshot repository, then run the command again.

To change an existing box, set `git_auth = "box"` in its `[box.<name>]` table and run `ferry init --box <name>`.

## Install and update tools

`ferry install` installs `gh`, `jq`, the agent CLIs (`claude`, `codex`, `pi`, `cursor-agent`), the tools of the config, and Ferry on a box. It prints the plan for each tool and asks before it runs a command. `gh` and `jq` come from apt, so Debian or Ubuntu is the tested target.

`ferry update` updates the agent tools on the boxes and on the operator machine. Each box gets the tool versions of its policy, the Ferry version of the operator machine, and Paseo when the integration is on. `ferry update --dry-run` prints the plan.

### Version policies

`ferry tools` lists the tools and their policies. A policy is `"operator"` (the version on the operator machine), `"latest"`, or an exact version. The default is `"latest"` for an agent CLI and `"operator"` for a tool. `[box.<name>.tools]` sets the policy for one box.

```toml
[tools]
gh = "latest"
codex = "0.156.1"
pi = "off"

[box.b.tools]
pi = "latest"
```

`"off"` turns off `gh` or an agent CLI. `install`, `update`, and the daily watch update skip it, `ferry auth` refuses it, and `ferry status` shows it as `off`. Ferry does not uninstall it from the box.

### Your own tools

Define each other tool in a `[tools.<id>]` table:

```toml
[tools.pnpm]
version = "operator"
local = "pnpm --version"
box = "pnpm --version"
latest = "npm view pnpm version"
install = 'npm install -g --prefix "$HOME/.local" pnpm@{version}'
path = [".local/bin"]
depends = ["node"]
```

`local` and `install` are required. The `auth_status`, `auth_login`, and `auth_hosts` keys let `ferry auth <id>` log the tool in on the box. See [`ferry tools`](commands.md#ferry-tools) for each key.

### Daily updates

With `[update] watch = true`, `ferry watch` runs the update once each day for the tools with the `"latest"` policy. The `gh` update runs `sudo apt` on the box, and the watch has no terminal for a password. See [`ferry update`](commands.md#ferry-update) for the sudoers rule. `ferry status` shows `Box sudo: PASSWORDLESS` when the rule works.

## Box awareness

On each sync, a box gets the generated file `~/.ferry/box/AGENTS.md`. The instruction files of the box link to it. The operator machine does not change. Ferry merges the file from three parts, in this order, with one blank line between them:

1. The Ferry header. It names the box and tells agents not to run `ferry sync` or edit Ferry-managed files there.
2. The per-box instructions, from `~/.ferry/boxes/<name>/AGENTS.md` on the operator machine. Only the box `<name>` gets them. A missing or empty file adds nothing.
3. The shared instructions, your `~/AGENTS.md`, byte for byte.

Agents run `ferry whoami` to check where they are. It prints the role of the machine (operator machine or box), the box name, and the paths that Ferry manages. On a box, it also prints the parts of the merged instruction file.

## Per-box instructions

Write the instructions for one box in `~/.ferry/boxes/<name>/AGENTS.md` on the operator machine, for example "this box runs the staging database". Then run `ferry sync`.

- `ferry box add` creates the file empty and prints its path.
- `ferry init` does not create it, so create it by hand for your first box. A `[host]` config has one box with the name `default`.
- Never edit `~/.ferry/box/AGENTS.md` on the box. Each sync writes it again.
- A box gets an instruction file only when you have a `~/AGENTS.md`. Without one, Ferry warns and does not apply the per-box file.
- The file never goes into the snapshot. It gets the same deny rules as `~/AGENTS.md`. A match stops the sync of that box only.
- With `ferry watch`, a change to a per-box file syncs only its box, and publishes nothing.

## Do not edit managed files on a box

Each sync resets the box checkout and writes the carried keys again. A change to a Ferry-managed file on the box is lost, and sync prints `Discarded box change: <path>` for it. Change the file on the operator machine instead. The `env` values of a carried stdio MCP server are the exception: set them on the box, and Ferry keeps them.

`ferry sync --force` moves a live directory on the box, such as a real `~/.claude/agents`, to `~/.ferry/backups` and links it.

## Box ports

`ferry tunnel` opens box ports on `127.0.0.1` of the operator machine until Ctrl-C.

| Argument | Box end | Local port |
| --- | --- | --- |
| `5432` | `127.0.0.1:5432` on the box | 5432 |
| `5432:15432` | `127.0.0.1:5432` on the box | 15432 |
| `db.example:5432` | `db.example:5432` from the box | 5432 |
| `db.example:5432:15432` | `db.example:5432` from the box | 15432 |
| `[fd00::1]:5432` | `[fd00::1]:5432` from the box | 5432 |

- Put a host before the box port to forward to a host that the box can reach, such as a database that accepts connections only from the box network. The box resolves the host name.
- Ferry first checks that the box can connect to the host, and stops with an error when it cannot. On a box without `bash`, `timeout`, or `/dev/tcp`, Ferry cannot always make this check. Then it prints a warning and opens the tunnel.
- `ferry tunnel --list` lists the TCP ports that listen on the box, with process names.

### Dev servers

On the box, `ferry expose -- <command>` runs a dev server and announces its port. The port is `--port`, else `$PASEO_PORT`. On the operator machine, `ferry tunnel --follow` opens a forward for each announced port and closes it when the port goes away. It connects again 5 seconds after a drop.

`ferry tunnel install` runs `--follow` for one box as a user service. `ferry tunnel uninstall` removes it.

`--follow` writes its forwards to `~/.ferry/tunnels/<box>.json`, and removes the file when it stops. The menu bar app reads it.

## Remove a box

`ferry box remove <name>` removes a box from the config. It does not connect to the box, and it refuses the last box.

`ferry box remove <name> --uninstall` removes Ferry from the box first. Run it with `--dry-run` to see the plan. Ferry connects to the box, prints the plan, and asks you to type the box name. Then it does these steps on the box:

1. It stops and removes each `ferry-*.service` user service, such as `ferry-paseo.service`. A stopped service stops its agents.
2. It removes each skill link, instruction file link, and root link that points into the Ferry checkout or to `~/.ferry/box/AGENTS.md`. When `ferry sync --force` moved a file of yours to `~/.ferry/backups`, Ferry moves the newest backup of that path back.
3. It removes the ferry PATH block of `~/.profile`.
4. It removes `~/.ferry/box`, `~/.ferry/exposed`, the checkout `~/.ferry/store`, the Ferry binary `~/.local/bin/ferry`, and the marker `~/.ferry/box.json`.

Then Ferry removes the box from the config.

### What stays on the box

- The logins and credentials, and the SSH keys
- The project directories
- `~/.paseo`
- The tools that Ferry installed: `gh`, `jq`, the agent CLIs, the Paseo CLI, and the tools of the config
- The settings keys, MCP servers, and plugins that sync merged into the config files of the box
- `~/.ferry/trash`, and each backup that Ferry did not move back

When Ferry cannot reach the box, or a box step fails, the box stays in the config.

### What changes on the operator machine

With and without `--uninstall`, Ferry stops and removes the tunnel user service of the box. Your per-box instruction file `~/.ferry/boxes/<name>/AGENTS.md` stays, and Ferry prints its path. A later box with the same name gets its text, so delete the file when you do not need it.

### Your only box

`ferry box remove <name> --uninstall` also removes the last box. For a `[host]` config, the box name is `default`. After the removal, the config has no `[host]` table and no `[box.<name>]` table. The rest of the config stays. `ferry sync`, `ferry status`, `ferry install`, and `ferry watch` then fail with `Ferry config has no box. Add a box with ferry box add <name>.` To use Ferry again, run `ferry box add <name>`, or `ferry init`.

### Locks

With `--uninstall`, Ferry holds the sync lock of the box from before it connects until the box is out of the config. During that time, a sync that includes the box fails with `sync-busy`, also a sync of `ferry watch`. The watch syncs again later. When a sync for the box runs, the command fails with `sync-busy` and changes nothing. `ferry update`, `ferry install`, `ferry move`, and `ferry integrations enable|disable` hold the same lock for each box that they change.
