//! Where a native menu action is delivered.
//!
//! The handler used to emit `menu-event` once per window in a loop. A
//! window's `emit` is a broadcast to every target, and `onMenuEvent` listened
//! globally — which also receives targeted emits — so with N windows every
//! window handled every action N times. Idempotent preferences survived that;
//! `toggle_mode` (a cycle) and anything acting on a document did not.
//!
//! Now each action is emitted exactly once: a preference to every window,
//! a document action to the window the user was last in.

use std::sync::Mutex;

#[derive(Debug, PartialEq, Eq)]
pub enum MenuRoute {
    /// A process-wide preference: every window applies it to itself, once.
    Broadcast,
    /// Acts on one document: the window the user is in, and no other.
    Focused,
}

pub fn menu_route(id: &str) -> MenuRoute {
    const BROADCAST_PREFIXES: [&str; 3] = ["engine_", "theme_", "toggle_ocd_alignment"];
    match id {
        "toggle_mode" | "zoom_in" | "zoom_out" | "zoom_reset" | "toggle_line_glow" => {
            MenuRoute::Broadcast
        }
        _ if BROADCAST_PREFIXES.iter().any(|p| id.starts_with(p)) => MenuRoute::Broadcast,
        _ => MenuRoute::Focused,
    }
}

/// The window that most recently gained focus.
///
/// `WebviewWindow::is_focused()` queried from the menu handler is not
/// reliable: while the menu bar is being used, the OS may report no window as
/// focused. The last `WindowEvent::Focused(true)` is — clicking the menu bar
/// or pressing an accelerator does not move key-window status.
pub struct FocusTracker(Mutex<Option<String>>);

impl FocusTracker {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub fn focused(&self, label: &str) {
        *self.0.lock().unwrap() = Some(label.to_string());
    }

    /// A destroyed window stops being the target; any other window is left alone.
    pub fn forget(&self, label: &str) {
        let mut last = self.0.lock().unwrap();
        if last.as_deref() == Some(label) {
            *last = None;
        }
    }

    pub fn last(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }
}

impl Default for FocusTracker {
    fn default() -> Self {
        Self::new()
    }
}

/// The window a document action goes to: the last focused one while it lives,
/// else the first in session order (`main`, then `editor-N` ascending) so the
/// fallback never depends on `HashMap` iteration order.
pub fn menu_target(last_focused: Option<&str>, live: &[String]) -> Option<String> {
    if let Some(label) = last_focused {
        if live.iter().any(|l| l == label) {
            return Some(label.to_string());
        }
    }
    live.iter()
        .min_by_key(|l| crate::session::label_order(l))
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn preferences_are_broadcast_once_to_every_window() {
        for id in [
            "toggle_mode",
            "engine_raw",
            "engine_live_render",
            "zoom_in",
            "zoom_out",
            "zoom_reset",
            "toggle_line_glow",
            "toggle_ocd_alignment:on",
            "theme_family_aurora",
            "theme_half_dark",
            "theme_system:off",
        ] {
            assert_eq!(menu_route(id), MenuRoute::Broadcast, "{id}");
        }
    }

    #[test]
    fn document_actions_go_to_one_window() {
        for id in [
            "open", "save", "save_as", "close", "select_all", "find", "recent_files",
            "ai_comment", "ai_watch_command", "format_json", "new_tab", "next_tab",
            "prev_tab", "select_tab_1", "select_tab_9",
        ] {
            assert_eq!(menu_route(id), MenuRoute::Focused, "{id}");
        }
    }

    #[test]
    fn target_is_the_last_focused_window_while_it_lives() {
        assert_eq!(
            menu_target(Some("editor-3"), &labels(&["main", "editor-3"])),
            Some("editor-3".to_string())
        );
    }

    #[test]
    fn a_dead_last_focused_window_falls_back_to_main_then_lowest_editor() {
        assert_eq!(
            menu_target(Some("editor-9"), &labels(&["editor-4", "main", "editor-2"])),
            Some("main".to_string())
        );
        assert_eq!(
            menu_target(Some("editor-9"), &labels(&["editor-10", "editor-2"])),
            Some("editor-2".to_string())
        );
    }

    #[test]
    fn nothing_focused_yet_falls_back_too() {
        assert_eq!(menu_target(None, &labels(&["editor-2", "main"])), Some("main".to_string()));
    }

    #[test]
    fn no_windows_means_no_target() {
        assert_eq!(menu_target(Some("main"), &[]), None);
    }

    #[test]
    fn tracker_remembers_the_last_focus_and_forgets_only_that_window() {
        let tracker = FocusTracker::new();
        assert_eq!(tracker.last(), None);
        tracker.focused("main");
        tracker.focused("editor-2");
        assert_eq!(tracker.last().as_deref(), Some("editor-2"));
        tracker.forget("main");
        assert_eq!(tracker.last().as_deref(), Some("editor-2"), "forgetting another window changes nothing");
        tracker.forget("editor-2");
        assert_eq!(tracker.last(), None);
    }
}
