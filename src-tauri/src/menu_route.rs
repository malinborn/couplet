//! Where a native menu action is delivered.
//!
//! Each action must be emitted exactly once: a preference to every window, a
//! document action to the window the user was last in. A window-level `emit`
//! is itself a broadcast to every target, and a global `listen` also matches
//! targeted emits, so emitting per window — or listening globally — makes N
//! windows handle every action N times. Idempotent preferences survive that;
//! `toggle_mode` (a cycle) and anything acting on a document do not.

use std::sync::Mutex;

#[derive(Debug, PartialEq, Eq)]
pub enum MenuRoute {
    /// A process-wide preference: every window applies it to itself, once.
    Broadcast,
    /// Acts on one document: the window the user is in, and no other.
    Focused,
}

pub fn menu_route(id: &str) -> MenuRoute {
    const BROADCAST_PREFIXES: [&str; 4] =
        ["engine_", "theme_", "toggle_ocd_alignment", "toggle_tabs_compact"];
    match id {
        "toggle_mode" | "zoom_in" | "zoom_out" | "zoom_reset" | "toggle_line_glow" => {
            MenuRoute::Broadcast
        }
        _ if BROADCAST_PREFIXES.iter().any(|p| id.starts_with(p)) => MenuRoute::Broadcast,
        _ => MenuRoute::Focused,
    }
}

/// The windows in the order they last gained focus, most recent first.
///
/// `WebviewWindow::is_focused()` queried from the menu handler is not
/// reliable: while the menu bar is being used, the OS may report no window as
/// focused. The last `WindowEvent::Focused(true)` is — clicking the menu bar
/// or pressing an accelerator does not move key-window status. The whole
/// order is what agent routing breaks ties with (spec §5 step 3).
pub struct FocusTracker(Mutex<Vec<String>>);

impl FocusTracker {
    pub fn new() -> Self {
        Self(Mutex::new(Vec::new()))
    }

    pub fn focused(&self, label: &str) {
        let mut order = self.0.lock().unwrap();
        order.retain(|l| l != label);
        order.insert(0, label.to_string());
    }

    /// A destroyed window leaves the order; the window focused before it
    /// becomes the last one.
    pub fn forget(&self, label: &str) {
        self.0.lock().unwrap().retain(|l| l != label);
    }

    pub fn last(&self) -> Option<String> {
        self.0.lock().unwrap().first().cloned()
    }

    /// Most recently focused first.
    pub fn order(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

impl Default for FocusTracker {
    fn default() -> Self {
        Self::new()
    }
}

/// The window a document action goes to: the last focused one while it is in
/// `live` (the caller passes only windows the user can see), else the first in
/// session order (`main`, then `editor-N` ascending) so the
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
            "toggle_tabs_compact:on",
            "toggle_tabs_compact:off",
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
            "prev_tab", "select_tab_1", "select_tab_9", "toggle_drawer",
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
    fn a_tracked_window_left_out_as_hidden_is_skipped_for_a_visible_one() {
        assert_eq!(
            menu_target(Some("main"), &labels(&["editor-5", "editor-3"])),
            Some("editor-3".to_string())
        );
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

    #[test]
    fn tracker_orders_windows_most_recently_focused_first() {
        let tracker = FocusTracker::new();
        tracker.focused("main");
        tracker.focused("editor-2");
        tracker.focused("editor-3");
        tracker.focused("main");
        assert_eq!(tracker.order(), vec!["main", "editor-3", "editor-2"]);
        tracker.forget("main");
        assert_eq!(tracker.last().as_deref(), Some("editor-3"), "the previous window takes over");
    }
}
