#!/usr/bin/env bash
# Drive the TUI in its private tmux session. Every call is appended to $EVID/commands.log.
#   drive.sh key <tmux-key>...          e.g. Enter, Escape, Up, C-g
#   drive.sh type <text>                literal text into the composer (no Enter)
#   drive.sh say <text>                 type + Enter (sends a message / runs a slash command)
#   drive.sh wait <regex> [secs=60]     wait until the plain screen matches (extended regex)
#   drive.sh waitgone <regex> [secs=120]
#   drive.sh cap <label>                save captures/NN-<label>.ansi (colour) + .txt, print its bar row
#   drive.sh sample <label> <n> <secs>  n captures, <secs> apart
#   drive.sh watch <label> <secs> <every>   cap every <every> s until the screen stops saying Working (after 5 s) or <secs> pass
#   drive.sh model <filter>             /model, filter, Enter (e.g. haiku-4-5)
#   drive.sh open-project               "+ Add this folder" for the throwaway repo
. "$(dirname "$0")/common.sh"
HERE=$(cd "$(dirname "$0")" && pwd)
cmd=${1:?usage: see header}; shift || true
plain() { tm capture-pane -t v -p; }
case $cmd in
  key)  log "key $*"; tm send-keys -t v "$@" ;;
  type) log "type $*"; tm send-keys -t v -l "$*" ;;
  say)  log "say $*"; tm send-keys -t v -l "$*"; sleep 0.2; tm send-keys -t v Enter ;;
  wait|waitgone)
    rx=$1; secs=${2:-$([ "$cmd" = wait ] && echo 60 || echo 120)}
    for _ in $(seq $((secs * 4))); do
      if plain | grep -Eq -- "$rx"; then [ "$cmd" = wait ] && exit 0; else [ "$cmd" = waitgone ] && exit 0; fi
      sleep 0.25
    done
    echo "timeout ($cmd $rx)" >&2; plain | tail -25 >&2; exit 1 ;;
  cap)
    n=$(printf '%02d' "$(ls "$EVID/captures"/*.ansi 2>/dev/null | wc -l | tr -d ' ')")
    f=$EVID/captures/$n-$1
    tm capture-pane -t v -p -e > "$f.ansi"; tm capture-pane -t v -p > "$f.txt"
    log "cap $f"; echo "$n-$1 $(date +%H:%M:%S)"; python3 -I "$HERE/pane.py" bar "$f.ansi" ;;
  watch)  t0=$SECONDS; while [ $((SECONDS - t0)) -lt "$2" ]; do "$0" cap "$1"; sleep "$3"
            [ $((SECONDS - t0)) -gt 5 ] && ! plain | grep -q "Working" && break; done ;;
  sample) for _ in $(seq "$2"); do "$0" cap "$1"; sleep "$3"; done ;;
  model)  "$0" say /model; "$0" wait "type to filter" 10; "$0" type "$1"; sleep 1; "$0" key Enter ;;
  open-project) "$0" key Enter; "$0" wait "Type a message and press Enter" 20 ;;
  *) echo "unknown: $cmd"; exit 2 ;;
esac
