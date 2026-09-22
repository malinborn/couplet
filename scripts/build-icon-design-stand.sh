#!/usr/bin/env bash
# Builds couplet-icon-design-stand.html from scripts/icon-stand.template.html,
# inlining every font as a data URI so the stand opens straight off disk.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
F="$ROOT/src/assets/fonts"; P="$ROOT/scripts/icon-fonts"
PF=$(base64 -i "$P/PlayfairDisplay-Italic-500-latin.woff") \
PF8=$(base64 -i "$P/PlayfairDisplay-Italic-800-latin.woff") \
MW=$(base64 -i "$F/Merriweather-BoldItalic.woff2") \
INI=$(base64 -i "$F/Inter-BoldItalic.woff2") \
perl -pe 's/__PF__/$ENV{PF}/g; s/__PF8__/$ENV{PF8}/g; s/__MW__/$ENV{MW}/g; s/__INI__/$ENV{INI}/g' \
  "$ROOT/scripts/icon-stand.template.html" > "$ROOT/couplet-icon-design-stand.html"
echo "$ROOT/couplet-icon-design-stand.html"
