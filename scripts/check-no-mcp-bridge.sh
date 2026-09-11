#!/bin/bash
# Release gate: prove the dev-only MCP bridge is ABSENT from a shipping binary.
#
# Why this exists even though Cargo.toml makes the crate optional and lib.rs
# carries a `compile_error!` guard: those two are assertions ABOUT a build. This
# script reads the ARTEFACT. "Checked the build flags instead of the binary" is a
# real way to ship something other than what you think you shipped.
#
# Usage:
#   scripts/check-no-mcp-bridge.sh [path-to-binary]
#
# With no argument it checks, in order of preference, whichever exists:
#   src-tauri/target/release/bundle/macos/md-mini.app/Contents/MacOS/md-mini
#   src-tauri/target/release/md-mini
#
# Wire this into the release pipeline as a BLOCKING gate, not as a one-off command.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ $# -ge 1 ]; then
    CANDIDATES=("$1")
else
    # This repo points cargo at a SHARED target directory, so the binary is not
    # under src-tauri/target. Ask cargo where it actually is instead of guessing —
    # checking a stale artefact from some other build is exactly the failure this
    # script exists to prevent.
    TARGET_DIR=$(cargo metadata --no-deps --format-version 1 --offline \
        --manifest-path "$ROOT/src-tauri/Cargo.toml" 2>/dev/null \
        | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')
    CANDIDATES=(
        "$ROOT/src-tauri/target/release/bundle/macos/md-mini.app/Contents/MacOS/md-mini"
        "$ROOT/src-tauri/target/release/md-mini"
    )
    if [ -n "${TARGET_DIR:-}" ]; then
        CANDIDATES+=(
            "$TARGET_DIR/release/bundle/macos/md-mini.app/Contents/MacOS/md-mini"
            "$TARGET_DIR/release/md-mini"
        )
    fi
fi

BIN=""
for c in "${CANDIDATES[@]}"; do
    if [ -f "$c" ]; then BIN="$c"; break; fi
done

if [ -z "$BIN" ]; then
    echo "FAIL: binary not found. Looked at:"
    printf '  %s\n' "${CANDIDATES[@]}"
    exit 1
fi

echo "Checking: $BIN"

# A universal binary carries one slice per architecture. `strings`/`nm` read the
# whole file, so both slices are covered by the scan below — but print the arch
# list, because "checked the artefact" should say WHICH artefact.
if command -v lipo >/dev/null 2>&1; then
    echo "Arches:   $(lipo -archs "$BIN" 2>/dev/null || echo 'n/a')"
fi
echo "Built:    $(date -r "$BIN" '+%Y-%m-%d %H:%M:%S')"

# Refuse to bless a STALE artefact. A shared target directory (this repo uses one)
# can hold a bundle from a completely different checkout, and "verified the binary"
# is worthless if it was some other build. If any Rust source or manifest is newer
# than the binary, the binary did not come from the tree being checked.
NEWER=$(find "$ROOT/src-tauri/src" "$ROOT/src-tauri/Cargo.toml" \
    -newer "$BIN" -print -quit 2>/dev/null)
if [ -n "$NEWER" ]; then
    echo "FAIL: stale artefact — $NEWER is newer than the binary."
    echo "      Rebuild before checking, or pass the intended binary explicitly."
    exit 1
fi

# Pass 1 — strong indicators. These exist in the artefact only if the crate was
# actually linked: its own name, and the ACL command ids the plugin registers.
# Never filtered, never softened.
if strings -a "$BIN" | grep -Eiq 'tauri[-_]plugin[-_]mcp[-_]bridge|plugin:mcp-bridge\|'; then
    echo "FAIL: MCP bridge traces in release binary — DO NOT SHIP"
    echo "Matches:"
    strings -a "$BIN" | grep -Eio 'tauri[-_]plugin[-_]mcp[-_]bridge|plugin:mcp-bridge\|[a-z_]*' | sort -u | head
    exit 1
fi

if nm -a "$BIN" 2>/dev/null | grep -Eiq 'mcp_bridge'; then
    echo "FAIL: mcp_bridge symbols in release binary — DO NOT SHIP"
    exit 1
fi

# Pass 2 — the broad `mcp-bridge` sweep, minus the one benign source of matches:
# the absolute build path, which Tauri compiles in via CARGO_MANIFEST_DIR. Build
# from a directory or git worktree whose NAME contains "mcp-bridge" (e.g. a branch
# called `mcp-bridge-hardening`) and the naive sweep fails on a perfectly clean
# binary. Filtering only lines containing this build's own path keeps the sweep
# honest: pass 1 above is what actually detects a linked plugin, and it is not
# filtered at all.
BROAD=$(strings -a "$BIN" | grep -Ei 'mcp[-_]bridge' | grep -v -F "$ROOT" || true)
if [ -n "$BROAD" ]; then
    echo "FAIL: unexplained 'mcp-bridge' strings in release binary — DO NOT SHIP"
    printf '%s\n' "$BROAD" | head
    exit 1
fi

echo "OK: no MCP bridge traces"
