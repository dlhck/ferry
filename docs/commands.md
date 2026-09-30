---
title: Commands
description: The help text of each Ferry command and subcommand.
---

<!-- This file is generated. Do not edit it. Run: bun scripts/docs-commands.ts -->

# Commands

This page has the `--help` text of each Ferry command and subcommand, from the Ferry source. Run `ferry <command> --help` to get the text of your version.

The `ferry sherlock` commands exist only when the Sherlock integration is on and `sherlock` is on the PATH.

- [`ferry`](#ferry)
  - [`ferry init`](#ferry-init)
  - [`ferry install`](#ferry-install)
  - [`ferry update`](#ferry-update)
  - [`ferry uninstall`](#ferry-uninstall)
  - [`ferry auth`](#ferry-auth)
  - [`ferry sync`](#ferry-sync)
  - [`ferry history`](#ferry-history)
  - [`ferry revert`](#ferry-revert)
  - [`ferry move`](#ferry-move)
  - [`ferry adopt`](#ferry-adopt)
  - [`ferry tunnel`](#ferry-tunnel)
    - [`ferry tunnel install`](#ferry-tunnel-install)
    - [`ferry tunnel uninstall`](#ferry-tunnel-uninstall)
  - [`ferry expose`](#ferry-expose)
  - [`ferry status`](#ferry-status)
  - [`ferry doctor`](#ferry-doctor)
  - [`ferry integrations`](#ferry-integrations)
    - [`ferry integrations enable`](#ferry-integrations-enable)
    - [`ferry integrations disable`](#ferry-integrations-disable)
  - [`ferry sherlock`](#ferry-sherlock)
    - [`ferry sherlock add`](#ferry-sherlock-add)
  - [`ferry tools`](#ferry-tools)
  - [`ferry watch`](#ferry-watch)
    - [`ferry watch install`](#ferry-watch-install)
  - [`ferry menubar`](#ferry-menubar)
    - [`ferry menubar install`](#ferry-menubar-install)
    - [`ferry menubar uninstall`](#ferry-menubar-uninstall)
  - [`ferry self-update`](#ferry-self-update)
  - [`ferry whoami`](#ferry-whoami)
  - [`ferry box`](#ferry-box)
    - [`ferry box list`](#ferry-box-list)
    - [`ferry box add`](#ferry-box-add)
    - [`ferry box remove`](#ferry-box-remove)
    - [`ferry box default`](#ferry-box-default)
  - [`ferry skills`](#ferry-skills)
    - [`ferry skills add`](#ferry-skills-add)

<!-- {% raw %} -->

## ferry

```text
Usage: ferry [options] [command]

Ferry keeps a remote Linux agent box in the same shape as this machine.

Use ferry init to record a Tailscale host or OpenSSH destination and seed the
private snapshot.

Ferry never copies logins. Vendor sessions stay on the machine that created
them. Ferry starts a login on the box and you finish it in a browser here.

Options:
  -V, --version                  output the version number
  --box <name>                   select a box of the config; repeat it to select
                                 more boxes
  --json                         print JSON on stdout: one result envelope, or
                                 one event for each line for watch, tunnel, and
                                 expose. Progress goes to stderr
  -h, --help                     display help for command

Commands:
  init [options]                 Record a Tailscale host or SSH destination,
                                 seed the snapshot, and convert this machine
  install [options]              Install the supported agent tools on the
                                 configured box
  update [options]               Update the agent tools on the configured box
                                 and on this machine
  uninstall [options]            Remove Ferry's local state and restore paths
                                 changed by init
  auth [options] [provider]      Start a login on the configured box without
                                 copying credentials
  sync [options]                 Publish the snapshot and apply it to the
                                 selected boxes, or to all boxes
  history [options]              List the recent snapshot commits and the paths
                                 each one changed
  revert [options] <commit>      Undo one snapshot commit on this machine and on
                                 all boxes
  move [options] <path>          Continue a project on a box, on this machine
                                 with --from-box, or on another box with both
  adopt [options] <skill>        Copy a skill that an agent wrote on a box to
                                 this machine
  tunnel [options] [ports...]    Open box ports on this machine until Ctrl-C,
                                 list the ports that listen on the box, or
                                 follow the ports of ferry expose
  expose [options] <command...>  Run a command on the box and announce its port
                                 to ferry tunnel --follow
  status [options]               Inspect link, snapshot, managed paths, and box
                                 logins without writing
  doctor                         Check SSH, Tailscale, snapshot access, linger,
                                 and services, and print a fix for each failure
  integrations                   List the integrations of each box, whether each
                                 one is enabled, its parts, and the local app
                                 versions
  sherlock                       Add Sherlock database connections that tunnel
                                 through a box
  tools                          List the tools, the version policy of each one
                                 and of each box, and the versions on this
                                 machine
  watch                          Watch the portable set and sync accepted
                                 changes
  menubar                        Install or remove the macOS menu bar app that
                                 shows what needs action on the boxes
  self-update                    Update Ferry on this machine to the latest
                                 release.

                                 Ferry updates in the same way as it was
                                 installed: with npm, or with the
                                 release installer in the directory of this
                                 binary. It restarts installed
                                 watch and tunnel services that point at this
                                 Ferry. On macOS, it also updates
                                 an installed release menu bar app. It writes
                                 the Ferry agent skill of the new
                                 version to ~/.agents/skills/ferry, unless ferry
                                 init --no-skill turned it off
                                 or the skill folder has local changes. Then run
                                 ferry update to put the new
                                 version on the boxes.

                                 On a terminal, each command also asks to update
                                 when a newer release is
                                 there. Ferry reads the latest release at most
                                 once a day. It does not ask
                                 with --json, with CI set, or with
                                 FERRY_NO_UPDATE_CHECK=1.
  whoami                         Print the role of this machine: the operator
                                 machine or a Ferry box.

                                 On a box, Ferry also prints the box name from
                                 the last ferry sync, and the
                                 parts of the generated instruction file
                                 ~/.ferry/box/AGENTS.md in their
                                 order: the Ferry header, the per-box
                                 instructions from
                                 ~/.ferry/boxes/<name>/AGENTS.md on the operator
                                 machine when the box has
                                 them, and the shared ~/AGENTS.md. The operator
                                 machine is the source of
                                 truth. On a box, change a Ferry-managed file on
                                 the operator machine, not
                                 on the box. This command runs on the operator
                                 machine and on a box install.
  box                            List, add, and remove the boxes of the config
  skills                         Install skills into the global harness roots
                                 that Ferry manages

JSON output (--json):
  stdout has only JSON. Progress and the text lines go to stderr. Ferry
  shows no prompt: a confirmation fails with confirmation-required unless
  you give --yes. The SSH host keys of init and box add need
  --accept-host-keys: --yes does not trust them, and error.details.hostKeys
  lists them. A command that runs and exits prints one envelope:
    {"schemaVersion":1,"command","ok","result","warnings","error"}
  error is null, or {"code","message","hint"}. On failure, ok is false and
  the exit code is not 0. A failed update, or a failed sync of more than
  one box, keeps the outcome of each box in result. watch, tunnel,
  tunnel --follow, and expose print one event for each line. Each event
  has "type". An error event also has "code", "message", and "hint".

  Error codes: usage, config-missing, config-invalid, unknown-box,
    box-required, box-offline, box-command-failed, forward-failed,
    confirmation-required, missing-values, deny-rule-match, refused,
    sync-busy, sync-failed, update-failed, login-failed, command-failed,
    failed.
  Event types: watch-started, synced, sync-failed, sync-refused,
    content-refused, config-error, update-started, update-failed,
    status-failed, watch-stopped, following, forward-opened, forward-closed,
    forward-failed, connection-lost, tunnel-closed, exposed, exited, login,
    error.

  The help of each command gives its result. The ferry agent skill
  describes the full contract.
```

## ferry init

```text
Usage: ferry init [options]

Record a Tailscale host or SSH destination, seed the snapshot, and convert this
machine.

The snapshot URL is an empty private git repository. Ferry does not create it.
For an SSH snapshot URL, load a key that can push to it into your SSH agent.
Ferry forwards the agent to the box to test read access, and asks before it
trusts the Git host key on the box. Ferry never falls back from Tailscale to
direct SSH.

With box tables, init runs again for the box of --box, else default_box, else
the only box. Use ferry box add to add a box.

Init writes the Ferry agent skill of this version to ~/.agents/skills/ferry,
so the snapshot carries it to the boxes. ferry self-update writes the skill
of the new version. Ferry does not change a skill folder with local changes.

Add a custom harness in ~/.ferry/config.toml. A repeat init keeps it:

  [[harness]]
  id = "opencode"
  name = "OpenCode"
  skill_root = ".config/opencode/skills"
  instruction_file = ".config/opencode/AGENTS.md"

Options:
  --host <host>                    Tailscale host name or IP address
  --ssh-user <user>                SSH user on the host
  --ssh-destination <destination>  explicit OpenSSH destination
  --snapshot-url <url>             private snapshot git URL
  --dry-run                        print the init plan without writing or
                                   connecting
  --accept-host-keys               trust the SSH host keys of the snapshot host
                                   on the box without a confirmation prompt
  --no-skill                       do not install the Ferry agent skill. Ferry
                                   records the choice, and self-update then
                                   skips the skill too
  -h, --help                       display help for command

With --json: { dryRun, leftovers, published, skill: { action, path, message } }, or with --dry-run { dryRun, leftovers, plan }.
```

## ferry install

```text
Usage: ferry install [options]

Install gh, jq, the agent CLIs, the tools of the config, and Ferry on the box.

Ferry prints the plan for each tool and asks before it runs a command on the
box. gh and jq come from apt, so Debian or Ubuntu is the tested target. Ferry on
the
box is the version of this machine. It is a box install that runs only
ferry expose and ferry whoami. Run ferry tools --help for the tool config.

Options:
  --yes       run without a confirmation prompt
  -h, --help  display help for command

With --json: { plan: [{ tool, policy, version, action, command, dependsOn }], gitIdentity }.
```

## ferry update

```text
Usage: ferry update [options]

Update the agent tools on the boxes and on this machine.

On this machine, Ferry updates only the agent CLIs that are installed. It does
not update Ferry itself. Each box gets the tool versions of its policy, the
Ferry version of this machine, and Paseo when the integration is on. The Paseo
update restarts the daemon, which stops the agents on the box.

With [update] watch = true in ~/.ferry/config.toml, ferry watch runs this
update once each day for the tools with the "latest" policy. The gh update
runs sudo apt on the box, and the watch has no terminal for a password. Add
this rule on the box with sudo visudo -f /etc/sudoers.d/ferry:

  <ssh-user> ALL=(root) NOPASSWD: /usr/bin/true, \
    /usr/bin/apt update, /usr/bin/apt install gh -y

ferry status shows "Box sudo: PASSWORDLESS" when the rule works.

Options:
  --yes       run without a confirmation prompt
  --dry-run   print the update plan without running it
  -h, --help  display help for command

With --json: { dryRun, boxes: [{ name, ok, error, offline, skipped, plan, integrations }], operator, updated, failed }, also on failure. skipped is the reason that Ferry did not change the box.
```

## ferry uninstall

```text
Usage: ferry uninstall [options]

Remove Ferry's local state and restore paths changed by init

Options:
  --yes       run without a confirmation prompt
  -h, --help  display help for command

With --json: { removed, restored }.
```

## ferry auth

```text
Usage: ferry auth [options] [provider]

Start a login on the configured box without copying credentials.

Tools: gh, claude, codex, cursor, and each [tools.<id>] table with login keys
(see ferry tools --help). Ferry starts the vendor login on the box and prints
a URL, and a code if the tool has one. Finish the login in a browser
on this machine. When codex gives no device code, Ferry forwards local port
1455 to the box for up to 120 seconds. Pi has no remote login. Run pi on the
box and use /login.

ferry auth gh also creates ~/.ssh/id_ed25519 on the box if it is missing, and
adds it to your GitHub account with the title "<box host> (ferry)", so agents
on the box can push. Delete that key in GitHub to revoke it.

--mcp <server> logs in to a remote MCP server on the box. Give the provider,
as in ferry auth codex --mcp linear, or the name that ferry status shows, as
in ferry auth --mcp codex/linear. Ferry forwards the localhost callback port,
such as 3118 for Claude, for up to 300 seconds. The port must be free on
this machine.

Without a provider, Ferry lists the tools and their login: startable,
manual SSH flow, or off.

Options:
  --mcp <server>  start the MCP server login of the provider CLI on the box,
                  such as linear or codex/linear
  -h, --help      display help for command

With --json: { providers: [{ id, login }] } without a provider, where login is "startable", "manual", or "off", else the login result { kind, provider, ... }. A "login" event line with the URL comes before the envelope. A login that needs the code from the browser reads it as one line on stdin.
```

## ferry sync

```text
Usage: ferry sync [options]

Publish the snapshot and apply it to the selected boxes, or to all boxes.

A file that looks like a secret stops the sync before the publish. The error
names the file, never the value. Ferry skips MCP servers that are neither
remote HTTPS servers nor stdio commands, stdio MCP servers and hooks that refer
to home paths that the box does not have, and prints a line for each. A stdio
MCP server carries its command, its arguments, and the names of its env keys,
never their values.
Ferry syncs up to 4 boxes at the same time. A failed box does not stop the
other boxes. Sync also writes the ferry PATH block in ~/.profile on the box.

Sync writes ~/.ferry/box/AGENTS.md on each box from three parts: the Ferry
header, then ~/.ferry/boxes/<name>/AGENTS.md of this machine for that box
only, then your ~/AGENTS.md. One blank line separates the parts. A per-box
file that looks like a secret stops the sync of that box only.

If a plugin in enabledPlugins comes from a marketplace that
extraKnownMarketplaces does not list, run claude plugin marketplace add for it
once on this machine.

Options:
  --dry-run                print the plan without writing
  --force                  back up live managed paths before Apply links them
  -m, --message <message>  snapshot commit message
  -h, --help               display help for command

With --json: { dryRun, published, boxes: [{ name, ok, step, error, skipped, plan, applyPlan, discarded }] }, also on failure of more than one box. skipped is the reason that Ferry did not connect to the box.
```

## ferry history

```text
Usage: ferry history [options]

List the recent snapshot commits and the paths each one changed.

Ferry reads the local snapshot checkout in ~/.ferry/store. Give a commit id to
ferry revert to undo that commit.

Options:
  -n, --limit <count>  the number of commits (default: 20)
  -h, --help           display help for command

With --json: { commits: [{ commit, date, subject, paths }] }, newest first.
```

## ferry revert

```text
Usage: ferry revert [options] <commit>

Undo one snapshot commit on this machine and on all boxes.

Ferry undoes the commit as git revert does, and later commits stay. The
skills, AGENTS.md, and extra roots on this machine link into the snapshot, so
they change with it. Ferry writes the reverted settings keys back into the
local settings files and keeps all other keys. Then Ferry syncs all boxes.

Ferry stops and changes nothing when a later commit changes the same lines,
or when this machine has changes that are not in the snapshot. Run ferry sync
first. Run ferry history for the commit ids.

Arguments:
  commit      the snapshot commit to undo

Options:
  --dry-run   print what the revert changes without writing
  --no-sync   do not sync the boxes after the revert
  -h, --help  display help for command

With --json: { dryRun, commit, subject, tip, paths, settings: [{ file, keys }], sync }. sync is the sync result, or null with --dry-run or --no-sync.
```

## ferry move

```text
Usage: ferry move [options] <path>

Continue a project on a box, on this machine with --from-box, or on another box
with both.

The path must be inside the home directory. The destination uses the same path
relative to its home. Ferry refuses unpushed commits, uncommitted changes to
tracked files, and a destination path that exists. The destination clones from
origin with its own SSH key, so run ferry auth gh for a box first. Ferry
carries the untracked and ignored files that pass the deny rules, skips build
output such as node_modules and dist, and checks each file with SHA-256.
Between two boxes, the files go through a temporary directory on this machine,
and nothing stays here. With --remove, the source copy goes to ~/.Trash on
macOS, else to ~/.ferry/trash. Run --dry-run first.

Ferry also carries the Claude and Codex sessions of the project and the Claude
project memory, so claude --resume and codex resume find them on the
destination. A session file there stays, unless the source has the same file.
Ferry skips a session that fails the deny rules and names the file and the
rule. The source keeps its sessions.

The deny rules run on the source machine. It reads each file one time and
sends only the bytes that pass. With --from-box, the Ferry on the box does
this, so the box needs a release of Ferry from ferry install or ferry update.
--dry-run copies no file.

Arguments:
  path               project folder inside the home directory

Options:
  --from-box <name>  move the project from this box. Without --to-box, the
                     destination is this machine
  --to-box <name>    move the project to this box. Without it and --from-box,
                     Ferry uses default_box or the only box
  --dry-run          print what Ferry would carry, refuse, and skip without
                     changes
  --remove           after verification, move the source copy to a trash
                     directory
  --include-env      also carry .env files that pass the token and secret rules
  --no-sessions      do not carry the agent sessions and the project memory
  --allow-secrets    also carry sessions, and with --include-env .env files,
                     that hold tokens or secrets
  --yes              carry .env files with secrets without a confirmation prompt
  -h, --help         display help for command

With --json: { path, source, destination, dryRun, git, carry, refused, skipped, notes, trash, sessions }.
```

## ferry adopt

```text
Usage: ferry adopt [options] <skill>

Copy a skill that an agent wrote on a box to this machine.

ferry status lists the box-only skills of each box: skills in a harness skill
root or in the box checkout that the snapshot does not have. The Ferry on the
box runs the deny rules on the skill. A skill that fails a deny rule does not
reach this machine: Ferry copies no file of it. Else Ferry copies the files
that pass and shows the file list of a new skill or the diff against the copy
on this machine. The box needs a release of Ferry from ferry install or ferry
update. After the confirmation, Ferry writes the skill to
the same skill root on this machine and moves the box copy to
~/.ferry/backups on the box. Then run ferry sync. It publishes the skill,
links it on this machine, and links it on all boxes.

Arguments:
  skill              the skill name that ferry status lists

Options:
  --from-box <name>  copy the skill from this box
  --yes              adopt the skill without a confirmation prompt
  -h, --help         display help for command

With --json: { box, name, source, destination, replaces, files: [{ path, executable }], skipped, diff, adopted, boxBackup }, or null when cancelled.
```

## ferry tunnel

```text
Usage: ferry tunnel [options] [command] [ports...]

Open box ports on this machine until Ctrl-C, list the ports that listen on the
box, or follow the ports of ferry expose.

Local ports bind to 127.0.0.1 only. The box end is 127.0.0.1 on the box, so a
dev server that listens only on ::1 does not answer. A plain tunnel does not
reconnect. With --follow, the local port is the box port when it is free, else
the next free port, and Ferry connects again 5 seconds after a drop. Run
ferry tunnel install to run --follow as a user service.

Put a host before the box port to forward to a host that the box can reach,
such as a database that accepts connections only from the box network. A
numeric first part is a box port. The box resolves the host name. Put an IPv6
address in brackets. Ferry first checks that the box can connect to the host,
and stops with an error when it cannot. On a box without bash, timeout, or
/dev/tcp, Ferry cannot always make this check. Then it prints a warning and
opens the tunnel.

  5432                   127.0.0.1:5432 on the box, local port 5432
  5432:15432             127.0.0.1:5432 on the box, local port 15432
  db.example:5432        db.example:5432 from the box, local port 5432
  db.example:5432:15432  db.example:5432 from the box, local port 15432
  [fd00::1]:5432         [fd00::1]:5432 from the box, local port 5432

A plain tunnel works as the child process of another program. It never
prompts: OpenSSH runs in batch mode. The local port accepts connections after
the SSH connection is ready. SIGTERM closes the tunnel with exit code 0.

--follow writes its forwards to ~/.ferry/tunnels/<box>.json when it connects,
after each change, and when the connection drops. The menu bar app reads the
file. Fields: schemaVersion (1), box, pid, connected (false after a drop, with
no forwards), updatedAt, and forwards: [{ name, cwd, boxPort, localPort }].
name and cwd are missing when the entry of ferry expose has none. Ferry
removes the file when --follow stops on Ctrl-C or SIGTERM.

Arguments:
  ports       box port, box:local to pick another local port, or
              host:port[:local] for a host that the box can reach, such as 3000,
              3000:4000, or db.example:5432

Options:
  --list      list the TCP ports that listen on the box, with process names
  --follow    open a forward for each port that ferry expose announces on the
              box, and close it when the port goes away
  -h, --help  display help for command

Commands:
  install     Install and start a user service that runs ferry tunnel --follow
              for one box
  uninstall   Stop and remove the tunnel user service of one box

With --json: events forward-opened, forward-closed, forward-failed, following, connection-lost, tunnel-closed. With --list, one envelope: { box, listeners: [{ port, address, process }] }.
```

### ferry tunnel install

```text
Usage: ferry tunnel install [options]

Install and start a user service that runs ferry tunnel --follow for one box.

The box is --box, then default_box, then the only box. The service always
runs with --box <box>, so a later default_box does not change it. Each box has
its own service:

  macOS  ~/Library/LaunchAgents/dev.ferry.tunnel.<box>.plist
         log: ~/Library/Logs/ferry-tunnel-<box>.log
  Linux  ~/.config/systemd/user/ferry-tunnel-<box>.service
         log: journalctl --user -u ferry-tunnel-<box>.service -f

The service writes ~/.ferry/tunnels/<box>.json, as ferry tunnel --follow does.
The menu bar app shows its ports.

The service starts again each time it exits. The service records the path of
this Ferry, the current PATH, and SSH_AUTH_SOCK. PATH must find ssh, and
tailscale for a Tailscale box. Run the command again after you move Ferry or
change these values. A successful ferry self-update restarts the service when
it points at the updated Ferry.

Options:
  -h, --help  display help for command

With --json: { manager, path }.
```

### ferry tunnel uninstall

```text
Usage: ferry tunnel uninstall [options]

Stop and remove the tunnel user service of one box.

The box is --box, then default_box, then the only box. Ferry removes the file
that ferry tunnel install wrote. The macOS log stays.

Options:
  -h, --help  display help for command

With --json: { manager, path, removed }.
```

## ferry expose

```text
Usage: ferry expose [options] <command...>

Run a command on the box and announce its port to ferry tunnel --follow.

Ferry writes ~/.ferry/exposed/<pid>.json before the command starts and
removes it when the command exits. At the start, Ferry removes the entries
whose pid does not run. Ferry forwards SIGINT, SIGTERM, and SIGHUP to the
command and exits with its exit code. Put the command after --.

For example, a service script in paseo.json on the box:

  "web": {
    "type": "service",
    "command": "ferry expose -- bun run dev --port $PASEO_PORT"
  }

Arguments:
  command     the command to run, after --, such as -- bun run dev

Options:
  --port <n>  the port of the command. The default is $PASEO_PORT
  -h, --help  display help for command

With --json: events exposed and exited. The output of the command goes to stderr.
```

## ferry status

```text
Usage: ferry status [options]

Inspect link, snapshot, managed paths, and box logins without writing.

The Tools part of each box shows one state for each tool: ok; drift, run
ferry update; missing, run ferry install; hidden, a login shell on the box
does not find the tool, run ferry sync; skipped, the tool has no target;
unknown, Ferry cannot read the box version. Box-only skills lists the skills
on each box that the snapshot does not have. ferry adopt --from-box copies one
to this machine. With --json, result is the
status report, schema version 2. The ferry agent skill describes its fields.
Install the skill with ferry skills add dlhck/ferry --skill ferry.

--brief checks only the link, the free disk, memory, and load, the logins, the
MCP logins, the carried stdio MCP servers, and the tools of each box, and the
hooks of this machine that run a home file Ferry does not carry. It prints one
line for each item that needs action, with the Ferry command that fixes it.
ferry watch writes the same report to ~/.ferry/status.json.

The probe reads the free disk of the box home file system, the available
memory, and the load average in its SSH command. --brief shows an item when
the free disk is below both 10% and 5 GiB, or the available memory is below
10%. Set other limits in [status] of ~/.ferry/config.toml with
disk_free_percent, disk_free_gib, and memory_available_percent. A limit of 0
turns its part of the check off. When one disk limit is 0, the other decides.
The load is only in the JSON report.

Options:
  --brief     check only the link, the disk and memory, the logins, the MCP
              logins, and the tools, and print what needs action
  -h, --help  display help for command

With --json: the status report, schema version 2. With --brief, { schemaVersion: 1, checkedAt, boxes: [{ name, host, online, error, issues: [{ kind, name, state, message, command }], resources: { disk, memory, load } }] }.
```

## ferry doctor

```text
Usage: ferry doctor [options]

Check SSH, Tailscale, snapshot access, linger, and services, and print a fix for
each failure.

Ferry runs each check, also after a check fails, and changes nothing. It
checks that the SSH agent has a key, that this machine can read the snapshot
and push to it (git push --dry-run), and that the installed watch and tunnel
services run this Ferry. For each box, it checks that the box responds over
SSH with host key checks on, that Tailscale reaches a Tailscale box, that the
box can read the snapshot with the forwarded agent or the deploy key of
git_auth = "box", and that linger is on when a Ferry service runs on the box.

The exit code is 1 when a check fails. With --json, result has one entry for
each check, also on failure.

Options:
  -h, --help  display help for command

With --json: { schemaVersion: 1, ok, checks: [{ id, box, status, message, fix }] }, also on failure. status is ok, failed, or skipped.
```

## ferry integrations

```text
Usage: ferry integrations [options] [command]

List the integrations of each box, whether each one is enabled, its parts, and
the local app versions

Options:
  -h, --help                display help for command

Commands:
  enable [options] <name>   Install and start an integration on the box, then
                            turn it on in the config
  disable [options] <name>  Stop and remove an integration on the box, then turn
                            it off in the config

With --json: { boxes: [{ name, destination, integrations: [{ id, description, enabled, parts, available, localVersion, localSource, connectSteps }] }] }.
```

### ferry integrations enable

```text
Usage: ferry integrations enable [options] <name>

Install and start an integration on the box, then turn it on in the config.

paseo: Ferry installs Node 22 or later and the Paseo CLI at the version of the
local Paseo app, then starts the user service ferry-paseo.service. The daemon
listens on 127.0.0.1:6767 with the relay off by default. It has no password, so
use it
only on a box with one user. To connect Paseo Desktop, add the Remote SSH host
ssh://<box destination>. With Paseo on, sync carries the Paseo agent profiles,
managed Git and npm plugins, the portable fields of agents.providers,
agents.metadataGeneration.providers, daemon.appendSystemPrompt, and the
portable daemon.terminalProfiles. move registers the project in Paseo on the
box and imports each carried session as a Paseo agent. move --from-box does
the same in the Paseo of this machine.

For relay pairing, set paseo_relay = true in [integrations] of
~/.ferry/config.toml. A [box.<name>.integrations] table can override it.
Run ferry integrations enable paseo --box <name> again to apply a change.
A changed service config restarts the daemon and stops its agents.

Enable writes the whole ferry-paseo.service again, so a line that you added
to it by hand is gone. Put such a line in a drop-in file on the box, for
example ~/.config/systemd/user/ferry-paseo.service.d/local.conf.

The service has OOMPolicy=continue. When the kernel kills an agent process
that ran out of memory, the daemon and the other agents continue. Enable and
sync add the line to an older service without a restart of the daemon.

To carry daemon.autoArchiveAfterMerge, set paseo_auto_archive = true in
[integrations] of ~/.ferry/config.toml. A [box.<name>.integrations] table can
override it. Sync applies it with paseo daemon reload, without a restart.

An integration without a box part runs only on this machine. For it, Ferry
changes only the config and adds its commands when it can run here.

sherlock: needs the sherlock executable on this machine. Ferry adds ferry
sherlock add, and ferry status checks each connection that it added.

Arguments:
  name        integration name, such as paseo

Options:
  --dry-run   print the box commands without connecting or writing
  --yes       run without a confirmation prompt
  -h, --help  display help for command

With --json: { integration, action, dryRun, plan, output, enabled, connectSteps }.
```

### ferry integrations disable

```text
Usage: ferry integrations disable [options] <name>

Stop and remove an integration on the box, then turn it off in the config.

Ferry never removes ~/.paseo on the box. An integration without a box part
changes only the config.

Arguments:
  name        integration name, such as paseo

Options:
  --purge     also uninstall the integration package on the box
  --yes       run without a confirmation prompt
  -h, --help  display help for command

With --json: { integration, action, dryRun, plan, output, enabled, connectSteps }.
```

## ferry sherlock

```text
Usage: ferry sherlock [options] [command]

Add Sherlock database connections that tunnel through a box

Options:
  -h, --help            display help for command

Commands:
  add [options] <name>  Add a Sherlock connection whose tunnel is ferry tunnel
  help [command]        display help for command
```

### ferry sherlock add

```text
Usage: ferry sherlock add [options] <name>

Add a Sherlock connection whose tunnel is ferry tunnel.

Ferry runs sherlock connection add with
--tunnel-command "ferry tunnel --box <box> <target>:{{port}}". Sherlock opens
the tunnel on the first query and closes it when it is idle. The box is --box,
then default_box, then the only box.

The target is a box port, such as 5432, or a host and port that the box can
reach, such as db.example:5432.

On a terminal, Ferry asks for the password and gives it to Sherlock on stdin.
Sherlock stores it in the keychain of this machine. With --password-stdin,
Sherlock reads the password from the stdin of Ferry. Ferry never stores the
password and never changes the Sherlock config file. Ferry records the name,
box, and target in ~/.ferry/sherlock.json for ferry status.

With --json, Ferry asks nothing, so give --password-stdin or --password-env.
With --json: { name, box, target, tunnelCommand }.

Arguments:
  name                  connection name in Sherlock

Options:
  --target <target>     box port or host:port that the box can reach, such as
                        5432 or db.example:5432
  --type <type>         postgres, mysql, mssql, or redis
  --database <name>     database name
  --username <user>     database user
  --ssl <mode>          off, require, or verify
  --password-stdin      Sherlock reads the password from stdin
  --password-env <var>  Sherlock reads the password from this environment
                        variable at query time
  --force               replace a Sherlock connection with the same name
  -h, --help            display help for command
```

## ferry tools

```text
Usage: ferry tools [options]

List the tools, the version policy of each one and of each box, and the versions
on this machine.

Ferry has recipes for gh and the agent CLIs claude, codex, pi, and cursor.
Define each other tool in ~/.ferry/config.toml. Ferry does not scan projects.

A policy is "operator" (the version on this machine), "latest", or an exact
version. The default is "latest" for an agent CLI and "operator" for a tool.
With "operator", Ferry skips a tool that this machine does not have.
[box.<name>.tools] sets the policy for one box.

"off" turns off gh or an agent CLI (claude, codex, pi, cursor). install,
update, and the daily watch update skip it, ferry auth refuses it, and
ferry status shows it as off. Ferry does not uninstall it from the box. An
off agent also turns off its harness: sync does not read it on this machine
and does not write it on the box, and removes the links that Ferry made
there before. Ferry never removes other files there. A box policy can turn
the tool on again. "off" is not valid in a [tools.<id>] table. To remove
such a tool, delete its table.

  [tools]
  gh = "latest"
  codex = "0.156.1"
  pi = "off"

  [box.b.tools]
  pi = "latest"

  [tools.pnpm]
  version = "operator"
  local = "pnpm --version"
  box = "pnpm --version"
  latest = "npm view pnpm version"
  install = 'npm install -g --prefix "$HOME/.local" pnpm@{version}'
  path = [".local/bin"]
  depends = ["node"]

  [tools.northflank]
  local = "northflank --version"
  install = "npm install -g @northflank/cli@{version}"
  auth_status = "northflank list projects"
  auth_login = "northflank login --do-not-open-browser"
  auth_hosts = ["northflank.com"]

local and install are required. local prints the version on this machine, box
prints the version on the box, and latest prints the newest version, which the
"latest" policy needs. update is the update command, and the default is
install. {version} is the only placeholder. path adds home directories to the
box PATH, and depends names the tools to install first. A comment must be on
its own line. Run ferry sync after a path change.

The auth keys let ferry auth <id> log the tool in on the box. auth_status
passes when the tool is logged in. auth_login starts a login that prints a URL
and finishes after the browser step, with no input on the box. auth_hosts names
the hosts that URL may have. Ferry passes the URL on with its fragment and
query, which can hold the login session. Give all three keys or none.

Options:
  -h, --help  display help for command

With --json: { tools: [{ id, name, kind, install, policy: { policy, default }, boxes, operatorVersion }] }.
```

## ferry watch

```text
Usage: ferry watch [options] [command]

Watch the portable set and sync accepted changes.

The watch syncs all boxes one second after a change stays stable. A box that
fails retries with its own backoff, up to 60 seconds. The watch reads the
config in each cycle. With [update] watch = true, it also runs ferry update
once each day. Run ferry update --help for the sudo rule on the box.

At the start, every 5 minutes, and after each sync, the watch runs
ferry status --brief for all boxes and writes the report to
~/.ferry/status.json.

Options:
  -h, --help  display help for command

Commands:
  install     Install and start the watch user service

With --json: events watch-started, synced, sync-failed, sync-refused, content-refused, config-error, update-started, update-failed, status-failed, watch-stopped.
```

### ferry watch install

```text
Usage: ferry watch install [options]

Install and start the watch user service.

The macOS service is ~/Library/LaunchAgents/dev.ferry.watch.plist. Its log
is ~/Library/Logs/ferry-watch.log. The Linux service is
~/.config/systemd/user/ferry-watch.service. Read its log with
journalctl --user -u ferry-watch.service -f.

The service records the path of this Ferry, the current PATH, and
SSH_AUTH_SOCK. PATH must find git, ssh, and tailscale for a Tailscale box.
Run the command again after you move Ferry or change these values. A
successful ferry self-update restarts the service when it points at the
updated Ferry.

Options:
  -h, --help  display help for command

With --json: { manager, path }.
```

## ferry menubar

```text
Usage: ferry menubar [options] [command]

Install or remove the macOS menu bar app that shows what needs action on the
boxes

Options:
  -h, --help         display help for command

Commands:
  install [options]  Install and start the macOS menu bar app
  uninstall          Stop and remove the macOS menu bar app
  help [command]     display help for command
```

### ferry menubar install

```text
Usage: ferry menubar install [options]

Install and start the macOS menu bar app.

The app shows the report of ~/.ferry/status.json: offline boxes, logins, MCP
logins, and tool drift. ferry watch writes the file, so run ferry watch
install too. Click an item with a Ferry command to run it in Terminal.

The app also shows the ports of each running ferry tunnel --follow, from
~/.ferry/tunnels/<box>.json. Click a port to open it in the browser.

Ferry downloads ferry-menubar-macos.zip of the release of this Ferry,
verifies it against SHA256SUMS of the release, and unpacks it to
~/Applications/Ferry Menu Bar.app. --app installs a local build of
macos/build.sh, a .app directory or its zip, without a checksum. A
development build of Ferry needs --app.

The app starts at login with ~/Library/LaunchAgents/dev.ferry.menubar.plist.
It records the path of this Ferry as FERRY_PATH, the current PATH, and
SSH_AUTH_SOCK. Run the command again after you move Ferry or update it.

Options:
  --app <path>  install a local build of macos/build.sh: a .app directory or its
                zip
  -h, --help    display help for command

With --json: { app, path, version, ferryPath }. version is null with --app.
```

### ferry menubar uninstall

```text
Usage: ferry menubar uninstall [options]

Stop and remove the macOS menu bar app.

Ferry stops the app, and removes ~/Library/LaunchAgents/dev.ferry.menubar.plist
and ~/Applications/Ferry Menu Bar.app. The log stays.

Options:
  -h, --help  display help for command

With --json: { app, path, removed }.
```

## ferry self-update

```text
Usage: ferry self-update [options]

Update Ferry on this machine to the latest release.

Ferry updates in the same way as it was installed: with npm, or with the
release installer in the directory of this binary. It restarts installed
watch and tunnel services that point at this Ferry. On macOS, it also updates
an installed release menu bar app. It writes the Ferry agent skill of the new
version to ~/.agents/skills/ferry, unless ferry init --no-skill turned it off
or the skill folder has local changes. Then run ferry update to put the new
version on the boxes.

On a terminal, each command also asks to update when a newer release is
there. Ferry reads the latest release at most once a day. It does not ask
with --json, with CI set, or with FERRY_NO_UPDATE_CHECK=1.

Options:
  -h, --help  display help for command

With --json: { current, latest, updated, services: [{ service, action, message }], skill }. skill is the message of the skill update, or null. The output of the installer goes to stderr.
```

## ferry whoami

```text
Usage: ferry whoami [options]

Print the role of this machine: the operator machine or a Ferry box.

On a box, Ferry also prints the box name from the last ferry sync, and the
parts of the generated instruction file ~/.ferry/box/AGENTS.md in their
order: the Ferry header, the per-box instructions from
~/.ferry/boxes/<name>/AGENTS.md on the operator machine when the box has
them, and the shared ~/AGENTS.md. The operator machine is the source of
truth. On a box, change a Ferry-managed file on the operator machine, not
on the box. This command runs on the operator machine and on a box install.

Options:
  -h, --help  display help for command

With --json: { role: "operator" or "box", box, instructions: { file, sources: [{ part: "header", "box", or "shared", path }] }, managedPaths: { instructionFiles, skillRoots, roots } }. box is null on the operator machine and before the first sync of a box. instructions is null on the operator machine and on a box without the generated file. sources has the merged parts in order, and path is the file on the operator machine.
```

## ferry box

```text
Usage: ferry box [options] [command]

List, add, and remove the boxes of the config

Options:
  -h, --help               display help for command

Commands:
  list                     List the boxes, their transport and destination, and
                           the default box
  add [options] <name>     Check a new box like ferry init, then add it to the
                           config
  remove [options] <name>  Remove a box from the config. With --uninstall,
                           remove Ferry from the box first
  default <name>           Set default_box, the box of install, auth, move,
                           tunnel, and integrations enable|disable without --box
  help [command]           display help for command
```

### ferry box list

```text
Usage: ferry box list [options]

List the boxes, their transport and destination, and the default box

Options:
  -h, --help  display help for command

With --json: { boxes: [{ name, transport, destination, default }] }.
```

### ferry box add

```text
Usage: ferry box add [options] <name>

Check a new box like ferry init, then add it to the config.

The first box add on a [host] config moves [host] to [box.default] and sets
default_box = "default". Ferry asks before it writes.

Ferry also creates the empty file ~/.ferry/boxes/<name>/AGENTS.md on this
machine and prints its path. Write instructions for this box only there.
ferry sync puts them into the instruction file of the box, after the Ferry
header and before your ~/AGENTS.md. The file never goes into the snapshot.

With --git-auth box, Ferry never forwards your SSH agent to the box. Ferry
creates ~/.ssh/ferry_snapshot on the box and tests read access to the
snapshot with it. If the test fails, Ferry prints the public key and does not
change the config. Add the key as a read-only deploy key on the snapshot
repository, then run the command again. To change an existing box, set
git_auth = "box" in its [box.<name>] table and run ferry init --box <name>.

Arguments:
  name                             box name: 1 to 32 characters from a-z, 0-9,
                                   and -

Options:
  --host <host>                    Tailscale host name or IP address
  --ssh-user <user>                SSH user on the host
  --ssh-destination <destination>  explicit OpenSSH destination
  --git-auth <mode>                agent forwards your SSH agent to the box git;
                                   box uses a read-only deploy key on the box
                                   (choices: "agent", "box")
  --yes                            change a [host] config to box tables without
                                   a confirmation prompt
  --accept-host-keys               trust the SSH host keys of the snapshot host
                                   on the box without a confirmation prompt
  -h, --help                       display help for command

With --json: { name, transport, destination, gitAuth, migrated, instructionFile }.
```

### ferry box remove

```text
Usage: ferry box remove [options] <name>

Remove a box from the config. With --uninstall, remove Ferry from the box first.

Without --uninstall, Ferry does not connect to the box and does not change it.

With and without --uninstall, Ferry stops and removes the tunnel user service
of the box on this machine, which ferry tunnel install wrote. Your per-box
instruction file ~/.ferry/boxes/<name>/AGENTS.md stays. Ferry prints its path.
A later box with the same name gets its text. Delete the file when you do not
need it.

With --uninstall, Ferry reads the box, prints the plan, and asks you to type
the box name. Then it does these steps on the box, in this order:

  1. It stops and removes each ferry-*.service user service, such as
     ferry-paseo.service. A stopped service stops its agents.
  2. It removes each skill link, instruction file link, and root link that
     points into ~/.ferry/store or to ~/.ferry/box/AGENTS.md. When ferry sync
     --force moved a file of yours to ~/.ferry/backups, Ferry moves the
     newest backup of that path back. Else the path stays absent.
  3. It removes the ferry PATH block of ~/.profile.
  4. It removes ~/.ferry/box, ~/.ferry/exposed, ~/.ferry/store, the Ferry
     binary ~/.local/bin/ferry, and the marker ~/.ferry/box.json.

Then Ferry removes the box from the config. Ferry keeps these on the box:
the logins and credentials, the SSH keys, the project directories,
~/.paseo, and the tools that Ferry installed: gh, jq, the agent CLIs, the
Paseo CLI, and the tools of the config. It also keeps the settings keys, MCP
servers, and plugins that ferry sync merged into the config files of the
box, ~/.ferry/trash, and each backup that it did not move back.

With --uninstall, Ferry holds the sync lock of the box from before it
connects until the box is out of the config. During that time, a sync that
includes the box fails with the code sync-busy, also a sync of ferry watch.
The watch syncs again later. When a sync for the box runs, the command fails
with that code and changes nothing. Run it again when the sync ends.
--dry-run takes no lock.

When Ferry cannot reach the box, or a box step fails, the box stays in the
config. Run the command without --uninstall to remove the box from the
config only.

Without --uninstall, Ferry refuses the last box of the config, because the
box keeps Ferry. With --uninstall, Ferry removes the last box too, also the
box default of a [host] config. Then the config has no [host] table and no
[box.<name>] table, and the rest of the config stays. ferry sync, ferry
status, ferry install, and ferry watch fail and name ferry box add, until
you add a box with ferry box add <name>. ferry init adds a box too.

Arguments:
  name         box name

Options:
  --uninstall  remove Ferry from the box, then remove the box from the config
  --yes        with --uninstall, do not ask for the box name
  --dry-run    with --uninstall, print the plan and change nothing
  -h, --help   display help for command

With --json: { name, defaultBoxRemoved, tunnelService, instructionFile }. tunnelService is the file of the tunnel user service that Ferry removed from this machine, or null. instructionFile is the per-box instruction file that stays on this machine, or null. With --uninstall, also uninstall: { dryRun, plan: { home, services, links: [{ path, link, backup }], profileBlock, paths }, remaining }, or null when cancelled. The plan paths are relative to the box home. backup is the file that Ferry moves back to path, or null. remaining has the names that stay in ~/.ferry on the box. A dry run changes nothing.
```

### ferry box default

```text
Usage: ferry box default [options] <name>

Set default_box, the box of install, auth, move, tunnel, and integrations
enable|disable without --box

Arguments:
  name        box name

Options:
  -h, --help  display help for command

With --json: { defaultBox }.
```

## ferry skills

```text
Usage: ferry skills [options] [command]

Install skills into the global harness roots that Ferry manages

Options:
  -h, --help                        display help for command

Commands:
  add [options] <source> [args...]  Run npx skills add as a global copy install.

                                    Ferry adds -g and --copy unless you pass
                                    them.
                                    Global copy installs match Ferry's snapshot
                                    model. The skill is a real
                                    directory in a global harness root, and the
                                    next sync links it to the store.
                                    Put arguments after -- to keep Ferry from
                                    reading them.
                                    Run ferry sync or ferry watch to publish the
                                    skill.
  help [command]                    display help for command
```

### ferry skills add

```text
Usage: ferry skills add [options] <source> [args...]

Run npx skills add as a global copy install.

Ferry adds -g and --copy unless you pass them.
Global copy installs match Ferry's snapshot model. The skill is a real
directory in a global harness root, and the next sync links it to the store.
Put arguments after -- to keep Ferry from reading them.
Run ferry sync or ferry watch to publish the skill.

Arguments:
  source      skill source, such as owner/repo or a git URL
  args        other npx skills add arguments, passed through unchanged

Options:
  --project   install into the current project and do not add -g
  -h, --help  display help for command

With --json: { argv }. The output of npx goes to stderr.
```

<!-- {% endraw %} -->
