use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use notify::RecommendedWatcher;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::tabs::TabRegistry;

/// Every window's tabs, and through them which tab holds each file — see
/// `tabs.rs`. Every dedup check in the app goes through it.
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

#[cfg(test)]
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

/// IPC command: what this window shows on mount.
///
/// The contract with the frontend:
/// - Its `open-file` and `reopen-tab` listeners are registered — awaited —
///   BEFORE this is called. The window counts as mounted from here on, and a
///   file for it arrives as one of those events instead of in this payload;
///   one arriving before the listeners exist is lost.
/// - The tabs returned are already registered. The frontend calls
///   `tab_activate` for the active one (that is what points the watcher at
///   it) and never `tab_open` for any of them.
/// - A tab from `open-file` / `reopen-tab` is not registered: it goes through
///   `tab_open`, which checks ownership and claims it.
#[tauri::command]
pub async fn get_window_init(
    app: AppHandle,
    window: tauri::Window,
    pending: tauri::State<'_, PendingFiles>,
    open_files: tauri::State<'_, OpenFiles>,
) -> Result<WindowInit, String> {
    let label = window.label().to_string();
    let (init, moved) = {
        let mut reg = open_files.0.lock().map_err(|e| e.to_string())?;
        // Taken under the registry lock, together with `mark_mounted`: see
        // `queue_tab`, which appends to a payload only while it is unmounted.
        let taken = pending.0.lock().map_err(|e| e.to_string())?.remove(&label);
        reg.mark_mounted(&label);
        // A window created before `WindowNumbers` was managed missed its number.
        let moved = number_if_missing(&mut reg, &label, allocate_from(&app));
        (window_init(&mut reg, &label, taken, crate::session::new_tab_id), moved)
    };
    if moved {
        save_window_counter(&app);
    }
    Ok(init)
}

/// Stores a pending payload per window label, pulled by the frontend on mount.
///
/// Lock order: `OpenFiles` → `PendingFiles`, never the reverse.
pub struct PendingFiles(pub Mutex<HashMap<String, PendingOpen>>);

impl PendingFiles {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

/// How a tab reached a window, or why it did not.
#[derive(Debug, PartialEq, Eq)]
pub enum Handover {
    /// Registered and waiting, active, in the window's pending payload.
    Pending,
    /// Its frontend has mounted: an event reaches it now, and it opens and
    /// claims the tab itself.
    Mounted,
    /// A live window's tab holds the file already.
    Held(String),
}

/// Give `label` a tab for `tab` while its frontend has not mounted: an event
/// sent now would be lost. Registered in the registry (every dedup check
/// consults it) and appended, active, to the pending payload — a tab, not a
/// replacement, so several files can wait for one window. A holder whose
/// window is gone does not block it.
///
/// Called with both locks held: `get_window_init` takes the payload and marks
/// the window mounted under the same registry lock, so a payload is never
/// appended to after it was taken.
pub fn queue_tab(
    reg: &mut TabRegistry,
    pending: &mut HashMap<String, PendingOpen>,
    label: &str,
    tab: PendingTab,
    is_live: impl Fn(&str) -> bool,
) -> Handover {
    if let Some(path) = &tab.path {
        if let Some(owner) = evict_dead(reg, pending, path, is_live) {
            return Handover::Held(owner);
        }
    }
    if reg.is_mounted(label) {
        return Handover::Mounted;
    }
    if !reg.add_tab(label, &tab.tab_id, tab.path.clone()) {
        return Handover::Held(label.to_string());
    }
    reg.set_active(label, &tab.tab_id);
    let entry = pending.entry(label.to_string()).or_default();
    entry.active_tab_id = Some(tab.tab_id.clone());
    entry.tabs.push(tab);
    Handover::Pending
}

/// `queue_tab` for a live app.
pub fn hand_over_tab(app: &AppHandle, label: &str, tab: PendingTab) -> Handover {
    let open_files = app.state::<OpenFiles>();
    let mut reg = open_files.0.lock().unwrap();
    let pending = app.state::<PendingFiles>();
    let mut map = pending.0.lock().unwrap();
    queue_tab(&mut reg, &mut map, label, tab, |l| app.get_webview_window(l).is_some())
}

/// Point `label`'s one watcher at `path`, or stop watching (`None`, or a file
/// that does not exist yet). Background tabs are not watched; returning to
/// one compares its file with what it held when it was left.
///
/// The tab commands call this with the `OpenFiles` lock held, so two of them
/// for one window cannot leave the watcher on the tab that lost.
pub fn set_watcher(app: &AppHandle, label: &str, path: Option<&str>) {
    let watcher = path.and_then(|p| {
        crate::watcher::watch_file(app, label.to_string(), p.to_string()).ok()
    });
    let watchers = app.state::<FileWatchers>();
    let mut map = watchers.0.lock().unwrap();
    match watcher {
        Some(w) => {
            map.insert(label.to_string(), w);
        }
        None => {
            map.remove(label);
        }
    }
}

/// Holds active file watchers keyed by window label. Dropping a watcher stops watching.
///
/// Lock order: `OpenFiles` → `PendingFiles` → `FileWatchers`; nothing is
/// locked while this one is held.
pub struct FileWatchers(pub Mutex<HashMap<String, RecommendedWatcher>>);

impl FileWatchers {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

/// The live window holding `path`, if any — `evict_dead` for a live app.
/// Called with the `OpenFiles` lock held; takes `PendingFiles` itself.
pub(crate) fn live_owner(app: &AppHandle, reg: &mut TabRegistry, path: &str) -> Option<String> {
    let pending = app.state::<PendingFiles>();
    let mut pending = pending.0.lock().unwrap();
    evict_dead(reg, &mut pending, path, |label| app.get_webview_window(label).is_some())
}

/// The live window holding `path`, if any. A holder whose window is gone
/// (`is_live` says no) is stale: its registry entry and the payload it never
/// came to pull are dropped, so the file can be claimed again.
pub fn evict_dead(
    reg: &mut TabRegistry,
    pending: &mut HashMap<String, PendingOpen>,
    path: &str,
    is_live: impl Fn(&str) -> bool,
) -> Option<String> {
    let label = reg.label_of(path)?;
    if is_live(&label) {
        return Some(label);
    }
    reg.remove_window(&label);
    pending.remove(&label);
    None
}

/// Give `label` its window number: `preferred` (a restored window's own) when
/// it is free, else whatever `allocate` hands out. Returns whether `allocate`
/// did — the counter moved and wants `save_window_counter` once the registry
/// lock is released.
pub fn number_window(
    reg: &mut TabRegistry,
    label: &str,
    preferred: Option<u32>,
    allocate: impl FnOnce(&HashSet<u32>) -> Option<u32>,
) -> bool {
    let live = reg.numbers_in_use();
    if let Some(n) = crate::window_numbers::pick_restored(preferred, &live) {
        reg.set_number(label, Some(n));
        return false;
    }
    let number = allocate(&live);
    reg.set_number(label, number);
    number.is_some()
}

/// `number_window` for a window that has no number yet, and only then.
pub fn number_if_missing(
    reg: &mut TabRegistry,
    label: &str,
    allocate: impl FnOnce(&HashSet<u32>) -> Option<u32>,
) -> bool {
    if reg.window(label).is_some_and(|w| w.number.is_some()) {
        return false;
    }
    number_window(reg, label, None, allocate)
}

/// The next number from the app's counter, in memory only. Lock order:
/// `OpenFiles` → `WindowNumbers`, never the reverse.
///
/// `try_state`: the single-instance callback can open a window from its own
/// task before `setup` has managed `WindowNumbers`, and a panic there would
/// end that listener for the rest of the run. Such a window stays unnumbered
/// until its frontend mounts (`get_window_init`).
fn allocate_from(app: &AppHandle) -> impl FnOnce(&HashSet<u32>) -> Option<u32> + '_ {
    move |live| {
        app.try_state::<crate::window_numbers::WindowNumbers>()
            .and_then(|numbers| numbers.allocate(live))
    }
}

/// Write the counter to disk. Never under the `OpenFiles` lock.
fn save_window_counter(app: &AppHandle) {
    if let Some(numbers) = app.try_state::<crate::window_numbers::WindowNumbers>() {
        numbers.save();
    }
}

/// Number the `main` window — created by `tauri.conf.json`, not by us.
pub fn number_main_window(app: &AppHandle) {
    let moved = {
        let open_files = app.state::<OpenFiles>();
        let mut reg = open_files.0.lock().unwrap();
        number_window(&mut reg, "main", None, allocate_from(app))
    };
    if moved {
        save_window_counter(app);
    }
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
            let moved = {
                let open_files = app.state::<OpenFiles>();
                let mut reg = open_files.0.lock().unwrap();
                number_window(&mut reg, &label, None, allocate_from(app))
            };
            if moved {
                save_window_counter(app);
            }
            if let Some(file_path) = path {
                let tab = PendingTab {
                    tab_id: crate::session::new_tab_id(),
                    path: Some(file_path.clone()),
                    content: None,
                    cursor: 0,
                    top_line: 1,
                };
                match hand_over_tab(app, &label, tab) {
                    Handover::Pending => set_watcher(app, &label, Some(&file_path)),
                    // Mounted before the tab could be queued: its listeners
                    // exist, and it opens and claims the tab itself.
                    Handover::Mounted => {
                        let _ = app.emit_to(label.as_str(), "open-file", &file_path);
                    }
                    // Claimed since the check above. The file stays with its
                    // holder — it must never be shown and autosaved in two
                    // windows — and this window opens with one untitled tab.
                    Handover::Held(owner) => {
                        eprintln!("open_file_window: {file_path} is held by {owner}; {label} opens empty");
                        if let Some(win) = app.get_webview_window(&owner) {
                            reveal(&win);
                            let _ = win.emit_to(owner.as_str(), "open-file", &file_path);
                        }
                    }
                }
            }
        }
        Err(e) => {
            eprintln!("Failed to create window: {}", e);
        }
    }
}

/// Removes a file path from the open files tracking when a window is closed.
/// Also cleans up any recovery file for that path.
pub fn untrack_window(app: &AppHandle, label: &str) {
    let paths: Vec<String> = {
        let open_files = app.state::<OpenFiles>();
        let mut reg = open_files.0.lock().unwrap();
        // A window closed before it mounted never pulled its payload.
        app.state::<PendingFiles>().0.lock().unwrap().remove(label);
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

/// Recreate a window from a session snapshot — geometry, tabs, and a payload
/// the frontend pulls on mount. Returns the new window's label.
///
/// A tab whose file is already open elsewhere stays where it is (one file, one
/// tab) and an untitled tab whose sidecar is gone has nothing to show. A
/// window left with no tabs is not created; the window holding its first file
/// is focused instead.
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
            // The payload goes in under the same registry lock that registers
            // its tabs: `get_window_init` takes it under that lock too, so it
            // never sees the tabs without their payload.
            let (active_path, number, moved) = {
                let open_files = app.state::<OpenFiles>();
                let mut reg = open_files.0.lock().unwrap();
                let moved = number_window(&mut reg, &label, snapshot.number, allocate_from(app));
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
                app.state::<PendingFiles>().0.lock().unwrap().insert(
                    label.clone(),
                    PendingOpen {
                        tabs: pending_tabs,
                        active_tab_id,
                    },
                );
                (active_path, reg.window(&label).and_then(|w| w.number), moved)
            };
            if moved {
                save_window_counter(app);
            }
            // The seeded entry carries the number it actually got, which may
            // differ from the snapshot's when that one was taken meanwhile.
            app.state::<crate::session::SessionState>()
                .set_number(&label, number);

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
    // A closed main would take the file into a payload nobody pulls.
    if main_shows_a_file || !is_live("main") {
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
/// and report `true`. Used by a tab open (`lib/tabs/controller.ts`) for a file
/// another window holds, so the same file never ends up open — and
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
                // The file may sit in a background tab there; that window
                // activates it through its own open path.
                let _ = win.emit_to(other.as_str(), "open-file", &path);
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
    fn evict_dead_drops_a_holder_whose_window_is_gone_and_its_unpulled_payload() {
        let mut reg = reg(&[("/tmp/a.md", "editor-2"), ("/tmp/b.md", "main")]);
        let mut pending = HashMap::from([
            ("editor-2".to_string(), PendingOpen::default()),
            ("main".to_string(), PendingOpen::default()),
        ]);
        assert_eq!(evict_dead(&mut reg, &mut pending, "/tmp/a.md", |label| label != "editor-2"), None);
        assert!(!reg.contains_path("/tmp/a.md"), "the file can be claimed again");
        assert!(reg.window("editor-2").is_none());
        assert!(!pending.contains_key("editor-2"), "a payload nobody will pull");
        assert!(reg.contains_path("/tmp/b.md"), "live windows are untouched");
        assert!(pending.contains_key("main"));
    }

    #[test]
    fn evict_dead_keeps_a_live_holder() {
        let mut reg = reg(&[("/tmp/a.md", "editor-2")]);
        let mut pending = HashMap::from([("editor-2".to_string(), PendingOpen::default())]);
        assert_eq!(evict_dead(&mut reg, &mut pending, "/tmp/a.md", |_| true), Some("editor-2".to_string()));
        assert_eq!(reg.label_of("/tmp/a.md").as_deref(), Some("editor-2"));
        assert!(pending.contains_key("editor-2"));
    }

    #[test]
    fn evict_dead_is_none_when_nobody_holds_the_path() {
        let mut reg = reg(&[("/tmp/b.md", "main")]);
        let mut pending = HashMap::from([("main".to_string(), PendingOpen::default())]);
        assert_eq!(evict_dead(&mut reg, &mut pending, "/tmp/a.md", |_| false), None);
        assert!(reg.contains_path("/tmp/b.md"), "an unrelated dead-looking window is not evicted");
        assert!(pending.contains_key("main"));
    }

    #[test]
    fn a_file_claimed_before_a_new_window_registers_it_stays_out_of_that_window() {
        // `open_file_window`: the file was free when checked, then another
        // window claimed it while this one was being built.
        let mut reg = reg(&[("/a.md", "editor-2")]);
        let mut pending = HashMap::new();
        assert_eq!(
            queue_tab(&mut reg, &mut pending, "editor-5", file_tab("n1", "/a.md"), |_| true),
            Handover::Held("editor-2".to_string())
        );
        assert!(!pending.contains_key("editor-5"), "no payload carries the path");
        assert_eq!(reg.label_of("/a.md").as_deref(), Some("editor-2"));
        let init = window_init(&mut reg, "editor-5", pending.remove("editor-5"), || "u1".to_string());
        assert_eq!(init.tabs.len(), 1);
        assert_eq!(init.tabs[0].path, None, "the new window opens one untitled tab");
    }

    #[test]
    fn route_opened_file_opens_a_new_window_when_main_is_gone() {
        let reg = TabRegistry::new();
        assert_eq!(route_opened_file(&reg, "/tmp/x.md", |label| label != "main"), OpenedRoute::NewWindow);
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
    fn a_free_restored_number_is_kept_without_touching_the_counter() {
        let mut reg = TabRegistry::new();
        let moved = number_window(&mut reg, "editor-2", Some(7), |_| panic!("must not allocate"));
        assert!(!moved, "nothing to save");
        assert_eq!(reg.window("editor-2").unwrap().number, Some(7));
    }

    #[test]
    fn a_taken_restored_number_falls_back_to_the_counter_skipping_live_ones() {
        let mut reg = TabRegistry::new();
        reg.set_number("main", Some(7));
        let moved = number_window(&mut reg, "editor-2", Some(7), |live| {
            assert!(live.contains(&7));
            Some(8)
        });
        assert!(moved, "the counter moved and wants saving");
        assert_eq!(reg.window("editor-2").unwrap().number, Some(8));
    }

    #[test]
    fn no_number_to_hand_out_means_nothing_to_save() {
        let mut reg = TabRegistry::new();
        assert!(!number_window(&mut reg, "editor-2", None, |_| None));
        assert_eq!(reg.window("editor-2").unwrap().number, None);
    }

    #[test]
    fn a_window_that_missed_its_number_gets_one_at_init() {
        let mut reg = TabRegistry::new();
        reg.add_tab("editor-2", "t", None);
        assert!(number_if_missing(&mut reg, "editor-2", |_| Some(3)));
        assert_eq!(window_init(&mut reg, "editor-2", None, || panic!("has a tab")).number, Some(3));
    }

    #[test]
    fn a_numbered_window_is_never_renumbered_at_init() {
        let mut reg = TabRegistry::new();
        reg.set_number("main", Some(4));
        assert!(!number_if_missing(&mut reg, "main", |_| panic!("must not allocate")));
        assert_eq!(reg.window("main").unwrap().number, Some(4));
    }

    #[test]
    fn window_init_reuses_a_tab_the_window_already_has() {
        let mut reg = TabRegistry::new();
        reg.add_tab("main", "t1", None);
        let init = window_init(&mut reg, "main", None, || panic!("must not mint a second tab"));
        assert_eq!(init.tabs[0].tab_id, "t1");
    }

    fn file_tab(id: &str, path: &str) -> PendingTab {
        PendingTab {
            tab_id: id.to_string(),
            path: Some(path.to_string()),
            content: None,
            cursor: 0,
            top_line: 1,
        }
    }

    #[test]
    fn a_file_opened_into_main_before_it_mounts_reports_under_the_registry_id() {
        // `assign_file_to_main`'s shape: the queued tab's id is both the
        // registry's and the pending payload's, and the frontend reports under it.
        let mut reg = TabRegistry::new();
        let mut pending = HashMap::new();
        assert_eq!(queue_tab(&mut reg, &mut pending, "main", file_tab("m1", "/a.md"), |_| true), Handover::Pending);
        let init = window_init(&mut reg, "main", pending.remove("main"), || panic!("no id needed"));
        assert_eq!(reg.owner_of("/a.md"), Some(("main".to_string(), init.active_tab_id.clone().unwrap())));
    }

    #[test]
    fn queue_tab_adds_tabs_to_an_unmounted_window_the_last_one_active() {
        let mut reg = TabRegistry::new();
        let mut pending = HashMap::new();
        queue_tab(&mut reg, &mut pending, "main", file_tab("m1", "/a.md"), |_| true);
        assert_eq!(queue_tab(&mut reg, &mut pending, "main", file_tab("m2", "/b.md"), |_| true), Handover::Pending);
        let payload = &pending["main"];
        let ids: Vec<&str> = payload.tabs.iter().map(|t| t.tab_id.as_str()).collect();
        assert_eq!(ids, vec!["m1", "m2"], "a tab, not a replacement");
        assert_eq!(payload.active_tab_id.as_deref(), Some("m2"));
        assert_eq!(reg.window("main").unwrap().active.as_deref(), Some("m2"));
        assert_eq!(reg.paths_of("main"), vec!["/a.md".to_string(), "/b.md".to_string()]);
    }

    #[test]
    fn queue_tab_leaves_a_mounted_window_to_its_event() {
        let mut reg = TabRegistry::new();
        let mut pending = HashMap::new();
        reg.mark_mounted("main");
        assert_eq!(queue_tab(&mut reg, &mut pending, "main", file_tab("m1", "/a.md"), |_| true), Handover::Mounted);
        assert!(!reg.contains_path("/a.md"), "the frontend claims it itself");
        assert!(pending.is_empty(), "a payload nobody will pull again");
    }

    #[test]
    fn queue_tab_refuses_a_file_a_live_window_holds_but_not_a_dead_one() {
        let mut reg = reg(&[("/a.md", "editor-2")]);
        let mut pending = HashMap::new();
        assert_eq!(
            queue_tab(&mut reg, &mut pending, "main", file_tab("m1", "/a.md"), |_| true),
            Handover::Held("editor-2".to_string())
        );
        assert!(pending.is_empty());
        assert_eq!(
            queue_tab(&mut reg, &mut pending, "main", file_tab("m1", "/a.md"), |l| l != "editor-2"),
            Handover::Pending
        );
        assert_eq!(reg.label_of("/a.md").as_deref(), Some("main"));
    }
}
