---
title: Boxes
description: Add or create a box, install and update its tools, write instructions for one box, open its ports, and remove Ferry from it.
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

### Projects on a box

`projects` in `[box.<name>]` lists the git project directories on the box, relative to the box home:

```toml
[box.b]
transport = "ssh"
destination = "user@box-b.example"
projects = ["code/app", "work/api"]
```

`ferry status` reports the [unsaved work](status.md#unsaved-work) of each project. A path must be below the box home, with no `~` and no `..`. You do not need to add a project that `ferry move` moved to the box, because the box records it.

### A memory limit for each agent

`agent_memory_max` in `[box.<name>]` sets a memory limit for each agent on the box. The key is optional, and there is no limit without it. One value does not fit all boxes, so Ferry sets no default.

```toml
[box.b]
transport = "ssh"
destination = "user@box-b.example"
agent_memory_max = "6G"
```

The value is a systemd `MemoryMax` size: a number with a `K`, `M`, `G`, `T`, `P`, or `E` suffix (base 1024), or a percentage of the box memory, such as `"50%"`. A size must be at least `256M`. Ferry refuses a number without a suffix, because systemd reads it as bytes, and an agent does not start with that little memory. When an agent uses more memory than the limit, the kernel stops that agent only. The other agents and the Paseo daemon continue.

Ferry does not start the agents. With the [Paseo integration](paseo-sync.md#agent-memory-limit), `ferry sync` applies the limit to each agent that Paseo starts on the box. `ferry ps` shows the limit next to the box name.

To give the same limit to an agent that you start from a shell or from a Paseo terminal profile, start it in a systemd scope:

```sh
systemd-run --user --scope -p MemoryMax=6G -- claude
```

### An MCP gateway on the box

`mcp_gateway = true` in `[box.<name>]` runs the Ferry MCP gateway on the box. The key is optional and off by default. Without it, the box does not change.

```toml
[box.b]
transport = "ssh"
destination = "user@box-b.example"
mcp_gateway = true
```

The gateway is the only OAuth client of each carried remote MCP server on the box. It keeps one login for each server, in place of one login for each harness. Claude Code, Codex, and Cursor Agent on the box connect to the gateway, and the gateway connects to the server.

On each sync of the box, Ferry does these steps:

1. It writes `~/.ferry/mcp-gateway/servers.json` with the name and the URL of each carried remote server. The file gets no header and no `env` value. The gateway supports Streamable HTTP only, so Ferry skips an SSE server and prints a warning.
2. It makes the client key `~/.ferry/mcp-gateway/client-key` when it is missing. A harness sends this key to the gateway. The key never leaves the box.
3. It installs and starts the user service `ferry-mcp-gateway.service`, which runs `ferry mcp serve` on `127.0.0.1:47820`.
4. It points the entry of each gateway server in each harness at the gateway: the URL `http://127.0.0.1:47820/mcp/<server>` and the header `Authorization: Bearer <client key>`. The box reads the key from its file and writes it only into the harness entries. Ferry adds a Claude entry with `claude mcp add-json` and a Codex entry with `codex mcp add`, and then adds the `http_headers` table to `~/.codex/config.toml` and sets the file mode to 0600. It merges a Cursor entry into `~/.cursor/mcp.json` with jq. Stdio servers keep their direct entries, except the [shared stdio servers](#shared-stdio-servers). SSE servers keep their direct entries. This step needs jq on the box.
5. It removes each harness entry whose URL starts with `http://127.0.0.1:47820/mcp/` when Ferry no longer carries its server. For Codex, `codex mcp remove` also removes the `http_headers` table. Ferry does not change an entry without this prefix.

When the gateway service does not run, the harness entries stay on the gateway. Ferry does not change them back to direct entries, so they do not change from one sync to the next. `ferry status --brief` shows the `mcp-gateway` item in the state `stopped`, until a sync starts the service again.

The gateway runs the Ferry of the box. A development build of Ferry puts no Ferry on the box, so it gets no gateway, and the harness entries stay direct. Sync prints a warning, and `ferry status` shows `MCP gateway: NOT AVAILABLE`. A box with a Ferry from before the gateway, such as 0.10.4, also gets no gateway: the harness entries stay direct, and sync and `ferry status` tell you to run `ferry update --box <name>`. The next sync then starts the gateway. When `ferry update` changes the Ferry of the box, it restarts the gateway service. A box that has no gateway service yet has nothing to restart, and the update does not fail.

Log in the gateway to a server with `ferry auth --mcp <server> --box <name>`. The token stays on the box, in `~/.ferry/mcp-gateway/tokens/`, with mode 0600. `ferry status` shows the gateway state and the login state of each server. `ferry status --brief` shows one `gateway/<server>` item for each server that needs a login, and one `mcp-gateway` item when the service does not run. A harness entry of the gateway needs no login of its own, because the gateway never asks a harness for a login. So `ferry status` shows no `<tool>/<server>` login item for it.

When you remove the key, the next sync first changes each gateway entry of a carried server back to its direct entry, and removes each other gateway entry. Then it stops and removes the service and deletes `~/.ferry/mcp-gateway/`, with the tokens and the client key. Ferry does not change a box entry whose URL is not on the gateway. The harnesses then have no login for the remote servers, and `ferry status` shows one `mcp-login` item for each harness and server. Log in again with `ferry auth <tool> --mcp <server>`.

#### Shared stdio servers

`mcp_gateway_shared` in `[box.<name>]` names the carried stdio MCP servers that the gateway shares between the agents of the box. The key is optional. Without it, each harness starts its own process of each stdio server, as on a box without the gateway.

```toml
[box.b]
transport = "ssh"
destination = "user@box-b.example"
mcp_gateway = true
mcp_gateway_shared = ["context7"]
```

The gateway starts one process of each shared server for all agents of the box, at `http://127.0.0.1:47820/mcp/<server>`. It starts the process on the first call. When the process stops, the gateway starts it again on the next call, and until then it keeps the last tool list.

On each sync of the box, Ferry does these steps for the shared servers:

1. It writes the command and the arguments of each shared server into `~/.ferry/mcp-gateway/servers.json`.
2. The box copies the `env` values of the server from the first harness entry that has all the `env` keys into `servers.json`. The file has mode 0600. When `servers.json` has all the keys already, the box keeps its values. The box does this with jq, and it sends back only status letters, never a value.
3. It points the harness entries of the server at the gateway, as for a remote server.

When you remove a server from `mcp_gateway_shared`, or remove `mcp_gateway`, the box first writes the `env` values from `servers.json` back into each harness entry of the server, with the direct command. Then it removes the server from `servers.json`, or deletes `~/.ferry/mcp-gateway/`. `ferry box remove <name> --uninstall` does the same. When the box cannot change a harness entry back, for example because `codex mcp add` fails, or because the box has no jq, sync keeps the service and `~/.ferry/mcp-gateway/`, because `servers.json` can be the only copy of the `env` values. Sync prints a warning, and the next sync tries again. Before sync deletes `~/.ferry/mcp-gateway/`, the box also checks that each harness entry of a server in `servers.json` sets all `env` keys of that file. An entry that is missing, or that lacks a key, gets the direct entry with the `env` values of `servers.json` again. If that fails too, sync keeps the directory. In the same case, `ferry box remove <name> --uninstall` stops before it removes Ferry, and the box stays in the config. The uninstall does not know the carried servers, so it checks `servers.json` itself: for each stdio server there, at least one harness on the box must have a direct entry with all `env` keys. If none has, the box writes the entry with the `env` values of `servers.json` into each harness on the box. When a server leaves `mcp_gateway_shared` and the box cannot give its entries their `env` values back, `servers.json` keeps the server with `"leaving": true`. The gateway does not serve it. A later sync drops it after its entries have their `env` values.

Sync prints a warning and ignores a name in `mcp_gateway_shared` when Ferry carries no stdio server with that name to the box. It also prints a warning when the box has `mcp_gateway_shared` but not `mcp_gateway = true`, and when the box has no jq. Without jq, the shared servers keep their direct entries.

Share a server only when one process can serve all agents. These are the risks:

- The process keeps its state for all agents. A server that keeps a session, a cache, a login, or a selected project for one agent gives that state to the other agents.
- The working directory of the process is the home of the box user, not the project of the agent. A server that reads files relative to its working directory reads them from the home.
- The service has the same `PATH` as a Ferry box command and the Paseo unit: the box PATH directories in the home, such as `~/.local/bin`, then the system directories. A command in another directory, such as a version manager like nvm, is not found. Use an absolute command path outside the home, or install the command in one of these directories.
- The gateway connects to the server with no client capabilities. When the server sends a request to the client, such as `roots/list` or sampling, the gateway answers with an error. Then `ferry mcp list` and `ferry status` show the server in the state `cannot-share`, and `ferry status --brief` shows a `gateway/<server>` item. To fix it, remove the server from `mcp_gateway_shared`, then run `ferry sync --box <name>`.

Limits:

- Agents run as the box user, so they can read the client key and the gateway tokens. Other users of the box cannot read them: the files have mode 0600. The [Security model](security-model.md#the-mcp-gateway) has the details.
- Cursor Agent keeps a list of approved MCP servers (`cursor-agent mcp enable <server>`, or `--approve-mcps` for one run). Ferry does not approve a server for Cursor Agent, for a gateway entry or a direct entry. The Cursor documentation does not say if a changed entry needs a new approval.
- `ferry box remove <name> --uninstall` does the same step first: each gateway entry of a server in `~/.ferry/mcp-gateway/servers.json` gets its direct entry back, and Ferry removes each other gateway entry. Then it removes the service and `~/.ferry/mcp-gateway/`. The plan shows this step.

### Change box keys with ferry config

`ferry config` reads and changes some keys of `~/.ferry/config.toml`. The menu bar app uses it for its settings.

```sh
ferry config get
ferry config set mcp_gateway true --box dev
ferry config set mcp_gateway_shared context7 github --box dev
ferry config set agent_memory_max 6G --box dev
ferry config set projects code/app work/api --box dev
ferry config unset agent_memory_max --box dev
ferry config set notifications.agents true
```

| Key | Scope | Value |
| --- | --- | --- |
| `notifications.agents` | all boxes, no `--box` | `true` or `false` |
| `mcp_gateway` | one box | `true` or `false`. `false` removes the key. |
| `mcp_gateway_shared` | one box | zero or more stdio MCP server names |
| `agent_memory_max` | one box | one size with the rule of [A memory limit for each agent](#a-memory-limit-for-each-agent) |
| `projects` | one box | zero or more paths relative to the box home |

- A box key changes the box of `--box`, else `default_box`, else the only box. A `[host]` config has no box table, so only `notifications.agents` works there. Run `ferry box add` first.
- An empty list and `ferry config unset` remove the key.
- A value that is not valid changes nothing, and the command fails with the code `usage`.
- `ferry config get` also lists the carried stdio MCP servers of this machine that each box can share. It prints only the names, never a command, an env value, a header, or a URL. When Ferry cannot read the MCP files, the list is empty, and the command prints a warning.
- A change goes to the box at the next sync. The command prints the sync to run, such as `Run ferry sync --box dev to apply it.` With `--json`, `syncNeeded` is `true` when the value changed.
- Ferry writes the whole config again, so the comments in `~/.ferry/config.toml` are lost after a change. A command that changes nothing does not write the file.

## Create a box at Hetzner Cloud

`ferry box create <name>` creates a machine in your Hetzner Cloud project, with your API token. Ferry does not host machines. The machine costs money until you run `ferry box destroy <name>`.

```sh
export HCLOUD_TOKEN=...          # or a keychain entry, see below
ferry box create b --dry-run     # the plan and the monthly price
ferry box create b
```

Ferry does these steps:

1. It creates the machine `ferry-<name>` with the label `ferry-box=<name>` and a firewall that allows inbound TCP port 22 only. The machine gets the SSH user `ferry` with your public key. It has no password login.
2. It pins the SSH host key of the machine in `~/.ssh/known_hosts`, connects as root with your key, and replaces the host key on the box. Each SSH connection of the create uses `StrictHostKeyChecking=yes` with `~/.ssh/known_hosts` as the only user known_hosts file, so a setting in `~/.ssh/config` cannot turn the check off. See [the security model](security-model.md#the-ssh-host-key).
3. As root, it installs Tailscale, joins your tailnet with the host name `ferry-<name>`, installs gh with its apt source, and turns on linger for `ferry`.
4. It writes the sudoers rule of the `ferry` user and turns off root login. See [the security model](security-model.md#ssh-login-and-sudo).
5. As `ferry`, it runs `ferry box add <name>` with the Tailscale name, `ferry install --box <name>`, and `ferry sync --box <name>`. Then `ferry status` shows the box, with `Box sudo: PASSWORDLESS`.

The box table gets `provider_id`, the id of the machine at Hetzner Cloud. `ferry box destroy` uses it to find the box of the machine. Do not change it. The box gets `gh = "latest"` in `[box.<name>.tools]`, because the sudoers rule allows `apt install gh -y` only, and no exact gh version. Do not change that policy for the box.

Before it installs gh, `ferry install` runs `sudo apt update --error-on=any`. When this command fails, Ferry adds the GitHub CLI apt source and key again, so a box gets a new key after GitHub changes it. On a created box, the sudoers rule does not allow that setup. So a warning from any apt source, for example a mirror that does not answer, stops `ferry install` with the apt warning. Run `ferry install --box <name>` again when the source answers.

`--yes` skips the questions of create, of a `[host]` config change, and of the install. `--accept-host-keys` trusts the host keys of the snapshot host on the box, as for `ferry box add`.

When a step fails after the machine exists, the error names the machine and its id. Run `ferry box destroy <name>` to remove it.

### The token and the Tailscale auth key

Ferry reads each secret on this machine only, in this order:

| Secret | Environment variable | macOS keychain | Linux Secret Service |
| --- | --- | --- | --- |
| Hetzner Cloud token | `HCLOUD_TOKEN` | service `ferry`, account `hetzner` | `service ferry account hetzner` |
| Tailscale auth key | `FERRY_TAILSCALE_AUTHKEY` | service `ferry`, account `tailscale` | `service ferry account tailscale` |

Ferry reads the Secret Service only when `secret-tool` is on the `PATH`. To store the token:

```sh
security add-generic-password -s ferry -a hetzner -w            # macOS, asks for the token
secret-tool store --label=ferry service ferry account hetzner   # Linux, asks for the token
```

Create the token in the Hetzner Cloud console, in the project of the box, with read and write access. Without a Tailscale auth key, Ferry prints a login URL. Open it to add the box to your tailnet. A one-use auth key from the Tailscale admin console skips that step.

### Machine settings

The `[provider.hetzner]` table of `~/.ferry/config.toml` sets the machine:

```toml
[provider.hetzner]
server_type = "cax21"            # the default
image = "ubuntu-26.04"           # the default
location = "fsn1"                # the default
ssh_public_key = "~/.ssh/id_ed25519.pub"
```

- The default `cax21` is a shared Arm server with 4 vCPU, 8 GB memory, and 80 GB disk. The agent CLIs need more than the 4 GB of the smallest types. `--dry-run` shows the price of the type in the location.
- Without `ssh_public_key`, Ferry uses `~/.ssh/id_ed25519.pub`, then `id_ecdsa.pub`, then `id_rsa.pub`.
- Debian or Ubuntu is the tested target of `ferry install`. The pi recipe needs Node 22.19 or later from apt. Ubuntu 26.04 has it, and Ubuntu 24.04 does not.

### Destroy a box

`ferry box destroy <name>` finds the machine with the label `ferry-box=<name>`, prints the plan, and prints the projects on the box with [unsaved work](status.md#unsaved-work), as `ferry box remove --uninstall` does. When Ferry cannot reach the box, it says so in one line and continues. Then it asks you to type the box name, and does these steps:

1. It runs `tailscale logout` on the box, so the box leaves the tailnet. When that fails, Ferry warns. Then remove the machine in the Tailscale admin console.
2. It removes the machine and its firewall at Hetzner Cloud. The data on the machine is lost. When only the removal of the firewall fails, Ferry warns with the name of the firewall and continues. Then remove the firewall in the Hetzner Cloud console.
3. It removes the lines of the box from `~/.ssh/known_hosts`. Ferry removes only the lines that it added.
4. It does what `ferry box remove <name>` does on this machine. It also removes the last box.

Ferry does steps 1 and 4 only when `[box.<name>]` has the `provider_id` of the machine. Otherwise, for example after a failed create, Ferry removes only the machine and the `known_hosts` lines of the box, and keeps the box in the config. So a host that you add later with `ferry box add <name>` does not leave the tailnet and stays in the config. When the removal at Hetzner Cloud fails, the box stays in the config. `--dry-run` prints the plan and changes nothing. `--yes` skips the question. Move the projects that you need with `ferry move` first.

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

Each sync writes the paths that it linked on the box into `~/.ferry/box/identity.json`. `ferry whoami` on the box lists those paths. So the list has no path of an agent that is off for the box, and it has the paths of your custom harnesses. A box that an earlier Ferry synced has no such record until the next sync. Until then, `ferry whoami` lists the paths of the built-in harnesses that are links of Ferry on the box.

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

`ferry box remove <name> --uninstall` removes Ferry from the box first. Run it with `--dry-run` to see the plan. Ferry connects to the box, prints the projects with [unsaved work](status.md#unsaved-work) and the plan, and asks you to type the box name. Then it does these steps on the box:

1. It removes the hooks of [`ferry notify`](status.md#agent-notifications) from `~/.claude/settings.json`. The other hooks stay. Without jq on the box, the hooks stay, and they do nothing without Ferry.
2. It stops and removes each `ferry-*.service` user service, such as `ferry-paseo.service`. A stopped service stops its agents.
3. It removes each skill link, instruction file link, and root link that points into the Ferry checkout or to `~/.ferry/box/AGENTS.md`. When `ferry sync --force` moved a file of yours to `~/.ferry/backups`, Ferry moves the newest backup of that path back.
4. It removes the ferry PATH block of `~/.profile`.
5. It removes `~/.ferry/box`, `~/.ferry/exposed`, the agent events in `~/.ferry/events`, the [MCP gateway](#an-mcp-gateway-on-the-box) files and logins in `~/.ferry/mcp-gateway`, the checkout `~/.ferry/store`, the move record `~/.ferry/projects`, the Ferry binary `~/.local/bin/ferry`, and the marker `~/.ferry/box.json`.

Then Ferry removes the box from the config.

### What stays on the box

- The logins and credentials, except the MCP gateway logins, and the SSH keys
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
