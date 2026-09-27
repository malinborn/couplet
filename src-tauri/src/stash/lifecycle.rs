//! What leaving the tabs means for the stash (stash plan 03, D5-D8). Decided
//! here, from the database, never from a frontend's cache: `tab_close` (⌘W,
//! ⌃T, `/stash`, an agent's close, an expired quick look), a window's red
//! button and a quit all come through `documents_left`.
//!
//! Lock discipline (I3, A11): the stash lock covers SQL only. Each document
//! goes lookup (SQL) → the user's disk (unlocked) → write (SQL); the caller
//! runs all of it off the main thread with no other lock held — except a
//! quit, which runs it on the main thread because the process is ending.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::session::{Session, SessionState, WindowSnapshot};
use crate::tabs::WindowTabs;

use super::entries::{kind_of_new, plan_put_away};
use super::{clock, db, emit_changed, PutAway, Stash, StashKind, StashState};

/// How a document left the tabs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Leaving {
    /// ⌘W and every close that goes its way. The frontend flushed first.
    Closed,
    /// ⌃T / `/stash` / File → «Отложить в тайник»: `Closed`, and a file
    /// becomes a reference.
    PutAway,
    /// The red button or a quit (D8): nothing was flushed, so a note is put
    /// away but never discarded (D6), and a file is left as it is.
    WithWindow,
}

/// What the stash did with a document that left. The id is the entry's.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Left {
    Untouched,
    PutAway(String),
    Discarded(String),
}

/// A blank note is tiny; anything bigger is not read to find out.
const BLANK_READ_LIMIT: u64 = 64 * 1024;

/// What `remove_if_blank` did.
#[derive(Debug, PartialEq, Eq)]
enum Blank {
    /// It was blank, and it is gone.
    Removed,
    /// It is at its name with whatever text it holds: not blank, not provably
    /// blank, or a newer save took the name back meanwhile.
    Stays,
    /// Text reached the file while it was set aside, and a newer save took its
    /// name meanwhile: the set-aside text is kept at this path (a visible name
    /// in the same folder), the newer save at the note's own name.
    Recovered(PathBuf),
}

/// Whether the regular file at `path` — never through a symlink — holds only
/// whitespace, read through one handle. Anything that cannot prove it
/// (missing, a symlink, not UTF-8, unreadable, large) is not blank.
fn holds_only_whitespace(path: &Path) -> bool {
    if !fs::symlink_metadata(path).is_ok_and(|m| m.is_file()) {
        return false;
    }
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    if !file
        .metadata()
        .is_ok_and(|m| m.is_file() && m.len() <= BLANK_READ_LIMIT)
    {
        return false;
    }
    let mut bytes = Vec::new();
    file.take(BLANK_READ_LIMIT + 1)
        .read_to_end(&mut bytes)
        .is_ok()
        && bytes.len() as u64 <= BLANK_READ_LIMIT
        && std::str::from_utf8(&bytes).is_ok_and(|t| t.trim().is_empty())
}

/// Tells one process's asides apart.
static ASIDE_SEQ: AtomicU64 = AtomicU64::new(0);

/// A hidden name beside `path` (same folder, so the rename stays on one
/// volume) that no save and no other close uses.
fn aside_name(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_str()?;
    let n = ASIDE_SEQ.fetch_add(1, Ordering::Relaxed);
    Some(path.with_file_name(format!(".{name}.discard-{}-{n}", std::process::id())))
}

/// Removes `path` if it is a regular file holding only whitespace. See
/// `remove_if_blank_with`.
fn remove_if_blank(path: &Path, now_secs: u64) -> Blank {
    remove_if_blank_with(path, now_secs, || {})
}

/// `remove_if_blank`; `between` runs after the first look and before the file
/// is set aside — where a save racing the close lands (tests).
///
/// Check-then-unlink would delete whatever an atomic save (tmp + rename) put
/// at the name after the check. So a file that looks blank is first renamed
/// aside — from then on no save can reach it — re-read there, and unlinked
/// only if it is still blank; otherwise it goes back (`settle_aside`). Never
/// loses text: at every moment the text is at the name or at the aside.
fn remove_if_blank_with(path: &Path, now_secs: u64, between: impl FnOnce()) -> Blank {
    if !holds_only_whitespace(path) {
        return Blank::Stays;
    }
    between();
    let Some(aside) = aside_name(path) else {
        return Blank::Stays;
    };
    // A name taken by something else is never renamed over.
    if fs::symlink_metadata(&aside).is_ok() || fs::rename(path, &aside).is_err() {
        return Blank::Stays;
    }
    settle_aside(&aside, path, now_secs)
}

/// Decides what happens to a file set aside from `path`: unlinked if it is
/// still blank, else put back. `hard_link` refuses an existing name, so the
/// put-back never overwrites a save that landed at `path` meanwhile; that
/// text stays at `path` and the aside's is kept under
/// `<stem>.recovered-<secs>.md` (numbered when taken).
fn settle_aside(aside: &Path, path: &Path, now_secs: u64) -> Blank {
    if holds_only_whitespace(aside) {
        if fs::symlink_metadata(path).is_ok() {
            // A newer save is at the name: that is the note now. The aside
            // held only whitespace.
            let _ = fs::remove_file(aside);
            return Blank::Stays;
        }
        // Unlinked, not trashed: a trash copy of whitespace keeps nothing,
        // and the spec wants an empty document to vanish without a trace.
        // (A save landing after this is a file with no entry — text on disk,
        // never lost.)
        if fs::remove_file(aside).is_ok() {
            return Blank::Removed;
        }
    }
    if fs::hard_link(aside, path).is_ok() {
        let _ = fs::remove_file(aside);
        return Blank::Stays;
    }
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("note");
    for n in 0..100u32 {
        let name = match n {
            0 => format!("{stem}.recovered-{now_secs}.md"),
            n => format!("{stem}.recovered-{now_secs}-{n}.md"),
        };
        let kept = path.with_file_name(name);
        match fs::hard_link(aside, &kept) {
            Ok(()) => {
                let _ = fs::remove_file(aside);
                return Blank::Recovered(kept);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => break,
        }
    }
    // Could not name it anywhere else: the text stays at the aside, intact.
    Blank::Recovered(aside.to_path_buf())
}

impl Stash {
    /// Drops the row of a note whose blank file `lifecycle` already removed.
    /// A row trashed meanwhile is left alone (A8). Tags go with it (cascade).
    fn forget_discarded_note(&mut self, id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM entries WHERE id = ?1 AND kind = 'note' AND deleted_at IS NULL",
                [id],
            )
            .map_err(db::err)?;
        Ok(())
    }
}

/// One document left the tabs at `cursor` / `top_line`.
///
/// A live note is put away — or, a note whose file holds only whitespace,
/// discarded (spec: «пустой документ при закрытии просто исчезает»; D6: only
/// here, after the frontend flushed). Discarding deletes no user text: the
/// file is re-read just before it goes and is blank. Only a couplet-named file
/// directly in the notes folder is ever removed, and the file goes before the
/// row, so a file that will not go keeps its entry and is put away instead.
/// A file enters the stash only on `PutAway`; a trashed entry is never
/// touched (A8). `WithWindow` only ever puts a live note away.
pub(crate) fn document_left(
    state: &StashState,
    path: &str,
    cursor: usize,
    top_line: usize,
    leaving: Leaving,
    now: i64,
) -> Result<Left, String> {
    let (entry, notes_dir) =
        state.with(|s| Ok((s.entry_for_path(path)?, s.notes_dir_spelling())))?;
    match &entry {
        Some(e) if e.deleted_at.is_some() => {
            return match leaving {
                Leaving::Closed | Leaving::WithWindow => Ok(Left::Untouched),
                Leaving::PutAway => Err(format!("in the trash: {path}")),
            };
        }
        // The red button and ⌘Q leave the last ≤300 ms of typing unflushed:
        // a blank file is no proof of a blank buffer (D6).
        Some(e) if e.kind == StashKind::Note && leaving == Leaving::WithWindow => {}
        Some(e) if e.kind == StashKind::Note => {
            let is_note_file = kind_of_new(Path::new(path), &notes_dir) == StashKind::Note;
            let now_secs = u64::try_from(now.div_euclid(1000)).unwrap_or(0);
            let blank = if is_note_file {
                remove_if_blank(Path::new(path), now_secs)
            } else {
                Blank::Stays
            };
            if let Blank::Recovered(kept) = &blank {
                eprintln!(
                    "stash: {path} changed while it was being discarded; its earlier text is kept at {}",
                    kept.display()
                );
            }
            if blank == Blank::Removed {
                let id = e.id.clone();
                state.with(|s| s.forget_discarded_note(&id))?;
                return Ok(Left::Discarded(id));
            }
        }
        _ if leaving != Leaving::PutAway => return Ok(Left::Untouched),
        _ => {}
    }
    let req = PutAway {
        paths: vec![path.to_string()],
        caret: i64::try_from(cursor).ok(),
        top_line: i64::try_from(top_line).ok(),
        tags: Vec::new(),
    };
    // Metadata, a title, a `.git` walk: the user's disk, unlocked.
    let plan = plan_put_away(&req, &notes_dir, now)?;
    let results = state.with(|s| s.put_away_probed(plan, now))?;
    results
        .into_iter()
        .next()
        .map(|r| Left::PutAway(r.entry.id))
        .ok_or_else(|| format!("nothing put away for {path}"))
}

/// `document_left` for each of `docs`, best effort: a stash that cannot be
/// written never fails a close. Blocking. Answers the ids it changed, after
/// one export/backup for all of them.
pub(crate) fn documents_left_in(
    state: &StashState,
    docs: &[(String, usize, usize)],
    leaving: Leaving,
    now: i64,
) -> Vec<String> {
    let mut ids = Vec::new();
    for (path, cursor, top_line) in docs {
        match document_left(state, path, *cursor, *top_line, leaving, now) {
            Ok(Left::Untouched) => {}
            Ok(Left::PutAway(id) | Left::Discarded(id)) => ids.push(id),
            Err(e) => eprintln!("stash: {path} left the tabs: {e}"),
        }
    }
    if !ids.is_empty() {
        let offset = clock::local_offset_secs(now.div_euclid(1000));
        let _ = state.with(|s| {
            s.after_write(now, offset);
            Ok(())
        });
    }
    ids
}

/// `documents_left_in` in the live app, then one `stash-changed` (A6:
/// `put-away`, naming every entry put away or discarded) — unless the app is
/// quitting, when no drawer is left to refresh. Blocking: call it on the
/// blocking pool (a quit excepted), with no other lock held.
pub(crate) fn documents_left(app: &AppHandle, docs: &[(String, usize, usize)], leaving: Leaving) {
    if docs.is_empty() {
        return;
    }
    let Some(state) = app.try_state::<StashState>() else {
        return;
    };
    let ids = documents_left_in(&state, docs, leaving, clock::now_ms());
    let quitting = app
        .try_state::<SessionState>()
        .is_some_and(|s| s.is_quitting());
    if !ids.is_empty() && !quitting {
        emit_changed(app, "put-away", Some(ids));
    }
}

/// Stash work handed to the blocking pool that a quit must not cut short.
///
/// Closing the last window by its red button destroys it and then exits the
/// process at once (nothing prevents the exit): a put-away still queued or
/// running on the pool would simply never land. The quit path waits for
/// these — bounded, since it runs on the main thread.
struct InFlight {
    count: Mutex<usize>,
    idle: Condvar,
}

/// One unit of `InFlight` work; counted from `enter` until dropped.
pub(crate) struct Pending<'a>(&'a InFlight);

impl InFlight {
    const fn new() -> Self {
        Self {
            count: Mutex::new(0),
            idle: Condvar::new(),
        }
    }

    fn enter(&self) -> Pending<'_> {
        *self.count.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        Pending(self)
    }

    /// Waits until nothing is in flight, at most `timeout`. `true`: idle.
    fn wait_idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut count = self.count.lock().unwrap_or_else(|e| e.into_inner());
        while *count > 0 {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                return false;
            };
            count = self
                .idle
                .wait_timeout(count, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        true
    }
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        let mut count = self.0.count.lock().unwrap_or_else(|e| e.into_inner());
        *count = count.saturating_sub(1);
        if *count == 0 {
            self.0.idle.notify_all();
        }
    }
}

static IN_FLIGHT: InFlight = InFlight::new();

/// Counts the caller's stash work in flight until the guard drops. Take it
/// before handing the work to the pool, so a quit sees it even queued.
pub(crate) fn pending() -> Pending<'static> {
    IN_FLIGHT.enter()
}

/// How long a quit waits for stash work in flight. SQL plus a note's own
/// metadata normally takes milliseconds; this is for a stash waiting out its
/// busy timeout, and a quit may not hang on it.
const QUIT_WAIT: Duration = Duration::from_secs(3);

/// The quit path: waits (bounded) for stash work still in flight.
pub(crate) fn wait_for_pending() {
    if !IN_FLIGHT.wait_idle(QUIT_WAIT) {
        eprintln!("stash: quitting with a put-away still in flight");
    }
}

/// `documents_left` on the blocking pool, for a caller on the main thread
/// (the red button's `Destroyed`). Counted in flight from here, so a quit
/// right behind it waits for it.
pub(crate) fn documents_left_later(
    app: &AppHandle,
    docs: Vec<(String, usize, usize)>,
    leaving: Leaving,
) {
    if docs.is_empty() {
        return;
    }
    let pending = pending();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _pending = pending;
        documents_left(&app, &docs, leaving);
    });
}

/// A closing window's file tabs, with the carets its last heartbeat recorded.
/// Read before `SessionState::remove` erases them.
pub(crate) fn left_with_window(
    tabs: &WindowTabs,
    snapshot: Option<&WindowSnapshot>,
) -> Vec<(String, usize, usize)> {
    tabs.tabs
        .iter()
        .filter_map(|t| {
            let path = t.path.clone()?;
            let (cursor, top_line) = snapshot
                .and_then(|s| s.tabs.iter().find(|s| s.tab_id == t.id))
                .map(|s| (s.cursor, s.top_line))
                .unwrap_or((0, 1));
            Some((path, cursor, top_line))
        })
        .collect()
}

/// The file tabs of the first `live` windows of the session written on quit
/// (`SessionState::snapshot_to_write_counting_live`). The windows after them
/// are carried un-restored from the previous run: not open, so nothing of
/// theirs left the tabs — stamping them would raise their notes on every quit.
pub(crate) fn left_at_quit(session: &Session, live: usize) -> Vec<(String, usize, usize)> {
    session
        .windows
        .iter()
        .take(live)
        .flat_map(|w| w.tabs.iter())
        .filter_map(|t| t.path.clone().map(|p| (p, t.cursor, t.top_line)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stash::testkit::{paths_in, rows, set_columns, user_file, MSK, T0};
    use std::path::{Path, PathBuf};

    const NOW: i64 = T0 + 60_000;

    fn state_in(tag: &str) -> (StashState, PathBuf) {
        let root = crate::atomic_write::testkit::scratch(&format!("lifecycle-{tag}"));
        (StashState::open(Ok(paths_in(&root))), root)
    }

    fn note(state: &StashState, text: &str) -> crate::stash::StashEntry {
        state.with(|s| s.create_note(text, None, T0, MSK)).unwrap()
    }

    fn by_path(state: &StashState, path: &str) -> Option<crate::stash::StashEntry> {
        state.with(|s| s.entry_for_path(path)).unwrap()
    }

    #[test]
    fn a_closed_note_is_put_away_with_its_caret() {
        let (state, _root) = state_in("note");
        let note = note(&state, "# Plan\nbody");
        assert_eq!(
            document_left(&state, &note.path, 7, 3, Leaving::Closed, NOW).unwrap(),
            Left::PutAway(note.id.clone())
        );
        let e = state.with(|s| s.get(&note.id)).unwrap();
        assert_eq!(e.stashed_at, Some(NOW));
        assert_eq!((e.caret, e.top_line), (7, 3));
    }

    #[test]
    fn a_closed_blank_note_disappears_without_a_trace() {
        let (state, _root) = state_in("blank");
        let note = note(&state, "x");
        std::fs::write(&note.path, " \n\t\n").unwrap();
        assert_eq!(
            document_left(&state, &note.path, 0, 1, Leaving::Closed, NOW).unwrap(),
            Left::Discarded(note.id.clone())
        );
        assert!(!Path::new(&note.path).exists(), "the empty file is gone");
        assert!(by_path(&state, &note.path).is_none(), "and so is its entry");
    }

    #[test]
    fn a_blank_note_put_away_with_ctrl_t_disappears_too() {
        let (state, _root) = state_in("blank-put-away");
        let note = note(&state, "x");
        std::fs::write(&note.path, "").unwrap();
        assert_eq!(
            document_left(&state, &note.path, 0, 1, Leaving::PutAway, NOW).unwrap(),
            Left::Discarded(note.id.clone())
        );
        assert!(!Path::new(&note.path).exists());
    }

    #[test]
    fn a_missing_note_file_is_never_taken_for_a_blank_one() {
        let (state, _root) = state_in("missing");
        let note = note(&state, "keep");
        std::fs::remove_file(&note.path).unwrap();
        assert_eq!(
            document_left(&state, &note.path, 0, 1, Leaving::Closed, NOW).unwrap(),
            Left::PutAway(note.id.clone()),
            "an unreadable file proves nothing; the entry stays"
        );
    }

    #[test]
    fn a_note_file_that_is_not_text_is_never_taken_for_a_blank_one() {
        let (state, _root) = state_in("binary");
        let note = note(&state, "x");
        std::fs::write(&note.path, [0xff, b' ', b'\n']).unwrap();
        assert_eq!(
            document_left(&state, &note.path, 0, 1, Leaving::Closed, NOW).unwrap(),
            Left::PutAway(note.id.clone())
        );
        assert!(Path::new(&note.path).exists());
    }

    #[test]
    fn a_blank_file_outside_the_notes_folder_is_never_removed() {
        // Whatever a row claims, only a couplet-named file directly in the
        // notes folder may be removed.
        let (state, root) = state_in("not-a-note");
        let note = note(&state, "x");
        let blank = user_file(&root, "blank.md", "  \n");
        state
            .with(|s| {
                set_columns(s, &note.id, &format!("path = '{blank}'"));
                Ok(())
            })
            .unwrap();
        assert_eq!(
            document_left(&state, &blank, 0, 1, Leaving::Closed, NOW).unwrap(),
            Left::PutAway(note.id.clone())
        );
        assert!(Path::new(&blank).exists(), "the user's file stays");
    }

    #[test]
    fn a_blank_symlink_in_the_notes_folder_is_never_followed_into_a_removal() {
        let (state, root) = state_in("symlink");
        let note = note(&state, "x");
        let target = user_file(&root, "target.md", "\n");
        std::fs::remove_file(&note.path).unwrap();
        std::os::unix::fs::symlink(&target, &note.path).unwrap();
        // Put away, not discarded. (Which entry is stamped is `plan_put_away`'s
        // business: its normalization resolves the link to the target.)
        assert!(matches!(
            document_left(&state, &note.path, 0, 1, Leaving::Closed, NOW).unwrap(),
            Left::PutAway(_)
        ));
        assert!(Path::new(&target).exists());
        assert!(std::fs::symlink_metadata(&note.path).is_ok());
    }

    #[test]
    fn a_trashed_note_is_left_alone() {
        let (state, _root) = state_in("trashed");
        let note = note(&state, "x");
        std::fs::write(&note.path, "").unwrap();
        state
            .with(|s| {
                set_columns(s, &note.id, "deleted_at = 5, stashed_at = NULL");
                Ok(())
            })
            .unwrap();
        assert_eq!(
            document_left(&state, &note.path, 3, 2, Leaving::Closed, NOW).unwrap(),
            Left::Untouched
        );
        assert!(
            document_left(&state, &note.path, 3, 2, Leaving::PutAway, NOW).is_err(),
            "⌃T on a trashed note refuses"
        );
        let e = state.with(|s| s.get(&note.id)).unwrap();
        assert_eq!((e.deleted_at, e.stashed_at, e.caret), (Some(5), None, 0));
        assert!(
            Path::new(&note.path).exists(),
            "even a blank trashed note keeps its file"
        );
    }

    #[test]
    fn a_closed_file_is_left_alone_unless_it_is_put_away() {
        let (state, root) = state_in("file");
        let file = user_file(&root, "plan.md", "# plan");

        assert_eq!(
            document_left(&state, &file, 0, 1, Leaving::Closed, NOW).unwrap(),
            Left::Untouched
        );
        assert!(
            by_path(&state, &file).is_none(),
            "an open file never enters the stash by itself"
        );

        let Left::PutAway(id) = document_left(&state, &file, 4, 2, Leaving::PutAway, NOW).unwrap()
        else {
            panic!("⌃T puts a file away");
        };
        let e = by_path(&state, &file).expect("⌃T made it a reference");
        assert_eq!((e.id, e.kind), (id, StashKind::File));
        assert_eq!((e.caret, e.top_line), (4, 2));
        assert!(Path::new(&file).exists(), "the file itself is untouched");
    }

    #[test]
    fn a_stashed_file_closed_with_cmd_w_keeps_its_stamp() {
        let (state, root) = state_in("stashed-file");
        let file = user_file(&root, "plan.md", "");
        document_left(&state, &file, 4, 2, Leaving::PutAway, NOW).unwrap();
        assert_eq!(
            document_left(&state, &file, 9, 9, Leaving::Closed, NOW + 1).unwrap(),
            Left::Untouched
        );
        let e = by_path(&state, &file).unwrap();
        assert_eq!((e.stashed_at, e.caret), (Some(NOW), 4));
        assert!(
            Path::new(&file).exists(),
            "a blank file reference is never discarded"
        );
    }

    #[test]
    fn a_window_closing_never_discards_even_a_blank_note() {
        // The red button and ⌘Q do not flush the last keystrokes: blank on disk
        // is not proof the buffer was blank (D6).
        let (state, _root) = state_in("window");
        let note = note(&state, "x");
        std::fs::write(&note.path, "").unwrap();
        assert_eq!(
            document_left(&state, &note.path, 5, 2, Leaving::WithWindow, NOW).unwrap(),
            Left::PutAway(note.id.clone())
        );
        assert!(Path::new(&note.path).exists());
        let e = state.with(|s| s.get(&note.id)).unwrap();
        assert_eq!((e.stashed_at, e.caret, e.top_line), (Some(NOW), 5, 2));
    }

    #[test]
    fn a_window_closing_leaves_files_and_trashed_notes_alone() {
        let (state, root) = state_in("window-files");
        let open = user_file(&root, "open.md", "a");
        assert_eq!(
            document_left(&state, &open, 1, 1, Leaving::WithWindow, NOW).unwrap(),
            Left::Untouched
        );
        assert!(
            by_path(&state, &open).is_none(),
            "a file never enters the stash by itself"
        );

        let stashed = user_file(&root, "stashed.md", "b");
        document_left(&state, &stashed, 4, 2, Leaving::PutAway, NOW).unwrap();
        assert_eq!(
            document_left(&state, &stashed, 9, 9, Leaving::WithWindow, NOW + 1).unwrap(),
            Left::Untouched
        );
        let e = by_path(&state, &stashed).unwrap();
        assert_eq!(
            (e.stashed_at, e.caret),
            (Some(NOW), 4),
            "a reference keeps its stamp"
        );

        let trashed = note(&state, "x");
        state
            .with(|s| {
                set_columns(s, &trashed.id, "deleted_at = 5, stashed_at = NULL");
                Ok(())
            })
            .unwrap();
        assert_eq!(
            document_left(&state, &trashed.path, 3, 2, Leaving::WithWindow, NOW).unwrap(),
            Left::Untouched
        );
        let e = state.with(|s| s.get(&trashed.id)).unwrap();
        assert_eq!((e.deleted_at, e.stashed_at), (Some(5), None));
    }

    #[test]
    fn a_window_takes_its_file_tabs_with_the_last_heartbeats_carets() {
        use crate::session::{TabSnapshot, WindowSnapshot};
        use crate::tabs::{RegTab, WindowTabs};
        let tabs = WindowTabs {
            tabs: vec![
                RegTab {
                    id: "a".into(),
                    path: Some("/n/a.md".into()),
                },
                RegTab {
                    id: "u".into(),
                    path: None,
                },
                RegTab {
                    id: "b".into(),
                    path: Some("/p/b.md".into()),
                },
            ],
            ..Default::default()
        };
        let snapshot = WindowSnapshot {
            number: Some(1),
            project: None,
            x: 0,
            y: 0,
            width: 900,
            height: 700,
            tabs: vec![TabSnapshot {
                tab_id: "a".into(),
                cursor: 12,
                top_line: 4,
                ..Default::default()
            }],
            active_tab: Some("a".into()),
        };
        assert_eq!(
            left_with_window(&tabs, Some(&snapshot)),
            vec![
                ("/n/a.md".to_string(), 12, 4),
                ("/p/b.md".to_string(), 0, 1)
            ]
        );
        assert_eq!(
            left_with_window(&tabs, None),
            vec![("/n/a.md".to_string(), 0, 1), ("/p/b.md".to_string(), 0, 1)],
            "a window that never heartbeat still takes its files"
        );
    }

    fn quit_session() -> crate::session::Session {
        use crate::session::{Session, TabSnapshot, WindowSnapshot, SESSION_VERSION};
        let window = |tabs: Vec<TabSnapshot>| WindowSnapshot {
            number: None,
            project: None,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            active_tab: None,
            tabs,
        };
        let file = |id: &str, path: &str, cursor| TabSnapshot {
            tab_id: id.into(),
            path: Some(path.into()),
            cursor,
            top_line: 1,
            ..Default::default()
        };
        let draft = |id: &str| TabSnapshot {
            tab_id: id.into(),
            untitled: Some(format!("draft-{id}.md")),
            ..Default::default()
        };
        Session {
            version: SESSION_VERSION,
            saved_at: 1,
            windows: vec![
                window(vec![file("a", "/n/a.md", 2)]),
                window(vec![draft("u")]),
                // Carried by `snapshot_to_write` from the previous run: not open.
                window(vec![file("c", "/n/c.md", 7), draft("v")]),
            ],
        }
    }

    #[test]
    fn a_quit_takes_every_file_tab_of_the_live_windows() {
        assert_eq!(
            left_at_quit(&quit_session(), 2),
            vec![("/n/a.md".to_string(), 2, 1)]
        );
    }

    #[test]
    fn a_quit_never_takes_the_windows_nobody_restored() {
        // Stamping them would raise their notes in «changed» on every quit.
        assert_eq!(
            left_at_quit(&quit_session(), 1),
            vec![("/n/a.md".to_string(), 2, 1)]
        );
        assert_eq!(left_at_quit(&quit_session(), 0), Vec::new());
        assert_eq!(
            left_at_quit(&quit_session(), 3).len(),
            2,
            "counted, not guessed"
        );
    }

    #[test]
    fn with_nothing_in_flight_a_quit_does_not_wait() {
        let flight = InFlight::new();
        let started = std::time::Instant::now();
        assert!(flight.wait_idle(std::time::Duration::from_secs(5)));
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn a_quit_waits_for_a_window_still_being_put_away() {
        let flight = InFlight::new();
        let done = std::sync::atomic::AtomicBool::new(false);
        std::thread::scope(|scope| {
            let pending = flight.enter();
            scope.spawn(|| {
                let _pending = pending;
                std::thread::sleep(std::time::Duration::from_millis(50));
                done.store(true, std::sync::atomic::Ordering::SeqCst);
            });
            assert!(flight.wait_idle(std::time::Duration::from_secs(5)));
            assert!(
                done.load(std::sync::atomic::Ordering::SeqCst),
                "waited for it"
            );
        });
    }

    #[test]
    fn a_quit_waits_a_bounded_time() {
        let flight = InFlight::new();
        let _stuck = flight.enter();
        let started = std::time::Instant::now();
        assert!(!flight.wait_idle(std::time::Duration::from_millis(50)));
        assert!(started.elapsed() >= std::time::Duration::from_millis(50));
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    fn notes_folder(tag: &str) -> PathBuf {
        let dir = crate::atomic_write::testkit::scratch(&format!("blank-{tag}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const SECS: u64 = 1_790_378_160;

    #[test]
    fn a_blank_file_is_removed_through_an_aside_name() {
        let dir = notes_folder("gone");
        let path = dir.join("2026-09-26-0215-abcd.md");
        std::fs::write(&path, " \n\t\n").unwrap();
        assert_eq!(remove_if_blank(&path, SECS), Blank::Removed);
        assert!(names_in(&dir).is_empty(), "no aside left behind");
    }

    #[test]
    fn text_saved_between_the_check_and_the_aside_goes_back_to_its_name() {
        // An atomic save (tmp + rename) landing after the blank check: the
        // aside holds real text, which must come back — never be unlinked.
        let dir = notes_folder("raced");
        let path = dir.join("2026-09-26-0215-abcd.md");
        std::fs::write(&path, "").unwrap();
        let blank = remove_if_blank_with(&path, SECS, || {
            let tmp = dir.join(".save.tmp");
            std::fs::write(&tmp, "real text").unwrap();
            std::fs::rename(&tmp, &path).unwrap();
        });
        assert_eq!(blank, Blank::Stays);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "real text");
        assert_eq!(names_in(&dir), vec!["2026-09-26-0215-abcd.md".to_string()]);
    }

    #[test]
    fn an_aside_with_text_never_overwrites_a_newer_save_and_both_stay() {
        let dir = notes_folder("both");
        let path = dir.join("2026-09-26-0215-abcd.md");
        let aside = dir.join(".2026-09-26-0215-abcd.md.discard-1-0");
        std::fs::write(&aside, "text set aside").unwrap();
        std::fs::write(&path, "a newer save").unwrap();
        let Blank::Recovered(kept) = settle_aside(&aside, &path, SECS) else {
            panic!("the aside's text is kept under a visible name");
        };
        assert_eq!(
            kept,
            dir.join(format!("2026-09-26-0215-abcd.recovered-{SECS}.md"))
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "a newer save");
        assert_eq!(std::fs::read_to_string(&kept).unwrap(), "text set aside");
        assert!(!aside.exists());
    }

    #[test]
    fn a_recovered_name_already_taken_is_never_overwritten() {
        let dir = notes_folder("taken");
        let path = dir.join("2026-09-26-0215-abcd.md");
        let aside = dir.join(".2026-09-26-0215-abcd.md.discard-1-0");
        let first = dir.join(format!("2026-09-26-0215-abcd.recovered-{SECS}.md"));
        std::fs::write(&first, "an earlier recovery").unwrap();
        std::fs::write(&aside, "text set aside").unwrap();
        std::fs::write(&path, "a newer save").unwrap();
        let Blank::Recovered(kept) = settle_aside(&aside, &path, SECS) else {
            panic!("kept");
        };
        assert_ne!(kept, first);
        assert_eq!(
            std::fs::read_to_string(&first).unwrap(),
            "an earlier recovery"
        );
        assert_eq!(std::fs::read_to_string(&kept).unwrap(), "text set aside");
    }

    #[test]
    fn a_blank_aside_with_a_newer_save_at_the_name_is_not_a_removal() {
        let dir = notes_folder("blank-newer");
        let path = dir.join("2026-09-26-0215-abcd.md");
        let aside = dir.join(".2026-09-26-0215-abcd.md.discard-1-0");
        std::fs::write(&aside, "\n").unwrap();
        std::fs::write(&path, "a newer save").unwrap();
        assert_eq!(settle_aside(&aside, &path, SECS), Blank::Stays);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "a newer save");
        assert!(!aside.exists());
    }

    #[test]
    fn documents_left_names_every_entry_it_changed() {
        let (state, root) = state_in("ids");
        let kept = note(&state, "# kept");
        let blank = note(&state, "y");
        std::fs::write(&blank.path, "\n").unwrap();
        let file = user_file(&root, "a.md", "a");
        let ids = documents_left_in(
            &state,
            &[
                (kept.path.clone(), 1, 1),
                (blank.path.clone(), 0, 1),
                (file.clone(), 0, 1),
            ],
            Leaving::Closed,
            NOW,
        );
        assert_eq!(ids, vec![kept.id.clone(), blank.id.clone()]);
        assert_eq!(state.with(|s| Ok(rows(s, "entries"))).unwrap(), 1);
    }
}
