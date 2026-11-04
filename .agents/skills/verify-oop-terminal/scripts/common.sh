# Sourced by the other scripts. Needs RUN (the id `launch.sh` printed) in the environment.
set -euo pipefail
: "${RUN:?set RUN=<id printed by launch.sh>}"
EVID_ROOT=${OOP_VERIFY_EVIDENCE_ROOT:-/tmp/oop-verify-evidence}
EVID=$EVID_ROOT/$RUN
[ -f "$EVID/run.env" ] || { echo "no $EVID/run.env: run launch.sh first" >&2; exit 2; }
# shellcheck disable=SC1090
. "$EVID/run.env"
TM=${TMUX_BIN:-/opt/homebrew/bin/tmux}
tm() { "$TM" -L "$SOCK" "$@"; }
log() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*" >> "$EVID/commands.log"; }
