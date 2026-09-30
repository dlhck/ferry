<a href="https://dlhck.github.io/ferry/"><img src="https://raw.githubusercontent.com/dlhck/ferry/main/docs/readme-hero.png" alt="An illustration of Ferry. A ferry carries crates labelled skills, AGENTS.md, subagents, commands, settings, MCP and Paseo from your machine to three boxes. A key stays ashore behind the deny rules barrier."></a>

# ferry

[![CI](https://github.com/dlhck/ferry/actions/workflows/ci.yml/badge.svg)](https://github.com/dlhck/ferry/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/dlhck/ferry)](https://github.com/dlhck/ferry/releases)

Ferry keeps the agent setup of your machine in sync with one or more Linux boxes where remote agents run. Your machine is the source of truth. Ferry publishes your skills, `~/AGENTS.md`, Claude subagents, commands, and hook scripts (`~/.claude/hooks`), some Claude, Codex, Pi, and Cursor Agent settings, and remote and stdio MCP servers to a private git repository, the snapshot. Each box clones the snapshot and links its harness directories to it. Ferry also installs and updates the agent CLIs and your tools on each box, and starts logins there, but it never copies a login.

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
ferry install        # gh, jq, the agent CLIs, your tools, and Ferry on the box
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
| `ferry box list\|add\|remove\|default` | Manage several boxes and the default box. `ferry box remove <name> --uninstall` removes Ferry from the box first. `--dry-run` shows the plan. |
| `ferry install` | Install gh, jq, the agent CLIs, the tools of the config, and Ferry on a box. |
| `ferry sync` | Publish the snapshot and apply it on all boxes, or on the boxes of `--box`. |
| `ferry history` | List the last 20 snapshot commits and the paths each one changed. |
| `ferry revert <commit>` | Undo one snapshot commit on this machine, including the carried settings keys, then sync all boxes. `--no-sync` skips the sync. `--dry-run` shows the plan. |
| `ferry watch` | Sync each accepted change. `ferry watch install` runs it as a launchd or systemd user service. |
| `ferry status` | Show the state of the snapshot and of each box. `--brief` shows only what needs action: offline boxes, low disk or memory on a box, logins, MCP logins, stdio MCP servers that lack something on the box, tool drift, and hooks that run a home file Ferry does not carry. |
| `ferry doctor` | Check the SSH agent, push access to the snapshot, SSH and Tailscale to each box, the box deploy key, linger, and the installed services. It changes nothing, runs every check, and prints a fix for each failed check. |
| `ferry menubar install\|uninstall` | On macOS, install a menu bar app that shows the report of `ferry status --brief` for each box. The app reads `~/.ferry/status.json`, so `ferry watch` must run. It also shows the ports of each running `ferry tunnel --follow`. It sends a macOS notification when a box goes offline, a login or MCP login needs a login, or a tool has drift. Turn off Notifications in the menu to stop them. Sync now runs `ferry sync`. On Linux, see [the waybar module](docs/linux-status-bar.md). |
| `ferry auth <tool>` | Start a login for `gh`, `claude`, `codex`, `cursor`, or a config tool with login keys on the box. `--mcp <server>` logs in to an MCP server. `--mcp <tool>/<server>`, the name in `ferry status`, also works. |
| `ferry update` | Update the agent tools on the boxes and on this machine. |
| `ferry tools` | List the tools and their version policies. |
| `ferry self-update` | Update Ferry on this machine, restart its installed user services, and update its release menu bar app. |
| `ferry skills add` | Install skills with `npx skills add` as a global copy, so that Ferry carries them. |
| `ferry adopt --from-box <name> <skill>` | Copy a skill that an agent wrote on a box to this machine. Ferry runs the deny rules and shows the diff or the file list before it asks. Then run `ferry sync` to publish it to all boxes. `ferry status` lists the box-only skills. |
| `ferry move <path>` | Continue a project on a box, back on this machine, or on another box. |
| `ferry tunnel` | Open box ports, or ports of a host that the box can reach, on `127.0.0.1` of this machine. `ferry tunnel install` runs `--follow` for one box as a user service. |
| `ferry expose` | On the box: run a dev server and announce its port to `ferry tunnel --follow`. |
| `ferry whoami` | Print the role of this machine (operator machine or box), the box name, and the paths that Ferry manages. On a box, it also prints the parts of the merged instruction file. It also runs on a box. |
| `ferry integrations` | List, enable, or disable the Paseo and Sherlock integrations. The list shows the part of each integration: `box` for a box service, `operator` for commands and status checks on this machine. |
| `ferry uninstall` | Remove Ferry from this machine and restore the paths that `init` changed. |

`ferry <command> --help` has the options, the config formats, and the details of each command.

Add `--json` to any command for scripts and agents: stdout then has only JSON, and Ferry asks nothing. `ferry --help` describes the output.

## Security model

- Logins, credential files, tokens, API keys, `.env` files, and whole settings files never leave the machine that has them. A login starts on the box, and its token stays there.
- Before each publish, Ferry checks the carried files against deny rules: secret file names, private keys, token content, secret keys in JSON, YAML, and TOML, and executable binaries (ELF, Mach-O, and PE). Scripts, such as hook scripts, pass and keep their executable bit. A match stops the sync. The error names the file, never the value.
- A per-box instruction file, `~/.ferry/boxes/<name>/AGENTS.md`, gets the same deny rules as `~/AGENTS.md`, and the private key rule. It never goes into the snapshot. Ferry sends it to its box on the standard input of an SSH command, so the text is not in a command line. A match stops the sync of that box only.
- Ferry merges the carried settings keys and MCP servers into the box files on the box: with jq for JSON files and with awk for the Codex `config.toml`. The box sends back only a status, never the file. Without jq on the box, Ferry leaves a JSON file as it is and tells you to run `ferry update`.
- For a stdio MCP server, Ferry carries the command, the arguments, and the names of the `env` keys, never their values. Set the values in the `env` of the server on the box. Ferry keeps them: the box merges its own entry with jq or the agent CLI, and sends back only a status or key names, never a value. A command or an argument stops the sync when it has a token, a secret flag with a value, or a URL with a user, a password, or a secret query parameter. An inline script for a shell or an interpreter, such as `sh -c`, `node -e`, or `python -c`, also stops the sync, because Ferry cannot check it. Use a command on the PATH, and set secrets in the `env` of the server. The error names the server and the rule, never the value. Ferry does not carry a server whose command or arguments refer to a path in your home, as an absolute path, `~`, `$HOME`, or `${HOME}`, and it never installs a command. `ferry status --brief` names each missing env key, each command that is not on the box, and each server that Ferry did not carry.
- Ferry forwards your SSH agent to a box only for the snapshot checks and updates and for the Claude plugin installs. A box with `git_auth = "box"` gets no agent and reads the snapshot with its own read-only deploy key. See `ferry box add --help`.
- Boxes do not trust each other. Ferry connects to each box from your machine. `ferry move` between two boxes goes through your machine, with the same deny rules.
- Ferry opens no public port and never turns off SSH host-key checks. It runs commands with your SSH user, so use a box and a user that you trust with the agents that run there.

## Features

- **Several boxes.** `ferry box add <name>` adds a `[box.<name>]` table and creates the empty per-box instruction file `~/.ferry/boxes/<name>/AGENTS.md`. `sync`, `status`, and `update` work on all boxes, or on the boxes of `--box`. See `ferry box --help`.
- **Remove Ferry from a box.** `ferry box remove <name> --uninstall` connects to the box, prints the plan, and asks you to type the box name. On the box, it stops and removes the `ferry-*.service` user services, such as `ferry-paseo.service`. It removes each skill link, instruction file link, and root link that points into the Ferry checkout or to `~/.ferry/box/AGENTS.md`. When `ferry sync --force` moved a file of yours to `~/.ferry/backups`, Ferry moves the newest backup of that path back. It removes the ferry PATH block of `~/.profile`, `~/.ferry/box`, `~/.ferry/exposed`, the checkout `~/.ferry/store`, the Ferry binary `~/.local/bin/ferry`, and the marker `~/.ferry/box.json`. Then it removes the box from the config. These stay on the box: the logins and credentials, the SSH keys, the project directories, `~/.paseo`, the tools that Ferry installed (`gh`, `jq`, the agent CLIs, the Paseo CLI, and the tools of the config), the settings keys, MCP servers, and plugins that sync merged into the config files of the box, `~/.ferry/trash`, and each backup that Ferry did not move back. When Ferry cannot reach the box, or a box step fails, the box stays in the config. `ferry box remove <name>` without the flag does not connect to the box, and it refuses the last box. See `ferry box remove --help`.
- **Remove Ferry from your only box.** `ferry box remove <name> --uninstall` also removes the last box. For a `[host]` config, the box name is `default`. The same rules apply: Ferry prints the plan, asks you to type the box name, and keeps the credentials and the projects on the box. After the removal, the config has no `[host]` table and no `[box.<name>]` table. The rest of the config stays. `ferry sync`, `ferry status`, `ferry install`, and `ferry watch` then fail with `Ferry config has no box. Add a box with ferry box add <name>.` `ferry box list` shows no box. To use Ferry again, run `ferry box add <name>`, or `ferry init`, which adds a `[host]` table and keeps the rest of the config.
- **What `ferry box remove` does on your machine.** With and without `--uninstall`, it stops and removes the tunnel user service of the box, which `ferry tunnel install` wrote. Your per-box instruction file `~/.ferry/boxes/<name>/AGENTS.md` stays, and Ferry prints its path. A later box with the same name gets its text, so delete the file when you do not need it. With `--uninstall`, Ferry holds the sync lock of the box from before it connects until the box is out of the config. During that time, a sync that includes the box fails with `sync-busy`, also a sync of `ferry watch`, so no sync can write the links on the box again. The watch syncs again later. When a sync for the box runs, the command fails with `sync-busy` and changes nothing.
- **Tools in config.** Define each tool in a `[tools.<id>]` table, with a version policy of `"operator"`, `"latest"`, or an exact version. The `auth_status`, `auth_login`, and `auth_hosts` keys let `ferry auth <id>` log the tool in. See `ferry tools --help`.
- **Move a project.** `ferry move <path> --to-box <name>` and `--from-box <name>` carry a git project, with its untracked files, between machines. It also carries the Claude and Codex sessions of the project and the Claude project memory, so `claude --resume` and `codex resume` find them on the destination. `--no-sessions` turns this off. A session that fails the deny rules stays on the source. See `ferry move --help`.
- **Box ports.** `ferry tunnel 3000` opens a box port here. `ferry tunnel db.example:5432:15432` opens port 5432 of a host that the box can reach, such as a database that accepts connections only from the box network, on local port 15432. The box resolves the host name. Put an IPv6 address in brackets, such as `[fd00::1]:5432`. `ferry expose` on the box and `ferry tunnel --follow` here open each dev server port on its own. `--follow` writes its forwards to `~/.ferry/tunnels/<box>.json` (`schemaVersion`, `box`, `pid`, `connected`, `updatedAt`, `forwards: [{ name, cwd, boxPort, localPort }]`), and removes the file when it stops. The menu bar app reads it. See `ferry tunnel --help` and `ferry expose --help`.
- **Paseo.** `ferry integrations enable paseo` runs the Paseo daemon on a box and carries your Paseo agent profiles, managed Git plugins at their installed commits, npm plugins at their installed versions, the portable fields of your Paseo provider definitions, metadata model preferences, shared system instructions, and portable terminal profiles. With `paseo_auto_archive = true` in `[integrations]` or `[box.<name>.integrations]`, it also carries the Paseo auto-archive-after-merge switch. When it carries an enabled plugin, Ferry also turns on the box's global plugin switch. When `ferry move` puts a project on a box with Paseo, Ferry registers the project in Paseo and imports each carried session as a Paseo agent. It skips a session that already has an agent on the box. When `ferry move --from-box` puts a project back on this machine, Ferry does the same in the local Paseo. For this, it uses the `paseo` command on the PATH, else the CLI of the Paseo desktop app. When this machine has no `paseo` command, or an import fails, the move prints a warning and completes. Plugin settings, provider env blocks, provider commands, terminal profile env blocks and paths, and credentials stay on each host. The box merges the carried values into its `~/.paseo/config.json` with jq and sends back only a status, never the file. Without jq on the box, Ferry leaves the file as it is and tells you to run `ferry update`. Plugin installs and updates also need jq on the box, because the box compares its plugin list with jq. See [Paseo sync](docs/paseo-sync.md) for supported sources, limitations, and other sync candidates, and `ferry integrations enable --help`.
- **Sherlock.** With [Sherlock](https://github.com/michaelbromley/sherlock) on this machine, `ferry integrations enable sherlock` adds `ferry sherlock add <name> --box <box> --target <host:port> --type <type>`. It runs `sherlock connection add` with `--tunnel-command "ferry tunnel --box <box> <target>:{{port}}"`, so Sherlock queries a database on the box, or one that only the box can reach, through a tunnel that it opens on the first query. Sherlock stores the password in the keychain of this machine. Ferry never stores it and never edits the Sherlock config. Ferry records the name, box, and target in `~/.ferry/sherlock.json`, and `ferry status` checks that each box can reach its target. `ferry` must be on the PATH that Sherlock uses. See `ferry sherlock add --help`.
- **Box awareness.** On each sync, a box gets `~/.ferry/box/AGENTS.md`. The instruction files of the box link to it. Your machine does not change. Agents run `ferry whoami` to check where they are. Ferry merges the file from three parts, in this order, with one blank line between them:
  1. The Ferry header. It names the box and tells agents not to run `ferry sync` or edit Ferry-managed files there.
  2. The per-box instructions, from `~/.ferry/boxes/<name>/AGENTS.md` on your machine. Only the box `<name>` gets them. A `[host]` config has one box with the name `default`. A missing or empty file adds nothing.
  3. The shared instructions, your `~/AGENTS.md`, byte for byte.
- **Per-box instructions.** Write the instructions for one box in `~/.ferry/boxes/<name>/AGENTS.md` on your machine, for example "this box runs the staging database". `ferry box add` creates the file empty and prints its path. `ferry init` does not create it, so create it by hand for your first box. Then run `ferry sync`. Never edit `~/.ferry/box/AGENTS.md` on the box: each sync writes it again. A box gets an instruction file only when you have a `~/AGENTS.md`. Without one, Ferry warns and does not apply the per-box file.
- **Automatic sync.** `ferry watch install` syncs each change after one second. A change to a per-box instruction file syncs only its box, and publishes nothing. With `[update] watch = true`, it also updates the tools with the `"latest"` policy once a day. Every 5 minutes and after each sync, the watch writes `ferry status --brief --json` to `~/.ferry/status.json`. That report has the free disk, memory, and load of each box. `--brief` shows an item when the free disk of the box home is below both 10% and 5 GiB, or the available memory is below 10%. Set other limits with `disk_free_percent`, `disk_free_gib`, and `memory_available_percent` in `[status]`. A limit of 0 turns its part of the check off. When one disk limit is 0, the other decides. See `ferry watch install --help` and `ferry update --help`.

### Paseo relay

To use relay pairing, set this in `~/.ferry/config.toml` on the operator machine:

```toml
[integrations]
paseo = true
paseo_relay = true
```

The relay is off by default. Set `paseo_relay` in `[box.<name>.integrations]` to override it for one box. Run `ferry integrations enable paseo --box <name>` to apply the setting, including changes to an existing service. Omit `--box` for a single box. A changed service config restarts the daemon and stops its agents. Sync and updates preserve the applied relay setting.

## Agent skill

The [`skills/ferry`](skills/ferry/SKILL.md) skill tells agents how to work with Ferry on both machines, for example not to edit a Ferry-managed file on the box. Each Ferry build has the skill of its version, so Ferry installs it without network access.

- `ferry init` writes the skill to `~/.agents/skills/ferry`. The snapshot carries it to the boxes.
- `ferry self-update` writes the skill of the new version. Existing installs get the skill at their next self-update.
- If the skill folder has local changes, or another tool wrote it, Ferry does not change it and prints a note. To get the bundled skill again, remove the folder and run `ferry self-update` or `ferry init`.
- `ferry init --no-skill` does not install the skill. Ferry records the choice in `~/.ferry/skill.json`, and `ferry self-update` then skips the skill too. Run `ferry init` without the flag to turn the skill on again.

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
