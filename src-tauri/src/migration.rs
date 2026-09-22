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
//!    leave the new identifier's (different) salt unable to derive that same
//!    hash, and WebKit would never look there. The whole `<identifier>/`
//!    directory must move as one unit, `salt` included, so the salt-to-hash
//!    relationship that already exists on disk stays consistent under the
//!    new identifier too.
//!
//! This module is a no-op today: every `LEGACY_IDENTITIES` entry's own name
//! equals the current one, so `legacy_for_*` finds nothing to migrate *from*.
//! It activates automatically the moment `tauri.conf.json` /
//! `tauri.dev.conf.json` are renamed to something new — nothing else needs
//! to change, and this file's logic never hardcodes the new name.
//!
//! **Ordering matters more than usual here.** The WebKit migration must run
//! before the FIRST webview window is created, not merely before our own
//! `.setup()` closure: Tauri's internal `app::setup()` builds every window
//! listed in `tauri.conf.json` — which creates the WKWebView, which creates
//! its on-disk profile — as the very first step of `Builder::build()`,
//! before the user-supplied setup closure is ever invoked (see
//! `tauri-2.10.3/src/app.rs`, the private `fn setup<R: Runtime>` called from
//! `build()`: it loops over `app.config().app.windows` and only *then* calls
//! `app.setup.take()`). So both migrations run in `run()` itself, before
//! `Builder::default()...build(context)` — well before `paths::init`, which
//! stays the first statement inside `.setup()` for everything that follows.
//!
//! Each migration function here is a thin real-filesystem wrapper around a
//! pure(-ish) core that takes its base directory as a parameter, so tests run
//! against a temp directory instead of `~/Library`. **What those tests do and
//! do not prove:** they confirm the copy-the-whole-directory, no-overwrite,
//! idempotent, dev/release-isolated behaviour on a plain filesystem tree that
//! happens to have the same shape as a real WebKit profile (verified against
//! a real one — see the doc comment above). They do NOT start a WKWebView, so
//! they cannot confirm WebKit actually re-derives the same `<hash>` from a
//! copied `salt` and finds the migrated `localstorage.sqlite3` at runtime.
//! That needs a live check: build twice with `npm run build:dev`, once with
//! `tauri.dev.conf.json`'s `identifier` temporarily changed to a throwaway
//! value (e.g. `com.md-mini.migrationtest`), confirm the app runs and set a
//! value that lands in `localStorage` (e.g. toggle the theme), quit, restore
//! `identifier` back and add a fabricated legacy entry pointing at the
//! throwaway one, launch again, and confirm the value survived. Not run here.

use std::fs;
use std::io;
use std::path::Path;

/// Marker left inside a migrated-from directory once its contents are safely
/// in the new location. Its presence means "do not migrate again" and its
/// content tells a human poking around the old directory where things went.
const MOVED_MARKER: &str = "MOVED_TO";

/// One generation of (product name, bundle identifier) this app has shipped
/// under. `dev` keeps the dev and release migrations from ever crossing:
/// `md-mini-dev` must migrate into the new dev name, never the release one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LegacyIdentity {
    product_name: &'static str,
    identifier: &'static str,
    dev: bool,
}

/// Every name/identifier this app has shipped under. Add an entry here — and
/// only here — the next time the product is renamed again; nothing in
/// `paths.rs` or this module's matching logic needs to change.
const LEGACY_IDENTITIES: &[LegacyIdentity] = &[
    LegacyIdentity {
        product_name: "md-mini",
        identifier: "com.md-mini.app",
        dev: false,
    },
    LegacyIdentity {
        product_name: "md-mini-dev",
        identifier: "com.md-mini.dev",
        dev: true,
    },
];

/// Product names this app has previously shipped under. `paths.rs`'s own
/// regression test checks the current release name against this, so it
/// keeps failing if a future rename ever drops today's name from
/// `LEGACY_IDENTITIES` without giving it somewhere to migrate to first —
/// which would silently strand every existing install's `recovery/` and
/// `session/` data. Test-only: nothing at runtime needs the full list by
/// name, only `legacy_for_product_name`'s lookup.
#[cfg(test)]
pub(crate) fn known_legacy_product_names() -> impl Iterator<Item = &'static str> {
    LEGACY_IDENTITIES.iter().map(|l| l.product_name)
}

/// A dev build's product name carries a `-dev` suffix (`tauri.dev.conf.json`
/// sets `md-mini` -> `md-mini-dev`); its identifier carries a `.dev` suffix
/// (`com.md-mini.app` -> `com.md-mini.dev`). Both conventions already exist
/// in this repo — this just reads them back to classify the *current* build,
/// so dev never migrates from or into a release directory.
fn is_dev_product_name(name: &str) -> bool {
    name.trim().ends_with("-dev")
}

fn is_dev_identifier(id: &str) -> bool {
    id.trim().ends_with(".dev")
}

/// The legacy identity the current product name should migrate data FROM, or
/// `None` when the current name already matches every entry it could match
/// (today's no-op state) or matches no known generation at all (an
/// unrecognised build flavour — nothing to guess at, so nothing migrates).
fn legacy_for_product_name(current: &str) -> Option<&'static LegacyIdentity> {
    let dev = is_dev_product_name(current);
    LEGACY_IDENTITIES
        .iter()
        .find(|l| l.dev == dev && l.product_name != current)
}

fn legacy_for_identifier(current: &str) -> Option<&'static LegacyIdentity> {
    let dev = is_dev_identifier(current);
    LEGACY_IDENTITIES
        .iter()
        .find(|l| l.dev == dev && l.identifier != current)
}

/// Where a migration's bytes are allowed to move.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Strategy {
    /// Try an atomic `rename` first (fast, and the whole directory simply
    /// disappears from the old location); fall back to a recursive copy,
    /// leaving the old directory fully intact, if the rename fails — e.g. a
    /// different volume, which is possible but unlikely for two sibling
    /// directories under the same `~/Library/Application Support/`.
    PreferRename,
    /// Never rename — always copy, and never touch the old directory's
    /// contents. Used for the WebKit profile: unlike the app-data directory,
    /// this one is not solely owned by this process's Rust code, and nothing
    /// here can prove WebKit itself has no lingering reference to the old
    /// path at the moment this runs (it runs before any webview exists in
    /// *this* process, but a previous run's WebKit process is not something
    /// this code can reason about).
    CopyOnly,
}

type Logger<'a> = dyn Fn(&str) + 'a;

fn is_marked_migrated(dir: &Path) -> bool {
    dir.join(MOVED_MARKER).exists()
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

fn write_marker(old: &Path, new: &Path, log: &Logger) {
    let marker = old.join(MOVED_MARKER);
    let content = format!(
        "This directory's contents were moved to:\n{}\n\n\
         A future launch will not migrate again because this file exists. \
         It is safe to delete this directory once you've confirmed the new \
         location has everything you expect.\n",
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

/// Recursively copies `src` into `dst`, creating `dst` if needed. Symlinks
/// are recreated as symlinks (pointing at the same target) rather than
/// dereferenced, so a link that escapes the tree is not silently inlined.
fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else if file_type.is_symlink() {
            let link_target = fs::read_link(entry.path())?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(&link_target, &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// The shared core: migrate `old` into `new` under `strategy`, logging every
/// decision and never losing data on any failure path.
///
/// - No-op if `old` was already marked migrated, or does not exist.
/// - No-op (data stays in `old`, nothing written to `new`) if `new` already
///   holds anything — never overwrite existing data.
/// - On a copy failure (rename fallback or `CopyOnly`), any partial `new` is
///   removed and the marker is NOT written: a half-copied directory must not
///   look "already migrated" to a future launch, or to `paths::app_data_dir`
///   lazily creating an empty `new` on first use. Data stays exactly where it
///   was, in `old`, and the next launch retries the copy from scratch.
fn migrate_dir(old: &Path, new: &Path, label: &str, strategy: Strategy, log: &Logger) {
    if is_marked_migrated(old) {
        return;
    }
    if !old.exists() {
        return;
    }
    if !dir_is_absent_or_empty(new) {
        log(&format!(
            "migration: {label} — {} already has data, leaving {} in place",
            new.display(),
            old.display()
        ));
        return;
    }

    if strategy == Strategy::PreferRename {
        if let Some(parent) = new.parent() {
            let _ = fs::create_dir_all(parent);
        }
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
                return;
            }
            Err(e) => {
                log(&format!(
                    "migration: {label} — rename failed ({e}), falling back to copy"
                ));
            }
        }
    }

    match copy_dir_recursive(old, new) {
        Ok(()) => {
            log(&format!(
                "migration: {label} — copied {} -> {}",
                old.display(),
                new.display()
            ));
            write_marker(old, new, log);
        }
        Err(e) => {
            log(&format!(
                "migration: {label} — copy failed ({e}); leaving data in {} untouched, \
                 will retry on next launch",
                old.display()
            ));
            // A partially written `new` must not survive: it would look like
            // finished, empty (or worse, truncated) data rather than the
            // "nothing happened yet" state that makes a retry safe.
            let _ = fs::remove_dir_all(new);
        }
    }
}

/// Migrates `<base>/<legacy product name>` into `<base>/<dir_name(current)>`.
/// `base` stands in for `dirs::data_dir()` — a parameter so tests run against
/// a tempdir. Goes through `paths::dir_name` for the destination so this
/// agrees with `paths::app_data_dir` on unusual-name fallback behaviour.
pub fn migrate_app_data_dir(base: &Path, current_product_name: &str, log: &Logger) {
    let Some(legacy) = legacy_for_product_name(current_product_name) else {
        return;
    };
    let old_dir = base.join(legacy.product_name);
    let new_dir = base.join(crate::paths::dir_name(current_product_name));
    migrate_dir(&old_dir, &new_dir, "app data directory", Strategy::PreferRename, log);
}

/// Migrates `<webkit_base>/<legacy identifier>` into
/// `<webkit_base>/<current identifier>` — the WHOLE WKWebView profile
/// directory for one bundle identifier, not just its `WebsiteData` child.
///
/// This has to be the whole directory, and it has to move as one unit: the
/// `WebsiteData/Default/<hash>/...` leaf that holds `localstorage.sqlite3`
/// gets its `<hash>` name from `WebsiteData/Default/salt` plus the origin —
/// copying the leaf without its salt would leave the new identifier's own
/// (different) salt unable to re-derive that hash, so WebKit would never
/// find the data. See the module doc comment for how this was confirmed
/// against a real profile.
///
/// `webkit_base` stands in for `~/Library/WebKit` — a parameter so tests run
/// against a temp directory.
pub fn migrate_webkit_profile(webkit_base: &Path, current_identifier: &str, log: &Logger) {
    let Some(legacy) = legacy_for_identifier(current_identifier) else {
        return;
    };
    let old_dir = webkit_base.join(legacy.identifier);
    let new_dir = webkit_base.join(current_identifier);
    migrate_dir(&old_dir, &new_dir, "WebKit profile", Strategy::CopyOnly, log);
}

// ---------------------------------------------------------------------------
// Real-filesystem entry points. Thin on purpose: everything that can be
// exercised without touching `~/Library` lives in the functions above.
// ---------------------------------------------------------------------------

/// Real entry point for the app-data-dir migration. Errors are logged and
/// swallowed — a failed migration must never stop the app from starting; the
/// worst case is the user's data stays exactly where the old build left it,
/// waiting for a retry on the next launch.
pub fn migrate_app_data_dir_real(current_product_name: &str) {
    let Some(base) = dirs::data_dir() else {
        eprintln!("migration: could not determine the application data directory, skipping");
        return;
    };
    migrate_app_data_dir(&base, current_product_name, &|msg| eprintln!("{msg}"));
}

/// Real entry point for the WebKit profile migration. Must be called before
/// the first webview window is created — see the module doc comment for why
/// that means "before `Builder::build()`", not "before `.setup()`".
pub fn migrate_webkit_profile_real(current_identifier: &str) {
    let Some(home) = dirs::home_dir() else {
        eprintln!("migration: could not determine the home directory, skipping WebKit profile migration");
        return;
    };
    let webkit_base = home.join("Library").join("WebKit");
    migrate_webkit_profile(&webkit_base, current_identifier, &|msg| eprintln!("{msg}"));
}

#[cfg(test)]
mod tests {
    use super::*;
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

    // --- legacy matching -----------------------------------------------------

    #[test]
    fn no_op_when_current_name_matches_a_legacy_entry_exactly() {
        // Today's state: nothing has been renamed yet.
        assert!(legacy_for_product_name("md-mini").is_none());
        assert!(legacy_for_product_name("md-mini-dev").is_none());
        assert!(legacy_for_identifier("com.md-mini.app").is_none());
        assert!(legacy_for_identifier("com.md-mini.dev").is_none());
    }

    #[test]
    fn finds_the_release_legacy_after_a_rename() {
        let legacy = legacy_for_product_name("couplet").expect("should find md-mini");
        assert_eq!(legacy.product_name, "md-mini");
        assert!(!legacy.dev);
    }

    #[test]
    fn finds_the_dev_legacy_after_a_rename() {
        let legacy = legacy_for_product_name("couplet-dev").expect("should find md-mini-dev");
        assert_eq!(legacy.product_name, "md-mini-dev");
        assert!(legacy.dev);
    }

    #[test]
    fn dev_and_release_never_cross() {
        // A dev build must never be offered the release legacy directory, or
        // vice versa — that would merge two users' worth of state.
        let release_legacy = legacy_for_product_name("couplet").unwrap();
        let dev_legacy = legacy_for_product_name("couplet-dev").unwrap();
        assert_ne!(release_legacy.product_name, dev_legacy.product_name);
        assert!(!release_legacy.dev);
        assert!(dev_legacy.dev);

        let release_id = legacy_for_identifier("com.couplet.app").unwrap();
        let dev_id = legacy_for_identifier("com.couplet.dev").unwrap();
        assert_ne!(release_id.identifier, dev_id.identifier);
    }

    // Note on what is deliberately NOT tested here: there is no
    // "unrecognised name matches nothing" case. Any current name that is not
    // itself a known legacy name of the same dev/release flavour is treated
    // as "the product was just renamed to this" and matched against that
    // flavour's legacy entry — that IS the mechanism that makes migration
    // activate automatically on a rename without this module ever learning
    // the new name. `no_op_when_current_name_matches_a_legacy_entry_exactly`
    // above is the only case where matching correctly finds nothing.

    // --- migrate_app_data_dir -------------------------------------------------

    #[test]
    fn app_data_dir_is_a_no_op_when_names_match() {
        let dir = std::env::temp_dir().join(format!("md-mini-migtest-noop-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        write(&dir.join("md-mini").join("session.json"), "{}");

        let (log, logger) = collecting_logger();
        migrate_app_data_dir(&dir, "md-mini", &logger);

        assert!(dir.join("md-mini").join("session.json").exists());
        assert!(!dir.join("couplet").exists());
        assert!(log.lock().unwrap().is_empty(), "no-op must not log anything");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn app_data_dir_moves_into_an_empty_new_directory() {
        let dir = std::env::temp_dir().join(format!("md-mini-migtest-move-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        write(&dir.join("md-mini").join("session.json"), "{\"windows\":[]}");
        write(&dir.join("md-mini").join("recovery").join("draft.md"), "unsaved work");

        let (_log, logger) = collecting_logger();
        migrate_app_data_dir(&dir, "couplet", &logger);

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
        let dir = std::env::temp_dir().join(format!("md-mini-migtest-nooverwrite-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        write(&dir.join("md-mini").join("session.json"), "old unsaved work");
        write(&dir.join("couplet").join("session.json"), "already has real couplet data");

        let (log, logger) = collecting_logger();
        migrate_app_data_dir(&dir, "couplet", &logger);

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
    fn app_data_dir_migration_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("md-mini-migtest-idempotent-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        write(&dir.join("md-mini").join("session.json"), "{}");

        let (_log, logger) = collecting_logger();
        migrate_app_data_dir(&dir, "couplet", &logger);
        let after_first = fs::read_to_string(dir.join("couplet").join("session.json")).unwrap();

        // Simulate a second launch: nothing about the old marker directory or
        // the new data should change, and a second run must not error or
        // duplicate anything.
        let (_log2, logger2) = collecting_logger();
        migrate_app_data_dir(&dir, "couplet", &logger2);

        assert_eq!(
            fs::read_to_string(dir.join("couplet").join("session.json")).unwrap(),
            after_first
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn dev_and_release_app_data_dirs_do_not_cross() {
        let dir = std::env::temp_dir().join(format!("md-mini-migtest-devcross-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
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
    fn app_data_dir_falls_back_to_copy_when_rename_is_impossible() {
        // A directory cannot be renamed onto a path that is itself inside a
        // read-only parent... simulating a genuine cross-device failure is
        // impractical in a unit test, so this exercises the fallback branch
        // directly through `migrate_dir`'s copy path by pointing `new_dir`'s
        // parent at a location `fs::rename` will refuse: a file where a
        // directory is expected. `fs::rename` errors when the destination's
        // parent has a non-directory in the way of a component; here we
        // instead confirm the copy path is reached and reproduces the data,
        // and that the original is left intact — the fallback contract that
        // matters, independent of what triggers it.
        let dir = std::env::temp_dir().join(format!("md-mini-migtest-copyfallback-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let old = dir.join("md-mini");
        write(&old.join("session.json"), "{}");
        let new = dir.join("couplet");

        let (_log, logger) = collecting_logger();
        // Exercise the shared core directly with CopyOnly, the same fallback
        // codepath PreferRename lands in after a failed rename.
        migrate_dir(&old, &new, "test", Strategy::CopyOnly, &logger);

        assert_eq!(fs::read_to_string(new.join("session.json")).unwrap(), "{}");
        assert!(old.join("session.json").exists(), "copy must not remove the source");
        assert!(old.join(MOVED_MARKER).exists());
        fs::remove_dir_all(&dir).ok();
    }

    // --- migrate_webkit_profile ------------------------------------------------

    #[test]
    fn webkit_profile_is_a_no_op_when_identifiers_match() {
        let dir = std::env::temp_dir().join(format!("md-mini-migtest-wk-noop-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        write(
            &dir.join("com.md-mini.app").join("WebsiteData").join("marker.txt"),
            "x",
        );

        let (log, logger) = collecting_logger();
        migrate_webkit_profile(&dir, "com.md-mini.app", &logger);

        assert!(!dir.join("com.couplet.app").exists());
        assert!(log.lock().unwrap().is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn webkit_profile_copies_and_leaves_the_old_profile_intact() {
        let dir = std::env::temp_dir().join(format!("md-mini-migtest-wk-copy-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let ls_dir = dir
            .join("com.md-mini.app")
            .join("WebsiteData")
            .join("Default")
            .join("h1")
            .join("h1")
            .join("LocalStorage");
        write(&ls_dir.join("localstorage.sqlite3"), "sqlite-bytes");

        let (_log, logger) = collecting_logger();
        migrate_webkit_profile(&dir, "com.couplet.app", &logger);

        let new_ls = dir
            .join("com.couplet.app")
            .join("WebsiteData")
            .join("Default")
            .join("h1")
            .join("h1")
            .join("LocalStorage")
            .join("localstorage.sqlite3");
        assert_eq!(fs::read_to_string(&new_ls).unwrap(), "sqlite-bytes");
        // CopyOnly: the old profile must still be there, untouched (aside
        // from the marker), because copy — never move — is the rule here.
        assert!(ls_dir.join("localstorage.sqlite3").exists());
        // The marker lives at the identifier-directory level, since that is
        // what got migrated as a unit (not just its WebsiteData child).
        assert!(dir.join("com.md-mini.app").join(MOVED_MARKER).exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn webkit_profile_copy_keeps_salt_paired_with_its_hash_directory() {
        // The concern this guards: WebsiteData/Default/<hash> is only
        // meaningful together with the salt that produced it
        // (WebsiteData/Default/salt). Migrating the identifier directory as
        // one unit must carry both, unmodified, to the new identifier —
        // never regenerate or drop the salt, never move the hash dir alone.
        let dir = std::env::temp_dir().join(format!("md-mini-migtest-wk-salt-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
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
        migrate_webkit_profile(&dir, "com.couplet.app", &logger);

        let new_default = dir.join("com.couplet.app").join("WebsiteData").join("Default");
        assert_eq!(
            fs::read_to_string(new_default.join("salt")).unwrap(),
            "the-real-salt-bytes",
            "salt must travel byte-for-byte, unmodified"
        );
        assert_eq!(
            fs::read_to_string(
                new_default
                    .join("XJT9IvBEje24OTnR7aXObEjmm8tb4_4zZvFzi5jl05w")
                    .join("XJT9IvBEje24OTnR7aXObEjmm8tb4_4zZvFzi5jl05w")
                    .join("LocalStorage")
                    .join("localstorage.sqlite3")
            )
            .unwrap(),
            "the-real-localstorage-bytes",
            "the hash directory name must be preserved exactly — it only \
             resolves against the salt that travelled alongside it"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn webkit_profile_never_overwrites_existing_new_profile_data() {
        let dir = std::env::temp_dir().join(format!("md-mini-migtest-wk-nooverwrite-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        write(
            &dir.join("com.md-mini.app").join("WebsiteData").join("f.txt"),
            "old",
        );
        write(
            &dir.join("com.couplet.app").join("WebsiteData").join("f.txt"),
            "already real couplet localStorage",
        );

        let (_log, logger) = collecting_logger();
        migrate_webkit_profile(&dir, "com.couplet.app", &logger);

        assert_eq!(
            fs::read_to_string(dir.join("com.couplet.app").join("WebsiteData").join("f.txt")).unwrap(),
            "already real couplet localStorage"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn webkit_profile_migration_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("md-mini-migtest-wk-idempotent-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        write(
            &dir.join("com.md-mini.app").join("WebsiteData").join("f.txt"),
            "x",
        );

        let (_l1, logger1) = collecting_logger();
        migrate_webkit_profile(&dir, "com.couplet.app", &logger1);
        let (_l2, logger2) = collecting_logger();
        migrate_webkit_profile(&dir, "com.couplet.app", &logger2);

        assert_eq!(
            fs::read_to_string(dir.join("com.couplet.app").join("WebsiteData").join("f.txt")).unwrap(),
            "x"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn webkit_dev_and_release_profiles_do_not_cross() {
        let dir = std::env::temp_dir().join(format!("md-mini-migtest-wk-devcross-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        write(
            &dir.join("com.md-mini.app").join("WebsiteData").join("f.txt"),
            "release",
        );
        write(
            &dir.join("com.md-mini.dev").join("WebsiteData").join("f.txt"),
            "dev",
        );

        let (_l1, logger1) = collecting_logger();
        migrate_webkit_profile(&dir, "com.couplet.app", &logger1);
        let (_l2, logger2) = collecting_logger();
        migrate_webkit_profile(&dir, "com.couplet.dev", &logger2);

        assert_eq!(
            fs::read_to_string(dir.join("com.couplet.app").join("WebsiteData").join("f.txt")).unwrap(),
            "release"
        );
        assert_eq!(
            fs::read_to_string(dir.join("com.couplet.dev").join("WebsiteData").join("f.txt")).unwrap(),
            "dev"
        );
        fs::remove_dir_all(&dir).ok();
    }

    // --- failure handling -------------------------------------------------------

    #[test]
    fn a_failed_copy_does_not_leave_an_empty_new_dir_masquerading_as_migrated() {
        // Force a copy failure by making the *destination's parent* a file
        // instead of a directory, so `create_dir_all` for `new` fails partway.
        let dir = std::env::temp_dir().join(format!("md-mini-migtest-copyfail-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let old = dir.join("md-mini");
        write(&old.join("session.json"), "precious data");
        // `new`'s parent path component is a plain file, so creating
        // `new` (a directory under it) must fail.
        let blocker = dir.join("blocked-parent");
        fs::write(&blocker, "not a directory").unwrap();
        let new = blocker.join("couplet");

        let (log, logger) = collecting_logger();
        migrate_dir(&old, &new, "test", Strategy::CopyOnly, &logger);

        assert!(!new.exists(), "no partial/empty destination should remain");
        assert!(
            old.join("session.json").exists(),
            "source data must be untouched after a failed copy"
        );
        assert!(
            !old.join(MOVED_MARKER).exists(),
            "a failed migration must not be marked as done"
        );
        assert!(log.lock().unwrap().iter().any(|m| m.contains("copy failed")));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn marked_directory_is_never_touched_again() {
        let dir = std::env::temp_dir().join(format!("md-mini-migtest-marked-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let old = dir.join("md-mini");
        write(&old.join(MOVED_MARKER), "moved elsewhere already");
        write(&old.join("stray-file.txt"), "should not move");

        let (log, logger) = collecting_logger();
        migrate_app_data_dir(&dir, "couplet", &logger);

        assert!(!dir.join("couplet").exists());
        assert!(log.lock().unwrap().is_empty());
        fs::remove_dir_all(&dir).ok();
    }
}
