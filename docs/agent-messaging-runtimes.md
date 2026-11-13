---
title: Agent messaging runtimes
description: The Claude Code and Codex versions that the agent messaging tests passed, the real-CLI suite, the operator-run checks, and the map from each #306 criterion to its test.
---

# Agent messaging runtimes

This page records the runtime versions that Ferry's agent messaging was tested with. It also tells you how to run the tests that CI does not run, and which test or check covers each completion criterion of [#306](https://github.com/dlhck/ferry/issues/306). The design is in `docs/agent-messaging-design.md`.

## Tested versions

The real-CLI suite writes the table below. Do not edit the rows by hand. The suite keeps the newest run for each runtime, version, and platform.

The version gate of the adapters (design 9.2 and 9.3) uses these results:

- A version below the minimum (Claude Code 2.1.323, Codex 0.169.0) is `unsupported`. Ferry does not deliver to it.
- A version that passed all cases here is `supported`.
- A newer version is `untested`. Ferry delivers to it, and `ferry status --brief` and `ferry messaging status` report the untested version.

The suite has not run yet. Before the suite, the design probes passed on Linux with Claude Code 2.1.323 and Codex 0.169.0 (design section 20). Those probes are not a run of this suite.

<!-- e2e-runtimes:start -->
| Runtime | Version | Platform | Run | Result |
| --- | --- | --- | --- | --- |
<!-- e2e-runtimes:end -->

## Test layers

| Layer | Where | Runs in |
| --- | --- | --- |
| 1. Unit, state machines on a real SQLite file | `test/messaging/relay`, `test/messaging/github`, `test/messaging/client`, `test/messaging/worker`, `test/messaging/cli`, `test/messaging/sync` | `bun test`, CI |
| 2. Integration: relay, two workers, fake GitHub, fake runtimes, fault injection | `test/messaging/integration` | `bun test`, CI |
| 3. Real `claude` and `codex` in tmux | `test/e2e-runtimes` | `bun run test:e2e-runtimes`, on demand |
| 4. Two identities | One host: `test/messaging/integration/identities.test.ts`. Two hosts and two real GitHub accounts: operator-run, below. | CI, and the operator |
| 5. macOS | `scripts/messaging-macos-check.sh` | The operator, on a Mac |
| 6. Soak | `scripts/messaging-soak.ts` | The operator, on a box |

The shared harness is in `test/messaging/harness`. Each integration test makes a checkout with a GitHub remote, a linked worktree, and an ignored file, under the home of each identity. It records the state of the whole tree, `.git` and ignored files included, before the enrollment. After the test, it fails if one file was added, removed, or changed, also a rewrite with the same content.

## Real-CLI suite

The suite starts real Claude Code and Codex sessions. It uses real model tokens, so it runs only when you start it:

```sh
bun run test:e2e-runtimes
```

What the suite does:

- It starts the relay and a fake GitHub in the test process, on `127.0.0.1`. It enrolls two identities (`alice` and `bob`), each with its own `HOME` for Ferry state. It starts one `ferry messaging worker` for each identity.
- It starts each session in tmux, on a tmux server of its own (`tmux -L ferry-e2e-<pid>`). The sessions are plain `claude` and `codex` launches in a test checkout.
- It gives the Ferry hooks and the `ferry-messaging` MCP entry as CLI options only: `--settings` and `--mcp-config` for Claude, `-c` for Codex. It trusts the test checkout for Codex with `-c projects=...` for that launch only. It changes no global Claude or Codex setting. The runtimes keep their own logins.
- It copies the bundled `ferry-messaging` skill into each Ferry home, with one added line that tells the agent to end each Ferry answer with a random marker word. The marker is only in the skill file, never in a message. An answer with the marker proves that the model read the skill that the `SessionStart` context names.
- It writes its state to `$FERRY_E2E_RUNTIMES_DIR`, default `~/.cache/ferry-e2e-runtimes/<time>`. It never uses `/tmp`, and it writes nothing into a participating checkout. When a case fails, it saves each tmux pane to that directory.

Cases:

| File | Case |
| --- | --- |
| `both-directions.test.ts` | Claude to idle Codex, Codex to idle Claude, Claude to busy Codex, Codex to busy Claude. Each case checks the answer through the relay: request status `answered`, the answer refers to the request, the answer has the marker, and the answer reached the sender. |
| `normal-launch.test.ts` | For each runtime: a session on the branch `feat/clo-1442-example` joins the conversation with the issue link `CLO-1442` at registration, and its answer has the skill marker. |
| `failures.test.ts` | Claude at a permission prompt: a peer message that claims approval holds with `awaiting-approval`, the command does not run, and delivery follows after the human refuses. `/exit` and `kill -9` for each runtime: the session goes `offline`, and a request holds with `recipient-offline`. Stale Codex queue: a request is queued while Codex is busy, Codex is killed, the sender cancels, the thread resumes, the stale row runs, and the agent takes no action and sends no answer. |

The second mode of design 15.3 proves delivery, but not the global install. The global install is part of the box check and the macOS check below.

Known limits of the suite:

- Codex asks once on each machine to trust non-managed hooks. That trust is a global Codex setting, so the suite never answers the prompt. If Codex shows it, the case fails with a message. To run the Codex cases on that machine, open Codex once in a disposable directory with the same `-c hooks=...` value, trust the hooks with `/hooks`, and run the suite again. Do this only on a machine where you accept that change.
- If Codex asks for approval of the `ferry-messaging` tool calls, the Codex cases stall. Design 9.4 then needs the narrowest Codex setting that allows those tools. Report it on #306.

## Operator-run checks

These checks need a second box, a second GitHub account, or a Mac. CI cannot do them, and an automated run on this project's boxes must not use a teammate's account or box. Record each result on #306 with the date and the versions.

### A. Two hosts (real cross-machine delivery)

You need: your enrollment, a relay URL, and permission to create a short-lived box.

1. Create a second box: `ferry box create <name>` (see [Boxes](boxes.html)).
2. In `~/.ferry/config.toml`, set `messaging = true` for both boxes. Run `ferry messaging enroll --box <name>` for each box, then `ferry sync` to each box.
3. On each box, run `ferry messaging status`. The worker must run and the relay must be reachable.
4. On box 1, start `claude` in a clone of a participating repository. On box 2, start `codex` in a clone of the same repository.
5. In the Claude session, tell the agent: "Create a Ferry conversation named cross-host check, then send a request to the Codex session on the other box that asks for its branch name." Do the same in the other direction.
6. Check on each box: `ferry messaging requests --sent` shows `answered`. `ferry messaging show cross-host-check` shows the request, the answer, and the receipts with `delivered` evidence.
7. On box 2, run `kill -9` on the Codex process. On box 1, `ferry messaging peers` shows the session `offline` within 90 seconds. A new request shows `held: recipient offline`.
8. Run `git status` and `git stash list` in each clone. They must show no change from Ferry.
9. Remove the box: `ferry box remove <name> --uninstall`.

### B. Two GitHub identities (real GitHub permission API and device flow)

You need: a second GitHub account, a test organization that you own, and a relay host that you control.

1. Create the App: `ferry relay setup github-app --org <test org>`. Turn on "Enable Device Flow" when the command asks. Install the App on the test organization with access to one test repository.
2. Give the second account write access to the test repository.
3. Enroll each account on its own OS user or machine: `ferry messaging enroll --relay <url>`. Each enrollment opens the GitHub device flow in a browser.
4. Start one session for each account in a clone of the test repository. Exchange a request and an answer, as in check A, steps 5 and 6.
5. Lower the second account to read access in the repository settings.
6. Within 15 minutes, the session of the second account gets `no-project-access` from each `ferry_*` tool, `ferry messaging peers` of the first account no longer lists it in the conversation, and open requests assigned to it show `assigneeAccess: lost`.
7. Give write access again. A new session of the second account participates again after its next registration.
8. Remove the test App installation, or keep it only for these checks.

### C. macOS

On a Mac, from a Ferry checkout, after `ferry messaging enroll`:

```sh
scripts/messaging-macos-check.sh
```

The script installs the worker under launchd with `ferry messaging setup` (a global install on purpose), checks the launchd job `dev.ferry.messaging` and the worker socket, checks with `lsof` that a live Codex TUI holds its thread writer lock and that no process holds it after `kill -9`, and runs the real-CLI suite. The suite adds the `darwin` rows to the table above. The script prints a table of its steps. Paste it on #306.

### D. Soak

On a box, with a memory cap:

```sh
systemd-run --user --scope -p MemoryMax=2G -- bun scripts/messaging-soak.ts --hours 4
```

The script sends scripted updates and requests between four sessions (two owners, Claude and Codex each), with fake runtimes. With `--real`, it uses real sessions in tmux and real model tokens. It fails when the memory grows by more than `--max-growth-mib` (default 128) after the warm-up, when one message has two `acknowledged` handlings or one request has two answers, when a receipt stays `stored` without a hold for more than 5 minutes while its session is live, or when a session gets more than 20 wakes in 60 minutes. It writes `report.json` to `~/.cache/ferry-messaging-soak/<time>`.

## Acceptance map

Each completion criterion of #306, with the test or check that gives the evidence (design section 16).

| #306 criterion | Evidence |
| --- | --- |
| Receipt and reply between Claude Code and Codex in both directions, without Paseo or human copying, idle and busy | Layer 3: `test/e2e-runtimes/both-directions.test.ts`, four cases. Layer 2: `test/messaging/integration/delivery.test.ts` (idle request and answer, busy Claude, busy Codex). |
| Normal launches get the skill context and join relevant conversations automatically | Layer 3: `test/e2e-runtimes/normal-launch.test.ts`. Layer 2: `participation.test.ts` (the `SessionStart` context, link match, `auto_join = all`). The global install: checks A and C. |
| Delivery between two identities on separate machines, or a documented narrower scope | Layer 4 on one host: `identities.test.ts` (owner by user id, read permission refused, owner-login recipient, cross-owner claim refused, reassign). Two hosts: check A. Two real GitHub accounts: check B. The narrower scope until A and B pass: design section 18. |
| Failure behavior and the evidence for every delivery state | Layer 1: lane A receipt and request tests. Layer 2: `faults.test.ts` (relay killed during a send, worker stopped during an injection, repeated idempotency key, network drop, access lost), `lifecycle.test.ts` (worker offline, recipient offline), `delivery.test.ts` (approval hold, evidence kinds). Layer 3: `failures.test.ts` (approval, `/exit`, `kill -9`). |
| Enrollment, registration, participation, and adapter setup change no files in checkouts or Git metadata | The checkout state check after each layer 2 test (`useSystem` in `test/messaging/harness/system.ts`), after each layer 3 file, and at the end of the soak. Check A, step 8. |
| Join includes an active constraint older than the recent window, and resolution keeps history | Layer 1: lane A constraint and context tests. Layer 2: `participation.test.ts`, through `ferry_membership`, `ferry_constraint`, and `ferry_history`. |
| A recipient that never resumes, an explicit handoff, a late resume after close or reassignment, history persists, stale requests do not run | Layer 1: lane A lifecycle and generation tests. Layer 2: `lifecycle.test.ts` (claim between two sessions of one owner, stranded Codex delivery after a cancel and a resume, a recipient that never returns), `identities.test.ts` (reassign by the sender). Layer 3: the stale Codex queue case in `failures.test.ts`. |
| First-release decisions resolved, with explicit deferrals | Design section 1. |
| Minimal implementation plan, acceptance tests, and follow-up issues | Design sections 14, 15, 16, and 19, and this page. |

The open items of the first discovery milestone:

| Milestone item | Evidence |
| --- | --- |
| Active-turn steering into an independently launched Codex terminal | Not needed: Codex gets busy deliveries after the current turn (design 18). Layer 2 and layer 3 busy Codex cases. |
| Correlated reply in both directions without transcript inspection | Layer 3 `both-directions.test.ts`: the answer route is the relay. |
| Recipient waiting for approval, and a disconnected recipient | Layer 3 approval case. Layer 2 approval hold and worker-offline case. |
| Crash detection, liveness after terminal exit, late resume, stale queued requests | Layer 3 `/exit`, `kill -9`, and stale Codex queue. Layer 2 stranded Codex delivery with the fake Codex. |
| Normal launches after global installation, with authenticated registration and automatic participation | Layer 3 normal launch (CLI options). Check A (box, global install by sync). Check C (Mac, `ferry messaging setup`). |
| Supported versions and platform restrictions, macOS | The table on this page. Check C. |
