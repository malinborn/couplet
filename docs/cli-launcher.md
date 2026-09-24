# CLI Launcher — macOS Console Integration

## How `mdmini` command works

The `mdmini` CLI wrapper (`scripts/mdmini` → `/usr/local/bin/mdmini`) launches md-mini from the terminal without blocking it.

### The Problem

macOS GUI apps (Tauri/WebKit) have strict requirements:
- **Cannot be backgrounded with `&`** — process loses window server access, exits immediately
- **`open -a app file.md`** doesn't pass files to Tauri apps (Apple Events not handled by Tauri CLI plugin)
- **`open -n`** (force new instance) causes infinite restart loop with single-instance plugin
- **Direct binary execution** works but blocks the terminal

### The Solution: Two-Path Approach

The socket file `/tmp/com_md_mini_app_si.sock` (created by `tauri-plugin-single-instance`) indicates whether the app is running.

#### Path 1: App NOT running (`-S "$SOCK"` is false)

```
Script writes file paths → /tmp/md-mini-pending-files
Script calls → open /Applications/md-mini.app
App starts → setup() reads temp file → opens files in "main" window
```

- `open` launches the app through macOS Launch Services (proper window server access, non-blocking)
- `load_pending_open_files()` in Rust `setup()` reads the temp file and hands the first path to the "main" window as a tab (`assign_file_to_main`: registered in `OpenFiles`, payload in `PendingFiles` — same mechanism as CLI args); every further path opens its own window
- Frontend calls `get_window_init` on mount and shows the tabs it returns (see the init contract in `CLAUDE.md` → Gotchas)

#### Path 2: App IS running (`-S "$SOCK"` is true)

```
Script calls → /path/to/binary file.md  (no &, no backgrounding)
Binary connects to socket → sends argv → single-instance callback fires → exits
Running app receives args → opens file in new window
```

- The binary connects to the single-instance Unix socket, sends its `argv`, and **exits immediately** (takes milliseconds, doesn't block the terminal)
- The running app's `single_instance::init` callback receives the file paths and calls `open_file_window()`
- No backgrounding needed — the second instance exits on its own

### Why Other Approaches Failed

| Approach | Problem |
|----------|---------|
| `binary &` | macOS kills backgrounded GUI apps (no window server access) |
| `binary & disown` | Same — process exits with code 0 immediately |
| `nohup binary &` | Same — WebKit requires foreground process |
| `open -a app file.md` | Tauri doesn't handle Apple Events for file opening |
| `open -a app --args file.md` | Args ignored when app is already running |
| `open -n -a app --args` | Infinite loop — single-instance plugin exits second instance, macOS relaunches |

### Stale Socket Issue

If the app is killed with `kill -9` (or crashes), the socket file remains but no process listens on it. The next launch detects the socket, tries to connect, fails silently, and exits.

**Fix:** The script checks both socket existence AND process existence:
```bash
if [ -S "$SOCK" ]; then
  # Socket exists — app should be running, use single-instance IPC
```

If the socket becomes stale (app was force-killed), manually remove it:
```bash
rm -f /tmp/com_md_mini_app_si.sock
```

### Installation

```bash
# Build
npm run tauri build

# Install app
cp -a src-tauri/target/release/bundle/macos/md-mini.app /Applications/

# Install CLI wrapper (must be a COPY, not a symlink)
sudo cp scripts/mdmini /usr/local/bin/mdmini
sudo chmod +x /usr/local/bin/mdmini
```

**Important:** `/usr/local/bin/mdmini` must be a **copy** of the script, not a symlink to the binary. If it's a symlink (`ln -sf .../md-mini`), it runs the binary directly and blocks the terminal.

### Usage

```bash
mdmini                    # Open empty editor
mdmini README.md          # Open file (launches app if not running)
mdmini file1.md file2.md  # Open multiple files in separate windows
```

### AI interface passthrough

`mdmini show <file> ...` and `mdmini edit <file> ...` don't go through either socket above — they talk to a separate **command socket** (`/tmp/md_mini_cmd.sock`) that the running app also serves, launching it first (via the same `open` path) if it isn't up yet. See `docs/ai-interface.md` for the full protocol.
