use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use notify::RecommendedWatcher;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::tabs::TabRegistry;

/// Every window's tabs, and through them which tab holds each file — see
/// `tabs.rs`. The name is kept from when this was a `path → label` map;
/// every dedup check in the app still goes through it.
pub struct OpenFiles(pub Mutex<TabRegistry>);

impl OpenFiles {
    pub fn new() -> Self {
        Self(Mutex::new(TabRegistry::new()))
    }
}

/// One tab a freshly created window opens with.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTab {
    pub tab_id: String,
    pub path: Option<String>,
    /// Text of an untitled tab being restored.
    pub content: Option<String>,
    pub cursor: usize,
    pub top_line: usize,
}

/// What a freshly created window should load once its frontend mounts.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingOpen {
    pub tabs: Vec<PendingTab>,
    pub active_tab_id: Option<String>,
}

impl PendingOpen {
    /// A window opening one file in one tab.
    pub fn single_file(tab_id: String, path: String) -> Self {
        Self {
            active_tab_id: Some(tab_id.clone()),
            tabs: vec![PendingTab {
                tab_id,
                path: Some(path),
                content: None,
                cursor: 0,
                top_line: 1,
            }],
        }
    }
}

/// Everything a window's frontend needs on mount — pulled, not pushed, so it
/// cannot race the listener registration.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInit {
    pub number: Option<u32>,
    pub tabs: Vec<PendingTab>,
    pub active_tab_id: Option<String>,
}

/// The pending payload if there is one, else the window's registered tabs —
/// minting one untitled tab for a window that has none (`main` at launch,
/// a ⌘N window).
pub fn window_init(
    reg: &mut TabRegistry,
    label: &str,
    pending: Option<PendingOpen>,
    new_id: impl FnOnce() -> String,
) -> WindowInit {
    let number = reg.window(label).and_then(|w| w.number);
    if let Some(p) = pending.filter(|p| !p.tabs.is_empty()) {
        return WindowInit {
            number,
            tabs: p.tabs,
            active_tab_id: p.active_tab_id,
        };
    }
    let window = reg.ensure_tab(label, new_id);
    WindowInit {
        number,
        tabs: window
            .tabs
            .iter()
            .map(|t| PendingTab {
                tab_id: t.id.clone(),
                path: t.path.clone(),
                content: None,
                cursor: 0,
                top_line: 1,
            })
            .collect(),
        active_tab_id: window.active.clone(),
    }
}

/// IPC command: what this window shows on mount. Replaces `get_pending_file`.
#[tauri::command]
pub async fn get_window_init(
    window: tauri::Window,
    pending: tauri::State<'_, PendingFiles>,
    open_files: tauri::State<'_, OpenFiles>,
) -> Result<WindowInit, String> {
    let label = window.label().to_string();
    let taken = pending.0.lock().map_err(|e| e.to_string())?.remove(&label);
    let mut reg = open_files.0.lock().map_err(|e| e.to_string())?;
    Ok(window_init(&mut reg, &label, taken, crate::session::new_tab_id))
}

/// Stores a pending payload per window label, pulled by the frontend on mount.
pub struct PendingFiles(pub Mutex<HashMap<String, PendingOpen>>);

impl PendingFiles {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

/// Holds active file watchers keyed by window label. Dropping a watcher stops watching.
pub struct FileWatchers(pub Mutex<HashMap<String, RecommendedWatcher>>);

impl FileWatchers {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

/// The live window holding `path`, if any. A holder whose window is already
/// gone is stale — its entry is dropped so the file can be claimed again.
pub(crate) fn live_owner(app: &AppHandle, reg: &mut TabRegistry, path: &str) -> Option<String> {
    evict_dead(reg, path, |label| app.get_webview_window(label).is_some())
}

/// `live_owner` without the app: `is_live` says whether a window label still
/// exists.
pub fn evict_dead(
    reg: &mut TabRegistry,
    path: &str,
    is_live: impl Fn(&str) -> bool,
) -> Option<String> {
    let label = reg.label_of(path)?;
    if is_live(&label) {
        return Some(label);
    }
    reg.remove_window(&label);
    None
}

/// Give `label` its window number: `preferred` (a restored window's own) when
/// it is free, else the next one. Lock order: `OpenFiles` → `WindowNumbers`.
///
/// `try_state`: the single-instance callback can open a window from its own
/// task before `setup` has managed `WindowNumbers`, and a panic there would
/// end that listener for the rest of the run. Such a window goes unnumbered.
fn assign_number(app: &AppHandle, reg: &mut TabRegistry, label: &str, preferred: Option<u32>) {
    let live = reg.numbers_in_use();
    let number = crate::window_numbers::pick_restored(preferred, &live).or_else(|| {
        app.try_state::<crate::window_numbers::WindowNumbers>()
            .and_then(|numbers| numbers.allocate(&live))
    });
    reg.set_number(label, number);
}

/// Number the `main` window — created by `tauri.conf.json`, not by us.
pub fn number_main_window(app: &AppHandle) {
    let open_files = app.state::<OpenFiles>();
    let mut reg = open_files.0.lock().unwrap();
    assign_number(app, &mut reg, "main", None);
}

static WINDOW_COUNTER: AtomicU32 = AtomicU32::new(1);

const CASCADE_OFFSET: f64 = 30.0;
const DEFAULT_WIDTH: f64 = 900.0;
const DEFAULT_HEIGHT: f64 = 700.0;

/// Opens a file in a new window, or focuses an existing window if the file is already open.
/// If `path` is None, opens a new empty window.
pub fn open_file_window(app: &AppHandle, path: Option<String>) {
    if let Some(ref file_path) = path {
        let open_files = app.state::<OpenFiles>();
        let mut reg = open_files.0.lock().unwrap();
        if let Some(label) = live_owner(app, &mut reg, file_path) {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.set_focus();
            }
            return;
        }
    }

    let count = WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst);
    let label = format!("editor-{}", count);
    let offset = (count as f64) * CASCADE_OFFSET;

    let product_name = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "md-mini".to_string());
    let window_title = format!("Untitled — {}", product_name);

    let builder = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App("index.html".into()),
    )
    .title(&window_title)
    .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
    .min_inner_size(400.0, 300.0)
    .position(100.0 + offset, 100.0 + offset)
    .background_color(tauri::utils::config::Color(25, 23, 36, 255));

    match builder.build() {
        Ok(window) => {
            // Bring app + window to foreground (macOS requires NSApp activate)
            let _ = window.set_focus();
            #[cfg(target_os = "macos")]
            unsafe {
                use cocoa::appkit::{NSApplication, NSApplicationActivationPolicy};
                let ns_app = cocoa::appkit::NSApp();
                // `cocoa::base::YES`, never a `true` literal: Objective-C's BOOL
                // is `bool` on aarch64 but `i8` everywhere else, so a literal
                // type-checks on Apple Silicon and fails to compile for x86_64.
                ns_app.activateIgnoringOtherApps_(cocoa::base::YES);
            }
            {
                let open_files = app.state::<OpenFiles>();
                let mut reg = open_files.0.lock().unwrap();
                assign_number(app, &mut reg, &label, None);
            }
            // Track the file path in OpenFiles and store it in PendingFiles
            // so the frontend can pull it on mount via `get_window_init`.
            if let Some(ref file_path) = path {
                let tab_id = crate::session::new_tab_id();
                {
                    let open_files = app.state::<OpenFiles>();
                    let mut reg = open_files.0.lock().unwrap();
                    if !reg.add_tab(&label, &tab_id, Some(file_path.clone())) {
                        eprintln!("open_file_window: {file_path} is already held by another tab; {label} is not registered for it");
                        // Still registered, without the path: the frontend
                        // reports under this id, and a later claim retargets
                        // this tab instead of minting a second id.
                        reg.add_tab(&label, &tab_id, None);
                    }
                }

                let pending = app.state::<PendingFiles>();
                let mut pending_map = pending.0.lock().unwrap();
                pending_map.insert(label.clone(), PendingOpen::single_file(tab_id, file_path.clone()));

                // Start watching the file for external changes
                if let Ok(watcher) = crate::watcher::watch_file(app, label.clone(), file_path.clone()) {
                    let watchers = app.state::<FileWatchers>();
                    let mut wmap = watchers.0.lock().unwrap();
                    wmap.insert(label.clone(), watcher);
                }
            }
        }
        Err(e) => {
            eprintln!("Failed to create window: {}", e);
        }
    }
}

/// The file `label` is showing, if any. The lock is released before this returns.
pub fn open_path_of(app: &AppHandle, label: &str) -> Option<String> {
    let open_files = app.state::<OpenFiles>();
    let reg = open_files.0.lock().unwrap();
    reg.paths_of(label).into_iter().next()
}

/// Removes a file path from the open files tracking when a window is closed.
/// Also cleans up any recovery file for that path.
pub fn untrack_window(app: &AppHandle, label: &str) {
    let paths: Vec<String> = {
        let open_files = app.state::<OpenFiles>();
        let mut reg = open_files.0.lock().unwrap();
        reg.remove_window(label)
            .map(|w| w.tabs.into_iter().filter_map(|t| t.path).collect())
            .unwrap_or_default()
    };

    // Stop file watcher for this window
    let watchers = app.state::<FileWatchers>();
    let mut wmap = watchers.0.lock().unwrap();
    wmap.remove(label); // dropping RecommendedWatcher stops watching
    drop(wmap);

    // Fail any AI command still queued for this window (closed before it ever
    // mounted to pull its queue) instead of leaking the waiting CLI connection
    // until the socket listener's own timeout.
    crate::ai_socket::cancel_queued_for_window(app, label);

    // Fail any AI command already delivered to this window but not yet
    // answered (e.g. an `ask` still waiting on a click) — otherwise the CLI
    // connection hangs until the request's own timeout instead of learning
    // right away that the window it was waiting on is gone.
    app.state::<crate::ai_socket::AiPending>()
        .cancel_for_window(label);

    // Clean up recovery files in background
    for path in paths {
        std::thread::spawn(move || {
            let _ = crate::recovery::delete_recovery_sync(&path);
        });
    }
}

/// IPC command: open a file in a new window (or focus existing).
/// Pass `path: null` to open a new empty window.
#[tauri::command]
pub async fn open_file_window_cmd(app: AppHandle, path: Option<String>) -> Result<(), String> {
    open_file_window(&app, path);
    Ok(())
}

/// IPC command: register `path` as owned by the calling window and (re)start
/// its file watcher.
///
/// A window that opens a file directly — `Cmd+O`, a drag-drop, a restored
/// pending payload — never goes through `open_file_window`'s registration, so
/// without this the path stays invisible to `OpenFiles`. That breaks every
/// dedup check that consults it: the AI-command router would open a second,
/// duplicate window for a file already sitting in this one, and reopening the
/// file from the Open dialog wouldn't find/focus the existing window either.
#[tauri::command]
pub async fn register_open_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<(), String> {
    let label = window.label().to_string();

    // The window's one tab now shows `path`; the path it held before is
    // released by the same call. Another window's claim is never taken.
    let claimed = {
        let open_files = app.state::<OpenFiles>();
        let mut reg = open_files.0.lock().unwrap();
        live_owner(&app, &mut reg, &path);
        reg.set_single_path(&label, &path, crate::session::new_tab_id)
            .is_some()
    };
    if !claimed {
        // Still `Ok`: the frontend has no handling for a refused registration
        // yet, and an error here would surface as a failed open.
        eprintln!("register_open_file: {path} is held by another window; {label} was refused");
        return Ok(());
    }

    // Replacing any existing entry under this label drops (and thus stops)
    // the previous watcher.
    if let Ok(watcher) = crate::watcher::watch_file(&app, label.clone(), path) {
        let watchers = app.state::<FileWatchers>();
        let mut wmap = watchers.0.lock().unwrap();
        wmap.insert(label, watcher);
    }

    Ok(())
}

/// Recreate a window from a session snapshot — geometry, tabs, and a payload
/// the frontend pulls on mount. Returns the new window's label.
///
/// A tab whose file is already open elsewhere stays where it is (one file, one
/// tab) and an untitled tab whose sidecar is gone has nothing to show. A
/// window left with no tabs is not created; the window holding its first file
/// is focused instead, as before tabs.
pub fn open_restored_window(
    app: &AppHandle,
    snapshot: &crate::session::WindowSnapshot,
) -> Option<String> {
    let mut focus_instead: Option<String> = None;
    let mut survivors: Vec<crate::session::TabSnapshot> = Vec::new();
    {
        let open_files = app.state::<OpenFiles>();
        let mut reg = open_files.0.lock().unwrap();
        for tab in &snapshot.tabs {
            if let Some(path) = &tab.path {
                if let Some(owner) = live_owner(app, &mut reg, path) {
                    focus_instead.get_or_insert(owner);
                    continue;
                }
            }
            survivors.push(tab.clone());
        }
    }

    // Sidecars are read outside the registry lock.
    let mut kept: Vec<crate::session::TabSnapshot> = Vec::new();
    let mut pending_tabs: Vec<PendingTab> = Vec::new();
    for tab in survivors {
        let content = match &tab.path {
            Some(_) => None,
            None => match tab.untitled.as_deref().and_then(crate::session::read_untitled) {
                Some(text) => Some(text),
                None => continue,
            },
        };
        pending_tabs.push(PendingTab {
            tab_id: tab.tab_id.clone(),
            path: tab.path.clone(),
            content,
            cursor: tab.cursor,
            top_line: tab.top_line.max(1),
        });
        kept.push(tab);
    }

    if kept.is_empty() {
        if let Some(win) = focus_instead.and_then(|label| app.get_webview_window(&label)) {
            let _ = win.set_focus();
        }
        return None;
    }

    let active_tab_id = snapshot
        .active_tab
        .clone()
        .filter(|a| kept.iter().any(|t| &t.tab_id == a))
        .or_else(|| kept.first().map(|t| t.tab_id.clone()));

    let count = WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst);
    let label = format!("editor-{}", count);

    // Seeded before the frontend's first heartbeat, so every restored tab
    // keeps its id — and each untitled tab goes on writing to the sidecar it
    // was restored from instead of minting a new one and orphaning the old.
    let mut seeded = snapshot.clone();
    seeded.tabs = kept;
    seeded.active_tab = active_tab_id.clone();
    app.state::<crate::session::SessionState>()
        .seed(&label, seeded);

    let product_name = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "md-mini".to_string());
    let window_title = format!("Untitled — {}", product_name);

    let width = if snapshot.width >= 400 {
        snapshot.width as f64
    } else {
        DEFAULT_WIDTH
    };
    let height = if snapshot.height >= 300 {
        snapshot.height as f64
    } else {
        DEFAULT_HEIGHT
    };

    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(&window_title)
        .inner_size(width, height)
        .min_inner_size(400.0, 300.0)
        .position(snapshot.x as f64, snapshot.y as f64)
        .background_color(tauri::utils::config::Color(25, 23, 36, 255));

    match builder.build() {
        Ok(window) => {
            let _ = window.set_focus();
            #[cfg(target_os = "macos")]
            unsafe {
                use cocoa::appkit::NSApplication;
                let ns_app = cocoa::appkit::NSApp();
                // See the note on the other call site: BOOL is arch-dependent.
                ns_app.activateIgnoringOtherApps_(cocoa::base::YES);
            }

            // A claim made since the check above wins; that tab is dropped.
            let (active_path, number) = {
                let open_files = app.state::<OpenFiles>();
                let mut reg = open_files.0.lock().unwrap();
                assign_number(app, &mut reg, &label, snapshot.number);
                pending_tabs.retain(|t| {
                    let added = reg.add_tab(&label, &t.tab_id, t.path.clone());
                    if !added {
                        eprintln!(
                            "open_restored_window: tab {} ({:?}) was claimed meanwhile; {label} drops it",
                            t.tab_id, t.path
                        );
                    }
                    added
                });
                let active_path = pending_tabs
                    .iter()
                    .find(|t| Some(&t.tab_id) == active_tab_id.as_ref())
                    .and_then(|t| t.path.clone());
                (active_path, reg.window(&label).and_then(|w| w.number))
            };
            // The seeded entry carries the number it actually got, which may
            // differ from the snapshot's when that one was taken meanwhile.
            app.state::<crate::session::SessionState>()
                .set_number(&label, number);

            app.state::<PendingFiles>().0.lock().unwrap().insert(
                label.clone(),
                PendingOpen {
                    tabs: pending_tabs,
                    active_tab_id,
                },
            );

            if let Some(path) = active_path {
                if let Ok(watcher) = crate::watcher::watch_file(app, label.clone(), path) {
                    let watchers = app.state::<FileWatchers>();
                    watchers.0.lock().unwrap().insert(label.clone(), watcher);
                }
            }
            Some(label)
        }
        Err(e) => {
            eprintln!("Failed to restore window: {}", e);
            // No window will ever heartbeat or be destroyed under this label.
            app.state::<crate::session::SessionState>().remove(&label);
            None
        }
    }
}

/// Which window (if any) should be focused for `path`, excluding
/// `exclude_label` (the window making the request) — split out from
/// `focus_if_open` so the decision is testable without a running window.
pub fn label_to_focus(reg: &TabRegistry, path: &str, exclude_label: &str) -> Option<String> {
    reg.label_of(path).filter(|label| label != exclude_label)
}

/// IPC command: whether `path` is open in a window other than the caller —
/// the query half of `focus_if_open`, with no side effect.
///
/// `switchDocument` needs the answer before it decides anything, and focusing
/// is only one of the outcomes: with a save error standing the window must
/// stay put, so the focus waits for `focus_if_open` in the branch that wants
/// it.
#[tauri::command]
pub async fn is_open_elsewhere(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<bool, String> {
    let open_files = app.state::<OpenFiles>();
    let reg = open_files.0.lock().unwrap();
    Ok(label_to_focus(&reg, &path, window.label())
        .is_some_and(|other| app.get_webview_window(&other).is_some()))
}

/// IPC command: give up the calling window's claim on `path`.
///
/// `RunEvent::Opened` reuses "main" whenever `OpenFiles` has no entry for it,
/// and registers the file to it before the frontend has decided anything. A
/// main window holding a dirty Untitled buffer has no entry either, so the
/// frontend refuses the swap and asks for a new window instead — which
/// `open_file_window` would then dedup against that very registration, focus
/// main, and open nothing. The frontend calls this right before
/// `open_file_window_cmd` so the path is free to get a window of its own.
#[tauri::command]
pub async fn release_open_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<(), String> {
    let open_files = app.state::<OpenFiles>();
    open_files.0.lock().unwrap().clear_path(window.label(), &path);
    Ok(())
}

/// Where a file handed to the app by the OS (`RunEvent::Opened`) goes.
#[derive(Debug, PartialEq, Eq)]
pub enum OpenedRoute {
    /// A live window already shows the file: bring it forward, touch nothing.
    FocusExisting(String),
    /// "main" shows no file, so it takes this one.
    UseMain,
    NewWindow,
}

/// Decide `RunEvent::Opened` for `path`. `is_live` says whether a window label
/// still exists — a mapping whose window is gone is stale and routes as if
/// absent.
///
/// The existing-window check must come first: "main" being empty says nothing
/// about the file, and registering it to main while another window holds it
/// would overwrite that window's `OpenFiles` entry — the file then open in two
/// windows and AI commands for it routed to the wrong one.
pub fn route_opened_file(
    reg: &TabRegistry,
    path: &str,
    is_live: impl Fn(&str) -> bool,
) -> OpenedRoute {
    if let Some(label) = reg.label_of(path).filter(|label| is_live(label)) {
        return OpenedRoute::FocusExisting(label);
    }
    let main_shows_a_file = reg
        .window("main")
        .is_some_and(|w| w.tabs.iter().any(|t| t.path.is_some()));
    if main_shows_a_file {
        OpenedRoute::NewWindow
    } else {
        OpenedRoute::UseMain
    }
}

/// Bring `win` to the front even if it is minimized — tao's macOS
/// `set_focus` is a silent no-op on a minimized window.
pub(crate) fn reveal(win: &tauri::WebviewWindow) {
    if win.is_minimized().unwrap_or(false) {
        let _ = win.unminimize();
    }
    let _ = win.set_focus();
}

/// IPC command: if `path` is already open in a *different* window, focus it
/// and report `true`. Used by `switchDocument` before it replaces the current
/// window's document, so the same file never ends up open — and
/// autosaving — in two windows at once.
///
/// `path` is looked up exactly as given, like every other `OpenFiles` lookup:
/// the map is keyed by the string each window registered, never canonicalized.
#[tauri::command]
pub async fn focus_if_open(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<bool, String> {
    let label = window.label().to_string();
    let target = {
        let open_files = app.state::<OpenFiles>();
        let reg = open_files.0.lock().unwrap();
        label_to_focus(&reg, &path, &label)
    };
    match target {
        Some(other) => match app.get_webview_window(&other) {
            Some(win) => {
                reveal(&win);
                Ok(true)
            }
            None => Ok(false),
        },
        None => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A registry where each `(path, label)` window holds that one file.
    fn reg(entries: &[(&str, &str)]) -> TabRegistry {
        let mut reg = TabRegistry::new();
        for (path, label) in entries {
            assert!(reg.add_tab(label, &format!("tab-{path}"), Some(path.to_string())));
        }
        reg
    }

    #[test]
    fn label_to_focus_finds_another_window_showing_the_path() {
        let reg = reg(&[("/tmp/a.md", "editor-2")]);
        assert_eq!(label_to_focus(&reg, "/tmp/a.md", "main"), Some("editor-2".to_string()));
    }

    #[test]
    fn label_to_focus_excludes_the_calling_window() {
        let reg = reg(&[("/tmp/a.md", "main")]);
        assert_eq!(label_to_focus(&reg, "/tmp/a.md", "main"), None);
    }

    #[test]
    fn label_to_focus_is_none_when_the_path_is_not_open_anywhere() {
        assert_eq!(label_to_focus(&TabRegistry::new(), "/tmp/a.md", "main"), None);
    }

    #[test]
    fn route_opened_file_focuses_the_window_already_showing_it_even_with_main_empty() {
        let reg = reg(&[("/tmp/x.md", "editor-2")]);
        assert_eq!(
            route_opened_file(&reg, "/tmp/x.md", |_| true),
            OpenedRoute::FocusExisting("editor-2".to_string())
        );
    }

    #[test]
    fn route_opened_file_focuses_main_when_main_already_shows_it() {
        let reg = reg(&[("/tmp/x.md", "main")]);
        assert_eq!(
            route_opened_file(&reg, "/tmp/x.md", |_| true),
            OpenedRoute::FocusExisting("main".to_string())
        );
    }

    #[test]
    fn route_opened_file_ignores_a_mapping_to_a_dead_window() {
        let reg = reg(&[("/tmp/x.md", "editor-2")]);
        assert_eq!(
            route_opened_file(&reg, "/tmp/x.md", |label| label != "editor-2"),
            OpenedRoute::UseMain
        );
    }

    #[test]
    fn route_opened_file_uses_an_empty_main() {
        let reg = reg(&[("/tmp/b.md", "editor-2")]);
        assert_eq!(route_opened_file(&reg, "/tmp/x.md", |_| true), OpenedRoute::UseMain);
    }

    #[test]
    fn evict_dead_drops_a_holder_whose_window_is_gone() {
        let mut reg = reg(&[("/tmp/a.md", "editor-2"), ("/tmp/b.md", "main")]);
        assert_eq!(evict_dead(&mut reg, "/tmp/a.md", |label| label != "editor-2"), None);
        assert!(!reg.contains_path("/tmp/a.md"), "the file can be claimed again");
        assert!(reg.window("editor-2").is_none());
        assert!(reg.contains_path("/tmp/b.md"), "live windows are untouched");
    }

    #[test]
    fn evict_dead_keeps_a_live_holder() {
        let mut reg = reg(&[("/tmp/a.md", "editor-2")]);
        assert_eq!(evict_dead(&mut reg, "/tmp/a.md", |_| true), Some("editor-2".to_string()));
        assert_eq!(reg.label_of("/tmp/a.md").as_deref(), Some("editor-2"));
    }

    #[test]
    fn evict_dead_is_none_when_nobody_holds_the_path() {
        let mut reg = reg(&[("/tmp/b.md", "main")]);
        assert_eq!(evict_dead(&mut reg, "/tmp/a.md", |_| false), None);
        assert!(reg.contains_path("/tmp/b.md"), "an unrelated dead-looking window is not evicted");
    }

    #[test]
    fn route_opened_file_opens_a_new_window_when_main_shows_another_file() {
        let reg = reg(&[("/tmp/b.md", "main")]);
        assert_eq!(route_opened_file(&reg, "/tmp/x.md", |_| true), OpenedRoute::NewWindow);
    }

    #[test]
    fn window_init_hands_over_the_pending_tabs() {
        let mut reg = TabRegistry::new();
        let pending = PendingOpen::single_file("t1".to_string(), "/a.md".to_string());
        let init = window_init(&mut reg, "editor-2", Some(pending), || panic!("no id needed"));
        assert_eq!(init.tabs.len(), 1);
        assert_eq!(init.tabs[0].path.as_deref(), Some("/a.md"));
        assert_eq!(init.active_tab_id.as_deref(), Some("t1"));
    }

    #[test]
    fn window_init_without_pending_gives_the_window_one_untitled_tab() {
        let mut reg = TabRegistry::new();
        let init = window_init(&mut reg, "main", None, || "u1".to_string());
        assert_eq!(init.tabs, vec![PendingTab {
            tab_id: "u1".to_string(),
            path: None,
            content: None,
            cursor: 0,
            top_line: 1,
        }]);
        assert_eq!(init.active_tab_id.as_deref(), Some("u1"));
        assert!(reg.window("main").is_some_and(|w| w.tabs.len() == 1), "registered, not just reported");
    }

    #[test]
    fn window_init_carries_the_window_number() {
        let mut reg = TabRegistry::new();
        reg.set_number("main", Some(7));
        assert_eq!(window_init(&mut reg, "main", None, || "u".to_string()).number, Some(7));
    }

    #[test]
    fn window_init_reuses_a_tab_the_window_already_has() {
        let mut reg = TabRegistry::new();
        reg.add_tab("main", "t1", None);
        let init = window_init(&mut reg, "main", None, || panic!("must not mint a second tab"));
        assert_eq!(init.tabs[0].tab_id, "t1");
    }

    #[test]
    fn a_file_opened_into_main_before_it_mounts_reports_under_the_registry_id() {
        // `assign_file_to_main`'s shape: the claim mints the id, the pending
        // payload carries the same one, and the frontend reports under it.
        let mut reg = TabRegistry::new();
        let id = reg.set_single_path("main", "/a.md", || "m1".to_string()).unwrap();
        let init = window_init(&mut reg, "main", Some(PendingOpen::single_file(id, "/a.md".to_string())), || {
            panic!("no id needed")
        });
        assert_eq!(reg.owner_of("/a.md"), Some(("main".to_string(), init.active_tab_id.clone().unwrap())));
    }

    #[test]
    fn opening_a_file_into_the_mounted_window_keeps_its_tab_id() {
        // Cmd+O in a window that mounted with an untitled tab: the claim
        // (`register_open_file`) retargets that tab rather than minting one.
        let mut reg = TabRegistry::new();
        let init = window_init(&mut reg, "main", None, || "u1".to_string());
        let claimed = reg.set_single_path("main", "/a.md", || panic!("must reuse the mounted tab"));
        assert_eq!(claimed, init.active_tab_id);
    }
}
