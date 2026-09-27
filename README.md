# ferry

Ferry keeps a remote Linux agent box in the same shape as the machine you work on. Your machine is the source of truth. A private git repository holds the skills, the one global instruction file, the Claude subagents and commands, and the Claude plugin declarations. Both machines clone that repository and point their harness directories at the clone with symlinks. Ferry uses Tailscale by default and also accepts an explicit OpenSSH destination for local machines and existing SSH configurations.

Ferry never copies logins. OAuth sessions stay on the machine that created them. Ferry starts a vendor login on the box and you finish it in a browser here.

`PRD.md` holds the v1 specification.

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
  --ssh-destination ubuntu@orb \
  --snapshot-url git@github.com:you/ferry-snapshot.git
```

Ferry never falls back from Tailscale to direct SSH. The selected transport is stored in `~/.ferry/config.toml`.

An SSH snapshot URL requires a loaded identity in the operator's SSH agent. During `ferry init`, Ferry checks the agent, forwards it to the box, and tests read access to the snapshot repository. If the Git host is not in the box's `known_hosts`, Ferry prints the host-key fingerprints and asks for approval before it adds the public host keys. The operator's private key stays on the operator machine.

Add `--dry-run` to inspect the SSH probe, snapshot publish, config write, and managed symlinks without connecting to the box or changing the local filesystem.

Run `ferry uninstall` to remove the local store and config, remove Ferry-managed symlinks, and restore the paths that existed before the first `ferry init`. The command refuses to write if a managed symlink was replaced with local content. Backups from older Ferry versions are restored when Ferry can identify one unambiguous backup for a managed path. The command asks for confirmation first. Add `--yes` to skip the prompt.

## Add skills

After `ferry init`, use `ferry skills add` to install skills. The command runs `npx skills add` and passes your arguments through unchanged:

```sh
ferry skills add vercel-labs/agent-skills --skill frontend-design -a claude-code -y
```

Ferry adds `-g` and `--copy` if you do not pass them. The example runs `npx skills add vercel-labs/agent-skills --skill frontend-design -a claude-code -y -g --copy`. A global copy install puts each skill in a real directory in a global harness root, and the next sync links it to the store. A plain `npx skills add` installs into the current project, and Ferry does not see that install. Add `--project` to keep a project install. Ferry then does not add `-g`. Put arguments after `--` to keep Ferry from reading them. A failed `npx skills add` makes Ferry exit with the same code.

The install does not publish the skill. Run `ferry sync` or keep `ferry watch` running to publish it to the snapshot and apply it on the box.

## Update the agent tools

`ferry update` runs the update command of each agent tool on the box and on this machine:

| Tool | Update command | On this machine |
| --- | --- | --- |
| `gh` | `sudo apt update && sudo apt install gh -y` | Skipped. `gh` has no own update command, and Ferry does not guess the package manager here. |
| Claude | `claude update` | Runs if `claude` is installed. |
| Codex | `codex update` | Runs if `codex` is installed. |
| Pi | `pi update` | Runs if `pi` is installed. This updates Pi only, not its packages. |
| Cursor Agent | `cursor-agent update` | Runs if `cursor-agent` is installed. |

On this machine, Ferry uses `command -v` to find each tool. It updates only a tool that is already installed. It never installs a tool here.

Ferry prints the plan first and asks for confirmation. Add `--yes` to skip the prompt. Add `--dry-run` to print the plan and change nothing:

```sh
ferry update --dry-run
```

A failed update does not stop the other updates. After all updates, Ferry names each failed update and exits with a non-zero code.

The `gh` update uses `sudo` on the box. When `ferry watch` runs the update, no terminal is available to type a password. Membership in the `sudo` group is not sufficient, because the default rule on Ubuntu and Debian asks for a password. To let the watch update `gh`, add this rule on the box. Replace `<ssh-user>` with the SSH user of the box:

```
# /etc/sudoers.d/ferry  (edit with: sudo visudo -f /etc/sudoers.d/ferry)
<ssh-user> ALL=(root) NOPASSWD: /usr/bin/true, /usr/bin/apt update, /usr/bin/apt install gh -y
```

sudo compares the full command path and all arguments. The rule allows only these three commands, with these exact arguments. `/usr/bin/apt update` and `/usr/bin/apt install gh -y` are the two commands of the `gh` update. `/usr/bin/true` does nothing. `ferry status` runs `sudo -n /usr/bin/true` to find out if `sudo` asks for a password. Ferry does not write sudoers files on the box.

`ferry status` shows `Box sudo: PASSWORDLESS` or `Box sudo: PASSWORD REQUIRED`, and `--json` has the result in `boxSudo`. When `[update] watch = true` and `sudo` asks for a password, `ferry status` shows a warning that the watch cannot update `gh`.

## What Ferry carries

Ferry carries these items from the operator machine to the box:

- The skills in every global harness skill root, such as `~/.agents/skills` and `~/.claude/skills`.
- `~/AGENTS.md`, linked as the instruction file of each harness.
- The Claude subagents in `~/.claude/agents` and the Claude commands in `~/.claude/commands`. Ferry links each directory whole into the store. On the box, a live directory at one of these paths stops the sync. `ferry sync --force` moves it to `~/.ferry/backups` and then links it.
- An allowlist of keys from `~/.claude/settings.json`: the plugin declarations `enabledPlugins` and `extraKnownMarketplaces`, and `permissions` and `hooks`. The snapshot holds these keys in `settings/claude.json`. It holds no other settings key and no plugin cache. Keys that can hold secrets, such as `env` and `apiKeyHelper`, stay on the operator machine.

The deny rules apply to every carried directory. A file such as `.env` or `credentials.json`, or a file that holds a token, stops the sync. Ferry also stops the sync if a carried settings key holds a token or request headers.

Ferry does not carry a hook that refers to a file in your home that the box will not have. Ferry splits each hook `command` into words at spaces, quotes, `;`, `|`, `&`, `(`, `)`, `<`, `>`, and `=`. A word that starts with `~/`, `$HOME/`, or `${HOME}/` must point into a skill root that Ferry fills on the box, `~/.claude/agents`, `~/.claude/commands`, or a managed instruction file such as `~/AGENTS.md`. A word that is an absolute path under your home, such as `/Users/you/bin/check.sh`, never passes, because the box home has a different path. Programs on `PATH` (`jq`, `npx ...`), `$CLAUDE_PROJECT_DIR` paths, and absolute paths outside your home pass. Ferry leaves out each hook entry that does not pass and carries all other hooks. If a matcher group has no hooks left, Ferry removes the group. If an event has no groups left, Ferry removes the event. The sync continues. `ferry sync` and `ferry sync --dry-run` print one `Skipped hook:` line for each hook that Ferry leaves out, with its location, such as `hooks.PreToolUse[0].hooks[1].command`, and the path. A script in `~/.claude/hooks` is not carried, so move it into a carried directory or onto `PATH` on both machines.

On the box, `ferry sync` runs `claude plugin marketplace add` for each carried marketplace and `claude plugin install` for each enabled plugin. Claude does not install a plugin from settings alone. Then Ferry writes the carried keys into the box `~/.claude/settings.json`. The box keeps all other keys, such as `env` and `model`. A carried key that the operator machine does not have is removed from the box, because the box never wins. For example, if you have no `hooks` key, sync removes the box `hooks` key. If the box has no settings file, Ferry creates one. A marketplace or plugin that the box cannot install gives a warning and does not stop the sync. A marketplace with a `directory` or `file` source is on the operator machine only, so the box cannot add it.

`ferry sync --dry-run` lists the carried settings keys that sync will change. It compares your carried keys with the keys of the last publish in `~/.ferry/store/settings`. It does not connect to the box, so a key that someone changed on the box does not show.

Claude writes a marketplace to `extraKnownMarketplaces` when you add it with `claude plugin marketplace add`. Older Claude versions recorded marketplaces only in `~/.claude/plugins`. If a plugin in `enabledPlugins` comes from a marketplace that `extraKnownMarketplaces` does not list, such as `claude-plugins-official`, run `claude plugin marketplace add` for it once on the operator machine. For example: `claude plugin marketplace add anthropics/claude-plugins-official`.

## Automatic sync

`ferry watch` runs in the foreground. It watches the Manifest identity for every configured global skill root, `~/AGENTS.md`, the Claude subagents and commands, and the carried Claude settings keys. It does not watch project-local skills. After an accepted change stays stable for one second, Ferry runs the normal sync without `--force`. Network, SSH, and Git failures retry with a backoff capped at 60 seconds. Manifest refusals name the local path and wait for another edit.

`ferry watch` can also run `ferry update --yes` once each day. This is off by default. To turn it on, add this section to `~/.ferry/config.toml`:

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
bun run build
```

`bun run build` compiles a standalone executable to `dist/ferry` for the current platform.

## License

MIT. See `LICENSE`.
