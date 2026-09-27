//! The note trash (stage 06): delete moves a note's file into
//! `StashPaths::trash_dir`, restore moves it back, purge is the one place
//! that deletes a note's bytes — and only a regular file directly inside that
//! directory. Every move is no-clobber; every move across volumes copies,
//! verifies and only then removes the source.

use std::fs;
use std::io::{ErrorKind, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::{db, search, Stash, StashKind};

const MAX_SUFFIX: u32 = 999;
/// A name taken between `unique_target` and the move is retried this often.
const MOVE_ATTEMPTS: u32 = 5;

#[derive(Debug)]
pub(crate) enum MoveError {
    /// The destination exists. Nothing was changed.
    Exists,
    Other(String),
}

impl From<std::io::Error> for MoveError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == ErrorKind::AlreadyExists {
            MoveError::Exists
        } else {
            MoveError::Other(e.to_string())
        }
    }
}

impl std::fmt::Display for MoveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MoveError::Exists => write!(f, "destination exists"),
            MoveError::Other(e) => write!(f, "{e}"),
        }
    }
}

fn occupied(path: &Path) -> bool {
    // `symlink_metadata`: a dangling symlink occupies its name too.
    fs::symlink_metadata(path).is_ok()
}

fn split_name(name: &str) -> (&str, Option<&str>) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], Some(&name[i + 1..])),
        _ => (name, None),
    }
}

/// `dir/file_name`, or the first `stem-N.ext` (N = 2…999) that is free on disk
/// and not held by another row (`taken`). Only a hint: the move itself is
/// what refuses a name taken since (`move_into`).
pub(crate) fn unique_target(
    dir: &Path,
    file_name: &str,
    taken: impl Fn(&Path) -> bool,
) -> Result<PathBuf, String> {
    let free = |p: &Path| !occupied(p) && !taken(p);
    let first = dir.join(file_name);
    if free(&first) {
        return Ok(first);
    }
    let (stem, ext) = split_name(file_name);
    for n in 2..=MAX_SUFFIX {
        let candidate = dir.join(match ext {
            Some(e) => format!("{stem}-{n}.{e}"),
            None => format!("{stem}-{n}"),
        });
        if free(&candidate) {
            return Ok(candidate);
        }
    }
    Err(format!("no free name for {file_name} in {}", dir.display()))
}

fn rename_excl(from: &Path, to: &Path) -> std::io::Result<()> {
    let f = crate::atomic_write::c_path(from).map_err(std::io::Error::other)?;
    let t = crate::atomic_write::c_path(to).map_err(std::io::Error::other)?;
    // SAFETY: both are NUL-terminated C strings that outlive the call.
    let rc = unsafe { libc::renamex_np(f.as_ptr(), t.as_ptr(), libc::RENAME_EXCL) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Move `from` to `to` without ever replacing `to`. Same volume: an atomic
/// exclusive rename (or link + unlink where the volume lacks RENAME_EXCL).
/// Across volumes: `copy_verify_remove`. Never `fs::rename`: on macOS it
/// silently replaces an existing destination.
pub(crate) fn move_no_clobber(from: &Path, to: &Path) -> Result<(), MoveError> {
    match rename_excl(from, to) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(libc::ENOTSUP) => link_then_unlink(from, to),
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => copy_verify_remove(from, to),
        Err(e) => Err(e.into()),
    }
}

/// The fallback where the volume has no RENAME_EXCL: `hard_link` refuses an
/// existing name, and the first name goes only once the second holds the
/// text. An unlink that fails leaves both names (`Other`): the caller treats
/// the move as not done, and nothing is lost.
fn link_then_unlink(from: &Path, to: &Path) -> Result<(), MoveError> {
    match fs::hard_link(from, to) {
        Ok(()) => fs::remove_file(from).map_err(|e| {
            MoveError::Other(format!(
                "{} linked to {} but not unlinked: {e}",
                from.display(),
                to.display()
            ))
        }),
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => copy_verify_remove(from, to),
        Err(e) => Err(e.into()),
    }
}

/// The roadmap's cross-volume rule: a second copy exists, is on disk and
/// matches byte for byte before the first one is removed. A source that will
/// not go leaves both copies (`Other`).
pub(crate) fn copy_verify_remove(from: &Path, to: &Path) -> Result<(), MoveError> {
    let bytes = fs::read(from)?;
    let mode = fs::metadata(from)?.permissions().mode() & 0o7777;
    {
        let mut out = fs::OpenOptions::new().write(true).create_new(true).open(to)?;
        out.write_all(&bytes)?;
        out.set_permissions(fs::Permissions::from_mode(mode))?;
        out.sync_all()?;
    }
    if fs::read(to)? != bytes {
        // Only the copy this call just created is removed; the source is intact.
        let _ = fs::remove_file(to);
        return Err(MoveError::Other(format!("copy to {} did not verify", to.display())));
    }
    fs::remove_file(from).map_err(|e| {
        MoveError::Other(format!(
            "{} copied to {} but not removed: {e}",
            from.display(),
            to.display()
        ))
    })
}

/// Move `from` into `dir` under `file_name` or its first free suffix; a name
/// taken between the check and the move is retried with the next one.
pub(crate) fn move_into(
    dir: &Path,
    file_name: &str,
    from: &Path,
    taken: impl Fn(&Path) -> bool,
) -> Result<PathBuf, String> {
    for _ in 0..MOVE_ATTEMPTS {
        let target = unique_target(dir, file_name, &taken)?;
        match move_no_clobber(from, &target) {
            Ok(()) => return Ok(target),
            Err(MoveError::Exists) => continue,
            Err(e) => return Err(format!("move {} → {}: {e}", from.display(), target.display())),
        }
    }
    Err(format!("could not find a free name for {file_name} in {}", dir.display()))
}

/// The purge guard (D9). `Ok(Some(canonical))`: a regular file directly inside
/// `trash_dir`, itself a real directory — safe to delete. `Ok(None)`: nothing
/// there any more, nothing to delete. `Err`: anything else — never delete it.
pub(crate) fn purgeable_file(trash_dir: &Path, path: &Path) -> Result<Option<PathBuf>, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    // A symlinked `.trash` would make wherever it points "the trash".
    crate::session::require_real_trash_dir(trash_dir)?;
    if !meta.file_type().is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    let name = path
        .file_name()
        .ok_or_else(|| format!("{} has no file name", path.display()))?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent", path.display()))?;
    let canon_parent =
        fs::canonicalize(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    let canon_trash =
        fs::canonicalize(trash_dir).map_err(|e| format!("{}: {e}", trash_dir.display()))?;
    if canon_parent != canon_trash {
        return Err(format!("{} is outside the note trash", path.display()));
    }
    Ok(Some(canon_parent.join(name)))
}

/// What `Stash::delete_entry` did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Deleted {
    /// A note is in the trash (now or already).
    Trashed,
    /// A file reference is gone; the file itself was not touched.
    Removed,
}

struct Row {
    kind: String,
    path: String,
    deleted_at: Option<i64>,
}

fn row(conn: &Connection, id: &str) -> Result<Row, String> {
    conn.query_row(
        "SELECT kind, path, deleted_at FROM entries WHERE id = ?1",
        [id],
        |r| {
            Ok(Row {
                kind: r.get(0)?,
                path: r.get(1)?,
                deleted_at: r.get(2)?,
            })
        },
    )
    .optional()
    .map_err(db::err)?
    .ok_or_else(|| format!("no stash entry {id}"))
}

/// Whether a row already names `path`: UNIQUE(path) would fail the
/// transaction after the file moved. An unreadable answer counts as taken.
fn path_taken(conn: &Connection, path: &Path) -> bool {
    conn.query_row(
        "SELECT 1 FROM entries WHERE path = ?1",
        [path.to_string_lossy().as_ref()],
        |_| Ok(()),
    )
    .optional()
    .map_or(true, |hit| hit.is_some())
}

fn file_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| format!("{} has no file name", path.display()))
}

/// The comment sidecar follows its note (D16), renamed to match a suffixed
/// name. Best effort: a sidecar that cannot move stays where it was and only
/// the log says so — the note's own move is what matters.
fn move_sidecar(from_doc: &Path, to_doc: &Path) {
    let (Some(from), Some(to)) = (
        crate::comments::sidecar_path(from_doc),
        crate::comments::sidecar_path(to_doc),
    ) else {
        return;
    };
    if !occupied(&from) {
        return;
    }
    if let Err(e) = move_no_clobber(&from, &to) {
        eprintln!("[stash::trash] sidecar {} not moved: {e}", from.display());
    }
}

/// Moves `dest` back to `src` after the transaction that should have
/// followed the move failed. `what` names the operation for the log.
fn move_back(dest: &Path, src: &Path, what: &str, e: &str) {
    match move_no_clobber(dest, src) {
        Ok(()) => move_sidecar(dest, src),
        Err(back) => eprintln!(
            "[stash::trash] {what} failed ({e}); the file stays at {} ({back})",
            dest.display()
        ),
    }
}

impl Stash {
    /// Stage 06 delete. A note's file moves into the trash (no-clobber), then
    /// its row takes the new path and `deleted_at` and leaves the search
    /// index, in one transaction; a failed transaction moves the file back. A
    /// note already trashed is left as it is. A file reference loses its row
    /// and tags (`remove_file_ref`); the file is not touched. The caller has
    /// made sure no tab holds a note's path (`delete_flow`, stage 06 D2).
    ///
    /// The move runs under the stash lock: one rename inside couplet's own
    /// folder, no read of the user's text. The copy fallback cannot run —
    /// a symlinked `.trash`, the only way off the volume, is refused.
    pub(crate) fn delete_entry(&mut self, id: &str, now: i64) -> Result<Deleted, String> {
        let r = row(&self.conn, id)?;
        if r.kind == StashKind::File.as_str() {
            self.remove_file_ref(id)?;
            return Ok(Deleted::Removed);
        }
        if r.deleted_at.is_some() {
            return Ok(Deleted::Trashed);
        }
        self.trash_note(id, &r.path, now)?;
        Ok(Deleted::Trashed)
    }

    /// The live note `id`, whose row names `path`, into the trash. A file
    /// already gone just marks the row (its path stays). The row changes only
    /// while it still names `path` and is live.
    fn trash_note(&mut self, id: &str, path: &str, now: i64) -> Result<(), String> {
        // The notes folder in its one spelling: `trash_dir` follows it, so
        // the stored trash path needs no `path_norm` call under the lock.
        self.notes_dir()?;
        let src = PathBuf::from(path);
        let moved = if occupied(&src) {
            let trash = self.paths.trash_dir.clone();
            fs::create_dir_all(&trash).map_err(|e| format!("{}: {e}", trash.display()))?;
            crate::session::require_real_trash_dir(&trash)?;
            let name = file_name(&src)?;
            let conn = &self.conn;
            let dest = move_into(&trash, &name, &src, |p| path_taken(conn, p))?;
            move_sidecar(&src, &dest);
            Some(dest)
        } else {
            None
        };
        let new_path = moved
            .as_deref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string());
        if let Err(e) = self.mark_trashed(id, path, &new_path, now) {
            if let Some(dest) = &moved {
                move_back(dest, &src, &format!("delete of {id}"), &e);
            }
            return Err(e);
        }
        Ok(())
    }

    fn mark_trashed(&mut self, id: &str, old: &str, new: &str, now: i64) -> Result<(), String> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db::err)?;
        let n = tx
            .execute(
                "UPDATE entries SET path = ?2, deleted_at = ?3 \
                 WHERE id = ?1 AND path = ?4 AND deleted_at IS NULL",
                params![id, new, now, old],
            )
            .map_err(db::err)?;
        if n != 1 {
            return Err(format!("stash entry {id} changed while it was being deleted"));
        }
        // Same transaction (A8): a trashed row is never in the index.
        search::unindex_entry(&tx, id)?;
        tx.commit().map_err(db::err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atomic_write::testkit::scratch;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn never_taken(_: &Path) -> bool {
        false
    }

    /// Makes `dir` read-only for the rest of the test's scope (unlinking in
    /// it fails), and writable again on drop so the scratch dir can be read.
    struct ReadOnly<'a>(&'a Path);

    impl<'a> ReadOnly<'a> {
        fn new(dir: &'a Path) -> Self {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o555)).unwrap();
            Self(dir)
        }
    }

    impl Drop for ReadOnly<'_> {
        fn drop(&mut self) {
            let _ = fs::set_permissions(self.0, fs::Permissions::from_mode(0o755));
        }
    }

    use crate::stash::testkit::{set_columns, stash_in, user_file, MSK, T0};
    use crate::stash::{PutAway, Stash, StashEntry};
    use rusqlite::params;

    const DAY: i64 = 24 * 60 * 60 * 1000;

    /// A note through the stash's own path, so the file and the row are real
    /// (and indexed: `insert_note_row` indexes from the text).
    fn note(stash: &mut Stash, text: &str) -> StashEntry {
        stash.create_note(text, None, T0, MSK).unwrap()
    }

    fn file_ref(stash: &mut Stash, root: &Path, rel: &str, text: &str) -> (StashEntry, PathBuf) {
        let path = user_file(root, rel, text);
        let req = PutAway {
            paths: vec![path.clone()],
            ..Default::default()
        };
        let got = stash.put_away(&req, T0).unwrap();
        (got[0].entry.clone(), PathBuf::from(path))
    }

    fn tags(stash: &Stash, id: &str) -> Vec<String> {
        let mut st = stash
            .conn
            .prepare("SELECT tag FROM tags WHERE entry_id = ?1 ORDER BY tag")
            .unwrap();
        st.query_map(params![id], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    /// `(path, deleted_at, stashed_at)`.
    fn row(stash: &Stash, id: &str) -> Option<(String, Option<i64>, Option<i64>)> {
        stash
            .conn
            .query_row(
                "SELECT path, deleted_at, stashed_at FROM entries WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok()
    }

    fn indexed(stash: &Stash, id: &str) -> bool {
        stash
            .conn
            .query_row(
                "SELECT count(*) FROM entries_fts \
                 WHERE rowid = (SELECT rowid FROM entries WHERE id = ?1)",
                params![id],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
            > 0
    }

    /// Every UPDATE of `entries` on this connection fails from now on.
    fn fail_next_update(stash: &Stash) {
        stash
            .conn
            .execute_batch(
                "CREATE TEMP TRIGGER boom BEFORE UPDATE ON entries \
                 BEGIN SELECT RAISE(ABORT, 'boom'); END;",
            )
            .unwrap();
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn unique_target_returns_the_plain_name_when_free() {
        let dir = scratch("trash-uniq-free");
        assert_eq!(unique_target(&dir, "a.md", never_taken).unwrap(), dir.join("a.md"));
    }

    #[test]
    fn unique_target_suffixes_before_the_extension() {
        let dir = scratch("trash-uniq-suffix");
        fs::write(dir.join("a.md"), "1").unwrap();
        assert_eq!(unique_target(&dir, "a.md", never_taken).unwrap(), dir.join("a-2.md"));
        fs::write(dir.join("a-2.md"), "2").unwrap();
        assert_eq!(unique_target(&dir, "a.md", never_taken).unwrap(), dir.join("a-3.md"));
    }

    #[test]
    fn unique_target_handles_names_without_extension_and_dotfiles() {
        let dir = scratch("trash-uniq-noext");
        fs::write(dir.join("notes"), "1").unwrap();
        assert_eq!(unique_target(&dir, "notes", never_taken).unwrap(), dir.join("notes-2"));
        fs::write(dir.join(".mdmini_comments_a.md"), "1").unwrap();
        assert_eq!(
            unique_target(&dir, ".mdmini_comments_a.md", never_taken).unwrap(),
            dir.join(".mdmini_comments_a-2.md")
        );
    }

    #[test]
    fn unique_target_skips_names_another_row_holds() {
        let dir = scratch("trash-uniq-db");
        let taken = dir.join("a.md");
        assert_eq!(
            unique_target(&dir, "a.md", |p| p == taken).unwrap(),
            dir.join("a-2.md")
        );
    }

    #[test]
    fn unique_target_treats_a_dangling_symlink_as_taken() {
        let dir = scratch("trash-uniq-dangling");
        symlink(dir.join("nowhere"), dir.join("a.md")).unwrap();
        assert_eq!(unique_target(&dir, "a.md", never_taken).unwrap(), dir.join("a-2.md"));
    }

    #[test]
    fn move_no_clobber_moves_and_keeps_the_bytes() {
        let dir = scratch("trash-move");
        fs::write(dir.join("a.md"), "тайник\r\nline").unwrap();
        move_no_clobber(&dir.join("a.md"), &dir.join("b.md")).unwrap();
        assert!(!dir.join("a.md").exists());
        assert_eq!(fs::read(dir.join("b.md")).unwrap(), "тайник\r\nline".as_bytes());
    }

    #[test]
    fn move_no_clobber_never_overwrites() {
        let dir = scratch("trash-move-excl");
        fs::write(dir.join("a.md"), "mine").unwrap();
        fs::write(dir.join("b.md"), "theirs").unwrap();
        assert!(matches!(
            move_no_clobber(&dir.join("a.md"), &dir.join("b.md")),
            Err(MoveError::Exists)
        ));
        assert_eq!(fs::read_to_string(dir.join("a.md")).unwrap(), "mine");
        assert_eq!(fs::read_to_string(dir.join("b.md")).unwrap(), "theirs");
    }

    #[test]
    fn move_no_clobber_never_overwrites_a_dangling_symlink() {
        let dir = scratch("trash-move-dangling");
        fs::write(dir.join("a.md"), "mine").unwrap();
        symlink(dir.join("nowhere"), dir.join("b.md")).unwrap();
        assert!(matches!(
            move_no_clobber(&dir.join("a.md"), &dir.join("b.md")),
            Err(MoveError::Exists)
        ));
        assert_eq!(fs::read_to_string(dir.join("a.md")).unwrap(), "mine");
        assert!(fs::symlink_metadata(dir.join("b.md")).unwrap().file_type().is_symlink());
    }

    #[test]
    fn link_fallback_moves_and_never_overwrites() {
        let dir = scratch("trash-link");
        fs::write(dir.join("a.md"), "text").unwrap();
        link_then_unlink(&dir.join("a.md"), &dir.join("b.md")).unwrap();
        assert!(!dir.join("a.md").exists());
        assert_eq!(fs::read_to_string(dir.join("b.md")).unwrap(), "text");

        fs::write(dir.join("c.md"), "mine").unwrap();
        assert!(matches!(
            link_then_unlink(&dir.join("c.md"), &dir.join("b.md")),
            Err(MoveError::Exists)
        ));
        assert_eq!(fs::read_to_string(dir.join("c.md")).unwrap(), "mine");
        assert_eq!(fs::read_to_string(dir.join("b.md")).unwrap(), "text");
    }

    #[test]
    fn link_fallback_has_the_second_name_before_the_first_goes() {
        // The source's folder refuses the unlink: the new name must already
        // hold the text, and the old one must still hold it too.
        let root = scratch("trash-link-order");
        let from_dir = root.join("from");
        let to_dir = root.join("to");
        fs::create_dir_all(&from_dir).unwrap();
        fs::create_dir_all(&to_dir).unwrap();
        fs::write(from_dir.join("a.md"), "text").unwrap();
        let result = {
            let _ro = ReadOnly::new(&from_dir);
            link_then_unlink(&from_dir.join("a.md"), &to_dir.join("a.md"))
        };
        assert!(matches!(result, Err(MoveError::Other(_))), "{result:?}");
        assert_eq!(fs::read_to_string(from_dir.join("a.md")).unwrap(), "text");
        assert_eq!(fs::read_to_string(to_dir.join("a.md")).unwrap(), "text");
    }

    #[test]
    fn copy_fallback_verifies_then_removes_the_source() {
        let dir = scratch("trash-copy");
        fs::write(dir.join("a.md"), "text").unwrap();
        fs::set_permissions(dir.join("a.md"), fs::Permissions::from_mode(0o600)).unwrap();
        copy_verify_remove(&dir.join("a.md"), &dir.join("b.md")).unwrap();
        assert!(!dir.join("a.md").exists());
        assert_eq!(fs::read_to_string(dir.join("b.md")).unwrap(), "text");
        assert_eq!(
            fs::metadata(dir.join("b.md")).unwrap().permissions().mode() & 0o7777,
            0o600
        );
    }

    #[test]
    fn copy_fallback_never_overwrites() {
        let dir = scratch("trash-copy-excl");
        fs::write(dir.join("a.md"), "mine").unwrap();
        fs::write(dir.join("b.md"), "theirs").unwrap();
        assert!(matches!(
            copy_verify_remove(&dir.join("a.md"), &dir.join("b.md")),
            Err(MoveError::Exists)
        ));
        assert_eq!(fs::read_to_string(dir.join("a.md")).unwrap(), "mine");
        assert_eq!(fs::read_to_string(dir.join("b.md")).unwrap(), "theirs");
    }

    #[test]
    fn copy_fallback_has_the_copy_on_disk_before_the_source_goes() {
        let root = scratch("trash-copy-order");
        let from_dir = root.join("from");
        let to_dir = root.join("to");
        fs::create_dir_all(&from_dir).unwrap();
        fs::create_dir_all(&to_dir).unwrap();
        fs::write(from_dir.join("a.md"), "text").unwrap();
        let result = {
            let _ro = ReadOnly::new(&from_dir);
            copy_verify_remove(&from_dir.join("a.md"), &to_dir.join("a.md"))
        };
        assert!(matches!(result, Err(MoveError::Other(_))), "{result:?}");
        assert_eq!(fs::read_to_string(from_dir.join("a.md")).unwrap(), "text");
        assert_eq!(fs::read_to_string(to_dir.join("a.md")).unwrap(), "text");
    }

    #[test]
    fn move_into_retries_past_a_name_taken_after_the_check() {
        let root = scratch("trash-move-into");
        let trash = root.join(".trash");
        fs::create_dir_all(&trash).unwrap();
        fs::write(root.join("a.md"), "note").unwrap();
        fs::write(trash.join("a.md"), "older").unwrap();
        let dest = move_into(&trash, "a.md", &root.join("a.md"), never_taken).unwrap();
        assert_eq!(dest, trash.join("a-2.md"));
        assert_eq!(fs::read_to_string(trash.join("a.md")).unwrap(), "older");
        assert_eq!(fs::read_to_string(&dest).unwrap(), "note");
        assert!(!root.join("a.md").exists());
    }

    #[test]
    fn move_into_skips_a_name_that_appears_between_the_check_and_the_move() {
        // `taken` reports the name free, then something takes it before the
        // move: the exclusive rename refuses, and the next name is used.
        let root = scratch("trash-move-into-race");
        let trash = root.join(".trash");
        fs::create_dir_all(&trash).unwrap();
        fs::write(root.join("a.md"), "note").unwrap();
        let racer = trash.join("a.md");
        let raced = std::cell::Cell::new(false);
        let dest = move_into(&trash, "a.md", &root.join("a.md"), |p| {
            if p == racer && !raced.get() {
                raced.set(true);
                fs::write(&racer, "theirs").unwrap();
                return false;
            }
            false
        })
        .unwrap();
        assert_eq!(dest, trash.join("a-2.md"));
        assert_eq!(fs::read_to_string(&racer).unwrap(), "theirs");
        assert_eq!(fs::read_to_string(&dest).unwrap(), "note");
    }

    #[test]
    fn purgeable_file_accepts_a_regular_file_in_the_trash() {
        let root = scratch("trash-guard-ok");
        let trash = root.join(".trash");
        fs::create_dir_all(&trash).unwrap();
        fs::write(trash.join("a.md"), "x").unwrap();
        let got = purgeable_file(&trash, &trash.join("a.md")).unwrap().unwrap();
        assert_eq!(got.file_name().unwrap(), "a.md");
        assert_eq!(got.parent().unwrap(), fs::canonicalize(&trash).unwrap());
    }

    #[test]
    fn purgeable_file_is_none_for_a_missing_file() {
        let root = scratch("trash-guard-missing");
        let trash = root.join(".trash");
        fs::create_dir_all(&trash).unwrap();
        assert_eq!(purgeable_file(&trash, &trash.join("gone.md")).unwrap(), None);
    }

    #[test]
    fn purgeable_file_refuses_everything_outside_the_trash() {
        let root = scratch("trash-guard-outside");
        let trash = root.join(".trash");
        fs::create_dir_all(&trash).unwrap();
        fs::write(root.join("live.md"), "x").unwrap();
        let elsewhere = scratch("trash-guard-elsewhere");
        fs::write(elsewhere.join("doc.md"), "x").unwrap();
        fs::create_dir_all(trash.join("sub")).unwrap();
        fs::write(trash.join("sub").join("deep.md"), "x").unwrap();

        assert!(purgeable_file(&trash, &root.join("live.md")).is_err());
        assert!(purgeable_file(&trash, &elsewhere.join("doc.md")).is_err());
        assert!(purgeable_file(&trash, &trash.join("..").join("live.md")).is_err());
        assert!(purgeable_file(&trash, &trash.join("sub").join("deep.md")).is_err());
        assert!(purgeable_file(&trash, &trash.join("sub")).is_err());
    }

    #[test]
    fn purgeable_file_refuses_a_symlink_in_the_trash() {
        let root = scratch("trash-guard-symlink");
        let trash = root.join(".trash");
        fs::create_dir_all(&trash).unwrap();
        fs::write(root.join("precious.md"), "keep me").unwrap();
        symlink(root.join("precious.md"), trash.join("a.md")).unwrap();
        assert!(purgeable_file(&trash, &trash.join("a.md")).is_err());
    }

    #[test]
    fn purgeable_file_refuses_a_symlinked_trash_folder() {
        // `.trash` itself a symlink to a real folder: its files are not the
        // trash's, however their canonical parents compare.
        let root = scratch("trash-guard-symlinked-dir");
        let real = root.join("documents");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("a.md"), "keep me").unwrap();
        let trash = root.join(".trash");
        symlink(&real, &trash).unwrap();
        assert!(purgeable_file(&trash, &trash.join("a.md")).is_err());
        assert!(purgeable_file(&trash, &real.join("a.md")).is_err());
    }

    #[test]
    fn purgeable_file_refuses_when_the_trash_dir_does_not_exist() {
        let root = scratch("trash-guard-nodir");
        fs::write(root.join("a.md"), "x").unwrap();
        assert!(purgeable_file(&root.join(".trash"), &root.join("a.md")).is_err());
    }

    // ---- delete ----

    #[test]
    fn delete_moves_a_note_into_the_trash_byte_for_byte() {
        let (mut stash, _root) = stash_in("trash-del-note");
        let e = note(&mut stash, "# План\n\nтекст\r\n");
        let original = PathBuf::from(&e.path);
        let bytes = fs::read(&original).unwrap();

        assert_eq!(stash.delete_entry(&e.id, T0 + 5).unwrap(), Deleted::Trashed);

        assert!(!original.exists());
        let (path, deleted_at, _) = row(&stash, &e.id).unwrap();
        let moved = PathBuf::from(&path);
        assert_eq!(
            moved.parent().unwrap(),
            fs::canonicalize(&stash.paths.trash_dir).unwrap()
        );
        assert_eq!(moved.file_name(), original.file_name());
        assert_eq!(fs::read(&moved).unwrap(), bytes);
        assert_eq!(deleted_at, Some(T0 + 5));
    }

    #[test]
    fn delete_stores_the_path_in_the_registry_spelling() {
        let (mut stash, _root) = stash_in("trash-del-spelling");
        let e = note(&mut stash, "x");
        stash.delete_entry(&e.id, T0).unwrap();
        let (path, _, _) = row(&stash, &e.id).unwrap();
        assert_eq!(path, crate::path_norm::normalize_str(&path));
    }

    #[test]
    fn delete_removes_the_note_from_the_search_index() {
        let (mut stash, _root) = stash_in("trash-del-fts");
        let e = note(&mut stash, "# искомое\n");
        assert!(indexed(&stash, &e.id));
        stash.delete_entry(&e.id, T0).unwrap();
        assert!(!indexed(&stash, &e.id));
    }

    #[test]
    fn delete_keeps_tags() {
        let (mut stash, _root) = stash_in("trash-del-tags");
        let e = note(&mut stash, "x");
        stash.tag(&e.id, &["infra".into()], &[]).unwrap();
        stash.delete_entry(&e.id, T0).unwrap();
        assert_eq!(tags(&stash, &e.id), vec!["infra".to_string()]);
    }

    #[test]
    fn delete_suffixes_a_name_already_in_the_trash() {
        let (mut stash, _root) = stash_in("trash-del-collide");
        let e = note(&mut stash, "mine");
        let name = PathBuf::from(&e.path).file_name().unwrap().to_owned();
        let trash = stash.paths.trash_dir.clone();
        fs::create_dir_all(&trash).unwrap();
        fs::write(trash.join(&name), "leftover").unwrap();

        stash.delete_entry(&e.id, T0).unwrap();

        let (path, _, _) = row(&stash, &e.id).unwrap();
        assert!(path.ends_with("-2.md"), "{path}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "mine");
        assert_eq!(fs::read_to_string(trash.join(&name)).unwrap(), "leftover");
    }

    #[test]
    fn delete_suffixes_a_name_another_row_holds() {
        // No file at the name, but a row names it: UNIQUE(path) would fail the
        // transaction after the file moved.
        let (mut stash, _root) = stash_in("trash-del-row-collide");
        let e = note(&mut stash, "mine");
        let other = note(&mut stash, "other");
        let name = PathBuf::from(&e.path).file_name().unwrap().to_owned();
        let trash = stash.paths.trash_dir.clone();
        let held = trash.join(&name);
        set_columns(
            &stash,
            &other.id,
            &format!("path = '{}', deleted_at = 1", held.to_string_lossy()),
        );

        stash.delete_entry(&e.id, T0).unwrap();

        let (path, deleted_at, _) = row(&stash, &e.id).unwrap();
        assert!(path.ends_with("-2.md"), "{path}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "mine");
        assert_eq!(deleted_at, Some(T0));
    }

    #[test]
    fn delete_of_a_file_ref_removes_row_and_tags_and_never_touches_the_file() {
        let (mut stash, root) = stash_in("trash-del-ref");
        let (e, file) = file_ref(&mut stash, &root, "report.md", "их текст");
        stash.tag(&e.id, &["review".into()], &[]).unwrap();

        assert_eq!(stash.delete_entry(&e.id, T0).unwrap(), Deleted::Removed);

        assert_eq!(row(&stash, &e.id), None);
        assert!(tags(&stash, &e.id).is_empty());
        assert_eq!(fs::read_to_string(&file).unwrap(), "их текст");
        assert!(!stash.paths.trash_dir.exists());
    }

    #[test]
    fn delete_twice_is_a_no_op() {
        let (mut stash, _root) = stash_in("trash-del-twice");
        let e = note(&mut stash, "x");
        stash.delete_entry(&e.id, T0).unwrap();
        let first = row(&stash, &e.id).unwrap();
        assert_eq!(
            stash.delete_entry(&e.id, T0 + DAY).unwrap(),
            Deleted::Trashed
        );
        assert_eq!(row(&stash, &e.id).unwrap(), first);
        assert_eq!(fs::read_to_string(&first.0).unwrap(), "x");
    }

    #[test]
    fn delete_of_a_note_whose_file_is_gone_still_leaves_the_stash() {
        let (mut stash, _root) = stash_in("trash-del-gone");
        let e = note(&mut stash, "x");
        fs::remove_file(&e.path).unwrap();
        assert_eq!(stash.delete_entry(&e.id, T0).unwrap(), Deleted::Trashed);
        let (path, deleted_at, _) = row(&stash, &e.id).unwrap();
        assert_eq!(path, e.path);
        assert_eq!(deleted_at, Some(T0));
        assert!(!indexed(&stash, &e.id));
    }

    #[test]
    fn delete_moves_the_file_back_when_the_row_cannot_be_updated() {
        let (mut stash, _root) = stash_in("trash-del-rollback");
        let e = note(&mut stash, "keep");
        let side = crate::comments::sidecar_path(Path::new(&e.path)).unwrap();
        fs::write(&side, "threads").unwrap();
        fail_next_update(&stash);

        assert!(stash.delete_entry(&e.id, T0).is_err());

        assert_eq!(fs::read_to_string(&e.path).unwrap(), "keep");
        assert_eq!(fs::read_to_string(&side).unwrap(), "threads");
        assert_eq!(row(&stash, &e.id).unwrap().1, None);
        assert!(indexed(&stash, &e.id));
        assert!(names_in(&stash.paths.trash_dir).is_empty());
    }

    #[test]
    fn delete_leaves_everything_when_the_trash_refuses_the_file() {
        let (mut stash, _root) = stash_in("trash-del-readonly");
        let e = note(&mut stash, "keep");
        let trash = stash.paths.trash_dir.clone();
        fs::create_dir_all(&trash).unwrap();
        let result = {
            let _ro = ReadOnly::new(&trash);
            stash.delete_entry(&e.id, T0)
        };
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&e.path).unwrap(), "keep");
        assert_eq!(row(&stash, &e.id).unwrap(), (e.path.clone(), None, None));
        assert!(names_in(&trash).is_empty());
    }

    #[test]
    fn delete_refuses_a_symlinked_trash_folder() {
        let (mut stash, root) = stash_in("trash-del-symlinked");
        let e = note(&mut stash, "keep");
        let elsewhere = root.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        symlink(&elsewhere, &stash.paths.trash_dir).unwrap();

        assert!(stash.delete_entry(&e.id, T0).is_err());

        assert_eq!(fs::read_to_string(&e.path).unwrap(), "keep");
        assert_eq!(row(&stash, &e.id).unwrap().1, None);
        assert!(names_in(&elsewhere).is_empty());
    }

    #[test]
    fn delete_takes_the_comment_sidecar_along() {
        let (mut stash, _root) = stash_in("trash-del-sidecar");
        let e = note(&mut stash, "x");
        let side = crate::comments::sidecar_path(Path::new(&e.path)).unwrap();
        fs::write(&side, "threads").unwrap();
        stash.delete_entry(&e.id, T0).unwrap();
        let (path, _, _) = row(&stash, &e.id).unwrap();
        let moved_side = crate::comments::sidecar_path(Path::new(&path)).unwrap();
        assert!(!side.exists());
        assert_eq!(fs::read_to_string(moved_side).unwrap(), "threads");
    }

    #[test]
    fn delete_renames_the_sidecar_with_a_suffixed_note() {
        let (mut stash, _root) = stash_in("trash-del-sidecar-suffix");
        let e = note(&mut stash, "x");
        let name = PathBuf::from(&e.path).file_name().unwrap().to_owned();
        let trash = stash.paths.trash_dir.clone();
        fs::create_dir_all(&trash).unwrap();
        fs::write(trash.join(&name), "leftover").unwrap();
        let side = crate::comments::sidecar_path(Path::new(&e.path)).unwrap();
        fs::write(&side, "threads").unwrap();

        stash.delete_entry(&e.id, T0).unwrap();

        let (path, _, _) = row(&stash, &e.id).unwrap();
        assert!(path.ends_with("-2.md"), "{path}");
        let moved_side = crate::comments::sidecar_path(Path::new(&path)).unwrap();
        assert_eq!(fs::read_to_string(moved_side).unwrap(), "threads");
        assert!(!side.exists());
    }

    #[test]
    fn delete_of_an_unknown_id_is_an_error() {
        let (mut stash, _root) = stash_in("trash-del-unknown");
        assert!(stash.delete_entry("nope", T0).is_err());
    }
}
