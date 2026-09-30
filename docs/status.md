---
title: Status and the menu bar
description: Read the state of each box with ferry status, the watch service, the macOS menu bar app, and a Linux status bar.
---

# Status and the menu bar

## Full status

`ferry status` shows the state of the snapshot and of each box. It changes nothing. It checks these for each box:

- The link: the box answers over SSH or Tailscale.
- The snapshot: the commit on the operator machine, on the git remote, and on the box.
- The managed paths: box links that are missing or wrong. A sync repairs them.
- The logins of the tools, and the logins of the MCP servers.
- The tools and their versions.
- The box-only skills: skills on the box that the snapshot does not have. `ferry adopt --from-box` copies one to the operator machine.
- The integrations that are on.

`ferry status` does not fail for an offline box. The report shows the box as offline.

### Tool states

| State | Meaning | Fix |
| --- | --- | --- |
| `ok` | The box has the target version. | |
| `drift` | The box has another version. | `ferry update` |
| `missing` | The box does not have the tool. | `ferry install` |
| `hidden` | A login shell on the box does not find the tool. | `ferry sync` |
| `skipped` | The tool has no target. | |
| `off` | The tool has the policy `"off"`. This is not a problem. | |
| `unknown` | Ferry cannot read the box version. | |

## Brief status

`ferry status --brief` prints one line for each item that needs action, with the Ferry command that fixes it:

- Offline boxes
- Low disk or memory on a box
- Logins and MCP logins
- Stdio MCP servers that lack something on the box: a missing env key, or a command that is not on the box
- MCP servers that Ferry did not carry
- Tool drift
- Hooks that run a home file Ferry does not carry

### Disk and memory limits

`--brief` shows an item when the free disk of the box home file system is below both 10% and 5 GiB, or the available memory is below 10%. Set other limits in `[status]` of `~/.ferry/config.toml`:

```toml
[status]
disk_free_percent = 10
disk_free_gib = 5
memory_available_percent = 10
```

A limit of 0 turns its part of the check off. When one disk limit is 0, the other decides. The load average is only in the JSON report, and it has no limit.

## The watch service

`ferry watch` syncs all boxes one second after a change is stable. `ferry watch install` runs it as a user service:

| System | Service file | Log |
| --- | --- | --- |
| macOS | `~/Library/LaunchAgents/dev.ferry.watch.plist` | `~/Library/Logs/ferry-watch.log` |
| Linux | `~/.config/systemd/user/ferry-watch.service` | `journalctl --user -u ferry-watch.service -f` |

- A box that fails retries with its own backoff, up to 60 seconds.
- A change to a per-box instruction file syncs only its box, and publishes nothing.
- With `[update] watch = true`, the watch also updates the tools with the `"latest"` policy once a day.
- The service records the path of this Ferry, the current `PATH`, and `SSH_AUTH_SOCK`. Run `ferry watch install` again after you move Ferry or change these values.

### The status file

At the start, every 5 minutes, and after each sync, the watch writes the report of `ferry status --brief --json` to `~/.ferry/status.json`. The menu bar app and the Linux status bar read this file. The report also has the free disk, the memory, and the load of each box. [Linux status bar](linux-status-bar.md#the-status-file) shows the format.

## The macOS menu bar app

`ferry menubar install` installs a menu bar app that shows the report of `ferry status --brief` for each box. The app reads `~/.ferry/status.json`, so `ferry watch` must run.

- Each item has a short title, such as `codex/node_repl: command not on the box`. Its submenu has the full message, the Ferry command that fixes it, and Copy. Copy puts the command on the clipboard, or the message when the item has no command.
- Click an item with a Ferry command to run it in Terminal.
- The app shows the ports of each running `ferry tunnel --follow`. Click a port to open it in the browser.
- The app sends a macOS notification when a box goes offline, a login or MCP login needs a login, or a tool has drift. Turn off Notifications in the menu to stop them.
- Sync now runs `ferry sync`.

Ferry downloads the app of the release of this Ferry, verifies it against `SHA256SUMS` of the release, and unpacks it to `~/Applications/Ferry Menu Bar.app`. When the release does not have these files yet, Ferry stops and the installed app stays. The app starts at login. Run the command again after you move Ferry or update it. `ferry menubar uninstall` removes the app.

## Linux

The menu bar app runs only on macOS. On Linux, a waybar custom module can show the same state from `~/.ferry/status.json`. See [Linux status bar](linux-status-bar.md).

## Scripts and agents

`ferry status --json` prints the status report with `schemaVersion: 2`. `ferry status --brief --json` prints `{ schemaVersion: 1, checkedAt, boxes }`. Each item has a `summary` of at most 60 characters and the full `message`. The [Ferry agent skill](https://github.com/dlhck/ferry/blob/main/skills/ferry/SKILL.md) describes each field.
