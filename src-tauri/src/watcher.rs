use std::path::Path;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

/// Starts watching a file for external modifications.
/// Sends `file-changed-externally` events to the window with the given label.
/// Returns the watcher handle (dropping it stops watching).
pub fn watch_file(
    app: &AppHandle,
    window_label: String,
    file_path: String,
) -> Result<RecommendedWatcher, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File does not exist: {}", file_path));
    }

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

    let mut watcher =
        RecommendedWatcher::new(tx, notify::Config::default().with_poll_interval(Duration::from_secs(2)))
            .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher
        .watch(path, RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch file: {}", e))?;

    // The document's comment sidecar rides the SAME watcher instance rather
    // than a second one: `FileWatchers` is keyed by window label and holds one
    // watcher each, and dropping a watcher stops it — so inserting a second
    // one under the same label would silently kill the document's own watching.
    //
    // The sidecar usually does not exist yet when a document is opened; that is
    // fine. It appears with the first comment, and the frontend re-registers
    // the file at that point, which rebuilds this watcher.
    if let Some(sidecar) = crate::comments::sidecar_path(path) {
        if sidecar.exists() {
            let _ = watcher.watch(&sidecar, RecursiveMode::NonRecursive);
        }
    }

    let app_handle = app.clone();
    let watched_path = file_path.clone();

    thread::spawn(move || {
        let mut last_emit = Instant::now() - Duration::from_secs(10);
        // Separate debounce for the sidecar. A single shared one would swallow
        // the agent's reply whenever it lands within 500ms of our own document
        // save — which is exactly the common sequence: `mdmini edit` the
        // document, then immediately answer in the thread.
        let mut last_emit_sidecar = Instant::now() - Duration::from_secs(10);

        while let Ok(result) = rx.recv() {
            match result {
                Ok(event) => {
                    if matches!(
                        event.kind,
                        EventKind::Modify(_) | EventKind::Create(_)
                    ) {
                        let is_sidecar = event
                            .paths
                            .iter()
                            .any(|p| crate::comments::is_sidecar(p));

                        // Debounce: skip events within 500ms of last emit
                        // (suppresses tmp+rename noise from our own atomic saves)
                        let last = if is_sidecar {
                            &mut last_emit_sidecar
                        } else {
                            &mut last_emit
                        };
                        let now = Instant::now();
                        if now.duration_since(*last) < Duration::from_millis(500) {
                            continue;
                        }
                        *last = now;

                        if let Some(window) = app_handle.get_webview_window(&window_label) {
                            // Comments get their own event: the document did
                            // not change, so the frontend must rebuild the
                            // comment cards and leave the buffer, the dirty
                            // flag and autosave alone. Routing this through
                            // `file-changed-externally` would also hit that
                            // handler's blocking "reload and lose changes?"
                            // dialog — unacceptable for a write the agent made.
                            if is_sidecar {
                                let payload = event
                                    .paths
                                    .first()
                                    .map(|p| p.display().to_string())
                                    .unwrap_or_else(|| watched_path.clone());
                                let _ = window.emit_to(window_label.as_str(), "comments-changed", &payload);
                            } else {
                                let _ = window.emit_to(
                                    window_label.as_str(),
                                    "file-changed-externally",
                                    &watched_path,
                                );
                            }
                        } else {
                            break;
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Watch error for {}: {}", watched_path, e);
                }
            }
        }
    });

    Ok(watcher)
}

/// IPC command: start watching a file for the calling window.
#[tauri::command]
pub async fn start_watching(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let watcher = watch_file(&app, label.clone(), path)?;
    let watchers = app.state::<crate::window::FileWatchers>();
    let mut wmap = watchers.0.lock().unwrap();
    wmap.insert(label, watcher);
    Ok(())
}
