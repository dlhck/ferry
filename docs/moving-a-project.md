---
title: Moving a project
description: Continue a git project on a box, back on your machine, or on another box, with its agent sessions.
---

# Moving a project

`ferry move` carries a git project between machines, with its untracked files, its Claude and Codex sessions, and its Claude project memory.

```sh
ferry move ~/code/shop --dry-run          # see the plan
ferry move ~/code/shop                    # to default_box or the only box
ferry move ~/code/shop --to-box b         # to box b
ferry move ~/code/shop --from-box a       # back to this machine
ferry move ~/code/shop --from-box a --to-box b
```

The path must be a directory inside the home. For one file, use `ferry cp`. The destination uses the same path relative to its home. `ferry move` does not accept `--box`.

## Copy one file

For a report or screenshot, use `ferry cp` on the operator machine:

```sh
ferry cp a:~/reports/report.pdf ~/Downloads/report.pdf
ferry cp ~/Downloads/report.pdf a:~/reports/report.pdf
```

The prefix names a configured box. It must agree with `--box` when you give both.
Use `:<path>` for `--box`, then `default_box`, then the only box.

Local relative paths start at the current folder. Box relative paths start at
the box home. Both accept `~/` and absolute paths. Give an exact destination
file path with an existing parent directory. Ferry refuses directories and
symbolic links, including a symbolic link in the source path.

The source checks the file with the same file name and content deny rules as
`move`, before the bytes leave. There is no secret override. A source box
needs a release of Ferry with current deny rules. The 128 MiB scan limit
applies. Ferry verifies SHA-256 before it installs the destination file.
An existing file stays unless you give `--force`. Ferry holds the box lock
during the copy. It copies no git state, agent sessions, or project memory.

## Before a move

Run `ferry move <path> --dry-run` first. It prints `Carry:`, `Refuse:`, `Skip:`, `Note:`, and `Problem:` lines and changes nothing.

Fix each `Problem:` line. Ferry refuses a move with one of these:

- Unpushed commits
- Uncommitted changes to tracked files
- A destination path that exists

The destination clones the project from `origin` with its own SSH key. Run `ferry auth gh` for a box first.

## What a move carries

- The git project, as a clone from `origin` on the destination.
- The untracked and ignored files that pass the deny rules. Ferry skips build output such as `node_modules` and `dist`, and checks each file with SHA-256.
- The Claude and Codex sessions of the project and the Claude project memory. `claude --resume` and `codex resume` find them on the destination.

A `Refuse:` file stays on the source machine. Do not copy it by hand without a check of its content.

Between two boxes, the files go through a temporary directory on the operator machine, and nothing stays there. The boxes do not connect to each other.

### `.env` files

- `--include-env` also carries a `.env` file that has no token and no secret key with a value.
- `--include-env --allow-secrets` also carries a `.env` or `.env.*` file that has a token or a secret key. Ferry still refuses a `.env` file with a private key or an executable. The plan shows each such file on a `Carry with secrets: <path> (<kinds>)` line. The line names the kinds of secret, never the values.
- On a terminal, Ferry asks before the transfer. Without a terminal, Ferry stops unless `--yes` is set.
- The destination gets these files with mode 600. Anyone with access to the box user can read them.

### Large files

Ferry reads one file at a time to check it, and it does not read a file of more than 128 MiB, so that a box with little memory can do the check. Such a file, session, or skill file stays on its machine. The plan lists it as `Skip: <path> (too large for Ferry to check)`, and you copy it by hand. `--remove` refuses the move when the project has such a file.

### Remove the source copy

With `--remove`, after verification, Ferry moves the source copy to `~/.Trash` on macOS, else to `~/.ferry/trash`. It does not delete it. Ferry refuses `--remove` if it refuses any local-only file.

## Sessions

The dry run prints a `Carry sessions:` line.

- A session file that is only on the destination stays. A session on both machines gets the source copy. The source keeps its sessions.
- Ferry applies the deny rules to each session and memory file. A `WARNING: Ferry skips the session of <file> (<rule>)` line names a session that stays on the source.
- `--allow-secrets` also carries a session that holds a token or a secret, after you confirm. It never carries a session with a private key.
- `--no-sessions` turns the sessions and the project memory off.

For a session transcript, Ferry reads each record. It looks for tokens, and for a password or secret key with a value in tool inputs and tool results: in JSON, in config text such as `KEY=value` lines, and in command flags such as `--password <value>`.

### The limit of the session scan

The scan finds a secret only by a token pattern or next to a secret key or flag.

- A secret in free prose passes, such as a password that you typed in a message.
- In text, a value counts only when it looks like a literal. A bare value of only letters, such as `password: swordfish`, also passes, unless the key is in the env form, such as `PASSWORD=swordfish`.
- A value that is a number passes, so that a token count such as `input_tokens` is not a hit.

Use `--no-sessions` when a session can hold such a secret.

## Where the check runs

The deny rules run on the source machine. It reads each file one time and sends only the bytes that pass. With `--from-box`, the Ferry on the box does this, and Ferry compares the SHA-256 of each file that arrives. `--dry-run` copies no file.

So the box needs a release of Ferry from `ferry install` or `ferry update`:

- `Ferry is not installed on <box>` or `The Ferry on <box> is too old to check the files there` means that the box has no release of Ferry with the check. Run `ferry install` or `ferry update`.
- `The Ferry on <box> has older deny rules than this machine` means that Ferry copied no file. Run `ferry update`.
- A development build of Ferry puts no Ferry on a box. `ferry move --from-box` and `ferry adopt --from-box` then refuse.

See the [Security model](security-model.md#files-that-leave-a-box).

## The origin URL

When the origin URL on the source has a password, a token, or a secret query parameter, the plan has the line `Note: The origin URL has a credential. Ferry carries the URL without it`. The destination clones from the URL without the credential and needs its own login, for example `gh auth login` or a deploy key.

## Locks

After the plan and the confirmation, a move holds the sync lock of each box that it uses. A sync, `ferry update`, or `ferry box remove --uninstall` does not run on that box during the move. When a box is busy, the move fails with `sync-busy` and changes nothing. Run it again later. `--dry-run` takes no lock.

## Messages during a move

| Message | Meaning |
| --- | --- |
| `<file> changed on <machine> after the check` | A file changed after the plan and no longer passes the deny rules. The source did not send it. Run the move again to see the new plan. |
| `Refuse: <file> (Ferry cannot read the file)` | The source user cannot read the file. It stays on the source. |
| `Refuse: <directory> (a file or directory in <directory> has a token in its name)` | A name there has the form of a token. Ferry does not print the name. |
| `Ferry refused files from <box> after the copy` | The box sent a file that the operator machine refuses. Ferry wrote nothing of it to the destination. Run `ferry update`, and check the box when the message comes again. |
| `WARNING: Ferry could not register <path> in Paseo` | Only the Paseo step failed. The move is complete. Do not run it again for this. |

## Paseo

With the Paseo integration on, `ferry move` registers the project in the Paseo of the destination and imports each carried session as a Paseo agent. See [Integrations](integrations.md#paseo).
