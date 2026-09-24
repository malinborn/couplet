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

/// Compare-and-delete: removes `path` from the map only if it still maps to
/// `label`, returning whether it did. Split out of the command so it can be
/// tested without an `AppHandle`.
///
/// By path rather than "everything this label owns", because IPC calls from
/// one window are not guaranteed to be handled in the order they were sent:
/// a release for a failed open of P1 that lands after a successful
/// `register_open_file(P2)` must not take P2 away from the window.
fn release_path(map: &mut HashMap<String, String>, path: &str, label: &str) -> bool {
    if map.get(path).map(String::as_str) == Some(label) {
        map.remove(path);
        true
    } else {
        false
    }
}

/// IPC command: the calling window does not, after all, own `path`.
///
/// The counterpart of `register_open_file`, for one case: a window created for
/// a path (CLI launch, a second-instance open, a session restore) is registered
/// as that path's owner — and its watcher started — before the frontend has
/// read a byte. When the read then fails (not valid UTF-8, permissions), the
/// window stays Untitled and shows the error; without this the stale entry
/// would make every later open of the same path focus that Untitled window
/// instead of trying again.
///
/// The watcher is dropped only when an entry was actually removed: a window's
/// watcher follows its registration, so if `path` was not (or no longer) this
/// window's, the watcher belongs to whatever the window does own now.
#[tauri::command]
pub async fn unregister_open_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let removed = {
        let open_files = app.state::<OpenFiles>();
        let mut map = open_files.0.lock().unwrap();
        release_path(&mut map, &path, &label)
    };
    if removed {
        // Dropping the watcher stops it.
        let watchers = app.state::<FileWatchers>();
        watchers.0.lock().unwrap().remove(&label);
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
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(p, l)| (p.to_string(), l.to_string()))
            .collect()
    }

    #[test]
    fn release_path_removes_the_windows_own_entry() {
        let mut m = map(&[("/a.md", "editor-1"), ("/b.md", "editor-2")]);
        assert!(release_path(&mut m, "/a.md", "editor-1"));
        assert!(!m.contains_key("/a.md"));
        assert_eq!(m.get("/b.md").map(String::as_str), Some("editor-2"));
    }

    #[test]
    fn release_path_leaves_a_path_owned_by_another_window() {
        let mut m = map(&[("/a.md", "editor-2")]);
        assert!(!release_path(&mut m, "/a.md", "editor-1"));
        assert_eq!(m.get("/a.md").map(String::as_str), Some("editor-2"));
    }

    #[test]
    fn release_path_after_the_label_re_registered_to_another_path_is_a_no_op() {
        // The out-of-order case: the window failed to open P1, then opened P2
        // successfully, and `register_open_file(P2)` (which drops every entry
        // for the label first) was handled before the release for P1. The
        // release must not touch P2.
        let mut m = map(&[("/p2.md", "editor-1")]);
        assert!(!release_path(&mut m, "/p1.md", "editor-1"));
        assert_eq!(m.get("/p2.md").map(String::as_str), Some("editor-1"));
    }

    #[test]
    fn release_path_for_an_unknown_path_is_a_no_op() {
        let mut m = map(&[("/b.md", "editor-2")]);
        assert!(!release_path(&mut m, "/nope.md", "editor-1"));
        assert_eq!(m.len(), 1);
    }
}
