//! Show a file in Finder (file-links D2) — never open it. Plan 03 adds
//! `current_modifiers` here: both are thin `objc` runtime calls.
//!
//! Plain `objc` runtime calls (`Class::get`, `Sel::register`, `send_message`)
//! rather than `cocoa` + `msg_send!`, for the reason `keep_behind_key_window`
//! in `window.rs` gives: every `cocoa` item is deprecated, and `objc` 0.2's
//! `sel!` expands to a `cfg` this crate does not declare.

use std::path::{Path, PathBuf};

use tauri::AppHandle;

/// The path `reveal_in_finder` may select: absolute and present (a dangling
/// symlink counts — Finder shows the link itself).
pub fn reveal_target(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(format!("not an absolute path: {path}"));
    }
    if std::fs::symlink_metadata(p).is_err() {
        return Err(format!("no such file: {path}"));
    }
    Ok(p.to_path_buf())
}

/// `NSWorkspace activateFileViewerSelectingURLs:` on the main thread. No
/// shell, no `open`: the shell plugin's scope stays `http(s)`/`mailto`/`tel`.
#[tauri::command]
pub async fn reveal_in_finder(app: AppHandle, path: String) -> Result<(), String> {
    let target = reveal_target(&path)?;
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(select_in_finder(&target));
    })
    .map_err(|e| e.to_string())?;
    let outcome = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?;
    match outcome {
        Ok(result) => result,
        Err(_) => Err("Finder did not answer".to_string()),
    }
}

#[cfg(target_os = "macos")]
fn select_in_finder(path: &Path) -> Result<(), String> {
    use objc::runtime::{Class, Object, Sel};
    use objc::Message;
    use std::os::unix::ffi::OsStrExt;

    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| "the path contains a NUL byte".to_string())?;
    let class = |name: &str| Class::get(name).ok_or_else(|| format!("{name} is not available"));
    unsafe {
        let ns_path: *mut Object = class("NSString")?
            .send_message(Sel::register("stringWithUTF8String:"), (c_path.as_ptr(),))
            .map_err(|e| format!("{e:?}"))?;
        if ns_path.is_null() {
            return Err("the path is not valid UTF-8".to_string());
        }
        let url: *mut Object = class("NSURL")?
            .send_message(Sel::register("fileURLWithPath:"), (ns_path,))
            .map_err(|e| format!("{e:?}"))?;
        if url.is_null() {
            return Err("could not make a file URL".to_string());
        }
        let urls: *mut Object = class("NSArray")?
            .send_message(Sel::register("arrayWithObject:"), (url,))
            .map_err(|e| format!("{e:?}"))?;
        let workspace: *mut Object = class("NSWorkspace")?
            .send_message(Sel::register("sharedWorkspace"), ())
            .map_err(|e| format!("{e:?}"))?;
        if urls.is_null() || workspace.is_null() {
            return Err("Finder is not available".to_string());
        }
        (*workspace)
            .send_message::<(*mut Object,), ()>(
                Sel::register("activateFileViewerSelectingURLs:"),
                (urls,),
            )
            .map_err(|e| format!("{e:?}"))?;
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn select_in_finder(_path: &Path) -> Result<(), String> {
    Err("Show in Finder is available on macOS only".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn an_existing_absolute_path_may_be_revealed() {
        let dir =
            std::env::temp_dir().join(format!("couplet-reveal-{}", crate::session::new_tab_id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.png"), "x").unwrap();
        assert_eq!(
            reveal_target(dir.join("a.png").to_str().unwrap()).unwrap(),
            dir.join("a.png")
        );
    }

    #[test]
    fn a_relative_or_missing_path_is_refused() {
        assert!(reveal_target("a.png").is_err());
        assert!(reveal_target("/definitely/not/here/a.png").is_err());
    }
}
