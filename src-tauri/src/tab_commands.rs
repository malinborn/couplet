//! IPC for the tab model. Every change of which tab holds which file is
//! decided and applied here under the one `OpenFiles` lock — the pure
//! functions are the decision, the commands wire it to a window.

use std::collections::HashMap;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::session::SessionState;
use crate::tabs::TabRegistry;
use crate::window::{self, OpenFiles, PendingFiles, PendingOpen};

/// Who holds a path, seen from the calling window.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TabOwner {
    None,
    ThisWindow {
        #[serde(rename = "tabId")]
        tab_id: String,
    },
    OtherWindow {
        label: String,
    },
}

/// A holder whose window is gone counts as nobody.
pub fn owner_for(
    reg: &TabRegistry,
    path: &str,
    caller: &str,
    is_live: impl Fn(&str) -> bool,
) -> TabOwner {
    match reg.owner_of(path) {
        Some((label, tab_id)) if label == caller => TabOwner::ThisWindow { tab_id },
        Some((label, _)) if is_live(&label) => TabOwner::OtherWindow { label },
        _ => TabOwner::None,
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TabOpened {
    Created {
        #[serde(rename = "tabId")]
        tab_id: String,
    },
    ThisWindow {
        #[serde(rename = "tabId")]
        tab_id: String,
    },
    OtherWindow {
        label: String,
    },
}

/// Open a tab for `path` (`None`: untitled) in `caller` — unless the file is
/// already held, then say by whom and change nothing. Check and claim are one
/// step under one lock, so two windows opening one file cannot both get it.
pub fn open_tab(
    reg: &mut TabRegistry,
    pending: &mut HashMap<String, PendingOpen>,
    caller: &str,
    path: Option<&str>,
    new_id: String,
    is_live: impl Fn(&str) -> bool,
) -> TabOpened {
    if let Some(path) = path {
        match owner_for(reg, path, caller, &is_live) {
            TabOwner::ThisWindow { tab_id } => return TabOpened::ThisWindow { tab_id },
            TabOwner::OtherWindow { label } => return TabOpened::OtherWindow { label },
            TabOwner::None => {
                window::evict_dead(reg, pending, path, &is_live);
            }
        }
    }
    reg.add_tab(caller, &new_id, path.map(str::to_string));
    TabOpened::Created { tab_id: new_id }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TabClaim {
    Claimed,
    ThisWindow {
        #[serde(rename = "tabId")]
        tab_id: String,
    },
    OtherWindow {
        label: String,
    },
    /// `tab_id` is another window's tab: nothing was claimed.
    Refused,
}

/// Save As: point `caller`'s tab at `path`, unless another tab holds it.
pub fn claim_path(
    reg: &mut TabRegistry,
    pending: &mut HashMap<String, PendingOpen>,
    caller: &str,
    tab_id: &str,
    path: &str,
    is_live: impl Fn(&str) -> bool,
) -> TabClaim {
    match owner_for(reg, path, caller, &is_live) {
        TabOwner::ThisWindow { tab_id: holder } if holder == tab_id => return TabClaim::Claimed,
        TabOwner::ThisWindow { tab_id: holder } => return TabClaim::ThisWindow { tab_id: holder },
        TabOwner::OtherWindow { label } => return TabClaim::OtherWindow { label },
        TabOwner::None => {
            window::evict_dead(reg, pending, path, &is_live);
        }
    }
    if reg.set_tab_path(caller, tab_id, path) || reg.add_tab(caller, tab_id, Some(path.to_string())) {
        TabClaim::Claimed
    } else {
        TabClaim::Refused
    }
}

fn live_windows(app: &AppHandle) -> impl Fn(&str) -> bool + '_ {
    move |label| app.get_webview_window(label).is_some()
}

#[tauri::command]
pub async fn tab_owner(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<TabOwner, String> {
    let open_files = app.state::<OpenFiles>();
    let reg = open_files.0.lock().unwrap();
    Ok(owner_for(&reg, &path, window.label(), live_windows(&app)))
}

#[tauri::command]
pub async fn tab_open(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: Option<String>,
) -> Result<TabOpened, String> {
    let open_files = app.state::<OpenFiles>();
    let mut reg = open_files.0.lock().unwrap();
    let pending = app.state::<PendingFiles>();
    let mut pending = pending.0.lock().unwrap();
    Ok(open_tab(
        &mut reg,
        &mut pending,
        window.label(),
        path.as_deref(),
        crate::session::new_tab_id(),
        live_windows(&app),
    ))
}

#[tauri::command]
pub async fn tab_claim(
    app: AppHandle,
    window: tauri::WebviewWindow,
    tab_id: String,
    path: String,
) -> Result<TabClaim, String> {
    let label = window.label().to_string();
    let open_files = app.state::<OpenFiles>();
    let mut reg = open_files.0.lock().unwrap();
    let claim = {
        let pending = app.state::<PendingFiles>();
        let mut pending = pending.0.lock().unwrap();
        claim_path(&mut reg, &mut pending, &label, &tab_id, &path, live_windows(&app))
    };
    // The watcher follows the active tab onto its new file.
    let is_active = reg.window(&label).and_then(|w| w.active.as_deref()) == Some(tab_id.as_str());
    if claim == TabClaim::Claimed && is_active {
        window::set_watcher(&app, &label, Some(&path));
    }
    Ok(claim)
}

/// A tab that never came to show its file (an aborted open, an unreadable
/// restored tab, a blank tab a file replaced) gives its claim back. Nothing
/// goes onto the closed stack: nothing was closed. Agents still waiting on
/// its file are failed — they would otherwise be answered by whatever tab
/// shows that file next, or never.
#[tauri::command]
pub async fn tab_release(
    app: AppHandle,
    window: tauri::WebviewWindow,
    tab_id: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let released = {
        let open_files = app.state::<OpenFiles>();
        let mut reg = open_files.0.lock().unwrap();
        let was_active = reg.window(&label).and_then(|w| w.active.as_deref()) == Some(tab_id.as_str());
        let released = reg.remove_tab(&label, &tab_id);
        if released.is_some() && was_active {
            window::set_watcher(&app, &label, None);
        }
        released
    };
    if let Some(path) = released.and_then(|t| t.path) {
        crate::ai_socket::cancel_for_tab(&app, &label, &path, "tab released");
    }
    Ok(())
}

/// The window now shows `tab_id`; the one watcher per window follows it.
#[tauri::command]
pub async fn tab_activate(
    app: AppHandle,
    window: tauri::WebviewWindow,
    tab_id: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let open_files = app.state::<OpenFiles>();
    let mut reg = open_files.0.lock().unwrap();
    if reg.set_active(&label, &tab_id) {
        window::set_watcher(&app, &label, reg.tab_path(&label, &tab_id).as_deref());
    }
    Ok(())
}

/// ⌘W on a tab, after the frontend flushed and handed it over. Fails the
/// agents still waiting on its document (pending and queued), commits its
/// comment pauses, and records it for ⌘⇧T with the caret the frontend saw.
#[tauri::command]
pub async fn tab_close(
    app: AppHandle,
    window: tauri::WebviewWindow,
    tab_id: String,
    cursor: usize,
    top_line: usize,
) -> Result<(), String> {
    let label = window.label().to_string();
    let (removed, number) = {
        let open_files = app.state::<OpenFiles>();
        let mut reg = open_files.0.lock().unwrap();
        let was_active =
            reg.window(&label).and_then(|w| w.active.as_deref()) == Some(tab_id.as_str());
        let number = reg.window(&label).and_then(|w| w.number);
        let removed = reg.remove_tab(&label, &tab_id);
        if removed.is_some() && was_active {
            window::set_watcher(&app, &label, None);
        }
        (removed, number)
    };
    let Some(tab) = removed else {
        return Ok(());
    };

    let session = app.state::<SessionState>();
    // At once, not at the next heartbeat: a quit in between would restore it.
    session.remove_tab(&label, &tab_id);

    if let Some(path) = tab.path {
        crate::ai_socket::cancel_for_tab(&app, &label, &path, "tab closed");
        crate::comment_pause::commit_document(std::path::Path::new(&path));
        let stack = app.state::<crate::closed::ClosedStack>();
        if crate::closed::record_tab_close(&session, &stack, &label, number, &path, cursor, top_line) {
            crate::closed::refresh_reopen_item(&app);
        }
        std::thread::spawn(move || {
            let _ = crate::recovery::delete_recovery_sync(&path);
        });
    }
    Ok(())
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
    fn owner_for_tells_this_window_from_another_and_ignores_dead_windows() {
        let reg = reg_with(&[("main", "a", Some("/a.md")), ("editor-2", "b", Some("/b.md"))]);
        assert_eq!(
            owner_for(&reg, "/a.md", "main", |_| true),
            TabOwner::ThisWindow { tab_id: "a".to_string() }
        );
        assert_eq!(
            owner_for(&reg, "/b.md", "main", |_| true),
            TabOwner::OtherWindow { label: "editor-2".to_string() }
        );
        assert_eq!(owner_for(&reg, "/b.md", "main", |l| l != "editor-2"), TabOwner::None);
        assert_eq!(owner_for(&reg, "/c.md", "main", |_| true), TabOwner::None);
    }

    #[test]
    fn open_tab_claims_a_free_file_for_the_caller() {
        let mut reg = TabRegistry::new();
        assert_eq!(
            open_tab(&mut reg, &mut HashMap::new(), "main", Some("/a.md"), "t1".to_string(), |_| true),
            TabOpened::Created { tab_id: "t1".to_string() }
        );
        assert_eq!(reg.owner_of("/a.md"), Some(("main".to_string(), "t1".to_string())));
    }

    #[test]
    fn open_tab_changes_nothing_for_a_file_already_held() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("editor-2", "b", Some("/b.md"))]);
        assert_eq!(
            open_tab(&mut reg, &mut HashMap::new(), "main", Some("/a.md"), "t9".to_string(), |_| true),
            TabOpened::ThisWindow { tab_id: "a".to_string() }
        );
        assert_eq!(
            open_tab(&mut reg, &mut HashMap::new(), "main", Some("/b.md"), "t9".to_string(), |_| true),
            TabOpened::OtherWindow { label: "editor-2".to_string() }
        );
        assert_eq!(reg.window("main").unwrap().tabs.len(), 1);
    }

    #[test]
    fn open_tab_takes_over_a_file_whose_window_is_gone() {
        let mut reg = reg_with(&[("editor-2", "b", Some("/b.md"))]);
        assert_eq!(
            open_tab(&mut reg, &mut HashMap::new(), "main", Some("/b.md"), "t1".to_string(), |l| l != "editor-2"),
            TabOpened::Created { tab_id: "t1".to_string() }
        );
        assert!(reg.window("editor-2").is_none(), "the stale window entry is dropped");
    }

    #[test]
    fn taking_over_from_a_dead_window_drops_the_payload_it_never_pulled() {
        let mut reg = reg_with(&[("editor-2", "b", Some("/b.md"))]);
        let mut pending = HashMap::from([
            ("editor-2".to_string(), PendingOpen::single_file("b".to_string(), "/b.md".to_string())),
            ("editor-3".to_string(), PendingOpen::default()),
        ]);
        open_tab(&mut reg, &mut pending, "main", Some("/b.md"), "t1".to_string(), |l| l != "editor-2");
        assert!(!pending.contains_key("editor-2"));
        assert!(pending.contains_key("editor-3"), "other windows' payloads are untouched");

        let mut reg = reg_with(&[("editor-2", "b", Some("/b.md")), ("main", "a", None)]);
        let mut pending = HashMap::from([("editor-2".to_string(), PendingOpen::default())]);
        assert_eq!(claim_path(&mut reg, &mut pending, "main", "a", "/b.md", |l| l != "editor-2"), TabClaim::Claimed);
        assert!(pending.is_empty());
    }

    #[test]
    fn open_tab_without_a_path_always_creates_an_untitled_tab() {
        let mut reg = reg_with(&[("main", "a", None)]);
        assert_eq!(
            open_tab(&mut reg, &mut HashMap::new(), "main", None, "t2".to_string(), |_| true),
            TabOpened::Created { tab_id: "t2".to_string() }
        );
        assert_eq!(reg.window("main").unwrap().tabs.len(), 2);
    }

    #[test]
    fn claim_path_points_the_tab_at_a_free_file() {
        let mut reg = reg_with(&[("main", "a", None)]);
        assert_eq!(claim_path(&mut reg, &mut HashMap::new(), "main", "a", "/new.md", |_| true), TabClaim::Claimed);
        assert_eq!(reg.tab_path("main", "a").as_deref(), Some("/new.md"));
        assert_eq!(claim_path(&mut reg, &mut HashMap::new(), "main", "a", "/new.md", |_| true), TabClaim::Claimed, "idempotent");
    }

    #[test]
    fn claim_path_never_takes_a_file_another_tab_holds() {
        let mut reg = reg_with(&[("main", "a", None), ("main", "b", Some("/b.md")), ("editor-2", "x", Some("/x.md"))]);
        assert_eq!(
            claim_path(&mut reg, &mut HashMap::new(), "main", "a", "/b.md", |_| true),
            TabClaim::ThisWindow { tab_id: "b".to_string() }
        );
        assert_eq!(
            claim_path(&mut reg, &mut HashMap::new(), "main", "a", "/x.md", |_| true),
            TabClaim::OtherWindow { label: "editor-2".to_string() }
        );
        assert_eq!(reg.tab_path("main", "a"), None);
    }

    #[test]
    fn claim_path_registers_a_tab_the_registry_does_not_know() {
        let mut reg = TabRegistry::new();
        assert_eq!(claim_path(&mut reg, &mut HashMap::new(), "main", "late", "/a.md", |_| true), TabClaim::Claimed);
        assert_eq!(reg.owner_of("/a.md"), Some(("main".to_string(), "late".to_string())));
    }

    #[test]
    fn claim_path_with_a_foreign_tab_id_claims_nothing() {
        let mut reg = reg_with(&[("editor-2", "x", None)]);
        assert_eq!(claim_path(&mut reg, &mut HashMap::new(), "main", "x", "/a.md", |_| true), TabClaim::Refused);
        assert!(!reg.contains_path("/a.md"));
        assert_eq!(reg.window("editor-2").unwrap().tabs[0].path, None);
    }

    #[test]
    fn answers_serialize_the_way_the_frontend_reads_them() {
        assert_eq!(
            serde_json::to_string(&TabOpened::Created { tab_id: "t1".to_string() }).unwrap(),
            r#"{"kind":"created","tabId":"t1"}"#
        );
        assert_eq!(
            serde_json::to_string(&TabOwner::ThisWindow { tab_id: "a".to_string() }).unwrap(),
            r#"{"kind":"this-window","tabId":"a"}"#
        );
        assert_eq!(
            serde_json::to_string(&TabOwner::OtherWindow { label: "editor-2".to_string() }).unwrap(),
            r#"{"kind":"other-window","label":"editor-2"}"#
        );
        assert_eq!(serde_json::to_string(&TabOwner::None).unwrap(), r#"{"kind":"none"}"#);
        assert_eq!(serde_json::to_string(&TabClaim::Claimed).unwrap(), r#"{"kind":"claimed"}"#);
        assert_eq!(serde_json::to_string(&TabClaim::Refused).unwrap(), r#"{"kind":"refused"}"#);
    }
}
