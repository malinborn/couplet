//! Stack of recently-closed windows, for Cmd+Shift+T.
//!
//! Only windows that were showing a **saved file** are pushed — an Untitled
//! window's Cmd+W is a deliberate, permanent discard (design doc §8), and a
//! window closed as part of quitting is not "closed" in this sense at all:
//! `SessionState`'s `quitting` flag exists so those windows come back via
//! session restore instead.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const MAX_ENTRIES: usize = 20;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedEntry {
    pub path: String,
    pub cursor: usize,
    pub top_line: usize,
    /// Geometry in logical pixels, as `SessionState` records it
    /// (`session::window_geometry`) and `open_restored_window` consumes it.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl ClosedEntry {
    /// The entry for a window about to be forgotten, or `None` if it should
    /// not be pushed at all — see `should_push_on_close`.
    pub fn from_snapshot(
        is_quitting: bool,
        snapshot: &crate::session::WindowSnapshot,
    ) -> Option<Self> {
        if !should_push_on_close(is_quitting, snapshot.path.as_deref()) {
            return None;
        }
        Some(Self {
            path: snapshot.path.clone()?,
            cursor: snapshot.cursor,
            top_line: snapshot.top_line,
            x: snapshot.x,
            y: snapshot.y,
            width: snapshot.width,
            height: snapshot.height,
        })
    }
}

/// Whether a just-destroyed window should be pushed onto the stack at all.
pub fn should_push_on_close(is_quitting: bool, path: Option<&str>) -> bool {
    !is_quitting && path.is_some()
}

/// Push `entry` to the top, deduped by path, capped at `MAX_ENTRIES`.
pub fn push(stack: Vec<ClosedEntry>, entry: ClosedEntry) -> Vec<ClosedEntry> {
    let mut out = vec![entry.clone()];
    out.extend(stack.into_iter().filter(|e| e.path != entry.path));
    out.truncate(MAX_ENTRIES);
    out
}

/// Take the most recent entry whose file still exists, dropping every dead
/// entry above it on the way. A file deleted or moved since its window closed
/// would otherwise reopen as a window that fails to load, and Cmd+Shift+T
/// would look broken while live entries sit right below it.
pub fn pop_live(
    stack: &mut Vec<ClosedEntry>,
    exists: impl Fn(&str) -> bool,
) -> Option<ClosedEntry> {
    while !stack.is_empty() {
        let entry = stack.remove(0);
        if exists(&entry.path) {
            return Some(entry);
        }
    }
    None
}

/// The live stack, shared by every window in this process. Not persisted —
/// it exists to undo an accidental Cmd+W a moment ago, not to survive a
/// restart (session restore already covers that case).
pub struct ClosedStack(Mutex<Vec<ClosedEntry>>);

impl ClosedStack {
    pub fn new() -> Self {
        Self(Mutex::new(Vec::new()))
    }

    pub fn push_entry(&self, entry: ClosedEntry) {
        let mut guard = self.0.lock().unwrap();
        *guard = push(std::mem::take(&mut *guard), entry);
    }

    /// Pop the most recently closed entry whose file still exists, if any.
    pub fn pop_live(&self, exists: impl Fn(&str) -> bool) -> Option<ClosedEntry> {
        pop_live(&mut self.0.lock().unwrap(), exists)
    }

    pub fn count(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

impl Default for ClosedStack {
    fn default() -> Self {
        Self::new()
    }
}

/// Pop the most recently closed entry and reopen it. Returns `false` (and
/// does nothing) when no live entry is left, so callers can fall back to
/// session restore. Reuses `open_restored_window`'s dedup: a file that is
/// open again by now gets its window focused instead of a duplicate.
pub fn reopen_closed(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    let Some(entry) = app
        .state::<ClosedStack>()
        .pop_live(|p| std::path::Path::new(p).exists())
    else {
        return false;
    };
    let snapshot = crate::session::WindowSnapshot::from_closed_entry(entry);
    crate::window::open_restored_window(app, &snapshot);
    true
}

/// Bring the "Reopen…" menu item in line with what Cmd+Shift+T would do now.
/// Call after anything that changes the closed stack or the pending restore.
pub fn refresh_reopen_item(app: &tauri::AppHandle) {
    use tauri::Manager;
    let (Some(items), Some(stack), Some(session)) = (
        app.try_state::<crate::menu::SessionMenuItems>(),
        app.try_state::<ClosedStack>(),
        app.try_state::<crate::session::SessionState>(),
    ) else {
        return;
    };
    items.sync(stack.count(), session.pending_count());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str) -> ClosedEntry {
        ClosedEntry {
            path: path.to_string(),
            cursor: 7,
            top_line: 3,
            x: 10,
            y: 20,
            width: 900,
            height: 700,
        }
    }

    fn paths(stack: &[ClosedEntry]) -> Vec<&str> {
        stack.iter().map(|e| e.path.as_str()).collect()
    }

    #[test]
    fn should_push_on_close_requires_a_path() {
        assert!(should_push_on_close(false, Some("/tmp/a.md")));
        assert!(
            !should_push_on_close(false, None),
            "an Untitled window's Cmd+W is a deliberate discard"
        );
    }

    #[test]
    fn should_push_on_close_is_false_while_quitting() {
        assert!(
            !should_push_on_close(true, Some("/tmp/a.md")),
            "windows closed by a quit come back via session restore"
        );
    }

    #[test]
    fn push_adds_to_front() {
        let stack = push(vec![entry("/a")], entry("/b"));
        assert_eq!(paths(&stack), vec!["/b", "/a"]);
    }

    #[test]
    fn push_dedups_by_path_moving_it_to_front() {
        let stack = push(vec![entry("/a"), entry("/b"), entry("/c")], entry("/b"));
        assert_eq!(paths(&stack), vec!["/b", "/a", "/c"]);
    }

    #[test]
    fn push_caps_at_twenty() {
        let mut stack = Vec::new();
        for i in 0..25 {
            stack = push(stack, entry(&format!("/f{}", i)));
        }
        assert_eq!(stack.len(), MAX_ENTRIES);
        assert_eq!(stack[0].path, "/f24", "newest stays on top");
        assert_eq!(stack[MAX_ENTRIES - 1].path, "/f5", "oldest fall off");
    }

    #[test]
    fn from_snapshot_copies_position_and_geometry() {
        let snap = crate::session::WindowSnapshot {
            path: Some("/tmp/a.md".to_string()),
            untitled: None,
            x: 11,
            y: 22,
            width: 800,
            height: 600,
            cursor: 42,
            top_line: 9,
            tab_id: crate::session::new_tab_id(),
        };
        let e = ClosedEntry::from_snapshot(false, &snap).expect("saved file is pushed");
        assert_eq!(
            e,
            ClosedEntry {
                path: "/tmp/a.md".to_string(),
                cursor: 42,
                top_line: 9,
                x: 11,
                y: 22,
                width: 800,
                height: 600,
            }
        );
        assert!(ClosedEntry::from_snapshot(true, &snap).is_none());
        let untitled = crate::session::WindowSnapshot { path: None, ..snap };
        assert!(ClosedEntry::from_snapshot(false, &untitled).is_none());
    }

    #[test]
    fn stack_pops_most_recent_first() {
        let stack = ClosedStack::new();
        stack.push_entry(entry("/a"));
        stack.push_entry(entry("/b"));
        assert_eq!(stack.pop_live(|_| true).map(|e| e.path), Some("/b".to_string()));
        assert_eq!(stack.pop_live(|_| true).map(|e| e.path), Some("/a".to_string()));
        assert_eq!(stack.count(), 0);
    }

    #[test]
    fn stack_pop_on_empty_is_none() {
        assert!(ClosedStack::new().pop_live(|_| true).is_none());
    }

    #[test]
    fn pop_live_skips_and_drops_entries_whose_file_is_gone() {
        let mut stack = vec![entry("/gone1"), entry("/gone2"), entry("/live"), entry("/older")];
        let popped = pop_live(&mut stack, |p| !p.starts_with("/gone"));
        assert_eq!(popped.map(|e| e.path), Some("/live".to_string()));
        assert_eq!(paths(&stack), vec!["/older"], "dead entries above it are discarded");
    }

    #[test]
    fn pop_live_with_only_dead_entries_empties_the_stack() {
        let mut stack = vec![entry("/gone1"), entry("/gone2")];
        assert!(pop_live(&mut stack, |_| false).is_none());
        assert!(stack.is_empty());
    }
}
