use std::fs;
use std::path::Path;
use tauri::command;

/// Returns and removes the pending payload for the calling window, if any.
/// Called by the frontend in onMount to pick up files passed via CLI args,
/// a new-window open, or a session restore.
#[command]
pub async fn get_pending_file(
    window: tauri::Window,
    state: tauri::State<'_, crate::window::PendingFiles>,
) -> Result<Option<crate::window::PendingOpen>, String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    Ok(map.remove(window.label()))
}

#[command]
pub async fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::InvalidData {
            "Cannot open: file is not valid text.".to_string()
        } else {
            format!("Failed to read file: {}", e)
        }
    })
}

#[command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    let tmp_path = format!("{}.tmp", path);
    fs::write(&tmp_path, &content).map_err(|e| format!("Failed to write: {}", e))?;
    fs::rename(&tmp_path, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to save: {}", e)
    })
}

#[command]
pub async fn file_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// Sets the Theme menu checkmarks to match the frontend's persisted
/// preference. Called on startup and on every theme change — the only
/// writer of these checkmarks (macOS toggles the clicked item natively;
/// this call corrects it).
#[command]
pub async fn sync_theme_menu(
    state: tauri::State<'_, crate::menu::ThemeMenuItems>,
    preference: String,
) -> Result<(), String> {
    state.sync(&preference);
    Ok(())
}

/// Sets the Editor Engine submenu checkmarks ("raw" | "live-preview" |
/// "live-render") to match the frontend's persisted engine. Same pattern as
/// `sync_theme_menu`: called on startup and on every engine change, since
/// macOS toggles the clicked item natively and this call corrects it.
#[command]
pub async fn sync_engine_menu(
    state: tauri::State<'_, crate::menu::EngineMenuItems>,
    engine: String,
) -> Result<(), String> {
    state.sync(&engine);
    Ok(())
}

/// Sets the "Include Live Render in Cmd+E" checkbox to match the frontend's
/// persisted `betaInCycle` flag. Independent of `sync_engine_menu` because
/// it isn't one of the three mutually exclusive engine choices.
#[command]
pub async fn sync_beta_in_cycle_menu(
    state: tauri::State<'_, crate::menu::EngineMenuItems>,
    enabled: bool,
) -> Result<(), String> {
    state.sync_beta_in_cycle(enabled);
    Ok(())
}

/// Comment threads of a document, read from its sidecar. A document with no
/// sidecar yet returns an empty list rather than an error — that is the normal
/// state for most files.
#[command]
pub async fn comment_threads(path: String) -> Result<Vec<crate::comments::Thread>, String> {
    crate::comments::load(std::path::Path::new(&path))
}

/// Creates a thread anchored to `quote` and returns its id.
///
/// The id is generated against the ids already in the file, so a hand-edited
/// file that happens to contain a colliding id cannot produce a duplicate.
///
/// `prefix`/`suffix` are the document text on either side of the fragment at
/// the moment of writing. They are what lets a repeated quote — a single word,
/// a list item, a heading that appears in a table of contents too — be told
/// apart from its duplicates later; without them the card lands on whichever
/// copy comes first in the file (#20). Optional, because a thread can also be
/// written by hand or by an older version.
#[command]
pub async fn comment_create(
    path: String,
    line: usize,
    quote: String,
    text: String,
    prefix: Option<String>,
    suffix: Option<String>,
) -> Result<String, String> {
    let doc = std::path::Path::new(&path);
    let taken: Vec<String> = crate::comments::load(doc)?
        .into_iter()
        .map(|thread| thread.id)
        .collect();
    let id = crate::comments::new_id_avoiding(doc, crate::comments::now_epoch(), &taken);
    let prefix = prefix.unwrap_or_default();
    let suffix = suffix.unwrap_or_default();
    let context = crate::comments::Context {
        prefix: &prefix,
        suffix: &suffix,
    };
    crate::comments::append_thread_ctx(
        doc,
        &id,
        line,
        &quote,
        context,
        crate::comments::SELF_AUTHOR,
        &text,
    )?;
    Ok(id)
}

/// Appends the user's own reply and puts the thread back to `open`.
///
/// `append_reply` sets `answered`, which is right for an agent but wrong here:
/// the user replying again means they are waiting once more, and `open` is
/// exactly what `mdmini watch` emits an event for — so this is what wakes the
/// agent for a follow-up question.
#[command]
pub async fn comment_reply(path: String, id: String, text: String) -> Result<(), String> {
    let doc = std::path::Path::new(&path);
    crate::comments::append_reply(doc, &id, crate::comments::SELF_AUTHOR, &text)?;
    crate::comments::set_status(doc, &id, crate::comments::Status::Open)
}

/// Writes what is currently in the comment box, replacing the user's own
/// trailing reply instead of appending a new one.
///
/// This is the autosave behind the always-editable comment area (#23): the
/// frontend calls it on a debounce while typing, so a pause of a few hundred
/// milliseconds is not a separate reply. Once an agent has answered, the
/// user's next keystrokes start a new reply under the answer rather than
/// rewriting it.
///
/// The status goes back to `open` for the same reason as [`comment_reply`]:
/// the user writing again means they are waiting again, and `open` is what
/// `mdmini watch` wakes an agent on.
#[command]
pub async fn comment_set_reply(path: String, id: String, text: String) -> Result<(), String> {
    let doc = std::path::Path::new(&path);
    crate::comments::set_last_reply(doc, &id, crate::comments::SELF_AUTHOR, &text)?;
    crate::comments::set_status(doc, &id, crate::comments::Status::Open)
}

/// Marks a thread `resolved`. It stays in the file as history — threads are
/// never deleted, and pruning them is ordinary editing of a markdown file.
#[command]
pub async fn comment_resolve(path: String, id: String) -> Result<(), String> {
    crate::comments::set_status(
        std::path::Path::new(&path),
        &id,
        crate::comments::Status::Resolved,
    )
}
