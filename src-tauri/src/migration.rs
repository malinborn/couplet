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
//! ## Resolving a running legacy build (N1, replaces the old "run on
//! legacy name" fallback)
//!
//! When [`Decision::LegacyRunning`] comes back, this process is not allowed
//! to start on ANY data directory while that decision stands — not the new
//! one (nothing has been migrated into it), and not the old one (that would
//! be the exact two-processes-one-directory bug this section opened with).
//! Instead, [`migrate_all_real`] blocks with a native `NSAlert`, before
//! `Builder::build()` — before any Tauri window exists — offering to
//! terminate the legacy build (`NSRunningApplication.terminate`, the same
//! "please quit" request Cmd+Q sends; never `forceTerminate`) and wait up to
//! 10 seconds, or to abandon this launch (`std::process::exit(0)`) instead.
//! If termination does not complete in time, the dialog is shown again
//! rather than proceeding on an assumption. This app is macOS-only, and
//! `NSAlert.runModal` and `NSApplication.sharedApplication` both work
//! without the full `NSApplicationMain`/event-loop machinery Tauri sets up
//! later — `sharedApplication` lazily creates the singleton `NSApp` object
//! on first call, and `runModal` pumps its own private run loop through
//! that object; neither needs `-finishLaunching` or `-run` to have
//! happened. (Evidence beyond documented Cocoa behaviour: `tao` 0.34 — the
//! event-loop crate under `wry`/Tauri — only touches `NSApplication` inside
//! `EventLoop::new()`, which `tauri::Builder::build()` calls internally;
//! this migration runs strictly before that call, so there is no earlier
//! `NSApp` state to conflict with. This reasoning is NOT the same as having
//! run the dialog for real — see the "Manual verification" section handed
//! back with this change for the two scenarios that still need an actual
//! macOS session, and why `npm run dev:app`'s bare binary and `npm run
//! build:dev`'s release profile are each unsuitable for one of them.)
//!
//! If the app-data migration itself fails for a reason OTHER than a running
//! legacy build (a genuine copy error, checked via
//! [`MigrationOutcome::Failed`]), this process uses the LEGACY product name
//! for this one launch — safe specifically because nothing else is running
//! on that directory at that point, so there is no second process to share
//! it with; the paths.rs invariant this module leans on is about two LIVE
//! processes, not about which name one lone process reads from.
//!
//! A failed WebKit migration has no equivalent fallback — WebKit's profile
//! location is derived by the OS from the fixed `CFBundleIdentifier`, not
//! something this code can redirect, and the first webview window is
//! created immediately after this migration runs regardless of outcome. A
//! failure there shows a second, different dialog — "Continue without
//! settings" or "Quit" — rather than starting silently on a fresh, empty
//! profile with no chance to retry.
//!
//! ## What is, and is not, proven by the automated tests in this file
//!
//! [`decide_migration`] and `evaluate`'s FS-state computation, the staged
//! copy/rename mechanics, permission handling, the debug/release row
//! filter, and orphan cleanup are all exercised on a real filesystem via a
//! temp directory. What is NOT, and cannot be, exercised by `cargo test`:
//! `NSAlert`/`NSRunningApplication` actually driving a second real process,
//! and WebKit actually re-deriving a `<hash>` from a copied `salt` at
//! runtime — both need a real macOS session and are documented as manual
//! procedures instead.

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
/// with NO debug/release filtering — used directly by the multi-generation
/// test (M5) and to check a table's shape independent of which build is
/// running the check. Test-only: production code always goes through
/// `rename_for_product_name`'s eligibility filter instead.
#[cfg_attr(not(test), allow(dead_code))]
fn rename_matching_product_name<'a>(table: &'a [Rename], current: &str) -> Option<&'a Rename> {
    table.iter().find(|r| r.to_product_name == current)
}

#[cfg_attr(not(test), allow(dead_code))]
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
fn gc_orphaned_staging(parent: &Path, log: &Logger) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(pid) = extract_staging_pid(&name) else {
            continue;
        };
        if !process_is_alive(pid) {
            log(&format!(
                "migration: removing orphaned staging directory {} (pid {pid} is gone)",
                entry.path().display()
            ));
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Parses the pid out of a `staging_path_for` name:
/// `.<name>.migrating-<pid>-<seq>`.
fn extract_staging_pid(file_name: &str) -> Option<libc::pid_t> {
    let idx = file_name.find(".migrating-")?;
    let rest = &file_name[idx + ".migrating-".len()..];
    rest.split('-').next()?.parse().ok()
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
/// asking whether `legacy_identifier` is running. The running-check is
/// skipped whenever the marker already matches, `old` is absent, or `new`
/// is already populated, since none of those branches of `decide_migration`
/// consult it.
fn evaluate(old: &Path, new: &Path, legacy_identifier: &str) -> Decision {
    let marker_matches = marker_points_to(old, new);
    let old_exists = old.exists();
    let new_populated = !dir_is_absent_or_empty(new);
    let legacy_running = !marker_matches && old_exists && !new_populated && is_bundle_running(legacy_identifier);
    decide_migration(marker_matches, old_exists, new_populated, legacy_running)
}

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

// ---------------------------------------------------------------------------
// Resolving a running legacy build: a blocking native dialog, offering to
// terminate it, before `Builder::build()` ever runs. See the module doc
// comment's "Resolving a running legacy build" section.
// ---------------------------------------------------------------------------

/// Shows a blocking `NSAlert` with `buttons` (first is the default,
/// highlighted button) and returns the 0-based index of the button chosen.
#[cfg(target_os = "macos")]
unsafe fn show_blocking_alert(message: &str, informative: &str, buttons: &[&str]) -> usize {
    use cocoa::appkit::NSApplication;
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::{class, msg_send, sel, sel_impl};

    let _pool = AutoreleasePool::new();
    // Lazily creates the singleton `NSApp` if nothing has yet — `NSAlert`'s
    // `runModal` needs it to exist, but not to have been `run`. See the
    // module doc comment for the evidence this is safe ahead of Tauri's own
    // (later) `NSApplication` setup.
    let _: id = NSApplication::sharedApplication(nil);

    let alert: id = msg_send![class!(NSAlert), alloc];
    let alert: id = msg_send![alert, init];

    let ns_message = NSString::alloc(nil).init_str(message);
    let _: () = msg_send![alert, setMessageText: ns_message];
    let _: () = msg_send![ns_message, release];

    let ns_informative = NSString::alloc(nil).init_str(informative);
    let _: () = msg_send![alert, setInformativeText: ns_informative];
    let _: () = msg_send![ns_informative, release];

    for button in buttons {
        let ns_button = NSString::alloc(nil).init_str(button);
        let _: id = msg_send![alert, addButtonWithTitle: ns_button];
        let _: () = msg_send![ns_button, release];
    }

    // NSAlertFirstButtonReturn == 1000; each subsequent button return code
    // is one higher.
    let response: isize = msg_send![alert, runModal];
    let _: () = msg_send![alert, release];
    (response - 1000).max(0) as usize
}

/// Sends `terminate` (the "please quit" request, NOT `forceTerminate`) to
/// every running instance of `bundle_id` other than this process, then polls
/// up to `timeout` for them all to disappear.
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

/// Blocks until `bundle_id` is no longer running or the user chooses to
/// abandon this launch entirely. Loops back to the dialog if termination is
/// requested but does not complete within 10 seconds, rather than either
/// force-quitting or silently proceeding.
#[cfg(target_os = "macos")]
fn resolve_legacy_running(bundle_id: &str, log: &Logger) -> bool {
    loop {
        let choice = unsafe {
            show_blocking_alert(
                "couplet (formerly md-mini) needs md-mini to quit",
                "To move your drafts and settings, md-mini needs to quit first. Nothing will be lost.",
                &["Quit md-mini and Continue", "Quit"],
            )
        };
        if choice != 0 {
            log("migration: user chose to quit rather than wait for the legacy build to close");
            return false;
        }
        log("migration: asking the legacy build to quit");
        if unsafe { terminate_bundle_and_wait(bundle_id, Duration::from_secs(10)) } {
            log("migration: legacy build quit, continuing");
            return true;
        }
        log("migration: legacy build did not quit within 10s, asking again");
    }
}

#[cfg(not(target_os = "macos"))]
fn resolve_legacy_running(_bundle_id: &str, _log: &Logger) -> bool {
    true
}

/// Shown when the WebKit migration itself failed (not because a legacy
/// build was running — that is resolved before this can be reached).
/// Returns whether to continue starting up anyway (losing this launch's
/// settings, retried next launch) or to quit.
#[cfg(target_os = "macos")]
fn resolve_webkit_failure(log: &Logger) -> bool {
    let choice = unsafe {
        show_blocking_alert(
            "couplet couldn't move your saved settings",
            "Your theme and recent files couldn't be copied from md-mini. You can continue without them, or quit and try again later.",
            &["Continue without settings", "Quit"],
        )
    };
    let continue_anyway = choice == 0;
    log(&format!(
        "migration: WebKit migration failed; user chose to {}",
        if continue_anyway { "continue without settings" } else { "quit" }
    ));
    continue_anyway
}

#[cfg(not(target_os = "macos"))]
fn resolve_webkit_failure(_log: &Logger) -> bool {
    true
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

fn file_logger(product_name: &str) -> impl Fn(&str) {
    let path = log_path_under(&dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")), product_name);
    move |msg: &str| {
        if append_log_line(&path, msg).is_err() {
            eprintln!("{msg}");
        }
    }
}

// ---------------------------------------------------------------------------
// The real, top-level entry point. Not unit-tested directly — it touches
// `~/Library`, `dirs::home_dir()`/`dirs::data_dir()`, and (on a running
// legacy instance or a WebKit failure) a real native dialog. Everything it
// composes (`evaluate`, `decide_migration`, `migrate_dir`,
// `gc_orphaned_staging`) is tested on its own.
// ---------------------------------------------------------------------------

/// Runs both migrations, called once from `run()` before
/// `tauri::Builder::default()...build()`. Returns the product name `run()`
/// should use for `paths::init` this launch.
pub(crate) fn migrate_all_real(current_product_name: &str, current_identifier: &str) -> String {
    let log = file_logger(current_product_name);

    let product_rename = rename_for_product_name(current_product_name);
    let identifier_rename = rename_for_identifier(current_identifier);
    if product_rename.is_none() && identifier_rename.is_none() {
        return current_product_name.to_string();
    }

    let app_data_paths = product_rename.and_then(|r| {
        dirs::data_dir().map(|base| {
            (
                r,
                base.join(r.from_product_name),
                base.join(crate::paths::dir_name(current_product_name)),
            )
        })
    });
    if product_rename.is_some() && app_data_paths.is_none() {
        log("migration: could not determine the application data directory, skipping");
    }

    let webkit_paths = identifier_rename.and_then(|r| {
        dirs::home_dir().map(|home| {
            let base = home.join("Library").join("WebKit");
            (r, base.join(r.from_identifier), base.join(current_identifier))
        })
    });
    if identifier_rename.is_some() && webkit_paths.is_none() {
        log("migration: could not determine the home directory, skipping WebKit profile migration");
    }

    let mut app_data_decision = app_data_paths.as_ref().map(|(r, old, new)| evaluate(old, new, r.from_identifier));
    let mut webkit_decision = webkit_paths.as_ref().map(|(r, old, new)| evaluate(old, new, r.from_identifier));

    if matches!(app_data_decision, Some(Decision::LegacyRunning)) || matches!(webkit_decision, Some(Decision::LegacyRunning)) {
        let legacy_identifier = app_data_paths
            .as_ref()
            .map(|(r, ..)| r.from_identifier)
            .or_else(|| webkit_paths.as_ref().map(|(r, ..)| r.from_identifier))
            .expect("a LegacyRunning decision implies at least one matching row");

        if !resolve_legacy_running(legacy_identifier, &log) {
            log("migration: abandoning this launch — the legacy build is still running");
            std::process::exit(0);
        }
        if let Some((r, old, new)) = &app_data_paths {
            app_data_decision = Some(evaluate(old, new, r.from_identifier));
        }
        if let Some((r, old, new)) = &webkit_paths {
            webkit_decision = Some(evaluate(old, new, r.from_identifier));
        }
    }

    let needs_lock = |d: &Option<Decision>| matches!(d, Some(dec) if *dec != Decision::AlreadyDone);
    let _lock = if needs_lock(&app_data_decision) || needs_lock(&webkit_decision) {
        let lock = MigrationLock::acquire(&log);
        if let Some((_, _, new)) = &app_data_paths {
            if let Some(parent) = new.parent() {
                gc_orphaned_staging(parent, &log);
            }
        }
        if let Some((_, _, new)) = &webkit_paths {
            if let Some(parent) = new.parent() {
                gc_orphaned_staging(parent, &log);
            }
        }
        lock
    } else {
        None
    };

    let app_data_outcome = match (&app_data_paths, app_data_decision) {
        (Some((_, old, new)), Some(Decision::Migrate)) => migrate_dir(old, new, "app data directory", Strategy::PreferRename, &log),
        (Some((_, old, new)), Some(Decision::NewAlreadyPopulated)) => {
            log(&format!(
                "migration: app data directory — {} already has data, leaving {} in place",
                new.display(),
                old.display()
            ));
            MigrationOutcome::NoOp
        }
        _ => MigrationOutcome::NoOp,
    };

    let webkit_outcome = match (&webkit_paths, webkit_decision) {
        (Some((_, old, new)), Some(Decision::Migrate)) => migrate_dir(old, new, "WebKit profile", Strategy::CopyOnly, &log),
        (Some((_, old, new)), Some(Decision::NewAlreadyPopulated)) => {
            log(&format!(
                "migration: WebKit profile — {} already has data, leaving {} in place",
                new.display(),
                old.display()
            ));
            MigrationOutcome::NoOp
        }
        _ => MigrationOutcome::NoOp,
    };

    if webkit_outcome == MigrationOutcome::Failed && !resolve_webkit_failure(&log) {
        std::process::exit(0);
    }

    if app_data_outcome == MigrationOutcome::Failed {
        if let Some((r, ..)) = &app_data_paths {
            log(&format!(
                "migration: app data directory migration did not complete this launch — using the legacy directory \"{}\" for this one launch (nothing else is running on it) so a retry stays possible next launch",
                r.from_product_name
            ));
            return r.from_product_name.to_string();
        }
    }

    current_product_name.to_string()
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
        let dead_pid = 999_999; // astronomically unlikely to be a live pid
        let orphan = dir.join(format!(".couplet-dev.migrating-{dead_pid}-0"));
        write(&orphan.join("partial.txt"), "leftover");

        let (_log, logger) = collecting_logger();
        gc_orphaned_staging(&dir, &logger);

        assert!(!orphan.exists(), "an orphan from a dead pid must be removed");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gc_leaves_a_staging_directory_whose_pid_is_alive() {
        let dir = scratch("gc-alive");
        let my_pid = std::process::id();
        let live = dir.join(format!(".couplet-dev.migrating-{my_pid}-0"));
        write(&live.join("still-copying.txt"), "in progress");

        let (_log, logger) = collecting_logger();
        gc_orphaned_staging(&dir, &logger);

        assert!(live.exists(), "a staging dir whose pid is still alive (this test process) must survive");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gc_ignores_entries_that_do_not_look_like_staging_directories() {
        let dir = scratch("gc-unrelated");
        write(&dir.join("not-a-staging-dir").join("file.txt"), "unrelated");

        let (_log, logger) = collecting_logger();
        gc_orphaned_staging(&dir, &logger);

        assert!(dir.join("not-a-staging-dir").exists());
        fs::remove_dir_all(&dir).ok();
    }

    // --- M6: file logging ---------------------------------------------------

    #[test]
    fn log_path_follows_the_apple_logs_convention_named_after_the_product() {
        let home = PathBuf::from("/Users/someone");
        assert_eq!(log_path_under(&home, "couplet"), PathBuf::from("/Users/someone/Library/Logs/couplet/migration.log"));
        assert_eq!(log_path_under(&home, "../escape"), PathBuf::from("/Users/someone/Library/Logs/md-mini/migration.log"));
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
}
