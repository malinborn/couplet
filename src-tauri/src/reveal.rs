//! Show a file in Finder (file-links D2) — never open it. `current_modifiers`
//! (plan 03) lives here too: both are thin `objc` runtime calls.
//!
//! Plain `objc` runtime calls (`Class::get`, `Sel::register`, `send_message`)
//! rather than `cocoa` + `msg_send!`, for the reason `keep_behind_key_window`
//! in `window.rs` gives: every `cocoa` item is deprecated, and `objc` 0.2's
//! `sel!` expands to a `cfg` this crate does not declare.

use std::path::{Path, PathBuf};

use serde::Serialize;

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

/// An `NSAutoreleasePool` that drains on `Drop`, panics included — the guard
/// `migration.rs` uses, built on the `objc` runtime like the rest of this
/// file instead of `cocoa`'s deprecated wrapper. `stringWithUTF8String:`,
/// `fileURLWithPath:` and `arrayWithObject:` return autoreleased objects; on
/// the main thread outside AppKit's own event dispatch nothing else is
/// guaranteed to drain them.
#[cfg(target_os = "macos")]
struct AutoreleasePool(*mut objc::runtime::Object);

#[cfg(target_os = "macos")]
impl AutoreleasePool {
    fn new() -> Result<Self, String> {
        use objc::runtime::{Class, Object, Sel};
        use objc::Message;
        let class = Class::get("NSAutoreleasePool").ok_or("NSAutoreleasePool is not available")?;
        // SAFETY: `new` (alloc + init) on NSAutoreleasePool takes no
        // arguments and returns an owned pool, released by `drain` in `Drop`.
        let pool: *mut Object = unsafe {
            class
                .send_message(Sel::register("new"), ())
                .map_err(|e| format!("{e:?}"))?
        };
        if pool.is_null() {
            return Err("could not create an autorelease pool".to_string());
        }
        Ok(Self(pool))
    }
}

#[cfg(target_os = "macos")]
impl Drop for AutoreleasePool {
    fn drop(&mut self) {
        use objc::runtime::Sel;
        use objc::Message;
        // SAFETY: `self.0` is the pool `new` created; nothing else drains it.
        unsafe {
            let _ = (*self.0).send_message::<(), ()>(Sel::register("drain"), ());
        }
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
    // Drained when this function returns, on every path out of it.
    let _pool = AutoreleasePool::new()?;
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

/// The modifier keys held right now (file-links D7). While Finder drives a
/// drag the webview receives no key events, so a drop asks the OS.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Modifiers {
    pub alt: bool,
    pub shift: bool,
    pub ctrl: bool,
    pub meta: bool,
}

// `NSEventModifierFlags` bits.
const NS_SHIFT: u64 = 1 << 17;
const NS_CONTROL: u64 = 1 << 18;
const NS_OPTION: u64 = 1 << 19;
const NS_COMMAND: u64 = 1 << 20;

pub fn modifiers_from_flags(flags: u64) -> Modifiers {
    Modifiers {
        alt: (flags & NS_OPTION) != 0,
        shift: (flags & NS_SHIFT) != 0,
        ctrl: (flags & NS_CONTROL) != 0,
        meta: (flags & NS_COMMAND) != 0,
    }
}

/// `+[NSEvent modifierFlags]` — global state, independent of any event —
/// read on the main thread (R6).
#[tauri::command]
pub async fn current_modifiers(app: AppHandle) -> Result<Modifiers, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(modifier_flags());
    })
    .map_err(|e| e.to_string())?;
    let outcome = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?;
    match outcome {
        Ok(flags) => flags.map(modifiers_from_flags),
        Err(_) => Err("the main thread did not answer".to_string()),
    }
}

#[cfg(target_os = "macos")]
fn modifier_flags() -> Result<u64, String> {
    use objc::runtime::{Class, Sel};
    use objc::Message;
    let class = Class::get("NSEvent").ok_or_else(|| "NSEvent is not available".to_string())?;
    // SAFETY: `+[NSEvent modifierFlags]` takes no arguments and returns an
    // `NSEventModifierFlags`, an `NSUInteger`: `usize` on arm64 and x86_64
    // alike. No `BOOL` is involved (CLAUDE.md's per-arch trap).
    let flags: usize = unsafe {
        class
            .send_message(Sel::register("modifierFlags"), ())
            .map_err(|e| format!("{e:?}"))?
    };
    Ok(flags as u64)
}

#[cfg(not(target_os = "macos"))]
fn modifier_flags() -> Result<u64, String> {
    Ok(0)
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

    #[cfg(target_os = "macos")]
    #[test]
    fn an_autorelease_pool_opens_and_drains() {
        // Nested pools are legal, and `Drop` drains this one: a pool that was
        // never drained, or drained twice, aborts the test process.
        let outer = AutoreleasePool::new().expect("outer pool");
        {
            let _inner = AutoreleasePool::new().expect("inner pool");
        }
        drop(outer);
    }

    #[test]
    fn a_relative_or_missing_path_is_refused() {
        assert!(reveal_target("a.png").is_err());
        assert!(reveal_target("/definitely/not/here/a.png").is_err());
    }

    #[test]
    fn modifier_flags_map_to_keys() {
        assert_eq!(modifiers_from_flags(0), Modifiers::default());
        assert_eq!(
            modifiers_from_flags(1 << 19),
            Modifiers {
                alt: true,
                ..Modifiers::default()
            }
        );
        assert_eq!(
            modifiers_from_flags((1 << 17) | (1 << 18) | (1 << 20)),
            Modifiers {
                alt: false,
                shift: true,
                ctrl: true,
                meta: true
            }
        );
        // Caps Lock (1 << 16) and device-dependent low bits are not modifiers here.
        assert_eq!(modifiers_from_flags((1 << 16) | 0x100), Modifiers::default());
    }

    #[test]
    fn modifiers_serialize_as_plain_flags() {
        let json = serde_json::to_value(Modifiers {
            alt: true,
            ..Modifiers::default()
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "alt": true, "shift": false, "ctrl": false, "meta": false })
        );
    }
}
