# ferry

[![CI](https://github.com/dlhck/ferry/actions/workflows/ci.yml/badge.svg)](https://github.com/dlhck/ferry/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/dlhck/ferry)](https://github.com/dlhck/ferry/releases)

```mermaid
flowchart LR
    subgraph laptop["💻 Your machine · source of truth"]
        direction TB
        set["🧰 skills<br/>AGENTS.md<br/>Claude agents + commands<br/>settings allowlist<br/>remote MCP servers"]
        vault["🔐 logins and tokens<br/>never leave"]
    end

    snap[("📦 private snapshot repo")]

    subgraph fleet["☁️ Linux agent boxes"]
        direction TB
        b1["🖥️ build-box<br/>claude · codex<br/>pi · cursor"]
        b2["🖥️ gpu-box<br/>claude · codex<br/>pi · cursor"]
        b3["🖥️ lab-box<br/>claude · codex<br/>pi · cursor"]
    end

    set == "ferry sync<br/>commit + push" ==> snap
    snap ==> b1
    snap == "pull + symlink<br/>over SSH or Tailscale" ==> b2
    snap ==> b3
    laptop -. "ferry auth<br/>login starts on the box,<br/>you finish it in a browser" .-> fleet

    classDef source fill:#1f6feb,stroke:#1f6feb,color:#fff
    classDef secret fill:#da3633,stroke:#da3633,color:#fff
    classDef repo fill:#8957e5,stroke:#8957e5,color:#fff
    classDef box fill:#238636,stroke:#238636,color:#fff
    class set source
    class vault secret
    class snap repo
    class b1,b2,b3 box
```

Ferry keeps a remote Linux agent box in the same shape as the machine you work on. Your machine is the source of truth. A private git repository holds the skills, the one global instruction file, the Claude subagents and commands, and the Claude plugin declarations. Both machines clone that repository and point their harness directories at the clone with symlinks. Ferry uses Tailscale by default and also accepts an explicit OpenSSH destination for local machines and existing SSH configurations.

Ferry never copies logins. OAuth sessions stay on the machine that created them. Ferry starts a vendor login on the box and you finish it in a browser here.

## Requirements

- An operator machine with macOS or Linux. Ferry runs here. Windows is not supported.
- A Linux box that you can reach with SSH. The box does not run Ferry. `ferry install` and `ferry update` use `apt` for `gh`, so Debian or Ubuntu is the tested target.
- Tailscale on both machines, or one OpenSSH destination such as `user@box.example`.
- An empty private git repository for the snapshot, for example `git@github.com:you/ferry-snapshot.git`. Ferry does not create it.
- For an SSH snapshot URL, an SSH agent on the operator machine with a loaded key that can read and push the snapshot repository.
- [bun](https://bun.sh) 1.4 or later, to install from source.

## Install

Install Ferry on the operator machine. The box does not need Ferry, but you can install it there too.

```sh
curl -fsSL https://raw.githubusercontent.com/dlhck/ferry/main/install.sh | sh
```

The script downloads the standalone executable for your platform from the latest GitHub release, verifies it against the `SHA256SUMS` file of the release, and installs it to `~/.local/bin/ferry`. It supports macOS and Linux on arm64 or x64. It needs `curl` or `wget`, and `sha256sum` or `shasum`. If `~/.local/bin` is not on your `PATH`, the script tells you the line to add to your shell profile.

Run the same command again to update Ferry. The watch service keeps the old executable until it restarts, so restart it after an update: `launchctl kickstart -k gui/$(id -u)/dev.ferry.watch` on macOS, or `systemctl --user restart ferry-watch.service` on Linux.

Set these variables to change the install:

- `FERRY_VERSION` installs a specific release, for example `curl -fsSL https://raw.githubusercontent.com/dlhck/ferry/main/install.sh | FERRY_VERSION=v0.2.0 sh`.
- `FERRY_INSTALL_DIR` installs to a different directory.
- `FERRY_SKIP_CHECKSUM=1` installs a release that has no `SHA256SUMS` file, v0.1.1 or earlier. The script then does not verify the download.

With npm:

```sh
npm i -g @dlhck/ferry
```

The package runs a prebuilt executable for macOS or Linux on arm64 or x64. You do not need bun. npm installs only the executable for your platform, from the optional dependency `@dlhck/ferry-<os>-<arch>`. Do not install with `--omit=optional`.

To update Ferry itself, run `npm i -g @dlhck/ferry@latest`. `ferry update` updates the agent tools, not Ferry. The watch service keeps the same executable path, so restart it after an update: `launchctl kickstart -k gui/$(id -u)/dev.ferry.watch` on macOS, or `systemctl --user restart ferry-watch.service` on Linux.

From source:

```sh
git clone https://github.com/dlhck/ferry.git
cd ferry
bun install
bun link
```

`bun link` puts `ferry` on your `PATH`. It runs `src/cli.ts` with bun.

The release workflow attaches standalone executables to each GitHub release: `ferry-darwin-arm64`, `ferry-darwin-x64`, `ferry-linux-arm64`, and `ferry-linux-x64`, with their checksums in `SHA256SUMS`. These executables do not need bun. To install one without the script, download the file for your platform, make it executable, and move it to a directory on your `PATH`:

```sh
chmod +x ferry-darwin-arm64
mv ferry-darwin-arm64 ~/.local/bin/ferry
```

## Quick start

```sh
ferry init          # record the box and the snapshot URL, seed the snapshot, link this machine
ferry install       # install gh, the agent CLIs, and the tools that you define on the box
ferry sync          # publish the snapshot and apply it on the box
ferry auth gh       # start a login on the box, finish it in a browser here
ferry auth claude
ferry status        # check the link, the snapshot, the managed paths, and the box logins
```

`ferry install` shows the plan for each tool and asks for confirmation before it runs a command on the box. Repeat `ferry auth` for each tool that you use. Add `--dry-run` to `init`, `sync`, or `update` to see the changes before Ferry makes them.

## Security model

Ferry carries skills, `~/AGENTS.md`, the Claude subagents and commands, an allowlist of Claude settings keys, and the name and HTTPS URL of each remote MCP server. [What Ferry carries](#what-ferry-carries) has the full list.

Ferry never carries:

- credential files, OAuth sessions, or Keychain items;
- tokens, API keys, or MCP tokens and request headers;
- settings keys that can hold secrets, such as `env` and `apiKeyHelper`;
- local MCP servers, which have a `command`, `args`, or `env`;
- session history, caches, databases, or whole settings files.

A carried file that looks like a secret stops the sync, and the error names the file, never the value. Logins happen on the box, and the tokens stay there.

Ferry opens no public listening port. The Codex callback login forwards local port 1455 to the box for 120 seconds. `ferry tunnel` binds its local ports to `127.0.0.1` only. Ferry never turns off SSH host-key checks, and it never falls back from Tailscale to direct SSH. Ferry forwards your SSH agent to the box only for the snapshot update. `ferry auth gh` creates an SSH key without a passphrase on the box and adds it to your GitHub account, so agents on the box can push. See [GitHub over SSH](#github-over-ssh).

Ferry runs commands on the box with your SSH user. Use a box and an SSH user that you trust with the agents that run there.

## Usage

`ferry init` asks whether to use a Tailscale host or an SSH-only destination. SSH-only never runs Tailscale.

Use a Tailscale peer:

```sh
ferry init \
  --host build-box \
  --ssh-user ferry \
  --snapshot-url git@github.com:you/ferry-snapshot.git
```

Or use an explicit OpenSSH destination:

```sh
ferry init \
  --ssh-destination user@box.example \
  --snapshot-url git@github.com:you/ferry-snapshot.git
```

Ferry never falls back from Tailscale to direct SSH. The selected transport is stored in `~/.ferry/config.toml`.

An SSH snapshot URL requires a loaded identity in the operator's SSH agent. During `ferry init`, Ferry checks the agent, forwards it to the box, and tests read access to the snapshot repository. If the Git host is not in the box's `known_hosts`, Ferry prints the host-key fingerprints and asks for approval before it adds the public host keys. The operator's private key stays on the operator machine.

Add `--dry-run` to inspect the SSH probe, snapshot publish, config write, and managed symlinks without connecting to the box or changing the local filesystem.

Run `ferry uninstall` to remove the local store and config, remove Ferry-managed symlinks, and restore the paths that existed before the first `ferry init`. The command refuses to write if a managed symlink was replaced with local content. Backups from older Ferry versions are restored when Ferry can identify one unambiguous backup for a managed path. The command asks for confirmation first. Add `--yes` to skip the prompt.

### Progress

`ferry init`, `sync`, `status`, `install`, `auth`, `update`, and `move` show the current step on stderr, for example `Publishing the snapshot` or `Installing Claude plugins (3/10)`. When stdout and stderr are both terminals, Ferry rewrites one line in place, with a spinner, the step number, and the step name:

```
◐ [6/9] Installing Claude plugins (3/10)
```

A finished step leaves no line. When the command ends, also after an error, Ferry prints a summary table with the result, a short detail, and the duration of each step. The command's own lines, such as `Skipped hook:`, `Box plugins:`, or the status report, come after the table. Lines that a prompt needs, such as the install plan before the confirmation, come before the prompt. `ferry auth` shows the live line for its wait, but prints no table.

```
Step                              Result     Detail               Time
Reading the portable set          ✔ done     14 skills            0.2s
Connecting to user@box.example    ✔ done                          0.9s
Publishing the snapshot           ✔ done     published 3f2a9c1    2.1s
Updating the box checkout         ✔ done                          1.4s
Applying the snapshot on the box  ✔ done     2 changes            1.8s
Installing Claude plugins         ✔ done     1 warning             12s
Merging settings on the box       ✔ done                          0.6s
Declaring MCP servers             ✔ done     4 servers            3.3s
Adopting published local skills   ✔ done                          0.0s
```

In other cases, Ferry writes one plain line when a step starts or its count changes, with no control characters and no table. `ferry watch` always writes plain lines, so its log stays readable. `ferry status --json` shows no progress, and its stdout is only the JSON report.

### Status

`ferry status` reads the local store, the git remote, and each box. It does not change a machine. It checks at most 4 boxes at the same time. An offline box shows `unavailable` lines and does not stop the other boxes.

The text output has a shared block first: the local and remote store tips and the deny list. Then it has one block for each box, in config order, with the header `Box <name> (<destination>)`. A box block shows only the integrations that are on for that box. With a `[host]` config, the one box has the name `default`. The `Git auth` line of a box shows `AGENT` or `BOX`. See [Git auth for each box](#git-auth-for-each-box).

With more than one box, each progress step starts with the box name, for example `[a] Checking logins on the box`. The summary table has one row for each box and step, grouped by box.

`ferry status --json` prints schema version 2, also for one box. The shared part is at the top. The `boxes` array has one entry for each box, in config order:

```json
{
  "schemaVersion": 2,
  "store": { "local": "1a2b3c4", "remote": "1a2b3c4", "localMatchesRemote": true, "error": null },
  "operator": { "gitIdentity": { "name": "Operator", "email": "operator@example.com" }, "error": null },
  "denyList": [{ "code": "dotenv", "description": "environment file", "behavior": "refuse" }],
  "boxes": [
    {
      "name": "a",
      "host": "dev@box-a.example",
      "gitAuth": "agent",
      "link": { "online": true, "address": "100.64.0.1", "error": null },
      "tip": "1a2b3c4",
      "remoteMatchesBox": true,
      "allMatch": true,
      "boxCheckout": { "dirty": false, "changes": [], "error": null },
      "gitIdentity": {
        "box": { "name": "Operator", "email": "operator@example.com" },
        "boxConfigured": true,
        "matchesOperator": true,
        "error": null
      },
      "boxSudo": { "passwordless": true, "watchUpdateBlocked": false, "error": null },
      "managedPaths": { "allHealthy": true, "unhealthy": [], "error": null },
      "auth": { "providers": [{ "provider": "gh", "status": "authenticated" }], "loginRequired": [], "error": null },
      "mcpLogins": { "loginRequired": [], "error": null },
      "tools": [
        { "id": "gh", "mode": "mirror", "policy": "operator", "operator": "2.92.0", "target": "2.92.0", "box": "2.92.0", "state": "ok" },
        { "id": "claude", "mode": "always", "policy": "latest", "operator": "2.1.0", "target": null, "box": "2.1.0", "state": "ok" }
      ],
      "errors": []
    },
    {
      "name": "b",
      "host": "dev@box-b.example",
      "link": {
        "online": false,
        "address": null,
        "error": { "code": "host-offline", "origin": "network", "message": "Tailscale host box-b is offline" }
      },
      "tip": null,
      "remoteMatchesBox": false,
      "allMatch": false,
      "boxCheckout": { "dirty": null, "changes": [], "error": null },
      "gitIdentity": { "box": null, "boxConfigured": null, "matchesOperator": null, "error": null },
      "boxSudo": { "passwordless": null, "watchUpdateBlocked": false, "error": null },
      "managedPaths": { "allHealthy": null, "unhealthy": [], "error": null },
      "auth": { "providers": [], "loginRequired": [], "error": null },
      "mcpLogins": { "loginRequired": [], "error": null },
      "tools": [
        { "id": "gh", "mode": "mirror", "policy": "operator", "operator": "2.92.0", "target": "2.92.0", "box": null, "state": "unknown", "reason": "host offline" },
        { "id": "claude", "mode": "always", "policy": "latest", "operator": "2.1.0", "target": null, "box": null, "state": "unknown", "reason": "host offline" }
      ],
      "errors": [{ "code": "host-offline", "origin": "network", "message": "Tailscale host box-b is offline" }]
    }
  ],
  "errors": []
}
```

`host` is the SSH destination, or `<ssh_user>@<tailscale host>` for a Tailscale box. The top-level `errors` has only the operator and git remote errors. Each box has its own `errors`. A box entry has `integrations` only when an integration is on for that box.

#### Tools in status

Each box block has a `Tools` part with one row for each tool in the registry: the built-in tools and each `[tools.<id>]` table. A row shows the policy of the tool for that box, the version on this machine, the target version, the version on the box, and a state. Ferry does not read your projects to find tools.

```
Tools:
  gh      operator  operator 2.92.0   target 2.92.0   box 2.92.0   ok
  claude  latest    operator 2.1.0    target latest   box 2.1.0    ok
  bun     operator  operator 1.4.2    target 1.4.2    box 1.4.2    ok
  node    operator  operator 24.16.0  target 24.16.0  box 22.22.1  DRIFT
  pnpm    operator  operator 11.17.0  target 11.17.0  box -        MISSING
  uv      operator  operator 0.9.2    target 0.9.2    box 0.9.2    HIDDEN
  go      operator  operator -        target -        box 1.22.7   skipped (not on the operator machine)
  docker  operator  operator 29.4.0   target 29.4.0   box -        unknown (no box version command)
  WARNING: node is 22.22.1 on the box, and the target is 24.16.0. Run ferry update.
  WARNING: pnpm is not on the box. Run ferry install.
  WARNING: uv: the login shell PATH does not find it. Run ferry sync to write the PATH block of ~/.profile.
```

The target comes from the policy, with the same rules as `ferry install`. Ferry reads the version on this machine one time and uses it for all boxes. The states are:

| State | Meaning | What to do |
|---|---|---|
| `ok` | The box has the target version. For the `latest` policy, the box has the tool. | Nothing. |
| `drift` | The box has another version. | `ferry update` |
| `missing` | The box does not have the tool. | `ferry install` |
| `hidden` | The box has the tool, but a login shell on the box does not find the same version. The ferry block of `~/.profile` is missing or old. | `ferry sync` |
| `skipped` | The tool has no target: a mirror tool that this machine does not have, or the `latest` policy without a `latest` command. The reason is in the row. | Nothing, or fix the config. |
| `unknown` | Ferry cannot read the tool on the box: the tool has no `box` command, the box is offline, or the box command failed. | See the reason. |

For each box, the step "Checking tools on the box" runs one SSH command that reads all tools. It runs the `box` command of each tool two times:

1. With the ferry PATH, which each Ferry box command gets. This is the box version.
2. In a clean login shell: `env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" PATH=/usr/local/bin:/usr/bin:/bin sh -lc '<box command>'`. This shell reads `/etc/profile` and `~/.profile`, as a new SSH login does.

When the second run prints another version or no version, the state is `hidden`. Both runs load nvm first, as `ferry install` does. A login shell that is bash and has a `~/.bash_profile` does not read `~/.profile`. Ferry does not check that case.

For the `latest` policy, `ferry status` does not run the `latest` command of a tool. That command asks the vendor server and can take many seconds, so the target shows `latest`. The row is `ok` when the box has the tool. `ferry update` and the daily update of `ferry watch` install the newest version.

`ferry status --json` has the rows in `tools` of each box entry, with `id`, `mode`, `policy`, `operator`, `target`, `box`, `state`, and `reason` for `hidden`, `skipped`, and `unknown`. When the tools check fails, `tools` is empty and the error is in `errors` of the box.

## Several boxes

Ferry can keep more than one box in the config. Each box has a `[box.<name>]` table. A config with only a `[host]` table is one box with the name `default`. It works as before, and no command needs `--box`.

Add a box:

```sh
ferry box add b --ssh-destination user@box-b.example
ferry box add c --host box-c --ssh-user ferry
```

`ferry box add` makes the same checks on the new box as `ferry init`: the SSH connection, and for an SSH snapshot URL, the operator SSH agent, the Git host key on the box, and read access to the snapshot. Then it writes the `[box.<name>]` table. If a check fails, Ferry does not change the config.

The first `ferry box add` on a `[host]` config changes the config. Ferry moves `[host]` to `[box.default]`, adds the new box, and sets `default_box = "default"`. Thus the commands that change one box still use the old host. Ferry shows this change and asks before it writes. Add `--yes` to skip the question.

Other box commands:

- `ferry box list` prints the name, transport, and destination of each box. The `Default` column marks the box that a command uses without `--box`.
- `ferry box remove <name>` removes the table from the config. Ferry does not connect to the box and does not change it. Ferry does not remove the last box. If the box was the `default_box`, Ferry removes `default_box` and prints a warning.
- `ferry box default <name>` sets `default_box`, the box of `install`, `auth`, `move`, `tunnel`, and `integrations enable|disable` without `--box`.

### Git auth for each box

The `git_auth` key of a `[box.<name>]` table sets how the box git reads the snapshot remote:

- `"agent"` is the default. Ferry forwards your SSH agent (`ssh -A`) to the box for the snapshot update and for the Claude plugin installs of `ferry sync`. While these commands run, the box can use your agent.
- `"box"`: Ferry never forwards your agent to this box. The box reads the snapshot remote with its own key, `~/.ssh/ferry_snapshot`. Use it for a box that you trust less.

```toml
[box.b]
transport = "ssh"
destination = "user@box-b.example"
git_auth = "box"
```

Add a box with its own key:

```sh
ferry box add b --ssh-destination user@box-b.example --git-auth box
```

For a `"box"` box, `ferry box add` and `ferry init --box <name>` do these steps:

1. Make an ed25519 key without a passphrase at `~/.ssh/ferry_snapshot` on the box, if the key is missing.
2. Trust the Git host key on the box, as for `"agent"`.
3. Run `git ls-remote` on the snapshot remote with the key.

If the box cannot read the snapshot, Ferry stops, prints the public key, and does not write the config. Add the public key as a read-only deploy key on the snapshot repository, then run the command again. Ferry does not add the deploy key for you. Do not give the deploy key write access. The box only reads the snapshot.

Ferry selects the key only for its own snapshot git commands. It runs them as `git -c core.sshCommand='ssh -i ~/.ssh/ferry_snapshot -o IdentitiesOnly=yes'`. It does not write this setting to the box checkout or to `~/.ssh/config`. Thus a `git fetch` that you run by hand in `~/.ferry/store` on the box does not use the key.

To change an existing box to `"box"`, add `git_auth = "box"` to its table, then run `ferry init --box <name>`. `"box"` needs an SSH snapshot URL, because a deploy key works over SSH only. `git_auth` is valid only in a `[box.<name>]` table. A `[host]` config refuses it. Use `ferry box add` to change to box tables.

With `"box"`, `ferry sync` installs Claude plugins without your agent. A plugin from a private repository then fails with a warning, unless the box has its own access.

Select a box with the `--box <name>` option:

- `install`, `auth`, `move`, and `integrations enable|disable` change one box. They use the box of `--box`, else `default_box`, else the only box. If there is more than one box and no `default_box`, they stop and ask for `--box`. They accept one `--box` only.
- `tunnel` uses one box, with the same rules. See [Open a box port locally](#open-a-box-port-locally).
- With box tables, `integrations enable|disable` writes the key to `[box.<name>.integrations]` of that box. The command prints the name of the table that it changed.
- `status` works on all boxes, or on the boxes of `--box`. Give `--box` more than one time to select more boxes. See [Status](#status).
- `update` works on all boxes, or on the boxes of `--box`. Ferry updates the boxes one after the other. Each box gets the tool versions of its own policy, and the Paseo update only if Paseo is on for that box. The agent CLI updates on this machine run one time, not one time for each box. If a box is offline or an update on a box fails, Ferry continues with the other boxes. At the end, Ferry prints one result line for each box and exits with code 1 if a box failed. With more than one box, each box line starts with `[<name>]`.
- `integrations` (the list) shows one block for each box, with the state of each integration on that box and the connect steps for that box. `--box` limits the list to the named boxes.
- `tools` adds one `BOX <name>` column for each box, or for each box of `--box`. The column shows the version policy of that box. `ferry tools` reads this machine only, so it does not show the version on the box.
- `sync` works on all boxes, or on the boxes of `--box`. It publishes the snapshot one time, then syncs up to 4 boxes at the same time. Each box uses its own `[box.<name>.integrations]`, so the Paseo steps run only on a box that has Paseo on. A box that is offline or fails does not stop the other boxes. The command then exits with code 1 and names each failed box and its failed step. If the publish fails, Ferry changes no box. If a sync is already active for a selected box, Ferry stops before the publish and names the box. After the boxes, Ferry adopts the published local skills one time. With more than one box, each box step and each box line starts with `[<name>]`. `sync --dry-run` prints one plan for each box and does not connect to a box.
- `watch` works on all boxes. It does not accept `--box`, because one state file follows all boxes and the watch service runs without options. The watch reads the config in each cycle, so `ferry box add` and `ferry box remove` take effect without a restart. A new box syncs in the next cycle. On a change, the watch publishes one time and syncs each box that does not have the change. A box that is offline or fails goes into its own backoff, capped at 60 seconds. The other boxes continue to sync, and the watch continues to observe. When the backoff of a box ends, the watch syncs that box only and does not publish again. The daily update runs one time for all boxes. It skips a box that is offline and logs it, and that box gets the update on the next day. With more than one box, each watch line about a box starts with `[<name>]`. See [Automatic sync](#automatic-sync).
- With box tables, `ferry init` runs again for the box of `--box`, else `default_box`, else the only box. It keeps all box tables and `default_box`. It does not accept `--host`, `--ssh-user`, or `--ssh-destination`. Use `ferry box add` to add a box.
- Other commands, such as `uninstall` and `skills add`, do not accept `--box`.

## Add skills

After `ferry init`, use `ferry skills add` to install skills. The command runs `npx skills add` and passes your arguments through unchanged:

```sh
ferry skills add vercel-labs/agent-skills --skill frontend-design -a claude-code -y
```

Ferry adds `-g` and `--copy` if you do not pass them. The example runs `npx skills add vercel-labs/agent-skills --skill frontend-design -a claude-code -y -g --copy`. A global copy install puts each skill in a real directory in a global harness root, and the next sync links it to the store. A plain `npx skills add` installs into the current project, and Ferry does not see that install. Add `--project` to keep a project install. Ferry then does not add `-g`. Put arguments after `--` to keep Ferry from reading them. A failed `npx skills add` makes Ferry exit with the same code.

The install does not publish the skill. Run `ferry sync` or keep `ferry watch` running to publish it to the snapshot and apply it on the box.

Some installers replace the store link of a skill in one harness root with a real directory that holds a newer version, for example in `~/.agents/skills`. Sync then updates the store copy from that directory, publishes it, and links the directory to the store. Sync does this only when all of these conditions are true:

- Exactly one harness root has a real directory for the skill.
- Each other harness root that has the skill links to `~/.ferry/store/skills/<name>`, directly or through a chain of links.
- The store copy has no changes since its last commit in `~/.ferry/store`.

In all other cases, sync stops with a clash. `ferry sync` prints `Updated store skill <name> from <path>` for each update. `ferry sync --dry-run` lists the updates in the `Store updates from a harness root:` line and changes nothing.

### Agent skill

This repository has an agent skill in [`skills/ferry`](skills/ferry/SKILL.md). It tells agents on this machine and on the box how to work with Ferry. Its first rule is for agents on the box. They must not edit a Ferry-managed file there, because the next sync discards the change. Install the skill on this machine:

```sh
ferry skills add dlhck/ferry --skill ferry
```

Then run `ferry sync`. The sync carries the skill to the box like any other skill.

## Tools

Ferry ships recipes for five tools only: the agent CLIs `claude`, `codex`, `pi`, and `cursor`, and `gh`. `ferry auth gh` and the GitHub SSH setup need `gh`. You define every other tool in `~/.ferry/config.toml`. Ferry does not scan your projects for tools.

Each tool has a kind:

- `agent`: the vendor CLIs of the harnesses. Ferry installs them on every box, at the latest version.
- `tool`: `gh` and each tool that you define. Ferry puts a tool on the box only when this machine has it, at the version of this machine.

### Version policy

A policy is `"operator"` (the version on this machine), `"latest"` (the latest vendor release), or an exact version such as `"1.4.2"`. A tool without a policy uses the default of its kind: `"latest"` for an agent, `"operator"` for a tool.

- `"operator"`: Ferry reads the version on this machine. When this machine does not have the tool, Ferry skips a `tool` and installs an `agent` at the latest version.
- `"latest"`: the builtin tools use their own install recipe, which installs the latest release. A tool that you define needs a `latest` command, which prints the newest version. Ferry runs it on this machine. Ferry refuses a tool with the `"latest"` policy and no `latest` command.
- An exact version: Ferry installs that version.

The mirror rule of a `tool` applies only to the `"operator"` policy, because Ferry has no version to copy when this machine does not have the tool. A `"latest"` policy or an exact version in your config tells Ferry to install the tool, so Ferry installs it also when this machine does not have it.

To set the policy of a builtin tool, write a string in the `[tools]` table:

```toml
[tools]
gh = "latest"
claude = "operator"
codex = "0.156.1"
```

### Define a tool

To define a tool, add a `[tools.<id>]` table:

```toml
[tools.pnpm]
version = "operator"
local = "pnpm --version"
box = "pnpm --version"
install = 'PATH="$HOME/.nvm/current/bin:$PATH" npm install -g --prefix "$HOME/.local" pnpm@{version}'
path = [".local/bin"]
depends = ["node"]
```

| Key | Required | Value |
| --- | --- | --- |
| `version` | No | The policy. The default is `"operator"`. |
| `local` | Yes | A command that prints the version on this machine. Ferry loads nvm first when nvm is there, and runs the command in your home directory. A failed command means that this machine does not have the tool. |
| `box` | No | A command that prints the version on the box. Without it, Ferry cannot see the box version, and `ferry install` always runs `install`. |
| `latest` | No | A command that prints the newest version, for example `npm view pnpm version`. Ferry runs it on this machine, in the same way as `local`. The `"latest"` policy needs it. |
| `install` | Yes | The command that installs the tool on the box. |
| `update` | No | The command that updates the tool on the box. The default is `install`. |
| `path` | No | Directories relative to the home for the box `PATH`. |
| `depends` | No | The ids of the tools to install first. |

Rules:

- A string in `[tools]` is only for a builtin tool. A tool that you define sets its policy with `version` in its own table.
- A table cannot use the id of a builtin tool, and the config cannot name one tool two times.
- Ferry replaces `{version}` in `install` and `update` with the version that the policy selects, in single quotes for the shell. `{version}` is the only placeholder. Ferry refuses each other `{...}` token, and a placeholder in `local` or `box`. A shell expansion such as `${HOME}` is not a placeholder.
- Each id in `depends` must be a builtin tool or a tool that you define. Ferry refuses a dependency cycle.
- A `path` directory must be inside the home. It can have only letters, digits, and `.`, `_`, `@`, `+`, `-`, and `/`.
- Ferry refuses an unknown key, a value of the wrong type, and a policy that is not `"operator"`, `"latest"`, or an exact version. The error names the tool and the key.
- A string can be in double quotes, or in single quotes. A string in single quotes keeps `"` and `\` as they are, which is easier for shell commands. A list is one line of strings in double quotes. A comment must be on its own line.

A repeat `ferry init` keeps the `[tools]` table and the tool tables.

### Box PATH

The box `PATH` has `~/.local/bin` first, then `~/.pi/agent/bin` for Pi, then the `path` directories of the tools that you define, in config order. A directory is in the list one time only. Ferry uses the same list in three places:

- Each box command that Ferry runs over SSH starts with `export PATH=...`, because a command over SSH does not read the shell profile.
- `ferry sync` writes one block in `~/.profile` on the box, so a login shell and an SSH session find the same tools:

  ```sh
  # >>> ferry PATH >>>
  # Managed by ferry. ferry sync rewrites this block. Do not edit it.
  export PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$HOME/.bun/bin:$PATH"
  # <<< ferry PATH <<<
  ```

- When the Paseo integration is on, `Environment=PATH=` in `ferry-paseo.service` has the same directories, then the system directories.

Ferry owns the block. Each `ferry sync` rewrites the block in place, or adds it at the end of the file, and keeps all other lines and the file mode. When the block is current, Ferry does not write the file. When `~/.profile` is missing, Ferry creates it. If `~/.bash_profile` or `~/.bash_login` is on the box, bash does not read `~/.profile` for a login shell, so source `~/.profile` from that file.

When the Paseo integration is on and the directories changed, `ferry sync` writes the unit again and runs `systemctl --user daemon-reload` and `systemctl --user restart ferry-paseo.service`. The restart stops the agents that run in Paseo on the box, so Ferry restarts only when the `PATH` changed, and prints a line when it does. `ferry sync --dry-run` shows the directories.

`ferry install` does not write the block. After you add or change a `path`, run `ferry sync`.

### Recipes

These recipes are examples to copy and change. Ferry does not ship them.

Node through nvm. The `~/.nvm/current` link points at the Node that this recipe installs, so the box `PATH` has one fixed directory:

```toml
[tools.node]
local = "node --version"
box = "node --version"
install = '([ -s "$HOME/.nvm/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE=/dev/null bash) && . "$HOME/.nvm/nvm.sh" && nvm install {version} && nvm alias default {version} && ln -sfn "$HOME/.nvm/versions/node/v"{version} "$HOME/.nvm/current"'
path = [".nvm/current/bin"]
```

pnpm, as in the example above.

Bun:

```toml
[tools.bun]
local = "bun --version"
box = "bun --version"
install = 'curl -fsSL https://bun.sh/install | bash -s "bun-v"{version}'
path = [".bun/bin"]
```

Docker. The install script needs `sudo` on the box:

```toml
[tools.docker]
local = "docker --version"
box = "docker --version"
install = 'curl -fsSL https://get.docker.com | sudo sh -s -- --version {version}'
```

An npm global CLI, here TypeScript:

```toml
[tools.typescript]
local = "tsc --version"
box = "tsc --version"
install = 'PATH="$HOME/.nvm/current/bin:$PATH" npm install -g --prefix "$HOME/.local" typescript@{version}'
path = [".local/bin"]
depends = ["node"]
```

### ferry tools

`ferry tools` lists the builtin tools and the tools that you define. For each tool, it shows the kind, the install mode, the policy, and the version on this machine. `ferry tools` does not connect to the box.

### Install and update the tools

`ferry install` and `ferry update` use the same rules for each tool:

1. Ferry selects the version from the policy, as [Version policy](#version-policy) tells.
2. Ferry reads the box version with the `box` command. When the box has the selected version, Ferry skips the tool.
3. Ferry changes the tools in `depends` order. A tool comes after the tools that it depends on.

`ferry install` runs `install` for each tool that it does not skip. `ferry update` runs `update` for a tool that the box has, and `install` for a tool that the box does not have. The agent CLIs keep their builtin recipes, which install the latest release. Ferry cannot see that version first, so it runs the recipe each time. `gh` installs the selected version with `apt`. When the GitHub apt repository does not have that version, `gh` falls back to the latest version with a warning. With the `"latest"` policy, `gh` uses its latest recipe.

Both commands print the plan first, with the policy, the version, and the action of each tool:

```
node: skipped, the box has 24.16.0 (policy operator)
pnpm: install 11.17.0 (policy operator): npm install -g --prefix "$HOME/.local" pnpm@'11.17.0'
bun: skipped, not on the operator machine (policy operator)
claude: install latest (policy latest): curl -fsSL https://claude.ai/install.sh | bash
```

Ferry prints the output of each install and update command after its step, for example a warning that `gh` falls back to the latest version.

Ferry refuses the plan and changes nothing when a tool is refused, or when it must change a tool that depends on a tool that this machine does not have. The error names the tool and what to change. When an install fails, `ferry install` stops, so no tool that depends on it runs. When an update fails, `ferry update` skips the tools that depend on it, runs the other updates, and names each failure at the end.

The daily update of `ferry watch` changes only the tools with the `"latest"` policy. A tool with the `"operator"` policy or an exact version changes only when you run `ferry update`.

`ferry status` shows the box version and the state of each tool. See [Tools in status](#tools-in-status).

## Update the agent tools

`ferry update` updates the tools on the box with the rules in [Install and update the tools](#install-and-update-the-tools). These are the update commands of the builtin tools, on the box and on this machine:

| Tool | Update command | On this machine |
| --- | --- | --- |
| `gh` | `sudo apt update && sudo apt install gh -y` for the `"latest"` policy. For a version, `sudo apt install gh=<version>`, with the fallback to the latest version. | Skipped. `gh` has no own update command, and Ferry does not guess the package manager here. |
| Claude | `claude update` | Runs if `claude` is installed. |
| Codex | `codex update` | Runs if `codex` is installed. |
| Pi | `pi update` | Runs if `pi` is installed. This updates Pi only, not its packages. |
| Cursor Agent | `cursor-agent update` | Runs if `cursor-agent` is installed. |

On this machine, Ferry uses `command -v` to find each tool. It updates only a tool that is already installed. It never installs a tool here, and it never runs the recipes of the tools that you define here.

Ferry prints the plan first and asks for confirmation. Add `--yes` to skip the prompt. Add `--dry-run` to print the plan and change nothing:

```sh
ferry update --dry-run
```

A failed update does not stop the other updates. After all updates, Ferry names each failed update and exits with a non-zero code.

The `gh` update uses `sudo` on the box. The daily update of `ferry watch` updates `gh` only when its policy is `"latest"`. When the watch runs the update, no terminal is available to type a password. Membership in the `sudo` group is not sufficient, because the default rule on Ubuntu and Debian asks for a password. To let the watch update `gh`, add this rule on the box. Replace `<ssh-user>` with the SSH user of the box:

```
# /etc/sudoers.d/ferry  (edit with: sudo visudo -f /etc/sudoers.d/ferry)
<ssh-user> ALL=(root) NOPASSWD: /usr/bin/true, /usr/bin/apt update, /usr/bin/apt install gh -y
```

sudo compares the full command path and all arguments. The rule allows only these three commands, with these exact arguments. `/usr/bin/apt update` and `/usr/bin/apt install gh -y` are the two commands of the `gh` update. `/usr/bin/true` does nothing. `ferry status` runs `sudo -n /usr/bin/true` to find out if `sudo` asks for a password. Ferry does not write sudoers files on the box.

`ferry status` shows `Box sudo: PASSWORDLESS` or `Box sudo: PASSWORD REQUIRED`, and `--json` has the result in `boxSudo` of each box. When `[update] watch = true`, the `gh` policy is `"latest"`, and `sudo` asks for a password, `ferry status` shows a warning that the watch cannot update `gh`. With another `gh` policy, the watch does not update `gh`, so Ferry shows no warning.

## Log in to the agent tools

Run `ferry auth <tool>` for `gh`, `claude`, `codex`, or `cursor`. Run `ferry auth` to list the tools.

Ferry first checks the login on the box. If the tool is not logged in, Ferry starts the vendor login on the box, detached from the SSH session. Ferry prints the URL, and the code if the tool has one, as soon as the login on the box shows them. Open the URL in a browser on your machine and finish the login there. Ferry then waits, and it checks the login on the box every 5 seconds. It reports the result when the login is complete. The login on the box stops after 15 minutes. If you do not finish in that time, Ferry reports that the login did not finish.

- `gh`: Ferry prints a one-time code for `https://github.com/login/device`.
- `claude`: Ferry prints the login URL. After the login, the browser shows a code. Paste it at the Ferry prompt, and Ferry gives it to the login on the box.
- `codex`: Ferry prints a one-time code for `https://auth.openai.com/codex/device`. If the device login gives no code, Ferry uses the Codex callback login. Ferry then prints the URL and forwards local port 1455 to the box for up to 120 seconds. Ferry checks the login on the box every 5 seconds and closes the forward when the login is done. Press Ctrl-C to stop early. Ferry then checks the login once more and reports it.
- `cursor`: Ferry prints the login URL.

Pi has no remote login that Ferry can start. SSH to the box, run `pi`, and use `/login`.

### GitHub over SSH

`ferry auth gh` sets up GitHub with SSH as the git protocol, so agents on the box can push. Ferry forwards your SSH agent only for its own snapshot update, so the box needs its own key.

1. Before the login, Ferry creates the key `~/.ssh/id_ed25519` on the box if it does not exist. The key has no passphrase and the comment `<box user>@<box host> ferry`. Ferry never replaces an existing key.
2. The gh login asks for the `admin:public_key` scope, which gh needs to add the key.
3. After the login, Ferry adds `~/.ssh/id_ed25519.pub` to your GitHub account with the title `<box host> (ferry)`. If GitHub already has the key, Ferry does not add it again.
4. If the box `~/.ssh/known_hosts` has no `github.com` entry, Ferry reads the ed25519 host key with `ssh-keyscan`. Ferry adds it only if its fingerprint is the same as the fingerprint that the GitHub meta API publishes.
5. Ferry sets `gh config set -h github.com git_protocol ssh`.
6. Ferry runs `ssh -T git@github.com` and reports if GitHub accepts the key.

If you do not finish the login, Ferry does not do steps 3 to 6. If gh is already logged in, `ferry auth gh` does only steps 1 and 3 to 6. A gh login without the `admin:public_key` scope cannot add the key. Run `gh auth refresh -h github.com -s admin:public_key` on the box, then run `ferry auth gh` again.

To revoke the box key, delete the key with the title `<box host> (ferry)` in GitHub under Settings > SSH and GPG keys. You can also run `gh ssh-key list` and `gh ssh-key delete <id>`. To remove the key from the box, delete `~/.ssh/id_ed25519` and `~/.ssh/id_ed25519.pub` there.

## Move a project

Use `ferry move` to continue work on a project on the other machine.

```sh
ferry move ~/Developer/app                # this machine -> box
ferry move --from-box ~/Developer/app     # box -> this machine
ferry move ~/Developer/app --dry-run      # show what Ferry carries, refuses, and skips
ferry move ~/Developer/app --remove       # after verification, move the source copy to a trash directory
ferry move ~/Developer/app --include-env  # also carry .env files that pass the deny rules
ferry move ~/Developer/app --include-env --allow-secrets  # also carry .env files with tokens or secrets
```

The project must be inside your home directory. The destination uses the same path relative to its home. For example, `~/Developer/app` on this machine becomes `~/Developer/app` on the box. Ferry does these steps:

1. **Preflight.** Ferry reads the remote branches and tags of `origin` with `git ls-remote`. Ferry refuses the move if a commit on a local branch is not on `origin`, and names the commit. Ferry accepts the commit in these cases: `git cherry` shows that an equivalent patch is on the default branch of `origin`; `git merge-tree` shows that the default branch already has the changes of the commit, as after a squash merge; or `gh` finds a merged pull request whose head is the branch tip. `git merge-tree` needs git 2.38 or later, and it writes its objects to a temporary directory, not to the repository. If `gh` is missing, cannot read `origin`, or does not answer in 15 seconds, Ferry does not use it and prints a note. The notes show which check accepted the commits of each branch. Ferry does not fetch, so run `git fetch` first if the branch was merged recently. Ferry also refuses uncommitted changes to tracked files, and a destination path that exists. Ferry reports stashes, because the clone does not get them.
2. **Clone.** The destination clones the project from `origin`, at the current branch if `origin` has it. The box uses its own SSH key. Run `ferry auth gh` first to set up that key.
3. **Carry.** Ferry carries the untracked and ignored files. Ferry skips `node_modules`, `.next`, `.nuxt`, `.output`, `.svelte-kit`, `.turbo`, `.vite`, `.velite`, `.docusaurus`, `.expo`, `.vercel/output`, `.cache`, `.parcel-cache`, `.pnpm-store`, `*.tsbuildinfo`, `dist`, `build`, `coverage`, `target`, `__pycache__`, `.venv`, `venv`, `.gradle`, `.terraform`, `.idea`, `.vscode`, `.DS_Store`, and `._*` at any depth. Ferry skips only the `output` directory of `.vercel`, and carries the other files in `.vercel`, such as `project.json`. Each carried file must pass the deny rules of [What Ferry carries](#what-ferry-carries): credential and token file names, private keys, token content, secret fields in JSON, YAML, and TOML files, and executable binaries. Ferry refuses symbolic links and nested git repositories. The archive has no macOS extended attributes, so the box gets no `._*` files.
4. **Environment files.** Ferry refuses `.env` and `.env.*` files. With `--include-env`, Ferry carries an environment file only if it has no token and no `PASSWORD`, `SECRET`, `API_KEY`, or similar key with a value. With `--include-env --allow-secrets`, Ferry also carries an environment file that has a token or a secret key. `--allow-secrets` without `--include-env` is an error. The flag applies only to `.env` and `.env.*` files. Ferry still refuses an environment file with a private key or an executable, and all other files keep every deny rule. The plan shows each of these files on a `Carry with secrets:` line with the kinds of secret, such as `AWS access key ID in file content`, and never the values. On a terminal, Ferry asks before the transfer. Without a terminal, Ferry stops before any change and needs `--yes`. `--yes` skips the question. `--dry-run` works without `--yes`. On the destination, Ferry writes these files with mode `600`, and the checksum check covers them. After the move, the box holds the same secrets as this machine. Anyone with access to the box user can read them.
5. **Verify.** Ferry compares the SHA-256 checksum of each carried file on the destination with the checksum of the bytes that Ferry checked.
6. **Remove.** With `--remove`, Ferry moves the source copy after verification. On macOS, this machine uses `~/.Trash/<name>-<timestamp>`. The box, and a Linux operator machine, use `~/.ferry/trash/<name>-<timestamp>`. Ferry never deletes the source copy. Ferry refuses `--remove` before any change if it refuses a local-only file.

A folder without git has no clone. Ferry copies all its files with the same skip list and deny rules.

`--dry-run` prints the plan: the clone, and each file that Ferry carries, refuses, or skips. It does not write on either machine. With `--from-box`, Ferry reads the box files into a temporary directory on this machine for the deny checks, and removes that directory after the run.

If a step fails after the clone, the destination copy is incomplete. Ferry does not remove it. Move it away before you try again.

## Open a box port locally

Use `ferry tunnel` to open a dev server of the box in a browser on this machine.

```sh
ferry tunnel 3000             # box 127.0.0.1:3000 -> http://localhost:3000
ferry tunnel 3000 5173 8080   # several ports in one SSH connection
ferry tunnel 3000:4000        # box port 3000 -> local port 4000
ferry tunnel --list           # list the TCP ports that listen on the box
ferry tunnel 3000 --box lab   # a box other than the default box
```

Ferry prints one line for each port, then keeps the tunnel open until you press Ctrl-C:

```text
http://localhost:3000 -> lab:127.0.0.1:3000
http://localhost:4000 -> lab:127.0.0.1:5173
Press Ctrl-C to close the tunnel.
Tunnel closed.
```

- The local end binds to `127.0.0.1` only. Other machines on your network cannot use the tunnel.
- The box end is `127.0.0.1` on the box. A dev server that listens only on `::1` does not answer. Start it on `127.0.0.1` or on all interfaces.
- Before it connects, Ferry binds each local port for a moment. If a local port is in use, Ferry stops and names the port. Use `box:local` to pick another local port.
- All ports use one SSH connection with `ssh -N`. If the connection drops, Ferry prints the SSH error and exits with a non-zero code. Ferry does not reconnect, and it has no background mode.
- `--list` runs one read-only command on the box: `ss -ltnpH`. If the box has no `ss`, Ferry uses `netstat -ltnp`, then `/proc/net/tcp`. The list shows the ports that listen on loopback or on all interfaces. Without root, the box can hide the process names of other users. The list shows `-` for them.
- The box is `--box`, then `default_box`, then the only box.

## What Ferry carries

Ferry carries these items from the operator machine to the box:

- The skills in every global harness skill root, such as `~/.agents/skills` and `~/.claude/skills`. Ferry does not carry the `.system` directory in a skill root, because Codex manages it and installs its own copy on each machine.
- `~/AGENTS.md`, linked as the instruction file of each harness.
- The Claude subagents in `~/.claude/agents` and the Claude commands in `~/.claude/commands`. Ferry links each directory whole into the store. On the box, a live directory at one of these paths stops the sync. `ferry sync --force` moves it to `~/.ferry/backups` and then links it.
- An allowlist of keys from `~/.claude/settings.json`: the plugin declarations `enabledPlugins` and `extraKnownMarketplaces`, and `permissions` and `hooks`. The snapshot holds these keys in `settings/claude.json`. It holds no other settings key and no plugin cache. Keys that can hold secrets, such as `env` and `apiKeyHelper`, stay on the operator machine.
- The remote MCP servers of Claude (`mcpServers` in `~/.claude.json`), Codex (`[mcp_servers]` in `~/.codex/config.toml`), and Cursor Agent (`mcpServers` in `~/.cursor/mcp.json`). Ferry carries only the name, the transport, and the HTTPS URL of each server. See [Remote MCP servers](#remote-mcp-servers).

The deny rules apply to every carried directory. A file such as `.env` or `credentials.json`, or a file that holds a token, stops the sync. A JSON, YAML, or TOML file also stops the sync if it has a secret key with a string value, at any depth. A secret key is `passwd`, or a key that contains `secret`, `privatekey`, `apikey`, `password`, or `token`. Ferry compares keys without regard to case, `-`, or `_`, so `clientSecret`, `OPENAI_API_KEY`, `accessToken`, and `secretKeyB64` match. A number value passes, so `maxTokens: 4096` in a file that parses does not stop the sync. The error names the file and the key, never the value. An empty value passes, and a placeholder value passes by the token rule below. If the file does not parse, Ferry checks each `key: value` or `key = value` line. An ELF, Mach-O, or PE executable also stops the sync. A script with a shebang and a Java class file are not executables to Ferry. Ferry also stops the sync if a carried settings key holds a token or request headers. A documentation placeholder is not a token. Ferry ignores a token whose part after the prefix is only `x`, only `X`, or only `0`, such as `ghs_xxxx...`. It also ignores a part of only `x` and `X` with the `-` or `_` separators of the token format, such as `xoxb-xxxx-xxxx-...`.

Ferry does not carry a hook that refers to a file in your home that the box will not have. Ferry splits each hook `command` into words at spaces, quotes, `;`, `|`, `&`, `(`, `)`, `<`, `>`, and `=`. A word that starts with `~/`, `$HOME/`, or `${HOME}/` must point into a skill root that Ferry fills on the box, `~/.claude/agents`, `~/.claude/commands`, or a managed instruction file such as `~/AGENTS.md`. A word that is an absolute path under your home, such as `/Users/you/bin/check.sh`, never passes, because the box home has a different path. Programs on `PATH` (`jq`, `npx ...`), `$CLAUDE_PROJECT_DIR` paths, and absolute paths outside your home pass. Ferry leaves out each hook entry that does not pass and carries all other hooks. If a matcher group has no hooks left, Ferry removes the group. If an event has no groups left, Ferry removes the event. The sync continues. `ferry sync` and `ferry sync --dry-run` print one `Skipped hook:` line for each hook that Ferry leaves out, with its location, such as `hooks.PreToolUse[0].hooks[1].command`, and the path. A script in `~/.claude/hooks` is not carried, so move it into a carried directory or onto `PATH` on both machines.

On the box, `ferry sync` runs `claude plugin marketplace add` for each carried marketplace and `claude plugin install` for each enabled plugin. Claude does not install a plugin from settings alone. Then Ferry writes the carried keys into the box `~/.claude/settings.json`. The box keeps all other keys, such as `env` and `model`. A carried key that the operator machine does not have is removed from the box, because the box never wins. For example, if you have no `hooks` key, sync removes the box `hooks` key. If the box has no settings file, Ferry creates one. A marketplace or plugin that the box cannot install gives a warning and does not stop the sync. A marketplace with a `directory` or `file` source is on the operator machine only, so the box cannot add it.

`ferry sync --dry-run` lists the carried settings keys that sync will change. It compares your carried keys with the keys of the last publish in `~/.ferry/store/settings`. It does not connect to the box, so a key that someone changed on the box does not show.

Claude writes a marketplace to `extraKnownMarketplaces` when you add it with `claude plugin marketplace add`. Older Claude versions recorded marketplaces only in `~/.claude/plugins`. If a plugin in `enabledPlugins` comes from a marketplace that `extraKnownMarketplaces` does not list, such as `claude-plugins-official`, run `claude plugin marketplace add` for it once on the operator machine. For example: `claude plugin marketplace add anthropics/claude-plugins-official`.

## Remote MCP servers

A remote MCP server, such as Linear, has a name and an HTTPS URL and logs in with OAuth. Ferry declares these servers on the box. Ferry never copies an MCP token. You log in to each server on the box.

Ferry reads only the MCP key of each file. It does not read the other keys of `~/.claude.json`, such as the account data. Ferry does not carry a local server, which has a `command`, or a server with a plain `http://` URL. `ferry sync` and `ferry sync --dry-run` print one `Skipped MCP server:` line for each. Ferry stops the sync if a remote server has request headers (`headers`, `headersHelper`, `http_headers`, `env_http_headers`, `http_headers_helper`), a `bearer_token_env_var`, an `env` or `env_vars` value, or `args`. Ferry also stops the sync if the URL has a user name, a password, a query parameter such as `api_key` or `token`, or a token. A server name can have only letters, digits, `.`, `_`, and `-`, because the name goes into commands on the box. Ferry stops the sync for any other name.

On the box, `ferry sync` declares each carried server:

- Claude: `claude mcp add --transport http --scope user <name> <url>`.
- Codex: `codex mcp add <name> --url <url>`. This command also starts a login and waits for it, so Ferry stops it after 20 seconds. Codex writes the declaration before the login starts.
- Cursor Agent: Ferry writes the server into `mcpServers` of the box `~/.cursor/mcp.json`, because Cursor Agent has no add command.

If the box already declares a server with the same URL, Ferry does not change it, so its login stays. If the URL is different, Ferry replaces the declaration. You must then log in again. Ferry never removes a server from the box. If you remove a server on your machine, remove it on the box yourself. A missing CLI or a server that the box does not take gives a `Box MCP:` warning and does not stop the sync.

`ferry status` lists each box MCP server that needs a login, from `claude mcp list`, `codex mcp list`, and `cursor-agent mcp list`.

To log in, run the command that status prints:

```sh
ferry auth claude --mcp linear
```

Ferry starts the login of the tool on the box. Claude and Codex need a terminal, so Ferry runs the login under `script`, detached from the SSH session. Ferry prints the authorize URL. Open it in a browser on your machine. The browser then goes to a `localhost` callback port. Ferry forwards that port to the box for up to 300 seconds, so the tool on the box gets the callback and keeps the token. Ferry checks the MCP server list on the box every 5 seconds and closes the forward when the server no longer needs a login. Press Ctrl-C to stop early. Ferry then checks the login once more and reports it. The login on the box stops after 330 seconds. The callback port must be free on your machine. For example, Claude uses port 3118. Pi has no MCP support of its own, so Ferry does not declare Pi MCP servers.

## Integrations

An integration runs one extra service on the box. Paseo is the only integration. All integrations are off by default. When no integration is on, Ferry commands print nothing about integrations.

`ferry integrations` lists each integration, shows if it is on, and shows the version of the local app and the file that Ferry read it from. The box gets the same Paseo version as the local app. Ferry reads the version from `/Applications/Paseo.app/Contents/Resources/bin/paseo --version` or from the `Info.plist` of the app on macOS, and from `/opt/Paseo/resources/bin/paseo --version` on Linux. If there is no local app, the box version is not pinned.

The config key is in `~/.ferry/config.toml`:

```toml
[integrations]
paseo = true
```

A repeat `ferry init` keeps this section. Ferry refuses an unknown integration name.

### Enable Paseo

```sh
ferry integrations enable paseo --dry-run   # print the box commands. Ferry does not connect or write.
ferry integrations enable paseo             # print the plan, ask, then run it
ferry integrations enable paseo --yes       # run without the prompt
```

Enable does these steps on the box, in this order:

1. Node. Paseo needs Node 22 or later. If the box has an older Node or no npm, Ferry installs `nodejs` and `npm` with apt, as the Pi install does. If the box still has no Node 22 after that, Ferry stops and changes nothing more.
2. Paseo CLI. `npm install -g --prefix "$HOME/.local" @getpaseo/cli@<version>`. The version is the version of the local app. With no local app, Ferry installs the npm `latest` tag and tells you that the version is not pinned.
3. Old unit. If `~/.config/systemd/user/paseo.service` exists and is active or enabled, Ferry stops and disables it, so two daemons never run. Ferry does not delete that file.
4. New unit. Ferry writes `~/.config/systemd/user/ferry-paseo.service`. The unit runs `paseo daemon run` with the same `PATH` as a Ferry box command, `PASEO_LISTEN=127.0.0.1:6767` and `PASEO_RELAY_ENABLED=false`. These variables override the Paseo `config.json`, so a change in the app cannot open the listen address or turn on the relay.
5. Start. `systemctl --user daemon-reload`, `systemctl --user enable --now ferry-paseo.service` and `loginctl enable-linger "$USER"`. Then Ferry reads `paseo daemon status --json` until the daemon is running, for a maximum of 60 seconds.
6. Projects. Ferry registers each git clone in the box home directory, to a depth of three directories, with `paseo project create`. It does not search hidden directories or `node_modules`. A project that Paseo refuses gives a warning. It does not stop the enable.

Then Ferry sets `paseo = true` in `~/.ferry/config.toml` and prints the steps to connect Paseo Desktop to the box: open Settings → Add host → Remote SSH and enter `ssh://<box destination>`. Ferry cannot add the host for you, because Paseo Desktop has no command for it. If a box step fails, Ferry does not change the config.

The daemon has no password. Any process of any user on the box can control it through `127.0.0.1:6767`. Use this integration only on a box that has one user.

`enable --now` does not restart a daemon that already runs. To load a new Paseo version, use `ferry update`.

### Update Paseo

`ferry update` updates Paseo only when `paseo = true`. It installs the local app version with npm, then runs `systemctl --user restart ferry-paseo.service`. `paseo daemon restart` is not sufficient, because it keeps the old binary. The restart stops the agents that run on the box. For this reason, the daily update of `ferry watch` never updates Paseo.

Before it installs, Ferry reads the version of the running daemon with `paseo daemon status --json`. If the box already runs the target version, Ferry prints `Paseo <version> is current` and does not install or restart. The target is the local app version. With no local app, the target is the output of `npm view @getpaseo/cli version` on this machine. If Ferry cannot read one of the two versions, it prints a warning and updates. `ferry update --dry-run` also reads the box version, and shows the skip or the box commands.

### Disable Paseo

```sh
ferry integrations disable paseo           # stop the daemon and remove the unit
ferry integrations disable paseo --purge   # also uninstall the Paseo CLI
```

Disable runs `systemctl --user disable --now ferry-paseo.service`, removes the unit file, and sets `paseo = false`. With `--purge`, it also runs `npm uninstall -g --prefix "$HOME/.local" @getpaseo/cli`. Linger stays on, because other user services can need it. Ferry never removes `~/.paseo`. It holds the Paseo config, the agent state, and worktrees that can have work that is not committed.

### Status and move

When `paseo = true`, `ferry status` adds an `Integrations` section and a step called "Checking Paseo on the box". The step runs one read-only command on the box. It reads `systemctl --user is-active` and `is-enabled` for `ferry-paseo.service`, `is-active` for the old `paseo.service`, and `paseo daemon status --json`:

```
Integrations:
  Paseo:
    Service: ferry-paseo.service active, enabled
    Daemon: running, reachable
    Version: box 0.9.2, local app 0.9.2
    Listen: 127.0.0.1:6767, relay off
    Providers: claude available, codex available
```

If there is no local Paseo app, the version line says `not pinned (no local Paseo app)`. Ferry prints a `WARNING` line for each of these problems:

- The box version is not the same as the local app version.
- The daemon is not running.
- The daemon listens on an address that is not loopback.
- The relay is on.
- The old hand-written `paseo.service` is active, so two daemons can run.
- Paseo is not installed on the box.
- Ferry cannot read the output of `paseo daemon status --json`.

For each box with `paseo = true`, `ferry status --json` adds `integrations.paseo` to the box entry, with `name`, `lines`, `warnings`, and `state`. `state` has the unit states, `localDaemon`, `connectedDaemon`, `daemonVersion`, `localVersion`, `pinned`, `listen`, `relay`, `providers`, and `error`. Ferry never shows the `serverId`, the hostname, or the values in `~/.paseo/config.json`. When the host is offline, Ferry skips the check.

When `paseo = true`, `ferry move` to the box adds a step called "Registering the project in Paseo" after the move. The step runs `paseo project create <path>` on the box. A repeat run is safe, because Paseo returns the existing project for a known directory. If the step fails, Ferry prints a warning and the move stays complete. `ferry move --from-box` does not register the project on this machine. With `--remove`, Ferry does not remove the source project from Paseo. It prints a line that tells you how to remove it: run `paseo project ls` to find its ID, then `paseo project delete <id>`. This does not delete files.

### Agent profiles

When `paseo = true`, `ferry sync` carries the Paseo agent profiles to the box. It reads `daemon.agentProfiles` from `~/.paseo/config.json` on this machine. It reads no other key from that file. The password hash, the voice provider API keys, the agent provider `env` blocks, the listen address, the relay, and the paths stay on this machine.

Before the publish, Ferry checks each profile. A profile stops the sync if it has an `env` block, a key that contains `credential`, a token, or a secret key with a value. The error names the profile and the key, never the value.

The last sync step is "Carrying Paseo agent profiles". It does these steps on the box:

1. It reads the providers from `paseo daemon status --json`. It skips each profile whose provider is not available on the box, and prints a warning that names the profile and the provider.
2. It sets `daemon.agentProfiles` in `~/.paseo/config.json` on the box to the profiles that it keeps. The box keeps all other keys. A box profile that is not on this machine is removed, because the box never wins.
3. It runs `paseo daemon reload`. Profiles need no restart, so the agents on the box continue to run.

If the box already has the same profiles, Ferry writes nothing and does not reload. If you have no profiles, the step says `no profiles` and changes nothing on the box. If the step fails, for example because the daemon does not run, Ferry prints a warning and the sync is complete. `ferry watch` runs the same sync, so it also carries the profiles. `ferry sync --dry-run` names the profiles that Ferry will carry. It does not connect to the box, so it cannot tell which profiles the box skips.

Do not edit `daemon.agentProfiles` in `~/.paseo/config.json` on the box. The next sync replaces it.

### Deny rules for Paseo files

Ferry refuses `daemon-keypair.json` (the Paseo relay key pair) and `hub-credentials.json` (the Paseo Hub login) by name in every carried directory and in `ferry move`. Ferry never reads `~/.paseo` for the snapshot.

## Automatic sync

`ferry watch` runs in the foreground. It watches the Manifest identity for every configured global skill root, `~/AGENTS.md`, the Claude subagents and commands, and the carried Claude settings keys. It does not watch project-local skills. After an accepted change stays stable for one second, Ferry runs the normal sync without `--force`. Network, SSH, and Git failures retry with a backoff capped at 60 seconds. Each box has its own backoff, and the watch does not stop to wait for it. Manifest refusals name the local path and wait for another edit.

Ferry records the last published Manifest identity, and the identity that each box accepted, in `~/.ferry/watch-state.json`:

```json
{ "version": 2, "published": "<identity>", "boxes": { "a": "<identity>", "b": "<identity>" } }
```

A `[host]` config has one box, named `default`. The watch reads a version 1 file from an older Ferry as the identity of each configured box, and then writes version 2. This file is not part of the snapshot.

`ferry watch` can also run `ferry update --yes` once each day, for the tools with the `"latest"` policy only. This is off by default. To turn it on, add this section to `~/.ferry/config.toml`:

```toml
[update]
watch = true
```

When the key is `true`, the watch runs the update when 24 hours have passed since the last update, or when no update ran before. The update runs next to the sync loop, so it does not delay a sync. A failed update prints a warning, and the watch continues. Ferry records the start time of the last update in `~/.ferry/update-state.json`, so a restart of the watch does not start an extra update. This file is not part of the snapshot. Restart the watch after you change the key.

Install and start the user service from the operator machine:

```sh
ferry watch install
```

The installer uses the absolute path of the running Ferry executable. It also records the current `PATH` and, when set, `SSH_AUTH_SOCK`. Run the command again after moving Ferry or changing either environment value.

### macOS launchd

On macOS, `ferry watch install` writes `~/Library/LaunchAgents/dev.ferry.watch.plist`, unloads an older Ferry watch job, and bootstraps the new job. The generated plist has this shape, with absolute paths from the current process:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.ferry.watch</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/ferry</string>
    <string>watch</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/example/Library/Logs/ferry-watch.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/example/Library/Logs/ferry-watch.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

launchd does not inherit the shell's `PATH` or `SSH_AUTH_SOCK`. Before installation, make sure the current `PATH` contains `git` and `ssh`. Include `tailscale` only when the configured host uses Tailscale. If the snapshot remote needs an SSH agent, make sure `SSH_AUTH_SOCK` points to its stable socket. Do not put tokens or private keys in the plist.

### Linux systemd user service

On Linux, `ferry watch install` writes `~/.config/systemd/user/ferry-watch.service`, reloads the user manager, and enables and starts the service. The generated unit has this shape:

```ini
[Unit]
Description=Ferry automatic sync
After=network-online.target

[Service]
Type=simple
ExecStart=/home/example/.local/bin/ferry watch
Restart=on-failure
RestartSec=5
Environment=PATH=/home/example/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

Read its logs with `journalctl --user -u ferry-watch.service -f`.

systemd user services also need an explicit `PATH`. The installer adds `Environment=SSH_AUTH_SOCK=/absolute/socket/path` when the variable exists. Reinstall the service if that socket path changes. Do not store tokens or private keys in the unit.

Custom global roots use declarative harness entries in `~/.ferry/config.toml`:

```toml
[[harness]]
id = "opencode"
name = "OpenCode"
skill_root = ".config/opencode/skills"
instruction_file = ".config/opencode/AGENTS.md"
```

Every command uses these entries, and `ferry init` keeps them when it rewrites the file. A custom harness cannot add extra directories or settings keys to the snapshot. Ferry refuses an unknown key or section in the config and names it.

## Development

Ferry needs [bun](https://bun.sh) 1.4 or later.

```sh
bun install
bun test
bun run typecheck
bun run build
```

`bun run build` compiles a standalone executable to `dist/ferry` for the current platform. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and [SECURITY.md](SECURITY.md) to report a vulnerability. See [RELEASING.md](RELEASING.md) for the release process and the npm packages.

## License

MIT. See [LICENSE](LICENSE).
