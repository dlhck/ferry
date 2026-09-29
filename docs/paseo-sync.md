# Paseo sync

With the Paseo integration enabled for a box, `ferry sync` carries agent profiles, managed Git and npm plugins, provider definitions, metadata model preferences, and shared system instructions from the operator machine. These go directly to the box. They are not stored in the snapshot repository. `ferry watch` detects changes to plugin commits, npm versions, enabled states, provider definitions, and the two preferences.

## Git and npm plugins

Ferry reads `~/.paseo/config.json` and `~/.paseo/plugins/sources.json`. For a Git plugin, it also reads the managed checkout's Git HEAD. It carries the plugin ID, repository URL, plugin subdirectory, installed commit, and enabled state. It uses `paseo plugin install --ref` for a missing plugin and `paseo plugin update --ref` for an existing plugin. An unchanged plugin needs no install or update.

For an npm plugin, Ferry reads the installed version from the plugin's `package-lock.json` and checks it against the installed `package.json`. It carries the plugin ID, package name, plugin subdirectory, exact installed version, and enabled state. It never carries the requested tag or range. It uses `paseo plugin install npm:<package>@<version>` for a missing plugin and `paseo plugin update --version <version>` for an existing plugin. Ferry moves the box to the operator's version, also when the box has a later version. Scoped packages, such as `@acme/review`, are supported.

- The box daemon must have access to the Git repository. SSH agent forwarding to the Ferry command does not give the running Paseo daemon access to that agent.
- For npm plugins, the box daemon needs `npm` on its PATH and access to the registry. Ferry uses the box's own npm configuration and authentication. It does not carry `.npmrc`, registry tokens, or the lockfile's resolved URL.
- An installed version that is not an exact semver version, and a package name or version that looks like a credential, stops the sync with an error. The error does not show the value. A missing lockfile, or a lockfile version that does not match the installed `package.json`, also stops the sync.
- After at least one enabled plugin is installed or current on the box, Ferry sets the box's global `pluginsEnabled` switch to `true` in `~/.paseo/config.json` and runs `paseo daemon reload`. Paseo 0.10.1 applies the switch on reload without a restart. Paseo has no CLI command for the switch. Ferry keeps all other config keys and does not write the file when the switch is already on.
- Turning on the switch starts every plugin that is enabled on the box, including box-only plugins. Ferry disables locally disabled plugins before it turns on the switch.
- Ferry never turns off the switch. With no enabled plugin to carry, or when all plugins are skipped, disabled, or in conflict, the switch stays as it is.
- Ferry preserves box-only plugins. Removing a local plugin does not uninstall its box copy.
- A matching ID with a different source kind, repository, package, or subdirectory produces a warning. Ferry does not replace it.
- New plugins that are disabled locally are skipped. Paseo's install command enables new plugins, so installing then disabling would briefly run their code. Existing box plugins can be disabled and updated.
- Local-directory plugins, unknown source kinds, and dirty Git checkouts produce warnings and are skipped. Local paths and URLs with embedded credentials are refused.
- Plugin settings, credentials, acquisition caches, build output, and source files are not copied. Paseo acquires and prepares the plugin on the box.
- Plugin commands run before agent profiles, so a plugin can provide a profile's provider. A plugin command failure produces a warning and does not block the core sync.

Use `ferry sync --dry-run` to review IDs, commits, npm versions, enabled states, and local skip reasons without connecting to a box. Source conflicts require a box connection and are reported during sync.

## Provider definitions

Ferry reads `agents.providers` from `~/.paseo/config.json` and merges an allowlist of fields into `agents.providers` of the box `~/.paseo/config.json`. Then it runs `paseo daemon reload`. Paseo 0.10.1 applies `agents.providers` on reload without a restart.

| Field | Carried |
| --- | --- |
| Provider ID, `extends`, `label`, `description` | Yes |
| `models`, `additionalModels` | Yes. The local list replaces the box list and keeps its order. Ferry copies only the model keys that Paseo knows: `id`, `label`, `description`, `isDefault`, and `thinkingOptions`. |
| `disallowedTools`, `paseoTools` | Yes. `paseoTools` merges by key. |
| `env`, `params` | No. They can hold credentials, endpoints, and host paths. |
| `command` | No for a provider that the box defines. See the create rules below. |
| `enabled`, `order` | No. Each host keeps its own provider state and menu order. |

- A provider that the box defines keeps its box `env`, `command`, `params`, `enabled`, `order`, and other box fields. A field that the local entry does not set keeps the box value.
- Ferry keeps box-only providers. Removing a local provider does not remove its box copy.
- When the box defines the same ID with a different `extends` value, Ferry produces a warning and does not change it.
- Ferry creates a provider that the box does not define only when the result works without local runtime fields. It skips the provider with a warning when the local entry has `env` or `params`, or is disabled. Define the provider on the box first. Then Ferry syncs its portable fields.
- A new provider with a `command` is created only when all of these are true: the executable is a bare name and is not a shell or interpreter, such as `sh` or `node`; no argument or flag value is a path, a file name, or text with spaces; no URL argument has a user, password, query, or fragment; every URL argument is a remote `http:` or `https:` URL, so `file:` URLs and `localhost`, `127.0.0.1`, and `[::1]` endpoints are skipped; no argument looks like a credential; and `command -v` finds the executable on the box PATH before Ferry writes the config. Scoped npm packages, such as `@scope/name`, are the one accepted slash. A box provider that already exists keeps its own command and gets the allowlisted fields.
- Ferry refuses the sync before it publishes or connects to a box when an entry does not match the Paseo schema, or when a carried field holds a token or a secret. The error names the provider and the rule, never the value.
- Warnings and errors never show env values, command arguments, or box config contents. `ferry sync --dry-run` and its `--json` plan show provider IDs, carried field names, model IDs, and skip reasons.
- An entry in Paseo's legacy runtime format, on either host, produces a warning and is skipped.
- Provider definitions are carried after plugins and before agent profiles and preferences, so a profile or a metadata provider can use a provider that the same sync creates. A provider failure produces a warning and does not block the core sync.

## Preferences

Ferry reads two fields from `~/.paseo/config.json` and writes them into the box `~/.paseo/config.json`. Then it runs `paseo daemon reload`. Paseo 0.10.1 applies both fields on reload without a restart, although the metadata generation page still says to restart after a direct edit.

| Field | Contents |
| --- | --- |
| `agents.metadataGeneration.providers` | The ordered list of providers that Paseo tries first for workspace titles, worktree branch names, commit messages, and pull request text. Each entry has a `provider`, an optional `model`, and an optional `thinkingOptionId`. |
| `daemon.appendSystemPrompt` | Shared instructions that Paseo adds to the system prompt of each agent on the box. |

- The preference step carries only these two fields. It does not copy other keys, environment blocks, or credentials. It keeps all other box keys. Provider definitions have their own step. See [Provider definitions](#provider-definitions).
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
