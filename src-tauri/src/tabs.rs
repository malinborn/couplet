//! Which tabs every window holds, and which tab holds each file.
//!
//! The rule it exists for is spec §2: one file is open in at most one tab in
//! the whole app. It is guarded by one lock (`window::OpenFiles`), so "is this
//! file open anywhere?" and "give it to this tab" are never answered from two
//! different moments. The path → owner direction is derived by scanning rather
//! than stored: a second map kept "in step" is how a claim used to be
//! overwritten behind another window's back, and a scan over a few dozen tabs
//! costs nothing.

use std::collections::{HashMap, HashSet};

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
    /// The tab the window shows. `None` only for a window with no tabs.
    pub active: Option<String>,
    /// `#N` in the title; `None` only when all 99 were in use.
    pub number: Option<u32>,
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

    pub fn numbers_in_use(&self) -> HashSet<u32> {
        self.windows.values().filter_map(|w| w.number).collect()
    }

    pub fn set_number(&mut self, label: &str, number: Option<u32>) {
        self.windows.entry(label.to_string()).or_default().number = number;
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
        let window = self.windows.entry(label.to_string()).or_default();
        window.tabs.push(RegTab { id: tab_id.to_string(), path });
        if window.active.is_none() {
            window.active = Some(tab_id.to_string());
        }
        true
    }

    /// For one-tab windows, until the frontend has tabs: point the window's
    /// active tab (else its first) at `path`, creating that tab with `new_id`
    /// if there is none. Returns the tab's id, or `None` when another window
    /// holds `path`.
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
        let active = window
            .active
            .as_ref()
            .and_then(|a| window.tabs.iter().position(|t| &t.id == a))
            .unwrap_or(0);
        let id = match window.tabs.get_mut(active) {
            Some(tab) => {
                tab.path = Some(path.to_string());
                tab.id.clone()
            }
            None => {
                let id = new_id();
                window.tabs.push(RegTab { id: id.clone(), path: Some(path.to_string()) });
                id
            }
        };
        window.active = Some(id.clone());
        Some(id)
    }

    /// `label`'s tabs, after giving a window that has none one untitled tab —
    /// a mounted window always shows something.
    pub fn ensure_tab(&mut self, label: &str, new_id: impl FnOnce() -> String) -> &WindowTabs {
        let has_tabs = self.windows.get(label).is_some_and(|w| !w.tabs.is_empty());
        if !has_tabs {
            let id = new_id();
            self.add_tab(label, &id, None);
        }
        self.windows.entry(label.to_string()).or_default()
    }

    /// Mirror the frontend's tab order and active tab.
    ///
    /// Never claims a path: paths change only through calls that check
    /// ownership first. A reported untitled tab the registry does not know is
    /// appended; a reported file tab it does not know is ignored. Tabs the
    /// report does not mention keep their place after the reported ones — a
    /// claim can be in flight while an older report is still on its way.
    pub fn sync(&mut self, label: &str, reported: &[(String, Option<String>)], active: Option<&str>) {
        let ids_elsewhere: HashSet<String> = self
            .windows
            .iter()
            .filter(|(l, _)| l.as_str() != label)
            .flat_map(|(_, w)| w.tabs.iter().map(|t| t.id.clone()))
            .collect();
        let window = self.windows.entry(label.to_string()).or_default();
        let mut ordered: Vec<RegTab> = Vec::with_capacity(window.tabs.len());
        for (id, path) in reported {
            if let Some(i) = window.tabs.iter().position(|t| &t.id == id) {
                ordered.push(window.tabs.remove(i));
            } else if path.is_none()
                && !ids_elsewhere.contains(id)
                && !ordered.iter().any(|t| &t.id == id)
            {
                ordered.push(RegTab { id: id.clone(), path: None });
            }
        }
        ordered.append(&mut window.tabs);
        window.tabs = ordered;
        if let Some(active) = active {
            if window.tabs.iter().any(|t| t.id == active) {
                window.active = Some(active.to_string());
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

    #[test]
    fn the_first_tab_of_a_window_becomes_active() {
        let reg = reg_with(&[("main", "t1", Some("/a.md")), ("main", "t2", None)]);
        assert_eq!(reg.window("main").unwrap().active.as_deref(), Some("t1"));
    }

    #[test]
    fn set_single_path_retargets_the_active_tab_not_the_first() {
        let mut reg = reg_with(&[("main", "t1", Some("/a.md")), ("main", "t2", None)]);
        reg.sync("main", &[("t1".into(), Some("/a.md".into())), ("t2".into(), None)], Some("t2"));
        assert_eq!(reg.set_single_path("main", "/b.md", || panic!("no new tab")).as_deref(), Some("t2"));
        assert_eq!(reg.label_of("/a.md").as_deref(), Some("main"), "the first tab keeps its file");
        assert_eq!(reg.owner_of("/b.md"), Some(("main".to_string(), "t2".to_string())));
    }

    #[test]
    fn set_single_path_makes_its_tab_active() {
        let mut reg = TabRegistry::new();
        let id = reg.set_single_path("main", "/a.md", || "fresh".to_string()).unwrap();
        assert_eq!(reg.window("main").unwrap().active.as_deref(), Some(id.as_str()));
    }

    #[test]
    fn ensure_tab_gives_a_window_without_tabs_one_untitled_tab() {
        let mut reg = TabRegistry::new();
        let window = reg.ensure_tab("main", || "u1".to_string());
        assert_eq!(window.tabs, vec![RegTab { id: "u1".to_string(), path: None }]);
        assert_eq!(window.active.as_deref(), Some("u1"));
    }

    #[test]
    fn ensure_tab_leaves_a_window_that_has_tabs_alone() {
        let mut reg = reg_with(&[("main", "t1", Some("/a.md"))]);
        let window = reg.ensure_tab("main", || panic!("must not mint an id"));
        assert_eq!(window.tabs.len(), 1);
    }

    #[test]
    fn sync_reorders_to_the_reported_order_and_moves_active() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("main", "b", None), ("main", "c", Some("/c.md"))]);
        reg.sync(
            "main",
            &[("c".into(), Some("/c.md".into())), ("a".into(), Some("/a.md".into())), ("b".into(), None)],
            Some("c"),
        );
        let w = reg.window("main").unwrap();
        let ids: Vec<&str> = w.tabs.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["c", "a", "b"]);
        assert_eq!(w.active.as_deref(), Some("c"));
    }

    #[test]
    fn sync_keeps_tabs_the_report_does_not_mention_after_the_reported_ones() {
        // A claim for "new" is registered while an older report (without it)
        // is still in flight — the report must not drop the claim.
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("main", "new", Some("/n.md"))]);
        reg.sync("main", &[("a".into(), Some("/a.md".into()))], Some("a"));
        let ids: Vec<&str> = reg.window("main").unwrap().tabs.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "new"]);
        assert!(reg.contains_path("/n.md"));
    }

    #[test]
    fn sync_appends_an_unknown_untitled_tab_but_never_claims_a_path() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("editor-2", "x", Some("/x.md"))]);
        reg.sync(
            "main",
            &[
                ("a".into(), Some("/a.md".into())),
                ("u".into(), None),
                ("sneaky".into(), Some("/x.md".into())),
                ("x".into(), None),
            ],
            None,
        );
        let ids: Vec<&str> = reg.window("main").unwrap().tabs.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "u"], "an unknown file tab and another window's id are ignored");
        assert_eq!(reg.label_of("/x.md").as_deref(), Some("editor-2"));
    }

    #[test]
    fn numbers_in_use_are_the_numbered_windows() {
        let mut reg = reg_with(&[("main", "t1", None), ("editor-2", "t2", None), ("editor-3", "t3", None)]);
        reg.set_number("main", Some(4));
        reg.set_number("editor-3", Some(9));
        assert_eq!(reg.numbers_in_use(), [4, 9].into_iter().collect());
        assert_eq!(reg.window("editor-2").unwrap().number, None);
        reg.remove_window("main");
        assert_eq!(reg.numbers_in_use(), [9].into_iter().collect(), "a closed window's number is free");
    }

    #[test]
    fn sync_sets_active_only_to_a_tab_it_knows() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md"))]);
        reg.sync("main", &[("a".into(), Some("/a.md".into()))], Some("ghost"));
        assert_eq!(reg.window("main").unwrap().active.as_deref(), Some("a"));
    }
}
