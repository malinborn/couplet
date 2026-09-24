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
App starts → setup() reads temp file → opens the files as tabs of "main"
```

- `open` launches the app through macOS Launch Services (proper window server access, non-blocking)
- `load_pending_open_files()` in Rust `setup()` reads the temp file and hands the first path to the "main" window as a tab (`assign_file_to_main`: registered in `OpenFiles`, payload in `PendingFiles` — same mechanism as CLI args); every further path becomes another tab of main (spec §4: one window, the files as tabs)
- Frontend calls `get_window_init` on mount and shows the tabs it returns (see the init contract in `CLAUDE.md` → Gotchas)

#### Path 2: App IS running (`-S "$SOCK"` is true)

```
Script calls → /path/to/binary file.md  (no &, no backgrounding)
Binary connects to socket → sends argv → single-instance callback fires → exits
Running app receives args → opens the files as tabs of one new window
```

- The binary connects to the single-instance Unix socket, sends its `argv`, and **exits immediately** (takes milliseconds, doesn't block the terminal)
- The running app's `single_instance::init` callback receives the file paths (relative ones resolved against the caller's `cwd`) and calls `window::open_files_window()`: one new window with every file that is not open yet as a tab. A file already open stays where it is; when every file is open already, the window holding the first comes forward on it. No files → a new empty window
- No backgrounding needed — the second instance exits on its own

#### Neither path: routed opens

`-t`/`-b`/`-f`, and any open by an agent (`CLAUDECODE` set, non-empty), skip both paths above: the script sends them through the command socket (`mdmini ai open`, see "AI interface passthrough" below), which routes each file to a window (spec §5: `-t N` → window #N; a file already open → its tab; a window of the file's project → a new tab there; else a new window) and prints the window it landed in as one line of JSON. An agent's open lands in the background unless `-f`; a human's `-t N` in focus unless `-b`.

#### Finder

A file opened from Finder (double-click, Open With, a drop on the Dock icon) arrives as `RunEvent::Opened` and is routed by project, like a routed open without `-t` (tabs-questions Q4): a file already open → its tab comes forward; a window of the file's project → a new tab there, in the one focused last; a `main` still as it started (no project, no file tab) takes it; else a new window. The routing runs off the main thread (it reads the disk to find the project), the open itself on it. It is a human's open, so the window it lands in comes forward.

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

**Re-run `scripts/install.sh` after updating.** Because it is a copy, it does not follow the app: a copy from before tabs knows nothing of `ls` and `close` and treats them as file names — `mdmini ls` opens a document called `ls`. Homebrew users are unaffected: the cask links the script bundled with the app.

### Usage

```bash
mdmini                    # Open empty editor
mdmini README.md          # Open file (launches app if not running)
mdmini file1.md file2.md  # One new window, the files as tabs
mdmini notes.md -t 7      # A tab in window #7, focused (-b: in the background)
mdmini ls                 # Open windows: #N, project, tabs (--json for JSON)
mdmini close notes.md     # Close the tab holding notes.md, the ⌘W way
```

### AI interface passthrough

`mdmini show|edit|ask <file> ...` and routed opens don't go through either socket above — they talk to a separate **command socket** (`/tmp/md_mini_cmd.sock`) that the running app also serves, launching it first if it isn't up yet: with `open`, or with `open -g` for a command that lands in the background (`edit`, `show -b`, an agent's open without `-f`), so a cold start does not bring md-mini to the front. `ask` uses plain `open`: its question must not wait unseen behind the terminal. A command socket file that nobody answers (a crashed app) is removed first, so the launch rebinds it. `mdmini ls` and `mdmini close` use the same socket but never launch the app — they answer `md-mini is not running`. See `docs/ai-interface.md` for the full protocol.
