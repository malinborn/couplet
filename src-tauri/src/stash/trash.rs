//! The note trash (stage 06): delete moves a note's file into
//! `StashPaths::trash_dir`, restore moves it back, purge is the one place
//! that deletes a note's bytes — and only a regular file directly inside that
//! directory. Every move is no-clobber; every move across volumes copies,
//! verifies and only then removes the source.

use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use std::collections::HashMap;
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::{clock, db, search, KeptReason, Stash, StashEntry, StashKind, StashState};

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
/// — its comment sidecar's name included, or the sidecar could not follow
/// the note (D16) — and not held by another row (`taken`). Only a hint: the
/// move itself is what refuses a name taken since (`move_into`).
pub(crate) fn unique_target(
    dir: &Path,
    file_name: &str,
    taken: impl Fn(&Path) -> bool,
) -> Result<PathBuf, String> {
    let sidecar_free =
        |p: &Path| crate::comments::sidecar_path(p).is_none_or(|s| !occupied(&s));
    let free = |p: &Path| !occupied(p) && sidecar_free(p) && !taken(p);
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

    /// Stage 06 restore (D8), the database and file half: the trashed note's
    /// file back into the notes folder (a taken name gets a suffix), out of
    /// the trash and put away now — so «изменение» shows it on top — with its
    /// tags, `opened_at` and `modified_at` untouched. A failed transaction
    /// moves the file back into the trash. Not re-indexed: that reads the
    /// note, which never happens under the stash lock — `restore` does it
    /// after. Answers the entry from the database alone.
    pub(crate) fn restore_entry(&mut self, id: &str, now: i64) -> Result<StashEntry, String> {
        let r = row(&self.conn, id)?;
        if r.kind != StashKind::Note.as_str() || r.deleted_at.is_none() {
            return Err(format!("stash entry {id} is not in the trash"));
        }
        let src = PathBuf::from(&r.path);
        let meta = fs::symlink_metadata(&src)
            .map_err(|_| format!("the note's file is gone from the trash ({})", src.display()))?;
        if !meta.file_type().is_file() {
            return Err(format!("{} is not a regular file", src.display()));
        }
        let dir = self.notes_dir()?;
        let name = file_name(&src)?;
        let conn = &self.conn;
        let dest = move_into(&dir, &name, &src, |p| path_taken(conn, p))?;
        move_sidecar(&src, &dest);
        let new_path = dest.to_string_lossy().into_owned();
        if let Err(e) = self.mark_restored(id, &r.path, &new_path, now) {
            move_back(&dest, &src, &format!("restore of {id}"), &e);
            return Err(e);
        }
        self.get(id)
    }

    fn mark_restored(&mut self, id: &str, old: &str, new: &str, now: i64) -> Result<(), String> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db::err)?;
        let n = tx
            .execute(
                "UPDATE entries SET path = ?2, deleted_at = NULL, stashed_at = ?3 \
                 WHERE id = ?1 AND path = ?4 AND deleted_at IS NOT NULL",
                params![id, new, now, old],
            )
            .map_err(db::err)?;
        if n != 1 {
            return Err(format!("stash entry {id} changed while it was being restored"));
        }
        tx.commit().map_err(db::err)
    }

    /// «удалить навсегда» and the 30-day purge: the only code that deletes a
    /// note's bytes (D9). Only a trashed note; only a regular file directly
    /// inside a real trash folder (`purgeable_file`) — a tampered row, a
    /// symlink, a directory or a symlinked `.trash` is refused and nothing
    /// changes. A file already gone just loses its row. The comment sidecar
    /// goes under the same guard, best effort.
    pub(crate) fn purge_entry(&mut self, id: &str) -> Result<(), String> {
        let r = row(&self.conn, id)?;
        if r.kind != StashKind::Note.as_str() || r.deleted_at.is_none() {
            return Err(format!("stash entry {id} is not in the trash"));
        }
        let trash = self.paths.trash_dir.clone();
        let doc = PathBuf::from(&r.path);
        if let Some(file) = purgeable_file(&trash, &doc)? {
            fs::remove_file(&file).map_err(|e| format!("{}: {e}", file.display()))?;
        }
        if let Some(side) = crate::comments::sidecar_path(&doc) {
            match purgeable_file(&trash, &side) {
                Ok(Some(s)) => {
                    if let Err(e) = fs::remove_file(&s) {
                        eprintln!("[stash::trash] sidecar {} not removed: {e}", s.display());
                    }
                }
                Ok(None) => {}
                Err(e) => eprintln!("[stash::trash] sidecar left alone: {e}"),
            }
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db::err)?;
        // Before the DELETE: afterwards the rowid can no longer be found.
        search::unindex_entry(&tx, id)?;
        // Explicit although `tags` cascades, as in `remove_file_ref`.
        tx.execute("DELETE FROM tags WHERE entry_id = ?1", [id])
            .map_err(db::err)?;
        tx.execute(
            "DELETE FROM entries WHERE id = ?1 AND kind = 'note' AND deleted_at IS NOT NULL",
            [id],
        )
        .map_err(db::err)?;
        tx.commit().map_err(db::err)
    }

    /// Trashed notes deleted at least `TRASH_RETENTION_MS` before `now`,
    /// oldest first.
    fn expired_trash(&self, now: i64) -> Result<Vec<String>, String> {
        let mut st = self
            .conn
            .prepare(
                "SELECT id FROM entries \
                 WHERE kind = 'note' AND deleted_at IS NOT NULL AND deleted_at <= ?1 \
                 ORDER BY deleted_at, rowid",
            )
            .map_err(db::err)?;
        let ids = st
            .query_map([now - TRASH_RETENTION_MS], |r| r.get(0))
            .map_err(db::err)?
            .collect::<Result<Vec<String>, _>>()
            .map_err(db::err)?;
        Ok(ids)
    }

    /// Every note's `(id, path, deleted_at)`: `reconcile`'s snapshot.
    fn note_rows(&self) -> Result<Vec<(String, String, Option<i64>)>, String> {
        let mut st = self
            .conn
            .prepare("SELECT id, path, deleted_at FROM entries WHERE kind = 'note' ORDER BY rowid")
            .map_err(db::err)?;
        let rows = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(db::err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db::err)?;
        Ok(rows)
    }

    /// One `reconcile` fix, SQL only: `Some(modified_at)` when the row moved
    /// to `fix.there` — only while it still names `fix.here` in the state it
    /// was seen in, and no other row names `fix.there`. A note marked
    /// deleted leaves the index in the same transaction.
    fn apply_fix(&mut self, fix: &Fix, now: i64) -> Result<Option<i64>, String> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db::err)?;
        if path_taken(&tx, Path::new(&fix.there)) {
            return Ok(None);
        }
        let sql = if fix.restoring {
            "UPDATE entries SET path = ?2, deleted_at = NULL, stashed_at = ?3 \
             WHERE id = ?1 AND path = ?4 AND kind = 'note' AND deleted_at IS NOT NULL \
             RETURNING modified_at"
        } else {
            "UPDATE entries SET path = ?2, deleted_at = ?3 \
             WHERE id = ?1 AND path = ?4 AND kind = 'note' AND deleted_at IS NULL \
             RETURNING modified_at"
        };
        let stamp: Option<i64> = tx
            .query_row(sql, params![fix.id, fix.there, now, fix.here], |r| r.get(0))
            .optional()
            .map_err(db::err)?;
        if stamp.is_some() && !fix.restoring {
            search::unindex_entry(&tx, &fix.id)?;
        }
        tx.commit().map_err(db::err)?;
        Ok(stamp)
    }
}

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Housekeeping runs when a day of wall clock has passed since the last run,
/// or when the clock went backwards (a manual change must not stall it).
pub(crate) fn due(last: Option<i64>, now: i64) -> bool {
    match last {
        None => true,
        Some(l) => now < l || now - l >= DAY_MS,
    }
}

/// What `reconcile` changed, by the event each needs.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct Reconciled {
    /// Live notes whose file was already in the trash: now trashed.
    pub(crate) deleted: Vec<String>,
    /// Trashed notes whose file was already back in the notes folder: now live.
    pub(crate) restored: Vec<String>,
}

/// One interrupted move to finish: the row names `here`, the file is at
/// `there` (both `path_norm` spellings).
struct Fix {
    id: String,
    here: String,
    there: String,
    restoring: bool,
}

/// Finish a move a crash cut between the rename and the transaction (D11):
/// a live note whose file is gone while `.trash/<name>` holds a regular file
/// is marked deleted; a trashed note whose file is gone while
/// `<notes>/<name>` holds one — and no other row names it — is marked
/// restored. Only the exact name is looked for; anything else is left
/// alone, and nothing on disk is moved or removed.
///
/// Phased like `ensure_index`: the rows are read under the lock, the disk is
/// looked at with no lock held, and each fix is one guarded transaction. A
/// restored note is re-indexed as `restore` does, off the lock.
pub(crate) fn reconcile(state: &StashState, now: i64) -> Reconciled {
    let mut done = Reconciled::default();
    let snapshot = state.with(|s| {
        Ok((
            s.note_rows()?,
            s.paths.notes_dir.clone(),
            s.paths.trash_dir.clone(),
        ))
    });
    let (rows, notes_dir, trash_dir) = match snapshot {
        Ok(snapshot) => snapshot,
        Err(e) => {
            eprintln!("[stash::trash] reconcile: {e}");
            return done;
        }
    };
    // A symlinked `.trash` is not the trash: nothing is marked deleted into it.
    let trash_ok = crate::session::require_real_trash_dir(&trash_dir).is_ok();
    let notes_dir = crate::path_norm::normalize_path(&notes_dir);
    let trash_dir = crate::path_norm::normalize_path(&trash_dir);

    let fixes: Vec<Fix> = rows
        .into_iter()
        .filter_map(|(id, path, deleted_at)| {
            let here = Path::new(&path);
            if occupied(here) {
                return None;
            }
            let restoring = deleted_at.is_some();
            if !restoring && !trash_ok {
                return None;
            }
            let name = here.file_name()?;
            let there = if restoring { &notes_dir } else { &trash_dir }.join(name);
            let is_file = fs::symlink_metadata(&there).is_ok_and(|m| m.file_type().is_file());
            is_file.then(|| Fix {
                id,
                here: path.clone(),
                there: there.to_string_lossy().into_owned(),
                restoring,
            })
        })
        .collect();

    for fix in fixes {
        let stamp = match state.with(|s| s.apply_fix(&fix, now)) {
            Ok(Some(stamp)) => stamp,
            Ok(None) => continue,
            Err(e) => {
                eprintln!("[stash::trash] reconcile of {} failed: {e}", fix.id);
                continue;
            }
        };
        if fix.restoring {
            if let Some(text) = search::read_saved(&fix.there) {
                if let Err(e) = state.with(|s| s.reindex_written(&fix.there, &text, stamp)) {
                    eprintln!("[stash::trash] reconciled {} but could not index it: {e}", fix.id);
                }
            }
            done.restored.push(fix.id);
        } else {
            done.deleted.push(fix.id);
        }
    }
    done
}

/// How long a trashed note stays restorable. Mirrored as `TRASH_DAYS` in
/// `src/lib/stash/trash-view.ts`; a vitest reads this line.
pub(crate) const TRASH_RETENTION_DAYS: i64 = 30;
pub(crate) const TRASH_RETENTION_MS: i64 = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct PurgeReport {
    pub(crate) purged: Vec<String>,
    /// Rows the guard refused, with the reason — left exactly as they were.
    pub(crate) skipped: Vec<(String, String)>,
}

/// The 30-day purge (D10's pass): every expired trashed note, one stash lock
/// per note, so the housekeeping thread never holds the lock across a run of
/// file removals. One refused row never stops the rest.
pub(crate) fn purge_expired(state: &StashState, now: i64) -> PurgeReport {
    let mut report = PurgeReport::default();
    let ids = match state.with(|s| s.expired_trash(now)) {
        Ok(ids) => ids,
        Err(e) => {
            eprintln!("[stash::trash] purge query failed: {e}");
            return report;
        }
    };
    for id in ids {
        match state.with(|s| s.purge_entry(&id)) {
            Ok(()) => report.purged.push(id),
            Err(e) => {
                eprintln!("[stash::trash] purge of {id} skipped: {e}");
                report.skipped.push((id, e));
            }
        }
    }
    report
}

/// «вернуть»: `Stash::restore_entry`, then the search index from the note as
/// it is on disk — read with no lock held, written only while the row still
/// has the `modified_at` it was restored with (`reindex_written`), so a save
/// that lands in between is not overwritten by this older read. Best effort
/// (D8): the index is derived, and a failed one must not undo a restore.
pub(crate) fn restore(state: &StashState, id: &str, now: i64) -> Result<StashEntry, String> {
    let entry = state.with(|s| s.restore_entry(id, now))?;
    // `read_saved` logs a file it cannot read; `ensure_index` fills the gap later.
    if let Some(text) = search::read_saved(&entry.path) {
        let stamp = entry.modified_at;
        if let Err(e) = state.with(|s| s.reindex_written(&entry.path, &text, stamp)) {
            eprintln!("[stash::trash] restored {id} but could not index it: {e}");
        }
    }
    Ok(entry)
}

// ---- Save As from a note (roadmap A14, stash-questions Q3) ----

/// The most `note_saved_as` reads of either file to compare them. A larger
/// note simply stays in the stash (a duplicate, never a loss).
const SAVED_AS_COMPARE_CAP: u64 = 16 * 1024 * 1024;

/// The whole file, for a byte compare: `open_readable_now`'s refusals (no
/// FIFO hang, no iCloud download), and nothing over the cap.
fn read_for_compare(path: &Path) -> Result<Vec<u8>, String> {
    let file = super::entries::open_readable_now(path)?;
    let mut bytes = Vec::new();
    file.take(SAVED_AS_COMPARE_CAP + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > SAVED_AS_COMPARE_CAP {
        return Err(format!("larger than {SAVED_AS_COMPARE_CAP} bytes"));
    }
    Ok(bytes)
}

/// Whether both files hold the same bytes, lengths first; `Err` when either
/// cannot be read now.
fn same_bytes(a: &Path, b: &Path) -> Result<bool, String> {
    let len = |p: &Path| {
        fs::metadata(p)
            .map(|m| m.len())
            .map_err(|e| format!("{}: {e}", p.display()))
    };
    if len(a)? != len(b)? {
        return Ok(false);
    }
    let read = |p: &Path| read_for_compare(p).map_err(|e| format!("{}: {e}", p.display()));
    Ok(read(a)? == read(b)?)
}

impl Stash {
    /// `note_saved_as`'s locked half: the note `id` into the trash, like a
    /// delete, but only while its row is still a live note naming `old` and
    /// its file is still there. `false`: something changed since the compare,
    /// and nothing was touched.
    pub(crate) fn trash_saved_note(&mut self, id: &str, old: &str, now: i64) -> Result<bool, String> {
        let r = row(&self.conn, id)?;
        if r.kind != StashKind::Note.as_str()
            || r.deleted_at.is_some()
            || r.path != old
            || !occupied(Path::new(old))
        {
            return Ok(false);
        }
        self.trash_note(id, old, now)?;
        Ok(true)
    }
}

/// «Сохранить как…» from a note (A14): once the tab has claimed `new` and
/// written it, the note has moved out of the stash. Its old file goes into
/// the trash and its row becomes trashed — restorable from «Удалённые» and
/// purged after 30 days like any delete (Q3) — but only when every check
/// holds: the paths differ, no tab holds `old` any more (`held`, the
/// registry's owner check: nothing may autosave it back), `old` is a live
/// note, and `new` holds exactly the old file's bytes. Anything else leaves
/// the note in the stash (a duplicate, never a loss) and answers `None`.
///
/// Both paths are normalized first, and the two files are read with no lock
/// held; `held` takes its own short `OpenFiles` lock and returns before the
/// stash lock is taken (A11). `Some(id)`: the entry now trashed.
pub(crate) fn note_saved_as(
    state: &StashState,
    old: &str,
    new: &str,
    held: impl Fn(&str) -> bool,
    now: i64,
) -> Result<Option<String>, String> {
    let old = crate::path_norm::normalize_str(old);
    let new = crate::path_norm::normalize_str(new);
    if old == new {
        return Ok(None);
    }
    if held(&old) {
        eprintln!("[stash::trash] saved as {new}, but a tab still holds {old}: the note stays");
        return Ok(None);
    }
    let id = match state.with(|s| s.entry_for_path(&old))? {
        Some(e) if e.kind == StashKind::Note && e.deleted_at.is_none() => e.id,
        _ => return Ok(None),
    };
    match same_bytes(Path::new(&old), Path::new(&new)) {
        Ok(true) => {}
        Ok(false) => {
            eprintln!("[stash::trash] {new} differs from note {id}: the note stays");
            return Ok(None);
        }
        Err(e) => {
            eprintln!("[stash::trash] note {id} saved as {new} not compared ({e}): the note stays");
            return Ok(None);
        }
    }
    let offset = clock::local_offset_secs(now.div_euclid(1000));
    state.with(|s| {
        let moved = s.trash_saved_note(&id, &old, now)?;
        if moved {
            s.after_write(now, offset);
        }
        Ok(moved.then_some(id))
    })
}

// ---- the delete flow (D2/D3) ----

/// How long a delete waits for the window holding a note's tab to drop it.
pub(crate) const DROP_REPLY_TIMEOUT: Duration = Duration::from_secs(10);

/// The window whose tab holds a note's path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Owner {
    pub(crate) label: String,
    pub(crate) number: Option<u32>,
}

/// What the owner window answered to `stash-drop-tab`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DropReply {
    Dropped,
    /// The tab's save had not landed; the window kept it (and said so there).
    Refused,
    /// No answer in `DROP_REPLY_TIMEOUT`, or the event could not be sent.
    Timeout,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FlowOutcome {
    Done(Deleted),
    Kept { reason: KeptReason, owner: Owner },
}

/// What `delete_flow` needs from the app. `commands::AppDeleteEnv` implements
/// it over `OpenFiles`, `StashState` and the `stash-drop-tab` round trip;
/// tests fake it.
pub(crate) trait DeleteEnv {
    /// `(kind, trashed, path)` of the entry.
    fn entry(&self, id: &str) -> Result<(StashKind, bool, String), String>;
    /// The live window whose tab holds `path`, read under a short
    /// `OpenFiles` lock that is dropped before anything takes the stash lock
    /// (D17/A11).
    fn owner(&self, path: &str) -> Option<Owner>;
    /// Ask `owner` to drop its tab of `path` and wait for the answer.
    fn ask_to_drop(&self, owner: &Owner, path: &str) -> DropReply;
    /// `Stash::delete_entry` (+ `after_write`) under the stash lock.
    fn trash(&self, id: &str) -> Result<Deleted, String>;
}

/// D2/D3: a live note held by a tab is dropped by that tab's window first —
/// its last keystroke saved, no autosave bound to its path any more — and the
/// file moves only once nobody holds the path, so nothing can write it back
/// into the notes folder. A file reference leaves the stash whoever has it
/// open (D12): its file is not touched.
pub(crate) fn delete_flow(env: &impl DeleteEnv, id: &str) -> Result<FlowOutcome, String> {
    let (kind, trashed, path) = env.entry(id)?;
    if kind == StashKind::Note && !trashed {
        if let Some(owner) = env.owner(&path) {
            match env.ask_to_drop(&owner, &path) {
                DropReply::Dropped => {}
                DropReply::Refused => {
                    return Ok(FlowOutcome::Kept { reason: KeptReason::Unsaved, owner })
                }
                DropReply::Timeout => {
                    return Ok(FlowOutcome::Kept { reason: KeptReason::Timeout, owner })
                }
            }
            // A tab opened on the path meanwhile (another window, an agent).
            if let Some(again) = env.owner(&path) {
                return Ok(FlowOutcome::Kept { reason: KeptReason::Open, owner: again });
            }
        }
    }
    env.trash(id).map(FlowOutcome::Done)
}

/// The live window holding `path` in the registry, with its `#N`. A holder
/// whose window is gone counts as nobody: asking it would only wait out
/// `DROP_REPLY_TIMEOUT`.
pub(crate) fn live_owner(
    reg: &crate::tabs::TabRegistry,
    path: &str,
    is_live: impl Fn(&str) -> bool,
) -> Option<Owner> {
    let (label, _tab) = reg.owner_of(path)?;
    if !is_live(&label) {
        return None;
    }
    let number = reg.window(&label).and_then(|w| w.number);
    Some(Owner { label, number })
}

/// Pending `stash-drop-tab` requests, answered by `stash_drop_done`.
/// Managed state; reads no disk.
#[derive(Default)]
pub(crate) struct DropRequests(Mutex<DropInner>);

#[derive(Default)]
struct DropInner {
    next: u64,
    waiting: HashMap<u64, (String, mpsc::Sender<bool>)>,
}

impl DropRequests {
    fn inner(&self) -> std::sync::MutexGuard<'_, DropInner> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// A new request to window `label`, and where its answer arrives.
    pub(crate) fn register(&self, label: &str) -> (u64, mpsc::Receiver<bool>) {
        let (tx, rx) = mpsc::channel();
        let mut inner = self.inner();
        inner.next += 1;
        let id = inner.next;
        inner.waiting.insert(id, (label.to_string(), tx));
        (id, rx)
    }

    /// `false` for an unknown or already answered request, or one asked of
    /// another window — only the window asked may say its tab is gone.
    pub(crate) fn answer(&self, from_label: &str, request_id: u64, dropped: bool) -> bool {
        let mut inner = self.inner();
        match inner.waiting.get(&request_id) {
            Some((label, _)) if label == from_label => {
                let Some((_, tx)) = inner.waiting.remove(&request_id) else {
                    return false;
                };
                tx.send(dropped).is_ok()
            }
            _ => false,
        }
    }

    /// A request nobody waits for any more (timed out, or never sent).
    pub(crate) fn abandon(&self, request_id: u64) {
        self.inner().waiting.remove(&request_id);
    }
}

// ---- housekeeping (D10) ----

/// What one housekeeping pass changed.
#[derive(Debug, Default)]
pub(crate) struct Housekept {
    pub(crate) reconciled: Reconciled,
    pub(crate) purged: PurgeReport,
}

impl Housekept {
    pub(crate) fn changed(&self) -> bool {
        !self.reconciled.deleted.is_empty()
            || !self.reconciled.restored.is_empty()
            || !self.purged.purged.is_empty()
    }
}

/// One pass: finish interrupted moves, then purge what is 30 days old; one
/// export and backup (`after_write`) if anything changed.
pub(crate) fn housekeeping_pass(state: &StashState, now: i64) -> Housekept {
    let done = Housekept {
        reconciled: reconcile(state, now),
        purged: purge_expired(state, now),
    };
    if done.changed() {
        let offset = clock::local_offset_secs(now.div_euclid(1000));
        if let Err(e) = state.with(|s| {
            s.after_write(now, offset);
            Ok(())
        }) {
            eprintln!("[stash::trash] housekeeping export skipped: {e}");
        }
    }
    done
}

/// Housekeeping on its own thread: a pass at startup, then an hourly check
/// against wall clock (D10) — `thread::sleep`'s clock stops while the Mac
/// sleeps, so "once a day" is `due`, not a 24 h sleep. Emits `stash-changed`
/// per reason only when that reason has ids.
pub(crate) fn start_housekeeping(state: StashState, app: tauri::AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("stash-trash".into())
        .spawn(move || {
            let mut last: Option<i64> = None;
            loop {
                let now = clock::now_ms();
                if due(last, now) {
                    last = Some(now);
                    let done = housekeeping_pass(&state, now);
                    if done.changed() || !done.purged.skipped.is_empty() {
                        eprintln!(
                            "[stash::trash] housekeeping: {} marked deleted, {} marked restored, {} purged, {} skipped",
                            done.reconciled.deleted.len(),
                            done.reconciled.restored.len(),
                            done.purged.purged.len(),
                            done.purged.skipped.len(),
                        );
                    }
                    for (reason, ids) in [
                        ("deleted", done.reconciled.deleted),
                        ("restored", done.reconciled.restored),
                        ("purged", done.purged.purged),
                    ] {
                        if !ids.is_empty() {
                            super::emit_changed(&app, reason, Some(ids));
                        }
                    }
                }
                std::thread::sleep(Duration::from_secs(60 * 60));
            }
        });
    if let Err(e) = spawned {
        eprintln!("[stash::trash] housekeeping thread not started: {e}");
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

    use crate::stash::testkit::{paths_in, set_columns, stash_in, user_file, MSK, T0};
    use crate::stash::{PutAway, Stash, StashEntry, StashState};
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
    fn unique_target_skips_a_name_whose_comment_sidecar_is_taken() {
        // A leftover sidecar (a failed sidecar purge) makes its document's
        // name taken: the note's own sidecar could not follow it there.
        let dir = scratch("trash-uniq-sidecar");
        fs::write(dir.join(".mdmini_comments_a.md"), "stale threads").unwrap();
        assert_eq!(unique_target(&dir, "a.md", never_taken).unwrap(), dir.join("a-2.md"));
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
    fn delete_never_leaves_the_sidecar_behind_for_a_stale_one_in_the_trash() {
        let (mut stash, _root) = stash_in("trash-del-sidecar-stale");
        let e = note(&mut stash, "x");
        let name = PathBuf::from(&e.path).file_name().unwrap().to_owned();
        let trash = stash.paths.trash_dir.clone();
        fs::create_dir_all(&trash).unwrap();
        let stale = crate::comments::sidecar_path(&trash.join(&name)).unwrap();
        fs::write(&stale, "stale threads").unwrap();
        let side = crate::comments::sidecar_path(Path::new(&e.path)).unwrap();
        fs::write(&side, "threads").unwrap();

        stash.delete_entry(&e.id, T0).unwrap();

        let (path, _, _) = row(&stash, &e.id).unwrap();
        assert!(path.ends_with("-2.md"), "{path}");
        let moved_side = crate::comments::sidecar_path(Path::new(&path)).unwrap();
        assert_eq!(fs::read_to_string(moved_side).unwrap(), "threads");
        assert!(!side.exists(), "the deleted text's threads must not stay readable");
        assert_eq!(fs::read_to_string(&stale).unwrap(), "stale threads");
    }

    #[test]
    fn delete_of_an_unknown_id_is_an_error() {
        let (mut stash, _root) = stash_in("trash-del-unknown");
        assert!(stash.delete_entry("nope", T0).is_err());
    }

    // ---- restore ----

    fn state_in(tag: &str) -> (StashState, PathBuf) {
        let root = scratch(&format!("stash-{tag}"));
        (StashState::open(Ok(paths_in(&root))), root)
    }

    #[test]
    fn restore_moves_the_note_back_and_puts_it_on_top() {
        let (state, _root) = state_in("trash-restore");
        let e = state
            .with(|s| s.create_note("# Вернись\nтайное слово\n", None, T0, MSK))
            .unwrap();
        state.with(|s| s.delete_entry(&e.id, T0 + 1)).unwrap();
        assert!(state.with(|s| Ok(!indexed(s, &e.id))).unwrap());

        let back = restore(&state, &e.id, T0 + 2).unwrap();

        assert_eq!(back.path, e.path);
        assert_eq!(fs::read_to_string(&back.path).unwrap(), "# Вернись\nтайное слово\n");
        assert_eq!(back.deleted_at, None);
        assert_eq!(back.stashed_at, Some(T0 + 2));
        assert_eq!(back.modified_at, e.modified_at);
        assert!(state.with(|s| Ok(indexed(s, &e.id))).unwrap());
        let hits = state
            .with(|s| Ok(crate::stash::search::found(&s.conn, "тайное")))
            .unwrap();
        assert_eq!(hits, vec![e.id.clone()]);
    }

    #[test]
    fn restore_keeps_tags_and_opened_at() {
        let (mut stash, _root) = stash_in("trash-restore-tags");
        let e = note(&mut stash, "x");
        stash.tag(&e.id, &["a".into(), "b".into()], &[]).unwrap();
        set_columns(&stash, &e.id, &format!("opened_at = {}", T0 - 7));
        stash.delete_entry(&e.id, T0).unwrap();
        let back = stash.restore_entry(&e.id, T0 + 1).unwrap();
        assert_eq!(back.tags, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(back.opened_at, Some(T0 - 7));
    }

    #[test]
    fn restore_suffixes_a_name_taken_in_the_notes_folder() {
        let (mut stash, _root) = stash_in("trash-restore-collide");
        let e = note(&mut stash, "trashed");
        let original = PathBuf::from(&e.path);
        stash.delete_entry(&e.id, T0).unwrap();
        fs::write(&original, "someone else").unwrap();

        let back = stash.restore_entry(&e.id, T0 + 1).unwrap();

        assert!(back.path.ends_with("-2.md"), "{}", back.path);
        assert_eq!(fs::read_to_string(&back.path).unwrap(), "trashed");
        assert_eq!(fs::read_to_string(&original).unwrap(), "someone else");
    }

    #[test]
    fn restore_suffixes_a_name_another_row_holds() {
        let (mut stash, _root) = stash_in("trash-restore-row-collide");
        let e = note(&mut stash, "trashed");
        let other = note(&mut stash, "other");
        stash.delete_entry(&e.id, T0).unwrap();
        set_columns(&stash, &other.id, &format!("path = '{}'", e.path));

        let back = stash.restore_entry(&e.id, T0 + 1).unwrap();

        assert!(back.path.ends_with("-2.md"), "{}", back.path);
        assert_eq!(fs::read_to_string(&back.path).unwrap(), "trashed");
    }

    #[test]
    fn restore_brings_the_sidecar_back_under_the_new_name() {
        let (mut stash, _root) = stash_in("trash-restore-sidecar");
        let e = note(&mut stash, "x");
        let side = crate::comments::sidecar_path(Path::new(&e.path)).unwrap();
        fs::write(&side, "threads").unwrap();
        stash.delete_entry(&e.id, T0).unwrap();
        fs::write(&e.path, "collider").unwrap();
        let back = stash.restore_entry(&e.id, T0 + 1).unwrap();
        let new_side = crate::comments::sidecar_path(Path::new(&back.path)).unwrap();
        assert_eq!(fs::read_to_string(new_side).unwrap(), "threads");
        assert!(!side.exists());
    }

    #[test]
    fn restore_refuses_a_live_note_and_a_file_ref() {
        let (mut stash, root) = stash_in("trash-restore-live");
        let e = note(&mut stash, "x");
        let (r, file) = file_ref(&mut stash, &root, "theirs.md", "theirs");
        assert!(stash.restore_entry(&e.id, T0).is_err());
        assert!(stash.restore_entry(&r.id, T0).is_err());
        assert_eq!(fs::read_to_string(&e.path).unwrap(), "x");
        assert_eq!(fs::read_to_string(&file).unwrap(), "theirs");
        assert_eq!(row(&stash, &e.id).unwrap().2, None);
    }

    #[test]
    fn restore_of_a_missing_file_errors_and_keeps_the_row() {
        let (mut stash, _root) = stash_in("trash-restore-missing");
        let e = note(&mut stash, "x");
        stash.delete_entry(&e.id, T0).unwrap();
        let (path, _, _) = row(&stash, &e.id).unwrap();
        fs::remove_file(&path).unwrap();
        assert!(stash.restore_entry(&e.id, T0 + 1).is_err());
        assert_eq!(row(&stash, &e.id).unwrap(), (path, Some(T0), None));
    }

    #[test]
    fn restore_refuses_a_symlink_in_the_trash() {
        let (mut stash, root) = stash_in("trash-restore-symlink");
        let e = note(&mut stash, "x");
        stash.delete_entry(&e.id, T0).unwrap();
        let (trashed, _, _) = row(&stash, &e.id).unwrap();
        let precious = root.join("precious.md");
        fs::write(&precious, "keep me").unwrap();
        fs::remove_file(&trashed).unwrap();
        symlink(&precious, &trashed).unwrap();

        assert!(stash.restore_entry(&e.id, T0 + 1).is_err());

        assert!(fs::symlink_metadata(&trashed).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&precious).unwrap(), "keep me");
        assert!(!Path::new(&e.path).exists());
    }

    #[test]
    fn restore_moves_the_file_back_into_the_trash_when_the_row_cannot_be_updated() {
        let (mut stash, _root) = stash_in("trash-restore-rollback");
        let e = note(&mut stash, "x");
        let side = crate::comments::sidecar_path(Path::new(&e.path)).unwrap();
        fs::write(&side, "threads").unwrap();
        stash.delete_entry(&e.id, T0).unwrap();
        let (trashed, _, _) = row(&stash, &e.id).unwrap();
        fail_next_update(&stash);

        assert!(stash.restore_entry(&e.id, T0 + 1).is_err());

        assert_eq!(fs::read_to_string(&trashed).unwrap(), "x");
        let trashed_side = crate::comments::sidecar_path(Path::new(&trashed)).unwrap();
        assert_eq!(fs::read_to_string(trashed_side).unwrap(), "threads");
        assert!(!Path::new(&e.path).exists());
        assert!(!side.exists());
        assert_eq!(row(&stash, &e.id).unwrap(), (trashed, Some(T0), None));
    }

    #[test]
    fn restore_leaves_the_file_in_the_trash_when_the_notes_folder_refuses_it() {
        let (mut stash, _root) = stash_in("trash-restore-readonly");
        let e = note(&mut stash, "x");
        stash.delete_entry(&e.id, T0).unwrap();
        let (trashed, _, _) = row(&stash, &e.id).unwrap();
        let notes = stash.paths.notes_dir.clone();
        let result = {
            let _ro = ReadOnly::new(&notes);
            stash.restore_entry(&e.id, T0 + 1)
        };
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&trashed).unwrap(), "x");
        assert!(!Path::new(&e.path).exists());
        assert_eq!(row(&stash, &e.id).unwrap(), (trashed, Some(T0), None));
    }

    // ---- purge ----

    /// Points a row somewhere else, as a corrupt or tampered database would.
    fn repoint(stash: &Stash, id: &str, path: &Path) {
        stash
            .conn
            .execute(
                "UPDATE entries SET path = ?2 WHERE id = ?1",
                params![id, path.to_string_lossy()],
            )
            .unwrap();
    }

    #[test]
    fn purge_removes_the_file_the_row_and_the_tags() {
        let (mut stash, _root) = stash_in("trash-purge");
        let e = note(&mut stash, "x");
        stash.tag(&e.id, &["t".into()], &[]).unwrap();
        stash.delete_entry(&e.id, T0).unwrap();
        let (trashed, _, _) = row(&stash, &e.id).unwrap();

        stash.purge_entry(&e.id).unwrap();

        assert!(!Path::new(&trashed).exists());
        assert_eq!(row(&stash, &e.id), None);
        assert!(tags(&stash, &e.id).is_empty());
        assert!(stash.paths.trash_dir.is_dir(), "the trash folder itself stays");
    }

    #[test]
    fn purge_removes_the_sidecar_in_the_trash() {
        let (mut stash, _root) = stash_in("trash-purge-sidecar");
        let e = note(&mut stash, "x");
        fs::write(crate::comments::sidecar_path(Path::new(&e.path)).unwrap(), "t").unwrap();
        stash.delete_entry(&e.id, T0).unwrap();
        let (trashed, _, _) = row(&stash, &e.id).unwrap();
        stash.purge_entry(&e.id).unwrap();
        assert!(!crate::comments::sidecar_path(Path::new(&trashed)).unwrap().exists());
        assert!(names_in(&stash.paths.trash_dir).is_empty());
    }

    #[test]
    fn purge_refuses_a_live_note_and_a_file_ref() {
        let (mut stash, root) = stash_in("trash-purge-live");
        let e = note(&mut stash, "live");
        let (r, file) = file_ref(&mut stash, &root, "theirs.md", "theirs");
        assert!(stash.purge_entry(&e.id).is_err());
        assert!(stash.purge_entry(&r.id).is_err());
        assert_eq!(fs::read_to_string(&e.path).unwrap(), "live");
        assert_eq!(fs::read_to_string(&file).unwrap(), "theirs");
        assert!(row(&stash, &e.id).is_some() && row(&stash, &r.id).is_some());
    }

    #[test]
    fn purge_never_deletes_a_file_outside_the_trash() {
        let (mut stash, root) = stash_in("trash-purge-outside");
        let e = note(&mut stash, "x");
        stash.delete_entry(&e.id, T0).unwrap();
        let precious = root.join("precious.md");
        fs::write(&precious, "keep me").unwrap();

        repoint(&stash, &e.id, &precious);
        assert!(stash.purge_entry(&e.id).is_err());
        // A `..` path that only looks as if it were in the trash.
        let dotted = stash.paths.trash_dir.join("..").join("..").join("..").join("precious.md");
        assert_eq!(fs::canonicalize(&dotted).unwrap(), fs::canonicalize(&precious).unwrap());
        repoint(&stash, &e.id, &dotted);
        assert!(stash.purge_entry(&e.id).is_err());
        // A file in the notes folder, next to a live note.
        let live = note(&mut stash, "live");
        fs::write(format!("{}.x", live.path), "neighbour").unwrap();
        repoint(&stash, &e.id, &PathBuf::from(format!("{}.x", live.path)));
        assert!(stash.purge_entry(&e.id).is_err());

        assert_eq!(fs::read_to_string(&precious).unwrap(), "keep me");
        assert_eq!(fs::read_to_string(&live.path).unwrap(), "live");
        assert_eq!(fs::read_to_string(format!("{}.x", live.path)).unwrap(), "neighbour");
        assert!(row(&stash, &e.id).is_some());
    }

    #[test]
    fn purge_of_a_symlink_in_the_trash_leaves_its_target() {
        let (mut stash, root) = stash_in("trash-purge-symlink");
        let e = note(&mut stash, "x");
        stash.delete_entry(&e.id, T0).unwrap();
        let (trashed, _, _) = row(&stash, &e.id).unwrap();
        let precious = root.join("precious.md");
        fs::write(&precious, "keep me").unwrap();
        fs::remove_file(&trashed).unwrap();
        symlink(&precious, &trashed).unwrap();

        assert!(stash.purge_entry(&e.id).is_err());
        assert_eq!(fs::read_to_string(&precious).unwrap(), "keep me");
        assert!(fs::symlink_metadata(&trashed).unwrap().file_type().is_symlink());
        assert!(row(&stash, &e.id).is_some());
    }

    #[test]
    fn purge_of_a_directory_in_the_trash_is_refused() {
        let (mut stash, _root) = stash_in("trash-purge-dir");
        let e = note(&mut stash, "x");
        stash.delete_entry(&e.id, T0).unwrap();
        let (trashed, _, _) = row(&stash, &e.id).unwrap();
        fs::remove_file(&trashed).unwrap();
        fs::create_dir(&trashed).unwrap();
        fs::write(Path::new(&trashed).join("inner.md"), "keep me").unwrap();

        assert!(stash.purge_entry(&e.id).is_err());
        assert_eq!(
            fs::read_to_string(Path::new(&trashed).join("inner.md")).unwrap(),
            "keep me"
        );
        assert!(row(&stash, &e.id).is_some());
    }

    #[test]
    fn purge_through_a_symlinked_trash_folder_is_refused() {
        // `.trash` swapped for a symlink to a real folder after the delete:
        // the row still names `.trash/<name>`, which now resolves elsewhere.
        let (mut stash, root) = stash_in("trash-purge-symlinked-dir");
        let e = note(&mut stash, "x");
        stash.delete_entry(&e.id, T0).unwrap();
        let (trashed, _, _) = row(&stash, &e.id).unwrap();
        let trash = stash.paths.trash_dir.clone();
        let elsewhere = root.join("documents");
        fs::rename(&trash, &elsewhere).unwrap();
        symlink(&elsewhere, &trash).unwrap();
        assert!(fs::metadata(&trashed).unwrap().is_file());

        assert!(stash.purge_entry(&e.id).is_err());

        let name = Path::new(&trashed).file_name().unwrap();
        assert_eq!(fs::read_to_string(elsewhere.join(name)).unwrap(), "x");
        assert!(row(&stash, &e.id).is_some());
    }

    #[test]
    fn purge_of_a_note_whose_file_is_gone_removes_the_row() {
        let (mut stash, _root) = stash_in("trash-purge-gone");
        let e = note(&mut stash, "x");
        stash.delete_entry(&e.id, T0).unwrap();
        let (trashed, _, _) = row(&stash, &e.id).unwrap();
        fs::remove_file(&trashed).unwrap();
        stash.purge_entry(&e.id).unwrap();
        assert_eq!(row(&stash, &e.id), None);
    }

    #[test]
    fn purge_of_a_note_trashed_without_its_file_removes_only_the_row() {
        // Deleted while its file was already gone: the row still names the
        // notes folder, where a file of that name may appear again later.
        let (mut stash, _root) = stash_in("trash-purge-gone-live-path");
        let e = note(&mut stash, "x");
        fs::remove_file(&e.path).unwrap();
        stash.delete_entry(&e.id, T0).unwrap();
        fs::write(&e.path, "a new file under the old name").unwrap();

        assert!(stash.purge_entry(&e.id).is_err());
        assert_eq!(
            fs::read_to_string(&e.path).unwrap(),
            "a new file under the old name"
        );

        fs::remove_file(&e.path).unwrap();
        stash.purge_entry(&e.id).unwrap();
        assert_eq!(row(&stash, &e.id), None);
    }

    #[test]
    fn purge_expired_uses_a_thirty_day_cutoff() {
        let (state, root) = state_in("trash-purge-cutoff");
        let make = |text: &str| state.with(|s| s.create_note(text, None, T0, MSK)).unwrap();
        let young = make("young");
        let exact = make("exact");
        let old = make("old");
        let live = make("live");
        let (r, file) = state
            .with(|s| Ok(file_ref(s, &root, "ref.md", "ref")))
            .unwrap();
        let now = T0 + 100 * DAY;
        let del = |id: &str, at: i64| state.with(|s| s.delete_entry(id, at)).unwrap();
        del(&young.id, now - 30 * DAY + 1);
        del(&exact.id, now - 30 * DAY);
        del(&old.id, now - 31 * DAY);

        let report = purge_expired(&state, now);

        let mut purged = report.purged.clone();
        purged.sort();
        let mut want = vec![exact.id.clone(), old.id.clone()];
        want.sort();
        assert_eq!(purged, want);
        assert!(report.skipped.is_empty());
        let row_of = |id: &str| state.with(|s| Ok(row(s, id))).unwrap();
        assert!(row_of(&young.id).is_some());
        assert!(row_of(&live.id).is_some());
        assert_eq!(fs::read_to_string(&live.path).unwrap(), "live");
        assert!(row_of(&r.id).is_some());
        assert_eq!(fs::read_to_string(&file).unwrap(), "ref");
        assert_eq!(TRASH_RETENTION_MS, 30 * DAY);
    }

    #[test]
    fn purge_expired_skips_an_unsafe_row_and_goes_on() {
        let (state, root) = state_in("trash-purge-skip");
        let bad = state.with(|s| s.create_note("bad", None, T0, MSK)).unwrap();
        let good = state.with(|s| s.create_note("good", None, T0, MSK)).unwrap();
        state.with(|s| s.delete_entry(&bad.id, T0)).unwrap();
        state.with(|s| s.delete_entry(&good.id, T0 + 1)).unwrap();
        let precious = root.join("precious.md");
        fs::write(&precious, "keep me").unwrap();
        state
            .with(|s| {
                repoint(s, &bad.id, &precious);
                Ok(())
            })
            .unwrap();

        let report = purge_expired(&state, T0 + 31 * DAY);

        assert_eq!(report.purged, vec![good.id.clone()]);
        assert_eq!(report.skipped.len(), 1);
        assert_eq!(report.skipped[0].0, bad.id);
        assert_eq!(fs::read_to_string(&precious).unwrap(), "keep me");
        assert!(state.with(|s| Ok(row(s, &bad.id))).unwrap().is_some());
    }

    // ---- reconcile, due, and what the rest of the stash sees ----

    fn row_in(state: &StashState, id: &str) -> Option<(String, Option<i64>, Option<i64>)> {
        state.with(|s| Ok(row(s, id))).unwrap()
    }

    fn indexed_in(state: &StashState, id: &str) -> bool {
        state.with(|s| Ok(indexed(s, id))).unwrap()
    }

    #[test]
    fn reconcile_completes_a_delete_cut_after_the_rename() {
        let (state, _root) = state_in("trash-reconcile-del");
        let e = state.with(|s| s.create_note("# слово\n", None, T0, MSK)).unwrap();
        let trash = state.with(|s| Ok(s.paths.trash_dir.clone())).unwrap();
        fs::create_dir_all(&trash).unwrap();
        let name = PathBuf::from(&e.path).file_name().unwrap().to_owned();
        fs::rename(&e.path, trash.join(&name)).unwrap();

        let got = reconcile(&state, T0 + 9);

        assert_eq!(got.deleted, vec![e.id.clone()]);
        assert!(got.restored.is_empty());
        let (path, deleted_at, _) = row_in(&state, &e.id).unwrap();
        assert_eq!(
            PathBuf::from(&path),
            fs::canonicalize(&trash).unwrap().join(&name)
        );
        assert_eq!(deleted_at, Some(T0 + 9));
        assert!(!indexed_in(&state, &e.id));
        assert_eq!(fs::read_to_string(&path).unwrap(), "# слово\n");
    }

    #[test]
    fn reconcile_completes_a_restore_cut_after_the_rename() {
        let (state, _root) = state_in("trash-reconcile-restore");
        let e = state
            .with(|s| s.create_note("# вернулась\nслово\n", None, T0, MSK))
            .unwrap();
        state.with(|s| s.delete_entry(&e.id, T0)).unwrap();
        let (trashed, _, _) = row_in(&state, &e.id).unwrap();
        fs::rename(&trashed, &e.path).unwrap();

        let got = reconcile(&state, T0 + 9);

        assert_eq!(got.restored, vec![e.id.clone()]);
        assert!(got.deleted.is_empty());
        let (path, deleted_at, stashed_at) = row_in(&state, &e.id).unwrap();
        assert_eq!(path, e.path);
        assert_eq!(deleted_at, None);
        assert_eq!(stashed_at, Some(T0 + 9));
        assert!(indexed_in(&state, &e.id), "re-indexed off the lock");
    }

    #[test]
    fn reconcile_leaves_a_note_deleted_outside_couplet_alone() {
        let (state, _root) = state_in("trash-reconcile-gone");
        let e = state.with(|s| s.create_note("x", None, T0, MSK)).unwrap();
        fs::remove_file(&e.path).unwrap();
        assert_eq!(reconcile(&state, T0), Reconciled::default());
        assert_eq!(row_in(&state, &e.id).unwrap().1, None);
    }

    #[test]
    fn reconcile_leaves_a_name_another_row_holds_alone() {
        let (state, _root) = state_in("trash-reconcile-held");
        let a = state.with(|s| s.create_note("a", None, T0, MSK)).unwrap();
        let b = state.with(|s| s.create_note("b", None, T0, MSK)).unwrap();
        state.with(|s| s.delete_entry(&a.id, T0)).unwrap();
        let (trashed, _, _) = row_in(&state, &a.id).unwrap();
        // `a`'s trashed file is gone, and its old name in the notes folder is
        // `b`'s now — not `a`'s file coming back.
        fs::remove_file(&trashed).unwrap();
        fs::rename(&b.path, &a.path).unwrap();
        state
            .with(|s| {
                repoint(s, &b.id, Path::new(&a.path));
                Ok(())
            })
            .unwrap();

        assert_eq!(reconcile(&state, T0 + 1), Reconciled::default());

        assert_eq!(row_in(&state, &a.id).unwrap(), (trashed, Some(T0), None));
        assert_eq!(row_in(&state, &b.id).unwrap().0, a.path);
        assert_eq!(fs::read_to_string(&a.path).unwrap(), "b");
    }

    #[test]
    fn reconcile_never_marks_a_note_trashed_into_a_symlinked_trash_folder() {
        let (state, root) = state_in("trash-reconcile-symlinked");
        let e = state.with(|s| s.create_note("x", None, T0, MSK)).unwrap();
        let trash = state.with(|s| Ok(s.paths.trash_dir.clone())).unwrap();
        let elsewhere = root.join("documents");
        fs::create_dir_all(&elsewhere).unwrap();
        symlink(&elsewhere, &trash).unwrap();
        let name = PathBuf::from(&e.path).file_name().unwrap().to_owned();
        fs::rename(&e.path, elsewhere.join(&name)).unwrap();

        assert_eq!(reconcile(&state, T0 + 1), Reconciled::default());
        assert_eq!(row_in(&state, &e.id).unwrap(), (e.path.clone(), None, None));
    }

    #[test]
    fn reconcile_leaves_a_directory_on_the_other_side_alone() {
        let (state, _root) = state_in("trash-reconcile-dir");
        let e = state.with(|s| s.create_note("x", None, T0, MSK)).unwrap();
        let trash = state.with(|s| Ok(s.paths.trash_dir.clone())).unwrap();
        let name = PathBuf::from(&e.path).file_name().unwrap().to_owned();
        fs::create_dir_all(trash.join(&name)).unwrap();
        fs::remove_file(&e.path).unwrap();

        assert_eq!(reconcile(&state, T0 + 1), Reconciled::default());
        assert_eq!(row_in(&state, &e.id).unwrap().1, None);
    }

    #[test]
    fn due_runs_first_then_after_a_day_or_a_clock_jump_back() {
        assert!(due(None, T0));
        assert!(!due(Some(T0), T0));
        assert!(!due(Some(T0), T0 + DAY - 1));
        assert!(due(Some(T0), T0 + DAY));
        assert!(due(Some(T0), T0 - 1));
    }

    #[test]
    fn a_trashed_note_cannot_be_tagged_or_put_away() {
        let (mut stash, _root) = stash_in("trash-guards");
        let e = note(&mut stash, "x");
        stash.delete_entry(&e.id, T0).unwrap();
        let (trashed, _, _) = row(&stash, &e.id).unwrap();
        assert!(stash.tag(&e.id, &["t".into()], &[]).is_err());
        let req = PutAway {
            paths: vec![trashed.clone()],
            ..Default::default()
        };
        assert!(stash.put_away(&req, T0 + 1).is_err());
        assert_eq!(row(&stash, &e.id).unwrap(), (trashed, Some(T0), None));
        assert!(tags(&stash, &e.id).is_empty());
    }

    #[test]
    fn a_write_to_a_trashed_file_does_not_touch_its_row() {
        let (mut stash, _root) = stash_in("trash-guard-hook");
        let e = note(&mut stash, "x");
        stash.delete_entry(&e.id, T0).unwrap();
        let (trashed, _, _) = row(&stash, &e.id).unwrap();
        let before = stash.get(&e.id).unwrap();

        let written = stash.file_written(&trashed, Some("new"), T0 + DAY).unwrap();

        assert_eq!(written, crate::stash::entries::Written::default());
        assert_eq!(stash.get(&e.id).unwrap(), before);
        assert!(!stash.reindex_written(&trashed, "# new\n", before.modified_at).unwrap());
        assert!(!indexed(&stash, &e.id));
    }

    #[test]
    fn list_counts_and_search_see_the_trash_the_way_the_ui_needs() {
        let (mut stash, _root) = stash_in("trash-contract");
        let a = note(&mut stash, "# альфа тайник\n");
        let b = note(&mut stash, "# бета тайник\n");
        let c = note(&mut stash, "# гамма\n");
        stash.delete_entry(&a.id, T0 + 1).unwrap();
        stash.delete_entry(&b.id, T0 + 2).unwrap();

        let ids = |r: crate::stash::ListResult| {
            r.entries.into_iter().map(|e| e.id).collect::<Vec<_>>()
        };
        let live = stash.list(&crate::stash::ListQuery::default()).unwrap();
        assert_eq!(ids(live), vec![c.id.clone()]);

        // Newest deletion first, whatever `sort` says. (The UI never passes `repo` here.)
        let trash = stash
            .list(&crate::stash::ListQuery {
                deleted: true,
                sort: crate::stash::ListSort::Kind,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(ids(trash), vec![b.id.clone(), a.id.clone()]);

        assert_eq!(stash.counts(Some("any-repo"), 0).unwrap().deleted, 2);

        for q in ["та", "тайник", "альфа"] {
            let hits = crate::stash::search::found(&stash.conn, q);
            assert!(hits.is_empty(), "{q}: trashed notes must not be found: {hits:?}");
        }
        assert_eq!(crate::stash::search::found(&stash.conn, "гамма"), vec![c.id.clone()]);

        // And back: restored, it is found again.
        stash.restore_entry(&a.id, T0 + 3).unwrap();
        assert_eq!(crate::stash::search::found(&stash.conn, "та"), vec![a.id.clone()]);
    }

    // ---- the delete flow, drop requests, housekeeping ----

    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeEnv {
        file: bool,
        deleted: bool,
        /// Popped front on each `owner()` call.
        owners: RefCell<Vec<Option<Owner>>>,
        reply: Option<DropReply>,
        log: RefCell<Vec<String>>,
    }

    fn owner(label: &str, number: u32) -> Option<Owner> {
        Some(Owner {
            label: label.into(),
            number: Some(number),
        })
    }

    fn pop(q: &RefCell<Vec<Option<Owner>>>) -> Option<Owner> {
        let mut q = q.borrow_mut();
        if q.is_empty() {
            None
        } else {
            q.remove(0)
        }
    }

    impl DeleteEnv for FakeEnv {
        fn entry(&self, _id: &str) -> Result<(StashKind, bool, String), String> {
            self.log.borrow_mut().push("entry".into());
            let kind = if self.file { StashKind::File } else { StashKind::Note };
            Ok((kind, self.deleted, "/notes/a.md".into()))
        }
        fn owner(&self, _path: &str) -> Option<Owner> {
            self.log.borrow_mut().push("owner".into());
            pop(&self.owners)
        }
        fn ask_to_drop(&self, o: &Owner, _path: &str) -> DropReply {
            self.log.borrow_mut().push(format!("ask:{}", o.label));
            self.reply.clone().unwrap_or(DropReply::Timeout)
        }
        fn trash(&self, _id: &str) -> Result<Deleted, String> {
            self.log.borrow_mut().push("trash".into());
            Ok(if self.file { Deleted::Removed } else { Deleted::Trashed })
        }
    }

    fn logged(env: &FakeEnv) -> Vec<String> {
        env.log.borrow().clone()
    }

    #[test]
    fn a_note_in_no_tab_is_trashed_at_once() {
        let env = FakeEnv::default();
        assert_eq!(delete_flow(&env, "id").unwrap(), FlowOutcome::Done(Deleted::Trashed));
        assert_eq!(logged(&env), vec!["entry", "owner", "trash"]);
    }

    #[test]
    fn a_note_open_in_a_tab_is_dropped_there_first_and_only_then_moved() {
        let env = FakeEnv {
            owners: RefCell::new(vec![owner("editor-2", 2), None]),
            reply: Some(DropReply::Dropped),
            ..Default::default()
        };
        assert_eq!(delete_flow(&env, "id").unwrap(), FlowOutcome::Done(Deleted::Trashed));
        assert_eq!(logged(&env), vec!["entry", "owner", "ask:editor-2", "owner", "trash"]);
    }

    #[test]
    fn a_tab_whose_save_has_not_landed_keeps_the_note() {
        let env = FakeEnv {
            owners: RefCell::new(vec![owner("main", 1)]),
            reply: Some(DropReply::Refused),
            ..Default::default()
        };
        assert_eq!(
            delete_flow(&env, "id").unwrap(),
            FlowOutcome::Kept {
                reason: KeptReason::Unsaved,
                owner: owner("main", 1).unwrap()
            }
        );
        assert!(!logged(&env).contains(&"trash".to_string()));
    }

    #[test]
    fn a_window_that_does_not_answer_keeps_the_note() {
        let env = FakeEnv {
            owners: RefCell::new(vec![owner("editor-3", 3)]),
            reply: Some(DropReply::Timeout),
            ..Default::default()
        };
        assert_eq!(
            delete_flow(&env, "id").unwrap(),
            FlowOutcome::Kept {
                reason: KeptReason::Timeout,
                owner: owner("editor-3", 3).unwrap()
            }
        );
        assert!(!logged(&env).contains(&"trash".to_string()));
    }

    #[test]
    fn a_note_reopened_between_the_drop_and_the_move_is_kept() {
        let env = FakeEnv {
            owners: RefCell::new(vec![owner("main", 1), owner("editor-4", 4)]),
            reply: Some(DropReply::Dropped),
            ..Default::default()
        };
        assert_eq!(
            delete_flow(&env, "id").unwrap(),
            FlowOutcome::Kept {
                reason: KeptReason::Open,
                owner: owner("editor-4", 4).unwrap()
            }
        );
        assert!(!logged(&env).contains(&"trash".to_string()));
    }

    #[test]
    fn a_file_ref_is_removed_without_asking_any_tab() {
        let env = FakeEnv {
            file: true,
            owners: RefCell::new(vec![owner("main", 1)]),
            ..Default::default()
        };
        assert_eq!(delete_flow(&env, "id").unwrap(), FlowOutcome::Done(Deleted::Removed));
        assert_eq!(logged(&env), vec!["entry", "trash"]);
    }

    #[test]
    fn an_already_trashed_note_is_not_asked_about() {
        let env = FakeEnv {
            deleted: true,
            owners: RefCell::new(vec![owner("main", 1)]),
            ..Default::default()
        };
        assert_eq!(delete_flow(&env, "id").unwrap(), FlowOutcome::Done(Deleted::Trashed));
        assert_eq!(logged(&env), vec!["entry", "trash"]);
    }

    #[test]
    fn an_unknown_entry_asks_nobody_and_moves_nothing() {
        struct Missing;
        impl DeleteEnv for Missing {
            fn entry(&self, id: &str) -> Result<(StashKind, bool, String), String> {
                Err(format!("no stash entry {id}"))
            }
            fn owner(&self, _: &str) -> Option<Owner> {
                panic!("asked for an owner")
            }
            fn ask_to_drop(&self, _: &Owner, _: &str) -> DropReply {
                panic!("asked a window")
            }
            fn trash(&self, _: &str) -> Result<Deleted, String> {
                panic!("trashed")
            }
        }
        assert!(delete_flow(&Missing, "nope").is_err());
    }

    /// The real `delete_flow` over a real stash: the file moves only when
    /// the flow says so, and a kept note is exactly where it was.
    struct StashEnv<'a> {
        state: &'a StashState,
        owners: RefCell<Vec<Option<Owner>>>,
        reply: DropReply,
    }

    impl DeleteEnv for StashEnv<'_> {
        fn entry(&self, id: &str) -> Result<(StashKind, bool, String), String> {
            let e = self.state.with(|s| s.get(id))?;
            Ok((e.kind, e.deleted_at.is_some(), e.path))
        }
        fn owner(&self, _: &str) -> Option<Owner> {
            pop(&self.owners)
        }
        fn ask_to_drop(&self, _: &Owner, _: &str) -> DropReply {
            self.reply.clone()
        }
        fn trash(&self, id: &str) -> Result<Deleted, String> {
            self.state.with(|s| s.delete_entry(id, T0 + 1))
        }
    }

    #[test]
    fn a_kept_note_stays_in_place_byte_for_byte_and_indexed() {
        for (reply, owners) in [
            (DropReply::Refused, vec![owner("main", 1)]),
            (DropReply::Timeout, vec![owner("main", 1)]),
            (DropReply::Dropped, vec![owner("main", 1), owner("editor-2", 2)]),
        ] {
            let (state, _root) = state_in("trash-flow-kept");
            let e = state
                .with(|s| s.create_note("# Держись\nслово\n", None, T0, MSK))
                .unwrap();
            let env = StashEnv {
                state: &state,
                owners: RefCell::new(owners),
                reply: reply.clone(),
            };
            let got = delete_flow(&env, &e.id).unwrap();
            assert!(matches!(got, FlowOutcome::Kept { .. }), "{reply:?}: {got:?}");
            assert_eq!(fs::read_to_string(&e.path).unwrap(), "# Держись\nслово\n");
            assert_eq!(row_in(&state, &e.id).unwrap(), (e.path.clone(), None, None));
            assert!(indexed_in(&state, &e.id));
        }
    }

    #[test]
    fn a_dropped_note_moves_into_the_trash() {
        let (state, _root) = state_in("trash-flow-dropped");
        let e = state.with(|s| s.create_note("# Уходи\n", None, T0, MSK)).unwrap();
        let env = StashEnv {
            state: &state,
            owners: RefCell::new(vec![owner("editor-2", 2), None]),
            reply: DropReply::Dropped,
        };
        assert_eq!(delete_flow(&env, &e.id).unwrap(), FlowOutcome::Done(Deleted::Trashed));
        let (path, deleted_at, _) = row_in(&state, &e.id).unwrap();
        assert_eq!(deleted_at, Some(T0 + 1));
        assert!(!Path::new(&e.path).exists());
        assert_eq!(fs::read_to_string(&path).unwrap(), "# Уходи\n");
    }

    #[test]
    fn an_open_file_ref_is_removed_and_its_file_left_alone() {
        let (state, root) = state_in("trash-flow-ref");
        let (r, file) = state
            .with(|s| Ok(file_ref(s, &root, "doc.md", "мой файл")))
            .unwrap();
        let env = StashEnv {
            state: &state,
            owners: RefCell::new(vec![owner("main", 1)]),
            reply: DropReply::Timeout,
        };
        assert_eq!(delete_flow(&env, &r.id).unwrap(), FlowOutcome::Done(Deleted::Removed));
        assert_eq!(row_in(&state, &r.id), None);
        assert_eq!(fs::read_to_string(&file).unwrap(), "мой файл");
    }

    #[test]
    fn the_owner_is_the_live_window_holding_the_path_with_its_number() {
        let mut reg = crate::tabs::TabRegistry::new();
        assert!(reg.add_tab("editor-2", "t2", Some("/n/a.md".into())));
        reg.set_number("editor-2", Some(2));
        assert!(reg.add_tab("gone", "t9", Some("/n/b.md".into())));
        let live = |l: &str| l != "gone";
        assert_eq!(live_owner(&reg, "/n/a.md", live), owner("editor-2", 2));
        assert_eq!(live_owner(&reg, "/n/b.md", live), None, "a dead window holds nothing");
        assert_eq!(live_owner(&reg, "/n/c.md", live), None);
    }

    #[test]
    fn drop_requests_accept_an_answer_only_from_the_window_asked() {
        let reqs = DropRequests::default();
        let (id, rx) = reqs.register("editor-2");
        assert!(!reqs.answer("main", id, true));
        assert!(reqs.answer("editor-2", id, true));
        assert!(rx.recv_timeout(std::time::Duration::from_millis(50)).unwrap());
        assert!(!reqs.answer("editor-2", id, true), "answered twice");
        let (id2, _rx2) = reqs.register("main");
        reqs.abandon(id2);
        assert!(!reqs.answer("main", id2, false));
    }

    #[test]
    fn drop_requests_get_distinct_ids() {
        let reqs = DropRequests::default();
        let (a, _ra) = reqs.register("main");
        let (b, _rb) = reqs.register("main");
        assert_ne!(a, b);
    }

    #[test]
    fn a_housekeeping_pass_reconciles_purges_and_writes_the_export_once() {
        let (state, root) = state_in("trash-housekeeping");
        let old = state.with(|s| s.create_note("old", None, T0, MSK)).unwrap();
        let cut = state.with(|s| s.create_note("cut", None, T0, MSK)).unwrap();
        let bad = state.with(|s| s.create_note("bad", None, T0, MSK)).unwrap();
        state.with(|s| s.delete_entry(&old.id, T0)).unwrap();
        state.with(|s| s.delete_entry(&bad.id, T0)).unwrap();
        let precious = root.join("precious.md");
        fs::write(&precious, "keep me").unwrap();
        state
            .with(|s| {
                repoint(s, &bad.id, &precious);
                Ok(())
            })
            .unwrap();
        // A delete cut between the rename and the transaction.
        let trash = state.with(|s| Ok(s.paths.trash_dir.clone())).unwrap();
        let name = PathBuf::from(&cut.path).file_name().unwrap().to_owned();
        fs::rename(&cut.path, trash.join(&name)).unwrap();
        let export = state.with(|s| Ok(s.paths.export_path.clone())).unwrap();
        assert!(!export.exists());

        let done = housekeeping_pass(&state, T0 + 31 * DAY);

        assert!(done.changed());
        assert_eq!(done.reconciled.deleted, vec![cut.id.clone()]);
        assert!(done.reconciled.restored.is_empty());
        assert_eq!(done.purged.purged, vec![old.id.clone()]);
        assert_eq!(done.purged.skipped.len(), 1);
        assert_eq!(fs::read_to_string(&precious).unwrap(), "keep me");
        assert!(export.exists(), "one after_write for the pass");
    }

    #[test]
    fn a_housekeeping_pass_with_nothing_to_do_writes_nothing() {
        let (state, _root) = state_in("trash-housekeeping-idle");
        state.with(|s| s.create_note("live", None, T0, MSK)).unwrap();
        let export = state.with(|s| Ok(s.paths.export_path.clone())).unwrap();

        let done = housekeeping_pass(&state, T0 + DAY);

        assert!(!done.changed());
        assert!(!export.exists());
    }

    // ---- Save As from a note (A14, stash-questions Q3) ----

    fn nobody_holds(_: &str) -> bool {
        false
    }

    /// `path` spelled through `link -> target`, where `path` lies under `target`.
    fn spelled_via(path: &str, target: &Path, link: &Path) -> PathBuf {
        let target = crate::path_norm::normalize_str(&target.to_string_lossy());
        link.join(Path::new(path).strip_prefix(&target).unwrap())
    }

    fn live_row(state: &StashState, id: &str) -> (String, Option<i64>, Option<i64>) {
        state.with(|s| Ok(row(s, id))).unwrap().unwrap()
    }

    #[test]
    fn a_note_saved_as_elsewhere_goes_into_the_trash_and_the_new_file_stays() {
        let (state, root) = state_in("trash-saved-as");
        let text = "# План\nтайное слово\n";
        let e = state.with(|s| s.create_note(text, None, T0, MSK)).unwrap();
        state.with(|s| s.tag(&e.id, &["work".to_string()], &[])).unwrap();
        let side = crate::comments::sidecar_path(Path::new(&e.path)).unwrap();
        fs::write(&side, "threads").unwrap();
        let new = user_file(&root, "plans/План.md", text);

        let moved = note_saved_as(&state, &e.path, &new, nobody_holds, T0 + 5).unwrap();

        assert_eq!(moved, Some(e.id.clone()));
        let (trashed, deleted_at, _) = live_row(&state, &e.id);
        assert_eq!(deleted_at, Some(T0 + 5));
        let trash = state.with(|s| Ok(s.paths.trash_dir.clone())).unwrap();
        assert_eq!(Path::new(&trashed).parent().unwrap(), trash);
        assert_eq!(fs::read(&trashed).unwrap(), text.as_bytes());
        assert!(!Path::new(&e.path).exists());
        let trashed_side = crate::comments::sidecar_path(Path::new(&trashed)).unwrap();
        assert_eq!(fs::read_to_string(trashed_side).unwrap(), "threads");
        assert!(!state.with(|s| Ok(indexed(s, &e.id))).unwrap());
        assert_eq!(state.with(|s| Ok(tags(s, &e.id))).unwrap(), vec!["work".to_string()]);
        assert_eq!(fs::read_to_string(&new).unwrap(), text);
        let export = state.with(|s| Ok(s.paths.export_path.clone())).unwrap();
        assert!(export.exists(), "after_write ran");
    }

    #[test]
    fn a_note_whose_saved_copy_differs_stays_in_the_stash() {
        let (state, root) = state_in("trash-saved-as-differs");
        let e = state.with(|s| s.create_note("первое", None, T0, MSK)).unwrap();
        let new = user_file(&root, "copy.md", "первое и ещё");
        let before = live_row(&state, &e.id);

        assert_eq!(note_saved_as(&state, &e.path, &new, nobody_holds, T0 + 5).unwrap(), None);

        assert_eq!(live_row(&state, &e.id), before);
        assert_eq!(fs::read_to_string(&e.path).unwrap(), "первое");
        assert!(state.with(|s| Ok(indexed(s, &e.id))).unwrap());
        assert_eq!(fs::read_to_string(&new).unwrap(), "первое и ещё");
        let export = state.with(|s| Ok(s.paths.export_path.clone())).unwrap();
        assert!(!export.exists());
    }

    #[test]
    fn a_note_whose_saved_copy_cannot_be_read_stays_in_the_stash() {
        let (state, root) = state_in("trash-saved-as-unreadable");
        let e = state.with(|s| s.create_note("x", None, T0, MSK)).unwrap();
        let before = live_row(&state, &e.id);
        let missing = root.join("work").join("gone.md");
        let dir = root.join("work").join("a-dir.md");
        fs::create_dir_all(&dir).unwrap();

        for new in [&missing, &dir] {
            let new = new.to_string_lossy();
            assert_eq!(note_saved_as(&state, &e.path, &new, nobody_holds, T0 + 5).unwrap(), None);
        }

        assert_eq!(live_row(&state, &e.id), before);
        assert_eq!(fs::read_to_string(&e.path).unwrap(), "x");
    }

    #[test]
    fn a_file_reference_saved_as_is_left_alone() {
        let (state, root) = state_in("trash-saved-as-file-ref");
        let (fref, path) = state.with(|s| Ok(file_ref(s, &root, "a.md", "text"))).unwrap();
        let new = user_file(&root, "b.md", "text");
        let before = live_row(&state, &fref.id);

        let old = path.to_string_lossy();
        assert_eq!(note_saved_as(&state, &old, &new, nobody_holds, T0 + 5).unwrap(), None);

        assert_eq!(live_row(&state, &fref.id), before);
        assert_eq!(fs::read_to_string(&path).unwrap(), "text");
    }

    #[test]
    fn a_trashed_note_is_left_alone() {
        let (state, root) = state_in("trash-saved-as-trashed");
        let e = state.with(|s| s.create_note("x", None, T0, MSK)).unwrap();
        state.with(|s| s.delete_entry(&e.id, T0 + 1)).unwrap();
        let before = live_row(&state, &e.id);
        let new = user_file(&root, "x.md", "x");

        // By its old name (no row names it now) and by its trash path.
        for old in [e.path.clone(), before.0.clone()] {
            assert_eq!(note_saved_as(&state, &old, &new, nobody_holds, T0 + 5).unwrap(), None);
        }

        assert_eq!(live_row(&state, &e.id), before);
        assert_eq!(fs::read_to_string(&before.0).unwrap(), "x");
    }

    #[test]
    fn a_note_a_tab_still_holds_is_left_alone() {
        let (state, root) = state_in("trash-saved-as-held");
        let e = state.with(|s| s.create_note("x", None, T0, MSK)).unwrap();
        let new = user_file(&root, "x.md", "x");
        let before = live_row(&state, &e.id);
        let held = e.path.clone();

        let moved = note_saved_as(&state, &e.path, &new, |p| p == held, T0 + 5).unwrap();

        assert_eq!(moved, None);
        assert_eq!(live_row(&state, &e.id), before);
        assert_eq!(fs::read_to_string(&e.path).unwrap(), "x");
    }

    #[test]
    fn save_as_onto_the_note_itself_is_left_alone() {
        let (state, root) = state_in("trash-saved-as-same");
        let e = state.with(|s| s.create_note("x", None, T0, MSK)).unwrap();
        let before = live_row(&state, &e.id);
        let alias = root.join("alias");
        symlink(root.join("home"), &alias).unwrap();
        let other_spelling = spelled_via(&e.path, &root.join("home"), &alias);

        for new in [PathBuf::from(&e.path), other_spelling] {
            let new = new.to_string_lossy();
            assert_eq!(note_saved_as(&state, &e.path, &new, nobody_holds, T0 + 5).unwrap(), None);
        }

        assert_eq!(live_row(&state, &e.id), before);
        assert_eq!(fs::read_to_string(&e.path).unwrap(), "x");
    }

    #[test]
    fn save_as_paths_are_normalized_before_anything_is_looked_up() {
        let (state, root) = state_in("trash-saved-as-spelling");
        let e = state.with(|s| s.create_note("x", None, T0, MSK)).unwrap();
        let new = user_file(&root, "x.md", "x");
        let (home_alias, work_alias) = (root.join("h"), root.join("w"));
        symlink(root.join("home"), &home_alias).unwrap();
        symlink(root.join("work"), &work_alias).unwrap();
        let old = spelled_via(&e.path, &root.join("home"), &home_alias);
        let new_spelled = spelled_via(&new, &root.join("work"), &work_alias);
        assert_ne!(old.to_string_lossy(), e.path);
        // The owner check sees the registry's spelling, not the caller's.
        let asked = std::cell::RefCell::new(Vec::new());

        let moved = note_saved_as(
            &state,
            &old.to_string_lossy(),
            &new_spelled.to_string_lossy(),
            |p| {
                asked.borrow_mut().push(p.to_string());
                false
            },
            T0 + 5,
        )
        .unwrap();

        assert_eq!(moved, Some(e.id.clone()));
        assert_eq!(asked.into_inner(), vec![e.path.clone()]);
        assert!(!Path::new(&e.path).exists());
        assert_eq!(fs::read_to_string(&new).unwrap(), "x");
    }

    #[test]
    fn a_saved_as_note_whose_row_cannot_be_updated_is_back_at_its_name() {
        let (state, root) = state_in("trash-saved-as-rollback");
        let e = state.with(|s| s.create_note("x", None, T0, MSK)).unwrap();
        let new = user_file(&root, "x.md", "x");
        state.with(|s| {
            fail_next_update(s);
            Ok(())
        })
        .unwrap();

        assert!(note_saved_as(&state, &e.path, &new, nobody_holds, T0 + 5).is_err());

        assert_eq!(fs::read_to_string(&e.path).unwrap(), "x");
        assert_eq!(live_row(&state, &e.id).1, None);
        assert!(state.with(|s| Ok(indexed(s, &e.id))).unwrap());
        let trash = state.with(|s| Ok(s.paths.trash_dir.clone())).unwrap();
        assert!(names_in(&trash).is_empty());
    }

    #[test]
    fn trash_saved_note_changes_nothing_once_the_row_names_another_path() {
        let (mut stash, _root) = stash_in("trash-saved-as-guard");
        let e = note(&mut stash, "x");

        assert!(!stash.trash_saved_note(&e.id, "/elsewhere/x.md", T0).unwrap());

        assert_eq!(row(&stash, &e.id).unwrap().1, None);
        assert_eq!(fs::read_to_string(&e.path).unwrap(), "x");
    }
}
