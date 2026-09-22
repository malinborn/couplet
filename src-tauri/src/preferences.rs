//! `preferences.json` — the one user-set preference that has to exist before
//! the webview does: the language override. Everything else (theme, engine,
//! zoom) lives in `localStorage`, unreachable from Rust at menu-build time —
//! see `docs/superpowers/specs/2026-09-21-i18n-design.md`.
//!
//! Shape: `{ "language": "de" }`. An absent key means "follow the system", and
//! a missing or corrupt file reads as that same default — this must never be
//! able to break startup.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::paths;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
struct Preferences {
    language: Option<String>,
}

const FILE_NAME: &str = "preferences.json";

fn prefs_path(base_dir: &Path) -> std::path::PathBuf {
    base_dir.join(FILE_NAME)
}

/// Corrupt or unreadable JSON degrades to the default (`language: None`,
/// i.e. "follow system") rather than propagating an error — a bad
/// `preferences.json` must not be able to keep the app from starting.
fn read(base_dir: &Path) -> Preferences {
    fs::read_to_string(prefs_path(base_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write(base_dir: &Path, prefs: &Preferences) -> Result<(), String> {
    let json = serde_json::to_string_pretty(prefs).map_err(|e| e.to_string())?;
    fs::write(prefs_path(base_dir), json).map_err(|e| e.to_string())
}

/// The stored language preference, or `None` to follow the system. Read once,
/// at the very start of `setup`, before `locale::resolve_at_startup`.
pub fn read_language() -> Option<String> {
    let base_dir = paths::app_data_dir().ok()?;
    read(&base_dir).language
}

/// Persist the language preference (`None` = follow system). Called from the
/// native menu's Language items via `lib.rs::apply_language_change`, which
/// restarts the app right after this returns.
///
/// Validates `language` through `locale::match_supported` before writing:
/// the menu only ever sends a value it built from `SUPPORTED_LANGUAGES`
/// itself, so this exists for defense, not for a caller this app currently
/// has. Without it, an unvalidated value (the deleted `set_language` IPC
/// command used to accept one from any webview) could land in
/// `preferences.json` as e.g. `"de-AT"` — a value `menu.rs`'s startup check
/// then compares raw against every language item's id, matching none, so the
/// app would boot in German with *no* Language item checked at all. Storing
/// the matched canonical code instead of the raw input keeps a value like
/// `"de-AT"` from ever drifting from what the menu compares against.
pub fn write_language(language: Option<String>) -> Result<(), String> {
    let language = match language {
        Some(l) => Some(
            crate::locale::match_supported(&l)
                .ok_or_else(|| format!("unsupported language: {l}"))?
                .to_string(),
        ),
        None => None,
    };
    let base_dir = paths::app_data_dir()?;
    write(&base_dir, &Preferences { language })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "md-mini-preferences-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn missing_file_reads_as_follow_system() {
        let dir = temp_base_dir("missing");
        assert_eq!(read(&dir), Preferences::default());
        assert_eq!(read(&dir).language, None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn round_trips_an_explicit_language() {
        let dir = temp_base_dir("round-trip");

        write(
            &dir,
            &Preferences {
                language: Some("de".to_string()),
            },
        )
        .expect("write preferences");
        assert_eq!(
            read(&dir),
            Preferences {
                language: Some("de".to_string())
            }
        );

        // Switching back to "follow system" round-trips too — the absent key
        // and an explicitly-written `null` must both read the same way.
        write(&dir, &Preferences { language: None }).expect("write preferences");
        assert_eq!(read(&dir), Preferences::default());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_json_degrades_to_follow_system() {
        let dir = temp_base_dir("corrupt");
        fs::write(prefs_path(&dir), "{not json at all").expect("write junk");
        assert_eq!(read(&dir), Preferences::default());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_file_degrades_to_follow_system() {
        // A directory where a file is expected can't be read as one — same
        // failure shape as permission-denied, without needing chmod.
        let dir = temp_base_dir("unreadable");
        fs::create_dir_all(prefs_path(&dir)).expect("create dir standing in for the file");
        assert_eq!(read(&dir), Preferences::default());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn json_missing_the_language_key_is_follow_system() {
        let dir = temp_base_dir("empty-object");
        fs::write(prefs_path(&dir), "{}").expect("write empty object");
        assert_eq!(read(&dir), Preferences::default());
        let _ = fs::remove_dir_all(&dir);
    }

    // `write_language` resolves `paths::app_data_dir()` itself, so it can't be
    // pointed at a temp dir the way `read`/`write` above can. What's exercised
    // here is the pure validation step it runs before ever touching disk —
    // mirrored locally, same discipline `i18n.rs`'s `init_rejects_an_unsupported_language`
    // test uses for the same reason (a `OnceLock`/real-fs boundary in the way).
    #[test]
    fn an_unsupported_language_is_rejected_before_it_can_be_written() {
        assert!(crate::locale::match_supported("de-AT").is_some());
        assert_eq!(crate::locale::match_supported("xx"), None);
    }

    #[test]
    fn write_language_rejects_an_unsupported_code() {
        let dir = temp_base_dir("reject-unsupported");
        // Exercise the same validation `write_language` performs, against a
        // temp dir rather than the real app data dir.
        let language = "xx".to_string();
        let result: Result<(), String> = match crate::locale::match_supported(&language) {
            Some(canonical) => write(&dir, &Preferences { language: Some(canonical.to_string()) }),
            None => Err(format!("unsupported language: {language}")),
        };
        assert!(result.is_err());
        // Nothing was written — the file was never touched.
        assert_eq!(read(&dir), Preferences::default());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_language_stores_the_canonical_code_not_the_raw_bcp47_tag() {
        let dir = temp_base_dir("canonicalize");
        // Same validate-then-write shape as `write_language`, against a temp
        // dir: a BCP-47 tag like "de-AT" must be stored as its matched
        // canonical code ("de"), the value `menu.rs` compares against.
        let language = "de-AT".to_string();
        let canonical = crate::locale::match_supported(&language)
            .expect("de-AT matches the de language")
            .to_string();
        write(&dir, &Preferences { language: Some(canonical) }).expect("write preferences");
        assert_eq!(
            read(&dir),
            Preferences { language: Some("de".to_string()) }
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
