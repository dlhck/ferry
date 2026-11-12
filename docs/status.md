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
- The logins of the tools, and the logins of the MCP servers. On a box with the [MCP gateway](boxes.md#an-mcp-gateway-on-the-box), the logins of the gateway servers too, as `gateway/<server>`. A harness entry of the gateway needs no login of its own. A [shared stdio server](boxes.md#shared-stdio-servers) that sent a request to the client shows as `gateway/<server>` in the state `cannot-share`.
- The tools and their versions.
- The box-only skills: skills on the box that the snapshot does not have. `ferry adopt --from-box` copies one to the operator machine.
- The unsaved work: git projects on the box with work that is only on the box. See [Unsaved work](#unsaved-work).
- The integrations that are on.

`ferry status` does not fail for an offline box. The report shows the box as offline.

### Skipped MCP servers

The shared part of the report, before the boxes, has the block `Skipped MCP servers` when Ferry does not carry a stdio MCP server of this machine. Each line has the harness and the name of the server, the reason, and what to change:

```
Skipped MCP servers:
  codex/node_repl (app-bundle): runs from a macOS app bundle, which the box does not have. There is nothing to change.
  claude/local (home-path): refers to a path in your home. Use a command on the PATH or a path outside the home.
```

| Reason | Meaning | What to change |
| --- | --- | --- |
| `home-path` | The command or an argument refers to a path in your home. | Use a command on the `PATH` or a path outside the home. |
| `inline-script` | A shell or an interpreter runs an inline script, which Ferry cannot check. | Put the script in a file that Ferry carries, or run the server through a tool on the `PATH`. |
| `unknown-options` | A shell or an interpreter has options that Ferry cannot classify. | Remove the options that come before the script file, or run the server through a tool on the `PATH`. |
| `app-bundle` | The server runs from a macOS app bundle, which the box does not have. | Nothing. A box cannot run a macOS app. |

The block shows only the name and the reason, never a command or an argument of a server. The list is the same for each box. Ferry prints no block when it skips no server. A server with a credential in its arguments is not in the block: it stops the sync, and the deny list has its rule.

### Unsaved work

The block `Unsaved work` of each box names each git project on the box that has work that is only on the box:

```
Unsaved work: 2 of 3 projects, only on the box
  ~/code/app (main): 3 changed files, main has 2 commits that no remote has
  ~/code/api (detached HEAD): feature has 1 commit that no remote has
```

Ferry checks two lists of projects:

- The `projects` key of `[box.<name>]` in `~/.ferry/config.toml`. See [Boxes](boxes.md#projects-on-a-box).
- The destinations of earlier `ferry move` commands to the box. The box records each destination in `~/.ferry/projects`.

A project appears when it has one of these:

- A changed tracked file or an untracked file. An ignored file does not count.
- A local branch with commits that no remote-tracking branch has. A branch without a remote counts all its commits. Ferry does not fetch, so the counts use the remote-tracking branches of the last fetch on the box.

A stash does not count. A clean project that is fully pushed does not appear. A path that is not a git project is skipped.

The block shows only the path, the branch, and the counts, never a file name or a commit subject. When the box has a box install of Ferry, the output goes through `ferry redact` on the box, so a token in a path or a branch name stays on the box. The operator machine applies the same token rule again.

`ferry box remove <name> --uninstall` prints the same list before it asks for the box name. Ferry keeps the project directories, but the list shows what is lost when you delete the machine. `--brief` does not have the block, because work in progress needs no action.

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
- With [agent notifications](#agent-notifications) on, the app also sends a notification when an agent on a box ends its turn or waits for input.
- Sync now runs `ferry sync`.

The app needs macOS 26 or later.

Ferry downloads the app of the release of this Ferry, verifies it against `SHA256SUMS` of the release, and unpacks it to `~/Applications/Ferry Menu Bar.app`. When the release does not have these files yet, Ferry stops and the installed app stays. The app starts at login. Run the command again after you move Ferry or update it. `ferry menubar uninstall` removes the app.

### The window

Open Ferry in the menu opens a window with a table of the boxes. A second click brings the same window to the front. The app shows a Dock icon while the window is open.

The table has one row for each box of `~/.ferry/status.json`, then one row for each box that has only a tunnel file. The columns are:

- Box: the box name.
- State: Online or Offline.
- Free disk: the free space of the file system of the box home.
- Free memory: the available memory.
- Needs action: the count of items that need action. An offline box counts as one item, and so does a disconnected tunnel of an online box.
- Ports: the ports of its running `ferry tunnel --follow`.

Select a row to see the items of the box with the full message, the fix command, and Copy. Click a fix command to run it in Terminal. Click a port to open it in the browser. Sync now and Refresh now do the same as in the menu.

The window reads the same files as the menu. It updates when `~/.ferry/status.json` or a tunnel file changes. When the status file is missing, or `ferry watch` did not write it in the last 15 minutes, the window shows the same message as the menu.

### Agent notifications

The menu bar app can send a notification when Claude on a box ends its turn or waits for input. The notification names the box, the harness, and the last folder of the project. It has no prompt text and no agent output. The feature is off by default.

To turn it on:

1. Add this table to `~/.ferry/config.toml` on the operator machine:

   ```toml
   [notifications]
   agents = true
   ```

2. Run `ferry sync`. Ferry adds a Claude `Stop` hook and a `Notification` hook to `~/.claude/settings.json` on each box. The hooks run `ferry notify` of the box install. Ferry does not change the Claude settings of the operator machine.
3. Run `ferry tunnel install --box <name>` for each box, so `ferry tunnel --follow` runs as a user service. It carries the events within seconds.
4. Install the menu bar app with `ferry menubar install`.

Ferry adds the hooks only to a box that has Claude on and when `~/.claude/settings.json` is on the operator machine. Else sync prints a warning. Remove the table, or set `agents = false`, and run `ferry sync` to remove the hooks from the boxes. `ferry box remove <name> --uninstall` removes the hooks and `~/.ferry/events` too, and keeps the other hooks.

The hooks do nothing when the box has no Ferry, or a Ferry without `ferry notify`. Sync then prints a warning that names `ferry install` or `ferry update`.

The `Notification` hook takes a permission prompt and a question from an MCP server. It does not take the reminder that Claude sends after 60 seconds of idle time.

#### The event files

`ferry notify <harness> <kind>` writes one event to `~/.ferry/events/<id>.json` on the box. The kind is `turn-ended` or `waiting-for-input`. Ferry reads only the `cwd` field of the hook input on stdin, and the project is that path with tokens and URL credentials replaced. The box keeps the newest 20 events of the last hour.

`ferry tunnel --follow` reads the events of the box and writes the new ones to `~/.ferry/tunnels/<box>.events.json` on the operator machine, with a write and a rename. The file stays when the tunnel stops, so a restart gives no event again. It keeps the newest 20 events, oldest first:

```json
{
  "schemaVersion": 1,
  "box": "lab",
  "updatedAt": "2026-11-11T10:00:01.000Z",
  "events": [
    {
      "id": "1794045600000-4242",
      "harness": "claude",
      "kind": "turn-ended",
      "project": "/home/user/app",
      "at": "2026-11-11T10:00:00.000Z",
      "receivedAt": "2026-11-11T10:00:01.000Z"
    }
  ]
}
```

`id` is unique for each box. `at` is the time on the box, and `receivedAt` is the time on the operator machine. When the file is not there, the read is the first read of the box. Then Ferry writes the file with no events, and puts the IDs of the events on the box in `seen`. These events are older than the follow, so Ferry never shows them. The app sends one notification for each `id` that it did not read before, when `receivedAt` is after the start of the app. With Notifications off in the menu, the app sends none.

## Linux

The menu bar app runs only on macOS. On Linux, a waybar custom module can show the same state from `~/.ferry/status.json`. See [Linux status bar](linux-status-bar.md).

## Scripts and agents

`ferry status --json` prints the status report with `schemaVersion: 2`. Its `skippedMcp` field has the skipped stdio MCP servers as `{ harness, name, reason }`. The `unsavedWork` field of each box has `{ checked, projects, error }`, and each project is `{ path, branch, changes, unpushed: [{ branch, commits }] }`. `ferry status --brief --json` prints `{ schemaVersion: 1, checkedAt, boxes }`. Each item has a `summary` of at most 60 characters and the full `message`. The [Ferry agent skill](https://github.com/dlhck/ferry/blob/main/skills/ferry/SKILL.md) describes each field.
