//! What leaving the tabs means for the stash (stash plan 03, D5-D6). Decided
//! here, from the database, never from a frontend's cache: `tab_close` (⌘W,
//! ⌃T, `/stash`, an agent's close, an expired quick look) comes through
//! `documents_left`.
//!
//! Lock discipline (I3, A11): the stash lock covers SQL only. Each document
//! goes lookup (SQL) → the user's disk (unlocked) → write (SQL); the caller
//! runs all of it on the blocking pool with no other lock held.

use std::fs;
use std::io::Read;
use std::path::Path;

use tauri::{AppHandle, Manager};

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

/// Removes `path` if — read right now — it is a regular file holding only
/// whitespace. Anything that cannot prove blankness (missing, a symlink, not
/// UTF-8, unreadable, large) is not blank and stays. `true`: it is gone.
fn remove_if_blank(path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() > BLANK_READ_LIMIT {
        return false;
    }
    let mut bytes = Vec::new();
    let read =
        fs::File::open(path).and_then(|f| f.take(BLANK_READ_LIMIT + 1).read_to_end(&mut bytes));
    let blank = read.is_ok()
        && bytes.len() as u64 <= BLANK_READ_LIMIT
        && std::str::from_utf8(&bytes).is_ok_and(|t| t.trim().is_empty());
    // Unlinked, not trashed: a trash copy of whitespace keeps nothing, and the
    // spec wants an empty document to vanish without a trace.
    blank && fs::remove_file(path).is_ok()
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
/// touched (A8).
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
                Leaving::Closed => Ok(Left::Untouched),
                Leaving::PutAway => Err(format!("in the trash: {path}")),
            };
        }
        Some(e) if e.kind == StashKind::Note => {
            let is_note_file = kind_of_new(Path::new(path), &notes_dir) == StashKind::Note;
            if is_note_file && remove_if_blank(Path::new(path)) {
                let id = e.id.clone();
                state.with(|s| s.forget_discarded_note(&id))?;
                return Ok(Left::Discarded(id));
            }
        }
        _ if leaving == Leaving::Closed => return Ok(Left::Untouched),
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
/// `put-away`, naming every entry put away or discarded). Blocking: call it
/// on the blocking pool, with no other lock held.
pub(crate) fn documents_left(app: &AppHandle, docs: &[(String, usize, usize)], leaving: Leaving) {
    if docs.is_empty() {
        return;
    }
    let Some(state) = app.try_state::<StashState>() else {
        return;
    };
    let ids = documents_left_in(&state, docs, leaving, clock::now_ms());
    if !ids.is_empty() {
        emit_changed(app, "put-away", Some(ids));
    }
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
