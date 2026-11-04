#!/usr/bin/env bash
# Read-only: is this run's instance worth driving? Exit 0 = yes. Run first whenever anything looks off.
. "$(dirname "$0")/common.sh"
fail=0; ok() { echo "ok    $*"; }; bad() { echo "FAIL  $*"; fail=1; }
alive() { kill -0 "$1" 2>/dev/null; }
args() { ps -ww -o command= -p "$1" 2>/dev/null; }

tm has-session -t v 2>/dev/null && ok "tmux session on private socket $SOCK" || bad "no tmux session on $SOCK"
alive "$TUI_PID" && args "$TUI_PID" | grep -q "$BIN" && ok "TUI pid $TUI_PID runs $BIN" || bad "TUI pid $TUI_PID is not our oop-rs"
cwd=$(lsof -a -p "$TUI_PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
[ "$cwd" = "$REPO" ] && ok "TUI cwd is the throwaway repo" || bad "TUI cwd '$cwd' != $REPO"
RT=$WORK/home/userdata/server-runtime.json
cur=$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["pid"])' "$RT" 2>/dev/null || true)
[ "$cur" = "$SERVER_PID" ] && alive "$SERVER_PID" && ok "daemon pid $SERVER_PID from our server-runtime.json" || bad "daemon pid mismatch/dead (json=$cur, run.env=$SERVER_PID)"
args "$SERVER_PID" | grep -q -- "--base-dir $WORK/home" && ok "daemon args carry our --base-dir" || bad "daemon --base-dir is not ours: $(args "$SERVER_PID")"
args "$SERVER_PID" | grep -q "$ROOT/apps/server/src/bin.ts" && ok "daemon runs this checkout's server entry" || bad "daemon is not this checkout's server"
[ "$SERVER_PORT" != 3773 ] && lsof -nP -iTCP:"$SERVER_PORT" -sTCP:LISTEN 2>/dev/null | awk '{print $2}' | grep -qx "$SERVER_PID" \
  && ok "port $SERVER_PORT is owned by the daemon (not 3773)" || bad "port $SERVER_PORT not owned by our daemon"
# The binary must be newer than the last commit touching the code under test.
last=$(git -C "$ROOT" log -1 --format=%ct -- apps/oop-tui-rs/src); bin=$(stat -f %m "$BIN")
[ "$bin" -ge "$last" ] && ok "binary built after the last apps/oop-tui-rs/src commit (HEAD $GIT_HEAD)" || bad "binary older than source; re-run cargo build"
st=$(OOP_HOME=$WORK/home "$BIN" status 2>&1 | grep "claudeAgent")
echo "$st" | grep -q "status=ready auth=authenticated" && ok "$st" || bad "Claude not ready: $st"
exit $fail
