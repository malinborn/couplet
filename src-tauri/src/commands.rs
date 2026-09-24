use crate::atomic_write::{self, NewFileMode};
use std::fs;
use std::path::Path;
use tauri::{command, AppHandle, Emitter};

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
    resolved: String,
    follow_system: bool,
) -> Result<(), String> {
    state.sync(&resolved, follow_system);
    Ok(())
}

/// Sets the Dock icon for the committed theme (see `dock_icon`). Separate from
/// `sync_theme_menu` on purpose: the menu follows a `/theme` preview, the Dock
/// must not — a window closed with the picker open never clears its preview,
/// and the Dock would keep a theme no window shows.
#[command]
pub async fn sync_dock_icon(app: AppHandle, theme: String) -> Result<(), String> {
    crate::dock_icon::apply(&app, &theme);
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

/// Sets the "OCD Alignment" checkbox to match the frontend's persisted flag.
///
/// Нужна не только для вида: `lib.rs` читает состояние этого пункта, чтобы
/// разослать окнам значение тумблера, а не команду «переключи», — и без
/// синхронизации при старте пункт меню и настройка разошлись бы после
/// перезапуска, а значение из меню оказалось бы враньём.
#[command]
pub async fn sync_ocd_alignment_menu(
    state: tauri::State<'_, crate::menu::ViewToggleItems>,
    enabled: bool,
) -> Result<(), String> {
    state.sync_ocd_alignment(enabled);
    Ok(())
}

/// Sets View → Tabs → Compact to the frontend's persisted flag — the same
/// start-up sync as `sync_ocd_alignment_menu`, for the same reason: `lib.rs`
/// sends windows this toggle's value from `ViewToggleItems`, not "flip it".
#[command]
pub async fn sync_tabs_compact_menu(
    state: tauri::State<'_, crate::menu::ViewToggleItems>,
    enabled: bool,
) -> Result<(), String> {
    state.sync_tabs_compact(enabled);
    Ok(())
}

/// Sets File → quick looks' radio pair to the frontend's policy (`"keep"` |
/// `"close"`). Called at start and after every click: macOS toggles the
/// clicked item natively, and this corrects the pair.
#[command]
pub async fn sync_transient_menu(
    state: tauri::State<'_, crate::menu::TransientMenuItems>,
    policy: String,
) -> Result<(), String> {
    state.sync(&policy);
    Ok(())
}

/// Broadcasts a `/theme` slash-command commit to every window, over the same
/// `menu-event` path a native Theme-menu click already uses (`MenuRoute::Broadcast`
/// in `lib.rs`). `App.svelte`'s `menu-event` switch is unchanged by this: it
/// cannot tell this call apart from a real click on the Theme menu.
///
/// One `app.emit` per id, not one per window: a window's `emit` is itself a
/// broadcast, so a loop over the windows would deliver each id N times to each
/// of N windows (see the CLAUDE.md gotcha).
///
/// A concrete theme needs two ids — family and half — because the native
/// menu only ever changes one of them per click, while a `/theme` commit
/// changes both at once. `follow_system` alone reproduces the
/// `theme_system:on` / `theme_system:off` ids `toggle_value` builds for a
/// real "Follow System" click.
#[command]
pub async fn broadcast_theme(
    app: AppHandle,
    family: Option<String>,
    half: Option<String>,
    follow_system: Option<bool>,
) -> Result<(), String> {
    let ids = theme_event_ids(family, half, follow_system)?;
    for id in &ids {
        let _ = app.emit("menu-event", id);
    }
    Ok(())
}

/// Theme families this build ships — the one Rust list; `dock_icon`'s tests
/// read it too, so a family added here without a Dock variant fails a test.
pub(crate) const VALID_FAMILIES: [&str; 6] = ["classic", "aurora", "blueprint", "phosphor", "paper", "ink"];

/// The `menu-event` ids `broadcast_theme` emits, pulled out as a pure
/// function so the validation and id-building are unit-testable without an
/// `AppHandle` (which needs a running app to construct).
fn theme_event_ids(
    family: Option<String>,
    half: Option<String>,
    follow_system: Option<bool>,
) -> Result<Vec<String>, String> {
    const VALID_HALVES: [&str; 2] = ["light", "dark"];

    if let Some(f) = &family {
        if !VALID_FAMILIES.contains(&f.as_str()) {
            return Err(format!("broadcast_theme: unknown family '{f}'"));
        }
    }
    if let Some(h) = &half {
        if !VALID_HALVES.contains(&h.as_str()) {
            return Err(format!("broadcast_theme: unknown half '{h}'"));
        }
    }
    if family.is_none() && half.is_none() && follow_system.is_none() {
        return Err("broadcast_theme: nothing to broadcast".to_string());
    }

    let mut ids: Vec<String> = Vec::new();
    if let Some(f) = family {
        ids.push(format!("theme_family_{f}"));
    }
    if let Some(h) = half {
        ids.push(format!("theme_half_{h}"));
    }
    if let Some(fs) = follow_system {
        ids.push(format!("theme_system:{}", if fs { "on" } else { "off" }));
    }
    Ok(ids)
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
/// exactly what `couplet watch` emits an event for — so this is what wakes the
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

    #[test]
    fn theme_event_ids_concrete_theme_emits_both_family_and_half() {
        // Unlike a native menu click, a `/theme` commit changes family and
        // half in one action — this is what the native menu never has to do.
        let ids = theme_event_ids(Some("aurora".into()), Some("dark".into()), None).unwrap();
        assert_eq!(ids, vec!["theme_family_aurora", "theme_half_dark"]);
    }

    #[test]
    fn theme_event_ids_follow_system_true_and_false() {
        assert_eq!(
            theme_event_ids(None, None, Some(true)).unwrap(),
            vec!["theme_system:on"]
        );
        assert_eq!(
            theme_event_ids(None, None, Some(false)).unwrap(),
            vec!["theme_system:off"]
        );
    }

    #[test]
    fn theme_event_ids_accepts_every_shipped_family() {
        for family in VALID_FAMILIES {
            let ids = theme_event_ids(Some(family.into()), None, None).unwrap();
            assert_eq!(ids, vec![format!("theme_family_{family}")]);
        }
    }

    #[test]
    fn theme_event_ids_rejects_unknown_family_or_half() {
        assert!(theme_event_ids(Some("neon".into()), None, None).is_err());
        assert!(theme_event_ids(None, Some("dim".into()), None).is_err());
    }

    #[test]
    fn theme_event_ids_rejects_an_empty_call() {
        assert!(theme_event_ids(None, None, None).is_err());
    }
}
