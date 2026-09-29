# Paseo sync

With the Paseo integration enabled for a box, `ferry sync` carries agent profiles, managed Git plugins, metadata model preferences, and shared system instructions from the operator machine. These go directly to the box. They are not stored in the snapshot repository. `ferry watch` detects changes to plugin commits, enabled states, and the two preferences.

## Git plugins

Ferry reads `~/.paseo/config.json`, `~/.paseo/plugins/sources.json`, and each managed checkout's Git HEAD. It carries the plugin ID, repository URL, plugin subdirectory, installed commit, and enabled state. It uses `paseo plugin install --ref` for a missing plugin and `paseo plugin update --ref` for an existing plugin. An unchanged plugin needs no install or update.

- The box daemon must have access to the Git repository. SSH agent forwarding to the Ferry command does not give the running Paseo daemon access to that agent.
- Ferry keeps the box's global `pluginsEnabled` switch. To run plugins, enable plugins in Paseo on that box.
- Ferry preserves box-only plugins. Removing a local plugin does not uninstall its box copy.
- A matching ID with a different repository or subdirectory produces a warning. Ferry does not replace it.
- New plugins that are disabled locally are skipped. Paseo's install command enables new plugins, so installing then disabling would briefly run their code. Existing box plugins can be disabled and updated.
- Local-directory plugins, npm plugins, and dirty Git checkouts produce warnings and are skipped. Local paths and URLs with embedded credentials are refused.
- Plugin settings, credentials, acquisition caches, build output, and source files are not copied. Paseo acquires and prepares the plugin on the box.
- Plugin commands run before agent profiles, so a plugin can provide a profile's provider. A plugin command failure produces a warning and does not block the core sync.

Use `ferry sync --dry-run` to review IDs, commits, enabled states, and local skip reasons without connecting to a box. Source conflicts require a box connection and are reported during sync.

## Preferences

Ferry reads two fields from `~/.paseo/config.json` and writes them into the box `~/.paseo/config.json`. Then it runs `paseo daemon reload`. Paseo 0.10.1 applies both fields on reload without a restart, although the metadata generation page still says to restart after a direct edit.

| Field | Contents |
| --- | --- |
| `agents.metadataGeneration.providers` | The ordered list of providers that Paseo tries first for workspace titles, worktree branch names, commit messages, and pull request text. Each entry has a `provider`, an optional `model`, and an optional `thinkingOptionId`. |
| `daemon.appendSystemPrompt` | Shared instructions that Paseo adds to the system prompt of each agent on the box. |

- Ferry carries only these two fields. It does not copy other keys, provider definitions, environment blocks, or credentials. It keeps all other box keys.
- A field that the local config does not set keeps the box value. An explicit empty list or empty string clears the box value.
- Ferry skips each metadata provider that is not available on the box, as it does for agent profiles. When no local provider is available on the box, Ferry keeps the box list.
- Ferry refuses the sync before it publishes or connects to a box when a field does not match the Paseo schema, or when it holds a token or a `key: value` secret line. The error names the field and the rule, never the text or the value.
- `ferry sync --dry-run` and its `--json` plan show the providers and the length of the shared instructions. They never show the instruction text.
- The shared instructions change the instructions of each agent on the box. A preference failure produces a warning and does not block the core sync.

Project scripts, setup, and metadata instructions stay in each project's `paseo.json`, which travels with the project in Git.

## Other sync candidates

Research checked on 2026-09-29 against Paseo 0.10.1 and current upstream documentation. The entries below are proposals, not implemented sync behavior.

| Candidate | Recommendation | Required handling |
| --- | --- | --- |
| Workspace label names and colors | Next candidate | Merge by Paseo's normalized, case-insensitive label name. Preserve box-only labels and workspace assignments. Local color wins for a matching name. Treat a rename as a new definition unless explicit rename history is available. |
| Terminal profiles | Conditional | Commands must exist on the target OS. Reject credentials and local absolute paths. Do not copy environment blocks without a field-level policy. |
| Auto-archive after merge | Small candidate | Carry `daemon.autoArchiveAfterMerge` only with an explicit setting, since it changes workspace lifecycle. |
| Provider definitions and model lists | Conditional | Carry portable names, model lists, and tool policies. Keep credentials and machine-specific command paths local. |
| npm plugins | Feasible follow-up | Paseo exposes package identity and installed version. Use pinned versions and box-local registry authentication. Git is not the only portable source type. |
| Project scripts, setup, and metadata instructions | Use project Git | These already live in `paseo.json`. Carry them with the project rather than maintaining a second copy in host sync. |
| Schedules | Explicit migration only | Map project paths, verify providers, and select one execution host. Copying an active schedule can run a task twice. |
| Plugin settings | Defer | Each plugin owns its schema and may store credentials or host paths. Need a portable-field contract first. |

Do not sync daemon identity, pairing or auth data, network listeners, relay endpoints, browser sessions, running agents, heartbeats, worktree paths, or workspace state as general preferences.

### Label API gap

Paseo stores label definitions as names and colors, separate from workspace assignments. Its label service currently creates a definition only when assigning a label to a workspace. The update operation rejects an unknown label. The CLI has no label management command.

The daemon caches the catalog and commits label changes with workspace transactions. Copying the catalog file while it runs would bypass that state and could lose changes. A safe implementation needs a standalone label upsert API and CLI command that accepts a name and color without a workspace ID. Ferry can then merge definitions without touching assignments or restarting the daemon.

### Sources

- [Plugin installation and sources](https://paseo.sh/docs/plugins.md)
- [Managed Git and npm acquisition](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/plugins/managed-source.ts)
- [Label creation, update, and assignment behavior](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/workspace-labels/internal/service.ts)
- [Label catalog transactions and cache](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/workspace-labels/internal/catalog-store.ts)
- [Host configuration fields](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/persisted-config.ts)
- [Metadata generation preferences](https://paseo.sh/docs/metadata-generation.md)
- [Custom provider definitions](https://paseo.sh/docs/custom-providers.md)
- [Project worktree configuration](https://paseo.sh/docs/worktrees.md)
- [Schedules](https://paseo.sh/docs/schedules.md)
