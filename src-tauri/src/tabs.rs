//! Which tabs every window holds, and which tab holds each file.
//!
//! The rule it exists for is spec §2: one file is open in at most one tab in
//! the whole app. It is guarded by one lock (`window::OpenFiles`), so "is this
//! file open anywhere?" and "give it to this tab" are never answered from two
//! different moments. The path → owner direction is derived by scanning rather
//! than stored: a second map kept "in step" is how a claim used to be
//! overwritten behind another window's back, and a scan over a few dozen tabs
//! costs nothing.

use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegTab {
    pub id: String,
    /// `None` for an untitled tab.
    pub path: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WindowTabs {
    /// In the order the window shows them.
    pub tabs: Vec<RegTab>,
}

#[derive(Debug, Default)]
pub struct TabRegistry {
    windows: HashMap<String, WindowTabs>,
}

impl TabRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn window(&self, label: &str) -> Option<&WindowTabs> {
        self.windows.get(label)
    }

    pub fn remove_window(&mut self, label: &str) -> Option<WindowTabs> {
        self.windows.remove(label)
    }

    /// The window and tab holding `path`. Looked up exactly as given, never
    /// canonicalized — every caller registers and queries the same string.
    pub fn owner_of(&self, path: &str) -> Option<(String, String)> {
        self.windows.iter().find_map(|(label, w)| {
            w.tabs
                .iter()
                .find(|t| t.path.as_deref() == Some(path))
                .map(|t| (label.clone(), t.id.clone()))
        })
    }

    pub fn label_of(&self, path: &str) -> Option<String> {
        self.owner_of(path).map(|(label, _)| label)
    }

    pub fn contains_path(&self, path: &str) -> bool {
        self.owner_of(path).is_some()
    }

    /// Every file open anywhere.
    pub fn paths(&self) -> Vec<String> {
        self.windows
            .values()
            .flat_map(|w| w.tabs.iter().filter_map(|t| t.path.clone()))
            .collect()
    }

    /// One window's files, in tab order.
    pub fn paths_of(&self, label: &str) -> Vec<String> {
        self.windows
            .get(label)
            .map(|w| w.tabs.iter().filter_map(|t| t.path.clone()).collect())
            .unwrap_or_default()
    }

    /// Append a tab to `label`. Refused — nothing changes, `false` — when
    /// `path` is already held by any tab or `tab_id` is already in use.
    pub fn add_tab(&mut self, label: &str, tab_id: &str, path: Option<String>) -> bool {
        if path.as_deref().is_some_and(|p| self.contains_path(p)) {
            return false;
        }
        if self.windows.values().any(|w| w.tabs.iter().any(|t| t.id == tab_id)) {
            return false;
        }
        self.windows
            .entry(label.to_string())
            .or_default()
            .tabs
            .push(RegTab { id: tab_id.to_string(), path });
        true
    }

    /// For one-tab windows, until the frontend has tabs: point the window's
    /// first tab at `path`, creating that tab with `new_id` if there is none.
    /// Returns the tab's id, or `None` when another window holds `path`.
    pub fn set_single_path(
        &mut self,
        label: &str,
        path: &str,
        new_id: impl FnOnce() -> String,
    ) -> Option<String> {
        if self.label_of(path).is_some_and(|owner| owner != label) {
            return None;
        }
        let window = self.windows.entry(label.to_string()).or_default();
        match window.tabs.first_mut() {
            Some(tab) => {
                tab.path = Some(path.to_string());
                Some(tab.id.clone())
            }
            None => {
                let id = new_id();
                window.tabs.push(RegTab { id: id.clone(), path: Some(path.to_string()) });
                Some(id)
            }
        }
    }

    /// Give up `label`'s claim on `path`; the tab stays, showing nothing.
    /// Another window's claim is never touched. Returns whether anything changed.
    pub fn clear_path(&mut self, label: &str, path: &str) -> bool {
        let Some(window) = self.windows.get_mut(label) else {
            return false;
        };
        match window.tabs.iter_mut().find(|t| t.path.as_deref() == Some(path)) {
            Some(tab) => {
                tab.path = None;
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg_with(entries: &[(&str, &str, Option<&str>)]) -> TabRegistry {
        let mut reg = TabRegistry::new();
        for (label, id, path) in entries {
            assert!(reg.add_tab(label, id, path.map(str::to_string)));
        }
        reg
    }

    #[test]
    fn owner_of_finds_the_window_and_tab_holding_a_path() {
        let reg = reg_with(&[("main", "t1", Some("/a.md")), ("editor-2", "t2", Some("/b.md"))]);
        assert_eq!(reg.owner_of("/b.md"), Some(("editor-2".to_string(), "t2".to_string())));
        assert_eq!(reg.label_of("/a.md").as_deref(), Some("main"));
        assert_eq!(reg.owner_of("/c.md"), None);
        assert!(reg.contains_path("/a.md"));
        assert!(!reg.contains_path("/c.md"));
    }

    #[test]
    fn paths_are_looked_up_exactly_as_given() {
        let reg = reg_with(&[("main", "t1", Some("/tmp/a.md"))]);
        assert_eq!(reg.owner_of("/tmp/./a.md"), None, "never canonicalized, like OpenFiles always was");
    }

    #[test]
    fn add_tab_refuses_a_path_any_tab_already_holds() {
        let mut reg = reg_with(&[("main", "t1", Some("/a.md"))]);
        assert!(!reg.add_tab("editor-2", "t2", Some("/a.md".to_string())));
        assert!(!reg.add_tab("main", "t3", Some("/a.md".to_string())));
        assert_eq!(reg.paths(), vec!["/a.md".to_string()]);
    }

    #[test]
    fn add_tab_refuses_a_tab_id_already_in_use() {
        let mut reg = reg_with(&[("main", "t1", None)]);
        assert!(!reg.add_tab("editor-2", "t1", Some("/b.md".to_string())));
        assert!(!reg.contains_path("/b.md"));
    }

    #[test]
    fn untitled_tabs_never_collide_on_path() {
        let reg = reg_with(&[("main", "t1", None), ("main", "t2", None)]);
        assert_eq!(reg.window("main").unwrap().tabs.len(), 2);
        assert!(reg.paths().is_empty());
    }

    #[test]
    fn paths_of_lists_one_windows_files_in_tab_order() {
        let reg = reg_with(&[
            ("main", "t1", Some("/a.md")),
            ("main", "t2", None),
            ("main", "t3", Some("/c.md")),
            ("editor-2", "t4", Some("/d.md")),
        ]);
        assert_eq!(reg.paths_of("main"), vec!["/a.md".to_string(), "/c.md".to_string()]);
        assert!(reg.paths_of("editor-9").is_empty());
    }

    #[test]
    fn remove_window_releases_all_its_paths() {
        let mut reg = reg_with(&[("main", "t1", Some("/a.md")), ("editor-2", "t2", Some("/b.md"))]);
        let removed = reg.remove_window("main").expect("was registered");
        assert_eq!(removed.tabs.len(), 1);
        assert!(!reg.contains_path("/a.md"));
        assert!(reg.contains_path("/b.md"));
    }

    #[test]
    fn set_single_path_retargets_the_windows_one_tab() {
        let mut reg = reg_with(&[("main", "t1", Some("/a.md"))]);
        assert_eq!(reg.set_single_path("main", "/b.md", || "unused".to_string()).as_deref(), Some("t1"));
        assert!(!reg.contains_path("/a.md"), "the old path is released");
        assert_eq!(reg.label_of("/b.md").as_deref(), Some("main"));
    }

    #[test]
    fn set_single_path_creates_the_tab_for_a_window_that_has_none() {
        let mut reg = TabRegistry::new();
        assert_eq!(reg.set_single_path("main", "/a.md", || "fresh".to_string()).as_deref(), Some("fresh"));
        assert_eq!(reg.owner_of("/a.md"), Some(("main".to_string(), "fresh".to_string())));
    }

    #[test]
    fn set_single_path_never_takes_another_windows_file() {
        let mut reg = reg_with(&[("editor-2", "t2", Some("/a.md")), ("main", "t1", None)]);
        assert_eq!(reg.set_single_path("main", "/a.md", || "x".to_string()), None);
        assert_eq!(reg.label_of("/a.md").as_deref(), Some("editor-2"));
    }

    #[test]
    fn clear_path_gives_up_only_the_callers_claim() {
        let mut reg = reg_with(&[("main", "t1", Some("/a.md")), ("editor-2", "t2", Some("/b.md"))]);
        assert!(!reg.clear_path("main", "/b.md"), "another window's claim is never touched");
        assert!(reg.clear_path("main", "/a.md"));
        assert!(!reg.contains_path("/a.md"));
        assert_eq!(reg.window("main").unwrap().tabs.len(), 1, "the tab stays, showing nothing");
        assert!(!reg.clear_path("main", "/a.md"), "idempotent");
    }
}
