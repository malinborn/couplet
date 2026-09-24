use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use notify::RecommendedWatcher;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Tracks which file paths are open in which windows.
pub struct OpenFiles(pub Mutex<HashMap<String, String>>);

impl OpenFiles {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

/// What a freshly created window should load once its frontend mounts.
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingOpen {
    pub path: Option<String>,
    /// Text for an Untitled window being restored.
    pub content: Option<String>,
    pub cursor: usize,
    pub top_line: usize,
}

impl PendingOpen {
    pub fn from_path(path: String) -> Self {
        Self {
            path: Some(path),
            content: None,
            cursor: 0,
            top_line: 1,
        }
    }
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

static WINDOW_COUNTER: AtomicU32 = AtomicU32::new(1);

const CASCADE_OFFSET: f64 = 30.0;
const DEFAULT_WIDTH: f64 = 900.0;
const DEFAULT_HEIGHT: f64 = 700.0;

/// Opens a file in a new window, or focuses an existing window if the file is already open.
/// If `path` is None, opens a new empty window.
pub fn open_file_window(app: &AppHandle, path: Option<String>) {
    // If a path is given, check if it's already open
    if let Some(ref file_path) = path {
        let open_files = app.state::<OpenFiles>();
        let map = open_files.0.lock().unwrap();
        if let Some(label) = map.get(file_path) {
            // Focus existing window
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.set_focus();
                return;
            }
            // Window label exists in map but window is gone — fall through to create new
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
            // Track the file path in OpenFiles and store it in PendingFiles
            // so the frontend can pull it on mount via get_pending_file command.
            if let Some(ref file_path) = path {
                let open_files = app.state::<OpenFiles>();
                let mut map = open_files.0.lock().unwrap();
                map.insert(file_path.clone(), label.clone());

                let pending = app.state::<PendingFiles>();
                let mut pending_map = pending.0.lock().unwrap();
                pending_map.insert(label.clone(), PendingOpen::from_path(file_path.clone()));

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

/// The file `label` is registered as showing in `OpenFiles`, if any. The lock
/// is released before this returns.
pub fn open_path_of(app: &AppHandle, label: &str) -> Option<String> {
    let open_files = app.state::<OpenFiles>();
    let map = open_files.0.lock().unwrap();
    map.iter()
        .find(|(_, v)| v.as_str() == label)
        .map(|(k, _)| k.clone())
}

/// Removes a file path from the open files tracking when a window is closed.
/// Also cleans up any recovery file for that path.
pub fn untrack_window(app: &AppHandle, label: &str) {
    let open_files = app.state::<OpenFiles>();
    let mut map = open_files.0.lock().unwrap();
    // Find the file path for this window before removing
    let file_path: Option<String> = map
        .iter()
        .find(|(_, v)| v.as_str() == label)
        .map(|(k, _)| k.clone());
    map.retain(|_, v| v != label);
    drop(map);

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

    // Clean up recovery file in background
    if let Some(path) = file_path {
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

    {
        let open_files = app.state::<OpenFiles>();
        let mut map = open_files.0.lock().unwrap();
        // The window is switching files — drop whatever it used to point at
        // before inserting the new path, so the old path doesn't keep
        // resolving to this window.
        map.retain(|_, v| v != &label);
        map.insert(path.clone(), label.clone());
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

/// Recreate a window from a session snapshot: saved geometry, and a payload the
/// frontend picks up on mount.
///
/// Files already open are focused rather than duplicated, reusing the dedup in
/// `open_file_window`.
pub fn open_restored_window(app: &AppHandle, snapshot: &crate::session::WindowSnapshot) {
    if let Some(path) = &snapshot.path {
        let already_open = {
            let open_files = app.state::<OpenFiles>();
            let map = open_files.0.lock().unwrap();
            map.get(path).and_then(|label| app.get_webview_window(label))
        };
        if let Some(window) = already_open {
            let _ = window.set_focus();
            return;
        }
    }

    let content = snapshot
        .untitled
        .as_deref()
        .and_then(crate::session::read_untitled);

    // An Untitled snapshot whose sidecar has gone is not worth an empty window.
    if snapshot.path.is_none() && content.is_none() {
        return;
    }

    let count = WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst);
    let label = format!("editor-{}", count);

    // Seed the session entry with the restored tab_id before this window's
    // frontend ever sends its first heartbeat — otherwise `untitled_file_for`
    // would find no entry and mint a brand new id on that first call (the
    // restored untitled sidecar would then be written under a new name while
    // the old one goes unreferenced and gets pruned).
    app.state::<crate::session::SessionState>()
        .seed(&label, snapshot.clone());

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

            let pending = app.state::<PendingFiles>();
            let mut pending_map = pending.0.lock().unwrap();
            pending_map.insert(
                label.clone(),
                PendingOpen {
                    path: snapshot.path.clone(),
                    content,
                    cursor: snapshot.cursor,
                    top_line: snapshot.top_line.max(1),
                },
            );
            drop(pending_map);

            if let Some(path) = &snapshot.path {
                let open_files = app.state::<OpenFiles>();
                let mut map = open_files.0.lock().unwrap();
                map.insert(path.clone(), label.clone());
                drop(map);

                if let Ok(watcher) =
                    crate::watcher::watch_file(app, label.clone(), path.clone())
                {
                    let watchers = app.state::<FileWatchers>();
                    let mut wmap = watchers.0.lock().unwrap();
                    wmap.insert(label.clone(), watcher);
                }
            }
        }
        Err(e) => {
            eprintln!("Failed to restore window: {}", e);
            // No window will ever heartbeat or be destroyed under this label.
            app.state::<crate::session::SessionState>().remove(&label);
        }
    }
}

/// Which window (if any) should be focused for `path`, excluding
/// `exclude_label` (the window making the request) — split out from
/// `focus_if_open` so the decision is testable without a running window.
pub fn label_to_focus(
    open_files: &HashMap<String, String>,
    path: &str,
    exclude_label: &str,
) -> Option<String> {
    open_files
        .get(path)
        .filter(|label| label.as_str() != exclude_label)
        .cloned()
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
    let map = open_files.0.lock().unwrap();
    Ok(label_to_focus(&map, &path, window.label())
        .is_some_and(|other| app.get_webview_window(&other).is_some()))
}

/// Remove `path` from `open_files` if — and only if — it maps to `label`.
/// Returns whether an entry was removed. Another window's mapping is never
/// touched: releasing is a window giving up a claim of its own.
pub fn release_mapping(open_files: &mut HashMap<String, String>, path: &str, label: &str) -> bool {
    if open_files.get(path).map(String::as_str) == Some(label) {
        open_files.remove(path);
        true
    } else {
        false
    }
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
    let mut map = open_files.0.lock().unwrap();
    release_mapping(&mut map, &path, window.label());
    Ok(())
}

/// Bring `win` to the front even if it is minimized — tao's macOS
/// `set_focus` is a silent no-op on a minimized window.
fn reveal(win: &tauri::WebviewWindow) {
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
        let map = open_files.0.lock().unwrap();
        label_to_focus(&map, &path, &label)
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

    #[test]
    fn label_to_focus_finds_another_window_showing_the_path() {
        let mut map = HashMap::new();
        map.insert("/tmp/a.md".to_string(), "editor-2".to_string());
        assert_eq!(
            label_to_focus(&map, "/tmp/a.md", "main"),
            Some("editor-2".to_string())
        );
    }

    #[test]
    fn label_to_focus_excludes_the_calling_window() {
        let mut map = HashMap::new();
        map.insert("/tmp/a.md".to_string(), "main".to_string());
        assert_eq!(label_to_focus(&map, "/tmp/a.md", "main"), None);
    }

    #[test]
    fn label_to_focus_is_none_when_the_path_is_not_open_anywhere() {
        let map = HashMap::new();
        assert_eq!(label_to_focus(&map, "/tmp/a.md", "main"), None);
    }

    #[test]
    fn release_mapping_removes_the_calling_windows_own_mapping() {
        let mut map = HashMap::new();
        map.insert("/tmp/a.md".to_string(), "main".to_string());
        map.insert("/tmp/b.md".to_string(), "editor-2".to_string());
        assert!(release_mapping(&mut map, "/tmp/a.md", "main"));
        assert!(!map.contains_key("/tmp/a.md"));
        assert_eq!(map.get("/tmp/b.md"), Some(&"editor-2".to_string()));
    }

    #[test]
    fn release_mapping_leaves_another_windows_mapping() {
        let mut map = HashMap::new();
        map.insert("/tmp/a.md".to_string(), "editor-2".to_string());
        assert!(!release_mapping(&mut map, "/tmp/a.md", "main"));
        assert_eq!(map.get("/tmp/a.md"), Some(&"editor-2".to_string()));
    }

    #[test]
    fn release_mapping_is_a_noop_when_the_path_is_absent() {
        let mut map = HashMap::new();
        map.insert("/tmp/b.md".to_string(), "main".to_string());
        assert!(!release_mapping(&mut map, "/tmp/a.md", "main"));
        assert_eq!(map.len(), 1);
    }
}
