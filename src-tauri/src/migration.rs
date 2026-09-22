//! One-time data migration for a product rename (product name AND bundle
//! identifier both changing at once).
//!
//! Two independent, identity-keyed data stores would otherwise silently
//! orphan a user's data the moment `tauri.conf.json` picks new names:
//!
//! 1. `~/Library/Application Support/<productName>/` (see `paths.rs`) —
//!    `recovery/` (crash-safety snapshots of unsaved work), `session/`
//!    (untitled-buffer contents), `session.json`, `onboarding-version`,
//!    `ai-connected`, and the `ai-*.md` / `welcome-*.md` docs. Keyed by
//!    product name.
//! 2. `~/Library/WebKit/<identifier>/` — WKWebView's own profile, keyed by
//!    the Tauri `identifier`. Under it, `WebsiteData/Default/salt` plus
//!    `WebsiteData/Default/<hash>/<hash>/LocalStorage/localstorage.sqlite3`
//!    hold `localStorage` (theme, recent files, the `ai-hint-seen` flag —
//!    all under an `md-mini:`-prefixed key today, unrenamed on purpose:
//!    renaming the prefix would be a third source of loss for zero visible
//!    benefit), plus IndexedDB, media-key salts and WebKit's own bookkeeping.
//!    **The `<hash>` directory name is derived from `Default/salt` plus the
//!    origin** — confirmed by reading a real profile: `com.md-mini.app` and
//!    `com.md-mini.dev` carry two different `<hash>` names for the very same
//!    origin, because each identifier's `WebsiteData/Default/salt` was
//!    generated independently. So the `<hash>` name is meaningless on its
//!    own — copying only the `LocalStorage` leaf across identifiers would
//!    leave the new identifier's own (different) salt unable to re-derive
//!    that same hash, and WebKit would never look there. The whole
//!    `<identifier>/` directory must move as one unit, `salt` included, so
//!    the salt-to-hash relationship that already exists on disk stays
//!    consistent under the new identifier too.
//!
//! ## Matching: exact `from -> to`, never a suffix guess
//!
//! [`RENAMES`] lists every approved rename as an exact `(from, to)` pair for
//! both the product name and the identifier. A build's CURRENT name is
//! matched by exact equality against a row's `to_*` field — never by
//! stripping/checking a `-dev`/`.dev` suffix. A suffix guess would treat any
//! unrecognised dev-flavoured name (`couplet-beta`, `md-mini-test`, a
//! throwaway identifier picked for a manual test) as eligible to receive
//! production data, silently stranding it in a directory the real release
//! build would never look at again — an earlier version of this module did
//! exactly that and it was wrong. This module is a no-op today — no row's
//! `to_*` equals `"md-mini"` / `"md-mini-dev"` / `"com.md-mini.app"` /
//! `"com.md-mini.dev"`, the CURRENT names — and activates the moment
//! `tauri.conf.json` / `tauri.dev.conf.json` are renamed to the approved
//! `couplet` names.
//!
//! Matching against `to_*` (rather than "not equal to any known name") is
//! also what makes a THIRD generation safe later: a future row
//! `{ from: "couplet", to: "<next name>" }` is found by matching `to ==
//! current`, independent of how many earlier rows exist — it can never be
//! confused with the `md-mini -> couplet` row two generations back. See the
//! `matches_the_immediate_predecessor_across_three_generations` test.
//!
//! ## Never losing the race between two processes (or two migration
//! attempts within one)
//!
//! `migrate_dir` never populates `new` incrementally: a copy lands in a
//! private, per-attempt staging directory first
//! (`<new's parent>/.<new's name>.migrating-<pid>-<seq>`) and `new` itself
//! only ever comes into existence via ONE atomic `rename` — either the
//! direct `old -> new` rename, or `staging -> new` once the staged copy is
//! complete. A failure at any point removes only the staging directory
//! (never `old`, never `new`) via [`StagingCleanup`], a `Drop` guard, so a
//! losing racer's cleanup can never delete data a *different*, faster
//! attempt already finished moving into `new`. [`MigrationLock`] adds a
//! best-effort cross-process `flock` on top so two attempts do not even run
//! concurrently in the first place — but the staged-commit design is what
//! actually guarantees safety; the lock only avoids wasted duplicate work
//! and shrinks the (already-safe) race window further.
//!
//! A rename that fails with `NotFound` gets special handling: `old`
//! vanishing between our own `exists()` check and the `rename` call means
//! something else already acted on it, and the safe response is to
//! re-examine state rather than blindly fall into a copy (which could try to
//! read from a source that is no longer there, or no longer complete).
//!
//! ## A failed or deferred migration must not create an empty `new`
//!
//! If `migrate_app_data_dir` fails (or is deferred — see the follow-up
//! commit that adds a running-legacy-instance check), the rest of `run()`
//! still starts up normally and, within THIS SAME launch, writes
//! `session.json`, `onboarding-version` and other files into whatever
//! `paths::app_data_dir()` currently resolves to. If that resolution used
//! the CURRENT (new) product name unconditionally, a failed migration would
//! be immediately overwritten by an empty-but-now-populated `new` directory,
//! and the NEXT launch would see "`new` already has data" and skip migration
//! forever — silently stranding the old data. `migrate_app_data_dir_real`
//! therefore returns the product name `run()` should actually use THIS
//! launch: the current name normally, or the LEGACY name when migration did
//! not complete, so nothing gets created under the new name until a later
//! launch actually succeeds.
//!
//! The WebKit migration cannot be given the same escape hatch: unlike
//! `paths::app_data_dir()` (our own code, parameterised by name), the WebKit
//! profile location is derived by the OS/WebKit from the process's actual
//! `CFBundleIdentifier`, which is fixed at build time — there is no "use the
//! legacy identifier's WebKit dir this launch" available to us, short of
//! reconfiguring `WKWebView`'s data store (out of scope: a much larger,
//! riskier change). The first webview window is created immediately after
//! this migration runs regardless of its outcome, and WebKit populates a
//! fresh profile (at minimum `WebsiteData/Default/salt`) for the current
//! identifier the moment it does — so a FAILED WebKit migration's retry
//! window is, in the worst case, exactly one launch. This is accepted as a
//! bounded, low-stakes risk: this app's `localStorage` holds only
//! re-derivable preferences (theme, recent files, an onboarding hint flag),
//! never unsaved document content — that risk is fully closed by the
//! app-data-dir fallback above, which is where anything the user would
//! actually miss lives.
//!
//! ## Ordering
//!
//! The WebKit migration must run before the FIRST webview window is
//! created, not merely before our own `.setup()` closure: Tauri's internal
//! `app::setup()` builds every window listed in `tauri.conf.json` — which
//! creates the WKWebView, which creates its on-disk profile — as the very
//! first step of `Builder::build()`, before the user-supplied setup closure
//! is ever invoked (see `tauri-2.10.3/src/app.rs`, the private
//! `fn setup<R: Runtime>` called from `build()`: it loops over
//! `app.config().app.windows` and only *then* calls `app.setup.take()`). So
//! both migrations run in `run()` itself, before
//! `Builder::default()...build(context)` — well before `paths::init`, which
//! stays the first statement inside `.setup()` for everything that follows.
//!
//! ## What is, and is not, proven by the tests in this file
//!
//! Each migration function here is a thin real-filesystem wrapper around a
//! pure(-ish) core that takes its base directory as a parameter, so tests
//! run against a temp directory instead of `~/Library`. They confirm the
//! copy-the-whole-directory, no-overwrite, idempotent, never-partial,
//! race-safe, dev/release-isolated behaviour on a plain filesystem tree
//! shaped like a real WebKit profile (confirmed against a real one — see
//! above). They do NOT start a WKWebView, so they cannot confirm WebKit
//! actually re-derives the same `<hash>` from a copied `salt` and finds the
//! migrated `localstorage.sqlite3` at runtime. That needs a live check —
//! see [`DEBUG_TEST_RENAMES`] below for how to do that WITHOUT risking a
//! throwaway identifier being treated as a real migration target.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::os::unix::io::AsRawFd;
use std::sync::atomic::{AtomicU64, Ordering};

/// Marker left inside a migrated-from directory once its contents are safely
/// in the new location. Its presence means "do not migrate again" — but only
/// while its content still points at the CURRENT destination; see
/// `marker_points_to`.
const MOVED_MARKER: &str = "MOVED_TO";

/// One approved rename: `from_*` is the exact previous productName/identifier;
/// `to_*` is what it became. Matching is always exact equality against
/// `to_*` — see the module doc comment for why.
#[derive(Debug, Clone, Copy)]
struct Rename {
    from_product_name: &'static str,
    to_product_name: &'static str,
    from_identifier: &'static str,
    to_identifier: &'static str,
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
    },
    Rename {
        from_product_name: "md-mini-dev",
        to_product_name: "couplet-dev",
        from_identifier: "com.md-mini.dev",
        to_identifier: "pro.couplet.dev",
    },
];

/// Extra rows consulted ONLY in a debug build (`#[cfg(debug_assertions)]` —
/// compiled out entirely from `cargo build --release` / `tauri build`, so
/// this can never ship, with or without remembering to revert it by hand).
/// Empty by default. To verify the WebKit salt/hash mechanism end to end
/// against a real WKWebView (unit tests below cannot do this — see the
/// module doc comment): temporarily add a row here with a throwaway
/// `to_identifier` (e.g. `com.md-mini.migrationtest`) and a `from_identifier`
/// you actually control test data for, build with `npm run build:dev` after
/// pointing `tauri.dev.conf.json`'s `identifier` at that throwaway value,
/// launch, set something that lands in `localStorage` (e.g. toggle the
/// theme), quit, point `identifier` back, launch again, and confirm the
/// value survived. Remove the row (and revert `tauri.dev.conf.json`) once
/// done — being debug-only means a forgotten row can never reach a release,
/// but a stray row here still isn't real configuration.
#[cfg(debug_assertions)]
const DEBUG_TEST_RENAMES: &[Rename] = &[];

fn rename_matching_product_name<'a>(table: &'a [Rename], current: &str) -> Option<&'a Rename> {
    table.iter().find(|r| r.to_product_name == current)
}

fn rename_matching_identifier<'a>(table: &'a [Rename], current: &str) -> Option<&'a Rename> {
    table.iter().find(|r| r.to_identifier == current)
}

fn rename_for_product_name(current: &str) -> Option<&'static Rename> {
    if let Some(r) = rename_matching_product_name(RENAMES, current) {
        return Some(r);
    }
    #[cfg(debug_assertions)]
    if let Some(r) = rename_matching_product_name(DEBUG_TEST_RENAMES, current) {
        return Some(r);
    }
    None
}

fn rename_for_identifier(current: &str) -> Option<&'static Rename> {
    if let Some(r) = rename_matching_identifier(RENAMES, current) {
        return Some(r);
    }
    #[cfg(debug_assertions)]
    if let Some(r) = rename_matching_identifier(DEBUG_TEST_RENAMES, current) {
        return Some(r);
    }
    None
}

/// Product names this app has previously shipped under. `paths.rs`'s own
/// regression test checks the current release name against this, so it
/// keeps failing if a future rename ever drops today's name from `RENAMES`
/// without giving it somewhere to migrate to first — which would silently
/// strand every existing install's `recovery/` and `session/` data.
#[cfg(test)]
pub(crate) fn known_legacy_product_names() -> impl Iterator<Item = &'static str> {
    RENAMES.iter().map(|r| r.from_product_name)
}

type Logger<'a> = dyn Fn(&str) + 'a;

/// What `migrate_dir` actually did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MigrationOutcome {
    /// Nothing to do: no rename matches the current name, migration already
    /// completed (marker points at `new`), or `new` already has data.
    NoOp,
    /// Moved/copied `old` into `new` this call.
    Migrated,
    /// Attempted and did not complete — `old` is untouched, `new` was never
    /// populated (a partial attempt only ever exists in a staging directory,
    /// which was removed). Safe, and expected, to retry on the next launch.
    Failed,
    /// Not attempted at all this launch: a legacy build with the matching
    /// generation's bundle identifier is still running, so `old` (its
    /// `recovery/`/`session/`, or its live WebKit profile with an open
    /// `-wal`/`-shm`) may be read or written at any moment. `old` is
    /// completely untouched. Safe, and expected, to retry next launch.
    DeferredLegacyRunning,
}

/// Where a migration's bytes are allowed to move.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Strategy {
    /// Try an atomic `rename` of `old` itself first (fast, and the whole
    /// directory simply disappears from the old location); fall back to a
    /// staged copy if that fails for a reason other than `old` having
    /// already vanished.
    PreferRename,
    /// Never rename `old` itself — always copy (via staging), and never
    /// touch `old`'s contents. Used for the WebKit profile: unlike the
    /// app-data directory, this one is not solely owned by this process's
    /// Rust code.
    CopyOnly,
}

/// True when the marker in `old` exists AND its recorded destination is
/// EXACTLY `expected_new`. A marker pointing somewhere else — a leftover
/// from an earlier, different rename generation, or manual tampering — must
/// NOT be read as "already migrated to where we need it now": that would
/// silently skip a migration that still needs to happen.
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
         its data to be — if the product is renamed again, this directory \
         becomes eligible to migrate once more, into wherever that next \
         rename points. It is safe to delete this directory once you've \
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
/// exists as a directory with no entries. Anything that exists but is NOT a
/// readable, empty directory — a stray file at that path, a permission
/// error — is treated as "occupied" rather than "absent": the whole point of
/// this check is never overwriting something that might be real data, and a
/// path this code cannot positively confirm is empty does not get the
/// benefit of the doubt.
fn dir_is_absent_or_empty(dir: &Path) -> bool {
    if !dir.exists() {
        return true;
    }
    match fs::read_dir(dir) {
        Ok(mut entries) => entries.next().is_none(),
        Err(_) => false,
    }
}

/// Recursively copies `src` into `dst`, creating `dst` if needed. Symlinks
/// are recreated as symlinks (pointing at the same target) rather than
/// dereferenced, so a link that escapes the tree is not silently inlined.
fn copy_dir_recursive(src: &Path, dst: &Path, log: &Logger) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    // Best-effort: a directory's own mode is worth preserving (a `0700`
    // `recovery/` staying `0700` in the new location, say), but failing to
    // set it must not fail the whole copy — the CONTENT is what matters most.
    if let Ok(meta) = fs::metadata(src) {
        let _ = fs::set_permissions(dst, meta.permissions());
    }
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
            // A socket, FIFO, or char/block device — `fs::copy` cannot copy
            // one of these anyway (it calls `open`, which blocks or fails on
            // most of them), and none of them are ever real user data inside
            // an app-data or WebKit profile directory. Skip it rather than
            // fail the ENTIRE migration over a file nothing downstream could
            // use even if the copy somehow succeeded.
            log(&format!(
                "migration: skipping non-regular file {} (socket/FIFO/device) while copying",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

/// Copies `src` (file, directory, or symlink) into `dst` recursively,
/// WITHOUT overwriting anything that already exists at `dst`. Returns how
/// many files were newly copied. Used by `sweep_stray_files` — unlike
/// `copy_dir_recursive` (used by the main migration, where `dst` is always
/// freshly empty by construction), this one has to coexist with data that is
/// already there.
fn merge_into(src: &Path, dst: &Path) -> io::Result<u32> {
    let meta = fs::symlink_metadata(src)?;
    if meta.is_dir() {
        fs::create_dir_all(dst)?;
        let mut count = 0;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            count += merge_into(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(count)
    } else if meta.file_type().is_symlink() {
        if dst.exists() {
            Ok(0)
        } else {
            let link_target = fs::read_link(src)?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(&link_target, dst)?;
            Ok(1)
        }
    } else if dst.exists() {
        Ok(0)
    } else {
        fs::copy(src, dst)?;
        Ok(1)
    }
}

/// Runs after every migration attempt that was not deferred: if a legacy
/// build gets launched again AFTER migration already completed — a
/// downgrade, a stale Dock/Spotlight entry, `open -a <old name>` from a
/// script nobody updated — it has no idea a marker exists and will happily
/// recreate `recovery/`/`session/` files (or WebKit localStorage writes)
/// under `old`. This walks `old` for anything besides the marker and merges
/// it into `new` via `merge_into` — never overwriting anything already
/// there — so those files do not silently vanish. Only acts once
/// `marker_points_to` confirms migration is actually done for `new`;
/// otherwise `old` still holds the primary copy and this must not race
/// `migrate_dir` above. Best-effort: a failure is logged, never fatal, and
/// `old` itself is never removed from (copy, not move) — a legacy instance
/// that resumes writing to `old` after this runs must not have its files
/// vanish out from under it either. This is a partial mitigation, not a
/// full fix, for a legacy build being launched repeatedly after migration —
/// see the M7 note in the PR this landed in for what remains.
fn sweep_stray_files(old: &Path, new: &Path, log: &Logger) {
    if !marker_points_to(old, new) {
        return;
    }
    let Ok(entries) = fs::read_dir(old) else {
        return;
    };
    let mut swept = 0u32;
    for entry in entries.flatten() {
        if entry.file_name() == MOVED_MARKER {
            continue;
        }
        let src = entry.path();
        let dst = new.join(entry.file_name());
        match merge_into(&src, &dst) {
            Ok(count) => swept += count,
            Err(e) => log(&format!(
                "migration: sweep could not merge {} into {}: {}",
                src.display(),
                dst.display(),
                e
            )),
        }
    }
    if swept > 0 {
        log(&format!(
            "migration: swept {swept} file(s) a legacy build left behind in {} (after migration) into {}",
            old.display(),
            new.display()
        ));
    }
}

/// Whether a running process reports `bundle_id` as its `CFBundleIdentifier`
/// — i.e. whether a legacy build (dev or release, matching the generation
/// being migrated) is alive right now. Checked before touching `old`: a
/// running legacy instance may be writing `recovery/`/`session/` files (app
/// data) or holding an open sqlite `-wal`/`-shm` (WebKit profile) at any
/// moment, and neither a `rename` out from under it nor a plain-`fs::copy`
/// snapshot of a live sqlite file set is safe.
// Tests must never depend on what is *actually* running on the machine that
// happens to run `cargo test` (this repo's own dev machine typically DOES
// have a real md-mini running) — so under `#[cfg(test)]` this reads only the
// explicit `testing::force_bundle_running` override, defaulting to "nothing
// is running" rather than falling through to `is_bundle_running_real`.
#[cfg(not(test))]
fn is_bundle_running(bundle_id: &str) -> bool {
    is_bundle_running_real(bundle_id)
}

#[cfg(test)]
fn is_bundle_running(_bundle_id: &str) -> bool {
    testing::forced_bundle_running().unwrap_or(false)
}

// Genuinely unused under `cargo test` (the `#[cfg(test)]` `is_bundle_running`
// above never calls it — see the comment there for why), never unused in a
// real build.
#[cfg(target_os = "macos")]
#[cfg_attr(test, allow(dead_code))]
fn is_bundle_running_real(bundle_id: &str) -> bool {
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSArray, NSAutoreleasePool, NSString};
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        // Same autorelease-pool discipline as `locale::system_locale`: this
        // can run before tao has created its own pool, and without one here
        // the runtime leaks a warning on every launch. Everything we need
        // (a `bool`) is copied out before the pool drains.
        let pool = NSAutoreleasePool::new(nil);
        let result = (|| {
            let ns_bundle_id = NSString::alloc(nil).init_str(bundle_id);
            let cls = class!(NSRunningApplication);
            let apps: id = msg_send![cls, runningApplicationsWithBundleIdentifier: ns_bundle_id];
            if apps.is_null() {
                return false;
            }
            NSArray::count(apps) > 0
        })();
        pool.drain();
        result
    }
}

#[cfg(not(target_os = "macos"))]
fn is_bundle_running_real(_bundle_id: &str) -> bool {
    false
}

static STAGING_SEQ: AtomicU64 = AtomicU64::new(0);

/// A private, per-attempt staging path: `<new's parent>/.<new's
/// name>.migrating-<pid>-<seq>`. Nothing else in this codebase, or in a
/// concurrent attempt (pid differs) or an earlier attempt in the same
/// process (seq differs), can ever be confused for this path — which is
/// exactly what makes it safe for a failure handler to unconditionally
/// `remove_dir_all` it: that path is never anything OTHER than this
/// attempt's own half-finished work.
fn staging_path_for(new: &Path) -> Option<PathBuf> {
    let parent = new.parent()?;
    let name = new.file_name()?;
    let seq = STAGING_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut staging_name = std::ffi::OsString::from(".");
    staging_name.push(name);
    staging_name.push(format!(".migrating-{}-{}", std::process::id(), seq));
    Some(parent.join(staging_name))
}

/// Removes its `path` on `Drop` unless [`disarm`](Self::disarm) was called —
/// i.e. "clean up my own staging directory unless I successfully committed
/// it". Because `path` is always a [`staging_path_for`] path, this can never
/// remove `old` or `new` themselves — see the module doc comment's C1
/// section for why that property is the entire point.
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

/// The shared core: migrate `old` into `new` under `strategy`, logging every
/// decision. See the module doc comment for the full race-safety argument;
/// in short:
///
/// - No-op if the marker in `old` already points at `new`, or `old` does not
///   exist.
/// - No-op (data stays in `old`, `new` untouched) if `new` already holds
///   anything — never overwrite existing data.
/// - `new` is populated by exactly ONE atomic `rename` — either directly
///   (`PreferRename`'s happy path) or by committing a fully-written staging
///   directory. Any failure before that point removes only the staging
///   directory; `old` and `new` are never touched by a failure path.
fn migrate_dir(old: &Path, new: &Path, label: &str, strategy: Strategy, log: &Logger) -> MigrationOutcome {
    if marker_points_to(old, new) {
        return MigrationOutcome::NoOp;
    }
    if !old.exists() {
        return MigrationOutcome::NoOp;
    }
    if !dir_is_absent_or_empty(new) {
        log(&format!(
            "migration: {label} — {} already has data, leaving {} in place",
            new.display(),
            old.display()
        ));
        return MigrationOutcome::NoOp;
    }

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
                // `old` no longer exists — `rename` replaced the directory
                // entry outright. Recreate it as an (otherwise empty) home
                // for the marker, so a human and a repeat launch both have
                // somewhere to find "this moved" without needing this
                // module's source code.
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
                // `old` vanished between our `exists()` check above and this
                // `rename` call — C1. Re-examine rather than falling into a
                // copy, which could read a source that is now gone, or
                // already only partially there. Whatever happened, there is
                // nothing safe left for THIS attempt to do.
                log(&format!(
                    "migration: {label} — source vanished mid-attempt (likely another process finished it first); rechecking instead of copying"
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
        return MigrationOutcome::Failed; // `cleanup` removes `staging` on drop
    }

    // Re-check immediately before committing: closes the window even beyond
    // what the cross-process lock covers (the lock is best-effort — see
    // `MigrationLock`), and is what the C1 race test exercises directly via
    // `testing::before_commit`.
    #[cfg(test)]
    testing::run_before_commit_hook();
    if !dir_is_absent_or_empty(new) {
        log(&format!(
            "migration: {label} — {} gained data while copying, discarding the staged copy",
            new.display()
        ));
        return MigrationOutcome::NoOp; // `cleanup` removes `staging` on drop
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
            MigrationOutcome::Failed // `cleanup` removes `staging` on drop
        }
    }
}

/// Migrates `<base>/<rename.from_product_name>` into
/// `<base>/<dir_name(current)>`. `base` stands in for `dirs::data_dir()` — a
/// parameter so tests run against a tempdir. Goes through `paths::dir_name`
/// for the destination so this agrees with `paths::app_data_dir` on
/// unusual-name fallback behaviour.
pub(crate) fn migrate_app_data_dir(base: &Path, current_product_name: &str, log: &Logger) -> MigrationOutcome {
    let Some(rename) = rename_for_product_name(current_product_name) else {
        return MigrationOutcome::NoOp;
    };
    let old_dir = base.join(rename.from_product_name);
    let new_dir = base.join(crate::paths::dir_name(current_product_name));

    if is_bundle_running(rename.from_identifier) {
        log(&format!(
            "migration: app data directory — {} is still running, deferring migration to the next launch",
            rename.from_identifier
        ));
        return MigrationOutcome::DeferredLegacyRunning;
    }

    let outcome = migrate_dir(&old_dir, &new_dir, "app data directory", Strategy::PreferRename, log);
    sweep_stray_files(&old_dir, &new_dir, log);
    outcome
}

/// Migrates `<webkit_base>/<rename.from_identifier>` into
/// `<webkit_base>/<current identifier>` — the WHOLE WKWebView profile
/// directory for one bundle identifier, not just its `WebsiteData` child (see
/// the module doc comment's salt/hash explanation for why it has to be the
/// whole directory). `webkit_base` stands in for `~/Library/WebKit` — a
/// parameter so tests run against a temp directory.
pub(crate) fn migrate_webkit_profile(webkit_base: &Path, current_identifier: &str, log: &Logger) -> MigrationOutcome {
    let Some(rename) = rename_for_identifier(current_identifier) else {
        return MigrationOutcome::NoOp;
    };
    let old_dir = webkit_base.join(rename.from_identifier);
    let new_dir = webkit_base.join(current_identifier);

    if is_bundle_running(rename.from_identifier) {
        log(&format!(
            "migration: WebKit profile — {} is still running (its sqlite -wal/-shm may be live), deferring migration to the next launch",
            rename.from_identifier
        ));
        return MigrationOutcome::DeferredLegacyRunning;
    }

    let outcome = migrate_dir(&old_dir, &new_dir, "WebKit profile", Strategy::CopyOnly, log);
    sweep_stray_files(&old_dir, &new_dir, log);
    outcome
}

/// Best-effort cross-process mutex over migration work, via `flock` on a
/// fixed, well-known file — not product/identifier-specific, so a release
/// and a dev build attempting migration at the same moment also serialize,
/// and two near-simultaneous launches of the SAME renamed build do too. This
/// is the scenario H3 names: nothing before `Builder::build()` has enforced
/// single-instance yet, so a double-launch can reach `run()` (and therefore
/// this migration) twice.
///
/// This is defense in depth, not the only thing preventing data loss — see
/// the module doc comment's C1 section: the staged-copy-then-atomic-rename
/// design in `migrate_dir` is what actually makes a lost race safe, even for
/// a process that never acquires this lock at all. Acquisition is therefore
/// best-effort: a failure to open or lock the file is logged and migration
/// proceeds unlocked rather than blocking startup. Waiting is bounded to 5
/// seconds for the same reason — a wedged holder must not hang every future
/// launch forever.
struct MigrationLock {
    _file: fs::File,
}

impl MigrationLock {
    fn lock_path() -> PathBuf {
        std::env::temp_dir().join("md-mini-rebrand-migration.lock")
    }

    fn acquire(log: &Logger) -> Option<Self> {
        let path = Self::lock_path();
        // `truncate(false)`: this file's content is never read, only used as
        // an `flock` handle, so there is nothing to gain from clearing it —
        // spelled out explicitly rather than relying on the (false) default.
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
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            // SAFETY: `file`'s fd is valid for this call and stays open for
            // as long as the returned guard (which owns `file`) is alive.
            let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if rc == 0 {
                return Some(Self { _file: file });
            }
            if std::time::Instant::now() >= deadline {
                log("migration: timed out waiting for the migration lock, proceeding unlocked");
                return None;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
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
// Logging. `eprintln!` alone is invisible for a bundled `.app` — nothing
// reads its stderr, so a migration failure would leave no trace anyone could
// ever find (M6). Every migration log line therefore also goes to
// `~/Library/Logs/<product>/migration.log`, the same convention macOS apps
// generally use for their own logs — falling back to `eprintln!` only if the
// file itself cannot be opened (never the reason migration itself fails).
//
// NOT implemented here: surfacing a failure as an in-app toast. Migration
// runs before `Builder::build()`, before any window/webview/frontend exists,
// so there is no toast channel available at the point this logs. The path to
// add one later: stash the outcome in a `tauri::State` (a `MigrationNotice`
// alongside `SessionState`/`UpdateState` in `lib.rs`), add an IPC command
// (`migration_notice() -> Option<String>`, next to `pending_update`'s
// pattern in `updater.rs`) the frontend polls once on mount, and a new toast
// kind in `toasts.svelte.ts` (`migration-error`, alongside `comment-error`)
// to render it. Out of scope here: it is frontend work with its own review
// surface, not a migration-correctness fix.
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

/// Appends one line to `path`, creating its parent directories if needed.
fn append_log_line(path: &Path, msg: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "[{}] {}", now_epoch_secs(), msg)
}

/// A logger that appends to `~/Library/Logs/<product_name>/migration.log`,
/// falling back to `eprintln!` if the file can't be written.
/// `product_name` should be the CURRENT build's raw name — the log's
/// location stays the same regardless of which product name this particular
/// launch's migration ends up telling `run()` to use.
fn file_logger(product_name: &str) -> impl Fn(&str) {
    let path = log_path_under(&dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")), product_name);
    move |msg: &str| {
        if append_log_line(&path, msg).is_err() {
            eprintln!("{msg}");
        }
    }
}

// ---------------------------------------------------------------------------
// Real-filesystem entry points. Thin on purpose: everything that can be
// exercised without touching `~/Library` lives in the functions above.
// ---------------------------------------------------------------------------

/// Real entry point for the app-data-dir migration. Returns the product name
/// `run()` should actually use THIS launch: `current_product_name` normally,
/// or the legacy name if migration did not complete — see the module doc
/// comment's "must not create an empty `new`" section for why that matters.
/// Errors are logged and swallowed — a failed migration must never stop the
/// app from starting.
pub(crate) fn migrate_app_data_dir_real(current_product_name: &str) -> String {
    let log = file_logger(current_product_name);
    let _lock = MigrationLock::acquire(&log);

    let Some(base) = dirs::data_dir() else {
        log("migration: could not determine the application data directory, skipping");
        return current_product_name.to_string();
    };

    match migrate_app_data_dir(&base, current_product_name, &log) {
        MigrationOutcome::Failed | MigrationOutcome::DeferredLegacyRunning => {
            match rename_for_product_name(current_product_name) {
                Some(rename) => {
                    log(&format!(
                        "migration: app data directory migration did not complete this launch — using the legacy directory \"{}\" so the data stays reachable and a retry stays possible next launch",
                        rename.from_product_name
                    ));
                    rename.from_product_name.to_string()
                }
                None => current_product_name.to_string(),
            }
        }
        MigrationOutcome::NoOp | MigrationOutcome::Migrated => current_product_name.to_string(),
    }
}

/// Real entry point for the WebKit profile migration. Must be called before
/// the first webview window is created — see the module doc comment for why
/// that means "before `Builder::build()`", not "before `.setup()`". Unlike
/// the app-data-dir migration, there is no legacy-fallback return value here
/// — see the module doc comment for why that escape hatch does not exist for
/// WebKit's profile location. `current_product_name` is used ONLY to pick
/// the log file's location (`~/Library/Logs/<product_name>/migration.log`,
/// shared with `migrate_app_data_dir_real`'s log) — WebKit's own directory
/// naming is entirely `current_identifier`.
pub(crate) fn migrate_webkit_profile_real(current_product_name: &str, current_identifier: &str) {
    let log = file_logger(current_product_name);
    let _lock = MigrationLock::acquire(&log);

    let Some(home) = dirs::home_dir() else {
        log("migration: could not determine the home directory, skipping WebKit profile migration");
        return;
    };
    let webkit_base = home.join("Library").join("WebKit");
    let _ = migrate_webkit_profile(&webkit_base, current_identifier, &log);
}

#[cfg(test)]
pub(crate) mod testing {
    //! Deterministic hook points for exercising race windows that are
    //! otherwise only reachable via genuine multi-process/multi-thread
    //! timing. Mirrors the pattern already established in
    //! `atomic_write::testing` for the same reason: thread-local, so tests
    //! running in parallel cannot see each other's hooks, and cleared by a
    //! `Drop` guard so one test cannot leak its hook into the next.
    use std::cell::RefCell;

    type Hook = Box<dyn Fn()>;

    thread_local! {
        static BEFORE_FIRST_RENAME: RefCell<Option<Hook>> = const { RefCell::new(None) };
        static BEFORE_COMMIT: RefCell<Option<Hook>> = const { RefCell::new(None) };
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

    /// Runs right after `migrate_dir` decides it will attempt the FIRST
    /// (direct, `PreferRename`) `fs::rename(old, new)` — lets a test make
    /// `old` vanish right before that call, to exercise the `NotFound`
    /// recheck path deterministically instead of needing a genuine race.
    pub(crate) fn before_first_rename<F: Fn() + 'static>(hook: F) -> HookGuard {
        BEFORE_FIRST_RENAME.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
        HookGuard(&BEFORE_FIRST_RENAME)
    }

    /// Runs with the staged copy fully written and the final
    /// `staging -> new` commit not yet issued — lets a test populate `new`
    /// from "another attempt" right in the C1 race window.
    pub(crate) fn before_commit<F: Fn() + 'static>(hook: F) -> HookGuard {
        BEFORE_COMMIT.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
        HookGuard(&BEFORE_COMMIT)
    }

    thread_local! {
        static FORCE_BUNDLE_RUNNING: RefCell<Option<bool>> = const { RefCell::new(None) };
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

    /// Overrides `is_bundle_running`'s result for the current thread, so
    /// tests can simulate "a legacy instance is alive" deterministically
    /// without needing a real running process with a real bundle identifier.
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

    /// Any entry directly under `parent` whose name matches the
    /// `staging_path_for` naming scheme (`.<name>.migrating-<pid>-<seq>`).
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

    // --- exact from -> to matching (H4, M5) -----------------------------------

    #[test]
    fn no_op_when_current_name_matches_a_known_from_or_is_otherwise_unrenamed() {
        // Today's state: nothing has been renamed yet, so the current names
        // ARE the `from_*` values, not any row's `to_*`.
        assert!(rename_for_product_name("md-mini").is_none());
        assert!(rename_for_product_name("md-mini-dev").is_none());
        assert!(rename_for_identifier("com.md-mini.app").is_none());
        assert!(rename_for_identifier("com.md-mini.dev").is_none());
    }

    #[test]
    fn finds_the_release_rename() {
        let rename = rename_for_product_name("couplet").expect("should find the md-mini row");
        assert_eq!(rename.from_product_name, "md-mini");
        assert_eq!(rename.from_identifier, "com.md-mini.app");

        let by_id = rename_for_identifier("pro.couplet.app").expect("should find it by identifier too");
        assert_eq!(by_id.from_identifier, "com.md-mini.app");
    }

    #[test]
    fn finds_the_dev_rename() {
        let rename = rename_for_product_name("couplet-dev").expect("should find the md-mini-dev row");
        assert_eq!(rename.from_product_name, "md-mini-dev");
        assert_eq!(rename.from_identifier, "com.md-mini.dev");
    }

    #[test]
    fn dev_and_release_never_cross() {
        let release = rename_for_product_name("couplet").unwrap();
        let dev = rename_for_product_name("couplet-dev").unwrap();
        assert_ne!(release.from_product_name, dev.from_product_name);
        assert_ne!(release.from_identifier, dev.from_identifier);
    }

    #[test]
    fn an_unrecognised_name_migrates_nothing_however_dev_flavoured_it_looks() {
        // H4's exact concern: a name that merely LOOKS like a dev build of
        // the new product (or an old throwaway test identifier) must not be
        // treated as eligible to receive production data.
        assert!(rename_for_product_name("couplet-beta").is_none());
        assert!(rename_for_product_name("md-mini-test").is_none());
        assert!(rename_for_identifier("com.md-mini.migrationtest").is_none());
        assert!(rename_for_identifier("pro.couplet.beta").is_none());
    }

    #[test]
    fn matches_the_immediate_predecessor_across_three_generations() {
        // M5: a hypothetical third generation (`couplet` -> `X`) must not
        // get confused with the two-generations-back row (`md-mini` ->
        // `couplet`) — exact `to`-matching walks one hop at a time
        // regardless of how many rows exist or what order they're in.
        let chain = [
            Rename {
                from_product_name: "md-mini",
                to_product_name: "couplet",
                from_identifier: "com.md-mini.app",
                to_identifier: "pro.couplet.app",
            },
            Rename {
                from_product_name: "couplet",
                to_product_name: "X",
                from_identifier: "pro.couplet.app",
                to_identifier: "com.x.app",
            },
        ];

        let hop1 = rename_matching_product_name(&chain, "couplet").expect("first hop");
        assert_eq!(hop1.from_product_name, "md-mini");

        let hop2 = rename_matching_product_name(&chain, "X").expect("second hop");
        assert_eq!(hop2.from_product_name, "couplet");
        assert_ne!(hop2.from_product_name, "md-mini", "must not skip straight to the oldest generation");
    }

    // --- migrate_app_data_dir -------------------------------------------------

    #[test]
    fn app_data_dir_is_a_no_op_when_names_match() {
        let dir = scratch("noop");
        write(&dir.join("md-mini").join("session.json"), "{}");

        let (log, logger) = collecting_logger();
        let outcome = migrate_app_data_dir(&dir, "md-mini", &logger);

        assert_eq!(outcome, MigrationOutcome::NoOp);
        assert!(dir.join("md-mini").join("session.json").exists());
        assert!(!dir.join("couplet").exists());
        assert!(log.lock().unwrap().is_empty(), "no-op must not log anything");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn app_data_dir_moves_into_an_empty_new_directory() {
        let dir = scratch("move");
        write(&dir.join("md-mini").join("session.json"), "{\"windows\":[]}");
        write(&dir.join("md-mini").join("recovery").join("draft.md"), "unsaved work");

        let (_log, logger) = collecting_logger();
        let outcome = migrate_app_data_dir(&dir, "couplet", &logger);

        assert_eq!(outcome, MigrationOutcome::Migrated);
        assert_eq!(
            fs::read_to_string(dir.join("couplet").join("session.json")).unwrap(),
            "{\"windows\":[]}"
        );
        assert_eq!(
            fs::read_to_string(dir.join("couplet").join("recovery").join("draft.md")).unwrap(),
            "unsaved work"
        );
        assert!(
            dir.join("md-mini").join(MOVED_MARKER).exists(),
            "old dir should carry the marker"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn app_data_dir_never_overwrites_a_non_empty_new_directory() {
        let dir = scratch("nooverwrite");
        write(&dir.join("md-mini").join("session.json"), "old unsaved work");
        write(&dir.join("couplet").join("session.json"), "already has real couplet data");

        let (log, logger) = collecting_logger();
        let outcome = migrate_app_data_dir(&dir, "couplet", &logger);

        assert_eq!(outcome, MigrationOutcome::NoOp);
        assert_eq!(
            fs::read_to_string(dir.join("couplet").join("session.json")).unwrap(),
            "already has real couplet data",
            "existing new-dir data must survive untouched"
        );
        assert_eq!(
            fs::read_to_string(dir.join("md-mini").join("session.json")).unwrap(),
            "old unsaved work",
            "old dir must not be touched either"
        );
        assert!(!dir.join("md-mini").join(MOVED_MARKER).exists());
        assert!(log.lock().unwrap().iter().any(|m| m.contains("already has data")));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn app_data_dir_treats_a_partial_new_directory_as_occupied() {
        // Even a single stray file in `new` must block migration — a
        // half-populated `new` from any source is indistinguishable from
        // "someone already put something here" and must never be papered
        // over by writing more into it.
        let dir = scratch("partial-new");
        write(&dir.join("md-mini").join("recovery").join("draft.md"), "unsaved work");
        write(&dir.join("couplet").join("stray.txt"), "not from us");

        let (_log, logger) = collecting_logger();
        let outcome = migrate_app_data_dir(&dir, "couplet", &logger);

        assert_eq!(outcome, MigrationOutcome::NoOp);
        assert!(!dir.join("couplet").join("recovery").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn app_data_dir_migration_is_idempotent() {
        let dir = scratch("idempotent");
        write(&dir.join("md-mini").join("session.json"), "{}");

        let (_log, logger) = collecting_logger();
        assert_eq!(migrate_app_data_dir(&dir, "couplet", &logger), MigrationOutcome::Migrated);
        let after_first = fs::read_to_string(dir.join("couplet").join("session.json")).unwrap();

        let (_log2, logger2) = collecting_logger();
        assert_eq!(migrate_app_data_dir(&dir, "couplet", &logger2), MigrationOutcome::NoOp);

        assert_eq!(
            fs::read_to_string(dir.join("couplet").join("session.json")).unwrap(),
            after_first
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn dev_and_release_app_data_dirs_do_not_cross() {
        let dir = scratch("devcross");
        write(&dir.join("md-mini").join("session.json"), "release data");
        write(&dir.join("md-mini-dev").join("session.json"), "dev data");

        let (_l1, logger1) = collecting_logger();
        migrate_app_data_dir(&dir, "couplet", &logger1);
        let (_l2, logger2) = collecting_logger();
        migrate_app_data_dir(&dir, "couplet-dev", &logger2);

        assert_eq!(
            fs::read_to_string(dir.join("couplet").join("session.json")).unwrap(),
            "release data"
        );
        assert_eq!(
            fs::read_to_string(dir.join("couplet-dev").join("session.json")).unwrap(),
            "dev data"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_marker_pointing_at_a_different_destination_is_not_treated_as_done() {
        let dir = scratch("marker-elsewhere");
        let old = dir.join("md-mini");
        write(
            &old.join(MOVED_MARKER),
            &format!("{}\n\nstale, from an earlier generation", dir.join("somewhere-else").display()),
        );
        write(&old.join("session.json"), "real data still here");
        let new = dir.join("couplet");

        let (_log, logger) = collecting_logger();
        let outcome = migrate_dir(&old, &new, "test", Strategy::CopyOnly, &logger);

        assert_eq!(outcome, MigrationOutcome::Migrated, "a stale marker must not block a real migration");
        assert_eq!(fs::read_to_string(new.join("session.json")).unwrap(), "real data still here");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn marked_directory_with_nothing_else_in_it_is_a_silent_no_op() {
        // A marker and NOTHING else beside it (the ordinary steady state
        // after a clean migration) must not re-trigger `migrate_dir`, and
        // there is nothing for the M7 sweep to find either — see
        // `sweep_moves_files_a_relaunched_legacy_build_left_behind_after_migration`
        // for the case where a stray file besides the marker IS present.
        let dir = scratch("marked");
        let old = dir.join("md-mini");
        write(&old.join(MOVED_MARKER), dir.join("couplet").to_str().unwrap());

        let (log, logger) = collecting_logger();
        let outcome = migrate_app_data_dir(&dir, "couplet", &logger);

        assert_eq!(outcome, MigrationOutcome::NoOp);
        assert!(!dir.join("couplet").exists());
        assert!(log.lock().unwrap().is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    // --- rename fallback and failure handling (C1, H2) ------------------------

    #[test]
    fn falls_back_to_a_staged_copy_on_a_genuine_rename_failure() {
        // A real EACCES, not a simulated one: `rename` needs write
        // permission on the SOURCE's parent to unlink the entry, so
        // chmod-555-ing `old`'s parent (leaving `old` itself untouched and
        // readable) makes the direct rename fail for a real OS reason while
        // still allowing the copy fallback (which only needs READ on `old`,
        // and writes under a completely different, normally-permissioned
        // parent) to succeed.
        let dir = scratch("rename-eacces");
        let old_parent = dir.join("old_parent");
        let old = old_parent.join("md-mini");
        write(&old.join("session.json"), "precious data");
        let new = dir.join("new_parent").join("couplet");

        fs::set_permissions(&old_parent, fs::Permissions::from_mode(0o555)).unwrap();

        let (log, logger) = collecting_logger();
        let outcome = migrate_dir(&old, &new, "test", Strategy::PreferRename, &logger);

        // Restore permissions before any assertion can panic and skip it.
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
        // A real EACCES on a read, not a simulated failure: chmod 000 on one
        // file partway through the tree makes `copy_dir_recursive` fail
        // reading it, after some other files already copied successfully
        // into the (private, per-attempt) staging directory.
        let dir = scratch("partial-copy");
        let old = dir.join("com.md-mini.app");
        write(&old.join("a.txt"), "copies fine");
        write(&old.join("b.txt"), "never gets read");
        fs::set_permissions(&old.join("b.txt"), fs::Permissions::from_mode(0o000)).unwrap();
        let new = dir.join("com.couplet.app");

        let (log, logger) = collecting_logger();
        let outcome = migrate_dir(&old, &new, "test", Strategy::CopyOnly, &logger);

        // Running as root (some CI/sandbox setups) ignores file mode bits,
        // so guard the assertion on what actually happened.
        if outcome == MigrationOutcome::Migrated {
            eprintln!("skipping strict assertions: this process can read 0o000 files (likely running as root)");
            fs::remove_dir_all(&dir).ok();
            return;
        }

        assert_eq!(outcome, MigrationOutcome::Failed);
        assert!(!new.exists(), "no partial destination should remain");
        assert!(old.join("a.txt").exists(), "source must be untouched after a failed copy");
        assert!(!old.join(MOVED_MARKER).exists(), "a failed migration must not be marked done");
        assert!(
            staging_leftovers(&dir).is_empty(),
            "the Drop-guard must have removed the staging directory"
        );
        assert!(log.lock().unwrap().iter().any(|m| m.contains("copy failed")));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_source_vanishing_right_before_the_first_rename_is_a_no_op_not_a_copy() {
        // Deterministic version of the C1 rename-ENOENT scenario: another
        // actor finishes the SAME migration (renames `old` away and leaves
        // just the marker) in the instant between our own `exists()` check
        // and our `rename` call.
        let dir = scratch("enoent-recheck");
        let old = dir.join("md-mini");
        write(&old.join("session.json"), "will be gone by the time we rename");
        let new = dir.join("couplet");
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
        assert_eq!(
            fs::read_to_string(new.join("session.json")).unwrap(),
            "the real, already-migrated data",
            "must not have been overwritten or removed"
        );
        assert!(log.lock().unwrap().iter().any(|m| m.contains("vanished")));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn concurrent_migration_that_commits_first_wins_and_this_attempt_backs_off() {
        // The C1 race, reproduced deterministically: this attempt finishes
        // copying into its OWN staging directory, and right before it would
        // commit, "another process" finishes first and populates `new` with
        // the real data. This attempt's pre-commit recheck must see that and
        // back off WITHOUT touching `new` — the exact bug (`remove_dir_all`
        // on a path that wasn't ours) this fix closes.
        let dir = scratch("race");
        let old = dir.join("com.md-mini.app");
        write(&old.join("f.txt"), "the real data");
        let new = dir.join("com.couplet.app");
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
        assert!(
            staging_leftovers(&dir).is_empty(),
            "the losing attempt's staging directory must still be cleaned up"
        );
        fs::remove_dir_all(&dir).ok();
    }

    // --- migrate_webkit_profile ------------------------------------------------

    #[test]
    fn webkit_profile_is_a_no_op_when_identifiers_match() {
        let dir = scratch("wk-noop");
        write(&dir.join("com.md-mini.app").join("WebsiteData").join("marker.txt"), "x");

        let (log, logger) = collecting_logger();
        let outcome = migrate_webkit_profile(&dir, "com.md-mini.app", &logger);

        assert_eq!(outcome, MigrationOutcome::NoOp);
        assert!(!dir.join("pro.couplet.app").exists());
        assert!(log.lock().unwrap().is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn webkit_profile_copies_and_leaves_the_old_profile_intact() {
        let dir = scratch("wk-copy");
        let ls_dir = dir
            .join("com.md-mini.app")
            .join("WebsiteData")
            .join("Default")
            .join("h1")
            .join("h1")
            .join("LocalStorage");
        write(&ls_dir.join("localstorage.sqlite3"), "sqlite-bytes");

        let (_log, logger) = collecting_logger();
        let outcome = migrate_webkit_profile(&dir, "pro.couplet.app", &logger);

        assert_eq!(outcome, MigrationOutcome::Migrated);
        let new_ls = dir
            .join("pro.couplet.app")
            .join("WebsiteData")
            .join("Default")
            .join("h1")
            .join("h1")
            .join("LocalStorage")
            .join("localstorage.sqlite3");
        assert_eq!(fs::read_to_string(&new_ls).unwrap(), "sqlite-bytes");
        assert!(ls_dir.join("localstorage.sqlite3").exists(), "CopyOnly must never touch the source");
        assert!(dir.join("com.md-mini.app").join(MOVED_MARKER).exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn webkit_profile_copy_keeps_salt_paired_with_its_hash_directory() {
        let dir = scratch("wk-salt");
        let default_dir = dir.join("com.md-mini.app").join("WebsiteData").join("Default");
        write(&default_dir.join("salt"), "the-real-salt-bytes");
        write(
            &default_dir
                .join("XJT9IvBEje24OTnR7aXObEjmm8tb4_4zZvFzi5jl05w")
                .join("XJT9IvBEje24OTnR7aXObEjmm8tb4_4zZvFzi5jl05w")
                .join("LocalStorage")
                .join("localstorage.sqlite3"),
            "the-real-localstorage-bytes",
        );

        let (_log, logger) = collecting_logger();
        migrate_webkit_profile(&dir, "pro.couplet.app", &logger);

        let new_default = dir.join("pro.couplet.app").join("WebsiteData").join("Default");
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

    #[test]
    fn webkit_profile_never_overwrites_existing_new_profile_data() {
        let dir = scratch("wk-nooverwrite");
        write(&dir.join("com.md-mini.app").join("WebsiteData").join("f.txt"), "old");
        write(
            &dir.join("pro.couplet.app").join("WebsiteData").join("f.txt"),
            "already real couplet localStorage",
        );

        let (_log, logger) = collecting_logger();
        let outcome = migrate_webkit_profile(&dir, "pro.couplet.app", &logger);

        assert_eq!(outcome, MigrationOutcome::NoOp);
        assert_eq!(
            fs::read_to_string(dir.join("pro.couplet.app").join("WebsiteData").join("f.txt")).unwrap(),
            "already real couplet localStorage"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn webkit_profile_migration_is_idempotent() {
        let dir = scratch("wk-idempotent");
        write(&dir.join("com.md-mini.app").join("WebsiteData").join("f.txt"), "x");

        let (_l1, logger1) = collecting_logger();
        migrate_webkit_profile(&dir, "pro.couplet.app", &logger1);
        let (_l2, logger2) = collecting_logger();
        let second = migrate_webkit_profile(&dir, "pro.couplet.app", &logger2);

        assert_eq!(second, MigrationOutcome::NoOp);
        assert_eq!(
            fs::read_to_string(dir.join("pro.couplet.app").join("WebsiteData").join("f.txt")).unwrap(),
            "x"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn webkit_dev_and_release_profiles_do_not_cross() {
        let dir = scratch("wk-devcross");
        write(&dir.join("com.md-mini.app").join("WebsiteData").join("f.txt"), "release");
        write(&dir.join("com.md-mini.dev").join("WebsiteData").join("f.txt"), "dev");

        let (_l1, logger1) = collecting_logger();
        migrate_webkit_profile(&dir, "pro.couplet.app", &logger1);
        let (_l2, logger2) = collecting_logger();
        migrate_webkit_profile(&dir, "pro.couplet.dev", &logger2);

        assert_eq!(
            fs::read_to_string(dir.join("pro.couplet.app").join("WebsiteData").join("f.txt")).unwrap(),
            "release"
        );
        assert_eq!(
            fs::read_to_string(dir.join("pro.couplet.dev").join("WebsiteData").join("f.txt")).unwrap(),
            "dev"
        );
        fs::remove_dir_all(&dir).ok();
    }

    // --- H3: a running legacy instance defers migration -----------------------

    #[test]
    fn app_data_dir_defers_while_the_legacy_build_is_still_running() {
        let dir = scratch("running-defer");
        write(&dir.join("md-mini").join("session.json"), "live, being written right now");

        let guard = testing::force_bundle_running(true);
        let (log, logger) = collecting_logger();
        let outcome = migrate_app_data_dir(&dir, "couplet", &logger);
        drop(guard);

        assert_eq!(outcome, MigrationOutcome::DeferredLegacyRunning);
        assert!(!dir.join("couplet").exists(), "must not touch new while old is live");
        assert!(
            dir.join("md-mini").join("session.json").exists(),
            "must not touch old while the legacy build owns it"
        );
        assert!(!dir.join("md-mini").join(MOVED_MARKER).exists());
        assert!(log.lock().unwrap().iter().any(|m| m.contains("still running")));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn app_data_dir_migrates_normally_once_the_legacy_build_is_not_running() {
        let dir = scratch("not-running");
        write(&dir.join("md-mini").join("session.json"), "{}");

        let guard = testing::force_bundle_running(false);
        let (_log, logger) = collecting_logger();
        let outcome = migrate_app_data_dir(&dir, "couplet", &logger);
        drop(guard);

        assert_eq!(outcome, MigrationOutcome::Migrated);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn webkit_profile_defers_while_the_legacy_build_is_still_running() {
        let dir = scratch("wk-running-defer");
        write(
            &dir.join("com.md-mini.app")
                .join("WebsiteData")
                .join("Default")
                .join("h1")
                .join("h1")
                .join("LocalStorage")
                .join("localstorage.sqlite3-wal"),
            "live wal frames",
        );

        let guard = testing::force_bundle_running(true);
        let (log, logger) = collecting_logger();
        let outcome = migrate_webkit_profile(&dir, "pro.couplet.app", &logger);
        drop(guard);

        assert_eq!(outcome, MigrationOutcome::DeferredLegacyRunning);
        assert!(!dir.join("pro.couplet.app").exists());
        assert!(log.lock().unwrap().iter().any(|m| m.contains("still running")));
        fs::remove_dir_all(&dir).ok();
    }

    // --- M7: sweeping stray files left by a legacy relaunch --------------------

    #[test]
    fn sweep_moves_files_a_relaunched_legacy_build_left_behind_after_migration() {
        let dir = scratch("sweep");
        write(&dir.join("md-mini").join("session.json"), "{}");

        let guard = testing::force_bundle_running(false);
        let (_log, logger) = collecting_logger();
        assert_eq!(migrate_app_data_dir(&dir, "couplet", &logger), MigrationOutcome::Migrated);

        // Simulate the legacy build being launched again (a downgrade, a
        // stale shortcut) and writing a fresh recovery snapshot into `old`,
        // which now holds only the marker.
        write(&dir.join("md-mini").join("recovery").join("crash.md"), "unsaved after the downgrade");

        let (log2, logger2) = collecting_logger();
        let outcome = migrate_app_data_dir(&dir, "couplet", &logger2);
        drop(guard);

        assert_eq!(outcome, MigrationOutcome::NoOp, "already migrated — sweep runs alongside, not instead");
        assert_eq!(
            fs::read_to_string(dir.join("couplet").join("recovery").join("crash.md")).unwrap(),
            "unsaved after the downgrade",
            "the sweep must have carried it into the new directory"
        );
        assert!(
            dir.join("md-mini").join("recovery").join("crash.md").exists(),
            "sweep copies, it does not move — a still-running legacy build must not lose the file out from under it"
        );
        assert!(log2.lock().unwrap().iter().any(|m| m.contains("swept")));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sweep_never_overwrites_a_file_already_present_in_new() {
        let dir = scratch("sweep-nooverwrite");
        write(&dir.join("md-mini").join("session.json"), "{}");

        let guard = testing::force_bundle_running(false);
        let (_log, logger) = collecting_logger();
        migrate_app_data_dir(&dir, "couplet", &logger);

        // A file with the SAME name now exists in both: a fresh write the
        // couplet build itself made, and a stray one the legacy relaunch
        // left behind. The couplet-side copy must win.
        write(&dir.join("couplet").join("onboarding-version"), "couplet's own value");
        write(&dir.join("md-mini").join("onboarding-version"), "stale legacy value");

        let (_log2, logger2) = collecting_logger();
        migrate_app_data_dir(&dir, "couplet", &logger2);
        drop(guard);

        assert_eq!(
            fs::read_to_string(dir.join("couplet").join("onboarding-version")).unwrap(),
            "couplet's own value",
            "sweep must never overwrite something already in the new directory"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sweep_does_nothing_before_migration_has_actually_completed() {
        // No marker yet (migration never ran, or is deferred) — the sweep
        // must not race `migrate_dir` by copying pieces of `old` into `new`
        // on its own.
        let dir = scratch("sweep-premature");
        let old = dir.join("md-mini");
        write(&old.join("recovery").join("draft.md"), "should stay put");
        let new = dir.join("couplet");

        let (log, logger) = collecting_logger();
        sweep_stray_files(&old, &new, &logger);

        assert!(!new.exists());
        assert!(log.lock().unwrap().is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    // --- M6: file logging -------------------------------------------------

    #[test]
    fn log_path_follows_the_apple_logs_convention_named_after_the_product() {
        let home = PathBuf::from("/Users/someone");
        assert_eq!(
            log_path_under(&home, "couplet"),
            PathBuf::from("/Users/someone/Library/Logs/couplet/migration.log")
        );
        // Goes through `paths::dir_name`, so it inherits the same
        // unusual-name fallback `paths::app_data_dir` uses.
        assert_eq!(
            log_path_under(&home, "../escape"),
            PathBuf::from("/Users/someone/Library/Logs/md-mini/migration.log")
        );
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
        assert!(
            content.lines().next().unwrap().starts_with('['),
            "each line should carry a timestamp prefix"
        );
        fs::remove_dir_all(&dir).ok();
    }

    // --- L10: special files and directory permissions --------------------

    #[test]
    fn copy_skips_sockets_and_fifos_instead_of_failing_the_whole_migration() {
        let dir = scratch("special-files");
        let old = dir.join("md-mini");
        write(&old.join("normal.txt"), "regular file");
        let fifo_path = old.join("weird.fifo");
        let fifo_c = std::ffi::CString::new(fifo_path.to_str().unwrap()).unwrap();
        let rc = unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) };
        assert_eq!(rc, 0, "test setup: could not create a FIFO to migrate around");
        let new = dir.join("couplet");

        let (log, logger) = collecting_logger();
        let outcome = migrate_dir(&old, &new, "test", Strategy::CopyOnly, &logger);

        assert_eq!(outcome, MigrationOutcome::Migrated, "a stray FIFO must not sink the whole migration");
        assert_eq!(fs::read_to_string(new.join("normal.txt")).unwrap(), "regular file");
        assert!(!new.join("weird.fifo").exists(), "the FIFO itself is not copyable and must be skipped");
        assert!(log.lock().unwrap().iter().any(|m| m.contains("skipping non-regular file")));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn copy_preserves_a_subdirectorys_mode() {
        let dir = scratch("dir-mode");
        let old = dir.join("md-mini");
        write(&old.join("recovery").join("draft.md"), "unsaved");
        fs::set_permissions(&old.join("recovery"), fs::Permissions::from_mode(0o700)).unwrap();
        let new = dir.join("couplet");

        let (_log, logger) = collecting_logger();
        migrate_dir(&old, &new, "test", Strategy::CopyOnly, &logger);

        let mode = fs::metadata(new.join("recovery")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "the recovery/ subdirectory's own mode should have been preserved");
        fs::remove_dir_all(&dir).ok();
    }
}
