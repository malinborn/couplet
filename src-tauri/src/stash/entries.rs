//! Entries: creating notes, reading, putting away, tags, list and counts.
//! Every multi-row change is one `BEGIN IMMEDIATE` transaction (roadmap).

use std::fs::{self, OpenOptions};
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::db::{self, EntryRow, ENTRY_COLUMNS};
use super::{ids, notes, Stash, StashEntry, StashKind};

/// Preview length in characters (roadmap: "first ~400 chars").
pub(crate) const PREVIEW_CHARS: usize = 400;
/// Bytes read for a preview: 400 characters of up to 4 UTF-8 bytes each.
const PREVIEW_BYTES: u64 = (PREVIEW_CHARS * 4) as u64;
const ID_ATTEMPTS: usize = 8;

/// The repo tag as the stash stores and filters it: a project's directory
/// name. A window knows its project as an absolute root, `git_info` gives a
/// file's as a name; both meet here (plan D1, roadmap A3).
pub(crate) fn normalize_repo(repo: Option<&str>) -> Option<String> {
    let repo = repo?.trim();
    if repo.is_empty() {
        return None;
    }
    if repo.contains('/') {
        let name = crate::git_info::dir_name(Path::new(repo.trim_end_matches('/')));
        return (!name.is_empty()).then_some(name);
    }
    Some(repo.to_string())
}

/// The first `PREVIEW_CHARS` characters of a regular file, `""` for anything
/// unreadable, not a regular file, or not UTF-8. Checked and opened like
/// `git_info::read_small`: a FIFO or a device must not hang a listing.
pub(crate) fn read_preview(path: &Path) -> String {
    if !fs::metadata(path).is_ok_and(|m| m.is_file()) {
        return String::new();
    }
    let Ok(file) = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
    else {
        return String::new();
    };
    if !file.metadata().is_ok_and(|m| m.is_file()) {
        return String::new();
    }
    let mut bytes = Vec::new();
    if file.take(PREVIEW_BYTES).read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text,
        // Cut inside the last character by the read limit: keep what came before it.
        Err(e) if e.error_len().is_none() => {
            std::str::from_utf8(&bytes[..e.valid_up_to()]).unwrap_or("")
        }
        Err(_) => return String::new(),
    };
    text.replace("\r\n", "\n")
        .chars()
        .take(PREVIEW_CHARS)
        .collect()
}

/// A fresh id not yet in `entries`, checked inside the caller's transaction.
fn unique_id(conn: &Connection) -> Result<String, String> {
    for _ in 0..ID_ATTEMPTS {
        let id = ids::new_id();
        let taken = conn
            .query_row("SELECT 1 FROM entries WHERE id = ?1", [&id], |_| Ok(()))
            .optional()
            .map_err(db::err)?
            .is_some();
        if !taken {
            return Ok(id);
        }
    }
    Err("could not pick a free stash id".to_string())
}

/// `(repo, branch)` as the entry shows them: stored for a note, derived from
/// the file's repository for a file reference.
fn derived_repo(row: &EntryRow) -> (Option<String>, Option<String>) {
    match row.kind {
        StashKind::Note => (row.repo.clone(), None),
        StashKind::File => match crate::git_info::repo_info(Path::new(&row.path)) {
            Some(info) => (Some(info.project), info.branch),
            None => (None, None),
        },
    }
}

fn entry_from(
    row: EntryRow,
    tags: Vec<String>,
    repo: Option<String>,
    branch: Option<String>,
    preview: String,
) -> StashEntry {
    StashEntry {
        title: (!row.title.is_empty()).then_some(row.title),
        id: row.id,
        kind: row.kind,
        path: row.path,
        repo,
        branch,
        tags,
        created_at: row.created_at,
        modified_at: row.modified_at,
        stashed_at: row.stashed_at,
        opened_at: row.opened_at,
        deleted_at: row.deleted_at,
        caret: row.caret,
        top_line: row.top_line,
        preview,
    }
}

impl Stash {
    /// A new note: its file in the notes folder, then its entry. Not put away
    /// (`stashed_at` is NULL): the note is open in the tab that typed it.
    pub fn create_note(
        &mut self,
        text: &str,
        repo: Option<&str>,
        now: i64,
        offset_secs: i64,
    ) -> Result<StashEntry, String> {
        if text.trim().is_empty() {
            return Err("a note needs text".to_string());
        }
        let dir = self.notes_dir()?;
        // `create_new`: never overwrites anything already in the folder.
        let path = notes::create_note_file(&dir, text, now, offset_secs, ids::random16)?;
        let path = path.to_string_lossy().into_owned();
        let title = notes::title_of(text).unwrap_or_default();
        let repo = normalize_repo(repo);
        // If the insert fails the file stays — it may be the only copy of the
        // human's text — and the error names it, so the caller can still reach it.
        let id = self
            .insert_note(&path, &title, repo.as_deref(), now)
            .map_err(|e| format!("note saved to {path} but not recorded in the stash: {e}"))?;
        self.get(&id)
    }

    fn insert_note(
        &mut self,
        path: &str,
        title: &str,
        repo: Option<&str>,
        now: i64,
    ) -> Result<String, String> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db::err)?;
        let id = unique_id(&tx)?;
        tx.execute(
            "INSERT INTO entries (id, kind, path, title, repo, created_at, modified_at) \
             VALUES (?1, 'note', ?2, ?3, ?4, ?5, ?5)",
            params![id, path, title, repo, now],
        )
        .map_err(db::err)?;
        tx.commit().map_err(db::err)?;
        Ok(id)
    }

    pub fn get(&self, id: &str) -> Result<StashEntry, String> {
        let row = self
            .conn
            .query_row(
                &format!("SELECT {ENTRY_COLUMNS} FROM entries WHERE id = ?1"),
                [id],
                db::entry_row,
            )
            .optional()
            .map_err(db::err)?
            .ok_or_else(|| format!("no stash entry {id}"))?;
        let tags = self.tags_of(&row.id)?;
        let (repo, branch) = derived_repo(&row);
        let preview = read_preview(Path::new(&row.path));
        Ok(entry_from(row, tags, repo, branch, preview))
    }

    fn tags_of(&self, id: &str) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT tag FROM tags WHERE entry_id = ?1 ORDER BY tag")
            .map_err(db::err)?;
        let tags = stmt
            .query_map([id], |r| r.get(0))
            .map_err(db::err)?
            .collect::<Result<Vec<String>, _>>()
            .map_err(db::err)?;
        Ok(tags)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atomic_write::testkit::scratch;
    use crate::stash::testkit::*;

    #[test]
    fn creating_a_note_writes_its_file_and_its_entry() {
        let (mut stash, root) = stash_in("create");
        let e = stash
            .create_note(
                "# Список покупок\n- молоко\n",
                Some("/Users/u/src/couplet"),
                T0,
                MSK,
            )
            .unwrap();
        assert_eq!(e.kind, StashKind::Note);
        assert_eq!(e.title.as_deref(), Some("Список покупок"));
        assert_eq!(
            (e.repo.as_deref(), e.branch.as_deref()),
            (Some("couplet"), None)
        );
        let notes = crate::path_norm::normalize_path(&root.join("home/couplet-test"));
        assert!(
            Path::new(&e.path).starts_with(&notes),
            "{} not under {}",
            e.path,
            notes.display()
        );
        let name = Path::new(&e.path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(
            name.starts_with("2026-09-26-0215-") && name.ends_with(".md"),
            "{name}"
        );
        assert_eq!(
            fs::read_to_string(&e.path).unwrap(),
            "# Список покупок\n- молоко\n"
        );
        assert_eq!((e.created_at, e.modified_at), (T0, T0));
        assert_eq!(
            (e.stashed_at, e.opened_at, e.deleted_at),
            (None, None, None),
            "open, not put away"
        );
        assert_eq!((e.caret, e.top_line), (0, 1));
        assert!(e.tags.is_empty());
        assert_eq!(e.preview, "# Список покупок\n- молоко\n");
        assert_eq!(stash.get(&e.id).unwrap(), e);
    }

    #[test]
    fn an_untitled_note_has_a_null_title_over_ipc() {
        // Roadmap A4: stored '' in the NOT NULL column, `null` in `StashEntry`.
        let (mut stash, _root) = stash_in("untitled");
        let e = stash.create_note("***\n", None, T0, MSK).unwrap();
        assert_eq!(e.title, None);
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["title"], serde_json::Value::Null);
        assert_eq!(json["repo"], serde_json::Value::Null);
        for key in [
            "createdAt",
            "modifiedAt",
            "stashedAt",
            "openedAt",
            "deletedAt",
            "topLine",
        ] {
            assert!(json.get(key).is_some(), "camelCase key {key} in {json}");
        }
        assert_eq!(json["kind"], "note");
    }

    #[test]
    fn a_blank_note_is_refused_and_creates_nothing() {
        let (mut stash, root) = stash_in("blank");
        assert!(stash.create_note(" \n\t", None, T0, MSK).is_err());
        assert!(!root.join("home").exists());
        assert_eq!(rows(&stash, "entries"), 0);
    }

    #[test]
    fn a_failed_insert_keeps_the_note_file_and_names_it() {
        let (mut stash, root) = stash_in("insert-fails");
        // Any write to the database now fails; the note file is already on disk
        // by then and holds the only copy of the human's text.
        stash.conn.execute_batch("PRAGMA query_only = ON;").unwrap();
        let err = stash
            .create_note("# Важное\nтекст\n", None, T0, MSK)
            .unwrap_err();
        let notes = root.join("home/couplet-test");
        let files: Vec<_> = fs::read_dir(&notes)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert_eq!(files.len(), 1, "{files:?}");
        assert_eq!(fs::read_to_string(&files[0]).unwrap(), "# Важное\nтекст\n");
        let name = files[0].file_name().unwrap().to_string_lossy().into_owned();
        assert!(err.contains(&name), "the error names the kept file: {err}");
        stash
            .conn
            .execute_batch("PRAGMA query_only = OFF;")
            .unwrap();
        assert_eq!(rows(&stash, "entries"), 0);
    }

    #[test]
    fn opening_the_stash_does_not_touch_the_notes_folder() {
        let (_stash, root) = stash_in("lazy");
        assert!(root.join("data/stash.db").exists());
        assert!(
            !root.join("home").exists(),
            "the notes folder appears with the first note"
        );
    }

    #[test]
    fn an_unknown_id_is_an_error() {
        let (stash, _root) = stash_in("unknown");
        assert_eq!(stash.get("s1-dead").unwrap_err(), "no stash entry s1-dead");
    }

    #[test]
    fn repo_names_meet_in_one_spelling() {
        assert_eq!(normalize_repo(None), None);
        assert_eq!(normalize_repo(Some("  ")), None);
        assert_eq!(
            normalize_repo(Some("/Users/u/src/couplet")).as_deref(),
            Some("couplet")
        );
        assert_eq!(
            normalize_repo(Some("/Users/u/src/couplet/")).as_deref(),
            Some("couplet")
        );
        assert_eq!(
            normalize_repo(Some(" couplet ")).as_deref(),
            Some("couplet")
        );
        assert_eq!(normalize_repo(Some("/")), None);
    }

    #[test]
    fn a_preview_is_the_first_400_characters_and_never_fails() {
        let dir = scratch("preview");
        let long = dir.join("long.md");
        fs::write(&long, "ж".repeat(1000)).unwrap();
        assert_eq!(read_preview(&long), "ж".repeat(PREVIEW_CHARS));

        let split = dir.join("split.md");
        fs::write(&split, format!("a{}", "ж".repeat(1000))).unwrap();
        assert_eq!(
            read_preview(&split),
            format!("a{}", "ж".repeat(PREVIEW_CHARS - 1)),
            "a character cut by the read limit is dropped"
        );

        let crlf = dir.join("crlf.md");
        fs::write(&crlf, "a\r\nb").unwrap();
        assert_eq!(read_preview(&crlf), "a\nb");

        let binary = dir.join("bin.md");
        fs::write(&binary, [0xff_u8, 0xfe, 0x00]).unwrap();
        assert_eq!(read_preview(&binary), "");
        assert_eq!(read_preview(&dir.join("missing.md")), "");
        assert_eq!(read_preview(&dir), "", "a directory");
    }
}
