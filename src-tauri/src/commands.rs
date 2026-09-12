use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
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
    save_atomic(Path::new(&path), &content, None)
}

// ---------------------------------------------------------------------------
// Atomic save (#18)
//
// The shape is still write-a-temp-then-`rename`, and deliberately so: `rename`
// is the only step here that is atomic with respect to a crash, so a process
// that dies mid-save leaves the reader's document either entirely old or
// entirely new, never truncated. Autosave fires every 300 ms and
// `delete_recovery` runs after every successful save, so between saves there is
// no recovery snapshot at all — an in-place `truncate` + `write` would open a
// window, dozens of times a minute, where a crash destroys the document with
// nothing to restore from. That is what this file is protecting.
//
// What `rename` costs is everything that lives on the *inode* rather than in
// the directory entry, and what the code below buys back: mode, ownership,
// ACLs and extended attributes are copied onto the temp before it is renamed
// into place. Not bought back: the inode number itself, birth time, and hard
// links — a `rename` necessarily replaces the directory entry, so a second name
// for the old inode keeps pointing at the old content. See
// `docs/investigations/2026-09-12-atomic-write-tcc.md`.
// ---------------------------------------------------------------------------

/// Guards against a symlink cycle in [`resolve_write_target`]. The same order
/// of magnitude as the kernel's own `MAXSYMLINKS`.
const MAX_SYMLINK_HOPS: usize = 32;

/// Counter feeding the temp file name, so two concurrent saves in one
/// directory cannot pick the same one.
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Run between the fully written temp file and the `rename`. The production
/// path passes `None`; tests use it to inject a failure exactly at the moment
/// the document is most vulnerable.
type BeforeRename<'a> = &'a dyn Fn(&Path) -> Result<(), String>;

/// The path a save must actually land on.
///
/// `rename` replaces a *directory entry*, so renaming onto a symlink destroys
/// the link and leaves the real document untouched: the edit lands on the wrong
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

/// A temp name that is hidden (leading dot, so Finder and sync clients skip it),
/// unique per process and per call, and — crucially — a *sibling* of the
/// destination, because `rename` cannot cross filesystems.
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

/// Writes `content` to `path`, replacing whatever is there without losing the
/// document's identity on disk.
fn save_atomic(
    path: &Path,
    content: &str,
    before_rename: Option<BeforeRename<'_>>,
) -> Result<(), String> {
    let target = resolve_write_target(path)?;
    let existing = fs::metadata(&target).ok();
    let tmp = temp_path_for(&target)?;

    // When there is a document to replace, the temp is born 0600 and is only
    // widened to the document's own mode once its content is in place: the temp
    // *becomes* the document, so a 0600 note whose temp spent a moment at 0644
    // would be the world-readable file from then on.
    //
    // When there is nothing to replace, 0666 reproduces `fs::write`: `open`
    // masks it with the umask, so a new file still gets exactly the mode this
    // command has always given it.
    let create_mode = if existing.is_some() { 0o600 } else { 0o666 };

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

    if let Some(meta) = existing.as_ref() {
        if let Err(e) = inherit_identity(&target, &tmp, &file, meta) {
            drop(file);
            discard_temp(&tmp);
            return Err(e);
        }
    }
    drop(file);

    if let Some(hook) = before_rename {
        if let Err(e) = hook(&tmp) {
            discard_temp(&tmp);
            return Err(e);
        }
    }

    fs::rename(&tmp, &target).map_err(|e| {
        discard_temp(&tmp);
        format!("Failed to save: {}", e)
    })?;

    sync_dir(&target);
    Ok(())
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
            "write_file: could not copy ACL/xattrs from {}: {}",
            from.display(),
            std::io::Error::last_os_error()
        );
    }
    Ok(())
}

fn c_path(path: &Path) -> Result<std::ffi::CString, String> {
    std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| format!("Failed to save: {} contains a NUL byte", path.display()))
}

/// Removes a temp that will not be renamed into place.
///
/// Plain `remove_file` is not enough once the destination's ACL has been copied
/// onto the temp: an `everyone deny delete` entry denies *everyone*, this
/// process included, so the unlink comes back EPERM. That is not a cosmetic
/// leak — a document carrying such an ACL fails every save, and autosave
/// retries every 300 ms, so an unremovable temp would become thousands of
/// hidden files beside the user's document within the hour. `chmod -N` drops
/// the ACL we ourselves just wrote, and the retry then succeeds.
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
/// not the document.
fn sync_dir(target: &Path) {
    if let Ok(dir) = File::open(parent_dir(target)) {
        let _ = dir.sync_all();
    }
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

#[cfg(test)]
mod tests {
    //! Every test here writes a real file on a real filesystem and reads the
    //! result back with `stat`, `getxattr` or `ls -le`. There is no seam
    //! between the assertions and the syscalls that matter: the bug being
    //! fixed (#18) was invisible to anything that stubbed the filesystem out.

    use super::*;
    use std::io::Read;
    use std::os::unix::fs::symlink;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant, SystemTime};

    const OLD: &str = "# original\n\nthe text that must survive a crash\n";
    const NEW: &str = "# rewritten\n\nthe text a successful save leaves behind\n";

    /// A private directory under the OS temp dir. Left behind on purpose when a
    /// test fails — the evidence is the file itself.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "md-mini-save-{}-{}-{}",
            tag,
            std::process::id(),
            TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A document with `content` and exactly `mode`.
    fn doc_with_mode(dir: &Path, name: &str, mode: u32) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, OLD).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        assert_eq!(mode_of(&path), mode, "test setup could not apply the mode");
        path
    }

    fn mode_of(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o7777
    }

    fn content_of(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    fn save(path: &Path, content: &str) -> Result<(), String> {
        save_atomic(path, content, None)
    }

    fn set_xattr(path: &Path, name: &str, value: &[u8]) {
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

    fn get_xattr(path: &Path, name: &str) -> Option<Vec<u8>> {
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
    fn acl_of(path: &Path) -> String {
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
    fn try_add_acl(path: &Path, entry: &str) -> bool {
        Command::new("/bin/chmod")
            .arg("+a")
            .arg(entry)
            .arg(path)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    fn temp_leftovers(dir: &Path) -> Vec<PathBuf> {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.to_string_lossy().ends_with(".tmp"))
            .collect()
    }

    // --- what a save must preserve ------------------------------------------

    #[test]
    fn preserves_the_documents_mode() {
        // 0600 and 0640 are the two modes reported in #18; 0644 is the control
        // that would have passed even before the fix.
        for mode in [0o600, 0o640, 0o644, 0o664] {
            let dir = scratch(&format!("mode-{mode:o}"));
            let doc = doc_with_mode(&dir, "note.md", mode);

            save(&doc, NEW).unwrap();

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

        save(&doc, NEW).unwrap();

        let after = fs::metadata(&doc).unwrap();
        assert_eq!(after.uid(), uid, "owner changed");
        assert_eq!(after.gid(), gid, "group changed");
    }

    #[test]
    fn preserves_a_custom_xattr() {
        let dir = scratch("xattr");
        let doc = doc_with_mode(&dir, "note.md", 0o644);
        set_xattr(&doc, "com.mdmini.test", b"keepme");

        save(&doc, NEW).unwrap();

        assert_eq!(
            get_xattr(&doc, "com.mdmini.test").as_deref(),
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
        set_xattr(&doc, "com.apple.quarantine", b"0081;00000000;mdmini;");

        save(&doc, NEW).unwrap();

        assert_eq!(
            get_xattr(&doc, "com.apple.quarantine").as_deref(),
            Some(&b"0081;00000000;mdmini;"[..]),
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

        save(&doc, NEW).unwrap();

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

        save(&doc, NEW).unwrap();

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

    // --- links ---------------------------------------------------------------

    #[test]
    fn writing_through_a_symlink_updates_the_target_and_keeps_the_link() {
        let dir = scratch("symlink");
        let target = doc_with_mode(&dir, "real.md", 0o640);
        let link = dir.join("link.md");
        symlink(&target, &link).unwrap();

        save(&link, NEW).unwrap();

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

        save(&outer, NEW).unwrap();

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

        save(&link, NEW).unwrap();

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

        let err = save(&a, NEW).unwrap_err();

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

        save(&doc, NEW).unwrap();

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
            let seen = std::cell::Cell::new(0o7777u32);

            let hook = |tmp: &Path| -> Result<(), String> {
                seen.set(mode_of(tmp));
                Ok(())
            };
            save_atomic(&doc, NEW, Some(&hook)).unwrap();

            let temp_mode = seen.get();
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
        let seen = std::cell::RefCell::new(PathBuf::new());

        let hook = |tmp: &Path| -> Result<(), String> {
            *seen.borrow_mut() = tmp.to_path_buf();
            Ok(())
        };
        save_atomic(&doc, NEW, Some(&hook)).unwrap();

        let tmp = seen.into_inner();
        assert_eq!(tmp.parent(), doc.parent(), "temp is not a sibling");
        let name = tmp.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with('.'), "temp {name} is not hidden");
        assert_ne!(tmp, dir.join("note.md.tmp"), "the old visible temp name");
    }

    #[test]
    fn a_successful_save_leaves_no_temp_behind() {
        let dir = scratch("notemp");
        let doc = doc_with_mode(&dir, "note.md", 0o644);

        save(&doc, NEW).unwrap();
        save(&doc, OLD).unwrap();

        assert!(
            temp_leftovers(&dir).is_empty(),
            "temp files were left behind"
        );
        assert_eq!(content_of(&doc), OLD);
    }

    #[test]
    fn a_brand_new_file_gets_the_same_mode_it_always_did() {
        // No document to inherit from, so the umask decides — exactly as the
        // previous `fs::write` implementation did. Compared against a live
        // `fs::write` rather than a hardcoded 0644, so the test does not
        // depend on the umask of whoever runs it.
        let dir = scratch("newfile");
        let reference = dir.join("reference.md");
        fs::write(&reference, NEW).unwrap();
        let doc = dir.join("fresh.md");

        save(&doc, NEW).unwrap();

        assert_eq!(content_of(&doc), NEW);
        assert_eq!(mode_of(&doc), mode_of(&reference));
    }

    // --- failure -------------------------------------------------------------

    #[test]
    fn a_failure_between_the_write_and_the_rename_leaves_the_document_untouched() {
        // The seam version of a crash: the document must be byte-identical,
        // down to the inode, and no temp may survive.
        let dir = scratch("hookfail");
        let doc = doc_with_mode(&dir, "note.md", 0o600);
        let before = fs::metadata(&doc).unwrap();

        let hook = |_: &Path| -> Result<(), String> { Err("simulated crash".into()) };
        let err = save_atomic(&doc, NEW, Some(&hook)).unwrap_err();

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

        let result = save(&doc, NEW);

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
        let hook = |_: &Path| -> Result<(), String> {
            fs::write(&ready, b"now").unwrap();
            loop {
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        let _ = save_atomic(Path::new(&target), NEW, Some(&hook));
    }

    #[test]
    fn a_real_sigkill_mid_save_leaves_the_document_intact() {
        let dir = scratch("sigkill");
        let doc = doc_with_mode(&dir, "note.md", 0o600);
        set_xattr(&doc, "com.mdmini.test", b"keepme");
        let before = fs::metadata(&doc).unwrap();
        let ready = dir.join("ready");

        let exe = std::env::current_exe().expect("test binary path");
        let mut child = Command::new(exe)
            .args([
                "commands::tests::sigkill_victim",
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
            get_xattr(&doc, "com.mdmini.test").as_deref(),
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
            save(&doc, &format!("revision {n}\n")).unwrap();
        }

        assert_eq!(content_of(&doc), "revision 4\n");
        assert_eq!(mode_of(&doc), 0o640);
    }

    #[test]
    fn saving_into_a_missing_directory_is_an_error() {
        let dir = scratch("nodir");
        let doc = dir.join("nope").join("note.md");

        let err = save(&doc, NEW).unwrap_err();

        assert!(err.starts_with("Failed to write"), "unexpected error: {err}");
    }
}
