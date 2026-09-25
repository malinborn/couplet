---
name: md-mini-install
description: Build and install couplet (formerly md-mini) to /Applications with the couplet and mdmini CLI commands. Use when user wants to build, install, update, or deploy couplet/md-mini on their Mac from source.
user_invocable: true
---

# couplet Build & Install (from source)

Build the couplet Tauri app and install it to `/Applications/couplet.app` with the `couplet`
CLI (and `mdmini`, the former name, which execs `couplet`). For a normal install use
Homebrew instead: `brew install --cask couplet`.

## Steps

1. Kill any running dev server on port 1420:
   ```bash
   lsof -ti:1420 | xargs kill -9 2>/dev/null || true
   ```

2. Run the install script from the project root:
   ```bash
   cd /Users/maximkovalevskij/playground/md-mini && bash scripts/install.sh
   ```

3. Verify the install:
   ```bash
   which couplet && couplet --version
   mdmini --version   # the alias reaches the same app
   ```

4. Report result to user: installed version, path, usage examples:
   - `couplet` — open empty editor
   - `couplet README.md` — open file
   - `couplet file1.md file2.md` — open multiple files

## Notes

- `sudo` is needed to copy the CLI into `/usr/local/bin` (the script will prompt).
- `/usr/local/bin/couplet` and `/usr/local/bin/mdmini` are **copies** of `scripts/couplet` and
  `scripts/mdmini`, never symlinks (see CLAUDE.md). Re-run the script after every update.
- Build takes 1-3 minutes (Rust compilation).
- If the app is currently running, close it first or it may not replace cleanly.
- The first launch of a renamed build migrates md-mini's data; if md-mini is still running it
  asks to quit it first.
- Known gap: the script looks for the bundle under `src-tauri/target/`, but `~/.cargo/config.toml`
  redirects cargo to `~/.cargo/shared-target`, and `coup` is not copied. Fix before relying on it.
