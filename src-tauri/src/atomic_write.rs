//! One hardened "replace this file with that text", shared by every write that
//! lands in the user's own directories.
//!
//! Two callers, one implementation, deliberately: `commands::write_file` (the
//! document) and `comments`'s sidecar (the comment threads, and since #23/#36
//! the reply the human is still typing). Both files sit in the same
//! TCC-protected, cloud-synced folders and carry the same modes, ACLs and
//! extended attributes, so a second copy of this logic would only be a second
//! place for #18 to come back. `recovery.rs` and `session.rs` are pointedly
//! *not* callers: they write inside the app's own data directory, where a
//! plain temp-and-rename is right and there is no user metadata to keep.
//!
//! The shape is still write-a-temp-then-`rename`, and deliberately so: `rename`
//! is the only step here that is atomic with respect to a crash, so a process
//! that dies mid-save leaves the reader's file either entirely old or entirely
//! new, never truncated. Autosave fires every 300 ms and `delete_recovery` runs
//! after every successful save, so between saves there is no recovery snapshot
//! at all — an in-place `truncate` + `write` would open a window, dozens of
//! times a minute, where a crash destroys the file with nothing to restore
//! from. The sidecar has it worse still: nothing snapshots a comment draft, so
//! a truncated sidecar is simply gone. That is what this module protects.
//!
//! What `rename` costs is everything that lives on the *inode* rather than in
//! the directory entry, and what the code below buys back: mode, ownership,
//! ACLs and extended attributes are copied onto the temp before it is renamed
//! into place. Not bought back: the inode number itself, birth time, and hard
//! links — a `rename` necessarily replaces the directory entry, so a second
//! name for the old inode keeps pointing at the old content. See
//! `docs/investigations/2026-09-12-atomic-write-tcc.md`.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Guards against a symlink cycle in [`resolve_write_target`]. The same order
/// of magnitude as the kernel's own `MAXSYMLINKS`.
const MAX_SYMLINK_HOPS: usize = 32;

/// Counter feeding the temp file name, so two concurrent saves in one
/// directory cannot pick the same one.
pub(crate) static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// What mode a file this write has to create *from nothing* should get.
///
/// Only ever consulted when there is no file to inherit from; replacing an
/// existing file always reproduces that file's own mode.
#[derive(Debug, Clone, Copy)]
pub enum NewFileMode<'a> {
    /// Exactly what `fs::write` would have done: `0666` masked by the umask.
    /// The document's rule — a file the user asked for by name gets the mode
    /// their environment says new files get.
    Umask,
    /// Take the mode of another file.
    ///
    /// This is the one place the sidecar differs from the document, and it
    /// differs because of what a sidecar *is*: a derived file that quotes the
    /// document's text back and stores replies about it. A `0600` private note
    /// whose comment file is born `0644` leaks its own contents sideways, and
    /// nothing in the UI would ever show that. Inheriting keeps the pair as
    /// confidential as its more confidential half.
    ///
    /// When the model cannot be read — the document was renamed or deleted and
    /// its sidecar outlived it — the new file stays at the `0600` it was
    /// created with rather than widening to the umask. Not knowing how private
    /// the original was is a reason to be careful with the copy, not a reason
    /// to publish it; and the user can always widen it themselves.
    Like(&'a Path),
}

/// Replaces `target`'s contents with `content`, keeping the file's identity on
/// disk: mode, owner, group, ACL and extended attributes all survive.
///
/// `target` may be a symlink; the write lands on what it points at.
pub fn save(target: &Path, content: &str, new_file: NewFileMode<'_>) -> Result<(), String> {
    let target = resolve_write_target(target)?;
    let existing = fs::metadata(&target).ok();
    let tmp = temp_path_for(&target)?;

    // When there is a file to replace, the temp is born 0600 and is only
    // widened to that file's own mode once its content is in place: the temp
    // *becomes* the file, so a 0600 note whose temp spent a moment at 0644
    // would be the world-readable file from then on. A file created from
    // nothing under `Like` follows the same order for the same reason; only
    // `Umask` opens at 0666, because that is what reproduces `fs::write`.
    let create_mode = match (&existing, new_file) {
        (None, NewFileMode::Umask) => 0o666,
        _ => 0o600,
    };
    let new_file_mode = match (&existing, new_file) {
        (Some(_), _) | (None, NewFileMode::Umask) => None,
        (None, NewFileMode::Like(model)) => fs::metadata(model)
            .ok()
            .map(|m| m.permissions().mode() & 0o7777),
    };

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(create_mode)
        .open(&tmp)
        .map_err(|e| format!("Failed to write: {}", e))?;

    // `sync_all` before the rename is what makes the rename meaningful after a
    // power loss: without it the directory entry can reach the disk pointing at
    // a file whose blocks did not. It is plain `fsync`, not `F_FULLFSYNC` —
    // autosave runs every 300 ms, and waiting on a drive cache flush that often
    // is a cost the crash-safety argument does not require.
    let written = file
        .write_all(content.as_bytes())
        .and_then(|()| file.sync_all());
    if let Err(e) = written {
        drop(file);
        discard_temp(&tmp);
        return Err(format!("Failed to write: {}", e));
    }

    let identity = match existing.as_ref() {
        Some(meta) => inherit_identity(&target, &tmp, &file, meta),
        None => match new_file_mode {
            Some(mode) => file
                .set_permissions(fs::Permissions::from_mode(mode))
                .map_err(|e| format!("Failed to save: cannot set permissions: {}", e)),
            None => Ok(()),
        },
    };
    if let Err(e) = identity {
        drop(file);
        discard_temp(&tmp);
        return Err(e);
    }
    drop(file);

    if let Err(e) = before_rename(&tmp) {
        discard_temp(&tmp);
        return Err(e);
    }

    fs::rename(&tmp, &target).map_err(|e| {
        discard_temp(&tmp);
        format!("Failed to save: {}", e)
    })?;

    sync_dir(&target);
    Ok(())
}

/// The path a save must actually land on.
///
/// `rename` replaces a *directory entry*, so renaming onto a symlink destroys
/// the link and leaves the real file untouched: the edit lands on the wrong
/// file and the user never learns. Resolving the chain by hand rather than with
/// `fs::canonicalize` keeps a dangling link writable — the target may
/// legitimately not exist yet, and `canonicalize` refuses that case.
fn resolve_write_target(path: &Path) -> Result<PathBuf, String> {
    let mut current = path.to_path_buf();
    for _ in 0..MAX_SYMLINK_HOPS {
        let meta = match fs::symlink_metadata(&current) {
            Ok(meta) => meta,
            // Nothing there — this is a path to create, not a link to follow.
            Err(_) => return Ok(current),
        };
        if !meta.file_type().is_symlink() {
            return Ok(current);
        }
        let link = fs::read_link(&current).map_err(|e| {
            format!(
                "Failed to save: cannot resolve link {}: {}",
                current.display(),
                e
            )
        })?;
        current = if link.is_absolute() {
            link
        } else {
            current
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(link)
        };
    }
    Err(format!(
        "Failed to save: too many levels of symbolic links in {}",
        path.display()
    ))
}

/// Directory holding `target`, as a path that can be opened.
fn parent_dir(target: &Path) -> &Path {
    match target.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    }
}

/// A temp name that is hidden (leading dot, so Finder and sync clients skip
/// it), unique per process and per call, and — crucially — a *sibling* of the
/// destination, because `rename` cannot cross filesystems.
///
/// The dot is prepended **unconditionally**, even when the destination is
/// already a dotfile, and that double dot is load-bearing rather than untidy.
/// A comment sidecar is named `.mdmini_comments_<doc>`, and
/// `comments::is_sidecar` recognises a sidecar by exactly that prefix. The old
/// sidecar temp name (`path.with_extension("tmp")`) produced
/// `.mdmini_comments_note.tmp`, which still matched that prefix — so
/// `collect_open` could parse a half-written temp as a real sidecar, and
/// `couplet watch` could fire on one. The extra dot makes the temp unmatchable,
/// which is what `watch.rs` already claimed was true.
fn temp_path_for(target: &Path) -> Result<PathBuf, String> {
    let name = target
        .file_name()
        .ok_or_else(|| format!("Failed to save: {} has no file name", target.display()))?;
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut temp_name = std::ffi::OsString::from(".");
    temp_name.push(name);
    temp_name.push(format!(".{}.{}.tmp", std::process::id(), seq));
    Ok(parent_dir(target).join(temp_name))
}

/// Copies the parts of the old file's identity that a `rename` would otherwise
/// drop onto the temp that is about to take its place.
///
/// Order is load-bearing. `copyfile` first, because it is the step that can be
/// told to bring timestamps along and must not be trusted with the mode;
/// `fchown` next, since changing ownership clears set-user/group-ID bits; and
/// `fchmod` last, so the mode on disk is exactly the old file's whatever the
/// two earlier steps did.
fn inherit_identity(
    target: &Path,
    tmp: &Path,
    file: &File,
    meta: &fs::Metadata,
) -> Result<(), String> {
    copy_acl_and_xattrs(target, tmp)?;

    // Ownership is best-effort by necessity: an unprivileged process cannot
    // give a file away, and refusing to save over that would turn a cosmetic
    // loss into lost work. The group half usually does succeed, and matters —
    // a new file inherits its *directory's* group, not the old file's.
    let mine = file.metadata().ok();
    let same_owner = mine
        .as_ref()
        .is_some_and(|m| m.uid() == meta.uid() && m.gid() == meta.gid());
    if !same_owner {
        // SAFETY: `file` is open for the whole call, so the fd is valid.
        unsafe {
            libc::fchown(file.as_raw_fd(), meta.uid(), meta.gid());
        }
    }

    let mode = meta.permissions().mode() & 0o7777;
    file.set_permissions(fs::Permissions::from_mode(mode))
        .map_err(|e| format!("Failed to save: cannot restore permissions: {}", e))
}

/// `COPYFILE_ACL | COPYFILE_XATTR`, and pointedly not `COPYFILE_SECURITY`.
///
/// `COPYFILE_SECURITY` is `COPYFILE_STAT | COPYFILE_ACL` and `COPYFILE_METADATA`
/// adds `COPYFILE_XATTR` on top, so either of those would drag `COPYFILE_STAT`
/// in — and `COPYFILE_STAT` copies the *timestamps*. A freshly saved file whose
/// mtime is the old file's is a file the watcher and every "changed on disk"
/// check believe was never written. The mode that `COPYFILE_STAT` would also
/// have carried is restored explicitly by the caller instead.
fn copy_acl_and_xattrs(from: &Path, to: &Path) -> Result<(), String> {
    let from_c = c_path(from)?;
    let to_c = c_path(to)?;
    // SAFETY: both strings are NUL-terminated and outlive the call; a null
    // state pointer is the documented way to ask for a one-shot copy.
    let rc = unsafe {
        libc::copyfile(
            from_c.as_ptr(),
            to_c.as_ptr(),
            std::ptr::null_mut(),
            libc::COPYFILE_ACL | libc::COPYFILE_XATTR,
        )
    };
    if rc != 0 {
        // Metadata that could not be carried over is worth reporting, but not
        // worth discarding the user's text for: the content is already written
        // and correct. Losing an xattr silently is the lesser failure.
        eprintln!(
            "atomic_write: could not copy ACL/xattrs from {}: {}",
            from.display(),
            std::io::Error::last_os_error()
        );
    }
    Ok(())
}

pub(crate) fn c_path(path: &Path) -> Result<std::ffi::CString, String> {
    std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| format!("Failed to save: {} contains a NUL byte", path.display()))
}

/// Removes a temp that will not be renamed into place.
///
/// Plain `remove_file` is not enough once the destination's ACL has been copied
/// onto the temp: an `everyone deny delete` entry denies *everyone*, this
/// process included, so the unlink comes back EPERM. That is not a cosmetic
/// leak — a file carrying such an ACL fails every save, and autosave retries
/// every 300 ms, so an unremovable temp would become thousands of hidden files
/// beside the user's document within the hour. `chmod -N` drops the ACL we
/// ourselves just wrote, and the retry then succeeds.
fn discard_temp(tmp: &Path) {
    if fs::remove_file(tmp).is_ok() {
        return;
    }
    let stripped = std::process::Command::new("/bin/chmod")
        .arg("-N")
        .arg(tmp)
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if stripped {
        let _ = fs::remove_file(tmp);
    }
}

/// Flushes the directory entry the `rename` just created. Best-effort: the save
/// has already landed, and a failure here costs durability across a power loss,
/// not the file.
fn sync_dir(target: &Path) {
    if let Ok(dir) = File::open(parent_dir(target)) {
        let _ = dir.sync_all();
    }
}

// ---------------------------------------------------------------------------
// The crash seam
//
// Everything interesting about this module happens in the instant between a
// fully written temp and the `rename`, and that instant cannot be observed
// from outside. `before_rename` is the only seam, and it is a thread-local
// rather than a parameter on `save` because the sidecar's writes are reached
// through `comments`'s public API (`append_reply`, `set_status`, …) — threading
// a hook through those call sites would put test scaffolding into production
// signatures for no gain. In a release build it compiles to nothing.
// ---------------------------------------------------------------------------

#[cfg(not(test))]
#[inline]
fn before_rename(_tmp: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
fn before_rename(tmp: &Path) -> Result<(), String> {
    testing::run_hook(tmp)
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use std::cell::RefCell;

    type Hook = Box<dyn Fn(&Path) -> Result<(), String>>;

    thread_local! {
        static HOOK: RefCell<Option<Hook>> = const { RefCell::new(None) };
    }

    pub(crate) fn run_hook(tmp: &Path) -> Result<(), String> {
        // The hook is taken out of the slot for the duration of the call: a
        // hook that itself writes a file — the SIGKILL victim does — would
        // otherwise re-enter this borrow and panic.
        let hook = HOOK.with(|slot| slot.borrow_mut().take());
        let Some(hook) = hook else { return Ok(()) };
        let outcome = hook(tmp);
        HOOK.with(|slot| *slot.borrow_mut() = Some(hook));
        outcome
    }

    /// Installs a hook that runs with the temp fully written and the `rename`
    /// not yet issued. Cleared when the returned guard drops, so one test
    /// cannot leak its seam into the next; thread-local, so tests running in
    /// parallel cannot see each other's.
    #[must_use]
    pub(crate) struct HookGuard;

    impl Drop for HookGuard {
        fn drop(&mut self) {
            HOOK.with(|slot| *slot.borrow_mut() = None);
        }
    }

    pub(crate) fn before_rename<F>(hook: F) -> HookGuard
    where
        F: Fn(&Path) -> Result<(), String> + 'static,
    {
        HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
        HookGuard
    }
}

// ---------------------------------------------------------------------------
// Test helpers shared with the callers' own suites (`commands`, `comments`).
// They all read the real filesystem back with `stat`, `getxattr` or `ls -le`:
// the bug being fixed (#18) was invisible to anything that stubbed it out.
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod testkit {
    use super::*;
    use std::process::Command;

    /// A private directory under the OS temp dir. Left behind on purpose when a
    /// test fails — the evidence is the file itself.
    pub(crate) fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "couplet-save-{}-{}-{}",
            tag,
            std::process::id(),
            TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    pub(crate) fn mode_of(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o7777
    }

    pub(crate) fn content_of(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    pub(crate) fn set_xattr(path: &Path, name: &str, value: &[u8]) {
        let path_c = c_path(path).unwrap();
        let name_c = std::ffi::CString::new(name).unwrap();
        // SAFETY: both C strings and the value slice outlive the call.
        let rc = unsafe {
            libc::setxattr(
                path_c.as_ptr(),
                name_c.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        assert_eq!(
            rc,
            0,
            "could not set {} for the test: {}",
            name,
            std::io::Error::last_os_error()
        );
    }

    pub(crate) fn get_xattr(path: &Path, name: &str) -> Option<Vec<u8>> {
        let path_c = c_path(path).unwrap();
        let name_c = std::ffi::CString::new(name).unwrap();
        let mut buf = vec![0u8; 4096];
        // SAFETY: `buf` is owned here and its length is passed honestly.
        let len = unsafe {
            libc::getxattr(
                path_c.as_ptr(),
                name_c.as_ptr(),
                buf.as_mut_ptr().cast(),
                buf.len(),
                0,
                0,
            )
        };
        if len < 0 {
            return None;
        }
        buf.truncate(len as usize);
        Some(buf)
    }

    /// The ACL as `ls` prints it — the same surface a user would check.
    pub(crate) fn acl_of(path: &Path) -> String {
        let out = Command::new("/bin/ls")
            .arg("-le")
            .arg(path)
            .output()
            .expect("ls -le");
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .skip(1)
            .map(|line| line.trim().to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Returns false when the filesystem under test refuses ACLs, so the ACL
    /// tests can say so instead of failing for the wrong reason.
    pub(crate) fn try_add_acl(path: &Path, entry: &str) -> bool {
        Command::new("/bin/chmod")
            .arg("+a")
            .arg(entry)
            .arg(path)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    pub(crate) fn temp_leftovers(dir: &Path) -> Vec<PathBuf> {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.to_string_lossy().ends_with(".tmp"))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    //! Every test here writes a real file on a real filesystem and reads the
    //! result back with `stat`, `getxattr` or `ls -le`. There is no seam
    //! between the assertions and the syscalls that matter: the bug being
    //! fixed (#18) was invisible to anything that stubbed the filesystem out.

    use super::testkit::*;
    use super::*;
    use std::io::Read;
    use std::os::unix::fs::symlink;
    use std::process::{Command, Stdio};
    use std::sync::atomic::AtomicU32;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant, SystemTime};

    const OLD: &str = "# original\n\nthe text that must survive a crash\n";
    const NEW: &str = "# rewritten\n\nthe text a successful save leaves behind\n";

    /// A document with `content` and exactly `mode`.
    fn doc_with_mode(dir: &Path, name: &str, mode: u32) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, OLD).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        assert_eq!(mode_of(&path), mode, "test setup could not apply the mode");
        path
    }

    fn save_doc(path: &Path, content: &str) -> Result<(), String> {
        save(path, content, NewFileMode::Umask)
    }

    // --- what a save must preserve ------------------------------------------

    #[test]
    fn preserves_the_documents_mode() {
        // 0600 and 0640 are the two modes reported in #18; 0644 is the control
        // that would have passed even before the fix.
        for mode in [0o600, 0o640, 0o644, 0o664] {
            let dir = scratch(&format!("mode-{mode:o}"));
            let doc = doc_with_mode(&dir, "note.md", mode);

            save_doc(&doc, NEW).unwrap();

            assert_eq!(mode_of(&doc), mode, "mode {mode:o} was not preserved");
            assert_eq!(content_of(&doc), NEW);
        }
    }

    #[test]
    fn preserves_owner_and_group() {
        let dir = scratch("owner");
        let doc = doc_with_mode(&dir, "note.md", 0o600);
        let before = fs::metadata(&doc).unwrap();
        let (uid, gid) = (before.uid(), before.gid());

        save_doc(&doc, NEW).unwrap();

        let after = fs::metadata(&doc).unwrap();
        assert_eq!(after.uid(), uid, "owner changed");
        assert_eq!(after.gid(), gid, "group changed");
    }

    #[test]
    fn preserves_a_custom_xattr() {
        let dir = scratch("xattr");
        let doc = doc_with_mode(&dir, "note.md", 0o644);
        set_xattr(&doc, "com.couplet.test", b"keepme");

        save_doc(&doc, NEW).unwrap();

        assert_eq!(
            get_xattr(&doc, "com.couplet.test").as_deref(),
            Some(&b"keepme"[..]),
            "custom xattr was lost"
        );
    }

    #[test]
    fn preserves_the_quarantine_flag() {
        // Losing this one silently un-quarantines a downloaded file — the save
        // path should not be able to change a security decision.
        let dir = scratch("quarantine");
        let doc = doc_with_mode(&dir, "note.md", 0o644);
        set_xattr(&doc, "com.apple.quarantine", b"0081;00000000;couplet;");

        save_doc(&doc, NEW).unwrap();

        assert_eq!(
            get_xattr(&doc, "com.apple.quarantine").as_deref(),
            Some(&b"0081;00000000;couplet;"[..]),
            "com.apple.quarantine was lost"
        );
    }

    #[test]
    fn preserves_an_acl() {
        let dir = scratch("acl");
        let doc = doc_with_mode(&dir, "note.md", 0o600);
        if !try_add_acl(&doc, "everyone allow read") {
            eprintln!("skipping: this filesystem does not take ACLs");
            return;
        }
        let before = acl_of(&doc);
        assert!(
            before.contains("allow"),
            "test setup left no ACL to preserve"
        );

        save_doc(&doc, NEW).unwrap();

        assert_eq!(acl_of(&doc), before, "ACL was lost or altered");
        assert_eq!(mode_of(&doc), 0o600, "restoring the ACL disturbed the mode");
    }

    #[test]
    fn updates_mtime_rather_than_copying_the_old_one() {
        // The regression guard for COPYFILE_STAT: an mtime carried over from
        // the previous file makes the watcher — and every "changed on disk"
        // check — believe the save never happened.
        let dir = scratch("mtime");
        let doc = doc_with_mode(&dir, "note.md", 0o644);
        let before = fs::metadata(&doc).unwrap().modified().unwrap();
        std::thread::sleep(Duration::from_millis(20));

        save_doc(&doc, NEW).unwrap();

        let after = fs::metadata(&doc).unwrap().modified().unwrap();
        assert!(
            after > before,
            "mtime did not advance ({after:?} vs {before:?}) — COPYFILE_STAT crept back in"
        );
        assert!(
            after.duration_since(SystemTime::UNIX_EPOCH).is_ok(),
            "mtime is not a sane wall-clock time"
        );
    }

    #[test]
    fn the_file_watcher_still_sees_the_save() {
        // The save's shape on disk changed — the temp is hidden and differently
        // named, the mode is set before the rename — and `watcher.rs` watches
        // the document *path* non-recursively. This asserts the change did not
        // make a save invisible to FSEvents, which would silently break
        // external-change detection for anyone editing the same file elsewhere.
        //
        // Deliberately a different question from `updates_mtime_...`: an
        // advancing mtime says a poller would notice, this says the event
        // stream does. `watch_file` itself needs an `AppHandle`, so the test
        // drives the same `notify` watcher it builds, with the same
        // `RecursiveMode::NonRecursive` on the same path.
        use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
        use std::sync::mpsc;

        let dir = scratch("watcher");
        let doc = doc_with_mode(&dir, "note.md", 0o600);

        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = RecommendedWatcher::new(tx, notify::Config::default())
            .expect("could not build the watcher");
        watcher
            .watch(&doc, RecursiveMode::NonRecursive)
            .expect("could not watch the document");
        // FSEvents delivers nothing for writes that happened before the stream
        // started, so let it come up first.
        std::thread::sleep(Duration::from_millis(300));

        save_doc(&doc, NEW).unwrap();

        let event = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("no filesystem event for a save the watcher is supposed to see")
            .expect("the watcher reported an error");
        assert!(
            matches!(
                event.kind,
                notify::EventKind::Modify(_) | notify::EventKind::Create(_)
            ),
            "the save arrived as {:?}, which watcher.rs ignores",
            event.kind
        );
        assert_eq!(content_of(&doc), NEW);
    }

    // --- links ---------------------------------------------------------------

    #[test]
    fn writing_through_a_symlink_updates_the_target_and_keeps_the_link() {
        let dir = scratch("symlink");
        let target = doc_with_mode(&dir, "real.md", 0o640);
        let link = dir.join("link.md");
        symlink(&target, &link).unwrap();

        save_doc(&link, NEW).unwrap();

        assert!(
            fs::symlink_metadata(&link).unwrap().file_type().is_symlink(),
            "the symlink was replaced by a regular file"
        );
        assert_eq!(content_of(&target), NEW, "the edit did not reach the target");
        assert_eq!(mode_of(&target), 0o640, "the target's mode was reset");
        assert!(temp_leftovers(&dir).is_empty());
    }

    #[test]
    fn follows_a_chain_of_symlinks() {
        let dir = scratch("symlink-chain");
        let target = doc_with_mode(&dir, "real.md", 0o600);
        let middle = dir.join("middle.md");
        let outer = dir.join("outer.md");
        symlink("real.md", &middle).unwrap(); // relative, resolved against dir
        symlink(&middle, &outer).unwrap();

        save_doc(&outer, NEW).unwrap();

        assert_eq!(content_of(&target), NEW);
        assert_eq!(mode_of(&target), 0o600);
        assert!(fs::symlink_metadata(&outer).unwrap().file_type().is_symlink());
        assert!(fs::symlink_metadata(&middle)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn writes_through_a_symlink_whose_target_does_not_exist_yet() {
        // `fs::canonicalize` refuses this case, which is why the resolver walks
        // the chain by hand.
        let dir = scratch("dangling");
        let link = dir.join("link.md");
        symlink(dir.join("not-yet.md"), &link).unwrap();

        save_doc(&link, NEW).unwrap();

        assert_eq!(content_of(&dir.join("not-yet.md")), NEW);
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    }

    #[test]
    fn a_symlink_loop_is_an_error_not_a_hang() {
        let dir = scratch("loop");
        let a = dir.join("a.md");
        let b = dir.join("b.md");
        symlink(&b, &a).unwrap();
        symlink(&a, &b).unwrap();

        let err = save_doc(&a, NEW).unwrap_err();

        assert!(err.contains("symbolic links"), "unexpected error: {err}");
    }

    #[test]
    fn hard_links_are_still_broken_by_the_rename() {
        // Not a fix — a record. `rename` replaces a directory entry, so the
        // second name keeps the old inode and the two files diverge. Removing
        // this would mean writing in place, which is what the temp-and-rename
        // scheme exists to avoid. If this test ever starts failing, the save
        // path stopped being crash-safe.
        let dir = scratch("hardlink");
        let doc = doc_with_mode(&dir, "note.md", 0o644);
        let other = dir.join("other.md");
        fs::hard_link(&doc, &other).unwrap();
        assert_eq!(fs::metadata(&doc).unwrap().nlink(), 2);

        save_doc(&doc, NEW).unwrap();

        assert_eq!(content_of(&doc), NEW);
        assert_eq!(content_of(&other), OLD, "documented limitation changed");
        assert_eq!(fs::metadata(&doc).unwrap().nlink(), 1);
    }

    // --- the temp file -------------------------------------------------------

    #[test]
    fn the_temp_file_is_never_wider_than_the_document() {
        // The original bug's quiet half: `fs::write` created the temp at 0644,
        // and that temp *became* the document, so a 0600 note was world-readable
        // from then on. The hook looks at the temp at the only moment it exists.
        for mode in [0o600, 0o640, 0o604] {
            let dir = scratch(&format!("tempmode-{mode:o}"));
            let doc = doc_with_mode(&dir, "note.md", mode);
            let seen = Arc::new(AtomicU32::new(0o7777));

            let recorder = Arc::clone(&seen);
            let guard = testing::before_rename(move |tmp: &Path| {
                recorder.store(mode_of(tmp), Ordering::Relaxed);
                Ok(())
            });
            save_doc(&doc, NEW).unwrap();
            drop(guard);

            let temp_mode = seen.load(Ordering::Relaxed);
            assert_eq!(
                temp_mode & 0o077,
                mode & 0o077,
                "temp was {temp_mode:o} while the document is {mode:o} — \
                 group/other access differs"
            );
            assert_eq!(mode_of(&doc), mode);
        }
    }

    #[test]
    fn the_temp_file_is_hidden_and_a_sibling_of_the_document() {
        // Hidden so it does not surface in Finder or a sync client's queue; a
        // sibling because `rename` cannot cross filesystems.
        let dir = scratch("tempname");
        let doc = doc_with_mode(&dir, "note.md", 0o644);
        let seen = Arc::new(Mutex::new(PathBuf::new()));

        let recorder = Arc::clone(&seen);
        let guard = testing::before_rename(move |tmp: &Path| {
            *recorder.lock().unwrap() = tmp.to_path_buf();
            Ok(())
        });
        save_doc(&doc, NEW).unwrap();
        drop(guard);

        let tmp = seen.lock().unwrap().clone();
        assert_eq!(tmp.parent(), doc.parent(), "temp is not a sibling");
        let name = tmp.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with('.'), "temp {name} is not hidden");
        assert_ne!(tmp, dir.join("note.md.tmp"), "the old visible temp name");
    }

    #[test]
    fn a_successful_save_leaves_no_temp_behind() {
        let dir = scratch("notemp");
        let doc = doc_with_mode(&dir, "note.md", 0o644);

        save_doc(&doc, NEW).unwrap();
        save_doc(&doc, OLD).unwrap();

        assert!(
            temp_leftovers(&dir).is_empty(),
            "temp files were left behind"
        );
        assert_eq!(content_of(&doc), OLD);
    }

    #[test]
    fn a_brand_new_file_gets_the_same_mode_it_always_did() {
        // No file to inherit from and `NewFileMode::Umask`, so the umask
        // decides — exactly as the previous `fs::write` implementation did.
        // Compared against a live `fs::write` rather than a hardcoded 0644, so
        // the test does not depend on the umask of whoever runs it.
        let dir = scratch("newfile");
        let reference = dir.join("reference.md");
        fs::write(&reference, NEW).unwrap();
        let doc = dir.join("fresh.md");

        save_doc(&doc, NEW).unwrap();

        assert_eq!(content_of(&doc), NEW);
        assert_eq!(mode_of(&doc), mode_of(&reference));
    }

    // --- NewFileMode::Like ---------------------------------------------------

    #[test]
    fn a_new_file_under_like_inherits_the_models_mode() {
        // The sidecar's rule. A 0600 document must not acquire a 0644 comment
        // file that quotes it — the derived file has to be as closed as the one
        // it derives from.
        for mode in [0o600, 0o640, 0o644] {
            let dir = scratch(&format!("like-{mode:o}"));
            let model = doc_with_mode(&dir, "note.md", mode);
            let derived = dir.join(".mdmini_comments_note.md");

            save(&derived, NEW, NewFileMode::Like(&model)).unwrap();

            assert_eq!(content_of(&derived), NEW);
            assert_eq!(
                mode_of(&derived),
                mode,
                "a new file under Like did not take the model's {mode:o}"
            );
        }
    }

    #[test]
    fn a_new_file_under_like_never_widens_before_the_rename() {
        // Same argument as the document's temp: the temp *becomes* the file, so
        // a moment at 0644 is not a moment, it is the mode from then on.
        let dir = scratch("like-temp");
        let model = doc_with_mode(&dir, "note.md", 0o600);
        let derived = dir.join(".mdmini_comments_note.md");
        let seen = Arc::new(AtomicU32::new(0o7777));

        let recorder = Arc::clone(&seen);
        let guard = testing::before_rename(move |tmp: &Path| {
            recorder.store(mode_of(tmp), Ordering::Relaxed);
            Ok(())
        });
        save(&derived, NEW, NewFileMode::Like(&model)).unwrap();
        drop(guard);

        assert_eq!(seen.load(Ordering::Relaxed) & 0o077, 0);
        assert_eq!(mode_of(&derived), 0o600);
    }

    #[test]
    fn like_stays_closed_when_the_model_is_gone() {
        // A sidecar can outlive its document — the user renames or deletes the
        // file and the comment file is still there to be written. That must not
        // fail the save, and it must not silently open the file up either: with
        // nothing to tell us how private the original was, 0600 is the answer
        // the user can widen and the umask's 0644 is the one they cannot undo
        // after the fact.
        let dir = scratch("like-missing");
        let derived = dir.join(".mdmini_comments_ghost.md");

        save(&derived, NEW, NewFileMode::Like(&dir.join("ghost.md"))).unwrap();

        assert_eq!(content_of(&derived), NEW);
        assert_eq!(mode_of(&derived), 0o600);
    }

    #[test]
    fn like_does_not_override_an_existing_files_own_mode() {
        // Once the file exists it owns its mode, whatever the model says: a
        // user who chmods their comment file keeps that choice.
        let dir = scratch("like-existing");
        let model = doc_with_mode(&dir, "note.md", 0o644);
        let derived = dir.join(".mdmini_comments_note.md");
        fs::write(&derived, OLD).unwrap();
        fs::set_permissions(&derived, fs::Permissions::from_mode(0o600)).unwrap();

        save(&derived, NEW, NewFileMode::Like(&model)).unwrap();

        assert_eq!(mode_of(&derived), 0o600, "the file's own mode was replaced");
    }

    // --- failure -------------------------------------------------------------

    #[test]
    fn a_failure_between_the_write_and_the_rename_leaves_the_document_untouched() {
        // The seam version of a crash: the document must be byte-identical,
        // down to the inode, and no temp may survive.
        let dir = scratch("hookfail");
        let doc = doc_with_mode(&dir, "note.md", 0o600);
        let before = fs::metadata(&doc).unwrap();

        let guard = testing::before_rename(|_: &Path| Err("simulated crash".into()));
        let err = save_doc(&doc, NEW).unwrap_err();
        drop(guard);

        assert_eq!(err, "simulated crash");
        assert_eq!(content_of(&doc), OLD, "the document was modified");
        assert_eq!(mode_of(&doc), 0o600);
        assert_eq!(
            fs::metadata(&doc).unwrap().ino(),
            before.ino(),
            "the document was replaced"
        );
        assert!(
            temp_leftovers(&dir).is_empty(),
            "the temp was not cleaned up"
        );
    }

    #[test]
    fn a_rename_the_filesystem_refuses_is_an_error_not_a_silent_success() {
        // `everyone deny delete` makes replacing the file impossible: `rename`
        // returns EPERM. Before the fix this reached only `console.error`, so
        // the user kept typing into a document that was no longer being saved.
        let dir = scratch("denydelete");
        let doc = doc_with_mode(&dir, "note.md", 0o600);
        if !try_add_acl(&doc, "everyone deny delete") {
            eprintln!("skipping: this filesystem does not take ACLs");
            return;
        }

        let result = save_doc(&doc, NEW);

        assert!(result.is_err(), "a refused save reported success");
        let err = result.unwrap_err();
        assert!(err.starts_with("Failed to save"), "unexpected error: {err}");
        assert_eq!(content_of(&doc), OLD, "the document was damaged anyway");
        assert!(temp_leftovers(&dir).is_empty(), "the temp was left behind");
    }

    // --- a real SIGKILL ------------------------------------------------------

    /// The child half of [`a_real_sigkill_mid_save_leaves_the_document_intact`].
    /// Runs in a process this suite spawns and then kills; it is `#[ignore]`d
    /// so an ordinary `cargo test` never reaches it.
    #[test]
    #[ignore = "spawned and killed by a_real_sigkill_mid_save_leaves_the_document_intact"]
    fn sigkill_victim() {
        let Ok(target) = std::env::var("MD_MINI_SIGKILL_TARGET") else {
            return;
        };
        let ready = std::env::var("MD_MINI_SIGKILL_READY").unwrap();

        // Stop with the temp fully written and the rename not yet issued —
        // the one instant at which a document could plausibly be destroyed.
        let _guard = testing::before_rename(move |_: &Path| {
            fs::write(&ready, b"now").unwrap();
            loop {
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        let _ = save_doc(Path::new(&target), NEW);
    }

    #[test]
    fn a_real_sigkill_mid_save_leaves_the_document_intact() {
        let dir = scratch("sigkill");
        let doc = doc_with_mode(&dir, "note.md", 0o600);
        set_xattr(&doc, "com.couplet.test", b"keepme");
        let before = fs::metadata(&doc).unwrap();
        let ready = dir.join("ready");

        let exe = std::env::current_exe().expect("test binary path");
        let mut child = Command::new(exe)
            .args([
                "atomic_write::tests::sigkill_victim",
                "--exact",
                "--ignored",
                "--test-threads",
                "1",
            ])
            .env("MD_MINI_SIGKILL_TARGET", &doc)
            .env("MD_MINI_SIGKILL_READY", &ready)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("could not spawn the victim process");

        let deadline = Instant::now() + Duration::from_secs(60);
        while !ready.exists() {
            if let Ok(Some(status)) = child.try_wait() {
                panic!("the victim exited before reaching the hook: {status}");
            }
            assert!(
                Instant::now() < deadline,
                "the victim never reached the pre-rename hook"
            );
            std::thread::sleep(Duration::from_millis(20));
        }

        child.kill().expect("SIGKILL");
        let status = child.wait().expect("wait");
        assert!(!status.success(), "the victim was not killed: {status}");

        // The whole point: a process that died with a fully written replacement
        // already on disk still leaves the reader's document exactly as it was.
        let mut text = String::new();
        File::open(&doc).unwrap().read_to_string(&mut text).unwrap();
        assert_eq!(text, OLD, "the document was damaged by the crash");
        assert_eq!(mode_of(&doc), 0o600, "the crash changed the mode");
        assert_eq!(fs::metadata(&doc).unwrap().ino(), before.ino());
        assert_eq!(
            get_xattr(&doc, "com.couplet.test").as_deref(),
            Some(&b"keepme"[..])
        );

        // And proof that the kill landed where it was aimed: the orphaned temp
        // holds the new text, so the victim really was past the write.
        let leftovers = temp_leftovers(&dir);
        assert_eq!(leftovers.len(), 1, "expected exactly one orphaned temp");
        assert_eq!(content_of(&leftovers[0]), NEW);
        assert!(
            leftovers[0]
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with('.'),
            "the orphan is visible in Finder"
        );
    }

    // --- the ordinary case ---------------------------------------------------

    #[test]
    fn repeated_saves_land_the_latest_text() {
        let dir = scratch("repeat");
        let doc = doc_with_mode(&dir, "note.md", 0o640);

        for n in 0..5 {
            save_doc(&doc, &format!("revision {n}\n")).unwrap();
        }

        assert_eq!(content_of(&doc), "revision 4\n");
        assert_eq!(mode_of(&doc), 0o640);
    }

    #[test]
    fn saving_into_a_missing_directory_is_an_error() {
        let dir = scratch("nodir");
        let doc = dir.join("nope").join("note.md");

        let err = save_doc(&doc, NEW).unwrap_err();

        assert!(err.starts_with("Failed to write"), "unexpected error: {err}");
    }
}
