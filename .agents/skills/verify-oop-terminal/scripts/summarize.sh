#!/usr/bin/env bash
# One line-pair per capture (bar row, fill, glow-lit cells) -> $EVID/bars.txt, plus the walker check
# on every capture. Read-only on captures. Usage: RUN=<id> summarize.sh
. "$(dirname "$0")/common.sh"
HERE=$(cd "$(dirname "$0")" && pwd)
: > "$EVID/bars.txt"
for f in "$EVID"/captures/*.ansi; do
  { echo "== $(basename "$f" .ansi)"; python3 -I "$HERE/pane.py" bar "$f"; python3 -I "$HERE/pane.py" walker "$f" | head -1; } >> "$EVID/bars.txt"
done
echo "$EVID/bars.txt ($(grep -c '^==' "$EVID/bars.txt") captures; walker rows: $(grep -c '^walker rows' "$EVID/bars.txt"))"
