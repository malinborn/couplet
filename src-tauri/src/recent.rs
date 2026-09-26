//! Recent-files list, persisted in `paths::app_data_dir()/recent.json`.
//!
//! Replaces the frontend's `localStorage`-backed list
//! (`src/lib/stores.svelte.ts`), which lived under
//! `~/Library/WebKit/<bundle id>/...` — a location the pending couplet
//! rebrand changes — and which every window overwrote independently
//! (last writer wins). See docs/investigations/2026-09-23-tabs-options.md §1.

use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

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

/// A missing file is the normal first run; anything else is logged, because
/// the next `add` overwrites whatever was there.
fn read() -> Vec<RecentFile> {
    let path = match recent_file() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Recent files: {}", e);
            return Vec::new();
        }
    };
    match fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_else(|e| {
            eprintln!("Recent files: cannot parse {}: {}", path.display(), e);
            Vec::new()
        }),
        Err(e) if e.kind() == ErrorKind::NotFound => Vec::new(),
        Err(e) => {
            eprintln!("Recent files: cannot read {}: {}", path.display(), e);
            Vec::new()
        }
    }
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

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// What every window is handed: the list plus the version it was taken at.
///
/// Commands run on a multithreaded runtime and emit after the lock is
/// released, so two concurrent adds can broadcast out of order. `version` is
/// bumped under the same lock as the change, which lets a window drop a
/// snapshot older than one it already applied instead of rolling back to it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RecentSnapshot {
    pub version: u64,
    pub files: Vec<RecentFile>,
}

/// The list and its version, with no disk access — `RecentFiles` adds that.
#[derive(Default)]
struct RecentState {
    version: u64,
    files: Vec<RecentFile>,
}

impl RecentState {
    fn snapshot(&self) -> RecentSnapshot {
        RecentSnapshot { version: self.version, files: self.files.clone() }
    }

    /// `false`, with no version bump, for an empty path — same rule as
    /// `import_rule`.
    fn add(&mut self, path: &str, timestamp: u64) -> bool {
        if path.is_empty() {
            return false;
        }
        self.files = touch(std::mem::take(&mut self.files), path, timestamp);
        self.version += 1;
        true
    }

    fn import(&mut self, entries: Vec<RecentFile>) -> bool {
        match import_rule(&self.files, entries) {
            Some(imported) => {
                self.files = imported;
                self.version += 1;
                true
            }
            None => false,
        }
    }
}

/// The live list, shared by every window in this process.
///
/// Built only by `load()`, inside `setup` after `paths::init`: loading reads
/// `recent.json`, and before `init` `app_data_dir()` refuses, so the list
/// would silently load empty. There is deliberately no `Default`, so it
/// cannot be `.manage`d on the builder.
pub struct RecentFiles(Mutex<RecentState>);

impl RecentFiles {
    pub fn load() -> Self {
        Self(Mutex::new(RecentState { version: 0, files: read() }))
    }

    pub fn snapshot(&self) -> RecentSnapshot {
        self.0.lock().unwrap().snapshot()
    }

    /// `None` when nothing changed (an empty path).
    pub fn add(&self, path: &str, timestamp: u64) -> Option<RecentSnapshot> {
        let mut guard = self.0.lock().unwrap();
        if !guard.add(path, timestamp) {
            return None;
        }
        persist(&guard.files);
        Some(guard.snapshot())
    }

    /// One-time import from a window's `localStorage` copy; see `import_rule`.
    /// The flag says whether the list changed, i.e. whether to broadcast.
    pub fn import_if_empty(&self, entries: Vec<RecentFile>) -> (RecentSnapshot, bool) {
        let mut guard = self.0.lock().unwrap();
        let changed = guard.import(entries);
        if changed {
            persist(&guard.files);
        }
        (guard.snapshot(), changed)
    }
}

#[tauri::command]
pub async fn recent_files_list(
    state: tauri::State<'_, RecentFiles>,
) -> Result<RecentSnapshot, String> {
    Ok(state.snapshot())
}

/// The timestamp is taken here rather than by the caller, so every window's
/// entries share one clock.
#[tauri::command]
pub async fn recent_files_add(
    app: tauri::AppHandle,
    state: tauri::State<'_, RecentFiles>,
    path: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let snapshot = state
        .add(&path, now_millis())
        .ok_or_else(|| "Recent files: refusing an empty path".to_string())?;
    let _ = app.emit("recent-changed", &snapshot);
    Ok(())
}

#[tauri::command]
pub async fn recent_files_import(
    app: tauri::AppHandle,
    state: tauri::State<'_, RecentFiles>,
    entries: Vec<RecentFile>,
) -> Result<RecentSnapshot, String> {
    use tauri::Emitter;
    let (snapshot, changed) = state.import_if_empty(entries);
    if changed {
        let _ = app.emit("recent-changed", &snapshot);
    }
    Ok(snapshot)
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

    #[test]
    fn versions_strictly_increase_across_changes() {
        let mut state = RecentState::default();
        let v0 = state.snapshot().version;
        assert!(state.import(vec![rf("/old.md", 1)]));
        let v1 = state.snapshot().version;
        assert!(state.add("/a.md", 2));
        let v2 = state.snapshot().version;
        assert!(state.add("/a.md", 3));
        let v3 = state.snapshot().version;
        assert!(v0 < v1 && v1 < v2 && v2 < v3);
    }

    #[test]
    fn a_no_op_leaves_list_and_version_alone() {
        let mut state = RecentState::default();
        assert!(state.add("/a.md", 1));
        let before = state.snapshot();
        assert!(!state.import(vec![rf("/stale.md", 0)]));
        assert!(!state.add("", 2));
        assert_eq!(state.snapshot(), before);
    }
}
