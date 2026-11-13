#!/bin/sh
# The macOS check of agent messaging (design 15.5). The operator runs it on a Mac,
# from a Ferry checkout, after `ferry messaging enroll`:
#
#   scripts/messaging-macos-check.sh
#
# Steps:
#   1. Preflight: macOS, and ferry, claude, codex, tmux, lsof, and bun on the PATH.
#   2. `ferry messaging setup`: the worker under launchd, the hooks, the MCP entry,
#      and the skill. This changes the user-level Claude and Codex settings of this
#      Mac on purpose: it is the global install that a teammate does.
#   3. The launchd job dev.ferry.messaging runs, and the worker socket exists.
#   4. The lsof liveness path for Codex: a live Codex TUI holds its thread writer
#      lock, and after kill -9 no process holds it.
#   5. The real-CLI suite (idle and busy delivery in both directions, and the
#      failure cases), which writes the darwin rows of docs/agent-messaging-runtimes.md.
#
# It prints one result line for each step, and exits 1 when a step failed.
# The state of the run goes to ~/Library/Caches/ferry-messaging-macos/<time>.

set -u

repo=$(cd "$(dirname "$0")/.." && pwd)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$HOME/Library/Caches/ferry-messaging-macos/$stamp"
mkdir -p "$out"
results="$out/results.txt"
failed=0

result() {
  printf '| %s | %s |\n' "$1" "$2" | tee -a "$results"
  case "$2" in pass*) ;; *) failed=1 ;; esac
}

printf '| Step | Result |\n| --- | --- |\n' | tee "$results"

# 1. Preflight
if [ "$(uname -s)" != "Darwin" ]; then
  echo "This check runs on macOS only." >&2
  exit 2
fi
missing=""
for tool in ferry claude codex tmux lsof bun; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  result "preflight" "fail: not on the PATH:$missing"
  exit 1
fi
if [ ! -f "$HOME/.ferry/messaging/client.json" ]; then
  result "preflight" "fail: no enrollment. Run ferry messaging enroll --relay <url> first."
  exit 1
fi
result "preflight" "pass: $(sw_vers -productVersion), $(claude --version | head -n 1), $(codex --version | head -n 1)"

# 2. Global install
if ferry messaging setup >"$out/setup.log" 2>&1; then
  result "ferry messaging setup" "pass"
else
  result "ferry messaging setup" "fail: see $out/setup.log"
fi

# 3. launchd job and worker socket
if launchctl print "gui/$(id -u)/dev.ferry.messaging" >"$out/launchd.txt" 2>&1 && grep -q "state = running" "$out/launchd.txt"; then
  result "launchd job dev.ferry.messaging" "pass: running"
else
  result "launchd job dev.ferry.messaging" "fail: see $out/launchd.txt"
fi
sock="$HOME/.ferry/messaging/worker.sock"
i=0
while [ ! -S "$sock" ] && [ "$i" -lt 20 ]; do sleep 1; i=$((i + 1)); done
if [ -S "$sock" ] && ferry messaging status --json >"$out/status.json" 2>&1; then
  result "worker socket and status" "pass"
else
  result "worker socket and status" "fail: see $out/status.json"
fi

# 4. lsof liveness path for Codex (design 9.3). A disposable repository, trusted
#    for this launch only with -c, so no global Codex setting changes.
probe="$out/codex-probe"
mkdir -p "$probe"
git -C "$probe" init -q
tmux_socket="ferry-macos-check-$$"
touch "$out/before-codex"
tmux -L "$tmux_socket" new-session -d -s probe -x 200 -y 50 \
  "cd '$probe' && exec codex -c 'projects={\"$probe\"={trust_level=\"trusted\"}}'"
codex_home="${CODEX_HOME:-$HOME/.codex}"
lock=""
i=0
while [ -z "$lock" ] && [ "$i" -lt 60 ]; do
  sleep 1
  i=$((i + 1))
  lock=$(find "$codex_home/thread-writer-locks" -name '*.lock' -newer "$out/before-codex" 2>/dev/null | head -n 1)
done
pane_pid=$(tmux -L "$tmux_socket" display -p -t probe '#{pane_pid}' 2>/dev/null)
if [ -z "$lock" ]; then
  result "codex lock: live session holds it" "fail: no new lock file in $codex_home/thread-writer-locks"
else
  holders=$(lsof -F p "$lock" 2>/dev/null | sed -n 's/^p//p' | tr '\n' ' ')
  if [ -n "$holders" ]; then
    result "codex lock: live session holds it" "pass: pids $holders(pane $pane_pid)"
  else
    result "codex lock: live session holds it" "fail: lsof shows no holder of $lock"
  fi
  for pid in $holders; do kill -9 "$pid" 2>/dev/null; done
  sleep 2
  if [ -f "$lock" ] && [ -z "$(lsof -F p "$lock" 2>/dev/null)" ]; then
    result "codex lock: kill -9 leaves no holder" "pass"
  elif [ ! -f "$lock" ]; then
    result "codex lock: kill -9 leaves no holder" "pass: the lock file is gone too"
  else
    result "codex lock: kill -9 leaves no holder" "fail: a process still holds $lock"
  fi
fi
tmux -L "$tmux_socket" kill-server 2>/dev/null

# 5. Real-CLI suite
if (cd "$repo" && FERRY_E2E_RUNTIMES_DIR="$out/e2e" bun run test:e2e-runtimes >"$out/e2e.log" 2>&1); then
  result "real-CLI suite" "pass: rows in docs/agent-messaging-runtimes.md"
else
  result "real-CLI suite" "fail: see $out/e2e.log"
fi

echo
echo "Results: $results"
echo "Add the table to the macOS section of docs/agent-messaging-runtimes.md, and commit the darwin rows of the suite."
exit "$failed"
