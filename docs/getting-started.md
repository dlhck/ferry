---
title: Getting started
description: Install Ferry, connect your first box, and sync your agent setup to it.
---

# Getting started

Ferry keeps the agent setup of your machine in sync with one or more Linux boxes where remote agents run. Your machine is the source of truth. It is the operator machine. Ferry publishes your setup to a private git repository, the snapshot. Each box clones the snapshot and links its harness directories to it.

```text
your machine ── ferry sync ──> private snapshot repo ──> box a, box b, ...
                                                         (pull and link over SSH or Tailscale)
```

## What you need

- An operator machine with macOS or Linux, arm64 or x64.
- A Linux box that you can reach with SSH, with `curl` or `wget`. Debian or Ubuntu is the tested target.
- Tailscale on both machines, or an OpenSSH destination such as `user@box.example`.
- An empty private git repository for the snapshot. Ferry does not create it. For an SSH URL, you also need an SSH agent with a key that can push to it.

## Install Ferry

On the operator machine:

```sh
curl -fsSL https://raw.githubusercontent.com/dlhck/ferry/main/install.sh | sh
```

Or with npm. Do not use `--omit=optional`, because the executable comes from an optional dependency:

```sh
npm i -g @dlhck/ferry
```

`install.sh` lists its environment variables, such as `FERRY_VERSION`, at the top of the file.

## Set up the first box

```sh
ferry init --ssh-destination user@box.example \
  --snapshot-url git@github.com:you/ferry-snapshot.git
ferry install        # gh, jq, the agent CLIs, your tools, and Ferry on the box
ferry sync           # publish the snapshot and apply it on the box
ferry auth claude    # start a login on the box, finish it in a browser here
ferry watch install  # sync each change automatically, as a user service
ferry status         # check the link, the snapshot, the logins, and the tools
```

1. `ferry init` records the box and the snapshot URL, seeds the snapshot, and links this machine to it. For a Tailscale box, use `--host <tailscale host> --ssh-user <user>` instead of `--ssh-destination`. Without flags, `ferry init` asks. Ferry asks before it trusts the Git host key on the box.
2. `ferry install` prints the plan for each tool and asks before it runs a command on the box. The Ferry on the box is a box install. It runs only `ferry expose` and `ferry whoami`.
3. `ferry sync` checks the carried files against the deny rules, publishes the snapshot, and applies it on the box. See [What Ferry carries](what-ferry-carries.md) and the [Security model](security-model.md).
4. `ferry auth <tool>` starts a login for `gh`, `claude`, `codex`, or `cursor` on the box. You finish it in a browser on this machine. The token stays on the box. Pi has no remote login. Run `pi` on the box and use `/login`.
5. `ferry watch install` runs `ferry watch` as a launchd or systemd user service. It syncs each change one second after the change is stable.
6. `ferry status` shows the state of the snapshot and of each box. See [Status and the menu bar](status.md).

Add `--dry-run` to `init`, `sync`, `update`, or `move` to see the plan first.

`ferry auth gh` also creates `~/.ssh/id_ed25519` on the box if it is missing, and adds it to your GitHub account, so agents on the box can push.

## Next steps

- Add more boxes, and write instructions for one box only. See [Boxes](boxes.md).
- Continue a project on a box, with its agent sessions. See [Moving a project](moving-a-project.md).
- Open a dev server of the box in your browser. See [Box ports](boxes.md#box-ports).
- Run Paseo on a box, or query a database through a box with Sherlock. See [Integrations](integrations.md).
- Read the options of each command. See [Commands](commands.md).

## Update Ferry

Run `ferry self-update` on the operator machine. It restarts installed watch and tunnel services that use the updated Ferry. On macOS, it also updates an installed release menu bar app. Then run `ferry update` to put the new version on the boxes. When `ferry self-update` says that the release is not ready for download, see [Troubleshooting](troubleshooting.md#a-release-is-not-ready-for-download).

On a terminal, Ferry also asks to update when a newer release is there. It checks at most once a day, and never with `--json`, with `CI` set, or with `FERRY_NO_UPDATE_CHECK=1`.

## Scripts and agents

Add `--json` to any command. Then stdout has only JSON, and Ferry asks nothing. `ferry --help` describes the output.

The Ferry agent skill tells agents how to work with Ferry on both machines, for example not to edit a Ferry-managed file on the box. `ferry init` writes it to `~/.agents/skills/ferry`, and the snapshot carries it to the boxes. `ferry self-update` writes the skill of the new version. `ferry init --no-skill` does not install it.

## Remove Ferry

- `ferry box remove <name> --uninstall` removes Ferry from a box. See [Boxes](boxes.md#remove-a-box).
- `ferry uninstall` removes Ferry from this machine and restores the paths that `init` changed.
