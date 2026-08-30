# ferry

Ferry keeps a remote Linux agent box in the same shape as the machine you work on. Your machine is the source of truth. A private git repository holds the skills and the one global instruction file. Both machines clone that repository and point their harness directories at the clone with symlinks. Ferry uses Tailscale by default and also accepts an explicit OpenSSH destination for local machines and existing SSH configurations.

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

Add `--dry-run` to inspect the SSH probe, snapshot publish, config write, and managed symlinks without connecting to the box or changing the local filesystem.

## Automatic sync

`ferry watch` runs in the foreground. It watches the Manifest identity for every configured global skill root and `~/AGENTS.md`. It does not watch project-local skills. After an accepted change stays stable for one second, Ferry runs the normal sync without `--force`. Network, SSH, and Git failures retry with a backoff capped at 60 seconds. Manifest refusals name the local path and wait for another edit.

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
