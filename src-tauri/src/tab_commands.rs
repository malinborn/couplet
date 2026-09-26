//! IPC for the tab model. Every change of which tab holds which file is
//! decided and applied here under the one `OpenFiles` lock — the pure
//! functions are the decision, the commands wire it to a window.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::session::{SessionState, TabSnapshot};
use crate::tabs::{MoveRefused, TabRegistry};
use crate::window::{self, OpenFiles, PendingFiles, PendingOpen, PendingTab};

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

/// An answer plus the path as the registry spells it
/// (`path_norm::normalize_str`), which the frontend adopts for its tab: an
/// agent names the file by that spelling, and the frontend finds its tabs by
/// path. `None` for an untitled tab.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct WithPath<T> {
    #[serde(flatten)]
    pub answer: T,
    pub path: Option<String>,
}

// The tab commands below are the registry's door for paths from the
// frontend (⌘O, Save As, Recent Files): each normalizes before it takes the
// `OpenFiles` lock, never under it.

#[tauri::command]
pub async fn tab_owner(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<TabOwner, String> {
    let path = crate::path_norm::normalize_str(&path);
    let open_files = app.state::<OpenFiles>();
    let reg = open_files.0.lock().unwrap();
    Ok(owner_for(&reg, &path, window.label(), live_windows(&app)))
}

#[tauri::command]
pub async fn tab_open(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: Option<String>,
) -> Result<WithPath<TabOpened>, String> {
    let path = path.as_deref().map(crate::path_norm::normalize_str);
    let open_files = app.state::<OpenFiles>();
    let mut reg = open_files.0.lock().unwrap();
    let pending = app.state::<PendingFiles>();
    let mut pending = pending.0.lock().unwrap();
    let answer = open_tab(
        &mut reg,
        &mut pending,
        window.label(),
        path.as_deref(),
        crate::session::new_tab_id(),
        live_windows(&app),
    );
    Ok(WithPath { answer, path })
}

#[tauri::command]
pub async fn tab_claim(
    app: AppHandle,
    window: tauri::WebviewWindow,
    tab_id: String,
    path: String,
) -> Result<WithPath<TabClaim>, String> {
    let path = crate::path_norm::normalize_str(&path);
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
    Ok(WithPath { answer: claim, path: Some(path) })
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

/// One tab as its old window hands it over (plan 05) — `MovedTab` in
/// `lib/tabs/controller.ts`. No path: Rust takes a tab's file from its
/// registry, never from a frontend.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MovedTab {
    pub tab_id: String,
    /// An untitled tab's text. Ignored for a file tab: the target reads the file.
    pub content: Option<String>,
    pub cursor: usize,
    pub top_line: usize,
    pub opened_at: u64,
    pub viewed_at: u64,
    pub edited_at: u64,
    pub unviewed: bool,
    pub transient: bool,
    pub transient_seen_at: u64,
    /// The agent inbox items that waited for the tab, untouched.
    pub inbox: Option<serde_json::Value>,
}

impl MovedTab {
    fn into_pending(self, path: Option<String>) -> PendingTab {
        PendingTab {
            content: if path.is_none() { self.content } else { None },
            path,
            tab_id: self.tab_id,
            cursor: self.cursor,
            top_line: self.top_line.max(1),
            opened_at: self.opened_at,
            viewed_at: self.viewed_at,
            edited_at: self.edited_at,
            unviewed: self.unviewed,
            transient: self.transient,
            transient_seen_at: self.transient_seen_at,
            inbox: self.inbox,
        }
    }
}

/// Where `tab_move` sends tabs.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MoveTarget {
    Window { label: String },
    /// A window built for them, in the background (D5).
    NewWindow,
}

/// `tab_move`'s answer: the window the tabs are in now.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct MoveDone {
    pub label: String,
    pub number: Option<u32>,
}

/// How moved tabs reach the target's frontend.
#[derive(Debug, PartialEq)]
pub enum Arrival {
    /// It has mounted: they go to it as one `tabs-arrive` event.
    Event(Vec<PendingTab>),
    /// It has not (a window built for the move): they wait in its payload.
    Pending,
}

/// What `move_tabs_between` did.
#[derive(Debug, PartialEq)]
pub struct Moved {
    pub arrival: Arrival,
    /// The session snapshots of the moved tabs, for `SessionState::move_tab`.
    pub snapshots: Vec<TabSnapshot>,
    /// Each moved untitled tab's id and text, for its sidecar (`save_moved_drafts`).
    pub drafts: Vec<(String, String)>,
}

impl Moved {
    /// Whether `path` left with the moved tabs — then a source watcher on it
    /// stops, until the source shows its next tab (`tab_activate`).
    pub fn took(&self, path: &str) -> bool {
        self.snapshots.iter().any(|s| s.path.as_deref() == Some(path))
    }
}

/// The move itself (D1), with the `OpenFiles` and `PendingFiles` locks held:
/// the registry, the agents' requests for the moved files, and the hand-over
/// — an event for a mounted target, its payload otherwise. `get_window_init`
/// takes the payload and marks the window mounted under the same two locks,
/// so a payload is never appended to after it was pulled. Nothing changes
/// when the target is gone or the registry refuses.
pub fn move_tabs_between(
    reg: &mut TabRegistry,
    pending: &mut HashMap<String, PendingOpen>,
    agents: &crate::ai_socket::AiPending,
    from: &str,
    to: &str,
    tabs: Vec<MovedTab>,
    is_live: impl Fn(&str) -> bool,
) -> Result<Moved, String> {
    if !is_live(to) {
        return Err(format!("window {to} is gone"));
    }
    let ids: Vec<String> = tabs.iter().map(|t| t.tab_id.clone()).collect();
    let moved = reg.move_tabs(from, to, &ids).map_err(|e| e.to_string())?;
    for path in moved.iter().filter_map(|t| t.path.as_deref()) {
        agents.relabel(from, to, path);
    }
    let arriving: Vec<PendingTab> = moved
        .iter()
        .map(|reg_tab| {
            let carried = tabs.iter().find(|t| t.tab_id == reg_tab.id).cloned().unwrap_or_default();
            carried.into_pending(reg_tab.path.clone())
        })
        .collect();
    let snapshots = arriving
        .iter()
        .map(|t| TabSnapshot {
            tab_id: t.tab_id.clone(),
            path: t.path.clone(),
            untitled: None,
            cursor: t.cursor,
            top_line: t.top_line,
            opened_at: t.opened_at,
            viewed_at: t.viewed_at,
            edited_at: t.edited_at,
            unviewed: t.unviewed,
            transient: t.transient,
            transient_seen_at: t.transient_seen_at,
        })
        .collect();
    let drafts = arriving
        .iter()
        .filter(|t| t.path.is_none())
        .map(|t| (t.tab_id.clone(), t.content.clone().unwrap_or_default()))
        .collect();
    let arrival = if reg.is_mounted(to) {
        Arrival::Event(arriving)
    } else {
        let entry = pending.entry(to.to_string()).or_default();
        if entry.active_tab_id.is_none() {
            entry.active_tab_id = arriving.first().map(|t| t.tab_id.clone());
        }
        entry.tabs.extend(arriving);
        Arrival::Pending
    };
    Ok(Moved { arrival, snapshots, drafts })
}

/// After the lock: move the tabs' session entries from `from` to `to`, then
/// write each moved untitled tab's text to its sidecar. Nothing else writes
/// it until the target's first heartbeat, so a quit before a target built
/// for the move has mounted would restore the draft as the source last
/// reported it — up to 5 s old.
///
/// The name is the one the source recorded (`untitled_file_for`, read before
/// the move takes the entry away), so a migrated draft keeps its file. It is
/// recorded — in the target's entry — **before** the file is written, as in
/// `session::record_heartbeat`: the GC ticker deletes every sidecar
/// `referenced_untitled` does not name, and a draft that never had a
/// heartbeat would otherwise be written unreferenced and could be deleted
/// before its name lands. A failed write is logged and the move stands; the
/// name stays recorded — the file it names is the last one written, or none
/// yet, and restore skips an untitled tab whose sidecar cannot be read.
pub fn save_moved_drafts(
    session: &SessionState,
    from: &str,
    to: &str,
    mut snapshots: Vec<TabSnapshot>,
    drafts: &[(String, String)],
    write: impl Fn(&str, &str) -> Result<(), String>,
) {
    let mut writes = Vec::new();
    for (tab_id, text) in drafts {
        let Some(snapshot) = snapshots.iter_mut().find(|s| &s.tab_id == tab_id) else {
            continue;
        };
        let name = session.untitled_file_for(from, tab_id);
        snapshot.untitled = Some(name.clone());
        writes.push((tab_id, name, text));
    }
    for snapshot in snapshots {
        session.move_tab(from, to, snapshot);
    }
    for (tab_id, name, text) in writes {
        if let Err(e) = write(&name, text) {
            eprintln!("tab_move: the draft of {tab_id} was not saved: {e}");
        }
    }
}

/// Build a window for a move, in the background, on the main thread: there
/// `keep_behind_key_window` runs at once, so the window is never drawn over
/// the human's for a frame (as for an agent's open, `ai_socket::dispatch`).
async fn build_move_window(app: &AppHandle) -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(window::build_window(&handle, window::Activation::Background));
    })
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "the window for the move was never built".to_string())?
}

/// Move `tabs` of the calling window to `target` (plan 05, D1). A window
/// built for them is built before the registry lock (`build_window` takes it
/// to number the window), in the background, once a first check under a
/// short lock says the move can go ahead — and destroyed again when the move
/// itself is refused. Never a close or a release (D13): the agents keep
/// waiting — on the target now.
#[tauri::command]
pub async fn tab_move(
    app: AppHandle,
    window: tauri::WebviewWindow,
    tabs: Vec<MovedTab>,
    target: MoveTarget,
) -> Result<MoveDone, String> {
    let from = window.label().to_string();
    if tabs.is_empty() {
        return Err(MoveRefused::Nothing.to_string());
    }
    if let Some(bad) = tabs.iter().find(|t| !crate::session::is_valid_tab_id(&t.tab_id)) {
        return Err(format!("invalid tab id: {:?}", bad.tab_id));
    }
    let (to, built) = match target {
        MoveTarget::Window { label } => (label, false),
        MoveTarget::NewWindow => {
            {
                let ids: Vec<String> = tabs.iter().map(|t| t.tab_id.clone()).collect();
                let open_files = app.state::<OpenFiles>();
                let reg = open_files.0.lock().unwrap();
                reg.check_move(&from, None, &ids).map_err(|e| e.to_string())?;
            }
            (build_move_window(&app).await?, true)
        }
    };
    let outcome = {
        let open_files = app.state::<OpenFiles>();
        let mut reg = open_files.0.lock().unwrap();
        let moved = {
            let pending = app.state::<PendingFiles>();
            let mut pending = pending.0.lock().unwrap();
            let agents = app.state::<crate::ai_socket::AiPending>();
            move_tabs_between(&mut reg, &mut pending, &agents, &from, &to, tabs, live_windows(&app))
        };
        moved.map(|m| {
            if window::watched_path(&app, &from).is_some_and(|p| m.took(&p)) {
                window::set_watcher(&app, &from, None);
            }
            // Under the lock: an agent command routed to the target right
            // after it drops must reach the target's queue after the tabs.
            if let Arrival::Event(arriving) = &m.arrival {
                if let Err(e) = app.emit_to(to.as_str(), "tabs-arrive", arriving) {
                    eprintln!("tab_move: {to} did not get its tabs: {e}");
                }
            }
            (m.snapshots, m.drafts, reg.window(&to).and_then(|w| w.number))
        })
    };
    let (snapshots, drafts, number) = match outcome {
        Ok(ok) => ok,
        Err(e) => {
            if built {
                if let Some(win) = app.get_webview_window(&to) {
                    let _ = win.destroy();
                }
            }
            return Err(e);
        }
    };
    let session = app.state::<SessionState>();
    save_moved_drafts(&session, &from, &to, snapshots, &drafts, crate::session::write_untitled);
    Ok(MoveDone { label: to, number })
}

/// How much of a window's active document its thumbnail gets.
const HEAD_BYTES: usize = 2048;

/// One carousel thumbnail (D8) — `CarouselWindow` in `lib/tabs/carousel.ts`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CarouselWindow {
    pub label: String,
    pub number: Option<u32>,
    pub project: Option<String>,
    /// The active file's branch; `None` outside git or for an untitled tab.
    pub branch: Option<String>,
    pub tab_count: usize,
    pub active_path: Option<String>,
    /// The start of the active document, whole lines, at most `HEAD_BYTES`.
    pub head: String,
}

/// The first bytes of a file — a little more than `HEAD_BYTES`, for the cut.
/// Empty when it cannot be read: a thumbnail is not worth an error.
fn read_start(path: &std::path::Path) -> String {
    use std::io::Read;
    let mut buf = Vec::with_capacity(HEAD_BYTES + 4);
    match std::fs::File::open(path) {
        Ok(file) => {
            let _ = file.take((HEAD_BYTES + 4) as u64).read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        }
        Err(_) => String::new(),
    }
}

/// IPC: the windows the caller's tabs can move to, for its carousel. The
/// registry is read under its lock; the files, the sidecars and `.git/HEAD`
/// only after it is dropped.
#[tauri::command]
pub async fn tab_carousel_windows(app: AppHandle, window: tauri::WebviewWindow) -> Result<Vec<CarouselWindow>, String> {
    // Before the registry lock: binding walks the file system.
    crate::routing::bind_missing_projects(&app);
    let order = app.state::<crate::menu_route::FocusTracker>().order();
    let rows = {
        let open_files = app.state::<OpenFiles>();
        let reg = open_files.0.lock().unwrap();
        crate::routing::carousel_rows(&reg, &order, window.label(), live_windows(&app))
    };
    let session = app.state::<SessionState>();
    Ok(rows
        .into_iter()
        .map(|row| {
            let text = match (&row.active_path, &row.active_untitled) {
                (Some(path), _) => read_start(std::path::Path::new(path)),
                (None, Some(id)) => session
                    .snapshot_for(&row.label)
                    .and_then(|w| w.tabs.into_iter().find(|t| &t.tab_id == id))
                    .and_then(|t| t.untitled)
                    .and_then(|name| crate::session::read_untitled(&name))
                    .unwrap_or_default(),
                (None, None) => String::new(),
            };
            let branch = row
                .active_path
                .as_deref()
                .and_then(|p| crate::git_info::git_info(std::path::Path::new(p)))
                .and_then(|g| g.branch);
            CarouselWindow {
                label: row.label,
                number: row.number,
                project: row.project,
                branch,
                tab_count: row.tab_count,
                active_path: row.active_path,
                head: crate::routing::cut_head(&text, HEAD_BYTES),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_socket::{AiPending, AiResponse};

    #[test]
    fn a_thumbnail_reads_only_the_start_of_a_file_and_nothing_of_a_missing_one() {
        let path = std::env::temp_dir().join(format!("couplet-head-{}.md", crate::session::new_tab_id()));
        std::fs::write(&path, "line\n".repeat(1000)).unwrap();
        assert_eq!(read_start(&path).len(), HEAD_BYTES + 4);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(read_start(&path), "");
    }

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
        assert_eq!(
            serde_json::to_string(&WithPath { answer: TabOpened::Created { tab_id: "t1".to_string() }, path: Some("/a.md".to_string()) })
                .unwrap(),
            r#"{"kind":"created","tabId":"t1","path":"/a.md"}"#
        );
        assert_eq!(
            serde_json::to_string(&WithPath { answer: TabClaim::Claimed, path: Some("/a.md".to_string()) }).unwrap(),
            r#"{"kind":"claimed","path":"/a.md"}"#
        );
        assert_eq!(
            serde_json::to_string(&WithPath { answer: TabOpened::Created { tab_id: "u".to_string() }, path: None }).unwrap(),
            r#"{"kind":"created","tabId":"u","path":null}"#
        );
    }

    /// `<tmp>/<unique>/real/a.md` and `<tmp>/<unique>/link -> real`.
    fn linked_file() -> (std::path::PathBuf, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!("couplet-tabcmd-{}", crate::session::new_tab_id()));
        let real = base.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("a.md"), "x").unwrap();
        std::os::unix::fs::symlink(&real, base.join("link")).unwrap();
        (real.join("a.md"), base.join("link").join("a.md"))
    }

    // The commands normalize with `normalize_str` before they lock; these
    // follow the same two steps.
    use crate::path_norm::normalize_str;

    #[test]
    fn a_tab_opened_by_one_spelling_is_found_by_the_other() {
        let (real, linked) = linked_file();
        let mut reg = TabRegistry::new();
        let path = normalize_str(linked.to_str().unwrap());
        assert_eq!(
            open_tab(&mut reg, &mut HashMap::new(), "main", Some(&path), "t1".to_string(), |_| true),
            TabOpened::Created { tab_id: "t1".to_string() }
        );
        assert_eq!(
            owner_for(&reg, &normalize_str(real.to_str().unwrap()), "editor-2", |_| true),
            TabOwner::OtherWindow { label: "main".to_string() }
        );
        let _ = std::fs::remove_dir_all(real.parent().unwrap().parent().unwrap());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn slash_tmp_and_slash_private_tmp_name_one_tab() {
        let name = format!("couplet-tabcmd-{}.md", crate::session::new_tab_id());
        let file = format!("/tmp/{name}");
        std::fs::write(&file, "x").unwrap();
        let mut reg = TabRegistry::new();
        open_tab(&mut reg, &mut HashMap::new(), "main", Some(&normalize_str(&file)), "t1".to_string(), |_| true);
        let owner = owner_for(&reg, &normalize_str(&format!("/private/tmp/{name}")), "main", |_| true);
        let _ = std::fs::remove_file(&file);
        assert_eq!(owner, TabOwner::ThisWindow { tab_id: "t1".to_string() });
    }

    #[test]
    fn a_claim_of_a_symlinked_spelling_is_refused_while_the_real_path_is_held_elsewhere() {
        let (real, linked) = linked_file();
        let mut reg = reg_with(&[("editor-2", "x", None), ("main", "a", None)]);
        assert_eq!(
            claim_path(&mut reg, &mut HashMap::new(), "editor-2", "x", &normalize_str(real.to_str().unwrap()), |_| true),
            TabClaim::Claimed
        );
        assert_eq!(
            claim_path(&mut reg, &mut HashMap::new(), "main", "a", &normalize_str(linked.to_str().unwrap()), |_| true),
            TabClaim::OtherWindow { label: "editor-2".to_string() }
        );
        assert_eq!(reg.tab_path("main", "a"), None, "nothing claimed");
        let _ = std::fs::remove_dir_all(real.parent().unwrap().parent().unwrap());
    }

    fn moved(id: &str) -> MovedTab {
        MovedTab { tab_id: id.to_string(), cursor: 3, top_line: 2, opened_at: 10, viewed_at: 20, edited_at: 30, ..Default::default() }
    }

    #[test]
    fn a_move_to_a_mounted_window_hands_the_tabs_over_as_one_event() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("main", "u", None), ("main", "k", None), ("editor-2", "x", None)]);
        reg.mark_mounted("editor-2");
        let tabs = vec![
            MovedTab { content: Some("draft".into()), unviewed: true, inbox: Some(serde_json::json!([{ "kind": "pulse" }])), ..moved("u") },
            MovedTab { content: Some("never the file's".into()), transient: true, transient_seen_at: 5, ..moved("a") },
        ];
        let out = move_tabs_between(&mut reg, &mut HashMap::new(), &AiPending::new(), "main", "editor-2", tabs, |_| true).unwrap();
        let Arrival::Event(arriving) = out.arrival else { panic!("the target is mounted") };
        assert_eq!(arriving.iter().map(|t| t.tab_id.as_str()).collect::<Vec<_>>(), vec!["u", "a"]);
        assert_eq!(arriving[0].content.as_deref(), Some("draft"));
        assert_eq!(arriving[0].inbox, Some(serde_json::json!([{ "kind": "pulse" }])));
        assert!(arriving[0].unviewed);
        assert_eq!(arriving[1].path.as_deref(), Some("/a.md"), "the registry's path, never the frontend's");
        assert_eq!(arriving[1].content, None, "a file tab's text comes from its file");
        assert_eq!(
            (arriving[1].cursor, arriving[1].top_line, arriving[1].opened_at, arriving[1].viewed_at),
            (3, 2, 10, 20)
        );
        assert_eq!(arriving[1].edited_at, 30, "the card's time travels with the tab");
        assert!(arriving[1].transient);
        assert_eq!(arriving[1].transient_seen_at, 5);
        assert_eq!(
            out.snapshots.iter().map(|s| (s.tab_id.as_str(), s.path.as_deref())).collect::<Vec<_>>(),
            vec![("u", None), ("a", Some("/a.md"))]
        );
        assert_eq!(
            (out.snapshots[1].transient, out.snapshots[1].transient_seen_at),
            (true, 5),
            "the target's session records the quick look before its first heartbeat (Q8)"
        );
    }

    #[test]
    fn a_moved_draft_is_written_at_once_under_the_name_the_source_recorded() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("main", "u", None), ("main", "e", None)]);
        let session = SessionState::new();
        session.set_tabs(
            "main",
            vec![TabSnapshot { tab_id: "u".into(), untitled: Some("untitled-main.md".into()), ..Default::default() }],
            None,
        );
        let tabs = vec![
            MovedTab { content: Some("typed a second ago".into()), ..moved("u") },
            moved("a"),
            MovedTab { content: None, ..moved("e") },
        ];
        let out =
            move_tabs_between(&mut reg, &mut HashMap::new(), &AiPending::new(), "main", "editor-5", tabs, |_| true).unwrap();
        let writes = std::cell::RefCell::new(Vec::new());
        save_moved_drafts(&session, "main", "editor-5", out.snapshots.clone(), &out.drafts, |name, text| {
            writes.borrow_mut().push((name.to_string(), text.to_string()));
            Ok(())
        });
        assert_eq!(
            writes.into_inner(),
            vec![
                ("untitled-main.md".to_string(), "typed a second ago".to_string()),
                ("draft-e.md".to_string(), String::new()),
            ],
            "the file tab writes nothing; an emptied draft is written empty, not left stale"
        );
        let target = session.snapshot_for("editor-5").unwrap();
        let names: Vec<_> = target.tabs.iter().map(|s| (s.tab_id.as_str(), s.untitled.as_deref())).collect();
        assert_eq!(names, vec![("u", Some("untitled-main.md")), ("a", None), ("e", Some("draft-e.md"))]);
        assert!(session.snapshot_for("main").unwrap().tabs.is_empty(), "moved out of the source's entry");

        let failed = SessionState::new();
        save_moved_drafts(&failed, "main", "editor-5", out.snapshots.clone(), &out.drafts, |_, _| Err("disk full".into()));
        assert_eq!(failed.snapshot_for("editor-5").unwrap().tabs.len(), 3, "a failed write does not undo the move");
    }

    #[test]
    fn a_moved_draft_is_referenced_before_it_is_written() {
        // The ticker prunes whatever `referenced_untitled` does not name: a
        // draft that never had a heartbeat, written first and named after,
        // could be deleted in between.
        let mut reg = reg_with(&[("main", "u", None)]);
        let session = SessionState::new();
        let tabs = vec![MovedTab { content: Some("never heartbeated".into()), ..moved("u") }];
        let out =
            move_tabs_between(&mut reg, &mut HashMap::new(), &AiPending::new(), "main", "editor-5", tabs, |_| true).unwrap();
        let checked = std::cell::Cell::new(false);
        save_moved_drafts(&session, "main", "editor-5", out.snapshots, &out.drafts, |name, _| {
            assert_eq!(name, "draft-u.md");
            assert!(session.referenced_untitled().contains(name), "{name} written before it was referenced");
            checked.set(true);
            Ok(())
        });
        assert!(checked.get());
    }

    #[test]
    fn a_move_to_a_window_that_has_not_mounted_waits_in_its_payload() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("main", "b", Some("/b.md"))]);
        reg.set_number("editor-5", Some(5));
        let mut pending = HashMap::new();
        let out = move_tabs_between(&mut reg, &mut pending, &AiPending::new(), "main", "editor-5", vec![moved("a"), moved("b")], |_| true)
            .unwrap();
        assert_eq!(out.arrival, Arrival::Pending);
        let payload = pending.get("editor-5").expect("queued for its mount");
        assert_eq!(payload.active_tab_id.as_deref(), Some("a"));
        assert_eq!(payload.tabs.iter().map(|t| t.tab_id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        assert!(out.took("/a.md") && out.took("/b.md"), "a source watcher on either must stop");
    }

    #[test]
    fn a_move_to_a_window_that_is_gone_changes_nothing() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("editor-2", "x", None)]);
        let err = move_tabs_between(&mut reg, &mut HashMap::new(), &AiPending::new(), "main", "editor-2", vec![moved("a")], |l| l != "editor-2")
            .unwrap_err();
        assert_eq!(err, "window editor-2 is gone");
        assert_eq!(reg.label_of("/a.md").as_deref(), Some("main"));
    }

    #[test]
    fn a_background_tab_moving_leaves_the_source_watcher_alone() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("main", "b", Some("/b.md")), ("editor-2", "x", None)]);
        reg.mark_mounted("editor-2");
        let out = move_tabs_between(&mut reg, &mut HashMap::new(), &AiPending::new(), "main", "editor-2", vec![moved("b")], |_| true)
            .unwrap();
        assert!(out.took("/b.md"));
        assert!(!out.took("/a.md"), "a watcher on the file that stayed keeps watching");
    }

    #[test]
    fn the_agents_of_a_moved_file_wait_on_the_target() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("editor-2", "x", None)]);
        reg.mark_mounted("editor-2");
        let agents = AiPending::new();
        let (id, rx) = agents.register_waiting("main", Some("/a.md"));
        move_tabs_between(&mut reg, &mut HashMap::new(), &agents, "main", "editor-2", vec![moved("a")], |_| true).unwrap();
        assert!(agents.respond_from(id, "main", AiResponse::ok()).is_err(), "never `tab released`, and not the source's any more");
        agents.respond_from(id, "editor-2", AiResponse::ok()).unwrap();
        assert!(rx.try_recv().unwrap().ok, "answered from its new window");
    }

    #[test]
    fn the_move_speaks_the_frontends_json() {
        let tab: MovedTab = serde_json::from_str(
            r#"{"tabId":"1-2-3","content":"x","cursor":4,"topLine":2,"openedAt":5,"viewedAt":6,"editedAt":8,"unviewed":true,"transient":true,"transientSeenAt":7,"inbox":[]}"#,
        )
        .unwrap();
        assert_eq!(
            tab,
            MovedTab {
                tab_id: "1-2-3".into(),
                content: Some("x".into()),
                cursor: 4,
                top_line: 2,
                opened_at: 5,
                viewed_at: 6,
                edited_at: 8,
                unviewed: true,
                transient: true,
                transient_seen_at: 7,
                inbox: Some(serde_json::json!([])),
            }
        );
        assert_eq!(
            serde_json::from_str::<MoveTarget>(r#"{"kind":"window","label":"editor-2"}"#).unwrap(),
            MoveTarget::Window { label: "editor-2".into() }
        );
        assert_eq!(serde_json::from_str::<MoveTarget>(r#"{"kind":"new-window"}"#).unwrap(), MoveTarget::NewWindow);
        assert_eq!(
            serde_json::to_string(&MoveDone { label: "editor-2".into(), number: Some(7) }).unwrap(),
            r#"{"label":"editor-2","number":7}"#
        );
        let pending = serde_json::to_value(PendingTab { tab_id: "u".into(), transient: true, transient_seen_at: 3, ..Default::default() })
            .unwrap();
        assert_eq!(pending["transientSeenAt"], 3);
        assert!(pending.get("inbox").is_none(), "absent unless carried");
    }
}
