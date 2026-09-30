---
title: Integrations
description: Run the Paseo daemon on a box, and query a database through a box with Sherlock.
---

# Integrations

An integration adds a service on the box, commands on the operator machine, or both. Each one is off by default. When it is off, Ferry prints nothing about it. The core of Ferry works without them.

```sh
ferry integrations                    # list them, and show which are on
ferry integrations enable paseo       # turn one on
ferry integrations disable paseo      # turn one off
```

`ferry integrations` shows the part of each integration: `box` for a box service, `operator` for commands and status checks on the operator machine. With box tables, `enable` and `disable` change the box of `--box`, else `default_box`, else the only box.

## Paseo

`ferry integrations enable paseo` installs Node 22 or later and the Paseo CLI on the box, at the version of the local Paseo app. Then it starts the user service `ferry-paseo.service`. Run it with `--dry-run` to see the box commands first.

- The daemon listens on `127.0.0.1:6767` with the relay off by default. It has no password, so use it only on a box with one user.
- To connect Paseo Desktop, add the Remote SSH host `ssh://<box destination>`.
- `ferry update` also updates Paseo on the box. The update restarts the daemon, which stops the agents on the box.
- `ferry integrations disable paseo` stops and removes the service. `--purge` also uninstalls the package. Ferry never removes `~/.paseo` on the box.

### What sync carries

With Paseo on, each sync carries these to the box, as its last step:

- Your Paseo agent profiles
- Managed Git plugins at their installed commits, and npm plugins at their installed versions
- The portable fields of your Paseo provider definitions
- Metadata model preferences
- Shared system instructions
- Portable terminal profiles
- With `paseo_auto_archive = true`, the auto-archive-after-merge switch

These go to the box directly. They are not in the snapshot. Plugin settings, provider env blocks, provider commands, terminal profile env blocks and paths, and credentials stay on each host.

The box merges the carried values into its `~/.paseo/config.json` with jq and sends back only a status, never the file. Without jq on the box, Ferry leaves the file as it is and tells you to run `ferry update`.

[Paseo sync](paseo-sync.md) has the supported sources, the fields, and the limits.

### Projects and sessions

When `ferry move` puts a project on a box with Paseo, Ferry registers the project in Paseo and imports each carried session as a Paseo agent. It skips a session that already has an agent on the box.

When `ferry move --from-box` puts a project back on the operator machine, Ferry does the same in the local Paseo. For this, it uses the `paseo` command on the `PATH`, else the CLI of the Paseo desktop app. When the operator machine has no `paseo` command, or an import fails, the move prints a warning and completes.

### Relay pairing

The relay is off by default. To use relay pairing, set this in `~/.ferry/config.toml` on the operator machine:

```toml
[integrations]
paseo = true
paseo_relay = true
```

Set `paseo_relay` in `[box.<name>.integrations]` to override it for one box. Run `ferry integrations enable paseo --box <name>` to apply the setting. A changed service config restarts the daemon and stops its agents.

### The service file

- Do not edit `~/.config/systemd/user/ferry-paseo.service` on the box. Enable writes the whole unit again. Put your own lines in a drop-in file on the box, for example `~/.config/systemd/user/ferry-paseo.service.d/local.conf`.
- The unit has `OOMPolicy=continue`. When the kernel kills an agent process that ran out of memory, the daemon and the other agents continue. A sync adds the line to an older unit without a restart of the daemon.
- The box compares and edits the PATH line of the unit itself, so Ferry never reads the unit.

### Status

When Paseo is on for a box, its `ferry status` block has an `Integrations` section:

| Line | Meaning |
| --- | --- |
| `Service:` | `ferry-paseo.service` must be `active, enabled`. |
| `Daemon:` | The daemon must be `running`. |
| `Version:` | The box version and the local app version. `not pinned` means there is no local Paseo app. |
| `Listen:` | The daemon must listen on `127.0.0.1:6767`. |
| `Providers:` | The agent providers on the box. Sync skips a profile whose provider is `unavailable`. |

## Sherlock

[Sherlock](https://github.com/michaelbromley/sherlock) is a read-only database query CLI on the operator machine. With the integration on, Sherlock queries a database on the box, or one that only the box can reach, through a tunnel that it opens on the first query.

```sh
ferry integrations enable sherlock
ferry sherlock add staging --box a --target db.example:5432 --type postgres
sherlock -c staging ...
```

- `ferry integrations enable sherlock` needs the `sherlock` executable on the operator machine. Without it, the command stops and prints the install command.
- `ferry sherlock add` runs `sherlock connection add` with a tunnel command that runs `ferry tunnel` for the box and the target. Sherlock opens the tunnel on the first query and closes it when it is idle.
- The target is a box port, such as `5432`, or a host and port that the box can reach, such as `db.example:5432`.
- The type is `postgres`, `mysql`, `mssql`, or `redis`.
- `ferry` must be on the `PATH` that Sherlock uses.

### Passwords

On a terminal, Ferry asks for the password and gives it to Sherlock on stdin. Sherlock stores it in the keychain of the operator machine. Ferry never stores the password and never edits the Sherlock config. Do not type a password into a command. With `--json`, give `--password-stdin` or `--password-env <var>`.

### Status

Ferry records the name, box, and target of each connection in `~/.ferry/sherlock.json`. Full `ferry status` checks that each box can reach its target:

| State | Meaning |
| --- | --- |
| `reachable` | The box can connect to the target. |
| `unreachable` | The box cannot connect to the target. |
| `unknown` | Ferry could not make the check. The box has no `bash`, `timeout`, or `/dev/tcp`. The target can be up. |
| `box-offline` | Ferry cannot reach the box. |
| `unknown-box` | The box of the connection is not in the config. |

`ferry status --brief` does not check Sherlock.
