# Stash 01 — Draft Safety Net Implementation Plan

> **⚠️ Roadmap amendments override this plan.** Read the section «Amendments after planning» in `2026-09-27-stash-00-roadmap.md` first. Most visible here: **A1 — the notes folder is `~/couplet/` (dev `~/couplet-dev/`), not `~/Documents/…`**: use `dirs::home_dir()` instead of `dirs::document_dir()`, rename every `Documents` base in tests to a home base, and drop every TCC-prompt note or step (the home root is not TCC-protected). Also A2 (offline build, `functions` feature), A3 (`repo` = directory name) and A5 (schema v2).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No untitled draft is ever deleted again: the session GC moves unreferenced drafts to `session/.trash/` (purged after 30 days), ⌘W on an untitled tab with text leaves a rescue copy there, and the root cause of the 2026-09-26 loss (drafts of an un-restored session dropped from `session-v2.json`, then deleted by the next launch) is fixed.

**Architecture:** All of it lives in the Rust session layer. `session.rs` gains a draft trash (`drafts_trash_dir`, move-by-`rename`, a name-stamped purge, a rescue writer) and `SessionState::snapshot` starts writing the un-restored windows that hold drafts. `tab_close` takes the discarded untitled text from the frontend; the tab controller (`controller.ts`) is the one place that sees that text at the moment of the discard and hands it over.

**Tech Stack:** Tauri 2 (Rust), Svelte 5 + TypeScript (one controller change), vitest, cargo test, a bash check script run against a debug bundle.

**Spec:** `docs/superpowers/specs/2026-09-26-stash-design.md` («Ни одного удаления без корзины», «Фаза 0»). Roadmap row 01 and shared contracts: `docs/superpowers/plans/2026-09-27-stash-00-roadmap.md` (the path `session::drafts_trash_dir()` comes from there). Spec wins on behaviour.

**Ships alone:** yes — this branch can be released as 2.0.2 by the owner. **This plan does not release:** no version bump, no tag, no `tauri build`, no Homebrew.

---

## Conventions for every task

- **Worktree:** `/Users/maximkovalevskij/playground/md-mini/.claude/worktrees/stash-impl` (created by the implementer prompt, `2026-09-27-stash-implementer-prompt.md`), branch `fix/draft-safety`. Run every command from there. Never `git stash`, `checkout` of another branch, `reset` or `restore`; `git add` explicit paths only and commit with the same pathspec.
- **Rust:** every cargo command is prefixed with `CARGO_TARGET_DIR=~/.cargo/stash-impl-target`. Tests: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml <filter>`.
- **Clippy:** the baseline is measured in Task 0. After every Rust task run `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo clippy --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "generated [0-9]+ warning"` and expect the baseline number. Never add `#[allow(dead_code)]`: every item below is introduced by the task that first calls it.
- **Frontend:** `npx vitest run <file>` for the file under test, `npx vitest run --dir src` for the full suite (plain `npm run test` overcounts stale worktree copies), `npm run check` for types.
- **Never** `npm run tauri dev`, `npm run tauri build`, `npm run build:universal`, or anything touching `/Applications`, `~/Library/Application Support/couplet/` or `~/Documents/couplet/`. Live checks in this plan use a **private identity** `couplet-safety` / `pro.couplet.safety` (Task 1 explains why not `pro.couplet.dev`). AppleScript quits **by bundle id only**: `osascript -e 'quit app id "pro.couplet.safety"'`. Never System Events, never the release id `pro.couplet.app`, never OS-level keystrokes.
- **Hands off the evidence:** `~/couplet-rescue-2026-09-26/` is the owner's backup of the incident. Read it (`ls -laT`), never write to it.
- **Commits:** conventional commits, one per task, trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Svelte runes outside components require `*.svelte.ts`. No `any`. Comments state constraints the code can't show, nothing else.
- Line numbers below are as of commit `c395132` (couplet 2.0.1; the stash docs commits on top change no code). Earlier tasks in this plan shift them — when a step says "replace function `X`", find it by name.

---

## Root cause of the 2026-09-26 loss

### What was observed

After `brew upgrade --cask couplet` (2.0.0 → 2.0.1) the owner's untitled plans document was gone: `~/Library/Application Support/couplet/session/` was empty, and `session-v2.json` named only a blank untitled tab and the `welcome-2.0.1-en.md` window. The owner copied the data dir to `~/couplet-rescue-2026-09-26/couplet-appdata/` at 02:20 with times preserved.

### Evidence (all times local, 2026-09-26)

| Time | Source | Fact |
|---|---|---|
| until 02:16:49.463 | unified log (`runningboardd`) | couplet **2.0.0**, pid 39437, running since at least 2026-09-25 16:15, exits with `termination reported by launchd (0, 0, 0)` — a clean quit (the cask's `uninstall quit:` AppleEvent) |
| 02:16:50.509 | unified log | couplet **2.0.1** (new bundle version id `…32461252`), pid 37008, launched through LaunchServices |
| 02:17:07.959 | unified log | pid 37008 exits cleanly, **18 s after launch** |
| 02:17:08 | `welcome-2.0.1-ru.md` mtime | a couplet process writes the Russian welcome — but runningboard records **no LaunchServices launch** between 02:17:07 and 02:18:49 |
| **02:17:09** | `session/` directory mtime | **the last change to `session/`: an entry removed.** The directory ends empty and is never touched again |
| 02:17:31 | `teach-your-ai.md` mtime | the same process serves the AI menu |
| 02:18:49 → 02:20:08.316 | unified log | pid 37507 (2.0.1) launched through LaunchServices, exits cleanly |
| 02:20:08 | `preferences.json`, `onboarding-version` = `2.0.1:en`, `welcome-2.0.1-en.md` mtimes; tab ids `1790378408…-37994-…` in `session-v2.json` | a language switch to English and a process pid 37994 that — again — has no LaunchServices launch record |
| 02:20:10 | `session-v2.json` (`savedAt` 1790378410) | names only a blank untitled (`untitled: null`) and the welcome window |

The 02:20:08 row is the key to the 02:17:08 row. A language pick calls `apply_language_change` (`src-tauri/src/lib.rs:546`), which writes `preferences.json`, calls `save_session_on_exit` and then `app.restart()` — a plain child process, not a LaunchServices launch, so runningboard never records it. 02:17:07.96 → 02:17:08 is the same pattern: in 37008 (English, like the rename letter `couplet-renamed-en.md` of 2026-09-25) the owner switched to Russian; the restarted child found the onboarding marker `2.0.1:en`, so `should_show` (`onboarding.rs:111`) opened the Russian welcome at 02:17:08, and its first ticker tick at 02:17:09 emptied `session/`.

Reproduce the evidence (read-only; the unified log may have rotated by the time you read this):

```sh
ls -laT ~/couplet-rescue-2026-09-26/couplet-appdata ~/couplet-rescue-2026-09-26/couplet-appdata/session
/usr/bin/log show --start "2026-09-26 02:16:00" --end "2026-09-26 02:21:00" \
  --predicate 'process == "runningboardd" AND eventMessage CONTAINS "pro.couplet.app"' --style compact \
  | grep -v "^\s" | grep -E "termination reported|Launch request|Now tracking process: \[app"
```

### The causal chain in the code

1. **Restoring the previous session is opt-in.** At launch `setup` reads the session into `pending` (`lib.rs:253-263`, `SessionState::set_pending`, `session.rs:542`). Nothing restores it automatically: the main window offers a toast (`App.svelte:2371-2379`, `ToastStack.svelte:59` → `restore_session`) and File has «Reopen Windows from Last Session» (`lib.rs:292-296`). 2.0.1's launch also opened the version-bump welcome window in front (`onboarding::maybe_show`, `lib.rs:428`) — the toast lives only in `main`, behind it.
2. **Un-restored drafts are protected only in memory.** `referenced_untitled` (`session.rs:578`) unions `entries`, `pending` and `restoring`, so this run's GC keeps them.
3. **But the session file stops naming them at once.** `SessionState::snapshot` (`session.rs:531-540`) serializes **only `entries`** — the live windows. The ticker writes it on the first dirty tick (`lib.rs:412-414`), `save_session_on_exit` writes it on quit (`lib.rs:581-589`), and `apply_language_change` writes it before the restart (`lib.rs:548`). The existing test `referenced_untitled_covers_the_pending_restore` (`session.rs:1253-1261`) even asserts `snapshot(0).windows.is_empty()` while a draft sits in `pending`.
4. **The next process deletes them.** It reads that file (`read_session`, `session.rs:681`), so its `pending` no longer names the drafts, and its first dirty tick calls `prune_untitled_files` (`lib.rs:417`) → `prune_untitled_files_in` (`session.rs:738-750`) → `fs::remove_file` on every unreferenced `draft-*.md` / `untitled-*.md`. There is no second copy anywhere.

So the loss needs two processes in a row with no restore in between. On 2026-09-26 those were 37008 (2.0.1's first launch: nobody restored in 18 s, the welcome window was in front) and its language-restart child (deleted the drafts at 02:17:09). The same happens today after any launch where the human does not click «restore», followed by any quit and relaunch — a crash, ⌘Q, an update, or a language switch.

### Ranked hypotheses

| # | Hypothesis | Status | How this plan tests it |
|---|---|---|---|
| H1 | An un-restored `pending` session is not written back (`snapshot` = live windows only), so the next process prunes its drafts | **Confirmed** — timeline above + code | Task 4's failing tests (`upgrade_then_language_restart_before_a_restore_keeps_the_draft` and three more); Task 1 reproduces it on a real bundle, Task 8 shows it fixed |
| H2 | 2.0.0's AppleEvent quit wrote a `session-v2.json` that no longer named a draft its live tab still had | Not needed to explain the loss; not excluded (2.0.0's last file was overwritten). 2.0.0 exited cleanly, and `CLAUDE.md` records that an AppleEvent quit fires `RunEvent::Exit` only, with no `Destroyed` storm | Task 8 steps 3–6 (live text, AppleEvent quit, check the file). Fix only if it fails: Task 8b |
| H3 | A heartbeat reporting an untitled tab's text as empty dropped its sidecar name mid-run (`tab_snapshots`' `!text.is_empty()` guard, `session.rs:814`; pinned by `a_heartbeat_with_an_empty_untitled_buffer_drops_the_sidecar_name`, `session.rs:1602`) | Refuted as the cause here: it would have deleted the draft during 2.0.0's run, not at 02:17:09. Stays a latent path | Made harmless by Task 2 (the GC moves, not deletes). Task 8b hardens it if H2 shows it happening on quit |
| H4 | `migration.rs` re-ran on 2.0.1 and replaced the data dir | Refuted: `session.json` (v1) still has its 2026-09-25 13:56:48 mtime; the migration marker makes a second run `AlreadyDone` | — |
| H5 | `choose_session` preferred the stale v1 `session.json` | Refuted by code: v2's `savedAt` (written 02:17:07 by the restart) is far newer than v1's 1790333808 (`choose_session`, `session.rs:636-643`) | — |
| H6 | Onboarding touches the session | Refuted: `onboarding.rs` writes only its document and marker. It is part of the trigger (a second window in front of the toast, a language-keyed welcome after the switch), not of the mechanism | — |

### The fix

- **Task 4 (root cause):** `snapshot` also writes every un-restored window (from `pending`, or from `restoring` while a restore is between `take_pending` and `seed`) that holds an untitled draft and none of whose tabs is live. The next launch then sees those drafts in its own `pending`. Windows of file tabs only are not carried: their files are on disk, and carrying them would grow the restore offer with every launch.
- **Task 2 (defence in depth):** whatever else ever makes a draft unreferenced — H3, a red-button close, a bug nobody has found yet — the GC now moves it to `session/.trash/` instead of deleting it.
- **Task 5–6:** ⌘W's deliberate discard keeps an up-to-date copy too (the sidecar can be a heartbeat behind).

**Not in this plan (owner's decision, listed in the night report):** restoring the session automatically after a restart the app itself initiated (language switch) — it would have hidden this bug from the owner entirely, but it changes tabs-questions Q1; and making the restore toast visible when the welcome window is in front.

---

## Design decisions this plan commits to

| # | Decision | Why |
|---|---|---|
| D1 | The draft trash is `<app_data_dir>/session/.trash/` (`session::drafts_trash_dir()`), for release and dev alike (the app data dir is already per product). | Roadmap contract. Inside `session/` → same volume → `fs::rename` is atomic and never leaves a moment with no copy. A dot-name is invisible to `is_untitled_sidecar`, so the GC never treats the folder as prey. |
| D2 | A trashed draft is named `<original stem>.trashed-<unix secs>.md` (`draft-1-2-3.trashed-1790378409.md`); a same-second clash gets `-1`, `-2`, … before `.md`. | `rename` keeps the old mtime, so the name is the only honest record of *when* it was thrown away; the purge reads it back from there. The original stem stays readable for a human (and for stage 03's migration). |
| D3 | The purge removes only files whose name it can parse (`.trashed-<digits>`), older than **30 days** by that stamp (strictly more than `30 × 86400` s). Unknown names, directories and temp files are never touched. It runs at the ticker's first tick and every 6 h after. | Spec «корзина на 30 дней». A long-running app (the 2.0.0 process ran 10+ hours) must still purge; a purge that guessed at foreign names could delete something that is not ours. |
| D4 | ⌘W on an untitled tab with non-blank text: the frontend passes that text as `tab_close`'s new `content` argument; Rust writes `closed-<tab_id>.trashed-<secs>.md` into the trash (tmp + rename) **after** removing the registry entry (no disk under the `OpenFiles` lock) and **before** `SessionState::remove_tab` (so it lands before the GC can take the sidecar). A failed rescue write is logged, never fails the close. | The controller is the one place holding the text at the moment of the discard (`controller.ts` `closeNow`); the sidecar can be up to 5 s stale. The close cannot be refused at that point — the frontend has already swapped the tab out — and the GC's trashed sidecar is still a second copy. |
| D5 | Whitespace-only text leaves no rescue copy; `tab_release` (a blank Untitled giving way, a handover) leaves none. | Not a document. A release is not a discard. |
| D6 | `snapshot` carries an un-restored window when it has at least one untitled tab with a sidecar name and none of its tab ids is live; it is appended after the live windows, normalized. | Root cause (Task 4). "Any tab id live" means the restore has seeded it: writing it twice would restore two tabs sharing one sidecar. |
| D7 | The verification bundle uses a private identity `couplet-safety` / `pro.couplet.safety`, built `--debug --features mcp-bridge`. | `pro.couplet.dev` shares its single-instance socket with any `npm run dev:app` running in this or another session: the bundle would hand its launch to that process and exit. A third identity has no row in `migration.rs` (a no-op there) and its own data dir. A debug build is the only one allowed to carry the bridge (`compile_error!` in `lib.rs:7-8`). |

## File Structure

| File | Responsibility |
|---|---|
| `scripts/verify-draft-safety.sh` (new) | Live check against a `pro.couplet.safety` bundle: seeds a previous session with a draft, runs three launch/quit cycles without a restore, reports PASS/FAIL. |
| `src-tauri/src/session.rs` (modify) | Draft trash (`drafts_trash_dir`, `move_to_trash`, `trashed_at`, `purge_drafts_trash`, `rescue_untitled`), GC moves instead of deleting, `snapshot` carries un-restored draft windows (`unrestored_draft_windows`). |
| `src-tauri/src/lib.rs` (modify) | Ticker purges the trash at launch and every 6 h. |
| `src-tauri/src/tab_commands.rs` (modify) | `tab_close` takes `content`, writes the rescue copy (`rescue_text`). |
| `src/lib/tabs/controller.ts` (modify) | `rust.close` gets the discarded untitled text. |
| `src/lib/tabs/controller.test.ts` (modify) | Rescue-text tests; existing `rust.close` assertions get the third argument. |
| `src/App.svelte` (modify) | Passes `content` to `tab_close`. |
| `CLAUDE.md` (modify) | Data-safety rule; untitled GC gotcha rewritten. |

---

### Task 0: Branch and baselines

**Files:** none.

- [ ] **Step 1: Create the branch**

Run (from the `stash-impl` worktree, after the implementer prompt's `git fetch && git merge origin/worktree-shelf-design`):

```sh
git switch -c fix/draft-safety
git log --oneline -1
```

Expected: `Switched to a new branch 'fix/draft-safety'` and the merged head.

- [ ] **Step 2: Measure the baselines and write them down (night report, "Stage 01 baselines")**

```sh
CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^test result"
CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml --lib session:: 2>&1 | grep -E "^test result"
CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo clippy --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "generated [0-9]+ warning"
npx vitest run --dir src 2>&1 | tail -4
npx vitest run src/lib/tabs/controller.test.ts 2>&1 | tail -4
```

Expected: all green. The planner measured `--lib session::` at `c395132`: **62 passed; 0 failed**. Record every other number as printed; later tasks compare against them.

No commit.

---

### Task 1: A live check that reproduces the loss (before any fix)

The script seeds what 2.0.0 left behind — a session naming one draft — and then does what the owner did: launch with a version-bump welcome, restore nothing, quit (the language restart is the same `save_session_on_exit` + fresh process, `lib.rs:546-560` vs `lib.rs:521-526`), launch again. On the unchanged code it must FAIL; that FAIL is the reproduction.

**Files:**
- Create: `scripts/verify-draft-safety.sh`

- [ ] **Step 1: Write the script**

Create `scripts/verify-draft-safety.sh`:

```bash
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
```

Then: `chmod +x scripts/verify-draft-safety.sh`.

- [ ] **Step 2: Build the verification bundle from the unchanged code**

```sh
CARGO_TARGET_DIR=~/.cargo/stash-impl-target npx tauri build --debug --bundles app --features mcp-bridge \
  --config src-tauri/tauri.dev.conf.json \
  --config '{"productName":"couplet-safety","identifier":"pro.couplet.safety"}'
ls -d ~/.cargo/stash-impl-target/debug/bundle/macos/couplet-safety.app
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' ~/.cargo/stash-impl-target/debug/bundle/macos/couplet-safety.app/Contents/Info.plist
```

Expected: the build finishes, the path exists, the identifier prints `pro.couplet.safety`. If the build refuses a second `--config`, put `{"productName":"couplet-safety","identifier":"pro.couplet.safety"}` merged into a copy of `tauri.dev.conf.json` under `$TMPDIR` and pass that one file instead — never edit the tracked configs.

- [ ] **Step 3: Reproduce**

```sh
bash scripts/verify-draft-safety.sh ~/.cargo/stash-impl-target/debug/bundle/macos/couplet-safety.app
```

(The script sleeps internally; if the harness blocks it in the foreground, run it with `run_in_background` and read its output file.)

Expected on the unchanged code — **this is the reproduction**:

```
PASS [launch 1, nobody restored] draft still in session/
FAIL [launch 1, nobody restored] session-v2.json no longer names it
PASS [after quit 1] draft still in session/
FAIL [after quit 1] session-v2.json no longer names it
FAIL [launch 2, nobody restored] draft gone from session/
FAIL [launch 2, nobody restored] session-v2.json no longer names it
...
```

and exit code 1. Copy the output into the night report under "Stage 01 — reproduction". If `launch 2` still shows the draft, stop: the reproduction failed — record what happened and ask the architect before writing any fix.

- [ ] **Step 4: Commit**

```sh
git add scripts/verify-draft-safety.sh
git commit -m "test(session): live check for drafts of an un-restored session

Seeds a previous session with a draft, runs launch/quit cycles without a
restore against a pro.couplet.safety bundle. Fails on 2.0.1: the second
launch deletes the draft (the 2026-09-26 loss).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- scripts/verify-draft-safety.sh
```

---

### Task 2: The GC moves unreferenced drafts to `session/.trash/`

**Files:**
- Modify: `src-tauri/src/session.rs` (imports line 3; `prune_untitled_files` + `prune_untitled_files_in`, lines 728-750; tests module from line 999, test `the_prune_keeps_referenced_sidecars_of_both_prefixes` at 1335-1350)

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/session.rs`'s `mod tests`, add these helpers right after `fn session(...)` (≈ line 1039):

```rust
    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("couplet-{tag}-{}", new_tab_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Names of the regular files directly in `dir`, sorted; empty when `dir` is missing.
    fn files_in(dir: &std::path::Path) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
```

Replace the whole test `the_prune_keeps_referenced_sidecars_of_both_prefixes` with:

```rust
    #[test]
    fn the_prune_keeps_referenced_sidecars_of_both_prefixes() {
        let dir = scratch_dir("prune");
        for name in ["draft-a.md", "draft-b.md", "untitled-c.md", "untitled-d.md", "notes.md"] {
            std::fs::write(dir.join(name), "x").unwrap();
        }
        let referenced: HashSet<String> = ["draft-a.md", "untitled-c.md"].map(String::from).into();
        prune_untitled_files_in(&dir, &referenced, 1_000);
        assert_eq!(files_in(&dir), vec!["draft-a.md", "notes.md", "untitled-c.md"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_prune_moves_unreferenced_drafts_to_the_trash_and_deletes_nothing() {
        let dir = scratch_dir("prune-trash");
        std::fs::write(dir.join("draft-b.md"), "b text").unwrap();
        std::fs::write(dir.join("untitled-editor-1.md"), "legacy text").unwrap();
        prune_untitled_files_in(&dir, &HashSet::new(), 1_000);

        assert!(files_in(&dir).is_empty(), "no sidecar left in session/");
        let trash = dir.join(".trash");
        assert_eq!(
            files_in(&trash),
            vec!["draft-b.trashed-1000.md", "untitled-editor-1.trashed-1000.md"]
        );
        assert_eq!(std::fs::read_to_string(trash.join("draft-b.trashed-1000.md")).unwrap(), "b text");
        assert_eq!(
            std::fs::read_to_string(trash.join("untitled-editor-1.trashed-1000.md")).unwrap(),
            "legacy text"
        );

        // The trash folder itself is never prey for the next pass.
        prune_untitled_files_in(&dir, &HashSet::new(), 2_000);
        assert_eq!(files_in(&trash).len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_same_name_thrown_away_in_the_same_second_gets_its_own_trash_name() {
        let dir = scratch_dir("prune-clash");
        let trash = dir.join(".trash");
        std::fs::create_dir_all(&trash).unwrap();
        std::fs::write(trash.join("draft-b.trashed-1000.md"), "first").unwrap();
        std::fs::write(dir.join("draft-b.md"), "second").unwrap();

        prune_untitled_files_in(&dir, &HashSet::new(), 1_000);

        assert_eq!(files_in(&trash), vec!["draft-b.trashed-1000-1.md", "draft-b.trashed-1000.md"]);
        assert_eq!(std::fs::read_to_string(trash.join("draft-b.trashed-1000.md")).unwrap(), "first");
        assert_eq!(std::fs::read_to_string(trash.join("draft-b.trashed-1000-1.md")).unwrap(), "second");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trashed_at_reads_the_stamp_back_and_refuses_foreign_names() {
        assert_eq!(trashed_at("draft-b.trashed-1000.md"), Some(1000));
        assert_eq!(trashed_at("draft-b.trashed-1000-3.md"), Some(1000));
        assert_eq!(trashed_at("closed-1-2-3.trashed-77.md"), Some(77));
        for foreign in ["notes.md", "draft-b.md", "draft-b.trashed-.md", "draft-b.trashed-12x.md", ".closed-1-2-3.tmp"] {
            assert_eq!(trashed_at(foreign), None, "{foreign}");
        }
    }
```

- [ ] **Step 2: Run them to see them fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml --lib session::`
Expected: FAIL to compile — `this function takes 2 arguments but 3 arguments were supplied` (`prune_untitled_files_in`) and `cannot find function trashed_at`.

- [ ] **Step 3: Implement the trash and the moving GC**

In `src-tauri/src/session.rs` change line 3 from `use std::path::PathBuf;` to:

```rust
use std::path::{Path, PathBuf};
```

Replace the doc comment and body of `prune_untitled_files` and all of `prune_untitled_files_in` (lines 728-750, from `/// Delete untitled sidecars nothing refers to any more.` to the closing brace of `prune_untitled_files_in`) with:

```rust
/// Folder inside `session/` that receives every draft the session lets go of.
/// A dot-name: `is_untitled_sidecar` never matches it, so the GC never
/// treats the folder itself as something to move.
const DRAFTS_TRASH_DIR: &str = ".trash";

/// Marks when a file entered the trash, inside its name: `rename` keeps the
/// old mtime, so the name is the only record of when it was thrown away.
const TRASHED_MARK: &str = ".trashed-";

/// A free path in `trash` for `stem` thrown away at `now_secs`:
/// `<stem>.trashed-<secs>.md`, then `<stem>.trashed-<secs>-1.md`, …
fn trash_path_for(trash: &Path, stem: &str, now_secs: u64) -> Result<PathBuf, String> {
    for n in 0..1000u32 {
        let name = if n == 0 {
            format!("{stem}{TRASHED_MARK}{now_secs}.md")
        } else {
            format!("{stem}{TRASHED_MARK}{now_secs}-{n}.md")
        };
        let path = trash.join(name);
        if fs::symlink_metadata(&path).is_err() {
            return Ok(path);
        }
    }
    Err(format!("no free trash name for {stem}"))
}

/// When a trash file was thrown away, read back from its name. `None` for
/// any name this module did not make — the purge never touches those.
fn trashed_at(name: &str) -> Option<u64> {
    let rest = name.strip_suffix(".md")?;
    let at = rest.rfind(TRASHED_MARK)?;
    let secs = rest[at + TRASHED_MARK.len()..].split('-').next()?;
    if secs.is_empty() || !secs.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    secs.parse().ok()
}

/// Move one sidecar into `trash` by `rename`: same volume, so there is never
/// a moment without a copy. On any failure the file stays where it was.
fn move_to_trash(src: &Path, trash: &Path, now_secs: u64) -> Result<PathBuf, String> {
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("not a UTF-8 file name: {}", src.display()))?;
    let stem = name.strip_suffix(".md").unwrap_or(name);
    fs::create_dir_all(trash).map_err(|e| format!("create {}: {e}", trash.display()))?;
    let dest = trash_path_for(trash, stem, now_secs)?;
    fs::rename(src, &dest).map_err(|e| format!("move {name} to the trash: {e}"))?;
    Ok(dest)
}

/// Move untitled sidecars nothing refers to any more into `session/.trash/`.
/// Never deletes: a draft leaves the session only with a copy kept.
///
/// Take the names from `SessionState::referenced_untitled`, never from the live
/// snapshot alone — see that method for why.
pub fn prune_untitled_files(referenced: &HashSet<String>) {
    let Ok(dir) = session_dir() else { return };
    prune_untitled_files_in(&dir, referenced, now_secs());
}

/// `prune_untitled_files` in `dir`: both sidecar prefixes (`is_untitled_sidecar`).
fn prune_untitled_files_in(dir: &Path, referenced: &HashSet<String>, now_secs: u64) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let trash = dir.join(DRAFTS_TRASH_DIR);
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !is_untitled_sidecar(name) || referenced.contains(name) {
            continue;
        }
        if let Err(e) = move_to_trash(&entry.path(), &trash, now_secs) {
            eprintln!("session: kept an unreferenced draft in place: {e}");
        }
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml --lib session::`
Expected: PASS — 62 + 3 new = **65 passed** (the replaced prune test keeps its name). Clippy: baseline count. (`session::drafts_trash_dir()`, the roadmap's name for the trash path, arrives in Task 3 with its first caller.)

- [ ] **Step 5: Commit**

```sh
git add src-tauri/src/session.rs
git commit -m "fix(session): the draft GC moves to session/.trash/ instead of deleting

A draft the session stops referencing is renamed to
session/.trash/<name>.trashed-<secs>.md. Nothing in session/ is removed any
more.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src-tauri/src/session.rs
```

---

### Task 3: Purge the trash after 30 days

**Files:**
- Modify: `src-tauri/src/session.rs` (after `prune_untitled_files_in`)
- Modify: `src-tauri/src/lib.rs:403-419` (the ticker)

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `session.rs`:

```rust
    #[test]
    fn the_purge_removes_only_trash_older_than_thirty_days() {
        let trash = scratch_dir("purge");
        let now = 100 * DRAFTS_TRASH_KEEP_SECS;
        let old = format!("draft-old.trashed-{}.md", now - DRAFTS_TRASH_KEEP_SECS - 1);
        let edge = format!("draft-edge.trashed-{}.md", now - DRAFTS_TRASH_KEEP_SECS);
        let fresh = format!("closed-1-2-3.trashed-{}.md", now - 10);
        for name in [old.as_str(), edge.as_str(), fresh.as_str(), "notes.md", ".closed-9.tmp"] {
            std::fs::write(trash.join(name), "x").unwrap();
        }
        std::fs::create_dir_all(trash.join("sub.trashed-1.md")).unwrap();

        purge_trash_in(&trash, now);

        let mut expected = vec![".closed-9.tmp".to_string(), fresh, edge, "notes.md".to_string()];
        expected.sort();
        assert_eq!(files_in(&trash), expected, "only the file past 30 days goes");
        assert!(trash.join("sub.trashed-1.md").is_dir(), "a directory is never removed");
        let _ = std::fs::remove_dir_all(&trash);
    }

    #[test]
    fn purging_a_trash_that_does_not_exist_is_a_noop() {
        let missing = std::env::temp_dir().join(format!("couplet-no-trash-{}", new_tab_id()));
        purge_trash_in(&missing, u64::MAX);
        assert!(!missing.exists());
    }
```

- [ ] **Step 2: Run them to see them fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml --lib session::the_purge`
Expected: FAIL to compile — `cannot find value DRAFTS_TRASH_KEEP_SECS`, `cannot find function purge_trash_in`.

- [ ] **Step 3: Implement the purge**

In `session.rs`, right after `prune_untitled_files_in`, add:

```rust
/// `<app data dir>/session/.trash/` — created on demand by whoever puts
/// something there.
pub fn drafts_trash_dir() -> Result<PathBuf, String> {
    Ok(session_dir()?.join(DRAFTS_TRASH_DIR))
}

/// How long a draft stays in `session/.trash/`, counted from the stamp in its name.
pub const DRAFTS_TRASH_KEEP_SECS: u64 = 30 * 24 * 60 * 60;

/// How often a running app purges the trash; it also purges on its first tick.
pub const DRAFTS_TRASH_PURGE_EVERY: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

/// Delete trash files thrown away more than `DRAFTS_TRASH_KEEP_SECS` ago —
/// the end of the retention the trash promised, the only deletion of user
/// text there is.
pub fn purge_drafts_trash(now_secs: u64) {
    let Ok(trash) = drafts_trash_dir() else { return };
    purge_trash_in(&trash, now_secs);
}

/// `purge_drafts_trash` in `trash`. Only regular files whose name carries a
/// stamp this module wrote; anything else is left alone.
fn purge_trash_in(trash: &Path, now_secs: u64) {
    let Ok(entries) = fs::read_dir(trash) else { return };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let name = entry.file_name();
        let Some(at) = name.to_str().and_then(trashed_at) else { continue };
        if now_secs.saturating_sub(at) > DRAFTS_TRASH_KEEP_SECS {
            let _ = fs::remove_file(entry.path());
        }
    }
}
```

- [ ] **Step 4: Wire it into the ticker**

In `src-tauri/src/lib.rs` replace the ticker (lines 403-419, from `// Crash-safety net.` through the `});` that closes `std::thread::spawn`) with:

```rust
            // Crash-safety net. The authoritative save happens on the way out
            // (see `save_session_on_exit`); this only catches a hard kill.
            let ticker_handle = app.handle().clone();
            std::thread::spawn(move || {
                // `None`: purge on the first tick — an app that ran for weeks
                // empties the trash when it is next launched.
                let mut last_purge: Option<std::time::Instant> = None;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(1000));
                    let state = ticker_handle.state::<SessionState>();
                    if state.is_quitting() {
                        return;
                    }
                    if state.take_dirty() {
                        let snapshot = state.snapshot(session::now_secs());
                        let _ = session::write_session(&snapshot);
                        // Must include the pending restore's buffers, not just the
                        // live ones — see `referenced_untitled`. What it leaves
                        // out goes to `session/.trash/`, never away.
                        session::prune_untitled_files(&state.referenced_untitled());
                    }
                    let purge_due = match last_purge {
                        None => true,
                        Some(at) => at.elapsed() >= session::DRAFTS_TRASH_PURGE_EVERY,
                    };
                    if purge_due {
                        session::purge_drafts_trash(session::now_secs());
                        last_purge = Some(std::time::Instant::now());
                    }
                }
            });
```

- [ ] **Step 5: Run the tests and clippy**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml --lib session::`
Expected: PASS — **67 passed**. Clippy: baseline count.

- [ ] **Step 6: Commit**

```sh
git add src-tauri/src/session.rs src-tauri/src/lib.rs
git commit -m "fix(session): purge session/.trash/ 30 days after a draft was thrown away

The age comes from the stamp in the file name (rename keeps the old mtime).
Unknown names and directories are never touched. The ticker purges at launch
and every 6 hours.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src-tauri/src/session.rs src-tauri/src/lib.rs
```

---

### Task 4: Root cause — the session file keeps the un-restored drafts

**Files:**
- Modify: `src-tauri/src/session.rs` (`SessionState::snapshot`, lines 531-540; the `referenced_untitled` doc comment, lines 571-577; a new free function after `label_order`, line 318; tests)

- [ ] **Step 1: Write the failing tests**

In `mod tests`, replace the whole test `referenced_untitled_covers_the_pending_restore` (lines 1252-1261) with:

```rust
    #[test]
    fn referenced_untitled_covers_the_pending_restore() {
        // Regression: the live session starts empty at launch while `pending`
        // still holds the previous run, so pruning on the live set alone deleted
        // the very buffer the user was about to reopen.
        let state = SessionState::new();
        state.set_pending(vec![window(vec![untitled_tab("m", "untitled-main.md")])]);
        assert!(state.snapshot_for("main").is_none(), "no live window holds it");
        assert!(state.referenced_untitled().contains("untitled-main.md"));
    }
```

and add:

```rust
    #[test]
    fn a_session_written_before_the_restore_still_names_its_drafts() {
        let state = SessionState::new();
        state.set_pending(vec![window(vec![untitled_tab("plans", "draft-plans.md")])]);
        state.set_tabs("main", vec![tab("blank", None)], Some("blank".to_string()));
        let written = state.snapshot(1);
        assert_eq!(written.windows.len(), 2, "main, then the window nobody restored");
        assert_eq!(written.windows[1].tabs[0].untitled.as_deref(), Some("draft-plans.md"));
    }

    #[test]
    fn upgrade_then_language_restart_before_a_restore_keeps_the_draft() {
        // 2026-09-26: `brew upgrade` 2.0.0 -> 2.0.1. 2.0.1's first run held
        // 2.0.0's session in `pending`; nobody restored it (the welcome window
        // was in front); 18 s later a language switch restarted the app, and
        // the restarted process's first tick deleted the draft.
        let dir = scratch_dir("incident");
        std::fs::write(dir.join("draft-plans.md"), "- [ ] plans").unwrap();

        let first = SessionState::new();
        first.set_pending(vec![window(vec![untitled_tab("plans", "draft-plans.md")])]);
        first.set_tabs("main", vec![tab("blank", None)], Some("blank".to_string()));
        first.set_tabs(
            "editor-1",
            vec![tab("welcome", Some("/tmp/welcome-2.0.1-en.md"))],
            Some("welcome".to_string()),
        );
        prune_untitled_files_in(&dir, &first.referenced_untitled(), 1);
        // What the first tick, the quit and the language restart all write.
        let on_disk = serde_json::to_string(&first.snapshot(1)).unwrap();

        let second = SessionState::new();
        second.set_pending(parse_session(&on_disk).expect("parses").windows);
        second.set_tabs("main", vec![tab("blank-2", None)], Some("blank-2".to_string()));
        prune_untitled_files_in(&dir, &second.referenced_untitled(), 2);

        assert_eq!(std::fs::read_to_string(dir.join("draft-plans.md")).unwrap(), "- [ ] plans");
        assert!(files_in(&dir.join(".trash")).is_empty(), "nothing was thrown away");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_window_the_restore_has_not_reached_yet_is_still_written() {
        let state = SessionState::new();
        state.set_pending(vec![window(vec![untitled_tab("u", "draft-u.md")])]);
        let _taken = state.take_pending();
        let written = state.snapshot(0);
        assert_eq!(written.windows.len(), 1, "a quit mid-restore keeps it");
        assert_eq!(written.windows[0].tabs[0].untitled.as_deref(), Some("draft-u.md"));
    }

    #[test]
    fn a_quit_writes_the_unrestored_draft_windows_too() {
        // `save_session_on_exit` skips an empty snapshot; a launch whose only
        // window of value is an un-restored draft must not look empty.
        let state = SessionState::new();
        state.set_pending(vec![window(vec![untitled_tab("u", "draft-u.md")])]);
        state.mark_quitting();
        assert_eq!(state.snapshot(0).windows.len(), 1);
    }

    #[test]
    fn a_restored_window_is_written_once_as_the_live_window() {
        let state = SessionState::new();
        state.set_pending(vec![window(vec![untitled_tab("u", "draft-u.md")])]);
        let taken = state.take_pending();
        state.seed("editor-1", taken[0].clone());
        assert_eq!(state.snapshot(0).windows.len(), 1, "seeded, not also carried");
        state.finish_restore();
        assert_eq!(state.snapshot(0).windows.len(), 1);
    }

    #[test]
    fn an_unrestored_window_of_files_only_is_not_carried() {
        let state = SessionState::new();
        state.set_pending(vec![window(vec![tab("a", Some("/tmp/a.md"))])]);
        assert!(state.snapshot(0).windows.is_empty(), "its files are on disk");
    }
```

- [ ] **Step 2: Run them to see them fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml --lib session::`
Expected: 4 FAIL —
- `a_session_written_before_the_restore_still_names_its_drafts`: `assertion left == right failed: main, then the window nobody restored` (`left: 1, right: 2`);
- `upgrade_then_language_restart_before_a_restore_keeps_the_draft`: `called Result::unwrap() on an Err value: Os { code: 2, kind: NotFound, … }` (the draft went to the trash);
- `a_window_the_restore_has_not_reached_yet_is_still_written`: `left: 0, right: 1`;
- `a_quit_writes_the_unrestored_draft_windows_too`: `left: 0, right: 1`.

`a_restored_window_is_written_once_as_the_live_window` and `an_unrestored_window_of_files_only_is_not_carried` already pass: they pin what the fix must not break.

- [ ] **Step 3: Implement**

In `session.rs`, right after `pub(crate) fn label_order` (ends at line 318, just above `/// The live session plus whatever was loaded from disk at startup.`), add:

```rust
/// The windows of the previous session nobody has restored yet — still in
/// `pending`, or taken by a restore that has not seeded them — that hold an
/// untitled draft. `snapshot` writes them after the live windows.
///
/// Restoring is opt-in, so a launch may never restore; without these, the
/// file it writes stops naming their drafts and the next launch's GC takes
/// them (the 2026-09-26 loss, stash-01 plan). A window of file tabs only is
/// not carried: its files are on disk, and carrying it would grow the restore
/// offer with every launch. A window with any live tab has been seeded by a
/// restore and is written as that live window, never twice.
fn unrestored_draft_windows<'a>(
    live: &[WindowSnapshot],
    waiting: impl Iterator<Item = &'a WindowSnapshot>,
) -> Vec<WindowSnapshot> {
    let live_ids: HashSet<&str> = live
        .iter()
        .flat_map(|w| w.tabs.iter())
        .map(|t| t.tab_id.as_str())
        .collect();
    waiting
        .filter(|w| w.tabs.iter().any(|t| t.path.is_none() && t.untitled.is_some()))
        .filter(|w| !w.tabs.iter().any(|t| live_ids.contains(t.tab_id.as_str())))
        .map(WindowSnapshot::normalized)
        .collect()
}
```

Replace `SessionState::snapshot` (lines 531-540) with:

```rust
    /// The session to write: the live windows (main first), then the
    /// un-restored ones that hold drafts (`unrestored_draft_windows`).
    pub fn snapshot(&self, saved_at: u64) -> Session {
        // entries → pending → restoring: the one lock order (`referenced_untitled`).
        let map = self.entries.lock().unwrap();
        let pending = self.pending.lock().unwrap();
        let restoring = self.restoring.lock().unwrap();
        let mut labelled: Vec<(&String, &WindowSnapshot)> = map.iter().collect();
        labelled.sort_by_key(|(label, _)| label_order(label));
        let mut windows: Vec<WindowSnapshot> =
            labelled.into_iter().map(|(_, w)| w.normalized()).collect();
        let carried = unrestored_draft_windows(&windows, pending.iter().chain(restoring.iter()));
        windows.extend(carried);
        Session {
            version: SESSION_VERSION,
            saved_at,
            windows,
        }
    }
```

In the doc comment of `referenced_untitled` (≈ lines 570-577), replace the sentence

```
    /// All of them matter. At startup the live session is deliberately empty — so
    /// that the first write of the new run supersedes the file — while `pending`
    /// still holds the previous run's windows. Collecting only the live half makes
    /// the ticker delete exactly the unsaved buffers the user is about to reopen.
```

with

```
    /// All of them matter. At startup the live session is empty while `pending`
    /// still holds the previous run's windows. Collecting only the live half makes
    /// the ticker trash exactly the unsaved buffers the user is about to reopen.
    /// This protects them for this run; `snapshot` carries them to the next one.
```

- [ ] **Step 4: Run the tests**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml --lib session::`
Expected: PASS — **73 passed**. Then the whole crate, since `snapshot` feeds `closed.rs`/`window.rs` tests indirectly:
`CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^test result"` — Task 0's baseline + 11 in the lib line, 0 failed. Clippy: baseline count.

- [ ] **Step 5: Commit**

```sh
git add src-tauri/src/session.rs
git commit -m "fix(session): keep un-restored drafts in session-v2.json

Restoring the previous session is opt-in, but snapshot() wrote only the live
windows. A launch nobody restored rewrote session-v2.json without the
previous run's drafts (first tick, quit, language restart), and the next
launch's GC deleted them. That is how brew upgrade 2.0.0 -> 2.0.1 followed
by a language switch lost the owner's plans on 2026-09-26.

snapshot() now also writes every un-restored window that holds a draft.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src-tauri/src/session.rs
```

---

### Task 5: ⌘W on an untitled tab leaves a rescue copy (Rust)

**Files:**
- Modify: `src-tauri/src/session.rs` (after `purge_trash_in`; tests)
- Modify: `src-tauri/src/tab_commands.rs:242-286` (`tab_close`), a new pure `rescue_text`, tests at line 638

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `session.rs`:

```rust
    #[test]
    fn a_rescue_copy_lands_in_the_trash_with_the_text() {
        let root = scratch_dir("rescue");
        let trash = root.join(".trash");
        let path = rescue_untitled_in(&trash, "1-2-3", "- [ ] plan", 500).unwrap();
        assert_eq!(path, trash.join("closed-1-2-3.trashed-500.md"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "- [ ] plan");
        assert_eq!(files_in(&trash), vec!["closed-1-2-3.trashed-500.md"], "no temp file left");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_rescue_refuses_a_tab_id_that_could_name_another_file() {
        let root = scratch_dir("rescue-bad-id");
        let trash = root.join(".trash");
        assert!(rescue_untitled_in(&trash, "../x", "text", 1).is_err());
        assert!(files_in(&trash).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
```

Add to `mod tests` in `tab_commands.rs` (after `use crate::ai_socket::{AiPending, AiResponse};`):

```rust
    #[test]
    fn only_an_untitled_tab_with_text_leaves_a_rescue_copy() {
        assert_eq!(rescue_text(None, Some("- [ ] plan")), Some("- [ ] plan"));
        assert_eq!(rescue_text(None, Some("  \n\t")), None, "blank is not a document");
        assert_eq!(rescue_text(None, None), None);
        assert_eq!(rescue_text(Some("/a.md"), Some("text")), None, "a file keeps its own copy on disk");
    }
```

- [ ] **Step 2: Run them to see them fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml --lib rescue`
Expected: FAIL to compile — `cannot find function rescue_untitled_in`, `cannot find function rescue_text`.

- [ ] **Step 3: Implement the rescue writer**

In `session.rs`, after `purge_trash_in`, add:

```rust
/// ⌘W on an untitled tab with text — a deliberate discard (tabs spec §8) —
/// keeps that text as `session/.trash/closed-<tab_id>.trashed-<secs>.md`.
/// The sidecar alone can be a heartbeat (5 s) behind what was on screen.
pub fn rescue_untitled(tab_id: &str, text: &str) -> Result<PathBuf, String> {
    rescue_untitled_in(&drafts_trash_dir()?, tab_id, text, now_secs())
}

fn rescue_untitled_in(trash: &Path, tab_id: &str, text: &str, now_secs: u64) -> Result<PathBuf, String> {
    if !is_valid_tab_id(tab_id) {
        return Err(format!("invalid tab id: {tab_id:?}"));
    }
    fs::create_dir_all(trash).map_err(|e| format!("create {}: {e}", trash.display()))?;
    let dest = trash_path_for(trash, &format!("closed-{tab_id}"), now_secs)?;
    let tmp = trash.join(format!(".closed-{tab_id}.tmp"));
    fs::write(&tmp, text).map_err(|e| format!("write the rescue copy: {e}"))?;
    fs::rename(&tmp, &dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("save the rescue copy: {e}")
    })?;
    Ok(dest)
}
```

- [ ] **Step 4: Implement `rescue_text` and the `tab_close` argument**

In `src-tauri/src/tab_commands.rs`, directly above the doc comment of `tab_close` (line 242), add:

```rust
/// What ⌘W leaves for a rescue copy: an untitled tab's text, when it has any.
/// A file tab's text is on disk already.
pub(crate) fn rescue_text<'a>(path: Option<&str>, content: Option<&'a str>) -> Option<&'a str> {
    match (path, content) {
        (None, Some(text)) if !text.trim().is_empty() => Some(text),
        _ => None,
    }
}
```

Replace `tab_close` (lines 242-286, doc comment included) with:

```rust
/// ⌘W on a tab, after the frontend flushed and handed it over. Fails the
/// agents still waiting on its document (pending and queued), commits its
/// comment pauses, and records it for ⌘⇧T with the caret the frontend saw.
/// `content` is an untitled tab's text as it was on screen: ⌘W discards it
/// by design (tabs spec §8), but never without a copy in the draft trash.
#[tauri::command]
pub async fn tab_close(
    app: AppHandle,
    window: tauri::WebviewWindow,
    tab_id: String,
    cursor: usize,
    top_line: usize,
    content: Option<String>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let (removed, number) = {
        let open_files = app.state::<OpenFiles>();
        let mut reg = open_files.0.lock().unwrap();
        let was_active =
            reg.window(&label).and_then(|w| w.active.as_deref()) == Some(tab_id.as_str());
        let number = reg.window(&label).and_then(|w| w.number);
        let removed = reg.remove_tab(&label, &tab_id);
        if removed.is_some() && was_active {
            window::set_watcher(&app, &label, None);
        }
        (removed, number)
    };
    let Some(tab) = removed else {
        return Ok(());
    };

    // After the registry guard (no disk under `OpenFiles`), before the
    // session forgets the tab and the GC takes its sidecar.
    if let Some(text) = rescue_text(tab.path.as_deref(), content.as_deref()) {
        if let Err(e) = crate::session::rescue_untitled(&tab_id, text) {
            eprintln!("tab_close: no rescue copy of {tab_id}: {e}");
        }
    }

    let session = app.state::<SessionState>();
    // At once, not at the next heartbeat: a quit in between would restore it.
    session.remove_tab(&label, &tab_id);

    if let Some(path) = tab.path {
        crate::ai_socket::cancel_for_tab(&app, &label, &path, "tab closed");
        crate::comment_pause::commit_document(std::path::Path::new(&path));
        let stack = app.state::<crate::closed::ClosedStack>();
        if crate::closed::record_tab_close(&session, &stack, &label, number, &path, cursor, top_line) {
            crate::closed::refresh_reopen_item(&app);
        }
        std::thread::spawn(move || {
            let _ = crate::recovery::delete_recovery_sync(&path);
        });
    }
    Ok(())
}
```

- [ ] **Step 5: Run the tests and clippy**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml --lib rescue`
Expected: PASS — 3 tests. Then `--lib session::` → **75 passed**. Clippy: baseline count.

- [ ] **Step 6: Commit**

```sh
git add src-tauri/src/session.rs src-tauri/src/tab_commands.rs
git commit -m "fix(tabs): cmd-W on an untitled tab keeps a rescue copy in the draft trash

tab_close takes the discarded text and writes it to
session/.trash/closed-<tab_id>.trashed-<secs>.md before the session forgets
the tab.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src-tauri/src/session.rs src-tauri/src/tab_commands.rs
```

---

### Task 6: The controller hands the discarded text to `tab_close`

**Files:**
- Modify: `src/lib/tabs/controller.ts` (the `rust.close` type at line 226; `closeNow`, lines 875-953)
- Modify: `src/lib/tabs/controller.test.ts` (assertions at lines 573, 584, 810, 839, 1492, 1642; new tests in `describe('close', …)` at line 535)
- Modify: `src/App.svelte:750-751`

- [ ] **Step 1: Write the failing tests and update the existing assertions**

In `src/lib/tabs/controller.test.ts`, inside `describe('close', () => {` (line 535), after the test `DiscardsAnUntitledTabsTextOnClose`, add:

```ts
  it('HandsTheDiscardedUntitledTextToRust_AsTheViewHoldsIt', async () => {
    // The sidecar can be a heartbeat behind: Rust keeps this copy in the draft trash.
    const h = await started({ '/a.md': 'AAAA' }, [untitledTab('u', 'draft'), fileTab('a', '/a.md')], 'u');
    h.type(' and the rest');
    await h.controller.closeActive();
    expect(h.deps.rust.close).toHaveBeenCalledWith('u', expect.anything(), 'draft and the rest');
  });

  it('HandsABackgroundUntitledTabsCachedTextToRust', async () => {
    const h = await started({ '/a.md': 'AAAA' }, [untitledTab('u', 'one'), fileTab('a', '/a.md')], 'u');
    h.type(' two');
    await h.controller.activate('a');
    await h.controller.closeTabs(['u']);
    expect(h.deps.rust.close).toHaveBeenCalledWith('u', expect.anything(), 'one two');
  });

  it('HandsNoTextForAFileTab', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md'), fileTab('b', '/b.md')]);
    await h.controller.closeActive();
    expect(h.deps.rust.close).toHaveBeenCalledWith('a', expect.anything(), null);
  });
```

Update the six existing `rust.close` assertions to the three-argument call (`expect.anything()` does not match `null`, so file tabs get an explicit `null`):

| Line | Test | Becomes |
|---|---|---|
| 573 | `DiscardsAnUntitledTabsTextOnClose` | `expect(h.deps.rust.close).toHaveBeenCalledWith('u', { cursor: 0, topLine: 1 }, 'draft');` |
| 584 | `ClosesABackgroundTabWithItsCachedPosition` | `expect(h.deps.rust.close).toHaveBeenCalledWith('a', { cursor: 2, topLine: 1 }, null);` |
| 810 | `ClosingABackgroundUntitledTabDropsItsText` | `expect(h.deps.rust.close).toHaveBeenCalledWith('u', { cursor: 0, topLine: 1 }, 'draft');` |
| 839 | `CallsMadeInOneTickSeeTheListTheEarlierOneLeft` | `expect(h.deps.rust.close).toHaveBeenCalledWith('t1', expect.anything(), null);` |
| 1492 | `KeepMakesItAnOrdinaryTab_CloseClosesItTheCmdWWay` | `expect(h.deps.rust.close).toHaveBeenCalledWith('t2', expect.anything(), null);` |
| 1642 | `ExpiredWhileTheAppWasDown_TheFirstTickClosesTheBackgroundOnes_NeverTheActiveOne` | `expect(h.deps.rust.close).toHaveBeenCalledWith('c', expect.anything(), null);` |

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/tabs/controller.test.ts`
Expected: FAIL — the 3 new tests and the 6 updated ones, each with `expected "spy" to be called with arguments: [ 'u', Anything, 'draft and the rest' ]` (received two arguments).

- [ ] **Step 3: Implement**

In `src/lib/tabs/controller.ts`, replace the `close` member of `rust` (line 226) with:

```ts
    /**
     * ⌘W (Rust `tab_close`). `discarded`: an untitled tab's text as it was on
     * screen, for the rescue copy in the draft trash; `null` for a file tab.
     */
    close(tabId: string, position: Position, discarded: string | null): Promise<void>;
```

In `closeNow`, replace

```ts
    if (!findById(list, tabId)) return false;
    const finish = (position: Position) =>
      how === 'close' ? deps.rust.close(tabId, position) : deps.rust.release(tabId);

    if (tabId !== list.activeId) {
      // A background tab is clean by construction and was handed over when
      // it was left; there is nothing to flush.
      const cached = cache.get(tabId);
      cache.delete(tabId);
      deps.ai.forget(tabId);
      publish(removeTab(list, tabId).state);
      await finish({ cursor: cached?.cursor ?? 0, topLine: cached?.topLine ?? 1 });
      deps.settled();
      return true;
    }
```

with

```ts
    const closing = findById(list, tabId);
    if (!closing) return false;
    const finish = (position: Position, discarded: string | null) =>
      how === 'close' ? deps.rust.close(tabId, position, discarded) : deps.rust.release(tabId);

    if (tabId !== list.activeId) {
      // A background tab is clean by construction and was handed over when
      // it was left; there is nothing to flush.
      const cached = cache.get(tabId);
      const discarded =
        closing.path === null ? (cached?.state?.doc.toString() ?? cached?.content ?? null) : null;
      cache.delete(tabId);
      deps.ai.forget(tabId);
      publish(removeTab(list, tabId).state);
      await finish({ cursor: cached?.cursor ?? 0, topLine: cached?.topLine ?? 1 }, discarded);
      deps.settled();
      return true;
    }
```

Further down in the same function, replace

```ts
    // From the dirty check above to the swap, nothing awaits.
    if (path !== null) deps.comments.forget(path);
    deps.editor.stripForBackground();
```

with

```ts
    // From the dirty check above to the swap, nothing awaits.
    if (path !== null) deps.comments.forget(path);
    // What ⌘W discards, as the view holds it now: the sidecar may be a heartbeat behind.
    const discarded = path === null ? (deps.editor.current()?.doc.toString() ?? null) : null;
    deps.editor.stripForBackground();
```

and change both remaining `await finish(position);` calls in `closeNow` (the last-tab branch and the one after `await enter(next.tab, …)`) to:

```ts
      await finish(position, discarded);
```

(the second one without the extra indentation: `    await finish(position, discarded);`).

In `src/App.svelte`, replace (lines 750-751)

```ts
      close: (tabId, { cursor, topLine }) =>
        invoke<void>('tab_close', { tabId, cursor, topLine }).catch(logTabIpc('tab_close')),
```

with

```ts
      close: (tabId, { cursor, topLine }, discarded) =>
        invoke<void>('tab_close', { tabId, cursor, topLine, content: discarded }).catch(logTabIpc('tab_close')),
```

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run src/lib/tabs/controller.test.ts` → PASS, Task 0's count + 3.
Run: `npm run check` → `0 errors`.

- [ ] **Step 5: Commit**

```sh
git add src/lib/tabs/controller.ts src/lib/tabs/controller.test.ts src/App.svelte
git commit -m "fix(tabs): hand the discarded untitled text to tab_close

The controller is the one place that holds the text at the moment of cmd-W;
Rust keeps it as the rescue copy.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/lib/tabs/controller.ts src/lib/tabs/controller.test.ts src/App.svelte
```

---

### Task 7: CLAUDE.md — the data-safety rule

**Files:**
- Modify: `CLAUDE.md` (architecture line 55; a new section before `## Gotchas` at line 250; gotcha at line 291; gotcha at line 335)

- [ ] **Step 1: Architecture line**

Replace line 55

```
  session.rs            # Session restore v2 (windows → tabs, geometry, caret, untitled buffers); tabs_sync heartbeat; v1 migration
```

with

```
  session.rs            # Session restore v2 (windows → tabs, geometry, caret, untitled buffers); tabs_sync heartbeat; v1 migration; draft trash (session/.trash/, 30 days) and the ⌘W rescue copy
```

- [ ] **Step 2: The rule**

Insert directly above `## Gotchas`:

```markdown
## Data safety

**User text is never deleted without a second copy.** Every path that makes text unreachable — a GC, a close, a migration — first leaves a copy the owner can find; only that copy's own retention may remove it. A new deletion path needs a test that the copy exists before the original goes.

- Untitled drafts the session stops referencing are **moved** (`rename`, same volume) to `<app data>/session/.trash/<name>.trashed-<unix secs>.md` by `session::prune_untitled_files`, never removed. `session::purge_drafts_trash` deletes a trash file 30 days after the stamp in its *name* (`rename` keeps the old mtime, so the mtime says nothing about when it was thrown away) and never touches a name it did not write.
- ⌘W on an untitled tab with text (a deliberate discard, tabs spec §8) also writes the text as it was on screen to `session/.trash/closed-<tab_id>.trashed-<secs>.md` (`tab_close`'s `content`): the sidecar can be a heartbeat (5 s) behind.
- Known gap: a red-button close or a quit keeps only what the last heartbeat wrote (≤ 5 s old), through the GC's trash. It closes when stash notes (stage 03) replace untitled.
- Live check for all of it: `scripts/verify-draft-safety.sh` against a `pro.couplet.safety` debug bundle (`docs/superpowers/plans/2026-09-27-stash-01-safety-net.md`, Task 1).
```

- [ ] **Step 3: Rewrite the untitled GC gotcha**

Replace the bullet at line 291 (it starts `- **Untitled sidecar GC must consider the pending restore.**`) with:

```markdown
- **The session file must name every draft the next launch has to keep — the un-restored ones included.** Restoring the previous session is opt-in (the toast, File → Reopen Windows from Last Session), so at startup the live session is empty while `pending` holds the previous run's windows. `SessionState::referenced_untitled()` protects their drafts in memory for this run; `SessionState::snapshot` writes every un-restored window that holds a draft back into `session-v2.json` (`unrestored_draft_windows`) so the *next* launch's GC still sees them. Until 2.0.2 `snapshot` wrote only the live windows: a launch nobody restored rewrote the file without the drafts (first tick, quit, language restart), and the next process deleted them at its first tick. That lost the owner's plans on 2026-09-26 — `brew upgrade` 2.0.0 → 2.0.1 put the welcome window in front of the restore toast, and a language switch 18 s later restarted the app (evidence: the stash-01 plan). Windows of file tabs only are not carried: their files are on disk.
```

- [ ] **Step 4: Update the session v2 gotcha's last sentence**

In the bullet at line 335 (it starts `- **Session v2 lives in \`session-v2.json\`**`), replace its last sentence

```
The GC (`is_untitled_sidecar`) prunes both prefixes, and only what `referenced_untitled` does not name.
```

with

```
The GC (`is_untitled_sidecar`) handles both prefixes, and only what `referenced_untitled` does not name — moving it to `session/.trash/`, never deleting it (see Data safety).
```

- [ ] **Step 5: Commit**

```sh
git add CLAUDE.md
git commit -m "docs(claude-md): user text is never deleted without a second copy

Data-safety section (draft trash, cmd-W rescue copy, the 5 s gap), and the
untitled GC gotcha rewritten around the 2026-09-26 root cause.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- CLAUDE.md
```

---

### Task 8: Live verification on the debug bundle

**Files:** none (evidence goes into the night report).

- [ ] **Step 1: Rebuild the verification bundle from the fixed code**

Same command as Task 1 Step 2:

```sh
CARGO_TARGET_DIR=~/.cargo/stash-impl-target npx tauri build --debug --bundles app --features mcp-bridge \
  --config src-tauri/tauri.dev.conf.json \
  --config '{"productName":"couplet-safety","identifier":"pro.couplet.safety"}'
```

- [ ] **Step 2: The scripted check must pass**

```sh
bash scripts/verify-draft-safety.sh ~/.cargo/stash-impl-target/debug/bundle/macos/couplet-safety.app; echo "exit $?"
```

Expected: 12 `PASS` lines, no `FAIL`, no trash listing, `exit 0`. Paste the output into the night report next to Task 1's reproduction.

- [ ] **Step 3: Live text and an AppleEvent quit (H2)**

```sh
rm -rf "$HOME/Library/Application Support/couplet-safety"
rm -f /tmp/pro_couplet_safety_si.sock
open -n -a ~/.cargo/stash-impl-target/debug/bundle/macos/couplet-safety.app --stdout /tmp/couplet-safety.log --stderr /tmp/couplet-safety.log
```

With the tauri MCP tools: `driver_session` (start; the bridge scans from port 9223), then `ipc_get_backend_state` — confirm it is the `couplet-safety` app (identifier / app name); if another bridge app answered, reconnect on the next port. Then `webview_execute_js` in window `main`:

```js
(() => {
  const v = document.querySelector('.cm-content').cmTile.root.view;
  v.dispatch({ changes: { from: 0, insert: '- [ ] LIVE: typed before the quit' } });
  return v.state.doc.toString();
})()
```

Expected: `"- [ ] LIVE: typed before the quit"`.

- [ ] **Step 4: Wait for the heartbeat, then check the sidecar**

After ≥ 6 s (a `Monitor` until-loop, or a backgrounded `sleep 6`):

```sh
ls "$HOME/Library/Application Support/couplet-safety/session/"
cat "$HOME/Library/Application Support/couplet-safety/session/"draft-*.md
```

Expected: one `draft-<tab_id>.md` holding the text.

- [ ] **Step 5: Quit by AppleEvent and check the session file**

```sh
osascript -e 'quit app id "pro.couplet.safety"'
pgrep -f "couplet-safety.app/Contents/MacOS/couplet" || echo "quit"
grep -o '"untitled": "[^"]*"' "$HOME/Library/Application Support/couplet-safety/session-v2.json"
ls "$HOME/Library/Application Support/couplet-safety/session/"
```

Expected: `quit`; `"untitled": "draft-<tab_id>.md"`; the draft still in `session/`. **H2 refuted** → record it and skip Task 8b. If the session file does not name the draft, or the draft sits in `.trash/`: **H2 confirmed** → record the evidence (the trash file's stamp vs. the quit time, the window count in `session-v2.json`, `/tmp/couplet-safety.log`) and do Task 8b before going on.

- [ ] **Step 6: Two launches without a restore, then the restore**

```sh
open -n -a ~/.cargo/stash-impl-target/debug/bundle/macos/couplet-safety.app --stdout /tmp/couplet-safety.log --stderr /tmp/couplet-safety.log
```

Wait ≥ 8 s, `osascript -e 'quit app id "pro.couplet.safety"'`, launch again the same way, wait ≥ 8 s. Then:

```sh
ls "$HOME/Library/Application Support/couplet-safety/session/"
grep -c '"untitled": "draft-' "$HOME/Library/Application Support/couplet-safety/session-v2.json"
```

Expected: the draft is still there and named (count ≥ 1). Reconnect the bridge (`driver_session`), then in `main`:

```js
window.__TAURI_INTERNALS__.invoke('restore_session').then((n) => { window.__probe = n; }); 'fired'
```

The eval may answer `Script execution timeout` — the call still runs (CLAUDE.md, MCP traps). Next call: `window.__probe` → a number ≥ 1; then `delete window.__probe`. `manage_window` (list) shows a new `editor-N`; in it:

```js
document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()
```

Expected: `"- [ ] LIVE: typed before the quit"`.

- [ ] **Step 7: ⌘W's rescue copy**

`ipc_emit_event` with event `menu-event` and payload `"close"`, targeted at `editor-N` if the tool offers a target (a broadcast closes the active tab of every window too — acceptable in this scratch identity). Then:

```sh
ls "$HOME/Library/Application Support/couplet-safety/session/.trash/"
cat "$HOME/Library/Application Support/couplet-safety/session/.trash/"closed-*.md
```

Expected: `closed-<tab_id>.trashed-<secs>.md` holding the live text (and, after the next tick, the GC's `draft-<tab_id>.trashed-<secs>.md` beside it). If `ipc_emit_event` cannot deliver a menu event, note it in the night report — the controller tests (Task 6) and the Rust tests (Task 5) cover this path.

- [ ] **Step 8: Clean up**

```sh
osascript -e 'quit app id "pro.couplet.safety"'
rm -rf "$HOME/Library/Application Support/couplet-safety" "$HOME/Library/WebKit/pro.couplet.safety"
rm -f /tmp/pro_couplet_safety_si.sock /tmp/couplet-safety.log
```

No commit.

---

### Task 8b (only if Task 8 Step 5 confirmed H2): an empty report keeps a known draft

Do this task **only** if the AppleEvent quit left the draft unnamed **while its window was still in `session-v2.json`** (the name was dropped, i.e. H3 happened on the way out). If a whole window is missing instead (a `Destroyed` before `RunEvent::Exit`, contradicting the measurement in `CLAUDE.md`), do not improvise: write `Q<N>` in `docs/superpowers/plans/stash-questions.md` with the evidence, tell the architect, and continue with Task 9 — Task 2 already guarantees the draft is in the trash, not gone.

**Files:**
- Modify: `src-tauri/src/session.rs` (`SessionState`, `tab_snapshots` ≈ line 804; test `a_heartbeat_with_an_empty_untitled_buffer_drops_the_sidecar_name` ≈ line 1602)

- [ ] **Step 1: Write the failing test**

Replace the test `a_heartbeat_with_an_empty_untitled_buffer_drops_the_sidecar_name` with:

```rust
    #[test]
    fn an_empty_report_keeps_a_known_draft_and_writes_nothing() {
        // H2 (stage 01, Task 8b): an empty report for a tab that already has a
        // sidecar must not unname it — the sidecar keeps its last text.
        let state = SessionState::new();
        state.seed("main", window(vec![untitled_tab("u", "untitled-u.md")]));
        let reports = vec![TabReport { tab_id: "u".into(), path: None, cursor: 0, top_line: 1, content: Some(String::new()), ..Default::default() }];
        record_heartbeat(&state, "main", reports, Some("u".to_string()), &["u".to_string()], &HashSet::new(), |_, _| {
            panic!("an empty report never overwrites a sidecar")
        })
        .unwrap();
        assert!(state.referenced_untitled().contains("untitled-u.md"));
    }

    #[test]
    fn a_blank_tab_that_never_had_a_draft_still_gets_none() {
        let state = SessionState::new();
        let reports = vec![TabReport { tab_id: "u".into(), path: None, cursor: 0, top_line: 1, content: Some(String::new()), ..Default::default() }];
        record_heartbeat(&state, "main", reports, Some("u".to_string()), &["u".to_string()], &HashSet::new(), |_, _| {
            panic!("no sidecar for an empty buffer")
        })
        .unwrap();
        assert!(state.referenced_untitled().is_empty());
        assert!(prune_missing(state.snapshot(0), |_| true).windows.is_empty(), "a blank tab never comes back");
    }
```

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml --lib session::an_empty_report`
Expected: FAIL — `assertion failed: state.referenced_untitled().contains("untitled-u.md")`.

- [ ] **Step 2: Implement**

In `impl SessionState`, after `untitled_file_for`, add:

```rust
    /// The sidecar name this window's entry records for `tab_id`, if any —
    /// unlike `untitled_file_for`, no name is made up for a tab without one.
    fn recorded_untitled(&self, label: &str, tab_id: &str) -> Option<String> {
        let map = self.entries.lock().unwrap();
        map.get(label)
            .and_then(|w| w.tabs.iter().find(|t| t.tab_id == tab_id))
            .and_then(|t| t.untitled.clone())
    }
```

In `tab_snapshots`, replace

```rust
            let untitled = match (&r.path, r.content) {
                (None, Some(text)) if !text.is_empty() => {
                    let name = state.untitled_file_for(label, &r.tab_id);
                    writes.push((name.clone(), text));
                    Some(name)
                }
                _ => None,
            };
```

with

```rust
            let untitled = match (&r.path, r.content) {
                (None, Some(text)) if !text.is_empty() => {
                    let name = state.untitled_file_for(label, &r.tab_id);
                    writes.push((name.clone(), text));
                    Some(name)
                }
                // A tab that already has a sidecar keeps it, unwritten: an empty
                // report on the way out (Task 8b) must not unname the only copy.
                // Cost: a draft emptied by hand comes back with its last text.
                (None, _) => state.recorded_untitled(label, &r.tab_id),
                _ => None,
            };
```

- [ ] **Step 3: Run the tests, rebuild, re-run Task 8 Steps 2–5**

`CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml --lib session::` → PASS. Clippy: baseline. Rebuild the bundle, repeat Task 8 Steps 2–5: Step 5 must now show the draft named.

- [ ] **Step 4: Commit**

```sh
git add src-tauri/src/session.rs
git commit -m "fix(session): an empty report never unnames a draft that has a sidecar

Seen on an AppleEvent quit (stage 01, Task 8): the last heartbeat reported
the untitled text as empty and the session forgot the draft.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src-tauri/src/session.rs
```

---

### Task 9: Stage end — full checks, review, draft PR

**Files:** none new.

- [ ] **Step 1: Full suites**

```sh
CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^test result"
CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo clippy --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "generated [0-9]+ warning"
npx vitest run --dir src 2>&1 | tail -4
npm run check
CARGO_TARGET_DIR=~/.cargo/stash-impl-target npm run check:x86
```

Expected: cargo = Task 0 baseline + 14 new tests (13 in `session::`, 1 in `tab_commands::`; +1 more if Task 8b ran), 0 failed; clippy = baseline; vitest = baseline + 3, 0 failed; `npm run check` 0 errors; `check:x86` builds.

- [ ] **Step 2: Code review**

Run the `code-reviewer` agent over `git diff main...fix/draft-safety` with this brief: data safety first — any path that can still remove user text without a second copy; the lock order in `snapshot` (entries → pending → restoring); the purge's name parsing; `tab_close` writing to disk outside the `OpenFiles` lock. Fix every finding in its own commit.

- [ ] **Step 3: Push and open the draft PR**

```sh
git push -u origin fix/draft-safety
gh pr create --draft --base main --head fix/draft-safety \
  --title "fix(session): drafts are never deleted — trash, rescue copy, un-restored sessions kept" \
  --body "$(cat <<'EOF'
Stage 01 of the stash roadmap (docs/superpowers/plans/2026-09-27-stash-01-safety-net.md). Releasable alone as 2.0.2 — not released here.

## Root cause of the 2026-09-26 loss
Restoring the previous session is opt-in, but `SessionState::snapshot` wrote only the live windows. 2.0.1's first launch (welcome window in front of the restore toast) rewrote `session-v2.json` without 2.0.0's drafts; a language switch 18 s later restarted the app, and the restarted process's first tick deleted them (`session/` mtime 02:17:09; unified log shows the restart as a non-LaunchServices child, same pattern as the 02:20:08 switch). Evidence table in the plan.

## Changes
- `snapshot` writes every un-restored window that holds a draft (root cause).
- The session GC moves unreferenced drafts to `session/.trash/<name>.trashed-<secs>.md`; purge after 30 days by the stamp in the name.
- cmd-W on an untitled tab with text writes a rescue copy to the trash (`tab_close` `content`).
- `scripts/verify-draft-safety.sh`: live check against a `pro.couplet.safety` debug bundle — FAILs on 2.0.1, PASSes here.
- CLAUDE.md: "user text is never deleted without a second copy".

## Verification
cargo / vitest / check / check:x86 green; live check output in the night report.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: a draft PR URL. Put it in the night report with the reproduction (Task 1), the passing run (Task 8), the H2 verdict and the test numbers.

---

## Risks and follow-ups (for the night report)

- **Growth of the restore offer:** a window holding a draft that is never restored is carried to every later session. Bounded to draft windows; stage 03 migrates drafts into notes and ends it.
- **The last ≤ 5 s** of untitled typing before a red-button close or a quit are not in the sidecar (pre-existing, tabs-02 D17). Documented in CLAUDE.md; closes with stage 03.
- **Owner decisions, not done here:** auto-restore after the app's own restart (language switch); making the restore toast visible when the welcome window is in front.
- **Stage 03 must read the trash:** its one-time draft migration should consider `session/.trash/` (drafts thrown away in the last 30 days) and the carried un-restored windows, not only the live session.
