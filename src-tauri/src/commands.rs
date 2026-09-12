use crate::atomic_write::{self, NewFileMode};
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

/// Saves the document. The hardening this needs — mode, owner, ACL and xattrs
/// carried across the `rename`, a temp that is never wider than the file it
/// becomes, `fsync` of file and directory — lives in [`crate::atomic_write`],
/// which the comment sidecar uses too. `NewFileMode::Umask` is the document's
/// rule: a file the user named themselves gets whatever mode their environment
/// gives new files, exactly as the original `fs::write` did.
#[command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    atomic_write::save(Path::new(&path), &content, NewFileMode::Umask)
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

// Creating a thread and rewriting its comment box both live in
// `comment_pause.rs` now. They were here, and they set `open` on every write —
// which is what woke an agent on a half-typed sentence (#36). Both writes have
// to agree with the pause rule and with the clock behind it, so they sit next
// to it rather than next to each other.

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

#[cfg(test)]
mod tests {
    //! The save's own behaviour — modes, ACLs, xattrs, symlinks, the crash
    //! window — is tested where it lives, in `crate::atomic_write`, because it
    //! is shared with the comment sidecar and belongs to neither caller. What
    //! is left to test here is the wiring: that `write_file` still reaches it.

    use super::*;
    use crate::atomic_write::testkit::{mode_of, scratch};
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn write_file_goes_through_the_hardened_save() {
        // A 0600 document is the shape of #18: before the fix the save left it
        // 0644. Asserting it through the command rather than through
        // `atomic_write::save` is the point — this is what catches someone
        // reintroducing a plain `fs::write` in the command body.
        let dir = scratch("command");
        let doc = dir.join("note.md");
        fs::write(&doc, "old\n").unwrap();
        fs::set_permissions(&doc, fs::Permissions::from_mode(0o600)).unwrap();

        tauri::async_runtime::block_on(write_file(
            doc.to_string_lossy().into_owned(),
            "new\n".to_string(),
        ))
        .unwrap();

        assert_eq!(fs::read_to_string(&doc).unwrap(), "new\n");
        assert_eq!(mode_of(&doc), 0o600, "the document's mode was reset");
    }

    #[test]
    fn a_brand_new_document_gets_the_mode_the_umask_says() {
        // `NewFileMode::Umask` is the document's rule, and it has to keep
        // reproducing what `fs::write` did. Compared against a live `fs::write`
        // rather than a hardcoded 0644, so the test does not depend on the
        // umask of whoever runs it.
        let dir = scratch("command-new");
        let reference = dir.join("reference.md");
        fs::write(&reference, "x\n").unwrap();
        let doc = dir.join("fresh.md");

        tauri::async_runtime::block_on(write_file(
            doc.to_string_lossy().into_owned(),
            "new\n".to_string(),
        ))
        .unwrap();

        assert_eq!(fs::read_to_string(&doc).unwrap(), "new\n");
        assert_eq!(mode_of(&doc), mode_of(&reference));
    }
}
