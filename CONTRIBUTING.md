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

Run these before you open a pull request. CI runs the same checks on each pull request and on each push to `main`.

```sh
bun test
bun run typecheck
bun run build
```

The Swift menu bar app in `macos/` builds only on macOS. Run `macos/build.sh` on a Mac after you change it. CI builds it on `macos-latest`.

Some box MCP tests run box scripts with a real `jq`. They skip when `jq` is not on the PATH. CI runs them on Ubuntu.

The tests do not connect to a real box. They use fake SSH hosts, temporary home directories, and local git remotes. Do not add a test that needs network access, a Tailscale peer, or a vendor login.

A test must not start a real tool binary, such as `gh`, `claude`, `ssh`, `npm`, or `systemctl`: inject a fake through the dependencies of the command, or put a fake program in front of `PATH`. The guard in `test/preload.ts` puts stubs with these names in front of `PATH`, and a test that starts one fails with the command in the message.

Use example values in tests and docs: `user@box.example`, `/home/user`, `operator@example.com`, and `git@github.com:you/ferry-snapshot.git`. Do not use a real host name, IP address, user name, or home path.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/), for example `fix: keep the box hooks key when the operator has none` or `docs: explain the sudoers rule`. The pull request title follows the same format, because the maintainer squashes the pull request into one commit.

The `commit-msg` hook runs `strip-clanker-attribution`. It removes AI tool attribution lines, such as `Co-authored-by` trailers for an agent, from the commit message.

## Pull requests

- Keep one change in one pull request.
- Add or change a test for each behaviour change.
- Update `README.md` when a command, flag, or carried path changes.
- After a change to the help text of a command, run `bun scripts/docs-commands.ts` and commit `docs/commands.md`. Do not edit that file by hand. A test fails when it differs from the help text.
- GitHub Pages builds the docs site from `docs/` with its built-in Jekyll. Each Markdown file there is a page, and `docs/_data/nav.yml` has the page list. You do not need a local server.
- A change to what Ferry carries, or to the deny rules, needs a clear reason in the pull request. Ferry must never carry a credential to the box.
- A change to a deny rule or to the session scanner must raise `DENY_RULES_VERSION` in `src/manifest.ts`. Ferry refuses the check of a box with a lower number.

Report a security problem privately. See [SECURITY.md](SECURITY.md).
