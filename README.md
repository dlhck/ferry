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
ferry install       # install gh, Claude Code, Codex, Pi, and Cursor Agent on the box
ferry sync          # publish the snapshot and apply it on the box
ferry auth gh       # start a login on the box, finish it in a browser here
ferry auth claude
ferry status        # check the link, the snapshot, the managed paths, and the box logins
```

`ferry install` shows each install command and asks for confirmation before it runs the command on the box. Repeat `ferry auth` for each tool that you use. Add `--dry-run` to `init`, `sync`, or `update` to see the changes before Ferry makes them.

## Security model

Ferry carries skills, `~/AGENTS.md`, the Claude subagents and commands, an allowlist of Claude settings keys, and the name and HTTPS URL of each remote MCP server. [What Ferry carries](#what-ferry-carries) has the full list.

Ferry never carries:

- credential files, OAuth sessions, or Keychain items;
- tokens, API keys, or MCP tokens and request headers;
- settings keys that can hold secrets, such as `env` and `apiKeyHelper`;
- local MCP servers, which have a `command`, `args`, or `env`;
- session history, caches, databases, or whole settings files.

A carried file that looks like a secret stops the sync, and the error names the file, never the value. Logins happen on the box, and the tokens stay there.

Ferry opens no public listening port. The Codex callback login forwards local port 1455 to the box for 120 seconds. Ferry never turns off SSH host-key checks, and it never falls back from Tailscale to direct SSH. Ferry forwards your SSH agent to the box only for the snapshot update. `ferry auth gh` creates an SSH key without a passphrase on the box and adds it to your GitHub account, so agents on the box can push. See [GitHub over SSH](#github-over-ssh).

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

`ferry init`, `sync`, `status`, `install`, `auth`, and `update` show the current step on stderr, for example `Publishing the snapshot` or `Installing Claude plugins (3/10)`. When stdout and stderr are both terminals, a spinner shows the step and ends it with a done or failed mark. In other cases, Ferry writes one plain line when a step starts or its count changes, with no control characters. `ferry watch` always writes plain lines, so its log stays readable. `ferry status --json` shows no progress, and its stdout is only the JSON report.

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
```

The project must be inside your home directory. The destination uses the same path relative to its home. For example, `~/Developer/app` on this machine becomes `~/Developer/app` on the box. Ferry does these steps:

1. **Preflight.** Ferry reads the remote branches and tags of `origin` with `git ls-remote`. Ferry refuses the move if a commit on a local branch is not on `origin`. If `git cherry` shows that an equivalent patch is on the default branch of `origin`, Ferry accepts the commit. Ferry does not fetch, so run `git fetch` first if the patch was merged recently. Ferry also refuses uncommitted changes to tracked files, and a destination path that exists. Ferry reports stashes, because the clone does not get them.
2. **Clone.** The destination clones the project from `origin`, at the current branch if `origin` has it. The box uses its own SSH key. Run `ferry auth gh` first to set up that key.
3. **Carry.** Ferry carries the untracked and ignored files. Ferry skips `node_modules`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.cache`, `.parcel-cache`, `dist`, `build`, `coverage`, `target`, `__pycache__`, `.venv`, `venv`, `.gradle`, `.terraform`, `.idea`, `.vscode`, `.DS_Store`, and `._*` at any depth. Each carried file must pass the deny rules of [What Ferry carries](#what-ferry-carries): credential and token file names, private keys, token content, secret fields in JSON, YAML, and TOML files, and executable binaries. Ferry refuses symbolic links and nested git repositories. The archive has no macOS extended attributes, so the box gets no `._*` files.
4. **Environment files.** Ferry refuses `.env` and `.env.*` files. With `--include-env`, Ferry carries an environment file only if it has no token and no `PASSWORD`, `SECRET`, `API_KEY`, or similar key with a value.
5. **Verify.** Ferry compares the SHA-256 checksum of each carried file on the destination with the checksum of the bytes that Ferry checked.
6. **Paseo.** If the destination has the `paseo` CLI, Ferry runs `paseo project create <path>` there.
7. **Remove.** With `--remove`, Ferry moves the source copy after verification. On macOS, this machine uses `~/.Trash/<name>-<timestamp>`. The box, and a Linux operator machine, use `~/.ferry/trash/<name>-<timestamp>`. Ferry never deletes the source copy. Ferry refuses `--remove` before any change if it refuses a local-only file.

A folder without git has no clone. Ferry copies all its files with the same skip list and deny rules.

`--dry-run` prints the plan: the clone, and each file that Ferry carries, refuses, or skips. It does not write on either machine. With `--from-box`, Ferry reads the box files into a temporary directory on this machine for the deny checks, and removes that directory after the run.

If a step fails after the clone, the destination copy is incomplete. Ferry does not remove it. Move it away before you try again.

## What Ferry carries

Ferry carries these items from the operator machine to the box:

- The skills in every global harness skill root, such as `~/.agents/skills` and `~/.claude/skills`. Ferry does not carry the `.system` directory in a skill root, because Codex manages it and installs its own copy on each machine.
- `~/AGENTS.md`, linked as the instruction file of each harness.
- The Claude subagents in `~/.claude/agents` and the Claude commands in `~/.claude/commands`. Ferry links each directory whole into the store. On the box, a live directory at one of these paths stops the sync. `ferry sync --force` moves it to `~/.ferry/backups` and then links it.
- An allowlist of keys from `~/.claude/settings.json`: the plugin declarations `enabledPlugins` and `extraKnownMarketplaces`, and `permissions` and `hooks`. The snapshot holds these keys in `settings/claude.json`. It holds no other settings key and no plugin cache. Keys that can hold secrets, such as `env` and `apiKeyHelper`, stay on the operator machine.
- The remote MCP servers of Claude (`mcpServers` in `~/.claude.json`), Codex (`[mcp_servers]` in `~/.codex/config.toml`), and Cursor Agent (`mcpServers` in `~/.cursor/mcp.json`). Ferry carries only the name, the transport, and the HTTPS URL of each server. See [Remote MCP servers](#remote-mcp-servers).

The deny rules apply to every carried directory. A file such as `.env` or `credentials.json`, or a file that holds a token, stops the sync. A JSON, YAML, or TOML file also stops the sync if it has a `password`, `passwd`, `secret`, `client_secret`, `private_key`, or `api_key` key with a string value, at any depth. Ferry compares keys without regard to case, `-`, or `_`, so `clientSecret` also matches. The error names the file and the key, never the value. An empty value passes, and a placeholder value passes by the token rule below. If the file does not parse, Ferry checks each `key: value` or `key = value` line. An ELF, Mach-O, or PE executable also stops the sync. A script with a shebang and a Java class file are not executables to Ferry. Ferry also stops the sync if a carried settings key holds a token or request headers. A documentation placeholder is not a token. Ferry ignores a token whose part after the prefix is only `x`, only `X`, or only `0`, such as `ghs_xxxx...`. It also ignores a part of only `x` and `X` with the `-` or `_` separators of the token format, such as `xoxb-xxxx-xxxx-...`.

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
bun run typecheck
bun run build
```

`bun run build` compiles a standalone executable to `dist/ferry` for the current platform. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and [SECURITY.md](SECURITY.md) to report a vulnerability. See [RELEASING.md](RELEASING.md) for the release process and the npm packages.

## License

MIT. See [LICENSE](LICENSE).
