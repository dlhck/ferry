---
title: What Ferry carries
description: The skills, instruction files, settings keys, MCP servers, and hook scripts that Ferry syncs, and what stays on each machine.
---

# What Ferry carries

`ferry sync` publishes a set of files and values from the operator machine to the snapshot, and applies them on each box. This page lists that set. For the rules that keep credentials out of it, see the [Security model](security-model.md).

## Linked paths

Both machines have a checkout of the snapshot at `~/.ferry/store`. These paths are symlinks into that checkout, on the operator machine and on each box:

| Item | Paths |
| --- | --- |
| Skills | Each entry in `~/.agents/skills` and `~/.claude/skills`, and in the `skill_root` of a custom harness |
| Instruction file | `~/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md`, and the `instruction_file` of a custom harness |
| Claude subagents | `~/.claude/agents` |
| Claude commands | `~/.claude/commands` |
| Claude hook scripts | `~/.claude/hooks` |

- Codex, Pi, and Cursor Agent read the shared skills in `~/.agents/skills`.
- A carried file keeps its executable bit, so a hook script runs on the box.
- Ferry does not manage the `.system` directory in a skill root. Codex owns it on each machine.
- A skill directory inside a project, such as `./.claude/skills`, is not managed.

On a box, each instruction file links to a generated file, `~/.ferry/box/AGENTS.md`. It has a Ferry header, your instructions for that box, and your `~/AGENTS.md`. See [Boxes](boxes.md#per-box-instructions).

## Settings keys

Ferry never carries a whole settings file. It carries these keys, and the box merges them into its own file:

| Agent | File | Keys |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | `enabledPlugins`, `extraKnownMarketplaces`, `permissions`, `hooks`, `attribution`, `includeCoAuthoredBy`, `model`, `alwaysThinkingEnabled`, `autoCompactWindow`, `modelSettings` |
| Codex | `~/.codex/config.toml` | `model`, `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`, `features`, `web_search` |
| Pi | `~/.pi/agent/settings.json` | `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `enabledModels`, `thinkingBudgets`, `enableSkillCommands` |
| Cursor Agent | `~/.cursor/cli-config.json` | `model`, `maxMode`, `hasChangedDefaultModel`, `attribution` |

- Sync replaces the carried keys on the box. A key that the operator machine does not have is removed from the box. The box keeps its other keys.
- Sync replaces the whole Claude `modelSettings` object with the operator's object. This replaces per-model effort levels and auto-compact windows saved on the box with `/effort` or `/autocompact`.
- Keys that can hold secrets, commands, or local paths stay on the operator machine. Examples are `env` and `apiKeyHelper` of Claude Code, and the providers, profiles, `notify`, and project trust of Codex.
- When a carried Codex key changes, sync writes `config.toml` again, and the comments in that file are lost.
- The box installs the Claude plugins of `enabledPlugins`. If a plugin comes from a marketplace that `extraKnownMarketplaces` does not list, run `claude plugin marketplace add` for it once on the operator machine.

### Hooks

Ferry carries the `hooks` key of Claude Code and the scripts in `~/.claude/hooks`. It leaves out a hook whose command refers to a home path that the box will not have, and prints `Skipped hook: <reason>: <location>`. To carry such a hook, move the script into a carried directory or onto the `PATH` of both machines.

## MCP servers

Ferry reads the MCP servers in `mcpServers` of `~/.claude.json`, `[mcp_servers]` of `~/.codex/config.toml`, and `mcpServers` of `~/.cursor/mcp.json`.

### Remote servers

Ferry carries the name and the HTTPS URL. Sync declares the server on the box. It replaces a box declaration with a different URL. It never removes a box server. Ferry skips a server with a plain `http://` URL. Log in to a server on the box with `ferry auth <tool> --mcp <server>`.

### Stdio servers

Ferry carries the name, the command, the arguments, and the names of the `env` keys. It never carries an `env` value.

- Set the values in the `env` of the server on the box. Ferry keeps them.
- Ferry never installs the command. `ferry status --brief` names each missing env key and each command that is not on the box.
- Ferry does not carry a server whose command or arguments refer to a path in your home, as an absolute path, `~`, `$HOME`, or `${HOME}`.
- Ferry does not carry a server whose command or arguments refer to a path in a macOS app bundle, a path with a `<name>.app/Contents/` part, as in `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl`. A box does not have the app. You have nothing to do, so `ferry status --brief` shows no item for it.
- Ferry does not carry a server that runs an inline script for a shell or an interpreter, such as `sh -c` or `node -e`, because Ferry cannot check the script. A script file passes, as in `node /srv/server.js`.
- A command or an argument with a token, a secret flag with a value, or a URL with a credential stops the sync.

The sync prints one line for each server that Ferry does not carry. After the sync, `ferry status` lists them in the [`Skipped MCP servers`](status.md#skipped-mcp-servers) block, each with the reason and what to change.

The [Security model](security-model.md#stdio-mcp-servers) has the full rules.

## What stays on each machine

Ferry never carries these with a sync:

- Logins, credential files, tokens, and API keys
- `.env` files
- Request headers and `env` values of MCP servers
- Session history, caches, and databases
- Whole settings files

`ferry move` carries the sessions of one project when you move that project. See [Moving a project](moving-a-project.md).

## Skills

Install skills with `ferry skills add <source>`. It runs `npx skills add` and adds `-g` and `--copy`, so the skill is a real directory in a global harness root, and the next sync links it into the store.

```sh
ferry skills add owner/repo --skill some-skill
```

A skill that an agent writes on a box stays on that box. `ferry status` lists it under `Box-only skills`. `ferry adopt --from-box <name> <skill>` copies it to the operator machine:

1. The Ferry on the box runs the deny rules on the skill. A skill that fails a rule does not leave the box.
2. Ferry copies the files that pass, and shows the file list of a new skill or the diff against your copy. Then it asks.
3. Ferry writes the skill to the same skill root on the operator machine and moves the box copy to `~/.ferry/backups` on the box.
4. Run `ferry sync` to publish the skill to all boxes.

## Agents and tools that are off

The policy `"off"` in `[tools]` or `[box.<name>.tools]` of `~/.ferry/config.toml` turns off `gh` or an agent CLI. An agent that is off also turns off its harness. Sync does not read that harness on the operator machine while the agent is off on every box. On a box where it is off, sync writes nothing there and removes the links that Ferry made earlier. The shared `~/.agents/skills` and `~/AGENTS.md` have no off switch.

## A custom harness

Add a harness that Ferry does not know in `~/.ferry/config.toml`:

```toml
[[harness]]
id = "opencode"
name = "OpenCode"
skill_root = ".config/opencode/skills"
instruction_file = ".config/opencode/AGENTS.md"
```

## History and revert

Each sync with a change is one commit in the snapshot.

- `ferry history` lists the last 20 snapshot commits and the paths each one changed.
- `ferry revert <commit>` undoes one commit on the operator machine, including the carried settings keys, then syncs all boxes. Later commits stay. `--no-sync` skips the sync, and `--dry-run` shows the plan.

Ferry stops and changes nothing when a later commit changes the same lines, or when the operator machine has changes that are not in the snapshot. Run `ferry sync` first.
