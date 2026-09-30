---
title: Security model
description: The rules that keep credentials on the machine that has them, and the limit of those rules.
---

# Security model

Ferry carries configuration. It does not carry anything that proves who you are. The rule is: no credential leaves the machine that has it.

## What never leaves a machine

Logins, credential files, tokens, API keys, `.env` files, and whole settings files never leave the machine that has them. A login starts on the box with `ferry auth`, and its token stays there.

## Deny rules

Before each publish, Ferry checks the carried files against the deny rules:

- Secret file names
- Private keys
- Token content
- Secret keys in JSON, YAML, and TOML
- Executable binaries (ELF, Mach-O, and PE)

Scripts, such as hook scripts, pass and keep their executable bit. A match stops the sync, and nothing is published. The error names the file, never the value.

`ferry sync --dry-run` prints the plan and the deny list. `ferry status --json` has the list in `denyList`.

Do not rename, move, split, or encode a file to get past a deny rule. Remove the secret from the file, or remove the file from the carried set.

## Per-box instruction files

A per-box instruction file, `~/.ferry/boxes/<name>/AGENTS.md`, gets the same deny rules as `~/AGENTS.md`, and the private key rule. It never goes into the snapshot. Ferry sends it to its box on the standard input of an SSH command, so the text is not in a command line. A match stops the sync of that box only.

## Settings and MCP servers on the box

Ferry merges the carried settings keys and MCP servers into the box files on the box: with jq for JSON files and with awk for the Codex `config.toml`. The box sends back only a status, never the file.

- Without jq on the box, Ferry leaves a JSON file as it is and tells you to run `ferry update`.
- When Ferry cannot read a line of the box `config.toml` as TOML, it leaves the file as it is and stops the sync. The error names the file and the line number, never the text.
- When a Claude plugin command fails on the box, Ferry names the plugin and the command, never the command output. Run the command on the box to see the error.

## Stdio MCP servers

For a stdio MCP server, Ferry carries the command, the arguments, and the names of the `env` keys, never their values. Set the values in the `env` of the server on the box. Ferry keeps them: the box merges its own entry with jq or the agent CLI, and sends back only a status or key names, never a value.

### Arguments that stop the sync

A command or an argument stops the sync when it has one of these:

- A token
- A secret flag with a value
- A URL with a password or a secret query parameter
- An `http` or `https` URL with a user and no password, because the user can be a token, as in `https://<token>@host`. This includes forms such as `git+https`.

Ferry decodes the percent escapes of a URL before the check, so `pa%73sword=` is `password=`. The same rules apply to a URL inside another URL, as it is or with percent escapes, as in `https://proxy.example/?next=https://<user>:<password>@host`.

In another scheme, a user without a password is a login name and passes, as in `git+ssh://git@github.com/you/server` or `postgresql://alice@db.example/app`.

The error names the server and the rule, never the value. Set secrets in the `env` of the server on the box.

### Servers that Ferry skips

The sync continues and names the server when Ferry skips it:

- A server whose command or arguments refer to a path in your home, as an absolute path, `~`, `$HOME`, or `${HOME}`.
- A server whose command or arguments refer to a path in a macOS app bundle, a path with a `<name>.app/Contents/` part, as in `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl`. The path can be at any place, also in `~/Applications` or inside a longer argument. A box does not have the app, and you have nothing to do, so `ferry status --brief` shows no item for this server. When an earlier sync put the server on a box, the next sync removes the box entry, but only when the command or an argument of the box entry is itself an app bundle path. Ferry removes no other box server.
- A server that runs an inline script for a shell or an interpreter, such as `sh -c`, `bash -cl`, `node -e`, `node --eval=...`, `python -c`, `deno eval`, `npx -c`, `pwsh -Command`, `cmd /c`, or `env -S`, because Ferry cannot check the script. This includes a shell or an interpreter behind another command, as in `env bash -c` or `docker run <image> sh -c`.
- A shell or an interpreter with an option that Ferry does not know before its script file, and a script option in a later argument. Then the message says that Ferry cannot classify the options.

A script file passes, as in `node /srv/server.js -c conf.json` or `python3 -m some_server`. Put the script in a file that Ferry carries, or run the server through a tool on the `PATH`.

Ferry knows only the shells and interpreters in its list. It carries a tool that is not in the list and that runs code from its arguments, such as `ssh host CODE`, `awk`, or `find -exec`. The credential rules still apply to the arguments of that tool.

Ferry never installs a command. `ferry status --brief` names each missing env key, each command that is not on the box, and each server that Ferry did not carry. The full `ferry status` lists each skipped server, also a server from a macOS app bundle, with its harness, its name, and the reason, and never with a command or an argument.

## SSH

- Ferry opens no public port and never turns off SSH host-key checks. It never falls back from Tailscale to direct SSH.
- Ferry forwards your SSH agent to a box only for the snapshot checks and updates and for the Claude plugin installs.
- A box with `git_auth = "box"` gets no agent. It reads the snapshot with its own read-only deploy key. See [Boxes](boxes.md#a-box-without-your-ssh-agent).
- Boxes do not trust each other. Ferry connects to each box from the operator machine. `ferry move` between two boxes goes through the operator machine, with the same deny rules.

## Files that leave a box

`ferry move --from-box` and `ferry adopt --from-box` copy files from a box. For a skill or a project that leaves a machine, that machine checks and copies in one step:

- It reads each file one time, applies the deny rules to those bytes, and sends exactly those bytes.
- A file that changes after the plan and no longer passes stays on its machine. No byte of it leaves.
- For a box, the Ferry on the box does this. The operator machine takes only the files that it asked for, as regular files inside the target directory.
- The operator machine applies its own deny rules to the bytes that arrive from a box, before it writes them to the destination or sends them to another box.

### Hashes and names

- The plan of a move has the SHA-256 of a file only when the file passes. It has no hash and no session id for a file that a rule refuses, because a hash of a short file is a test for its content.
- A name with the form of a token stays on its machine. Ferry refuses a file or a directory with such a name, and the message names only the directory above it.
- The Ferry on a source box filters the output of each command that Ferry runs there. A file name, a branch name, or a commit subject with a token reaches the operator machine as `[token]`.
- The check on a box looks at a name before it opens the file. A file that it cannot read is a hit with its path, so no error text of the box system reaches the operator machine.

### The origin URL of a project

A credential in the origin URL of a project stays on its machine. `ferry move` takes the user and the password, a token in the place of the user, and each secret query parameter out of the URL before the URL leaves the source. The destination clones from the URL without them, so it needs its own login for the clone. A login name stays, as in `ssh://git@host` and `git@host:path`. In an output, `[credential]` stands for a credential in a URL.

## The limit of the rule

The rule "no credential leaves the machine that has it" holds for a box that runs an honest Ferry.

The check on the box protects against mistakes and against files that change. It does not protect against a box account that an attacker controls, because that Ferry can give any answer and any bytes. This is why the operator machine applies its own deny rules to the bytes that arrive from a box.

Ferry runs commands with your SSH user. Use a box and a user that you trust with the agents that run there.

The session scan of `ferry move` also has a limit. See [Moving a project](moving-a-project.md#the-limit-of-the-session-scan).

## Report a vulnerability

Do not open a public issue for a security problem. Report it privately with GitHub private vulnerability reporting. See [SECURITY.md](https://github.com/dlhck/ferry/blob/main/SECURITY.md) for the scope.
