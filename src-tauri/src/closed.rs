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

/// Whether a just-destroyed window should be pushed onto the stack at all.
pub fn should_push_on_close(is_quitting: bool, path: Option<&str>) -> bool {
    !is_quitting && path.is_some()
}

/// Push the window `label` onto `stack` as it is being destroyed. Returns
/// whether anything was pushed. Call before `SessionState::remove(label)`.
///
/// `open_path` is the file the window shows *now*, from `OpenFiles`. The
/// session entry only knows the last heartbeat, up to 5 s old: a Save As from
/// Untitled followed by Cmd+W would read as Untitled, and a file switched to
/// just before closing would reopen the one before it. The entry still gives
/// the geometry, and the caret too when it describes the same file — a caret
/// from another document means nothing here, so that case starts at the top.
pub fn record_close(
    session: &crate::session::SessionState,
    stack: &ClosedStack,
    label: &str,
    open_path: Option<&str>,
) -> bool {
    if !should_push_on_close(session.is_quitting(), open_path) {
        return false;
    }
    let Some(path) = open_path else {
        return false;
    };
    let snap = session.snapshot_for(label);
    let (cursor, top_line) = match &snap {
        Some(s) if s.path.as_deref() == Some(path) => (s.cursor, s.top_line),
        _ => (0, 1),
    };
    let (x, y, width, height) = snap
        .as_ref()
        .map(|s| (s.x, s.y, s.width, s.height))
        .unwrap_or((0, 0, 0, 0));
    stack.push_entry(ClosedEntry {
        path: path.to_string(),
        cursor,
        top_line,
        x,
        y,
        width,
        height,
    });
    true
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
///
/// Lock order: `ClosedStack` → `OpenFiles` (`reopen_closed`'s liveness check
/// runs under this lock). Never lock this while holding `OpenFiles` — read
/// the path out and drop that guard first, as the `Destroyed` handler does.
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
/// session restore.
///
/// A file that is open in some window again by now is not live either:
/// reopening it would only focus that window and use up the press, while the
/// entry below it — the one the user actually wants back — waits.
pub fn reopen_closed(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    let is_open = |p: &str| {
        let open_files = app.state::<crate::window::OpenFiles>();
        let reg = open_files.0.lock().unwrap();
        reg.label_of(p)
            .is_some_and(|label| app.get_webview_window(&label).is_some())
    };
    let Some(entry) = app
        .state::<ClosedStack>()
        .pop_live(|p| std::path::Path::new(p).exists() && !is_open(p))
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

    use crate::session::SessionState;

    /// A session whose `editor-1` last heartbeat reported `/tmp/a.md`.
    fn session_with_heartbeat(path: Option<&str>) -> SessionState {
        let session = SessionState::new();
        session.set_geometry("editor-1", 11, 22, 800, 600);
        session.set_document("editor-1", path.map(str::to_string), 42, 9);
        session
    }

    fn only_entry(stack: &ClosedStack) -> ClosedEntry {
        assert_eq!(stack.count(), 1);
        stack.pop_live(|_| true).expect("one entry")
    }

    #[test]
    fn record_close_pushes_a_file_window_with_its_position_and_geometry() {
        let session = session_with_heartbeat(Some("/tmp/a.md"));
        let stack = ClosedStack::new();
        assert!(record_close(&session, &stack, "editor-1", Some("/tmp/a.md")));
        assert_eq!(
            only_entry(&stack),
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
    }

    #[test]
    fn record_close_skips_an_untitled_window() {
        let session = session_with_heartbeat(None);
        let stack = ClosedStack::new();
        assert!(!record_close(&session, &stack, "editor-1", None));
        assert_eq!(stack.count(), 0);
    }

    #[test]
    fn record_close_pushes_nothing_while_quitting() {
        let session = session_with_heartbeat(Some("/tmp/a.md"));
        session.mark_quitting();
        let stack = ClosedStack::new();
        assert!(!record_close(&session, &stack, "editor-1", Some("/tmp/a.md")));
        assert_eq!(stack.count(), 0);
    }

    #[test]
    fn record_close_trusts_the_open_path_over_a_stale_heartbeat() {
        // The last heartbeat still names the file shown before a switch (or
        // nothing, before a Save As from Untitled).
        for stale in [Some("/tmp/old.md"), None] {
            let session = session_with_heartbeat(stale);
            let stack = ClosedStack::new();
            assert!(record_close(&session, &stack, "editor-1", Some("/tmp/new.md")));
            let e = only_entry(&stack);
            assert_eq!(e.path, "/tmp/new.md");
            assert_eq!((e.cursor, e.top_line), (0, 1), "the caret belonged to another document");
            assert_eq!((e.x, e.y, e.width, e.height), (11, 22, 800, 600));
        }
    }

    #[test]
    fn record_close_without_any_session_entry_still_pushes_the_file() {
        let stack = ClosedStack::new();
        assert!(record_close(&SessionState::new(), &stack, "editor-9", Some("/tmp/a.md")));
        let e = only_entry(&stack);
        assert_eq!((e.path.as_str(), e.cursor, e.top_line), ("/tmp/a.md", 0, 1));
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
