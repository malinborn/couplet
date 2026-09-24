//! Where the app keeps its own state on disk.
//!
//! The directory name is derived from the product name so that a dev build never
//! shares state with an installed release one. They differ only by config
//! (`tauri.dev.conf.json` renames the product to `md-mini-dev`), so a hardcoded
//! name would put `recovery/` — which holds the user's unsaved work — and
//! `session.json` in the same place for both, and running `npm run dev:app` would
//! quietly overwrite the real app's files.
//!
//! A product rename (changing `productName` in `tauri.conf.json` /
//! `tauri.dev.conf.json`) therefore changes the directory this module
//! returns — on purpose, and that is no longer a data-loss risk by itself:
//! `migration.rs` runs before anything in this module is first touched and
//! moves an existing installation's directory across to the new name, as
//! long as the old name is still listed in its `RENAMES` table. This
//! module's own job stays exactly what it always was — name the *current*
//! directory, never move anything — `migration.rs` is where a rename's
//! continuity is guaranteed.

use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

/// The release build's product name, as `tauri.conf.json` spells it — the
/// one copy of it available to code that runs WITHOUT a Tauri context: the
/// `couplet ai …` CLI client and `couplet mcp`, which `main.rs` dispatches to
/// before any context exists, and which find the running app's command
/// socket by name (`ai_socket::socket_path`). The app binds that socket from
/// the live `productName`; before this constant the clients spelled the name
/// out as a literal, which would have left them dialling the old socket
/// after a rename. A test below pins it to `tauri.conf.json`.
pub const RELEASE_PRODUCT_NAME: &str = "couplet";

/// The name every callsite falls back to when `tauri.conf.json`'s
/// `product_name` is somehow absent — `Option<String>` on the config type,
/// even though this app always sets it. The release name, NOT the previous
/// one: falling back onto the legacy `md-mini` directory would put this
/// process in the one directory an installed md-mini may still be using —
/// the collision `migration.rs` exists to prevent.
pub(crate) const FALLBACK_PRODUCT_NAME: &str = RELEASE_PRODUCT_NAME;
const FALLBACK_DIR: &str = FALLBACK_PRODUCT_NAME;

static APP_DIR_NAME: OnceLock<String> = OnceLock::new();

/// Directory name for a product name. Unsuitable characters are not expected —
/// this only guards against an empty or path-bearing name reaching `join`.
pub fn dir_name(product_name: &str) -> String {
    let trimmed = product_name.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') {
        return FALLBACK_DIR.to_string();
    }
    trimmed.to_string()
}

/// Call once, as the first thing in `setup`, before anything reads or writes.
/// Later calls are ignored, so the name cannot change under a running app.
pub fn init(product_name: &str) {
    let _ = APP_DIR_NAME.set(dir_name(product_name));
}

/// `~/Library/Application Support/<product name>/`, created if missing.
pub fn app_data_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or("Cannot determine application data directory")?;
    let name = APP_DIR_NAME.get().map(String::as_str).unwrap_or(FALLBACK_DIR);
    let dir = base.join(name);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create data dir: {}", e))?;
    }
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_and_release_names_differ() {
        assert_eq!(dir_name("couplet"), "couplet");
        assert_eq!(dir_name("couplet-dev"), "couplet-dev");
        assert_ne!(dir_name("couplet"), dir_name("couplet-dev"));
    }

    fn product_name_in(config: &str) -> String {
        let value: serde_json::Value = serde_json::from_str(config).expect("config is JSON");
        value["productName"].as_str().expect("productName is set").to_string()
    }

    #[test]
    fn release_product_name_matches_the_config() {
        // The CLI clients reach the app's socket by this constant, the app
        // binds it by the config — renaming one without the other makes
        // `couplet mcp` wait for a socket that never appears.
        assert_eq!(product_name_in(include_str!("../tauri.conf.json")), RELEASE_PRODUCT_NAME);
        assert_eq!(
            product_name_in(include_str!("../tauri.dev.conf.json")),
            format!("{RELEASE_PRODUCT_NAME}-dev")
        );
    }

    #[test]
    fn release_name_is_still_a_recognised_migration_source() {
        // Before `migration.rs` existed, this test asserted `dir_name("md-mini")
        // == FALLBACK_DIR` — i.e. that the release name never changes. That
        // guarantee no longer holds by design: a rename is expected to change
        // it, and `migration.rs` is what keeps an existing install's data
        // reachable across that change. What must still never regress is that
        // "md-mini" — today's release name, and therefore the directory name
        // every currently-installed user's `recovery/` and `session/` already
        // sit under — stays listed as a migration source. Dropping it from
        // `migration::RENAMES` on a future rename, without adding it first,
        // would silently strand every existing install.
        assert!(
            crate::migration::known_legacy_product_names().any(|n| n == "md-mini"),
            "\"md-mini\" must stay listed in migration.rs so existing installs are not stranded by a rename"
        );
    }

    #[test]
    fn unusable_names_fall_back() {
        assert_eq!(dir_name(""), FALLBACK_DIR);
        assert_eq!(dir_name("   "), FALLBACK_DIR);
        assert_eq!(dir_name("../escape"), FALLBACK_DIR);
        assert_eq!(dir_name("a/b"), FALLBACK_DIR);
    }
}
