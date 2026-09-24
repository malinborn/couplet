//! One-time data migration for a product rename (product name AND bundle
//! identifier both changing at once).
//!
//! Two independent, identity-keyed data stores would otherwise silently
//! orphan a user's data the moment `tauri.conf.json` picks new names:
//!
//! 1. `~/Library/Application Support/<productName>/` (see `paths.rs`) —
//!    `recovery/`, `session/`, `session.json`, `onboarding-version`,
//!    `ai-connected`, and the `ai-*.md` / `welcome-*.md` docs. Keyed by
//!    product name.
//! 2. `~/Library/WebKit/<identifier>/` — WKWebView's own profile, keyed by
//!    the Tauri `identifier`. Under it, `WebsiteData/Default/salt` plus
//!    `WebsiteData/Default/<hash>/<hash>/LocalStorage/localstorage.sqlite3`
//!    hold `localStorage` (theme, recent files, the `ai-hint-seen` flag),
//!    IndexedDB, media-key salts and WebKit's own bookkeeping. **The
//!    `<hash>` directory name is derived from `Default/salt` plus the
//!    origin** — confirmed against a real profile: `com.md-mini.app` and
//!    `com.md-mini.dev` carry two different `<hash>` names for the same
//!    origin, because each identifier's salt was generated independently.
//!    So the whole `<identifier>/` directory has to move as one unit, salt
//!    included, or the copied hash directory is unreachable under the new
//!    identifier's own (different) salt.
//!
//! ## `paths.rs`'s isolation invariant is load-bearing here too
//!
//! `paths.rs` names its directory after the product specifically so that a
//! dev build and a release build — two processes that can genuinely be
//! running at once — never share `recovery/`/`session/`. This module MUST
//! NOT punch a hole in that invariant: an earlier version of this file
//! silently started the new build on the OLD (legacy) directory whenever
//! migration was deferred or failed, which is EXACTLY "two live processes
//! sharing one data directory" the moment the legacy build is also running
//! — untitled buffers overwritten, `recovery/` snapshots deleted out from
//! under the other process, `session.json` won by whoever wrote last. That
//! path no longer exists for the "legacy build is running" case: see
//! "Resolving a running legacy build" below. It is still used, narrowly, for
//! a genuine copy *failure* while nothing else is running — no second
//! process, no shared directory, just this one process choosing where to
//! read its own data from for one more launch.
//!
//! ## Matching: exact `from -> to`, never a suffix guess, and never in a
//! debug build for a release row (N5)
//!
//! [`RENAMES`] lists every approved rename as an exact `(from, to)` pair,
//! matched by exact equality against `to_*` — never a `-dev`/`.dev` suffix
//! guess, which would treat any unrecognised dev-flavoured name as eligible
//! to receive production data. Each row also carries `dev: bool`. In a
//! `debug_assertions` build (`cargo build`, `tauri dev` — WITHOUT
//! `--release`), only `dev: true` rows are ever matched, full stop. This is
//! what makes `npm run tauri dev` (no `--config`, so it reads
//! `tauri.conf.json` — the PRODUCTION config, per this repo's own
//! `CLAUDE.md`) safe after `tauri.conf.json` is renamed: the resulting
//! `current_product_name` would be `"couplet"`, which only the RELEASE
//! (`dev: false`) row's `to_product_name` matches — and that row is
//! invisible to a debug build. Without this, the very first routine
//! `tauri dev` run after the rename would treat the owner's real, installed
//! `md-mini` data as fair game. A release build (`tauri build`, with or
//! without `tauri.dev.conf.json`) has no such restriction — `npm run
//! build:dev` legitimately needs the dev row to still work.
//!
//! ## Never losing the race between two processes (or two migration
//! attempts within one) — C1
//!
//! `migrate_dir` never populates `new` incrementally: a copy lands in a
//! private, per-attempt staging directory
//! (`<parent>/.<name>.migrating-<pid>-<seq>`) and `new` only ever comes into
//! existence via ONE atomic `rename` — either directly, or committing a
//! fully-written staging directory. A failure removes only the staging path
//! (via the `StagingCleanup` `Drop` guard), never `old` or `new`. A `rename`
//! failing with `NotFound` (source vanished between our `exists()` check and
//! the call) is rechecked rather than treated as "fall back to copy". A
//! best-effort cross-process `flock` ([`MigrationLock`]) serializes
//! attempts as defense in depth, taken only once there is actually
//! something to do (a matching row whose marker does not already point at
//! `new`) — an ordinary launch, long after migration finished, never takes
//! it. Orphaned staging directories from a process that died without
//! running its `Drop` guard (`SIGKILL`) are swept on the next attempt that
//! does take the lock ([`gc_orphaned_staging`], N9).
//!
//! ## The decision is a pure function (N1/N2 regression surface)
//!
//! [`decide_migration`] takes plain booleans — does the marker already point
//! at `new`, does `old` exist, does `new` already have data, is a legacy
//! instance running — and returns a [`Decision`], checked in that exact
//! order. Marker-match is checked FIRST: an earlier version checked
//! "is a legacy instance running" first instead, which meant a completed
//! migration got silently treated as "still needs to defer" for as long as
//! the legacy build happened to be open for ANY reason (opening one `.md`
//! file in Finder was enough) — see the regression test
//! `marker_match_wins_over_a_running_legacy_instance`.
//!
//! ## Resolving a running legacy build (N1, B1, replaces the old "run on
//! legacy name" fallback)
//!
//! When [`Decision::LegacyRunning`] comes back, this process is not allowed
//! to start on ANY data directory while that decision stands — not the new
//! one (nothing has been migrated into it), and not the old one (that would
//! be the exact two-processes-one-directory bug this section opened with).
//! [`orchestrate`] blocks with a native alert, before `Builder::build()` —
//! before any Tauri window exists — offering to terminate the legacy build
//! (`NSRunningApplication.terminate`, the same "please quit" request Cmd+Q
//! sends; never `forceTerminate`) and wait up to 10 seconds, or to abandon
//! this launch instead.
//!
//! This is a `loop`, not a single attempt (B1): after a successful
//! termination, `orchestrate` RE-EVALUATES both decisions before doing
//! anything else, and loops back to the dialog (with different wording —
//! "didn't quit, it may be waiting in an open dialog") if either is STILL
//! `LegacyRunning` — the legacy build (or an agent's `mdmini`/MCP
//! `allow_launch`) can restart it in the window between "confirmed gone"
//! and "safe to migrate". The match on each decision after the loop is
//! exhaustive, with no `_` arm: a `LegacyRunning` that somehow still reaches
//! [`run_migration_with_retry`] is treated as an internal-error abort, never
//! silently folded into "nothing to do".
//!
//! ## B2: a system alert, never `NSAlert`
//!
//! The dialog is `CFUserNotificationDisplayAlert`
//! (`core-foundation-sys::user_notification`), deliberately NOT `NSAlert`.
//! An earlier version of this code called
//! `NSApplication.sharedApplication` to get an `NSApp` object for
//! `NSAlert.runModal` to run through — reasoning that this only needs the
//! shared instance to *exist*, not the full `NSApplicationMain` event loop.
//! That reasoning was WRONG in a way that would have broken every session
//! silently: `tao` 0.34.6 — the event-loop crate under `wry`/Tauri, which
//! `tauri::Builder::build()` drives via `EventLoop::new()` later — creates
//! its OWN `NSApplication` SUBCLASS there, and its own source
//! (`platform_impl/macos/event_loop.rs`, around the `NSApp()` call) states
//! outright that this "must be done before `NSApp()` is called anywhere
//! else". Calling `sharedApplication` earlier, as the `NSAlert` version did,
//! wins that race and hands `tao` a base-class `NSApplication` instead of
//! its own — permanently losing `tao`'s `sendEvent:` override for the rest
//! of the session (Cmd-modified key handling, device events), for every
//! window the app ever opens. On top of that: the alert could end up drawn
//! behind other windows before `-finishLaunching` runs, and an AppleEvent
//! `odoc` (the `open` command's own mechanism) arriving in that window could
//! be lost. `CFUserNotificationDisplayAlert` never touches `NSApplication`
//! at all — the alert is drawn by a separate system process — so none of
//! this can happen; there is no race to reason about instead of one that
//! merely runs first.
//!
//! `CFUserNotificationDisplayAlert` supports up to three buttons and
//! returns which one was chosen via an out-parameter, PLUS a `SInt32`
//! status for the call itself. I4: [`DialogChoice`] collapses every outcome
//! this code cannot positively identify as the (first) default or (second)
//! alternate button — `kCFUserNotificationCancelResponse`, a timeout, a
//! nonzero status from the call itself — into `CancelOrTimeout`, and every
//! caller treats that exactly like an explicit "Quit". Nothing unrecognised
//! is ever read as "proceed".
//!
//! ## I2/I3: no more fallback names, no more irreversible choices — Retry
//! or Quit, always
//!
//! Both the app-data "use the legacy directory for one launch" fallback and
//! the WebKit "continue without settings" choice are gone. Either one, kept
//! as the only escape from a genuine [`MigrationOutcome::Failed`], reopened
//! a version of N1's own problem: the legacy-name fallback could still
//! collide with a legacy build (or a second `couplet` via `open -n`)
//! starting up AFTER the check ran, and "continue without settings" was
//! presented as an in-the-moment convenience while actually being
//! permanent — WKWebView creates the fresh profile the instant the first
//! window opens, so there is no "later" to retry into. Every `Failed`
//! outcome — app-data or WebKit — now shows the same Retry/Quit alert
//! (see [`run_migration_with_retry`]); Retry re-attempts `migrate_dir`
//! immediately, Quit abandons the launch. Nothing is ever silently
//! degraded, and nothing this process reads from is ever the OLD directory
//! once it has decided to run under the new one.
//!
//! ## I5: the lock is never held across a dialog
//!
//! [`orchestrate`] and [`run_migration_with_retry`] both release
//! [`MigrationEnv::release_lock`] immediately before showing any dialog and
//! re-acquire only after it returns — a human can sit on either alert for
//! an arbitrary amount of time, and another process legitimately
//! attempting the same migration must not be blocked on `flock` for the
//! whole wait. The staged-commit design (C1) is what actually makes this
//! safe to do: `evaluate`/`decide_with`'s re-check right after re-acquiring
//! is what closes the window this necessarily reopens, not the lock itself.
//!
//! ## I7: a short pause after the legacy build actually quits
//!
//! WebKit's `Networking`/`StorageProcess` helper processes can briefly
//! outlive the main process they served — still holding `LocalStorage`'s
//! `.sqlite3`/`-wal`/`-shm` open — so `MigrationEnv::terminate_and_wait`
//! (the real implementation) sleeps briefly after confirming the main
//! process is gone, before this code goes on to copy the WebKit profile.
//! Fixed and short (not a poll loop): there is no stable, public identifier
//! for "this specific helper, spawned by that specific main process" to
//! poll for, and a fixed pause after a CONFIRMED-dead main process is a
//! small, bounded cost compared to the alternative of guessing wrong and
//! copying a live `-wal`.
//!
//! ## T2: the orchestration itself is dependency-injected and tested
//!
//! [`orchestrate`] takes an `&impl `[`MigrationEnv`] — `is_bundle_running`,
//! the lock, both dialogs, terminate-and-wait, logging — so the loop/retry
//! structure above (B1, I2/I3, I5) is exercised directly with a test double
//! (`testing::MockEnv`) instead of only being reachable through a real
//! dialog. `decide_migration` and `decide_with`'s FS-state computation, the
//! staged copy/rename mechanics, permission handling, the debug/release row
//! filter (N5), the production-identity refusal (B3), and orphan cleanup
//! (I1) are all exercised separately, on a real filesystem via a temp
//! directory.
//!
//! What is NOT, and cannot be, exercised by `cargo test`: a real
//! `CFUserNotificationDisplayAlert` actually drawing on screen, a real
//! `NSRunningApplication.terminate` actually quitting a second real
//! process, and WebKit actually re-deriving a `<hash>` from a copied `salt`
//! at runtime — all three need a real macOS session with real second
//! processes and are documented as manual procedures below.
//!
//! ## B3: a debug build must never poison the production names either
//!
//! N5 keeps a debug build (`cargo build`, `tauri dev`) blind to a `dev:
//! false` row when looking for something to migrate FROM — but that alone
//! left a gap: `npm run tauri dev` with no `--config` reads
//! `tauri.conf.json` directly, i.e. the PRODUCTION `productName`/
//! `identifier`, and neither `paths::init` nor WKWebView know or care that
//! this is "only" a debug run. Left unchecked, such a session would create
//! `~/Library/Application Support/couplet/` and/or
//! `~/Library/WebKit/pro.couplet.app/` as real, non-empty directories full
//! of throwaway debug output — and the REAL release build, launched later,
//! would see `Decision::NewAlreadyPopulated` for both and skip the owner's
//! actual `md-mini` data forever. `refuse_debug_build_on_production_identity`
//! runs before anything else in [`migrate_all_real`] and exits (`eprintln!`
//! plus `std::process::exit(1)`) if this build is a debug build, the
//! current name/identifier is exactly a `dev: false` row's production
//! identity, AND real unmigrated legacy data actually exists — a machine
//! with no installed `md-mini` at all has nothing to poison, so nothing to
//! refuse.
//!
//! ## Manual verification (NOT run as part of this change)
//!
//! Two things cannot be proven by `cargo test` at all: WebKit's `<hash>`
//! actually resolving from a copied `salt` at runtime, and the
//! legacy-running dialog actually driving a second real process. Both need
//! (a) a `debug_assertions` build, or `DEBUG_TEST_RENAMES` is compiled out,
//! AND (b) a real, registered `.app` bundle — `NSRunningApplication` does
//! not recognise a bare binary as an app at all, and a bare `tauri dev`
//! process's WebKit profile is keyed by the BINARY'S NAME
//! (`~/Library/WebKit/md-mini`), not by `identifier`, so it cannot exercise
//! the identifier-keyed migration this is meant to verify either way.
//! `npm run dev:app` (a bare binary) fails (a); `npm run build:dev` (a
//! release bundle) fails (b). The one command with both properties:
//! `tauri build --debug` (`-d`/`--debug`, confirmed via `tauri build
//! --help`) — a debug-profile `.app`, built with `--config
//! src-tauri/tauri.dev.conf.json` so it never touches `tauri.conf.json`.
//! Use an isolated `CARGO_TARGET_DIR` for this — never the shared one — and
//! only throwaway `-dev`-flavoured names: never `tauri.conf.json`,
//! `com.md-mini.app`, `~/Library/Application Support/md-mini`, or real
//! `md-mini-dev`/`com.md-mini.dev` data.
//!
//! **(a) WebKit salt/hash transfer.** Point `tauri.dev.conf.json` at a
//! throwaway identity A, `tauri build --debug --config
//! src-tauri/tauri.dev.conf.json`, launch the built `.app`'s binary
//! DIRECTLY from a terminal (registers the bundle id), change something
//! that lands in `localStorage` (e.g. the theme), quit. Confirm
//! `~/Library/WebKit/<A's identifier>/WebsiteData/Default/salt` and a hash
//! directory with `localstorage.sqlite3` exist. Add a temporary
//! `DEBUG_TEST_RENAMES` row A -> B (`dev: true`), point
//! `tauri.dev.conf.json` at B, rebuild, launch B's binary directly. Confirm
//! the theme survived (WebKit re-derived the hash from the copied salt),
//! B's `salt` is byte-for-byte A's, and A's WebKit directory is untouched
//! (copy, not move). Revert `tauri.dev.conf.json` and the
//! `DEBUG_TEST_RENAMES` row; delete both throwaway identities' directories
//! under `~/Library/WebKit/` and `~/Library/Application Support/`.
//!
//! **(b) The legacy-running dialog.** Same setup, two throwaway identities
//! C (legacy stand-in) and D (new stand-in) and a `DEBUG_TEST_RENAMES` row
//! C -> D. Build and launch C's `.app` directly from a terminal, leave it
//! running. Point `tauri.dev.conf.json` at D, rebuild, launch D's `.app`
//! WHILE C IS STILL RUNNING. Confirm the alert appears with the "needs
//! md-mini to quit" text; test both buttons on separate runs — "Quit
//! md-mini and Continue" should terminate C within ~10s and let D proceed
//! and migrate (confirm C's data landed under D's names, and C's directory
//! now holds only the marker); "Quit couplet" should exit D immediately
//! with neither directory touched. Revert and clean up as in (a).
//!
//! **Run 2026-09-25, before the config rename** (identities
//! `couplet-migtest-a`/`pro.couplet.migtest-a` -> `-b`, `tauri build --debug
//! --bundles app --features mcp-bridge`): (a) held — B came up with A's theme
//! and a probe `localStorage` key, `salt` byte-identical, A's profile left in
//! place; the untitled draft, the recovery snapshot, `onboarding-version` and
//! `ai-connected` arrived byte-identical, the session restored both tabs, and
//! the rename letter opened once and not on the next launch. (b) held up to
//! the button: with A running, B showed the alert and created nothing. The
//! "Quit md-mini and Continue" click itself was NOT exercised (the harness may
//! not click system dialogs); `orchestrate`'s tests cover that branch. Found
//! on the way: killing the process that shows the alert does NOT take the
//! alert down — `UserNotificationCenter` keeps an orphan on screen whose
//! buttons then do nothing. Only a kill leaves one; the alert's own timeout
//! and both buttons dismiss it.

use std::fs;
use std::io::{self, Write};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Marker left inside a migrated-from directory once its contents are safely
/// in the new location. Its presence means "do not migrate again" — but only
/// while its content still points at the CURRENT destination; see
/// `marker_points_to`.
const MOVED_MARKER: &str = "MOVED_TO";

/// One approved rename: `from_*` is the exact previous productName/identifier;
/// `to_*` is what it became. Matching is always exact equality against
/// `to_*`. `dev` marks a DEV build's rename (`md-mini-dev` -> `couplet-dev`);
/// see the module doc comment's N5 section for why a `dev: false` row is
/// invisible to a `debug_assertions` build.
#[derive(Debug, Clone, Copy)]
struct Rename {
    from_product_name: &'static str,
    to_product_name: &'static str,
    from_identifier: &'static str,
    to_identifier: &'static str,
    dev: bool,
}

/// Every approved rename this app has gone through. Add a row here — and
/// only here, never touch the matching functions — for the next rename. A
/// third generation (`couplet` -> something else) is just another row whose
/// `from_*` equals THIS row's `to_*`.
const RENAMES: &[Rename] = &[
    Rename {
        from_product_name: "md-mini",
        to_product_name: "couplet",
        from_identifier: "com.md-mini.app",
        to_identifier: "pro.couplet.app",
        dev: false,
    },
    Rename {
        from_product_name: "md-mini-dev",
        to_product_name: "couplet-dev",
        from_identifier: "com.md-mini.dev",
        to_identifier: "pro.couplet.dev",
        dev: true,
    },
];

/// Extra rows consulted ONLY in a debug build (`#[cfg(debug_assertions)]` —
/// compiled out entirely from a release build, so this can never ship even
/// if a row is left in place by accident). Empty by default. Every row added
/// here MUST set `dev: true` — a debug build never matches a `dev: false`
/// row regardless of which table it came from (see N5). See the "Manual
/// verification" procedure handed back with this change for how to use this
/// safely, without ever touching `com.md-mini.app` / `~/Library/Application
/// Support/md-mini` / real `md-mini-dev` data.
#[cfg(debug_assertions)]
const DEBUG_TEST_RENAMES: &[Rename] = &[];

#[cfg(debug_assertions)]
fn debug_test_renames() -> &'static [Rename] {
    DEBUG_TEST_RENAMES
}

#[cfg(not(debug_assertions))]
fn debug_test_renames() -> &'static [Rename] {
    &[]
}

/// N5: in a `debug_assertions` build, only a `dev: true` row is eligible —
/// see the module doc comment. In a release build every row is eligible.
#[cfg(debug_assertions)]
fn row_is_eligible(dev: bool) -> bool {
    dev
}

#[cfg(not(debug_assertions))]
fn row_is_eligible(_dev: bool) -> bool {
    true
}

/// Pure table lookup: the row whose `to_product_name` is exactly `current`,
/// with NO debug/release filtering — used by the multi-generation test (M5),
/// to check a table's shape independent of which build is running the
/// check, and by `production_identity_row` (B3), which specifically needs
/// to see a `dev: false` row regardless of the current build's own flavour.
/// Genuinely unused in a plain (non-test) RELEASE build: `production_identity_row`,
/// its only production caller, is itself only reachable from a debug build.
#[cfg_attr(not(any(test, debug_assertions)), allow(dead_code))]
fn rename_matching_product_name<'a>(table: &'a [Rename], current: &str) -> Option<&'a Rename> {
    table.iter().find(|r| r.to_product_name == current)
}

#[cfg_attr(not(any(test, debug_assertions)), allow(dead_code))]
fn rename_matching_identifier<'a>(table: &'a [Rename], current: &str) -> Option<&'a Rename> {
    table.iter().find(|r| r.to_identifier == current)
}

/// The real lookup: `RENAMES` plus (debug builds only) `DEBUG_TEST_RENAMES`,
/// filtered by `row_is_eligible` — this is the one migration.rs's own code
/// actually calls.
fn rename_for_product_name(current: &str) -> Option<&'static Rename> {
    RENAMES
        .iter()
        .chain(debug_test_renames())
        .filter(|r| row_is_eligible(r.dev))
        .find(|r| r.to_product_name == current)
}

fn rename_for_identifier(current: &str) -> Option<&'static Rename> {
    RENAMES
        .iter()
        .chain(debug_test_renames())
        .filter(|r| row_is_eligible(r.dev))
        .find(|r| r.to_identifier == current)
}

/// Product names this app has previously shipped under, WITHOUT the
/// debug/release eligibility filter — `paths.rs`'s own regression test
/// checks the current release name is still listed here at all (so a future
/// rename cannot drop it without giving it somewhere to migrate to first),
/// which is a question about the TABLE, not about what one particular build
/// flavour can currently reach.
#[cfg(test)]
pub(crate) fn known_legacy_product_names() -> impl Iterator<Item = &'static str> {
    RENAMES.iter().map(|r| r.from_product_name)
}

type Logger<'a> = dyn Fn(&str) + 'a;

/// What [`decide_migration`] decided should happen, given the state of
/// `old`/`new` on disk and whether a legacy instance is running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Decision {
    /// The marker in `old` already points at `new` — done, use the current
    /// name, no further action.
    AlreadyDone,
    /// `old` does not exist — nothing to migrate, use the current name.
    NothingToMigrate,
    /// `new` already has data (not from a marker we recognise) — never
    /// overwrite it; use the current name.
    NewAlreadyPopulated,
    /// A legacy instance matching this generation is running — migration
    /// must not proceed while a second process can be reading/writing
    /// `old`. See the module doc comment's "Resolving a running legacy
    /// build" section.
    LegacyRunning,
    /// Safe and expected to migrate `old` into `new` now.
    Migrate,
}

/// The pure core of N1/N2: given plain facts about the filesystem and
/// whether a legacy instance is running, decide what to do. Order is
/// load-bearing — see the module doc comment's "decision is a pure
/// function" section for why `marker_matches` is checked BEFORE
/// `legacy_running` (N2's regression).
pub(crate) fn decide_migration(
    marker_matches: bool,
    old_exists: bool,
    new_populated: bool,
    legacy_running: bool,
) -> Decision {
    if marker_matches {
        return Decision::AlreadyDone;
    }
    if !old_exists {
        return Decision::NothingToMigrate;
    }
    if new_populated {
        return Decision::NewAlreadyPopulated;
    }
    if legacy_running {
        return Decision::LegacyRunning;
    }
    Decision::Migrate
}

/// Where a migration's bytes are allowed to move.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Strategy {
    /// Try an atomic `rename` of `old` itself first; fall back to a staged
    /// copy if that fails for a reason other than `old` having vanished.
    PreferRename,
    /// Never rename `old` itself — always copy (via staging), and never
    /// touch `old`'s contents. Used for the WebKit profile.
    CopyOnly,
}

/// True when the marker in `old` exists AND its recorded destination is
/// EXACTLY `expected_new`.
fn marker_points_to(old: &Path, expected_new: &Path) -> bool {
    match fs::read_to_string(old.join(MOVED_MARKER)) {
        Ok(content) => content
            .lines()
            .next()
            .map(|line| Path::new(line) == expected_new)
            .unwrap_or(false),
        Err(_) => false,
    }
}

fn write_marker(old: &Path, new: &Path, log: &Logger) {
    let marker = old.join(MOVED_MARKER);
    let content = format!(
        "{}\n\n\
         This directory's contents were moved to the path on the first line \
         above. A future launch treats this directory as already migrated \
         only while that line still matches where the app currently expects \
         its data to be. It is safe to delete this directory once you've \
         confirmed the location above has everything you expect.\n",
        new.display(),
    );
    if let Err(e) = fs::write(&marker, content) {
        log(&format!(
            "migration: could not write marker in {}: {}",
            old.display(),
            e
        ));
    }
}

/// True when `dir` is safe to migrate into: it doesn't exist yet, or it
/// exists as a directory with no entries. Anything else — a stray file, a
/// permission error — is treated as "occupied" rather than "absent".
fn dir_is_absent_or_empty(dir: &Path) -> bool {
    if !dir.exists() {
        return true;
    }
    match fs::read_dir(dir) {
        Ok(mut entries) => entries.next().is_none(),
        Err(_) => false,
    }
}

/// Recursively copies `src` into `dst`. Symlinks are recreated as symlinks;
/// a socket/FIFO/device is skipped (logged, not fatal — none of these are
/// ever real user data here, and `fs::copy` cannot copy one anyway).
///
/// N6: each directory's own mode is copied onto its destination AFTER all of
/// its children have been copied into it, never before. Setting it first —
/// the previous order — means a source directory with a restrictive mode
/// (e.g. `0555`, no write bit) makes its OWN destination unwritable before
/// this function has finished creating files inside it, turning `fs::copy`/
/// `fs::create_dir_all` calls for its children into spurious `EACCES`.
fn copy_dir_recursive(src: &Path, dst: &Path, log: &Logger) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &target, log)?;
        } else if file_type.is_symlink() {
            let link_target = fs::read_link(entry.path())?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(&link_target, &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target)?;
        } else {
            log(&format!(
                "migration: skipping non-regular file {} (socket/FIFO/device) while copying",
                entry.path().display()
            ));
        }
    }
    // Best-effort: a directory's own mode is worth preserving, but failing
    // to set it must not fail the whole copy — content matters most, and by
    // this point every child is already in place, so a restrictive mode set
    // now cannot block anything this call still needs to do.
    if let Ok(meta) = fs::metadata(src) {
        let _ = fs::set_permissions(dst, meta.permissions());
    }
    Ok(())
}

static STAGING_SEQ: AtomicU64 = AtomicU64::new(0);

/// A private, per-attempt staging path: `<new's parent>/.<new's
/// name>.migrating-<pid>-<seq>`.
fn staging_path_for(new: &Path) -> Option<PathBuf> {
    let parent = new.parent()?;
    let name = new.file_name()?;
    let seq = STAGING_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut staging_name = std::ffi::OsString::from(".");
    staging_name.push(name);
    staging_name.push(format!(".migrating-{}-{}", std::process::id(), seq));
    Some(parent.join(staging_name))
}

/// Removes its `path` on `Drop` unless [`disarm`](Self::disarm) was called.
struct StagingCleanup<'a> {
    path: &'a Path,
    armed: std::cell::Cell<bool>,
}

impl<'a> StagingCleanup<'a> {
    fn new(path: &'a Path) -> Self {
        Self {
            path,
            armed: std::cell::Cell::new(true),
        }
    }

    fn disarm(&self) {
        self.armed.set(false);
    }
}

impl Drop for StagingCleanup<'_> {
    fn drop(&mut self) {
        if self.armed.get() {
            let _ = fs::remove_dir_all(self.path);
        }
    }
}

/// N9: a `StagingCleanup` guard only runs on a normal unwind — `SIGKILL`
/// skips `Drop` entirely, leaving a `.{name}.migrating-{pid}-{seq}`
/// directory behind forever. This scans `parent` (a `new`'s parent
/// directory, where staging directories always live) for entries matching
/// that naming pattern whose embedded pid no longer exists
/// (`kill(pid, 0) == ESRCH`) and removes them. Best-effort: a name that
/// doesn't parse, or a pid this process cannot check, is left alone rather
/// than guessed at.
fn gc_orphaned_staging(new: &Path, log: &Logger) {
    let Some(parent) = new.parent() else { return };
    let Some(new_name) = new.file_name().and_then(|n| n.to_str()) else {
        return;
    };
    let prefix = format!(".{new_name}.migrating-");

    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(rest) = name.strip_prefix(prefix.as_str()) else {
            continue;
        };
        let Some(pid) = parse_staging_suffix(rest) else {
            continue;
        };

        // I1: `symlink_metadata` never follows the final component, so a
        // symlink is never mistaken for a real directory here even if it
        // happens to point at one — `remove_dir_all` is only ever called
        // below on something confirmed to be a real, non-symlink directory.
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }

        if !process_is_alive(pid) {
            log(&format!(
                "migration: removing orphaned staging directory {} (pid {pid} is gone)",
                entry.path().display()
            ));
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Parses `<pid>-<seq>` (both purely numeric) from the remainder after the
/// `.{new's file name}.migrating-` prefix `gc_orphaned_staging` already
/// matched exactly. I1: this used to accept anything CONTAINING
/// `.migrating-` anywhere in the whole (shared!) parent directory — this
/// requires the full, exact prefix tied to THIS `new`, and both numeric
/// fields, before a name is even considered.
fn parse_staging_suffix(rest: &str) -> Option<libc::pid_t> {
    let (pid_str, seq_str) = rest.split_once('-')?;
    if seq_str.is_empty() || !seq_str.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    pid_str.parse().ok()
}

/// `kill(pid, 0)` sends no signal — it only checks whether `pid` could be
/// signalled. `ESRCH` means no such process; any other outcome (success, or
/// `EPERM` — exists but owned by someone else) means it is still alive.
fn process_is_alive(pid: libc::pid_t) -> bool {
    // SAFETY: `kill` with signal `0` is the documented existence-check idiom
    // and has no effect on the target process.
    let rc = unsafe { libc::kill(pid, 0) };
    if rc == 0 {
        return true;
    }
    io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

/// The shared core: migrate `old` into `new` under `strategy`. Assumes the
/// caller already resolved `Decision::Migrate` — this function does not
/// itself check the marker, `new`'s occupancy, or whether a legacy instance
/// is running; see `evaluate` and `decide_migration` for that. See the
/// module doc comment's C1 section for the full race-safety argument.
fn migrate_dir(old: &Path, new: &Path, label: &str, strategy: Strategy, log: &Logger) -> MigrationOutcome {
    if strategy == Strategy::PreferRename {
        if let Some(parent) = new.parent() {
            let _ = fs::create_dir_all(parent);
        }
        #[cfg(test)]
        testing::run_before_first_rename_hook();
        match fs::rename(old, new) {
            Ok(()) => {
                log(&format!(
                    "migration: {label} — moved {} -> {}",
                    old.display(),
                    new.display()
                ));
                if fs::create_dir_all(old).is_ok() {
                    write_marker(old, new, log);
                } else {
                    log(&format!(
                        "migration: {label} — moved but could not recreate {} for the marker",
                        old.display()
                    ));
                }
                return MigrationOutcome::Migrated;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                log(&format!(
                    "migration: {label} — source vanished mid-attempt; rechecking instead of copying"
                ));
                return MigrationOutcome::NoOp;
            }
            Err(e) => {
                log(&format!(
                    "migration: {label} — rename failed ({e}), falling back to a staged copy"
                ));
            }
        }
    }

    let Some(staging) = staging_path_for(new) else {
        log(&format!(
            "migration: {label} — {} has no parent/file name, cannot stage a copy",
            new.display()
        ));
        return MigrationOutcome::Failed;
    };
    let cleanup = StagingCleanup::new(&staging);

    if let Err(e) = copy_dir_recursive(old, &staging, log) {
        log(&format!(
            "migration: {label} — copy failed ({e}); leaving data in {} untouched, will retry on next launch",
            old.display()
        ));
        return MigrationOutcome::Failed;
    }

    #[cfg(test)]
    testing::run_before_commit_hook();
    if !dir_is_absent_or_empty(new) {
        log(&format!(
            "migration: {label} — {} gained data while copying, discarding the staged copy",
            new.display()
        ));
        return MigrationOutcome::NoOp;
    }

    match fs::rename(&staging, new) {
        Ok(()) => {
            cleanup.disarm();
            write_marker(old, new, log);
            log(&format!(
                "migration: {label} — copied {} -> {}",
                old.display(),
                new.display()
            ));
            MigrationOutcome::Migrated
        }
        Err(e) => {
            log(&format!(
                "migration: {label} — could not commit the staged copy ({e}); leaving data in {} untouched, will retry",
                old.display()
            ));
            MigrationOutcome::Failed
        }
    }
}

/// What `migrate_dir` actually did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MigrationOutcome {
    NoOp,
    Migrated,
    Failed,
}

/// Computes a [`Decision`] for the pair `(old, new)`, reading real
/// filesystem state and — only when it could actually change the answer —
/// calling `is_running`. The check is skipped whenever the marker already
/// matches, `old` is absent, or `new` is already populated, since none of
/// those branches of `decide_migration` consult it. Parameterised over
/// `is_running` (rather than calling `is_bundle_running` directly) so
/// [`orchestrate`] can supply [`MigrationEnv::is_bundle_running`] here too
/// (T2) without duplicating this logic.
fn decide_with(old: &Path, new: &Path, legacy_identifier: &str, is_running: &dyn Fn(&str) -> bool) -> Decision {
    let marker_matches = marker_points_to(old, new);
    let old_exists = old.exists();
    let new_populated = !dir_is_absent_or_empty(new);
    let legacy_running = !marker_matches && old_exists && !new_populated && is_running(legacy_identifier);
    decide_migration(marker_matches, old_exists, new_populated, legacy_running)
}

/// Thin wrapper around [`decide_with`] using the real, process-global
/// `is_bundle_running` — what every test in this file that isn't exercising
/// [`orchestrate`] itself calls directly. Test-only: `migrate_all_real`
/// builds a `RealEnv` and goes through `orchestrate`/`decide_with` instead.
#[cfg_attr(not(test), allow(dead_code))]
fn evaluate(old: &Path, new: &Path, legacy_identifier: &str) -> Decision {
    decide_with(old, new, legacy_identifier, &is_bundle_running)
}

/// B3: is `current_product_name`/`current_identifier` exactly the
/// PRODUCTION (`dev: false`) identity of some row? Pure — independent of
/// build flavour or filesystem state. See the module doc comment's B3
/// section. Genuinely unused in a plain (non-test) RELEASE build: its only
/// caller, `refuse_debug_build_on_production_identity`, is a no-op there.
#[cfg_attr(not(any(test, debug_assertions)), allow(dead_code))]
fn production_identity_row(current_product_name: &str, current_identifier: &str) -> Option<&'static Rename> {
    rename_matching_product_name(RENAMES, current_product_name)
        .filter(|r| !r.dev)
        .or_else(|| rename_matching_identifier(RENAMES, current_identifier).filter(|r| !r.dev))
}

/// Whether `row`'s legacy data is at risk of being silently poisoned by a
/// debug run under the production names: real `old` data exists and has not
/// already been migrated to THIS `new`. Parameterised by base dirs so tests
/// run against a tempdir. Same release-build caveat as `production_identity_row`.
#[cfg_attr(not(any(test, debug_assertions)), allow(dead_code))]
fn debug_run_risks_real_data(
    app_data_base: &Path,
    webkit_base: &Path,
    row: &Rename,
    current_product_name: &str,
    current_identifier: &str,
) -> bool {
    let app_data_risk = {
        let old = app_data_base.join(row.from_product_name);
        let new = app_data_base.join(crate::paths::dir_name(current_product_name));
        old.exists() && !marker_points_to(&old, &new)
    };
    let webkit_risk = {
        let old = webkit_base.join(row.from_identifier);
        let new = webkit_base.join(current_identifier);
        old.exists() && !marker_points_to(&old, &new)
    };
    app_data_risk || webkit_risk
}

/// B3: refuses to start (rather than silently creating throwaway debug
/// output under the production names) — see the module doc comment. A
/// no-op in a release build, and a no-op in a debug build whenever there is
/// nothing real to poison (a fresh machine with no installed `md-mini`).
#[cfg(debug_assertions)]
fn refuse_debug_build_on_production_identity(current_product_name: &str, current_identifier: &str) {
    let Some(row) = production_identity_row(current_product_name, current_identifier) else {
        return;
    };
    let Some(app_data_base) = dirs::data_dir() else {
        return;
    };
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let webkit_base = home.join("Library").join("WebKit");

    if debug_run_risks_real_data(&app_data_base, &webkit_base, row, current_product_name, current_identifier) {
        eprintln!(
            "migration: refusing to start — this debug build (`cargo build`/`tauri dev`) is \
             running under the PRODUCTION name \"{current_product_name}\" / identifier \
             \"{current_identifier}\". Continuing would create \
             ~/Library/Application Support/{current_product_name}/ and/or \
             ~/Library/WebKit/{current_identifier}/ as real, non-empty directories, which \
             would make the actual release build think migration is already done (or \
             blocked) and permanently skip the real md-mini data. Use `npm run dev:app` \
             instead — it runs under its own separate identity (`couplet-dev` / \
             `pro.couplet.dev`)."
        );
        std::process::exit(1);
    }
}

#[cfg(not(debug_assertions))]
fn refuse_debug_build_on_production_identity(_current_product_name: &str, _current_identifier: &str) {}

// ---------------------------------------------------------------------------
// `NSRunningApplication` — is the legacy build alive right now?
// ---------------------------------------------------------------------------

// Tests must never depend on what is *actually* running on the machine that
// happens to run `cargo test` (this repo's own dev machine typically DOES
// have a real md-mini running) — so under `#[cfg(test)]` this reads only the
// explicit `testing::force_bundle_running` override, defaulting to "nothing
// is running".
#[cfg(not(test))]
fn is_bundle_running(bundle_id: &str) -> bool {
    is_bundle_running_real(bundle_id)
}

#[cfg(test)]
fn is_bundle_running(_bundle_id: &str) -> bool {
    testing::forced_bundle_running().unwrap_or(false)
}

/// An `NSAutoreleasePool` that drains on `Drop` — including on a panic
/// unwinding through it, which a bare `pool.drain()` call at the end of a
/// function does not survive. `cocoa`'s own `NSAutoreleasePool` has no
/// `Drop` impl; this wraps it in one.
#[cfg(target_os = "macos")]
struct AutoreleasePool(cocoa::base::id);

#[cfg(target_os = "macos")]
impl AutoreleasePool {
    unsafe fn new() -> Self {
        use cocoa::base::nil;
        use cocoa::foundation::NSAutoreleasePool;
        Self(NSAutoreleasePool::new(nil))
    }
}

#[cfg(target_os = "macos")]
impl Drop for AutoreleasePool {
    fn drop(&mut self) {
        use cocoa::foundation::NSAutoreleasePool;
        // SAFETY: `self.0` was created by `NSAutoreleasePool::new` in `new`
        // and nothing else drains or frees it.
        unsafe {
            self.0.drain();
        }
    }
}

/// The `NSRunningApplication` instances matching `bundle_id`, EXCLUDING this
/// process's own pid (defensive: this process's identifier should never
/// equal a LEGACY identifier it is checking for, but a match here must never
/// be misread as "the legacy build is running" if it somehow did).
#[cfg(target_os = "macos")]
unsafe fn running_pids_for_bundle(bundle_id: &str) -> Vec<libc::pid_t> {
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSArray, NSString};
    use objc::{class, msg_send, sel, sel_impl};

    let ns_bundle_id = NSString::alloc(nil).init_str(bundle_id);
    let cls = class!(NSRunningApplication);
    let apps: id = msg_send![cls, runningApplicationsWithBundleIdentifier: ns_bundle_id];
    let _: () = msg_send![ns_bundle_id, release];

    if apps.is_null() {
        return Vec::new();
    }
    let count = NSArray::count(apps);
    let my_pid = std::process::id() as libc::pid_t;
    let mut pids = Vec::new();
    for i in 0..count {
        let running_app: id = NSArray::objectAtIndex(apps, i);
        let pid: libc::pid_t = msg_send![running_app, processIdentifier];
        if pid != my_pid {
            pids.push(pid);
        }
    }
    pids
}

#[cfg(target_os = "macos")]
#[cfg_attr(test, allow(dead_code))]
fn is_bundle_running_real(bundle_id: &str) -> bool {
    unsafe {
        let _pool = AutoreleasePool::new();
        !running_pids_for_bundle(bundle_id).is_empty()
    }
}

#[cfg(not(target_os = "macos"))]
fn is_bundle_running_real(_bundle_id: &str) -> bool {
    false
}

/// Sends `terminate` (the "please quit" request, NOT `forceTerminate`) to
/// every running instance of `bundle_id` other than this process, then polls
/// up to `timeout` for them all to disappear. I7: on success, sleeps briefly
/// before returning — see the module doc comment's I7 section for why a
/// confirmed-dead main process is not the same as its WebKit helper
/// processes having released `LocalStorage` yet.
#[cfg(target_os = "macos")]
unsafe fn terminate_bundle_and_wait(bundle_id: &str, timeout: Duration) -> bool {
    use cocoa::base::{id, BOOL};
    use objc::{msg_send, sel, sel_impl};

    {
        let _pool = AutoreleasePool::new();
        for pid in running_pids_for_bundle(bundle_id) {
            let cls = objc::class!(NSRunningApplication);
            let running_app: id = msg_send![cls, runningApplicationWithProcessIdentifier: pid];
            if !running_app.is_null() {
                // `terminate`'s BOOL return is unused (we poll for the
                // process actually disappearing below), but is still
                // declared with `cocoa::base::BOOL` rather than ignored
                // outright — `msg_send!`'s declared return type must match
                // the real ABI, and BOOL's representation is `bool` on
                // aarch64 but `i8` elsewhere (see this repo's own
                // `CLAUDE.md` gotcha about the same trap for an *argument*).
                let _: BOOL = msg_send![running_app, terminate];
            }
        }
    }

    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !is_bundle_running_real(bundle_id) {
            std::thread::sleep(Duration::from_millis(750)); // I7
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    !is_bundle_running_real(bundle_id)
}

#[cfg(not(target_os = "macos"))]
unsafe fn terminate_bundle_and_wait(_bundle_id: &str, _timeout: Duration) -> bool {
    true
}

// ---------------------------------------------------------------------------
// B2: the blocking dialog, via `CFUserNotificationDisplayAlert` — never
// `NSAlert`. See the module doc comment's B2 section for why.
// ---------------------------------------------------------------------------

/// How the user (or a timeout, or the call itself failing) resolved a
/// dialog. I4: everything except the two positively-identified buttons
/// collapses into `CancelOrTimeout`, and every caller treats that exactly
/// like an explicit "Quit" — nothing unrecognised is ever read as "proceed".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DialogChoice {
    /// The first (default) button.
    Default,
    /// The second (alternate) button.
    Alternate,
    /// Cancel, a timeout, or a failed/unrecognised call — always the safe
    /// choice.
    CancelOrTimeout,
}

/// How long a dialog waits for a response before treating it as
/// `CancelOrTimeout` — generous, since a human may not be at the keyboard,
/// but bounded so this can never hang a launch forever.
const DIALOG_TIMEOUT_SECS: f64 = 300.0;

#[cfg(target_os = "macos")]
fn show_system_alert(header: &str, message: &str, default_button: &str, alternate_button: &str) -> DialogChoice {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use core_foundation_sys::user_notification::{
        kCFUserNotificationAlternateResponse, kCFUserNotificationCautionAlertLevel,
        kCFUserNotificationDefaultResponse, CFUserNotificationDisplayAlert,
    };

    let header_cf = CFString::new(header);
    let message_cf = CFString::new(message);
    let default_cf = CFString::new(default_button);
    let alternate_cf = CFString::new(alternate_button);
    let mut response_flags: core_foundation_sys::base::CFOptionFlags = 0;

    // SAFETY: every `CFStringRef` passed in is kept alive by the `CFString`
    // locals above (owned, `Drop`-released) for the whole blocking call; the
    // icon/sound/localization-URL and third-button-title parameters are
    // legitimately null per the API's own documented "omit to skip"
    // contract; `response_flags` is a valid `&mut` for the duration.
    let status = unsafe {
        CFUserNotificationDisplayAlert(
            DIALOG_TIMEOUT_SECS,
            kCFUserNotificationCautionAlertLevel,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            header_cf.as_concrete_TypeRef(),
            message_cf.as_concrete_TypeRef(),
            default_cf.as_concrete_TypeRef(),
            alternate_cf.as_concrete_TypeRef(),
            std::ptr::null(),
            &mut response_flags,
        )
    };

    if status != 0 {
        return DialogChoice::CancelOrTimeout; // I4
    }
    if response_flags == kCFUserNotificationDefaultResponse {
        DialogChoice::Default
    } else if response_flags == kCFUserNotificationAlternateResponse {
        DialogChoice::Alternate
    } else {
        DialogChoice::CancelOrTimeout // I4: Cancel, timeout, or anything else
    }
}

#[cfg(not(target_os = "macos"))]
fn show_system_alert(_header: &str, _message: &str, _default_button: &str, _alternate_button: &str) -> DialogChoice {
    DialogChoice::CancelOrTimeout
}

// ---------------------------------------------------------------------------
// T2: `MigrationEnv` — everything `orchestrate` needs from the outside
// world, injected so the whole decision-and-retry flow (B1, I2/I3, I5) is
// testable without touching `~/Library`, showing a real dialog, or spawning
// a real second process. `RealEnv` is the only non-test implementation.
// ---------------------------------------------------------------------------

pub(crate) trait MigrationEnv {
    fn is_bundle_running(&self, bundle_id: &str) -> bool;
    /// Acquires the cross-process lock (best-effort; see `MigrationLock`).
    /// Idempotent: calling this while already held is a no-op.
    fn acquire_lock(&self);
    /// Releases the lock, if held. Idempotent.
    fn release_lock(&self);
    /// "A legacy build with a matching identity needs to quit" — `retry`
    /// selects the wording for a second (or later) showing (I6): the first
    /// asks it to quit, a retry acknowledges it apparently didn't and
    /// suggests why (an open dialog on its side).
    fn show_legacy_dialog(&self, retry: bool) -> DialogChoice;
    /// "Migrating `label` failed" — Retry/Quit.
    fn show_failure_dialog(&self, label: &str) -> DialogChoice;
    /// Sends `terminate` to `bundle_id` and waits for it to actually quit.
    fn terminate_and_wait(&self, bundle_id: &str) -> bool;
    fn log(&self, msg: &str);
}

/// The real environment: `~/Library`, real `NSRunningApplication`/CF
/// dialogs, a real cross-process `flock`.
struct RealEnv {
    lock: std::cell::RefCell<Option<MigrationLock>>,
    log_path: PathBuf,
}

impl RealEnv {
    fn new(current_product_name: &str) -> Self {
        Self {
            lock: std::cell::RefCell::new(None),
            log_path: log_path_under(&dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")), current_product_name),
        }
    }
}

impl MigrationEnv for RealEnv {
    fn is_bundle_running(&self, bundle_id: &str) -> bool {
        is_bundle_running(bundle_id)
    }

    fn acquire_lock(&self) {
        if self.lock.borrow().is_some() {
            return;
        }
        let log = |m: &str| self.log(m);
        *self.lock.borrow_mut() = MigrationLock::acquire(&log);
    }

    fn release_lock(&self) {
        *self.lock.borrow_mut() = None;
    }

    fn show_legacy_dialog(&self, retry: bool) -> DialogChoice {
        let (header, message) = if retry {
            (
                "md-mini didn't quit — it may be waiting in an open dialog",
                "Switch to md-mini and save or dismiss anything open, or quit couplet instead.",
            )
        } else {
            (
                "couplet (formerly md-mini) needs md-mini to quit",
                "To move your drafts and settings, md-mini needs to quit first. Nothing will be lost.",
            )
        };
        show_system_alert(header, message, "Quit md-mini and Continue", "Quit couplet")
    }

    fn show_failure_dialog(&self, label: &str) -> DialogChoice {
        show_system_alert(
            "couplet couldn't finish moving your data",
            &format!(
                "Something went wrong migrating md-mini's {label}. Check \
                 ~/Library/Logs/<product>/migration.log for details, then Retry, or quit and \
                 try again later."
            ),
            "Retry",
            "Quit couplet",
        )
    }

    fn terminate_and_wait(&self, bundle_id: &str) -> bool {
        unsafe { terminate_bundle_and_wait(bundle_id, Duration::from_secs(10)) }
    }

    fn log(&self, msg: &str) {
        if append_log_line(&self.log_path, msg).is_err() {
            eprintln!("{msg}");
        }
    }
}

/// Best-effort cross-process mutex over migration work, via `flock` on a
/// fixed, well-known file — taken only when there is actually something to
/// do (a matching `Rename` row whose marker does not already point at
/// `new`); an ordinary launch long after migration finished never takes it.
/// Acquisition is best-effort: a failure to open or lock the file is logged
/// and migration proceeds unlocked, since the staged-commit design in
/// `migrate_dir` is what actually guarantees safety (C1). Waiting is bounded
/// to 5 seconds so a wedged holder cannot hang every future launch.
struct MigrationLock {
    _file: fs::File,
}

impl MigrationLock {
    fn lock_path() -> PathBuf {
        std::env::temp_dir().join("md-mini-rebrand-migration.lock")
    }

    fn acquire(log: &Logger) -> Option<Self> {
        let path = Self::lock_path();
        let file = match fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&path)
        {
            Ok(f) => f,
            Err(e) => {
                log(&format!(
                    "migration: could not open lock file {}: {} — proceeding unlocked",
                    path.display(),
                    e
                ));
                return None;
            }
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            // SAFETY: `file`'s fd is valid for this call and stays open for
            // as long as the returned guard (which owns `file`) is alive.
            let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if rc == 0 {
                return Some(Self { _file: file });
            }
            if Instant::now() >= deadline {
                log("migration: timed out waiting for the migration lock, proceeding unlocked");
                return None;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for MigrationLock {
    fn drop(&mut self) {
        // SAFETY: `_file`'s fd is still open — `Drop` runs before it closes.
        unsafe {
            libc::flock(self._file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

// ---------------------------------------------------------------------------
// Logging. `eprintln!` alone is invisible for a bundled `.app`. Every
// migration log line also goes to `~/Library/Logs/<product>/migration.log`
// (falling back to `eprintln!` only if the file itself can't be opened).
//
// NOT implemented here: surfacing a failure as an in-app toast — migration
// runs before any window/webview/frontend exists, so there is no toast
// channel available yet. The path to add one later: a `tauri::State`
// alongside `SessionState`/`UpdateState`, an IPC command the frontend polls
// once on mount (the pattern `updater::pending_update` already uses), and a
// new toast kind in `toasts.svelte.ts`. Frontend work with its own review
// surface, left for later.
// ---------------------------------------------------------------------------

fn log_path_under(home: &Path, product_name: &str) -> PathBuf {
    home.join("Library")
        .join("Logs")
        .join(crate::paths::dir_name(product_name))
        .join("migration.log")
}

fn now_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn append_log_line(path: &Path, msg: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "[{}] {}", now_epoch_secs(), msg)
}

// ---------------------------------------------------------------------------
// T2: the orchestration itself, dependency-injected via `MigrationEnv`.
// `orchestrate` and `run_migration_with_retry` are exercised directly by
// tests with `testing::MockEnv`. `migrate_all_real` is the thin, untested
// real-filesystem wrapper.
// ---------------------------------------------------------------------------

pub(crate) enum OrchestrateOutcome {
    /// Proceed normally. `moved`: this launch actually carried data across
    /// (either side came back [`MigrationOutcome::Migrated`]) — what the
    /// one-time rename letter keys off, so a fresh install never sees it.
    Done { moved: bool },
    /// The caller must `std::process::exit(0)` and start nothing.
    Abort,
}

/// Runs one migration (app-data or WebKit) to completion. On
/// [`MigrationOutcome::Failed`] shows `env.show_failure_dialog` (I2/I3) —
/// `Default` retries `migrate_dir` immediately, anything else (I4) aborts.
/// The lock is released before that dialog and re-acquired after (I5). A
/// `Decision::LegacyRunning` reaching this function is an internal-error
/// abort — `orchestrate`'s own loop is what is supposed to guarantee this
/// never happens (B1).
fn run_migration_with_retry(
    env: &impl MigrationEnv,
    old_new: Option<(&Path, &Path)>,
    decision: Option<Decision>,
    label: &str,
    strategy: Strategy,
) -> Result<MigrationOutcome, ()> {
    let (Some((old, new)), Some(decision)) = (old_new, decision) else {
        return Ok(MigrationOutcome::NoOp);
    };
    match decision {
        Decision::AlreadyDone | Decision::NothingToMigrate => Ok(MigrationOutcome::NoOp),
        Decision::NewAlreadyPopulated => {
            env.log(&format!(
                "migration: {label} — {} already has data, leaving {} in place",
                new.display(),
                old.display()
            ));
            Ok(MigrationOutcome::NoOp)
        }
        Decision::LegacyRunning => {
            env.log(&format!(
                "migration: internal error — {label} still LegacyRunning after resolution; refusing to proceed"
            ));
            Err(())
        }
        Decision::Migrate => loop {
            let log_fn = |m: &str| env.log(m);
            let outcome = migrate_dir(old, new, label, strategy, &log_fn);
            if outcome != MigrationOutcome::Failed {
                return Ok(outcome);
            }
            env.release_lock(); // I5
            let choice = env.show_failure_dialog(label);
            let retry = choice == DialogChoice::Default; // I4
            env.log(&format!(
                "migration: {label} migration failed; user chose to {}",
                if retry { "retry" } else { "quit" }
            ));
            if !retry {
                return Err(());
            }
            env.acquire_lock();
        },
    }
}

/// The full decision-and-retry flow: garbage-collects orphaned staging
/// directories, resolves any running legacy build (looping — B1 — until
/// neither side is `LegacyRunning` or the user abandons the launch), then
/// runs both migrations, each with its own Retry/Quit on failure (I2/I3).
/// `app_data`/`webkit` are `(old, new, legacy_identifier)` — `None` means
/// no matching `Rename` row for that side.
pub(crate) fn orchestrate(
    env: &impl MigrationEnv,
    app_data: Option<(&Path, &Path, &str)>,
    webkit: Option<(&Path, &Path, &str)>,
) -> OrchestrateOutcome {
    env.acquire_lock();
    if let Some((_, new, _)) = &app_data {
        gc_orphaned_staging(new, &|m| env.log(m));
    }
    if let Some((_, new, _)) = &webkit {
        gc_orphaned_staging(new, &|m| env.log(m));
    }

    let is_running = |id: &str| env.is_bundle_running(id);
    let mut app_data_decision = app_data.map(|(old, new, id)| decide_with(old, new, id, &is_running));
    let mut webkit_decision = webkit.map(|(old, new, id)| decide_with(old, new, id, &is_running));

    let mut retry_dialog = false;
    loop {
        let legacy_running =
            matches!(app_data_decision, Some(Decision::LegacyRunning)) || matches!(webkit_decision, Some(Decision::LegacyRunning));
        if !legacy_running {
            break;
        }
        let legacy_identifier = app_data
            .map(|(_, _, id)| id)
            .or_else(|| webkit.map(|(_, _, id)| id))
            .expect("a LegacyRunning decision implies at least one matching row");

        env.release_lock(); // I5: never hold the lock across a dialog
        let choice = env.show_legacy_dialog(retry_dialog);
        let proceed = match choice {
            DialogChoice::Default => {
                env.log("migration: asking the legacy build to quit");
                if env.terminate_and_wait(legacy_identifier) {
                    env.log("migration: legacy build quit");
                    true
                } else {
                    env.log("migration: legacy build did not quit within the wait window");
                    false
                }
            }
            DialogChoice::Alternate | DialogChoice::CancelOrTimeout => false, // I4
        };
        if !proceed {
            env.log("migration: abandoning this launch — the legacy build is still running");
            return OrchestrateOutcome::Abort;
        }
        retry_dialog = true;
        env.acquire_lock();
        // B1: re-evaluate BOTH sides before doing anything else, and loop
        // back to the top — if either is STILL `LegacyRunning` (it can
        // restart in this exact window), the dialog is shown again with
        // `retry_dialog = true`, never silently treated as resolved.
        if let Some((old, new, id)) = &app_data {
            app_data_decision = Some(decide_with(old, new, id, &is_running));
        }
        if let Some((old, new, id)) = &webkit {
            webkit_decision = Some(decide_with(old, new, id, &is_running));
        }
    }

    let app_data_outcome = match run_migration_with_retry(
        env,
        app_data.map(|(o, n, _)| (o, n)),
        app_data_decision,
        "app data directory",
        Strategy::PreferRename,
    ) {
        Ok(o) => o,
        Err(()) => {
            env.release_lock();
            return OrchestrateOutcome::Abort;
        }
    };
    let webkit_outcome = match run_migration_with_retry(
        env,
        webkit.map(|(o, n, _)| (o, n)),
        webkit_decision,
        "WebKit profile",
        Strategy::CopyOnly,
    ) {
        Ok(o) => o,
        Err(()) => {
            env.release_lock();
            return OrchestrateOutcome::Abort;
        }
    };
    let moved = app_data_outcome == MigrationOutcome::Migrated || webkit_outcome == MigrationOutcome::Migrated;

    env.release_lock();
    OrchestrateOutcome::Done { moved }
}

/// Real, top-level entry point. Called once from `run()` before
/// `tauri::Builder::default()...build()`. `std::process::exit(0)`s rather
/// than returning if [`orchestrate`] decides this launch must not proceed.
pub(crate) fn migrate_all_real(current_product_name: &str, current_identifier: &str) {
    refuse_debug_build_on_production_identity(current_product_name, current_identifier); // B3

    let product_rename = rename_for_product_name(current_product_name);
    let identifier_rename = rename_for_identifier(current_identifier);
    if product_rename.is_none() && identifier_rename.is_none() {
        return;
    }

    let app_data_paths: Option<(PathBuf, PathBuf, &'static str)> = match (product_rename, dirs::data_dir()) {
        (Some(r), Some(base)) => Some((
            base.join(r.from_product_name),
            base.join(crate::paths::dir_name(current_product_name)),
            r.from_identifier,
        )),
        (Some(_), None) => {
            eprintln!("migration: could not determine the application data directory, skipping");
            None
        }
        (None, _) => None,
    };
    let webkit_paths: Option<(PathBuf, PathBuf, &'static str)> = match (identifier_rename, dirs::home_dir()) {
        (Some(r), Some(home)) => {
            let base = home.join("Library").join("WebKit");
            Some((base.join(r.from_identifier), base.join(current_identifier), r.from_identifier))
        }
        (Some(_), None) => {
            eprintln!("migration: could not determine the home directory, skipping WebKit profile migration");
            None
        }
        (None, _) => None,
    };

    let env = RealEnv::new(current_product_name);
    let outcome = orchestrate(
        &env,
        app_data_paths.as_ref().map(|(o, n, id)| (o.as_path(), n.as_path(), *id)),
        webkit_paths.as_ref().map(|(o, n, id)| (o.as_path(), n.as_path(), *id)),
    );
    match outcome {
        OrchestrateOutcome::Abort => std::process::exit(0),
        OrchestrateOutcome::Done { moved: true } => {
            if let Some((_, new, _)) = &app_data_paths {
                write_rename_letter_flag(new, &|m| env.log(m));
            }
        }
        OrchestrateOutcome::Done { moved: false } => {}
    }
}

/// Leaves `onboarding::RENAME_LETTER_FLAG` in the NEW data directory for
/// `onboarding::maybe_show` to find once `setup` runs. A file rather than a
/// value handed back through `run()`: a crash between this launch's migration
/// and its first window must not lose the letter — the flag survives it, and
/// the next launch (where migration is already `AlreadyDone`) still shows it.
/// Best-effort: a failure costs the letter, never the launch.
fn write_rename_letter_flag(new_app_data: &Path, log: &Logger) {
    let flag = new_app_data.join(crate::onboarding::RENAME_LETTER_FLAG);
    if let Err(e) = fs::create_dir_all(new_app_data).and_then(|()| fs::write(&flag, "")) {
        log(&format!("migration: could not leave {}: {}", flag.display(), e));
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use std::cell::RefCell;

    type Hook = Box<dyn Fn()>;

    thread_local! {
        static BEFORE_FIRST_RENAME: RefCell<Option<Hook>> = const { RefCell::new(None) };
        static BEFORE_COMMIT: RefCell<Option<Hook>> = const { RefCell::new(None) };
        static FORCE_BUNDLE_RUNNING: RefCell<Option<bool>> = const { RefCell::new(None) };
    }

    pub(crate) fn run_before_first_rename_hook() {
        run(&BEFORE_FIRST_RENAME);
    }

    pub(crate) fn run_before_commit_hook() {
        run(&BEFORE_COMMIT);
    }

    fn run(cell: &'static std::thread::LocalKey<RefCell<Option<Hook>>>) {
        let hook = cell.with(|slot| slot.borrow_mut().take());
        if let Some(hook) = hook {
            hook();
            cell.with(|slot| *slot.borrow_mut() = Some(hook));
        }
    }

    #[must_use]
    pub(crate) struct HookGuard(&'static std::thread::LocalKey<RefCell<Option<Hook>>>);

    impl Drop for HookGuard {
        fn drop(&mut self) {
            self.0.with(|slot| *slot.borrow_mut() = None);
        }
    }

    pub(crate) fn before_first_rename<F: Fn() + 'static>(hook: F) -> HookGuard {
        BEFORE_FIRST_RENAME.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
        HookGuard(&BEFORE_FIRST_RENAME)
    }

    pub(crate) fn before_commit<F: Fn() + 'static>(hook: F) -> HookGuard {
        BEFORE_COMMIT.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
        HookGuard(&BEFORE_COMMIT)
    }

    pub(crate) fn forced_bundle_running() -> Option<bool> {
        FORCE_BUNDLE_RUNNING.with(|slot| *slot.borrow())
    }

    #[must_use]
    pub(crate) struct BundleRunningGuard;

    impl Drop for BundleRunningGuard {
        fn drop(&mut self) {
            FORCE_BUNDLE_RUNNING.with(|slot| *slot.borrow_mut() = None);
        }
    }

    pub(crate) fn force_bundle_running(value: bool) -> BundleRunningGuard {
        FORCE_BUNDLE_RUNNING.with(|slot| *slot.borrow_mut() = Some(value));
        BundleRunningGuard
    }

    // --- T2: a scriptable `MigrationEnv` for testing `orchestrate` directly ---

    use super::{DialogChoice, MigrationEnv};
    use std::cell::Cell;
    use std::collections::VecDeque;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum TerminateBehavior {
        /// `terminate_and_wait` returns `false`; the legacy build stays
        /// "running" no matter how many times this is tried.
        Fails,
        /// Returns `true`, and the legacy build is genuinely gone from then
        /// on.
        SucceedsAndStaysGone,
        /// Returns `true` for the termination attempt itself, but the
        /// legacy build is "running" again by the time anything re-checks —
        /// B1's exact scenario (an agent's `mdmini`/MCP `allow_launch`, or
        /// the user, relaunching it in that window).
        SucceedsButRelaunches,
    }

    pub(crate) struct MockEnv {
        pub(crate) is_running: Cell<bool>,
        pub(crate) terminate_behavior: Cell<TerminateBehavior>,
        pub(crate) legacy_dialog_choices: RefCell<VecDeque<DialogChoice>>,
        pub(crate) failure_dialog_choices: RefCell<VecDeque<DialogChoice>>,
        pub(crate) locked: Cell<bool>,
        pub(crate) dialog_called_while_locked: Cell<bool>,
        pub(crate) legacy_dialog_calls: Cell<u32>,
        pub(crate) failure_dialog_calls: Cell<u32>,
        pub(crate) terminate_calls: Cell<u32>,
        pub(crate) log_lines: RefCell<Vec<String>>,
    }

    impl MockEnv {
        pub(crate) fn new() -> Self {
            Self {
                is_running: Cell::new(false),
                terminate_behavior: Cell::new(TerminateBehavior::SucceedsAndStaysGone),
                legacy_dialog_choices: RefCell::new(VecDeque::new()),
                failure_dialog_choices: RefCell::new(VecDeque::new()),
                locked: Cell::new(false),
                dialog_called_while_locked: Cell::new(false),
                legacy_dialog_calls: Cell::new(0),
                failure_dialog_calls: Cell::new(0),
                terminate_calls: Cell::new(0),
                log_lines: RefCell::new(Vec::new()),
            }
        }
    }

    impl MigrationEnv for MockEnv {
        fn is_bundle_running(&self, _bundle_id: &str) -> bool {
            self.is_running.get()
        }

        fn acquire_lock(&self) {
            self.locked.set(true);
        }

        fn release_lock(&self) {
            self.locked.set(false);
        }

        fn show_legacy_dialog(&self, _retry: bool) -> DialogChoice {
            self.legacy_dialog_calls.set(self.legacy_dialog_calls.get() + 1);
            if self.locked.get() {
                self.dialog_called_while_locked.set(true);
            }
            self.legacy_dialog_choices.borrow_mut().pop_front().unwrap_or(DialogChoice::CancelOrTimeout)
        }

        fn show_failure_dialog(&self, _label: &str) -> DialogChoice {
            self.failure_dialog_calls.set(self.failure_dialog_calls.get() + 1);
            if self.locked.get() {
                self.dialog_called_while_locked.set(true);
            }
            self.failure_dialog_choices.borrow_mut().pop_front().unwrap_or(DialogChoice::CancelOrTimeout)
        }

        fn terminate_and_wait(&self, _bundle_id: &str) -> bool {
            self.terminate_calls.set(self.terminate_calls.get() + 1);
            match self.terminate_behavior.get() {
                TerminateBehavior::Fails => false,
                TerminateBehavior::SucceedsAndStaysGone => {
                    self.is_running.set(false);
                    true
                }
                TerminateBehavior::SucceedsButRelaunches => true, // `is_running` deliberately left true
            }
        }

        fn log(&self, msg: &str) {
            self.log_lines.borrow_mut().push(msg.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Mutex};

    fn collecting_logger() -> (Arc<Mutex<Vec<String>>>, Box<Logger<'static>>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&log);
        let logger: Box<Logger<'static>> = Box::new(move |msg: &str| {
            recorder.lock().unwrap().push(msg.to_string());
        });
        (log, logger)
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "md-mini-migtest-{}-{}-{}",
            tag,
            std::process::id(),
            STAGING_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn staging_leftovers(parent: &Path) -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir(parent) else {
            return Vec::new();
        };
        entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with('.') && n.contains(".migrating-"))
            })
            .collect()
    }

    /// Test-only equivalent of the deleted `migrate_app_data_dir`/
    /// `migrate_webkit_profile`: resolves a `Decision` for `(old, new)` via
    /// `evaluate` and acts on it exactly the way `migrate_all_real` does for
    /// the two outcomes that matter to these tests, WITHOUT any dialog (a
    /// `LegacyRunning` decision is returned as-is so a test can assert on it
    /// directly — the real dialog flow is not something `cargo test` can or
    /// should exercise).
    fn test_migrate(old: &Path, new: &Path, strategy: Strategy, legacy_identifier: &str, log: &Logger) -> Decision {
        let decision = evaluate(old, new, legacy_identifier);
        if decision == Decision::Migrate {
            migrate_dir(old, new, "test", strategy, log);
        }
        decision
    }

    // --- decide_migration: the pure core (N1, N2) -----------------------------

    #[test]
    fn marker_match_wins_over_a_running_legacy_instance() {
        // N2's exact regression: previously `is_bundle_running` was checked
        // BEFORE the marker, so an already-completed migration kept being
        // treated as "still needs to defer" for as long as the legacy build
        // happened to be open for any reason.
        assert_eq!(
            decide_migration(true, true, false, true),
            Decision::AlreadyDone,
            "a completed migration must stay done even while the legacy build runs"
        );
    }

    #[test]
    fn decide_migration_covers_every_branch() {
        assert_eq!(decide_migration(true, false, false, false), Decision::AlreadyDone);
        assert_eq!(decide_migration(false, false, false, false), Decision::NothingToMigrate);
        assert_eq!(decide_migration(false, true, true, false), Decision::NewAlreadyPopulated);
        assert_eq!(decide_migration(false, true, false, true), Decision::LegacyRunning);
        assert_eq!(decide_migration(false, true, false, false), Decision::Migrate);
        // `new_populated` wins over `legacy_running` too — never overwrite
        // existing data regardless of what else is going on.
        assert_eq!(decide_migration(false, true, true, true), Decision::NewAlreadyPopulated);
    }

    // --- exact from -> to matching, debug/release filtering (H4, M5, N5) -----

    #[test]
    fn no_op_when_current_name_matches_a_known_from_or_is_otherwise_unrenamed() {
        assert!(rename_for_product_name("md-mini").is_none());
        assert!(rename_for_product_name("md-mini-dev").is_none());
        assert!(rename_for_identifier("com.md-mini.app").is_none());
        assert!(rename_for_identifier("com.md-mini.dev").is_none());
    }

    #[test]
    #[cfg(debug_assertions)]
    // T1: this assertion is only true under `debug_assertions` — under
    // `cargo test --release` the release row IS reachable (correctly: a
    // release build legitimately needs it), so the test itself must not
    // even compile-in for that profile, or it fails there on purpose.
    fn n5_a_release_row_is_invisible_under_a_debug_build() {
        // `cargo test` is itself a `debug_assertions` build, so this is the
        // real regression check, not a simulation: without the `dev` filter,
        // `npm run tauri dev` (a debug build reading `tauri.conf.json`'s
        // PRODUCTION identity, per this repo's own `dev`-vs-`tauri dev`
        // distinction in `CLAUDE.md`) would be able to match the release row
        // and migrate the owner's real, installed `md-mini` data.
        assert!(
            rename_for_product_name("couplet").is_none(),
            "the release row must not be reachable from a debug build"
        );
        assert!(rename_for_identifier("pro.couplet.app").is_none());

        // The row still legitimately exists in the table (release builds DO
        // need it) — checked with the unfiltered matchers, independent of
        // which build is running the check.
        let raw = rename_matching_product_name(RENAMES, "couplet").expect("the row must still exist in RENAMES");
        assert_eq!(raw.from_product_name, "md-mini");
        assert!(!raw.dev);
        let raw_by_id =
            rename_matching_identifier(RENAMES, "pro.couplet.app").expect("the row must still exist by identifier too");
        assert_eq!(raw_by_id.from_identifier, "com.md-mini.app");
    }

    // --- B3: a debug build must never poison the production names --------

    #[test]
    fn production_identity_row_matches_only_the_dev_false_row() {
        assert!(production_identity_row("couplet", "pro.couplet.app").is_some());
        assert!(production_identity_row("couplet-dev", "pro.couplet.dev").is_none(), "the dev row must not trigger this");
        assert!(production_identity_row("something-else", "com.something.else").is_none());
    }

    #[test]
    fn b3_flags_risk_when_real_legacy_data_exists_and_is_unmigrated() {
        let dir = scratch("b3-risk");
        let app_data_base = dir.join("AppSupport");
        let webkit_base = dir.join("WebKit");
        write(&app_data_base.join("md-mini").join("session.json"), "real data");
        let row = production_identity_row("couplet", "pro.couplet.app").unwrap();

        assert!(debug_run_risks_real_data(&app_data_base, &webkit_base, row, "couplet", "pro.couplet.app"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn b3_no_risk_when_nothing_legacy_exists() {
        let dir = scratch("b3-norisk");
        let app_data_base = dir.join("AppSupport");
        let webkit_base = dir.join("WebKit");
        let row = production_identity_row("couplet", "pro.couplet.app").unwrap();

        assert!(!debug_run_risks_real_data(&app_data_base, &webkit_base, row, "couplet", "pro.couplet.app"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn b3_no_risk_once_already_migrated() {
        let dir = scratch("b3-migrated");
        let app_data_base = dir.join("AppSupport");
        let webkit_base = dir.join("WebKit");
        let old = app_data_base.join("md-mini");
        let new = app_data_base.join("couplet");
        write(&old.join(MOVED_MARKER), new.to_str().unwrap());
        let row = production_identity_row("couplet", "pro.couplet.app").unwrap();

        assert!(!debug_run_risks_real_data(&app_data_base, &webkit_base, row, "couplet", "pro.couplet.app"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn finds_the_dev_rename() {
        let rename = rename_for_product_name("couplet-dev").expect("should find the md-mini-dev row");
        assert_eq!(rename.from_product_name, "md-mini-dev");
        assert_eq!(rename.from_identifier, "com.md-mini.dev");
        assert!(rename.dev);

        let by_id = rename_for_identifier("pro.couplet.dev").expect("should find it by identifier too");
        assert_eq!(by_id.from_identifier, "com.md-mini.dev");
    }

    #[test]
    fn an_unrecognised_name_migrates_nothing_however_dev_flavoured_it_looks() {
        assert!(rename_for_product_name("couplet-dev-beta").is_none());
        assert!(rename_for_product_name("md-mini-test").is_none());
        assert!(rename_for_identifier("com.md-mini.migrationtest").is_none());
    }

    #[test]
    fn matches_the_immediate_predecessor_across_three_generations() {
        // M5: a hypothetical third generation (`couplet-dev` -> `X-dev`)
        // must not get confused with the two-generations-back row. Uses
        // `dev: true` throughout so this test's premise (finding the right
        // row) is independent of the separate N5 debug/release concern.
        let chain = [
            Rename {
                from_product_name: "md-mini-dev",
                to_product_name: "couplet-dev",
                from_identifier: "com.md-mini.dev",
                to_identifier: "pro.couplet.dev",
                dev: true,
            },
            Rename {
                from_product_name: "couplet-dev",
                to_product_name: "X-dev",
                from_identifier: "pro.couplet.dev",
                to_identifier: "com.x.dev",
                dev: true,
            },
        ];

        let hop1 = rename_matching_product_name(&chain, "couplet-dev").expect("first hop");
        assert_eq!(hop1.from_product_name, "md-mini-dev");

        let hop2 = rename_matching_product_name(&chain, "X-dev").expect("second hop");
        assert_eq!(hop2.from_product_name, "couplet-dev");
        assert_ne!(hop2.from_product_name, "md-mini-dev", "must not skip straight to the oldest generation");

        // Same walk, by identifier — the two lookups are independent
        // functions and both need the same one-hop-at-a-time guarantee.
        let hop2_by_id = rename_matching_identifier(&chain, "com.x.dev").expect("second hop by identifier");
        assert_eq!(hop2_by_id.from_identifier, "pro.couplet.dev");
    }

    // --- evaluate + migrate_dir on real tempdirs ------------------------------
    //
    // These all use the DEV row (`couplet-dev` / `pro.couplet.dev`) as the
    // target name: `cargo test` is a debug build, and N5 makes the release
    // row (`couplet` / `pro.couplet.app`) unreachable from one on purpose —
    // see `n5_a_release_row_is_invisible_under_a_debug_build`.

    #[test]
    fn evaluate_reports_nothing_to_migrate_when_old_never_existed() {
        // A fresh install under the new name: `old` was never created, so
        // there is nothing to migrate and nothing should be touched.
        let dir = scratch("nothing-to-migrate");
        let old = dir.join("md-mini-dev");
        let new = dir.join("couplet-dev");
        let guard = testing::force_bundle_running(false);

        let decision = evaluate(&old, &new, "com.md-mini.dev");
        drop(guard);

        assert_eq!(decision, Decision::NothingToMigrate);
        assert!(!new.exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn moves_into_an_empty_new_directory() {
        let dir = scratch("move");
        let old = dir.join("md-mini-dev");
        let new = dir.join("couplet-dev");
        write(&old.join("session.json"), "{\"windows\":[]}");
        write(&old.join("recovery").join("draft.md"), "unsaved work");
        let guard = testing::force_bundle_running(false);

        let (_log, logger) = collecting_logger();
        let decision = test_migrate(&old, &new, Strategy::PreferRename, "com.md-mini.dev", &logger);
        drop(guard);

        assert_eq!(decision, Decision::Migrate);
        assert_eq!(fs::read_to_string(new.join("session.json")).unwrap(), "{\"windows\":[]}");
        assert_eq!(fs::read_to_string(new.join("recovery").join("draft.md")).unwrap(), "unsaved work");
        assert!(old.join(MOVED_MARKER).exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn never_overwrites_a_non_empty_new_directory() {
        let dir = scratch("nooverwrite");
        let old = dir.join("md-mini-dev");
        let new = dir.join("couplet-dev");
        write(&old.join("session.json"), "old unsaved work");
        write(&new.join("session.json"), "already has real data");
        let guard = testing::force_bundle_running(false);

        let (log, logger) = collecting_logger();
        let decision = test_migrate(&old, &new, Strategy::PreferRename, "com.md-mini.dev", &logger);
        drop(guard);

        assert_eq!(decision, Decision::NewAlreadyPopulated);
        assert_eq!(fs::read_to_string(new.join("session.json")).unwrap(), "already has real data");
        assert_eq!(fs::read_to_string(old.join("session.json")).unwrap(), "old unsaved work");
        assert!(!old.join(MOVED_MARKER).exists());
        let _ = log;
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn is_idempotent() {
        let dir = scratch("idempotent");
        let old = dir.join("md-mini-dev");
        let new = dir.join("couplet-dev");
        write(&old.join("session.json"), "{}");
        let guard = testing::force_bundle_running(false);

        let (_l1, logger1) = collecting_logger();
        assert_eq!(test_migrate(&old, &new, Strategy::PreferRename, "com.md-mini.dev", &logger1), Decision::Migrate);
        let after_first = fs::read_to_string(new.join("session.json")).unwrap();

        let (_l2, logger2) = collecting_logger();
        assert_eq!(
            test_migrate(&old, &new, Strategy::PreferRename, "com.md-mini.dev", &logger2),
            Decision::AlreadyDone
        );
        drop(guard);

        assert_eq!(fs::read_to_string(new.join("session.json")).unwrap(), after_first);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_marker_pointing_at_a_different_destination_is_not_treated_as_done() {
        let dir = scratch("marker-elsewhere");
        let old = dir.join("md-mini-dev");
        write(
            &old.join(MOVED_MARKER),
            &format!("{}\n\nstale, from an earlier generation", dir.join("somewhere-else").display()),
        );
        write(&old.join("session.json"), "real data still here");
        let new = dir.join("couplet-dev");
        let guard = testing::force_bundle_running(false);

        let (_log, logger) = collecting_logger();
        let decision = test_migrate(&old, &new, Strategy::CopyOnly, "com.md-mini.dev", &logger);
        drop(guard);

        assert_eq!(decision, Decision::Migrate, "a stale marker must not block a real migration");
        assert_eq!(fs::read_to_string(new.join("session.json")).unwrap(), "real data still here");
        fs::remove_dir_all(&dir).ok();
    }

    // --- N1/N2: legacy running --------------------------------------------

    #[test]
    fn evaluate_reports_legacy_running_without_touching_anything() {
        let dir = scratch("legacy-running");
        let old = dir.join("md-mini-dev");
        let new = dir.join("couplet-dev");
        write(&old.join("session.json"), "live, being written right now");
        let guard = testing::force_bundle_running(true);

        let decision = evaluate(&old, &new, "com.md-mini.dev");
        drop(guard);

        assert_eq!(decision, Decision::LegacyRunning);
        assert!(!new.exists(), "must not touch new while old is live");
        assert!(old.join("session.json").exists(), "must not touch old while the legacy build owns it");
        assert!(!old.join(MOVED_MARKER).exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migrates_normally_once_the_legacy_build_is_not_running() {
        let dir = scratch("not-running");
        let old = dir.join("md-mini-dev");
        let new = dir.join("couplet-dev");
        write(&old.join("session.json"), "{}");
        let guard = testing::force_bundle_running(false);

        let decision = evaluate(&old, &new, "com.md-mini.dev");
        drop(guard);

        assert_eq!(decision, Decision::Migrate);
        fs::remove_dir_all(&dir).ok();
    }

    // --- C1: staged-copy race safety, unchanged mechanics ----------------

    #[test]
    fn falls_back_to_a_staged_copy_on_a_genuine_rename_failure() {
        let dir = scratch("rename-eacces");
        let old_parent = dir.join("old_parent");
        let old = old_parent.join("md-mini-dev");
        write(&old.join("session.json"), "precious data");
        let new = dir.join("new_parent").join("couplet-dev");

        fs::set_permissions(&old_parent, fs::Permissions::from_mode(0o555)).unwrap();

        let (log, logger) = collecting_logger();
        let outcome = migrate_dir(&old, &new, "test", Strategy::PreferRename, &logger);

        fs::set_permissions(&old_parent, fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(outcome, MigrationOutcome::Migrated);
        assert_eq!(fs::read_to_string(new.join("session.json")).unwrap(), "precious data");
        assert!(old.join("session.json").exists(), "copy fallback must not remove the source");
        assert!(old.join(MOVED_MARKER).exists());
        assert!(log.lock().unwrap().iter().any(|m| m.contains("falling back to a staged copy")));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_partial_copy_failure_leaves_no_staging_directory_and_no_marker() {
        let dir = scratch("partial-copy");
        let old = dir.join("com.md-mini.dev");
        write(&old.join("a.txt"), "copies fine");
        write(&old.join("b.txt"), "never gets read");
        fs::set_permissions(&old.join("b.txt"), fs::Permissions::from_mode(0o000)).unwrap();
        let new = dir.join("pro.couplet.dev");

        let (log, logger) = collecting_logger();
        let outcome = migrate_dir(&old, &new, "test", Strategy::CopyOnly, &logger);

        if outcome == MigrationOutcome::Migrated {
            eprintln!("skipping strict assertions: this process can read 0o000 files (likely running as root)");
            fs::remove_dir_all(&dir).ok();
            return;
        }

        assert_eq!(outcome, MigrationOutcome::Failed);
        assert!(!new.exists());
        assert!(old.join("a.txt").exists());
        assert!(!old.join(MOVED_MARKER).exists());
        assert!(staging_leftovers(&dir).is_empty());
        assert!(log.lock().unwrap().iter().any(|m| m.contains("copy failed")));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_source_vanishing_right_before_the_first_rename_is_a_no_op_not_a_copy() {
        let dir = scratch("enoent-recheck");
        let old = dir.join("md-mini-dev");
        write(&old.join("session.json"), "will be gone by the time we rename");
        let new = dir.join("couplet-dev");
        let new_for_hook = new.clone();
        let old_for_hook = old.clone();

        let guard = testing::before_first_rename(move || {
            fs::remove_dir_all(&old_for_hook).unwrap();
            fs::create_dir_all(&new_for_hook).unwrap();
            fs::write(new_for_hook.join("session.json"), "the real, already-migrated data").unwrap();
        });

        let (log, logger) = collecting_logger();
        let outcome = migrate_dir(&old, &new, "test", Strategy::PreferRename, &logger);
        drop(guard);

        assert_eq!(outcome, MigrationOutcome::NoOp);
        assert_eq!(fs::read_to_string(new.join("session.json")).unwrap(), "the real, already-migrated data");
        assert!(log.lock().unwrap().iter().any(|m| m.contains("vanished")));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn concurrent_migration_that_commits_first_wins_and_this_attempt_backs_off() {
        let dir = scratch("race");
        let old = dir.join("com.md-mini.dev");
        write(&old.join("f.txt"), "the real data");
        let new = dir.join("pro.couplet.dev");
        let new_for_hook = new.clone();

        let guard = testing::before_commit(move || {
            fs::create_dir_all(&new_for_hook).unwrap();
            fs::write(new_for_hook.join("f.txt"), "the real data").unwrap();
        });

        let (_log, logger) = collecting_logger();
        let outcome = migrate_dir(&old, &new, "test", Strategy::CopyOnly, &logger);
        drop(guard);

        assert_eq!(outcome, MigrationOutcome::NoOp);
        assert_eq!(fs::read_to_string(new.join("f.txt")).unwrap(), "the real data");
        assert!(staging_leftovers(&dir).is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    // --- WebKit-shaped fixtures, real pro.couplet.dev identifier ----------

    #[test]
    fn webkit_profile_copies_and_leaves_the_old_profile_intact() {
        let dir = scratch("wk-copy");
        let ls_dir = dir
            .join("com.md-mini.dev")
            .join("WebsiteData")
            .join("Default")
            .join("h1")
            .join("h1")
            .join("LocalStorage");
        write(&ls_dir.join("localstorage.sqlite3"), "sqlite-bytes");
        let new = dir.join("pro.couplet.dev");
        let guard = testing::force_bundle_running(false);

        let (_log, logger) = collecting_logger();
        let decision = test_migrate(&dir.join("com.md-mini.dev"), &new, Strategy::CopyOnly, "com.md-mini.dev", &logger);
        drop(guard);

        assert_eq!(decision, Decision::Migrate);
        let new_ls = new
            .join("WebsiteData")
            .join("Default")
            .join("h1")
            .join("h1")
            .join("LocalStorage")
            .join("localstorage.sqlite3");
        assert_eq!(fs::read_to_string(&new_ls).unwrap(), "sqlite-bytes");
        assert!(ls_dir.join("localstorage.sqlite3").exists(), "CopyOnly must never touch the source");
        assert!(dir.join("com.md-mini.dev").join(MOVED_MARKER).exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn webkit_profile_copy_keeps_salt_paired_with_its_hash_directory() {
        let dir = scratch("wk-salt");
        let default_dir = dir.join("com.md-mini.dev").join("WebsiteData").join("Default");
        write(&default_dir.join("salt"), "the-real-salt-bytes");
        write(
            &default_dir
                .join("XJT9IvBEje24OTnR7aXObEjmm8tb4_4zZvFzi5jl05w")
                .join("XJT9IvBEje24OTnR7aXObEjmm8tb4_4zZvFzi5jl05w")
                .join("LocalStorage")
                .join("localstorage.sqlite3"),
            "the-real-localstorage-bytes",
        );
        let new = dir.join("pro.couplet.dev");
        let guard = testing::force_bundle_running(false);

        let (_log, logger) = collecting_logger();
        test_migrate(&dir.join("com.md-mini.dev"), &new, Strategy::CopyOnly, "com.md-mini.dev", &logger);
        drop(guard);

        let new_default = new.join("WebsiteData").join("Default");
        assert_eq!(fs::read_to_string(new_default.join("salt")).unwrap(), "the-real-salt-bytes");
        assert_eq!(
            fs::read_to_string(
                new_default
                    .join("XJT9IvBEje24OTnR7aXObEjmm8tb4_4zZvFzi5jl05w")
                    .join("XJT9IvBEje24OTnR7aXObEjmm8tb4_4zZvFzi5jl05w")
                    .join("LocalStorage")
                    .join("localstorage.sqlite3")
            )
            .unwrap(),
            "the-real-localstorage-bytes"
        );
        fs::remove_dir_all(&dir).ok();
    }

    // --- no sweep: a deleted file in `new` must never come back -----------

    #[test]
    fn nothing_repopulates_a_file_the_new_side_deliberately_deleted() {
        // There is no sweep any more (removed per this PR): once migration
        // is done, whatever a legacy relaunch writes into `old` stays in
        // `old` — see the module doc comment for why that trade-off was
        // made (starting on a shared directory was the worse bug).
        let dir = scratch("no-sweep");
        let old = dir.join("md-mini-dev");
        let new = dir.join("couplet-dev");
        write(&old.join("session.json"), "{}");
        let guard = testing::force_bundle_running(false);

        let (_log, logger) = collecting_logger();
        assert_eq!(test_migrate(&old, &new, Strategy::PreferRename, "com.md-mini.dev", &logger), Decision::Migrate);

        // The new side deliberately removes a file that came across.
        fs::remove_file(new.join("session.json")).unwrap();
        // A legacy relaunch (hypothetically) writes a fresh one into `old`,
        // which by now holds only the marker.
        write(&old.join("session.json"), "written by a relaunched legacy build");

        let decision = test_migrate(&old, &new, Strategy::PreferRename, "com.md-mini.dev", &logger);
        drop(guard);

        assert_eq!(decision, Decision::AlreadyDone, "no re-migration once the marker matches");
        assert!(
            !new.join("session.json").exists(),
            "nothing should have repopulated the file `new` deleted — there is no sweep"
        );
        fs::remove_dir_all(&dir).ok();
    }

    // --- N6: directory permission ordering ---------------------------------

    #[test]
    fn a_readonly_source_directory_does_not_break_the_copy() {
        // N6: setting `new`'s directory mode to match a `0555` (read+execute,
        // no write) source BEFORE copying its children in would make `new`
        // unwritable while this function still needed to create files inside
        // it. The fix copies the mode AFTER all children are in place.
        let dir = scratch("readonly-src-dir");
        let old = dir.join("com.md-mini.dev");
        write(&old.join("recovery").join("draft.md"), "unsaved");
        fs::set_permissions(&old.join("recovery"), fs::Permissions::from_mode(0o555)).unwrap();
        let new = dir.join("pro.couplet.dev");

        let (log, logger) = collecting_logger();
        let outcome = migrate_dir(&old, &new, "test", Strategy::CopyOnly, &logger);

        fs::set_permissions(&old.join("recovery"), fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(outcome, MigrationOutcome::Migrated, "a 0555 source subdirectory must not break the copy: {:?}", log.lock().unwrap());
        assert_eq!(fs::read_to_string(new.join("recovery").join("draft.md")).unwrap(), "unsaved");
        let mode = fs::metadata(new.join("recovery")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o555, "the mode should still end up copied, just not until after the children are in place");
        // T4: `new`'s copy of `recovery/` is ALSO 0o555 at this point — left
        // as-is, `remove_dir_all` cannot delete `draft.md` inside it (no
        // write bit) and `.ok()` would otherwise hide that, leaking a
        // stubborn 0o555 directory in `/tmp` across every test run.
        fs::set_permissions(&new.join("recovery"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn copy_skips_sockets_and_fifos_instead_of_failing_the_whole_migration() {
        let dir = scratch("special-files");
        let old = dir.join("md-mini-dev");
        write(&old.join("normal.txt"), "regular file");
        let fifo_path = old.join("weird.fifo");
        let fifo_c = std::ffi::CString::new(fifo_path.to_str().unwrap()).unwrap();
        let rc = unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) };
        assert_eq!(rc, 0, "test setup: could not create a FIFO to migrate around");
        let new = dir.join("couplet-dev");

        let (log, logger) = collecting_logger();
        let outcome = migrate_dir(&old, &new, "test", Strategy::CopyOnly, &logger);

        assert_eq!(outcome, MigrationOutcome::Migrated);
        assert_eq!(fs::read_to_string(new.join("normal.txt")).unwrap(), "regular file");
        assert!(!new.join("weird.fifo").exists());
        assert!(log.lock().unwrap().iter().any(|m| m.contains("skipping non-regular file")));
        fs::remove_dir_all(&dir).ok();
    }

    // --- N9: orphaned staging GC --------------------------------------------

    #[test]
    fn gc_removes_a_staging_directory_whose_pid_is_dead() {
        let dir = scratch("gc-dead");
        let new = dir.join("couplet-dev");
        let dead_pid = 999_999; // astronomically unlikely to be a live pid
        let orphan = dir.join(format!(".couplet-dev.migrating-{dead_pid}-0"));
        write(&orphan.join("partial.txt"), "leftover");

        let (_log, logger) = collecting_logger();
        gc_orphaned_staging(&new, &logger);

        assert!(!orphan.exists(), "an orphan from a dead pid must be removed");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gc_leaves_a_staging_directory_whose_pid_is_alive() {
        let dir = scratch("gc-alive");
        let new = dir.join("couplet-dev");
        let my_pid = std::process::id();
        let live = dir.join(format!(".couplet-dev.migrating-{my_pid}-0"));
        write(&live.join("still-copying.txt"), "in progress");

        let (_log, logger) = collecting_logger();
        gc_orphaned_staging(&new, &logger);

        assert!(live.exists(), "a staging dir whose pid is still alive (this test process) must survive");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gc_ignores_entries_that_do_not_look_like_staging_directories() {
        let dir = scratch("gc-unrelated");
        let new = dir.join("couplet-dev");
        write(&dir.join("not-a-staging-dir").join("file.txt"), "unrelated");

        let (_log, logger) = collecting_logger();
        gc_orphaned_staging(&new, &logger);

        assert!(dir.join("not-a-staging-dir").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gc_does_not_touch_an_unrelated_apps_directory_that_merely_contains_migrating() {
        // I1: an earlier version matched any name CONTAINING ".migrating-"
        // anywhere in the whole (shared!) parent directory
        // (`~/Library/Application Support/`, `~/Library/WebKit/`) — this
        // could in principle `remove_dir_all` some OTHER application's own
        // directory. The exact prefix, tied to THIS `new`'s own name, must
        // reject anything that merely superficially resembles the pattern.
        let dir = scratch("gc-unrelated-app");
        let new = dir.join("couplet-dev"); // our own `new`, unrelated name
        let other_app = dir.join(".other-app.migrating-999999-0");
        write(&other_app.join("their-file.txt"), "not ours");

        let (_log, logger) = collecting_logger();
        gc_orphaned_staging(&new, &logger);

        assert!(
            other_app.exists(),
            "an unrelated app's directory must survive even though it superficially resembles our naming pattern"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gc_never_follows_a_symlink_even_with_a_dead_pid_in_its_name() {
        // I1: `symlink_metadata` (never following the final component) is
        // what makes this safe regardless of what `fs::remove_dir_all`
        // itself would do with a symlink — a symlink is rejected before
        // `remove_dir_all` is ever called on it.
        let dir = scratch("gc-symlink");
        let new = dir.join("couplet-dev");
        let real_target = dir.join("precious-real-directory");
        fs::create_dir_all(&real_target).unwrap();
        write(&real_target.join("keepme.txt"), "important");
        let fake_staging = dir.join(".couplet-dev.migrating-999999-0"); // dead pid
        std::os::unix::fs::symlink(&real_target, &fake_staging).unwrap();

        let (_log, logger) = collecting_logger();
        gc_orphaned_staging(&new, &logger);

        assert!(fake_staging.exists(), "the symlink itself must be left alone");
        assert!(real_target.join("keepme.txt").exists(), "must never follow the symlink to its real target");
        fs::remove_dir_all(&dir).ok();
    }

    // --- M6: file logging ---------------------------------------------------

    #[test]
    fn log_path_follows_the_apple_logs_convention_named_after_the_product() {
        let home = PathBuf::from("/Users/someone");
        assert_eq!(log_path_under(&home, "couplet"), PathBuf::from("/Users/someone/Library/Logs/couplet/migration.log"));
        assert_eq!(log_path_under(&home, "../escape"), PathBuf::from("/Users/someone/Library/Logs/couplet/migration.log"));
    }

    #[test]
    fn append_log_line_creates_parent_directories_and_appends() {
        let dir = scratch("log-append");
        let path = dir.join("Logs").join("couplet").join("migration.log");

        append_log_line(&path, "first line").unwrap();
        append_log_line(&path, "second line").unwrap();

        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("first line"));
        assert!(content.contains("second line"));
        assert!(content.lines().next().unwrap().starts_with('['));
        fs::remove_dir_all(&dir).ok();
    }

    // --- real macOS smoke tests, not run by default -------------------------

    #[test]
    #[ignore = "hits real NSRunningApplication state on this machine; run manually"]
    fn is_bundle_running_real_matches_a_real_process() {
        assert!(is_bundle_running_real("com.apple.finder"), "Finder should always be running on macOS");
        assert!(!is_bundle_running_real("com.md-mini.this-bundle-id-does-not-exist"));
    }

    // --- T2: orchestrate, dependency-injected via MigrationEnv --------------

    #[test]
    fn terminate_that_never_succeeds_eventually_aborts() {
        // The legacy build simply never quits (`terminate_and_wait` always
        // returns `false`) — distinct from the relaunch scenario below: here
        // termination itself never succeeds even once.
        let dir = scratch("t2-terminate-fails");
        let old = dir.join("md-mini-dev");
        let new = dir.join("couplet-dev");
        write(&old.join("session.json"), "real data");

        let env = testing::MockEnv::new();
        env.is_running.set(true);
        env.terminate_behavior.set(testing::TerminateBehavior::Fails);
        env.legacy_dialog_choices.borrow_mut().push_back(DialogChoice::Default);

        let outcome = orchestrate(&env, Some((&old, &new, "com.md-mini.dev")), None);

        assert!(matches!(outcome, OrchestrateOutcome::Abort));
        assert!(!new.exists());
        assert_eq!(env.terminate_calls.get(), 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn legacy_running_after_resolve_never_starts_on_new() {
        // B1: the legacy build "quits" (terminate_and_wait succeeds) but is
        // running again by the time anything re-checks — the loop must show
        // the dialog AGAIN (this time with `retry = true`) rather than
        // proceeding as if it were gone, and eventually abandon rather than
        // ever create `new`.
        let dir = scratch("t2-b1");
        let old = dir.join("md-mini-dev");
        let new = dir.join("couplet-dev");
        write(&old.join("session.json"), "real data");

        let env = testing::MockEnv::new();
        env.is_running.set(true);
        env.terminate_behavior.set(testing::TerminateBehavior::SucceedsButRelaunches);
        env.legacy_dialog_choices.borrow_mut().extend([DialogChoice::Default, DialogChoice::CancelOrTimeout]);

        let outcome = orchestrate(&env, Some((&old, &new, "com.md-mini.dev")), None);

        assert!(matches!(outcome, OrchestrateOutcome::Abort));
        assert!(!new.exists(), "must never start on `new` while any resolution attempt leaves the legacy build running");
        assert_eq!(env.legacy_dialog_calls.get(), 2, "must have looped back and shown the dialog again");
        assert!(!env.locked.get(), "must not exit still holding the lock");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn legacy_dialog_default_button_migrates_once_it_actually_quits() {
        let dir = scratch("t2-b1-success");
        let old = dir.join("md-mini-dev");
        let new = dir.join("couplet-dev");
        write(&old.join("session.json"), "real data");

        let env = testing::MockEnv::new();
        env.is_running.set(true);
        env.terminate_behavior.set(testing::TerminateBehavior::SucceedsAndStaysGone);
        env.legacy_dialog_choices.borrow_mut().push_back(DialogChoice::Default);

        let outcome = orchestrate(&env, Some((&old, &new, "com.md-mini.dev")), None);

        assert!(matches!(outcome, OrchestrateOutcome::Done { moved: true }));
        assert_eq!(fs::read_to_string(new.join("session.json")).unwrap(), "real data");
        assert_eq!(env.legacy_dialog_calls.get(), 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn only_a_launch_that_moved_data_reports_it() {
        // The rename letter keys off `moved`: a fresh install (nothing to
        // migrate) and an already-migrated one must both stay silent, and
        // only the launch that actually carried data across says so.
        let dir = scratch("t2-moved");
        let old = dir.join("md-mini-dev");
        let new = dir.join("couplet-dev");
        let env = testing::MockEnv::new();

        let fresh = orchestrate(&env, Some((&old, &new, "com.md-mini.dev")), None);
        assert!(matches!(fresh, OrchestrateOutcome::Done { moved: false }));

        write(&old.join("session.json"), "real data");
        let first = orchestrate(&env, Some((&old, &new, "com.md-mini.dev")), None);
        assert!(matches!(first, OrchestrateOutcome::Done { moved: true }));

        let again = orchestrate(&env, Some((&old, &new, "com.md-mini.dev")), None);
        assert!(matches!(again, OrchestrateOutcome::Done { moved: false }));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_rename_letter_flag_lands_in_the_new_directory() {
        let dir = scratch("letter-flag");
        let new = dir.join("couplet-dev");
        let (_lines, log) = collecting_logger();
        write_rename_letter_flag(&new, &*log);
        assert!(new.join(crate::onboarding::RENAME_LETTER_FLAG).exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unrecognised_dialog_response_means_quit() {
        // I4: `CancelOrTimeout` on the VERY FIRST dialog call must abandon
        // immediately — never call `terminate_and_wait`, never create `new`.
        let dir = scratch("t2-i4");
        let old = dir.join("md-mini-dev");
        let new = dir.join("couplet-dev");
        write(&old.join("session.json"), "real data");

        let env = testing::MockEnv::new();
        env.is_running.set(true);
        env.legacy_dialog_choices.borrow_mut().push_back(DialogChoice::CancelOrTimeout);

        let outcome = orchestrate(&env, Some((&old, &new, "com.md-mini.dev")), None);

        assert!(matches!(outcome, OrchestrateOutcome::Abort));
        assert!(!new.exists());
        assert_eq!(env.terminate_calls.get(), 0, "an unrecognised response must never be read as \"quit md-mini\"");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn failed_migration_retries_then_quits_on_an_unrecognised_response() {
        // I2/I3: a genuine, PERSISTENT copy failure (chmod 000 on a file
        // inside `old`, real filesystem) — Retry re-attempts `migrate_dir`
        // (observable as repeated failure-dialog calls, since the failure
        // never actually clears), and the final unrecognised response
        // aborts rather than silently falling back to any directory.
        let dir = scratch("t2-i2i3");
        let old = dir.join("com.md-mini.dev");
        write(&old.join("a.txt"), "copies fine");
        write(&old.join("b.txt"), "never gets read");
        fs::set_permissions(&old.join("b.txt"), fs::Permissions::from_mode(0o000)).unwrap();
        let new = dir.join("pro.couplet.dev");

        let env = testing::MockEnv::new();
        env.is_running.set(false);
        env.failure_dialog_choices
            .borrow_mut()
            .extend([DialogChoice::Default, DialogChoice::Default, DialogChoice::CancelOrTimeout]);

        let outcome = orchestrate(&env, None, Some((&old, &new, "com.md-mini.dev")));

        if env.failure_dialog_calls.get() == 0 {
            eprintln!("skipping strict assertions: this process can read 0o000 files (likely running as root)");
            fs::remove_dir_all(&dir).ok();
            return;
        }

        assert!(matches!(outcome, OrchestrateOutcome::Abort));
        assert!(!new.exists());
        assert_eq!(env.failure_dialog_calls.get(), 3, "two retries, then the unrecognised response that finally aborts");
        assert!(!env.locked.get(), "must not exit still holding the lock");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn dialogs_are_never_shown_while_the_lock_is_held() {
        // I5, directly: `MockEnv::show_legacy_dialog`/`show_failure_dialog`
        // record whether `locked` was true at the moment they were called —
        // covers both the legacy-running loop and the failure-retry loop in
        // one run.
        let dir = scratch("t2-i5");
        let old_app = dir.join("md-mini-dev");
        write(&old_app.join("session.json"), "real data");
        let new_app = dir.join("couplet-dev");

        let old_wk = dir.join("com.md-mini.dev");
        write(&old_wk.join("secret.txt"), "never gets read");
        fs::set_permissions(&old_wk.join("secret.txt"), fs::Permissions::from_mode(0o000)).unwrap();
        let new_wk = dir.join("pro.couplet.dev");

        let env = testing::MockEnv::new();
        env.is_running.set(true);
        env.terminate_behavior.set(testing::TerminateBehavior::SucceedsAndStaysGone);
        env.legacy_dialog_choices.borrow_mut().push_back(DialogChoice::Default);
        env.failure_dialog_choices.borrow_mut().push_back(DialogChoice::CancelOrTimeout);

        let _ = orchestrate(
            &env,
            Some((&old_app, &new_app, "com.md-mini.dev")),
            Some((&old_wk, &new_wk, "com.md-mini.dev")),
        );

        if env.failure_dialog_calls.get() == 0 {
            eprintln!("skipping strict assertion: this process can read 0o000 files (likely running as root)");
        } else {
            assert!(!env.dialog_called_while_locked.get(), "a dialog must never be shown while the lock is held");
        }
        fs::remove_dir_all(&dir).ok();
    }
}
