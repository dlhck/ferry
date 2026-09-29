# ferry

[![CI](https://github.com/dlhck/ferry/actions/workflows/ci.yml/badge.svg)](https://github.com/dlhck/ferry/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/dlhck/ferry)](https://github.com/dlhck/ferry/releases)

<img src="https://raw.githubusercontent.com/dlhck/ferry/main/docs/menubar.png" width="401" alt="The Ferry menu bar app on macOS. It shows five items on the box fsn1 that need action: two MCP logins, and three tools with the wrong version or not on the box.">

Ferry keeps the agent setup of your machine in sync with one or more Linux boxes where remote agents run. Your machine is the source of truth. Ferry publishes your skills, `~/AGENTS.md`, Claude subagents and commands, some Claude and Codex settings, and remote MCP servers to a private git repository, the snapshot. Each box clones the snapshot and links its harness directories to it. Ferry also installs and updates the agent CLIs and your tools on each box, and starts logins there, but it never copies a login.

```
your machine ── ferry sync ──> private snapshot repo ──> box a, box b, ...
                                                         (pull and link over SSH or Tailscale)
```

## Install

On the operator machine (macOS or Linux, arm64 or x64):

```sh
curl -fsSL https://raw.githubusercontent.com/dlhck/ferry/main/install.sh | sh
```

Or with npm. Do not use `--omit=optional`, because the executable comes from an optional dependency:

```sh
npm i -g @dlhck/ferry
```

To update Ferry, run `ferry self-update`. It restarts installed watch and tunnel services that use the updated Ferry. On macOS, it also updates an installed release menu bar app. It leaves a service that uses another Ferry unchanged. On a terminal, Ferry also asks to update when a newer release is there. It checks at most once a day, and never with `--json`, with `CI` set, or with `FERRY_NO_UPDATE_CHECK=1`. `install.sh` lists its environment variables, such as `FERRY_VERSION`, at the top of the file.

You also need:

- A Linux box that you can reach with SSH, with `curl` or `wget`. Debian or Ubuntu is the tested target.
- Tailscale on both machines, or an OpenSSH destination such as `user@box.example`.
- An empty private git repository for the snapshot, and for an SSH URL, an SSH agent with a key that can push to it.

## Quick start

```sh
ferry init --ssh-destination user@box.example \
  --snapshot-url git@github.com:you/ferry-snapshot.git
ferry install        # gh, the agent CLIs, your tools, and Ferry on the box
ferry sync           # publish the snapshot and apply it on the box
ferry auth claude    # start a login on the box, finish it in a browser here
ferry watch install  # sync each change automatically, as a user service
ferry status         # check the link, the snapshot, the logins, and the tools
```

Use `--host <tailscale host> --ssh-user <user>` instead of `--ssh-destination` for a Tailscale box. Without flags, `ferry init` asks. Add `--dry-run` to `init`, `sync`, `update`, or `move` to see the plan first.

## Commands

| Command | What it does |
| --- | --- |
| `ferry init` | Record the first box and the snapshot URL, seed the snapshot, and link this machine. |
| `ferry box list\|add\|remove\|default` | Manage several boxes and the default box. |
| `ferry install` | Install gh, the agent CLIs, the tools of the config, and Ferry on a box. |
| `ferry sync` | Publish the snapshot and apply it on all boxes, or on the boxes of `--box`. |
| `ferry watch` | Sync each accepted change. `ferry watch install` runs it as a launchd or systemd user service. |
| `ferry status` | Show the state of the snapshot and of each box. `--brief` shows only what needs action: offline boxes, logins, MCP logins, and tool drift. |
| `ferry menubar install\|uninstall` | On macOS, install a menu bar app that shows the report of `ferry status --brief` for each box. The app reads `~/.ferry/status.json`, so `ferry watch` must run. It also shows the ports of each running `ferry tunnel --follow`. |
| `ferry auth <tool>` | Start a login for `gh`, `claude`, `codex`, `cursor`, or a config tool with login keys on the box. `--mcp <server>` logs in to an MCP server. `--mcp <tool>/<server>`, the name in `ferry status`, also works. |
| `ferry update` | Update the agent tools on the boxes and on this machine. |
| `ferry tools` | List the tools and their version policies. |
| `ferry self-update` | Update Ferry on this machine, restart its installed user services, and update its release menu bar app. |
| `ferry skills add` | Install skills with `npx skills add` as a global copy, so that Ferry carries them. |
| `ferry move <path>` | Continue a project on a box, back on this machine, or on another box. |
| `ferry tunnel` | Open box ports on `127.0.0.1` of this machine. `ferry tunnel install` runs `--follow` for one box as a user service. |
| `ferry expose` | On the box: run a dev server and announce its port to `ferry tunnel --follow`. |
| `ferry integrations` | List, enable, or disable the Paseo integration of a box. |
| `ferry uninstall` | Remove Ferry from this machine and restore the paths that `init` changed. |

`ferry <command> --help` has the options, the config formats, and the details of each command.

Add `--json` to any command for scripts and agents: stdout then has only JSON, and Ferry asks nothing. `ferry --help` describes the output.

## Security model

- Logins, credential files, tokens, API keys, `.env` files, and whole settings files never leave the machine that has them. A login starts on the box, and its token stays there.
- Before each publish, Ferry checks the carried files against deny rules: secret file names, private keys, token content, secret keys in JSON, YAML, and TOML, and executables. A match stops the sync. The error names the file, never the value.
- Ferry forwards your SSH agent to a box only for the snapshot checks and updates and for the Claude plugin installs. A box with `git_auth = "box"` gets no agent and reads the snapshot with its own read-only deploy key. See `ferry box add --help`.
- Boxes do not trust each other. Ferry connects to each box from your machine. `ferry move` between two boxes goes through your machine, with the same deny rules.
- Ferry opens no public port and never turns off SSH host-key checks. It runs commands with your SSH user, so use a box and a user that you trust with the agents that run there.

## Features

- **Several boxes.** `ferry box add <name>` adds a `[box.<name>]` table. `sync`, `status`, and `update` work on all boxes, or on the boxes of `--box`. See `ferry box --help`.
- **Tools in config.** Define each tool in a `[tools.<id>]` table, with a version policy of `"operator"`, `"latest"`, or an exact version. The `auth_status`, `auth_login`, and `auth_hosts` keys let `ferry auth <id>` log the tool in. See `ferry tools --help`.
- **Move a project.** `ferry move <path> --to-box <name>` and `--from-box <name>` carry a git project, with its untracked files, between machines. See `ferry move --help`.
- **Box ports.** `ferry tunnel 3000` opens a box port here. `ferry expose` on the box and `ferry tunnel --follow` here open each dev server port on its own. `--follow` writes its forwards to `~/.ferry/tunnels/<box>.json` (`schemaVersion`, `box`, `pid`, `connected`, `updatedAt`, `forwards: [{ name, cwd, boxPort, localPort }]`), and removes the file when it stops. The menu bar app reads it. See `ferry tunnel --help` and `ferry expose --help`.
- **Paseo.** `ferry integrations enable paseo` runs the Paseo daemon on a box and carries your Paseo agent profiles, managed Git plugins at their installed commits, metadata model preferences, and shared system instructions. Plugin settings and credentials stay on each host. See [Paseo sync](docs/paseo-sync.md) for supported sources, limitations, and other sync candidates, and `ferry integrations enable --help`.
- **Automatic sync.** `ferry watch install` syncs each change after one second. With `[update] watch = true`, it also updates the tools with the `"latest"` policy once a day. Every 5 minutes and after each sync, the watch writes `ferry status --brief --json` to `~/.ferry/status.json`. See `ferry watch install --help` and `ferry update --help`.

### Paseo relay

To use relay pairing, set this in `~/.ferry/config.toml` on the operator machine:

```toml
[integrations]
paseo = true
paseo_relay = true
```

The relay is off by default. Set `paseo_relay` in `[box.<name>.integrations]` to override it for one box. Run `ferry integrations enable paseo --box <name>` to apply the setting, including changes to an existing service. Omit `--box` for a single box. A changed service config restarts the daemon and stops its agents. Sync and updates preserve the applied relay setting.

## Agent skill

The [`skills/ferry`](skills/ferry/SKILL.md) skill tells agents how to work with Ferry on both machines, for example not to edit a Ferry-managed file on the box. Install it on this machine, then run `ferry sync`:

```sh
ferry skills add dlhck/ferry --skill ferry
```

## Development

Ferry needs [bun](https://bun.sh) 1.4 or later.

```sh
bun install
bun test
bun run typecheck
bun run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [RELEASING.md](RELEASING.md), and [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
