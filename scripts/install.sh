#!/usr/bin/env bash
set -euo pipefail

APP_NAME="couplet"
APP_BUNDLE="/Applications/${APP_NAME}.app"
BIN_DIR="/usr/local/bin"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Building ${APP_NAME}..."
cd "$PROJECT_DIR"
npm run tauri build

# Find the built .app bundle
BUILD_APP=$(find "$PROJECT_DIR/src-tauri/target/release/bundle/macos" -name "*.app" -maxdepth 1 | head -1)

if [ -z "$BUILD_APP" ]; then
  echo "ERROR: Build artifact not found in src-tauri/target/release/bundle/macos/"
  exit 1
fi

echo "==> Installing to /Applications..."
if [ -d "$APP_BUNDLE" ]; then
  rm -rf "$APP_BUNDLE"
fi
cp -R "$BUILD_APP" "$APP_BUNDLE"

# Copies, never symlinks (see CLAUDE.md). `mdmini` is the former name: it
# execs the `couplet` copied beside it.
echo "==> Installing CLI: ${BIN_DIR}/couplet, ${BIN_DIR}/mdmini"
sudo cp "${PROJECT_DIR}/scripts/couplet" "$BIN_DIR/couplet"
sudo cp "${PROJECT_DIR}/scripts/mdmini" "$BIN_DIR/mdmini"
sudo chmod +x "$BIN_DIR/couplet" "$BIN_DIR/mdmini"

echo "==> Done! Run: couplet [file.md]"
