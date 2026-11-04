#!/usr/bin/env bash
# Builds oop-rs (existing target dir), makes an isolated home + a throwaway git repo, starts the
# TUI in a private tmux server (the TUI starts its own daemon from THIS checkout's server entry).
# Prints `export RUN=<id>`. Everything it needs later is in /tmp/oop-verify-evidence/<id>/run.env.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../../.." && pwd)            # the checkout this skill lives in
TM=${TMUX_BIN:-/opt/homebrew/bin/tmux}
RUN=${RUN:-$(date +%Y%m%d-%H%M%S)-$$}
EVID=${OOP_VERIFY_EVIDENCE_ROOT:-/tmp/oop-verify-evidence}/$RUN
WORK=/tmp/oop-verify-run-$RUN                     # scratch: home + repo. Removed by cleanup.sh
SOCK=verify-oop-$RUN
BIN=$ROOT/apps/oop-tui-rs/target/debug/oop-rs
mkdir -p "$EVID/captures" "$WORK/home" "$WORK/repo"
echo "$(date +%H:%M:%S)  launch.sh RUN=$RUN" >> "$EVID/commands.log"

# Build once. Never set CARGO_TARGET_DIR (disk is tight); the checkout's own target/ is reused.
(cd "$ROOT/apps/oop-tui-rs" && cargo build 2>&1 | tail -2) | tee -a "$EVID/commands.log"

# Throwaway project: a real git repo, so the app treats it as a project folder.
(cd "$WORK/repo" && git init -q && echo "# verify-oop" > README.md && git add . \
  && git -c user.email=v@example.invalid -c user.name=verify commit -qm init)
REPO=$(cd "$WORK/repo" && pwd -P)                 # /private/tmp/... on macOS

# OOP_HOME isolates the data dir; OOP_DAEMON_ENTRY makes oop-rs start THIS checkout's server
# (without it an isolated home refuses to start the installed app). Port scan starts at 3873.
tm() { "$TM" -L "$SOCK" "$@"; }
tm new-session -d -s v -x 200 -y 50 -c "$REPO" \
  "env OOP_HOME=$WORK/home OOP_DAEMON_ENTRY=$ROOT/apps/server/src/bin.ts OOP_RS_FIRST_PORT=3873 \
   COLORTERM=truecolor TERM=xterm-256color LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 $BIN"
TUI_PID=$(tm display -p -t v '#{pane_pid}')

for _ in $(seq 60); do   # ready = the daemon announced itself AND the TUI drew its thread list
  [ -f "$WORK/home/userdata/server-runtime.json" ] && tm capture-pane -t v -p | grep -q "Threads" && break
  sleep 1
done
[ -f "$WORK/home/userdata/server-runtime.json" ] || { echo "server never announced" >&2; exit 1; }
SERVER_PID=$(python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["pid"],d["port"])' "$WORK/home/userdata/server-runtime.json")
cat > "$EVID/run.env" <<ENV
RUN=$RUN
ROOT=$ROOT
WORK=$WORK
REPO=$REPO
SOCK=$SOCK
BIN=$BIN
TUI_PID=$TUI_PID
SERVER_PID=${SERVER_PID% *}
SERVER_PORT=${SERVER_PID#* }
GIT_HEAD=$(git -C "$ROOT" rev-parse --short HEAD)
ENV
# Provider checks run after the server is up: installed=false/auth=unknown for the first seconds.
# Ready means the provider CLI is probed, not just that the port answers.
for _ in $(seq 60); do
  OOP_HOME=$WORK/home "$BIN" status 2>/dev/null | grep -q "claudeAgent .*status=ready" && break
  sleep 1
done
echo "export RUN=$RUN   # evidence: $EVID"
