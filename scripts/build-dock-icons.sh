#!/bin/bash
# Downscale the theme icon variants into the copies the binary embeds.
#
# `design/couplet-icon/variants/*.png` are 1024×1024 masters. The Dock never
# draws an app icon larger than 512×512 (256pt @2x), so embedding the masters
# would only double the binary for pixels nobody sees. `src-tauri/src/dock_icon.rs`
# pulls these copies in with `include_bytes!`.
#
# Usage:
#   scripts/build-dock-icons.sh
#
# `default.png` is skipped on purpose: the default is the bundle icon itself,
# restored by handing AppKit `nil` rather than a copy of the same picture.
#
# Run it after adding or re-rendering a variant, then commit `src-tauri/dock-icons/`.
# A new variant also needs a row in `dock_icon.rs`'s `VARIANTS` table — its test
# fails on a copy that is on disk but not wired, and on a row with no copy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/design/couplet-icon/variants"
DST="$ROOT/src-tauri/dock-icons"

mkdir -p "$DST"
rm -f "$DST"/*.png
for master in "$SRC"/*.png; do
  [ "$(basename "$master")" = default.png ] && continue
  sips -z 512 512 "$master" --out "$DST/$(basename "$master")" >/dev/null
done
ls -1 "$DST"
