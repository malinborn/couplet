//! Recent-files list, persisted in `paths::app_data_dir()/recent.json`.
//!
//! Replaces the frontend's `localStorage`-backed list
//! (`src/lib/stores.svelte.ts`), which lived under
//! `~/Library/WebKit/<bundle id>/...` — a location the pending couplet
//! rebrand changes — and which every window overwrote independently
//! (last writer wins). See docs/investigations/2026-09-23-tabs-options.md §1.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const MAX_ENTRIES: usize = 10;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub path: String,
    pub timestamp: u64,
}

/// Move `path` to the front, deduped, capped at `MAX_ENTRIES` — same
/// semantics as today's frontend `createRecentFilesStore.add`.
pub fn touch(list: Vec<RecentFile>, path: &str, timestamp: u64) -> Vec<RecentFile> {
    let mut out = vec![RecentFile { path: path.to_string(), timestamp }];
    out.extend(list.into_iter().filter(|f| f.path != path));
    out.truncate(MAX_ENTRIES);
    out
}

/// What a one-time import from a window's `localStorage` copy does to the
/// shared list: `None` leaves it untouched. Only an empty `current` accepts
/// an import — otherwise a second window importing after the first already
/// wrote real entries would stomp them with a stale browser-side copy. The
/// browser copy is not trusted to be well-formed: empty paths are dropped and
/// duplicates collapse to their first (most recent) occurrence.
fn import_rule(current: &[RecentFile], entries: Vec<RecentFile>) -> Option<Vec<RecentFile>> {
    if !current.is_empty() {
        return None;
    }
    let mut seen = HashSet::new();
    let mut merged: Vec<RecentFile> = entries
        .into_iter()
        .filter(|f| !f.path.is_empty() && seen.insert(f.path.clone()))
        .collect();
    if merged.is_empty() {
        return None;
    }
    merged.truncate(MAX_ENTRIES);
    Some(merged)
}

fn recent_file() -> Result<PathBuf, String> {
    Ok(crate::paths::app_data_dir()?.join("recent.json"))
}

fn read() -> Option<Vec<RecentFile>> {
    let path = recent_file().ok()?;
    let data = fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

/// Same tmp+rename shape as `session.rs::write_session` — this file lives in
/// the app's own data dir, not a user's, so the hardened `atomic_write`
/// is unnecessary here.
fn write(list: &[RecentFile]) -> Result<(), String> {
    let path = recent_file()?;
    let tmp = path.with_extension("json.tmp");
    let data = serde_json::to_string_pretty(list)
        .map_err(|e| format!("Failed to serialize recent files: {}", e))?;
    fs::write(&tmp, &data).map_err(|e| format!("Failed to write recent files: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed to save recent files: {}", e)
    })
}

/// A failed write leaves the in-memory list correct for this run, so it is
/// logged rather than surfaced — the only loss is persistence across a restart.
fn persist(list: &[RecentFile]) {
    if let Err(e) = write(list) {
        eprintln!("Recent files: {}", e);
    }
}

/// The live list, shared by every window in this process.
///
/// Must be constructed inside `setup`, after `paths::init`: `new()` reads
/// `recent.json`, and before `init` `app_data_dir()` answers the release
/// directory name, so a dev build would load the installed app's list.
pub struct RecentFiles(Mutex<Vec<RecentFile>>);

impl RecentFiles {
    pub fn new() -> Self {
        Self(Mutex::new(read().unwrap_or_default()))
    }

    pub fn list(&self) -> Vec<RecentFile> {
        self.0.lock().unwrap().clone()
    }

    pub fn add(&self, path: String, timestamp: u64) -> Vec<RecentFile> {
        let mut guard = self.0.lock().unwrap();
        *guard = touch(std::mem::take(&mut *guard), &path, timestamp);
        persist(&guard);
        guard.clone()
    }

    /// One-time import from a window's `localStorage` copy; see `import_rule`.
    pub fn import_if_empty(&self, entries: Vec<RecentFile>) -> Vec<RecentFile> {
        let mut guard = self.0.lock().unwrap();
        if let Some(imported) = import_rule(&guard, entries) {
            *guard = imported;
            persist(&guard);
        }
        guard.clone()
    }
}

impl Default for RecentFiles {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub async fn recent_files_list(
    state: tauri::State<'_, RecentFiles>,
) -> Result<Vec<RecentFile>, String> {
    Ok(state.list())
}

#[tauri::command]
pub async fn recent_files_add(
    app: tauri::AppHandle,
    state: tauri::State<'_, RecentFiles>,
    path: String,
    timestamp: u64,
) -> Result<(), String> {
    use tauri::Emitter;
    let list = state.add(path, timestamp);
    let _ = app.emit("recent-changed", &list);
    Ok(())
}

#[tauri::command]
pub async fn recent_files_import(
    app: tauri::AppHandle,
    state: tauri::State<'_, RecentFiles>,
    entries: Vec<RecentFile>,
) -> Result<Vec<RecentFile>, String> {
    use tauri::Emitter;
    let list = state.import_if_empty(entries);
    let _ = app.emit("recent-changed", &list);
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rf(path: &str, timestamp: u64) -> RecentFile {
        RecentFile { path: path.to_string(), timestamp }
    }

    fn paths(list: &[RecentFile]) -> Vec<&str> {
        list.iter().map(|f| f.path.as_str()).collect()
    }

    #[test]
    fn touch_adds_to_the_front() {
        let list = touch(vec![rf("/b.md", 1)], "/a.md", 2);
        assert_eq!(list, vec![rf("/a.md", 2), rf("/b.md", 1)]);
    }

    #[test]
    fn touch_moves_an_existing_path_to_the_front_instead_of_duplicating() {
        let list = touch(vec![rf("/a", 1), rf("/b", 2)], "/a", 3);
        assert_eq!(list, vec![rf("/a", 3), rf("/b", 2)]);
    }

    #[test]
    fn touch_caps_at_ten_entries() {
        let list: Vec<RecentFile> = (0..10).map(|i| rf(&format!("/f{}.md", 9 - i), i)).collect();
        let list = touch(list, "/new.md", 99);
        assert_eq!(list.len(), 10);
        assert_eq!(list[0].path, "/new.md");
        assert!(!list.iter().any(|f| f.path == "/f0.md"));
    }

    #[test]
    fn import_into_empty_list_takes_entries_capped_at_ten() {
        let entries: Vec<RecentFile> = (0..12).map(|i| rf(&format!("/f{}.md", i), i)).collect();
        let imported = import_rule(&[], entries).expect("empty store accepts an import");
        assert_eq!(imported.len(), 10);
        assert_eq!(imported[0].path, "/f0.md");
        assert_eq!(imported[9].path, "/f9.md");
    }

    #[test]
    fn import_into_non_empty_list_changes_nothing() {
        assert_eq!(import_rule(&[rf("/real.md", 5)], vec![rf("/stale.md", 1)]), None);
    }

    #[test]
    fn import_of_nothing_changes_nothing() {
        assert_eq!(import_rule(&[], vec![]), None);
    }

    #[test]
    fn import_dedups_by_path_keeping_the_first_occurrence_and_drops_empty_paths() {
        let entries = vec![rf("/a", 3), rf("", 2), rf("/b", 2), rf("/a", 1)];
        let imported = import_rule(&[], entries).expect("has valid entries");
        assert_eq!(paths(&imported), vec!["/a", "/b"]);
        assert_eq!(imported[0].timestamp, 3);
    }

    #[test]
    fn import_of_only_empty_paths_changes_nothing() {
        assert_eq!(import_rule(&[], vec![rf("", 1)]), None);
    }
}
