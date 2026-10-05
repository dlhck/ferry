---
title: Box-local secrets
description: Transfer selected environment variables to one box, outside normal sync and the Git snapshot.
---

# Box-local secrets

Run `ferry secrets` on the operator machine. It transfers only the names that you select, to one selected box, over SSH standard input. It never scans for credentials or distributes them through normal sync. Paseo is optional.

Every process started from a shell or service that loads these variables can access them. The box user and the agents that run as that user can read the plaintext files. This is a box-user environment, with no project isolation. Ferry shows this scope before transfer and asks for confirmation. `--yes` accepts the scope without a prompt. Use keys whose permissions fit the agents on the box.

## Select a source and a box

Select names from the operator environment:

```sh
ferry secrets set STRIPE_API_KEY --box dev
```

Or read the selected names from an explicit file:

```sh
ferry secrets set STRIPE_API_KEY --file /path/to/selected.env --box dev
```

The file format is literal `NAME=value`, one record per line. Empty lines and lines that start with `#` are ignored. Names must be unique. Quotes, spaces, dollar signs, and backslashes in a value are literal. Ferry does not remove quotes, expand variables, or run shell code. This is not a shell script or a general dotenv parser. Only the names in the command are transferred.

To enter values without terminal echo:

```sh
ferry secrets set STRIPE_API_KEY --prompt --box dev
```

`--prompt` needs a terminal and cannot be combined with `--file` or `--json`. Never put a value in a command argument. Names must match `[A-Za-z_][A-Za-z0-9_]*`; `FERRY_SECRET_` is reserved for the loader. Values can contain spaces, quotes, dollar signs, backticks, backslashes, tabs, and UTF-8 text. Line breaks, NUL, other control characters, invalid UTF-8, and Unicode noncharacters are refused. Errors never show a value.

`--box` selects exactly one configured box. Without it, Ferry uses `default_box`, then the only box. With more than one box and no default, Ferry requires a selection.

## Replace, inspect, and remove

Adding variables keeps unrelated entries. An existing selected name stops the transfer unless you give `--replace`, even when its value is the same:

```sh
ferry secrets set STRIPE_API_KEY --prompt --replace --box dev
ferry secrets status --box dev
ferry secrets status --box dev --json
ferry secrets remove STRIPE_API_KEY --box dev
```

Status shows file presence and stored names. The full `ferry status` report also has these fields in each box's `secrets` section. Neither report shows values or value hashes. A removal keeps unrelated entries. It does not revoke the key at its issuer or clear an environment that a running process already has.

## Shell startup and direct CLI commands

`ferry secrets set` writes the literal data reader `~/.ferry/secrets/load.sh`. Shell loading is an explicit opt-in. Add this exact line to your own startup file on the box:

```sh
[ -r "$HOME/.ferry/secrets/load.sh" ] && . "$HOME/.ferry/secrets/load.sh"
```

Ferry does not add this line. Secrets commands, sync, update, and uninstall do not read or change shell startup files for secrets, including symbolic links. The existing Ferry PATH block in `~/.profile` still follows the normal sync and uninstall behavior.

| Shell | Supported startup modes | Files |
| --- | --- | --- |
| POSIX sh and dash | Login, including an SSH login session | `~/.profile` |
| POSIX sh and dash | Interactive non-login | The file selected by `ENV`, if you set it |
| bash | Login, including SSH login | The first existing readable file of `~/.bash_profile`, `~/.bash_login`, `~/.profile` |
| bash | Interactive non-login | `~/.bashrc` |
| zsh | Login, including SSH login | `${ZDOTDIR:-$HOME}/.zprofile` |
| zsh | Interactive, including interactive login | `${ZDOTDIR:-$HOME}/.zshrc` |

Put the line before any early return in the chosen file. For bash login, edit the file bash already reads; creating `.bash_profile` or `.bash_login` can stop it from reading `.profile`. An interactive zsh login reads both `.zprofile` and `.zshrc`; sourcing the loader twice exports the same stored values. With no user-added line, a new shell does not load these secrets. Fish, shells started with startup files disabled, cron, and other services need their own environment integration.

A non-interactive `ssh box command` or `sh -c` can bypass startup files. Do not depend on it loading secrets. Some bash SSH command modes read `.bashrc`, but that behavior is not a portable promise. For an explicit shell integration, source the loader before you start the agent:

```sh
[ -r "$HOME/.ferry/secrets/load.sh" ] && . "$HOME/.ferry/secrets/load.sh"
```

The loader exports literal records with no `eval` or value expansion. It disables shell tracing while it reads values. Do not source `agent.env` or `systemd.env` directly. Programs can still print or log their own environment, so Ferry cannot prevent an agent or CLI from disclosing a key.

After you add the line, open a new SSH session after a transfer and start the agent there. Its direct child CLI processes inherit the variables. Existing shells, agents, and daemons keep their old environment. A nested shell also inherits its parent's old environment; removal from storage does not unset an inherited value. Reconnect for a fresh environment, or explicitly unset removed names in a shell that you control.

For Stripe, provision `STRIPE_API_KEY`, then an agent in the updated session can run `stripe customers list --limit 1` directly. [Stripe documents `STRIPE_API_KEY` as the CLI API key variable](https://docs.stripe.com/cli/api_keys). Its environment variables take precedence over its other key sources. Use a test or restricted key that permits the intended command. Stripe's native login session and credential store are outside this feature. `STRIPE_SECRET_KEY` is not the variable in this CLI example.

## Optional Paseo service

When Paseo is enabled, Ferry adds this line to its managed user service:

```ini
EnvironmentFile=-%h/.ferry/secrets/current/systemd.env
```

The `-` permits a missing file. Provisioning reloads the systemd unit configuration if needed, but does not restart Paseo. Sync and integration enable keep the line, and update adds it to an older unit. Transfer reports the explicit restart step. On the box, when you can stop its active agents:

```sh
systemctl --user restart ferry-paseo.service
```

Start a new Paseo agent after the restart. Its child CLI processes inherit the service variables. Other daemons need their own environment integration. No Paseo command is required for provisioning or shell use on a box without Paseo.

## Storage and security boundary

Ferry stores the data under `~/.ferry/secrets`, outside `~/.ferry/store`. The directory and generation directories have mode `700`. The literal `agent.env` data and separately escaped `systemd.env` have mode `600`. An atomic `current` pointer change selects both files together. A failed merge or publication keeps the old files. Selected values travel only on SSH standard input, and Ferry suppresses transport output from secrets operations. Results, plans, logs, and errors contain no values or value hashes.

Shell and systemd parsing rules differ. Ferry generates the systemd file from the same literal data and escapes its quotes and backslashes under the [systemd EnvironmentFile rules](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml). The shell loader never sources that file.

A busy operation reports the box lock directory `~/.ferry/secrets/.lock`. Wait for the active secrets command to finish. If a command was killed and no secrets command is running, remove the empty lock directory on the box with `rmdir "$HOME/.ferry/secrets/.lock"`, then retry. Ferry does not remove stale locks automatically.

`ferry box remove --uninstall` keeps the loader, private directory, stored values, and any loading line that you added yourself. Remove your line when you no longer want shell loading. Revoke keys at their issuers when they are no longer needed. Normal sync still excludes credentials. There is no reverse secret transfer, automatic distribution, or project-specific environment in this feature.
