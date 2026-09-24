//! Which tabs every window holds, and which tab holds each file.
//!
//! The rule it exists for is spec §2: one file is open in at most one tab in
//! the whole app. It is guarded by one lock (`window::OpenFiles`), so "is this
//! file open anywhere?" and "give it to this tab" are never answered from two
//! different moments. The path → owner direction is derived by scanning rather
//! than stored: a second map kept "in step" lets one claim overwrite another
//! window's behind its back, and a scan over a few dozen tabs costs nothing.

use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegTab {
    pub id: String,
    /// `None` for an untitled tab.
    pub path: Option<String>,
}

/// Why `TabRegistry::move_tabs` changed nothing.
#[derive(Debug, PartialEq, Eq)]
pub enum MoveRefused {
    Nothing,
    SameWindow,
    /// This id is not one of the source window's tabs.
    NotHere(String),
}

impl std::fmt::Display for MoveRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Nothing => write!(f, "nothing to move"),
            Self::SameWindow => write!(f, "the tabs are in that window already"),
            Self::NotHere(id) => write!(f, "tab {id} is not in this window"),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WindowTabs {
    /// In the order the window shows them.
    pub tabs: Vec<RegTab>,
    /// The tab the window shows. `None` only for a window with no tabs.
    pub active: Option<String>,
    /// `#N` in the title; `None` only when all 99 were in use.
    pub number: Option<u32>,
    /// Its frontend has pulled `get_window_init`. Before that an event sent to
    /// it is lost, so a file must reach it through `PendingFiles`; after it, a
    /// file arrives as an event only, so the frontend's listeners must exist
    /// before it pulls — see `get_window_init`.
    pub mounted: bool,
    /// Ids of tabs removed from this window. A heartbeat sent before the
    /// removal can be processed after it, and must not bring the tab back —
    /// nor, through the session, its untitled draft on the next launch.
    pub closed_ids: HashSet<String>,
    /// The project the window is bound to (spec §2): the absolute root — git
    /// toplevel, or the directory outside git — of the first file it held.
    /// Bound once (`routing::bind_missing_projects`) and never moved: closing
    /// that file does not rebind the window.
    pub project: Option<String>,
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

    /// The live window showing `#number`. Liveness is part of the lookup: an
    /// entry left by a window that is gone can still carry the number, and
    /// must not shadow the window that shows it now.
    pub fn live_label_with_number(&self, number: u32, is_live: impl Fn(&str) -> bool) -> Option<String> {
        self.windows
            .iter()
            .find(|(label, w)| w.number == Some(number) && is_live(label))
            .map(|(label, _)| label.clone())
    }

    pub fn all_windows(&self) -> impl Iterator<Item = (&String, &WindowTabs)> {
        self.windows.iter()
    }

    pub fn set_number(&mut self, label: &str, number: Option<u32>) {
        self.windows.entry(label.to_string()).or_default().number = number;
    }

    /// Bind `label` to `project` unless it already has one. `false`: it had.
    pub fn bind_project(&mut self, label: &str, project: String) -> bool {
        let window = self.windows.entry(label.to_string()).or_default();
        if window.project.is_some() {
            return false;
        }
        window.project = Some(project);
        true
    }

    /// Windows with no project yet but a file to take one from, with that
    /// file: `(label, first file in tab order)`.
    pub fn unbound_windows(&self) -> Vec<(String, String)> {
        self.windows
            .iter()
            .filter(|(_, w)| w.project.is_none())
            .filter_map(|(label, w)| {
                w.tabs.iter().find_map(|t| t.path.clone()).map(|p| (label.clone(), p))
            })
            .collect()
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
    ///
    /// An explicit registration outranks a tombstone: only `sync`, which
    /// cannot tell a stale report from a new tab, honours `closed_ids`.
    pub fn add_tab(&mut self, label: &str, tab_id: &str, path: Option<String>) -> bool {
        if path.as_deref().is_some_and(|p| self.contains_path(p)) {
            return false;
        }
        if self.windows.values().any(|w| w.tabs.iter().any(|t| t.id == tab_id)) {
            return false;
        }
        let window = self.windows.entry(label.to_string()).or_default();
        window.closed_ids.remove(tab_id);
        window.tabs.push(RegTab { id: tab_id.to_string(), path });
        if window.active.is_none() {
            window.active = Some(tab_id.to_string());
        }
        true
    }

    pub fn mark_mounted(&mut self, label: &str) {
        self.windows.entry(label.to_string()).or_default().mounted = true;
    }

    pub fn is_mounted(&self, label: &str) -> bool {
        self.windows.get(label).is_some_and(|w| w.mounted)
    }

    /// Remove one tab, for good: its id is tombstoned against a late report.
    /// When it was active, the first remaining tab is active until the
    /// frontend says otherwise.
    pub fn remove_tab(&mut self, label: &str, tab_id: &str) -> Option<RegTab> {
        let window = self.windows.get_mut(label)?;
        let at = window.tabs.iter().position(|t| t.id == tab_id)?;
        let tab = window.tabs.remove(at);
        window.closed_ids.insert(tab.id.clone());
        if window.active.as_deref() == Some(tab_id) {
            window.active = window.tabs.first().map(|t| t.id.clone());
        }
        Some(tab)
    }

    /// Point one of `label`'s tabs at `path` (Save As). Refused when any other
    /// tab holds `path`.
    pub fn set_tab_path(&mut self, label: &str, tab_id: &str, path: &str) -> bool {
        if self
            .owner_of(path)
            .is_some_and(|(l, t)| !(l == label && t == tab_id))
        {
            return false;
        }
        let Some(tab) = self
            .windows
            .get_mut(label)
            .and_then(|w| w.tabs.iter_mut().find(|t| t.id == tab_id))
        else {
            return false;
        };
        tab.path = Some(path.to_string());
        true
    }

    pub fn set_active(&mut self, label: &str, tab_id: &str) -> bool {
        let Some(window) = self.windows.get_mut(label) else {
            return false;
        };
        if !window.tabs.iter().any(|t| t.id == tab_id) {
            return false;
        }
        window.active = Some(tab_id.to_string());
        true
    }

    /// Move tabs `ids` from `from` to `to` (plan 05), in the order given,
    /// right after `to`'s active tab — at its end when it has none. All or
    /// nothing: refused, with nothing changed, when no id is given, the two
    /// are one window, or any id is not one of `from`'s tabs. Paths go with
    /// their tabs, so one file stays one tab.
    ///
    /// Each moved id is tombstoned in `from` — a heartbeat it sent before the
    /// move must not bring the tab back there (`sync`) nor, through the
    /// session, its draft — and un-tombstoned in `to`. `from`'s active tab,
    /// if it moved, falls to its first remaining tab until its frontend says
    /// otherwise; `to` keeps its own, or takes the first moved one.
    pub fn move_tabs(&mut self, from: &str, to: &str, ids: &[String]) -> Result<Vec<RegTab>, MoveRefused> {
        if ids.is_empty() {
            return Err(MoveRefused::Nothing);
        }
        if from == to {
            return Err(MoveRefused::SameWindow);
        }
        let mut unique: Vec<&String> = Vec::with_capacity(ids.len());
        for id in ids {
            if !unique.contains(&id) {
                unique.push(id);
            }
        }
        let Some(source) = self.windows.get_mut(from) else {
            return Err(MoveRefused::NotHere(ids[0].clone()));
        };
        if let Some(stranger) = unique.iter().find(|id| !source.tabs.iter().any(|t| &t.id == **id)) {
            return Err(MoveRefused::NotHere((*stranger).clone()));
        }
        let mut moved = Vec::with_capacity(unique.len());
        for id in unique {
            if let Some(at) = source.tabs.iter().position(|t| &t.id == id) {
                let tab = source.tabs.remove(at);
                source.closed_ids.insert(tab.id.clone());
                moved.push(tab);
            }
        }
        if source.active.as_ref().is_some_and(|a| moved.iter().any(|t| &t.id == a)) {
            source.active = source.tabs.first().map(|t| t.id.clone());
        }
        let target = self.windows.entry(to.to_string()).or_default();
        let at = target
            .active
            .as_ref()
            .and_then(|a| target.tabs.iter().position(|t| &t.id == a))
            .map_or(target.tabs.len(), |i| i + 1);
        for (k, tab) in moved.iter().enumerate() {
            target.closed_ids.remove(&tab.id);
            target.tabs.insert(at + k, tab.clone());
        }
        if target.active.is_none() {
            target.active = moved.first().map(|t| t.id.clone());
        }
        Ok(moved)
    }

    pub fn tab_path(&self, label: &str, tab_id: &str) -> Option<String> {
        self.windows
            .get(label)?
            .tabs
            .iter()
            .find(|t| t.id == tab_id)?
            .path
            .clone()
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
    /// appended unless it was removed from this window (`closed_ids`); a
    /// reported file tab it does not know is ignored. Tabs the report does not
    /// mention keep their place after the reported ones — a claim can be in
    /// flight while an older report is still on its way.
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
                && !window.closed_ids.contains(id)
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
        assert_eq!(reg.owner_of("/tmp/./a.md"), None, "never canonicalized");
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
    fn the_first_tab_of_a_window_becomes_active() {
        let reg = reg_with(&[("main", "t1", Some("/a.md")), ("main", "t2", None)]);
        assert_eq!(reg.window("main").unwrap().active.as_deref(), Some("t1"));
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
    fn remove_tab_hands_active_to_the_first_remaining_tab() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("main", "b", Some("/b.md"))]);
        assert_eq!(reg.remove_tab("main", "a").map(|t| t.id), Some("a".to_string()));
        assert!(!reg.contains_path("/a.md"));
        assert_eq!(reg.window("main").unwrap().active.as_deref(), Some("b"));
        assert_eq!(reg.remove_tab("main", "ghost"), None);
    }

    #[test]
    fn remove_tab_of_a_background_tab_keeps_active() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("main", "b", Some("/b.md"))]);
        reg.remove_tab("main", "b");
        assert_eq!(reg.window("main").unwrap().active.as_deref(), Some("a"));
    }

    #[test]
    fn set_tab_path_retargets_one_tab_but_never_takes_anothers_file() {
        let mut reg = reg_with(&[("main", "a", None), ("main", "b", Some("/b.md")), ("editor-2", "x", Some("/x.md"))]);
        assert!(reg.set_tab_path("main", "a", "/new.md"));
        assert_eq!(reg.owner_of("/new.md"), Some(("main".to_string(), "a".to_string())));
        assert!(!reg.set_tab_path("main", "a", "/b.md"), "another tab in this window");
        assert!(!reg.set_tab_path("main", "a", "/x.md"), "another window");
        assert!(reg.set_tab_path("main", "a", "/new.md"), "its own path again is fine");
        assert!(!reg.set_tab_path("main", "ghost", "/g.md"));
    }

    #[test]
    fn set_active_accepts_only_a_tab_of_that_window() {
        let mut reg = reg_with(&[("main", "a", None), ("main", "b", None), ("editor-2", "x", None)]);
        assert!(reg.set_active("main", "b"));
        assert_eq!(reg.window("main").unwrap().active.as_deref(), Some("b"));
        assert!(!reg.set_active("main", "x"));
        assert_eq!(reg.window("main").unwrap().active.as_deref(), Some("b"));
    }

    #[test]
    fn tab_path_answers_one_tabs_file() {
        let reg = reg_with(&[("main", "a", Some("/a.md")), ("main", "u", None)]);
        assert_eq!(reg.tab_path("main", "a").as_deref(), Some("/a.md"));
        assert_eq!(reg.tab_path("main", "u"), None);
        assert_eq!(reg.tab_path("editor-9", "a"), None);
    }

    #[test]
    fn a_window_is_mounted_once_it_pulled_its_init() {
        let mut reg = TabRegistry::new();
        assert!(!reg.is_mounted("main"));
        reg.mark_mounted("main");
        assert!(reg.is_mounted("main"));
    }

    #[test]
    fn a_heartbeat_that_arrives_after_tab_close_does_not_bring_the_tab_back() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("main", "u", None)]);
        let stale = [("a".to_string(), Some("/a.md".to_string())), ("u".to_string(), None)];
        reg.remove_tab("main", "u");
        reg.sync("main", &stale, Some("u"));
        let w = reg.window("main").unwrap();
        let ids: Vec<&str> = w.tabs.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["a"]);
        assert_eq!(w.active.as_deref(), Some("a"));
    }

    #[test]
    fn a_tombstone_binds_only_its_own_window() {
        let mut reg = reg_with(&[("main", "u", None), ("editor-2", "x", None)]);
        reg.remove_tab("main", "u");
        reg.sync("editor-2", &[("x".to_string(), None), ("u".to_string(), None)], None);
        let ids: Vec<&str> = reg.window("editor-2").unwrap().tabs.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["x", "u"]);
    }

    #[test]
    fn an_explicit_registration_clears_a_tombstone() {
        let mut reg = reg_with(&[("main", "u", None)]);
        reg.remove_tab("main", "u");
        assert!(reg.add_tab("main", "u", Some("/a.md".to_string())));
        assert!(!reg.window("main").unwrap().closed_ids.contains("u"));
        reg.sync("main", &[("u".to_string(), Some("/a.md".to_string()))], None);
        assert_eq!(reg.owner_of("/a.md"), Some(("main".to_string(), "u".to_string())));
    }

    #[test]
    fn sync_sets_active_only_to_a_tab_it_knows() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md"))]);
        reg.sync("main", &[("a".into(), Some("/a.md".into()))], Some("ghost"));
        assert_eq!(reg.window("main").unwrap().active.as_deref(), Some("a"));
    }

    #[test]
    fn a_window_takes_its_project_once_and_keeps_it() {
        let mut reg = reg_with(&[("main", "a", Some("/p/a.md"))]);
        assert!(reg.bind_project("main", "/p".to_string()));
        assert!(!reg.bind_project("main", "/q".to_string()), "never rebound");
        reg.remove_tab("main", "a");
        assert_eq!(
            reg.window("main").unwrap().project.as_deref(),
            Some("/p"),
            "closing the file that bound it keeps the binding"
        );
    }

    #[test]
    fn unbound_windows_name_their_first_file() {
        let mut reg = reg_with(&[
            ("main", "u", None),
            ("main", "a", Some("/p/a.md")),
            ("editor-2", "v", None),
            ("editor-3", "b", Some("/q/b.md")),
        ]);
        reg.bind_project("editor-3", "/q".to_string());
        assert_eq!(
            reg.unbound_windows(),
            vec![("main".to_string(), "/p/a.md".to_string())],
            "an untitled-only window has nothing to bind to yet; a bound one is done"
        );
    }

    fn ids_of(reg: &TabRegistry, label: &str) -> Vec<String> {
        reg.window(label).map(|w| w.tabs.iter().map(|t| t.id.clone()).collect()).unwrap_or_default()
    }

    fn strings(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_move_puts_the_tabs_after_the_targets_active_tab_in_the_order_given() {
        let mut reg = reg_with(&[
            ("main", "a", Some("/a.md")),
            ("main", "b", Some("/b.md")),
            ("main", "c", None),
            ("editor-2", "x", Some("/x.md")),
            ("editor-2", "y", Some("/y.md")),
        ]);
        let moved = reg.move_tabs("main", "editor-2", &strings(&["c", "a"])).unwrap();
        assert_eq!(moved.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["c", "a"]);
        assert_eq!(ids_of(&reg, "main"), vec!["b"]);
        assert_eq!(ids_of(&reg, "editor-2"), vec!["x", "c", "a", "y"], "right after x, the active tab");
        assert_eq!(reg.owner_of("/a.md"), Some(("editor-2".to_string(), "a".to_string())), "the file went with its tab");
        assert_eq!(reg.paths().iter().filter(|p| p.as_str() == "/a.md").count(), 1, "one file, one tab");
    }

    #[test]
    fn a_move_is_all_or_nothing() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("editor-2", "x", None)]);
        assert_eq!(
            reg.move_tabs("main", "editor-2", &strings(&["a", "x"])),
            Err(MoveRefused::NotHere("x".to_string()))
        );
        assert_eq!(reg.move_tabs("main", "main", &strings(&["a"])), Err(MoveRefused::SameWindow));
        assert_eq!(reg.move_tabs("main", "editor-2", &[]), Err(MoveRefused::Nothing));
        assert_eq!(ids_of(&reg, "main"), vec!["a"]);
        assert_eq!(ids_of(&reg, "editor-2"), vec!["x"]);
        assert!(reg.window("main").unwrap().closed_ids.is_empty(), "nothing tombstoned");
    }

    #[test]
    fn the_sources_active_tab_falls_to_its_first_remaining_one_and_the_target_keeps_its_own() {
        let mut reg = reg_with(&[("main", "a", None), ("main", "b", None), ("editor-2", "x", None)]);
        reg.move_tabs("main", "editor-2", &strings(&["a"])).unwrap();
        assert_eq!(reg.window("main").unwrap().active.as_deref(), Some("b"));
        assert_eq!(reg.window("editor-2").unwrap().active.as_deref(), Some("x"));
    }

    #[test]
    fn a_window_built_for_the_move_takes_the_first_moved_tab_as_active_and_keeps_its_number() {
        let mut reg = reg_with(&[("main", "a", None), ("main", "b", None)]);
        reg.set_number("editor-3", Some(3));
        reg.move_tabs("main", "editor-3", &strings(&["a", "b"])).unwrap();
        let w = reg.window("editor-3").unwrap();
        assert_eq!(w.active.as_deref(), Some("a"));
        assert_eq!(w.number, Some(3), "numbers never change");
        assert_eq!(reg.window("main").unwrap().active, None, "an emptied window has none");
    }

    #[test]
    fn a_heartbeat_the_source_sent_before_the_move_does_not_bring_the_tab_back() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("main", "u", None), ("editor-2", "x", None)]);
        let stale = [("a".to_string(), Some("/a.md".to_string())), ("u".to_string(), None)];
        reg.move_tabs("main", "editor-2", &strings(&["u"])).unwrap();
        reg.sync("main", &stale, Some("u"));
        assert_eq!(ids_of(&reg, "main"), vec!["a"]);
        assert_eq!(reg.window("main").unwrap().active.as_deref(), Some("a"));
        assert!(reg.window("main").unwrap().closed_ids.contains("u"));
        assert_eq!(ids_of(&reg, "editor-2"), vec!["x", "u"]);
    }

    #[test]
    fn moving_a_tab_back_clears_its_tombstone_there() {
        let mut reg = reg_with(&[("main", "a", None), ("main", "u", None), ("editor-2", "x", None)]);
        reg.move_tabs("main", "editor-2", &strings(&["u"])).unwrap();
        reg.move_tabs("editor-2", "main", &strings(&["u"])).unwrap();
        assert!(!reg.window("main").unwrap().closed_ids.contains("u"));
        assert!(reg.window("editor-2").unwrap().closed_ids.contains("u"));
        reg.sync("main", &[("a".to_string(), None), ("u".to_string(), None)], Some("u"));
        assert_eq!(reg.window("main").unwrap().active.as_deref(), Some("u"));
    }

    #[test]
    fn an_id_given_twice_moves_once() {
        let mut reg = reg_with(&[("main", "a", None), ("main", "b", None), ("editor-2", "x", None)]);
        assert_eq!(reg.move_tabs("main", "editor-2", &strings(&["a", "a"])).unwrap().len(), 1);
        assert_eq!(ids_of(&reg, "editor-2"), vec!["x", "a"]);
    }

    #[test]
    fn a_refused_move_says_why() {
        assert_eq!(MoveRefused::NotHere("x".into()).to_string(), "tab x is not in this window");
        assert_eq!(MoveRefused::SameWindow.to_string(), "the tabs are in that window already");
        assert_eq!(MoveRefused::Nothing.to_string(), "nothing to move");
    }
}
