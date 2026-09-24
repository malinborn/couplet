//! Stack of recently closed tabs, for Cmd+Shift+T.
//!
//! Only tabs showing a **saved file** are pushed — ⌘W on an untitled tab is a
//! deliberate, permanent discard (spec §8) — and nothing is pushed while
//! quitting: those windows come back through session restore instead.
//!
//! An entry remembers the window it was closed from, and ⌘⇧T puts the tab
//! back there while that window lives: a window has a project, and a tab
//! dropped into another project's window would break that binding. When the
//! window is gone the tab comes back in a new window, and the other tabs
//! closed with the same window follow it there (`revived`) instead of each
//! getting a window of its own.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::session::SessionState;
use crate::tabs::{RegTab, WindowTabs};

const MAX_ENTRIES: usize = 20;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedEntry {
    pub path: String,
    pub cursor: usize,
    pub top_line: usize,
    /// The window the tab was closed from.
    pub label: String,
    pub number: Option<u32>,
    /// That window's geometry in logical pixels, as `SessionState` records it
    /// — used when the tab has to come back in a new window.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Whether a closing tab should be pushed onto the stack at all.
pub fn should_push_on_close(is_quitting: bool, path: Option<&str>) -> bool {
    !is_quitting && path.is_some()
}

fn geometry_of(session: &SessionState, label: &str) -> (i32, i32, u32, u32) {
    session
        .snapshot_for(label)
        .map(|s| (s.x, s.y, s.width, s.height))
        .unwrap_or((0, 0, 0, 0))
}

/// ⌘W on one tab. The caret comes from the frontend at the moment of the
/// close; the heartbeat's copy is up to 5 s old.
pub fn record_tab_close(
    session: &SessionState,
    stack: &ClosedStack,
    label: &str,
    number: Option<u32>,
    path: &str,
    cursor: usize,
    top_line: usize,
) -> bool {
    if !should_push_on_close(session.is_quitting(), Some(path)) {
        return false;
    }
    let (x, y, width, height) = geometry_of(session, label);
    stack.push_entry(ClosedEntry {
        path: path.to_string(),
        cursor,
        top_line,
        label: label.to_string(),
        number,
        x,
        y,
        width,
        height,
    });
    true
}

/// A closing window's file tabs in push order: the active one last, so it is
/// the first one ⌘⇧T brings back.
pub fn close_order(window: &WindowTabs) -> Vec<&RegTab> {
    let (active, rest): (Vec<&RegTab>, Vec<&RegTab>) = window
        .tabs
        .iter()
        .filter(|t| t.path.is_some())
        .partition(|t| window.active.as_deref() == Some(t.id.as_str()));
    rest.into_iter().chain(active).collect()
}

/// A whole window destroyed — the red button, or ⌘W on its last tab (that
/// tab was already recorded and removed by `tab_close`). Each caret comes
/// from the last heartbeat when it describes the same tab and file, else the
/// tab starts at the top. Returns how many entries were pushed.
pub fn record_window_close(
    session: &SessionState,
    stack: &ClosedStack,
    label: &str,
    window: &WindowTabs,
) -> usize {
    if session.is_quitting() {
        return 0;
    }
    let snap = session.snapshot_for(label);
    let (x, y, width, height) = snap
        .as_ref()
        .map(|s| (s.x, s.y, s.width, s.height))
        .unwrap_or((0, 0, 0, 0));
    let mut pushed = 0;
    for tab in close_order(window) {
        let Some(path) = tab.path.as_deref() else { continue };
        let (cursor, top_line) = snap
            .as_ref()
            .and_then(|s| {
                s.tabs
                    .iter()
                    .find(|t| t.tab_id == tab.id && t.path.as_deref() == Some(path))
            })
            .map(|t| (t.cursor, t.top_line))
            .unwrap_or((0, 1));
        stack.push_entry(ClosedEntry {
            path: path.to_string(),
            cursor,
            top_line,
            label: label.to_string(),
            number: window.number,
            x,
            y,
            width,
            height,
        });
        pushed += 1;
    }
    pushed
}

/// Push `entry` to the top, deduped by path, capped at `MAX_ENTRIES`.
pub fn push(stack: Vec<ClosedEntry>, entry: ClosedEntry) -> Vec<ClosedEntry> {
    let mut out = vec![entry.clone()];
    out.extend(stack.into_iter().filter(|e| e.path != entry.path));
    out.truncate(MAX_ENTRIES);
    out
}

/// Take the most recent entry whose file still exists, dropping every dead
/// entry above it on the way. A file deleted or moved since its tab closed
/// would otherwise reopen as a tab that fails to load, and Cmd+Shift+T would
/// look broken while live entries sit right below it.
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

#[derive(Debug, PartialEq, Eq)]
pub enum ReopenTarget {
    Window(String),
    NewWindow,
}

/// Where a closed tab comes back: the window it was closed from while it
/// lives; else the window an earlier tab of that same closed window was
/// revived into; else a new window.
pub fn reopen_target(
    entry_label: &str,
    is_live: impl Fn(&str) -> bool,
    revived: &HashMap<String, String>,
) -> ReopenTarget {
    if is_live(entry_label) {
        return ReopenTarget::Window(entry_label.to_string());
    }
    match revived.get(entry_label) {
        Some(new_label) if is_live(new_label) => ReopenTarget::Window(new_label.clone()),
        _ => ReopenTarget::NewWindow,
    }
}

#[derive(Default)]
struct Inner {
    entries: Vec<ClosedEntry>,
    /// Closed window label → the window its tabs are coming back into.
    revived: HashMap<String, String>,
}

/// The live stack, shared by every window in this process. Not persisted —
/// it exists to undo an accidental close a moment ago; session restore covers
/// a restart.
///
/// Lock order: `ClosedStack` → `OpenFiles` (`reopen_closed`'s liveness check
/// runs under this lock). Never lock this while holding `OpenFiles` — read
/// what you need and drop that guard first, as the `Destroyed` handler does.
pub struct ClosedStack(Mutex<Inner>);

impl ClosedStack {
    pub fn new() -> Self {
        Self(Mutex::new(Inner::default()))
    }

    pub fn push_entry(&self, entry: ClosedEntry) {
        let mut inner = self.0.lock().unwrap();
        inner.entries = push(std::mem::take(&mut inner.entries), entry);
    }

    /// Pop the most recently closed entry whose file still exists, if any.
    pub fn pop_live(&self, exists: impl Fn(&str) -> bool) -> Option<ClosedEntry> {
        pop_live(&mut self.0.lock().unwrap().entries, exists)
    }

    pub fn count(&self) -> usize {
        self.0.lock().unwrap().entries.len()
    }

    pub fn target_for(&self, label: &str, is_live: impl Fn(&str) -> bool) -> ReopenTarget {
        reopen_target(label, is_live, &self.0.lock().unwrap().revived)
    }

    pub fn record_revival(&self, closed_label: &str, new_label: &str) {
        self.0
            .lock()
            .unwrap()
            .revived
            .insert(closed_label.to_string(), new_label.to_string());
    }
}

impl Default for ClosedStack {
    fn default() -> Self {
        Self::new()
    }
}

/// What `reopen-tab` carries to a mounted window. The tab is not registered:
/// the frontend opens it through `tab_open` at this caret, and must have its
/// listener in place before it pulls `get_window_init` — an entry sent to a
/// window without one is gone.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReopenTab {
    pub path: String,
    pub cursor: usize,
    pub top_line: usize,
}

/// Pop the most recently closed tab and bring it back. Returns `false` (and
/// does nothing) when no live entry is left, so callers can fall back to
/// session restore.
///
/// A file that is open in some tab again by now is not live either:
/// reopening it would only focus that tab and use up the press, while the
/// entry below it — the one the user actually wants back — waits.
pub fn reopen_closed(app: &tauri::AppHandle) -> bool {
    use tauri::{Emitter, Manager};
    let is_open = |p: &str| {
        let open_files = app.state::<crate::window::OpenFiles>();
        let reg = open_files.0.lock().unwrap();
        reg.label_of(p)
            .is_some_and(|label| app.get_webview_window(&label).is_some())
    };
    let stack = app.state::<ClosedStack>();
    let is_open = |p: &str| is_open(&crate::path_norm::normalize_str(p));
    let Some(mut entry) = stack.pop_live(|p| std::path::Path::new(p).exists() && !is_open(p)) else {
        return false;
    };
    // Recorded from the registry, so normally spelled right already; this is
    // the one door every reopen passes, and both branches below register it.
    entry.path = crate::path_norm::normalize_str(&entry.path);
    let is_live = |label: &str| app.get_webview_window(label).is_some();
    match stack.target_for(&entry.label, is_live) {
        ReopenTarget::Window(label) => {
            // A window revived a moment ago may not have mounted yet, and an
            // event sent to it now would be lost with the entry.
            let tab = crate::window::PendingTab {
                tab_id: crate::session::new_tab_id(),
                path: Some(entry.path.clone()),
                content: None,
                cursor: entry.cursor,
                top_line: entry.top_line,
                ..Default::default()
            };
            let reveal_label = match crate::window::hand_over_tab(app, &label, tab) {
                crate::window::Handover::Pending => label,
                crate::window::Handover::Mounted => {
                    let _ = app.emit_to(
                        label.as_str(),
                        "reopen-tab",
                        ReopenTab {
                            path: entry.path,
                            cursor: entry.cursor,
                            top_line: entry.top_line,
                        },
                    );
                    label
                }
                crate::window::Handover::Held(owner) => owner,
            };
            if let Some(win) = app.get_webview_window(&reveal_label) {
                crate::window::reveal(&win);
            }
        }
        ReopenTarget::NewWindow => {
            let closed_label = entry.label.clone();
            let snapshot = crate::session::WindowSnapshot::from_closed_entry(entry);
            if let Some(new_label) = crate::window::open_restored_window(app, &snapshot) {
                stack.record_revival(&closed_label, &new_label);
            }
        }
    }
    true
}

/// Bring the "Reopen…" menu item in line with what Cmd+Shift+T would do now.
/// Call after anything that changes the closed stack or the pending restore.
pub fn refresh_reopen_item(app: &tauri::AppHandle) {
    use tauri::Manager;
    let (Some(items), Some(stack), Some(session)) = (
        app.try_state::<crate::menu::SessionMenuItems>(),
        app.try_state::<ClosedStack>(),
        app.try_state::<SessionState>(),
    ) else {
        return;
    };
    items.sync(stack.count(), session.pending_count());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::TabSnapshot;

    fn entry(path: &str) -> ClosedEntry {
        ClosedEntry {
            path: path.to_string(),
            cursor: 7,
            top_line: 3,
            label: "editor-1".to_string(),
            number: Some(4),
            x: 10,
            y: 20,
            width: 900,
            height: 700,
        }
    }

    fn paths(stack: &[ClosedEntry]) -> Vec<&str> {
        stack.iter().map(|e| e.path.as_str()).collect()
    }

    fn reg_tab(id: &str, path: Option<&str>) -> RegTab {
        RegTab { id: id.to_string(), path: path.map(str::to_string) }
    }

    fn snap_tab(id: &str, path: &str, cursor: usize, top_line: usize) -> TabSnapshot {
        TabSnapshot { tab_id: id.to_string(), path: Some(path.to_string()), untitled: None, cursor, top_line, ..Default::default() }
    }

    /// `editor-1` at 11,22 800×600, whose last heartbeat reported `tabs`.
    fn session_with(tabs: Vec<TabSnapshot>) -> SessionState {
        let session = SessionState::new();
        session.set_geometry("editor-1", 11, 22, 800, 600);
        session.set_tabs("editor-1", tabs, None);
        session
    }

    #[test]
    fn should_push_on_close_requires_a_path() {
        assert!(should_push_on_close(false, Some("/tmp/a.md")));
        assert!(!should_push_on_close(false, None), "⌘W on untitled is a deliberate discard");
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

    #[test]
    fn record_tab_close_pushes_the_live_caret_with_the_windows_geometry_and_number() {
        let session = session_with(vec![snap_tab("t1", "/tmp/a.md", 1, 1)]);
        let stack = ClosedStack::new();
        assert!(record_tab_close(&session, &stack, "editor-1", Some(7), "/tmp/a.md", 42, 9));
        assert_eq!(
            stack.pop_live(|_| true).unwrap(),
            ClosedEntry {
                path: "/tmp/a.md".to_string(),
                cursor: 42,
                top_line: 9,
                label: "editor-1".to_string(),
                number: Some(7),
                x: 11,
                y: 22,
                width: 800,
                height: 600,
            }
        );
    }

    #[test]
    fn record_tab_close_pushes_nothing_while_quitting() {
        let session = session_with(vec![]);
        session.mark_quitting();
        let stack = ClosedStack::new();
        assert!(!record_tab_close(&session, &stack, "editor-1", None, "/tmp/a.md", 0, 1));
        assert_eq!(stack.count(), 0);
    }

    #[test]
    fn close_order_puts_the_active_file_tab_last_and_skips_untitled() {
        let window = WindowTabs {
            tabs: vec![reg_tab("a", Some("/a.md")), reg_tab("u", None), reg_tab("b", Some("/b.md"))],
            active: Some("a".to_string()),
            ..WindowTabs::default()
        };
        let ids: Vec<&str> = close_order(&window).iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a"]);
    }

    #[test]
    fn record_window_close_pushes_every_file_tab_active_on_top() {
        // `b`'s heartbeat still names the file it showed before a Save As.
        let session = session_with(vec![snap_tab("a", "/a.md", 5, 2), snap_tab("b", "/old.md", 9, 9)]);
        let window = WindowTabs {
            tabs: vec![reg_tab("a", Some("/a.md")), reg_tab("u", None), reg_tab("b", Some("/b.md"))],
            active: Some("a".to_string()),
            number: Some(3),
            ..WindowTabs::default()
        };
        let stack = ClosedStack::new();
        assert_eq!(record_window_close(&session, &stack, "editor-1", &window), 2);

        let first = stack.pop_live(|_| true).unwrap();
        assert_eq!((first.path.as_str(), first.cursor, first.top_line), ("/a.md", 5, 2));
        assert_eq!((first.number, first.x, first.width), (Some(3), 11, 800));
        let second = stack.pop_live(|_| true).unwrap();
        assert_eq!(
            (second.path.as_str(), second.cursor, second.top_line),
            ("/b.md", 0, 1),
            "a caret from another file means nothing here"
        );
    }

    #[test]
    fn record_window_close_without_any_session_entry_still_pushes_its_files() {
        let window = WindowTabs {
            tabs: vec![reg_tab("a", Some("/a.md"))],
            ..WindowTabs::default()
        };
        let stack = ClosedStack::new();
        assert_eq!(record_window_close(&SessionState::new(), &stack, "editor-9", &window), 1);
        let e = stack.pop_live(|_| true).unwrap();
        assert_eq!((e.path.as_str(), e.cursor, e.top_line, e.label.as_str()), ("/a.md", 0, 1, "editor-9"));
    }

    #[test]
    fn record_window_close_pushes_nothing_while_quitting() {
        let session = session_with(vec![]);
        session.mark_quitting();
        let window = WindowTabs {
            tabs: vec![reg_tab("a", Some("/a.md"))],
            ..WindowTabs::default()
        };
        assert_eq!(record_window_close(&session, &ClosedStack::new(), "editor-1", &window), 0);
    }

    #[test]
    fn reopen_target_prefers_the_window_it_was_closed_from() {
        assert_eq!(
            reopen_target("editor-1", |_| true, &HashMap::new()),
            ReopenTarget::Window("editor-1".to_string())
        );
    }

    #[test]
    fn reopen_target_follows_a_revived_window() {
        let revived = HashMap::from([("editor-1".to_string(), "editor-9".to_string())]);
        assert_eq!(
            reopen_target("editor-1", |l| l == "editor-9", &revived),
            ReopenTarget::Window("editor-9".to_string())
        );
    }

    #[test]
    fn reopen_target_opens_a_new_window_when_neither_lives() {
        let revived = HashMap::from([("editor-1".to_string(), "editor-9".to_string())]);
        assert_eq!(reopen_target("editor-1", |_| false, &revived), ReopenTarget::NewWindow);
        assert_eq!(reopen_target("editor-1", |_| false, &HashMap::new()), ReopenTarget::NewWindow);
    }

    #[test]
    fn a_recorded_revival_steers_the_next_entry_of_that_window() {
        let stack = ClosedStack::new();
        assert_eq!(stack.target_for("editor-1", |l| l == "editor-9"), ReopenTarget::NewWindow);
        stack.record_revival("editor-1", "editor-9");
        assert_eq!(
            stack.target_for("editor-1", |l| l == "editor-9"),
            ReopenTarget::Window("editor-9".to_string())
        );
    }
}
