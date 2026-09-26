#!/usr/bin/env bash
# Stage-01 live check (docs/superpowers/plans/2026-09-27-stash-01-safety-net.md):
# a draft of the previous session must survive launches in which nobody
# restores that session — the 2026-09-26 loss (brew upgrade 2.0.0 -> 2.0.1,
# then a language restart before the restore).
#
# Takes a bundle built under the private identity pro.couplet.safety (plan,
# Task 1) and refuses anything else: it resets that identity's data dir.
# Quits only by bundle id through AppleScript — never System Events.
set -uo pipefail

APP="${1:?usage: scripts/verify-draft-safety.sh /path/to/couplet-safety.app}"
ID="pro.couplet.safety"
DATA="$HOME/Library/Application Support/couplet-safety"
SOCK="/tmp/pro_couplet_safety_si.sock"
LOG="${TMPDIR:-/tmp}/couplet-safety.log"
TAB="1790000000000-1-0"
DRAFT="draft-$TAB.md"
TEXT="- [ ] PLAN: survive every launch"

bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null)
if [ "$bundle_id" != "$ID" ]; then
  echo "refusing: $APP is '$bundle_id', not $ID"
  exit 2
fi
BIN="$APP/Contents/MacOS/couplet"

running() { pgrep -f "$BIN" >/dev/null 2>&1; }

if running; then
  echo "refusing: $BIN is already running"
  exit 2
fi
# A stale socket makes the next launch exit silently (CLAUDE.md, single-instance).
rm -f "$SOCK"

rm -rf "$DATA"
mkdir -p "$DATA/session"
printf '%s' "$TEXT" > "$DATA/session/$DRAFT"
cat > "$DATA/session-v2.json" <<JSON
{"version":2,"savedAt":1790000000,"windows":[{"number":1,"project":null,"x":120,"y":120,"width":900,"height":700,"tabs":[{"tabId":"$TAB","path":null,"untitled":"$DRAFT","cursor":0,"topLine":1}],"activeTab":"$TAB"}]}
JSON
# An older marker: the welcome window opens, as it did after the upgrade.
printf '0.0.1:en' > "$DATA/onboarding-version"

launch() {
  open -n -a "$APP" --stdout "$LOG" --stderr "$LOG"
  for _ in $(seq 1 40); do running && break; sleep 0.5; done
  if ! running; then
    echo "FAIL: $APP did not start (log: $LOG)"
    exit 1
  fi
  # Mount, the first heartbeat and the first ticker tick (write + GC).
  sleep 8
}

quit() {
  osascript -e "quit app id \"$ID\"" >/dev/null
  for _ in $(seq 1 40); do running || break; sleep 0.5; done
  if running; then
    echo "FAIL: $ID did not quit"
    exit 1
  fi
}

status=0
check() {
  if [ "$(cat "$DATA/session/$DRAFT" 2>/dev/null)" = "$TEXT" ]; then
    echo "PASS [$1] draft still in session/"
  else
    echo "FAIL [$1] draft gone from session/"
    status=1
  fi
  if grep -q "\"$DRAFT\"" "$DATA/session-v2.json" 2>/dev/null; then
    echo "PASS [$1] session-v2.json still names it"
  else
    echo "FAIL [$1] session-v2.json no longer names it"
    status=1
  fi
  ls -la "$DATA/session/.trash" 2>/dev/null | sed 's/^/       trash: /'
}

for run in 1 2 3; do
  launch
  check "launch $run, nobody restored"
  quit
  check "after quit $run"
done
exit $status
