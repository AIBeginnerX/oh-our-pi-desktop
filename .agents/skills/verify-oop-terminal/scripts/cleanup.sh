#!/usr/bin/env bash
# Tears down ONLY what this run started (PIDs recorded at spawn), then removes the scratch dir.
# The evidence dir is never touched. Safe to re-run after a failed attempt.
. "$(dirname "$0")/common.sh"
args() { ps -ww -o command= -p "$1" 2>/dev/null; }
stop() {  # stop <pid> <must-contain>: signal only if the live command line proves it is ours
  if kill -0 "$1" 2>/dev/null && [ -n "$(args "$1")" ]; then
    if args "$1" | grep -q -- "$2"; then kill "$1"; for _ in $(seq 40); do kill -0 "$1" 2>/dev/null || break; sleep 0.25; done
      kill -0 "$1" 2>/dev/null && { echo "pid $1 still alive after SIGTERM; left running" >&2; return 1; }; echo "stopped pid $1"
    else echo "pid $1 is alive but not ours any more ($(args "$1")); not touching it" >&2; fi
  fi
}
# Keep the server's own log with the evidence before the home goes away.
[ -d "$WORK/home/userdata/logs" ] && cp -R "$WORK/home/userdata/logs" "$EVID/server-logs" 2>/dev/null || true
tm kill-server 2>/dev/null && echo "killed private tmux server $SOCK" || true   # kills the TUI with its pty
stop "$TUI_PID" "$BIN" || true
# The daemon detached into its own session: read its pid from OUR home's server-runtime.json.
RT=$WORK/home/userdata/server-runtime.json
pid=$SERVER_PID; [ -f "$RT" ] && pid=$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["pid"])' "$RT")
stop "$pid" "--base-dir $WORK/home" || true
case $WORK in /tmp/oop-verify-run-*) rm -rf "$WORK" ;; *) echo "refusing to rm $WORK" >&2 ;; esac
lsof -nP -iTCP:"$SERVER_PORT" -sTCP:LISTEN >/dev/null 2>&1 && echo "WARN port $SERVER_PORT still listening" || echo "port $SERVER_PORT free"
[ -d "$EVID/captures" ] && echo "evidence kept: $EVID ($(ls "$EVID/captures" | wc -l | tr -d ' ') capture files)"
