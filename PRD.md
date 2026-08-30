# Ferry

A CLI that keeps a remote Linux agent box in the same portable shape as the operator machine. The operator machine is the source of truth. A second private git repository stores skills and one global instruction file. Both machines clone that repository and point harness directories at the clone with symlinks. Tailscale is the only path to the box. Logins stay on the box. The CLI starts those logins from the operator machine. It does not copy sessions.

This document is the v1 product specification after the design grill. The repository is empty. There is no existing code to change.

## Problem Statement

I set up a remote Linux box so agents can run there instead of on my laptop. I installed `gh`, Claude, Codex, Cursor Agent, Pi, Linear MCP, and the rest. The box works. Two jobs still fail by hand every time I touch a new host.

I must log in to every CLI on the box again. Those logins already exist on my laptop. I accept that I cannot copy OAuth sessions. I still want the CLI to start the login on the box and let me finish it in a browser on the laptop.

I must also keep skills and `AGENTS.md` the same so agents on the box behave like agents on the laptop. I have dozens of skills. The copies under Claude, Codex, Pi, and Cursor already drifted. I do not want to rsync `$HOME`. I do not want to copy `auth.json`, Keychain items, sqlite, or chat history.

Nothing I found does this job. Skill-fan-out tools stay on one machine. Dotfile tools will copy secrets if I am careless. Paseo and Herdr treat the machine that runs the agent as the owner of credentials. They do not push my laptop skill tree to a named host over Tailscale.

I want the laptop to stay the source of truth. The box is a deploy target. If the box drifts, the next sync overwrites it. I also want this to be an open-source tool other people can use for the same setup.

## Solution

Ferry is a small CLI I run on the operator machine (macOS or Linux). It is MIT licensed. Releases are compiled bun executables. The box does not run ferry.

`ferry init` is a wizard (all values also exist as flags). It records one Linux host (Tailscale name or IP, SSH user), the private snapshot git URL I created, and converts this machine onto the clone model. It seeds the store from the union of managed harness skill directories plus the home instruction file. Same skill name with different bytes is a refuse. If the remote already has files that clash with the seed, refuse. It writes operator config next to the store clone. It fails if Tailscale is missing. It probes the host over SSH on the tailnet.

`ferry install` prints each vendor's official install command for the allowlist (`gh`, Claude Code, Codex, Pi, Cursor Agent), asks for yes, then runs it on the box. `--yes` skips the prompt.

`ferry sync` commits every dirty allowed file in the local store clone (my git `user.name` / `user.email`, default message or `-m`), pushes, SSHes to the box, pulls the clone, and repairs symlinks. Missing git identity is a fail. No force-push. A skill folder that contains a secret-looking file fails the whole sync. Managed skill names that left the snapshot are removed from the symlink targets. Unmanaged junk stays.

`ferry auth` starts a vendor login on the box (device URL, printed URL, or port-forward) and I finish it on the laptop. Providers are `gh`, Claude, Codex, and Cursor Agent. Pi if we can start a real login without leaving me inside a TUI. Tokens land only on the box. Ferry never reads or sends laptop credential files.

`ferry status` reports Tailscale reachability, whether the store tip matches the box clone, whether harness paths are the expected symlinks, which CLIs still need a login, and the Tailscale address plus usual Paseo daemon port. It writes nothing. `--json` exists for scripts.

The portable set is user-global skills and one `AGENTS.md`. The forbidden set is credentials, host tokens, session history, caches, databases, MCP tokens, and settings files. Project-local skill directories stay in the project git repo.

First-box done is `init`, `install`, `sync`, `auth`, then `status` green on link and apply. I add the Paseo host myself.

## User Stories

1. As an operator, I want a single CLI named ferry, so that I do not assemble rsync, git, and SSH by hand each time I change a skill.

2. As an operator, I want ferry to be open source under MIT, so that other people can run the same setup without asking me.

3. As an operator, I want compiled binaries for macOS and Linux on both arm64 and x64, so that I do not need bun on the machine that runs ferry.

4. As an operator, I want those binaries on GitHub Releases, so that install is a download, not an npm runtime.

5. As an operator, I want `ferry init` to walk me through host, SSH user, and snapshot remote, so that a first run does not require a config lecture.

6. As an operator, I want every init value to exist as a flag, so that I can script a second machine later.

7. As an operator, I want `ferry init` to fail if Tailscale is missing on this machine, so that I do not configure a host I cannot reach securely.

8. As an operator, I want `ferry init` to probe the host over Tailscale and SSH, so that I learn a bad name or a missing key before the first sync.

9. As an operator, I want `ferry init` to be safe to run twice, so that I can fill a missing value without destroying the rest of the config.

10. As an operator, I want one named host in v1, so that the CLI does not grow a fleet model before the first sync works.

11. As an operator, I want the snapshot itself to be host-agnostic, so that a later second box can reuse the same remote.

12. As an operator, I want the snapshot in a private git repository I create, so that ferry the product and my skills do not share history.

13. As an operator, I want to pass that repository URL into init, so that ferry never mints a GitHub repo for me.

14. As an operator, I want `ferry init` to clone that remote into a store directory on this machine, so that the payload has one checkout.

15. As an operator, I want operator config to live next to that checkout and not inside it, so that my Tailscale hostname is not committed with the skills.

16. As an operator, I want `ferry init` to seed the store from every managed harness skill directory I already have, so that a Claude-only skill is not dropped.

17. As an operator, I want init to take a skill name once when two harness dirs are the same directory, so that I do not duplicate bodies.

18. As an operator, I want init to refuse a skill name when two harness dirs have different bytes, so that ferry does not pick a winner in silence.

19. As an operator, I want init to print leftovers that were not imported, so that I can move them by hand.

20. As an operator, I want init to include my home `AGENTS.md` as the one instruction file, so that Claude, Codex, Pi, and Cursor Agent read the same rules.

21. As an operator, I want init to convert this machine onto the clone, so that harness skill dirs and the home instruction file become symlinks into the store.

22. As an operator, I want that convert to refuse if a destination is not a directory ferry owns or an existing symlink into the checkout, so that a random file is not replaced.

23. As an operator, I want a store file that names the schema version and the managed harnesses, so that a later ferry can refuse an old store instead of writing into the wrong folders.

24. As an operator, I want init to refuse if the remote already has files that differ from the seed, so that a re-run cannot blast the only backup.

25. As an operator, I want an empty remote to receive the seed commit and a push, so that the first init creates the backup.

26. As an operator, I want the laptop to stay the only publisher, so that an edit on the box cannot become truth.

27. As an operator, I want `ferry sync` that publishes to refuse when this machine is not the configured source, so that a binary I copied to the box cannot overwrite the store.

28. As an operator, I want daily edits to happen through the symlinks, so that I do not think about four skill trees.

29. As an operator, I want `ferry sync` to commit every dirty allowed file in the store, so that I do not run git by hand.

30. As an operator, I want that commit to use my existing git name and email, so that history looks like me.

31. As an operator, I want sync to fail if git identity is missing, so that ferry does not invent an author.

32. As an operator, I want a default commit message and `-m` to override it, so that a thoughtful message is optional.

33. As an operator, I want sync to push after commit, so that the remote is the backup.

34. As an operator, I want no force-push and no history rewrite, so that the store stays a normal private repository.

35. As an operator, I want sync to SSH to the box, pull the clone, and repair symlinks, so that the box does not depend on a live laptop filesystem.

36. As an operator, I want sync to use ordinary SSH to the Tailscale name or IP, so that I do not need `tailscale ssh` ACLs.

37. As an operator, I want sync to stop if Tailscale shows the host offline, so that I do not hang on SSH.

38. As an operator, I want sync to work from a cafe on the same tailnet, so that the laptop does not need to be on the LAN.

39. As an operator, I want sync to print a plan before it writes, so that I can see commits, pulls, symlink repairs, and deletes.

40. As an operator, I want `ferry sync --dry-run` to show that plan and write nothing, so that I can check a first run.

41. As an operator, I want sync to refuse if a skill folder contains `.env`, `credentials.json`, or a private key, so that the git remote never gets a leaked secret.

42. As an operator, I want that refuse to fail the whole sync, so that a dirty skill cannot sneak through while the rest ships.

43. As an operator, I want sync to refuse auth files, host token files, session history, caches, and sqlite, so that a broad include cannot leak a login.

44. As an operator, I want a deny list named in dry-run and status, so that I can see what will never move.

45. As an operator, I want project-local skill directories left alone, so that those files travel with the project clone.

46. As an operator, I want MCP configs and portable settings left out of v1, so that secrets and format translation stay out of the first ship.

47. As an operator, I want a deleted skill on the laptop to disappear from managed symlink targets on the box, so that a rename does not leave the old name.

48. As an operator, I want unmanaged extra files next to those targets reported and left in place, so that a random file I created on the box survives.

49. As an operator, I want sync to leave sessions, logs, and auth on the box untouched, so that a sync does not log me out.

50. As an operator, I want a live non-empty skill directory on the box to refuse apply, so that ferry does not silently delete someone else's tree.

51. As an operator, I want `--force` to move that directory to a timestamped backup and then link, so that I can recover it.

52. As an operator, I want `--force` to copy nothing out of the old directory into the clone, so that the box cannot win names.

53. As an operator, I want apply to create missing harness paths as symlinks, so that a fresh box does not fail because Codex never ran.

54. As an operator, I want apply to be idempotent, so that a second sync with no store changes writes nothing meaningful.

55. As an operator, I want sync to fail closed if apply errors halfway, and to name the harness, so that I do not think a partial box is in sync.

56. As an operator, I want the same skill names behind every managed harness symlink, so that Claude and Codex cannot silently diverge.

57. As an operator, I want `ferry install` to put `gh`, Claude, Codex, Pi, and Cursor Agent on the box, so that I do not remember vendor curl lines.

58. As an operator, I want install to print the exact command before it runs, so that I can refuse a remote curl.

59. As an operator, I want a yes prompt on install, and `--yes` for scripts, so that both humans and CI can run it.

60. As an operator, I want install to use each vendor's current official command, so that ferry does not pin a distro of agent CLIs.

61. As an operator, I want install to fail if a vendor script fails, so that a half-installed box is visible.

62. As an operator, I want Paseo install and daemon writes out of ferry, so that pairing is not a ferry bug.

63. As an operator, I want init and status to print the Tailscale address and the usual daemon port, so that I can add the host in Paseo Desktop myself.

64. As an operator, I want `ferry auth` to list the providers it can start, so that I do not invent names.

65. As an operator, I want `ferry auth gh` to start GitHub login on the box and print the device URL here, so that I finish it in a local browser.

66. As an operator, I want `ferry auth codex` to start Codex login on the box with a callback or device path I can finish here, so that ChatGPT tokens land on Linux.

67. As an operator, I want `ferry auth claude` to start Claude login on the box and tell me how to finish it here, so that Linux writes credentials on the box only.

68. As an operator, I want `ferry auth` for Cursor Agent to start `agent login` (or the documented remote equivalent) on the box, so that I do not copy a laptop login.

69. As an operator, I want Pi auth started only when there is a real remote login ferry can drive, so that I am not dumped into a TUI.

70. As an operator, I want status to say when Pi is not logged in even if ferry cannot start that login, so that I still know the next manual step.

71. As an operator, I want `ferry auth` to refuse to read or send laptop credential files, so that I cannot clone a session by accident.

72. As an operator, I want auth to say when a provider is already logged in on the box, so that I do not rotate a working token by habit.

73. As an operator, I want new tokens only in the vendor's usual location on the box, so that the CLI works the next morning.

74. As an operator, I want a stuck port-forward to time out and say so, so that a dead SSH leave-behind is visible.

75. As an operator, I want ferry never to print token values, so that a copied terminal scrollback is not a leak.

76. As an operator, I want help text to state that logins are not copied, so that a future me does not file a bug for the design.

77. As an operator, I want SSH agent forwarding treated as optional and only for git-over-SSH on the box, so that I do not think it logs in `gh` or Claude.

78. As an operator, I want `ferry status` to show Tailscale online or offline for the host, so that I do not debug SSH first.

79. As an operator, I want status to show whether the last store commit is on the box clone, so that I know if I forgot to sync.

80. As an operator, I want status to show whether each managed path is a symlink into the clone, so that a broken convert is visible.

81. As an operator, I want status to show which vendor CLIs on the box still need a login, so that I know the next auth target.

82. As an operator, I want status to run without writing files, so that I can check a box I must not change.

83. As an operator, I want `ferry status --json` for scripts, so that I can alert when the box is behind the laptop.

84. As an operator, I want errors to name the machine that failed (operator, git remote, or box), so that I do not chase the wrong end of the path.

85. As an operator, I want the box to need only SSH, git, Tailscale, and the vendor CLIs, so that I do not install a second agent runtime for ferry.

86. As an operator, I want config to live on the operator machine only, so that the box does not need a ferry daemon.

87. As an operator, I want one sync at a time per host, so that two overlapping pulls do not fight.

88. As an operator, I want Herdr attach out of ferry, so that one remote story does not become two.

89. As an operator who uses Paseo, I want daemon keys and Paseo home denied, so that a sync cannot break pairing.

90. As a stranger with Tailscale and an empty Linux box, I want `init`, `install`, `sync`, `auth`, and a green status on link and apply to be done, so that I know when to stop.

91. As an operator, I want tests that prove a forbidden file never enters a commit, so that a future include cannot ship `auth.json`.

92. As an operator, I want tests that prove every managed harness symlink sees the same skill names, so that apply cannot diverge.

93. As an operator, I want tests that prove a dry-run does not touch a filesystem, so that I can trust `--dry-run`.

94. As an operator, I want Windows as source or target out of v1, so that symlink and credential-store work does not block the first ship.

## Implementation Decisions

- Ship one bun TypeScript CLI compiled to a standalone executable. Targets are darwin and linux, arm64 and x64. The operator machine runs it. The box does not need a ferry daemon or a ferry binary.

- Six user commands: `init`, `install`, `sync`, `auth`, `status`, and `watch`. `watch` stays in the foreground while launchd or a systemd user service owns its process lifecycle.

- Seven modules sit behind those commands. A registry of descriptors feeds them.

- **Registry.** Data, not behaviour. A harness descriptor names an id, a printed name, a skill root, and an instruction file. A tool descriptor names an id, an install command, and a login recipe: probe, login, one completion (device URL, printed URL, or manual guidance), and an optional callback fallback with a port forward. One builtin file holds the official five harnesses (shared agents root, Claude, Codex, Pi, Cursor Agent) and the official five tools (`gh`, Claude, Codex, Pi, Cursor Agent), so each is written down once. Manifest, Apply, Store, Install, and AuthStart take descriptors as input.

- **Registry loading.** A loader merges `[[harness]]` and `[[tool]]` entries from the operator config into the builtin set. It is a pure function over parsed config data. It refuses a duplicate id, an absolute path, a path that climbs out of the home, any path the Manifest deny set covers, a skill root that does not end in a skills directory, and a path another harness already owns. Descriptors are data. Ferry loads no plugin code from an entry.

- **Manifest.** Deep module. Interface: given a source home and the harness descriptors, return a seed (skill names and bodies, plus the one instruction file) or refuse with named clashes and forbidden hits. Implementation owns the union-and-refuse-on-byte-clash rule and the deny set (vendor auth files, host tokens, session history, caches, sqlite, daemon keys, MCP tokens, settings, secret-looking files inside a skill). The deny set is hardcoded here. A registry entry can add a path to scan; it cannot disable or widen a deny rule. Callers never pass a raw rsync set. Tests drive snapshot and refuse.

- **Store.** Deep module. Interface: clone or open the snapshot remote, publish a commit of the working tree, fetch the current tip, report whether local and remote and box tips match. Implementation owns git clone, commit, push, pull, and snapshot identity. Commits use the operator git identity. Missing identity is an error. Never force-push. Schema metadata in the store names schema version 2 and the full descriptor of every managed harness. A checkout whose ferry.json cannot be read, or which records another schema version, is refused instead of rewritten. Git command runner is an injected adapter. Tests use an in-memory fake.

- **Apply.** Deep module. Interface: given a store checkout and a target home, return a plan (create symlink, repair symlink, refuse live directory, backup-and-link, delete managed name), then commit the plan or only return it. The caller passes the harness descriptors, which carry the skill roots and the instruction-file targets. One-way. Store clone wins. A live non-empty real directory refuses unless the caller sets force, which backups then links and copies nothing into the clone. Unmanaged extras are reported and left. Tests use a temp home as the local-substitutable filesystem.

- **Link.** Deep module. Interface: resolve the named host to a reachable Tailscale address, open an SSH session, run a command or a port-forward, return stdout and a structured error that names operator, network, or box. Implementation owns Tailscale status parsing and OpenSSH. Not `tailscale ssh`. Tests inject a host adapter. Production talks to Tailscale and SSH.

- **AuthStart.** Deep module. Interface: `start(provider)` on a Link session. Returns a local action (open URL, or listen on a forwarded port) and never accepts a credential file from the source machine. Recipes come from the tool descriptors, and the completion kind decides the local action. A tool whose completion is manual is never probed, which is where Pi sits until a documented remote login exists that does not require an interactive TTY. Already authenticated returns already-done. Time out a stuck forward. Do not print secrets. Tests use the fake host.

- **Install.** Deep module. Interface: `plan()` returns the exact remote commands for the allowlist, `run(confirmed)` executes them over Link. The install command of every tool descriptor is the vendor official line. Latest, no version pin. The CLI prints the plan and requires confirmation unless yes is set. Tests assert the command list and that run is not called without confirm.

- **Status.** Shallow composer. Interface: return one report (link health, store identity, symlink health, remaining logins, printed Paseo listen hint). It calls the modules above. No extra policy lives here.

- CLI is a thin adapter. It parses flags, prints plans, and exits non-zero on refuse. It does not contain include or deny rules.

- Direction lock. Config records which machine is source. Publish must run there.

- One host in config for v1.

- Transport is Tailscale then OpenSSH. No public listen port from ferry. Offline tailnet is a hard fail.

- Paseo. Do not install it, start it, or write daemon config. Print address and the usual daemon port.

- Secrets. No age vault, no 1Password. Token values stay out of ferry output.

- MCP and settings are not in the snapshot.

- Concurrency. One sync at a time per host.

- Observability. Human text by default. Json on status. Log lines name the failing machine.

- License is MIT. CI builds the four release targets.

## Testing Decisions

A good test calls a module through its interface and asserts an outcome a user can name: this skill name was refused as a clash, this path was refused as forbidden, this plan is a dry-run with no writes, this provider start did not read a source credential file, this install did not run without confirm. Tests do not assert internal call order, log wording beyond a stable error code, or the shape of private structs.

Test these modules:

- Manifest. Union keeps a name that exists in only one harness. Same inode or same bytes collapse to one entry. Different bytes for the same name refuse. Forbidden names never appear. A secret-looking file inside a skill refuses the snapshot. Identity changes when a skill is added or removed.

- Apply. A temp target home gets the same skill names through every managed symlink. A deleted skill becomes a delete in the plan and is gone after commit. Dry-run leaves the temp home unchanged. A live real directory refuses. Force moves it aside and then links. Auth files already on the target stay.

- Store. A fake git adapter receives one publish and returns the same snapshot on fetch. A second publish of the same bytes does not require a force update. Clash with an existing remote file refuses. Missing git identity refuses.

- AuthStart. Each known provider issues the expected remote command pattern. Supplying a source credential file errors. Already-done is returned when the fake host reports a logged-in probe. A timeout path returns a visible error.

- Install. Plan lists only the allowlist. Run without confirm is refused. A failed remote command is a failed install.

- Link. A fake host offline error becomes a structured host-offline result. The module does not retry forever.

Do not add a suite that shells out to a real Tailscale network in v1. Do not test the CLI string parser beyond a few wiring tests if the modules above are covered.

Prior art: none in this repository. The first tests are these interface tests.

## Out of Scope

- Copy or proxy of Claude, Codex, `gh`, Cursor Agent, or Pi sessions from the operator machine onto the box.
- 1Password, `op run`, age vaults, or any secret manager.
- MCP declarations, Linear OAuth as a ferry verb, and settings sync.
- agentsync-style projection of one config format into every harness.
- skillshare, chezmoi, or other tools as a required runtime.
- Herdr remote attach, SSH_AUTH_SOCK repair, or tmux-style sessions.
- Paseo Hub, Paseo Docker image authoring, Paseo daemon install, or writing daemon listen config.
- Fleet of hosts, team sharing, or org-wide skill registries.
- Windows as source or target.
- Bidirectional sync. The box never wins.
- Full home directory or full vendor home trees.
- A Ferry-owned background daemon. `ferry watch` does not fork or daemonize itself.
- Rewriting git history.
- Creating the snapshot GitHub repository for the user.
- npm or bunx as the primary distribution. Homebrew can wait.
- Plugin code in the registry. A custom harness or tool is a declarative config entry: paths and commands, never code ferry loads.

## Further Notes

`dlhck/ferry` holds the CLI. The portable snapshot is a second private repository. Init makes that split explicit.

Locked operator paths, for implementers: store clone at `~/.ferry/store`, config at `~/.ferry/config.toml`, store contents `skills/`, `AGENTS.md`, and `ferry.json`. Managed symlink targets are the shared agents skill root, Claude skills, Codex skills, Pi skills, Cursor Agent skills, and the home instruction files those tools already follow.

v1 success is narrow. Init on the operator machine, install of the allowlist, one sync that leaves the box on the same clone, status that shows a match, and one auth per provider ferry can start. After that, daily work is edit through the symlink and sync.

If a later version adds a second host, Manifest, Store, and Apply should not change. Only Link config grows a host list.
