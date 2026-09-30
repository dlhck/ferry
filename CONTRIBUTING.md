# Contributing to Ferry

## Setup

Ferry needs [bun](https://bun.sh) 1.4 or later.

```sh
git clone https://github.com/dlhck/ferry.git
cd ferry
bun install
```

`bun install` runs the `prepare` script, which installs the [husky](https://typicode.github.io/husky/) git hooks. Run it again if you clone without it.

## Checks

Run these before you open a pull request. CI runs the same checks on each push and pull request.

```sh
bun test
bun run typecheck
bun run build
```

The Swift menu bar app in `macos/` builds only on macOS. Run `macos/build.sh` on a Mac after you change it. CI builds it on `macos-latest`.

Some box MCP tests run box scripts with a real `jq`. They skip when `jq` is not on the PATH. CI runs them on Ubuntu.

The tests do not connect to a real box. They use fake SSH hosts, temporary home directories, and local git remotes. Do not add a test that needs network access, a Tailscale peer, or a vendor login.

Use example values in tests and docs: `user@box.example`, `/home/user`, `operator@example.com`, and `git@github.com:you/ferry-snapshot.git`. Do not use a real host name, IP address, user name, or home path.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/), for example `fix: keep the box hooks key when the operator has none` or `docs: explain the sudoers rule`. The pull request title follows the same format, because the maintainer squashes the pull request into one commit.

The `commit-msg` hook runs `strip-clanker-attribution`. It removes AI tool attribution lines, such as `Co-authored-by` trailers for an agent, from the commit message.

## Pull requests

- Keep one change in one pull request.
- Add or change a test for each behaviour change.
- Update `README.md` when a command, flag, or carried path changes.
- A change to what Ferry carries, or to the deny rules, needs a clear reason in the pull request. Ferry must never carry a credential to the box.

Report a security problem privately. See [SECURITY.md](SECURITY.md).
