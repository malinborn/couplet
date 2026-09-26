//! Entries: creating notes, reading, putting away, tags, list and counts.
//! Every multi-row change is one `BEGIN IMMEDIATE` transaction (roadmap).

use std::fs::{self, OpenOptions};
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::time::UNIX_EPOCH;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::db::{self, EntryRow, ENTRY_COLUMNS};
use super::{ids, notes, PutAway, PutAwayResult, Stash, StashEntry, StashKind};

/// Preview length in characters (roadmap: "first ~400 chars").
pub(crate) const PREVIEW_CHARS: usize = 400;
/// Bytes read for a preview: 400 characters of up to 4 UTF-8 bytes each.
const PREVIEW_BYTES: u64 = (PREVIEW_CHARS * 4) as u64;
const ID_ATTEMPTS: usize = 8;
/// Longest tag, in characters.
pub(crate) const TAG_MAX_CHARS: usize = 64;

/// A tag as stored: trimmed, without leading `#`, lower-case. `Ok(None)` for
/// nothing left; an error for whitespace inside (a `#tag` query could never
/// find it) or an absurd length (plan D8).
pub(crate) fn normalize_tag(raw: &str) -> Result<Option<String>, String> {
    let tag = raw.trim().trim_start_matches('#').trim();
    if tag.is_empty() {
        return Ok(None);
    }
    if tag.chars().any(char::is_whitespace) {
        return Err(format!("a tag cannot contain spaces: {raw:?}"));
    }
    if tag.chars().count() > TAG_MAX_CHARS {
        return Err(format!(
            "a tag is at most {TAG_MAX_CHARS} characters: {raw:?}"
        ));
    }
    Ok(Some(tag.to_lowercase()))
}

/// `normalize_tag` over a list, empties dropped, duplicates collapsed in order.
pub(crate) fn normalize_tags(raw: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for r in raw {
        if let Some(tag) = normalize_tag(r)? {
            if !out.contains(&tag) {
                out.push(tag);
            }
        }
    }
    Ok(out)
}

fn file_title(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// A file reference's repo as stored (roadmap A3): the git toplevel's name,
/// `None` outside a repository — the file's own folder is not a repo tag.
fn file_repo(path: &str) -> Option<String> {
    let info = crate::git_info::repo_info(Path::new(path))?;
    normalize_repo(Some(&info.project))
}

/// A path not yet in the stash becomes an entry: a note when it lies in the
/// notes folder, a file reference otherwise (plan D5, D18).
fn insert_new(
    tx: &Connection,
    path: &str,
    notes_dir: &Path,
    req: &PutAway,
    now: i64,
) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| format!("cannot put away {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("cannot put away {path}: not a file"));
    }
    let kind = if Path::new(path).starts_with(notes_dir) {
        StashKind::Note
    } else {
        StashKind::File
    };
    let (title, repo) = match kind {
        StashKind::Note => (
            fs::read_to_string(path)
                .ok()
                .and_then(|t| notes::title_of(&t))
                .unwrap_or_default(),
            None,
        ),
        StashKind::File => (file_title(path), file_repo(path)),
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(now);
    let id = unique_id(tx)?;
    tx.execute(
        "INSERT INTO entries (id, kind, path, title, repo, created_at, modified_at, stashed_at, caret, top_line) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6, ?8, ?9)",
        params![
            id,
            kind.as_str(),
            path,
            title,
            repo,
            now,
            modified,
            req.caret.unwrap_or(0),
            req.top_line.unwrap_or(1)
        ],
    )
    .map_err(db::err)?;
    Ok(id)
}

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

    /// Puts documents away: new ones become entries, ones already in the stash
    /// are raised (`stashed_at = now`), re-tagged (union) and re-positioned.
    /// Paths are normalized here — the dedup key is `path_norm`'s spelling —
    /// and the whole request is one transaction (plan D4): a trashed entry
    /// among the paths refuses all of it (roadmap A8).
    pub fn put_away(&mut self, req: &PutAway, now: i64) -> Result<Vec<PutAwayResult>, String> {
        if req.paths.len() > 1 && (req.caret.is_some() || req.top_line.is_some()) {
            return Err("caret and topLine belong to a single path".to_string());
        }
        let tags = normalize_tags(&req.tags)?;
        let paths: Vec<String> = req
            .paths
            .iter()
            .map(|p| crate::path_norm::normalize_str(p))
            .collect();
        let notes_dir = self.notes_dir()?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db::err)?;
        let mut done: Vec<(String, bool)> = Vec::with_capacity(paths.len());
        for path in &paths {
            if !Path::new(path).is_absolute() {
                return Err(format!("path must be absolute: {path}"));
            }
            let existing: Option<(String, String, Option<i64>)> = tx
                .query_row(
                    "SELECT id, kind, deleted_at FROM entries WHERE path = ?1",
                    [path],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(db::err)?;
            let (id, created) = match existing {
                Some((_, _, Some(_))) => return Err(format!("in the trash: {path}")),
                Some((id, kind, None)) => {
                    tx.execute(
                        "UPDATE entries SET stashed_at = ?1, caret = COALESCE(?2, caret), \
                         top_line = COALESCE(?3, top_line) WHERE id = ?4",
                        params![now, req.caret, req.top_line, id],
                    )
                    .map_err(db::err)?;
                    // A file's repo is re-derived at every put-away (roadmap A3);
                    // a note keeps the project it was written in.
                    if kind == StashKind::File.as_str() {
                        tx.execute(
                            "UPDATE entries SET repo = ?1 WHERE id = ?2",
                            params![file_repo(path), id],
                        )
                        .map_err(db::err)?;
                    }
                    (id, false)
                }
                None => (insert_new(&tx, path, &notes_dir, req, now)?, true),
            };
            for tag in &tags {
                tx.execute(
                    "INSERT OR IGNORE INTO tags (entry_id, tag) VALUES (?1, ?2)",
                    params![id, tag],
                )
                .map_err(db::err)?;
            }
            done.push((id, created));
        }
        tx.commit().map_err(db::err)?;
        done.into_iter()
            .map(|(id, created)| {
                Ok(PutAwayResult {
                    entry: self.get(&id)?,
                    created,
                })
            })
            .collect()
    }

    /// Adds then removes tags (plan D8), so a tag in both lists ends up absent.
    /// A trashed entry refuses (roadmap A8).
    pub fn tag(
        &mut self,
        id: &str,
        add: &[String],
        remove: &[String],
    ) -> Result<StashEntry, String> {
        let add = normalize_tags(add)?;
        let remove = normalize_tags(remove)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db::err)?;
        let deleted_at: Option<i64> = tx
            .query_row("SELECT deleted_at FROM entries WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(db::err)?
            .ok_or_else(|| format!("no stash entry {id}"))?;
        if deleted_at.is_some() {
            return Err(format!("in the trash: {id}"));
        }
        for tag in &add {
            tx.execute(
                "INSERT OR IGNORE INTO tags (entry_id, tag) VALUES (?1, ?2)",
                params![id, tag],
            )
            .map_err(db::err)?;
        }
        for tag in &remove {
            tx.execute(
                "DELETE FROM tags WHERE entry_id = ?1 AND tag = ?2",
                params![id, tag],
            )
            .map_err(db::err)?;
        }
        tx.commit().map_err(db::err)?;
        self.get(id)
    }

    /// Records that a document was opened from the stash. `false` when the
    /// path is not a stash entry (opening any other file is not stash news).
    pub fn touch_opened(&mut self, path: &str, now: i64) -> Result<bool, String> {
        let path = crate::path_norm::normalize_str(path);
        let changed = self
            .conn
            .execute(
                "UPDATE entries SET opened_at = ?1 WHERE path = ?2",
                params![now, path],
            )
            .map_err(db::err)?;
        Ok(changed > 0)
    }

    /// The save hook's work: a stash entry's `modified_at`, and a note's title
    /// (a file reference keeps its file name, plan D18). `path` is the spelling
    /// the editor saved under — already the registry's normalized one. Only
    /// moves forward in time, so a late, older save cannot roll a title back
    /// (plan D9); a trashed row is left alone (roadmap A8). `true` when the
    /// title changed — the one case worth a `stash-changed { reason: "title" }`.
    pub fn file_written(&mut self, path: &str, text: &str, now: i64) -> Result<bool, String> {
        let row: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT kind, title FROM entries WHERE path = ?1 AND deleted_at IS NULL",
                [path],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db::err)?;
        let Some((kind, old_title)) = row else {
            return Ok(false);
        };
        let title = if kind == StashKind::Note.as_str() {
            notes::title_of(text).unwrap_or_default()
        } else {
            old_title.clone()
        };
        // `deleted_at IS NULL` again: the row may have been trashed between the
        // read and this write by another connection (CLI, MCP).
        let changed = self
            .conn
            .execute(
                "UPDATE entries SET modified_at = ?1, title = ?2 \
                 WHERE path = ?3 AND modified_at <= ?1 AND deleted_at IS NULL",
                params![now, title, path],
            )
            .map_err(db::err)?;
        Ok(changed > 0 && title != old_title)
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
    use crate::stash::PutAway;

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

    fn put(paths: Vec<String>) -> PutAway {
        PutAway {
            paths,
            ..PutAway::default()
        }
    }

    /// The `repo` column itself, not the entry's derived `repo`.
    fn stored_repo(stash: &Stash, id: &str) -> Option<String> {
        stash
            .conn
            .query_row("SELECT repo FROM entries WHERE id = ?1", [id], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn putting_away_a_file_creates_a_reference() {
        let (mut stash, root) = stash_in("put-file");
        let file = user_file(&root, "plan.md", "# План\n");
        let req = PutAway {
            paths: vec![file.clone()],
            caret: Some(7),
            top_line: Some(3),
            tags: vec!["#Infra".into(), "infra".into()],
        };
        let r = stash.put_away(&req, T0).unwrap();
        assert_eq!(r.len(), 1);
        assert!(r[0].created);
        let e = &r[0].entry;
        assert_eq!(
            (e.kind, e.path.as_str(), e.title.as_deref()),
            (StashKind::File, file.as_str(), Some("plan.md"))
        );
        assert_eq!((e.stashed_at, e.created_at), (Some(T0), T0));
        assert_eq!((e.caret, e.top_line), (7, 3));
        assert_eq!(e.tags, vec!["infra"]);
        assert_eq!(e.repo, None, "a loose file has no repo tag");
        assert_eq!(e.preview, "# План\n");
    }

    #[test]
    fn putting_away_again_is_a_dedup_hit() {
        let (mut stash, root) = stash_in("dedup");
        let file = user_file(&root, "todo.md", "todo");
        let first = stash
            .put_away(
                &PutAway {
                    paths: vec![file.clone()],
                    caret: Some(1),
                    top_line: Some(3),
                    tags: vec!["a".into()],
                },
                T0,
            )
            .unwrap();
        let again = stash
            .put_away(
                &PutAway {
                    paths: vec![file],
                    caret: Some(9),
                    top_line: None,
                    tags: vec!["B".into()],
                },
                T0 + 60_000,
            )
            .unwrap();
        assert!(!again[0].created, "a second put-away is a dedup hit");
        let e = &again[0].entry;
        assert_eq!(e.id, first[0].entry.id);
        assert_eq!(e.stashed_at, Some(T0 + 60_000), "raised to the top");
        assert_eq!(e.tags, vec!["a", "b"], "tags merged");
        assert_eq!(
            (e.caret, e.top_line),
            (9, 3),
            "caret updated, an absent topLine kept"
        );
        assert_eq!(e.created_at, T0);
        assert_eq!(rows(&stash, "entries"), 1);
    }

    #[test]
    fn two_spellings_of_one_file_are_one_entry() {
        let (mut stash, root) = stash_in("alias");
        let real = root.join("work/real");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("a.md"), "a").unwrap();
        std::os::unix::fs::symlink(&real, root.join("work/link")).unwrap();
        let via_link = root.join("work/link/a.md").to_string_lossy().into_owned();
        let via_dots = root.join("work/real/./a.md").to_string_lossy().into_owned();
        let first = stash.put_away(&put(vec![via_link]), T0).unwrap();
        let second = stash.put_away(&put(vec![via_dots]), T0 + 1).unwrap();
        assert!(first[0].created && !second[0].created);
        assert_eq!(first[0].entry.id, second[0].entry.id);
        assert_eq!(rows(&stash, "entries"), 1);
    }

    #[test]
    fn putting_away_a_note_keeps_its_entry() {
        let (mut stash, _root) = stash_in("put-note");
        let note = stash
            .create_note("# Идея", Some("couplet"), T0, MSK)
            .unwrap();
        let req = PutAway {
            paths: vec![note.path.clone()],
            caret: Some(4),
            top_line: Some(1),
            tags: vec![],
        };
        let r = stash.put_away(&req, T0 + 5).unwrap();
        assert!(!r[0].created);
        let e = &r[0].entry;
        assert_eq!(
            (e.id.as_str(), e.kind, e.repo.as_deref()),
            (note.id.as_str(), StashKind::Note, Some("couplet"))
        );
        assert_eq!((e.stashed_at, e.caret), (Some(T0 + 5), 4));
    }

    #[test]
    fn a_file_in_the_notes_folder_is_a_note() {
        let (mut stash, _root) = stash_in("note-folder");
        let path = stash.notes_dir().unwrap().join("hand-made.md");
        fs::write(&path, "- [ ] позвонить\n").unwrap();
        let r = stash
            .put_away(&put(vec![path.to_string_lossy().into_owned()]), T0)
            .unwrap();
        assert_eq!(r[0].entry.kind, StashKind::Note);
        assert_eq!(r[0].entry.title.as_deref(), Some("позвонить"));
    }

    #[test]
    fn one_bad_path_rolls_the_whole_request_back() {
        let (mut stash, root) = stash_in("rollback");
        let good = user_file(&root, "good.md", "g");
        let err = stash
            .put_away(&put(vec![good.clone(), "relative.md".into()]), T0)
            .unwrap_err();
        assert!(err.contains("absolute"), "{err}");
        let missing = root.join("work/missing.md").to_string_lossy().into_owned();
        assert!(stash.put_away(&put(vec![good, missing]), T0).is_err());
        assert_eq!(rows(&stash, "entries"), 0, "all or nothing");
    }

    #[test]
    fn a_caret_with_several_paths_is_refused() {
        let (mut stash, root) = stash_in("caret-many");
        let a = user_file(&root, "a.md", "a");
        let b = user_file(&root, "b.md", "b");
        let req = PutAway {
            paths: vec![a, b],
            caret: Some(1),
            ..PutAway::default()
        };
        assert!(stash.put_away(&req, T0).is_err());
        assert_eq!(rows(&stash, "entries"), 0);
    }

    #[test]
    fn a_directory_is_not_put_away() {
        let (mut stash, root) = stash_in("dir");
        let dir = root.join("work/folder");
        fs::create_dir_all(&dir).unwrap();
        let err = stash
            .put_away(&put(vec![dir.to_string_lossy().into_owned()]), T0)
            .unwrap_err();
        assert!(err.contains("not a file"), "{err}");
    }

    #[test]
    fn a_trashed_entry_refuses_the_whole_put_away() {
        // Roadmap A8, stage 06 D18: a dedup hit on a trashed row must not stamp
        // `stashed_at` on a row that stays deleted; the request is all or none.
        let (mut stash, root) = stash_in("put-trashed");
        let note = stash.create_note("# Удалённая", None, T0, MSK).unwrap();
        set_columns(&stash, &note.id, &format!("deleted_at = {}", T0 + 1));
        let good = user_file(&root, "good.md", "g");
        let req = PutAway {
            paths: vec![good, note.path.clone()],
            tags: vec!["x".into()],
            ..PutAway::default()
        };
        let err = stash.put_away(&req, T0 + 2).unwrap_err();
        assert!(err.contains("in the trash"), "{err}");
        let after = stash.get(&note.id).unwrap();
        assert_eq!((after.stashed_at, after.deleted_at), (None, Some(T0 + 1)));
        assert!(after.tags.is_empty());
        assert_eq!(
            rows(&stash, "entries"),
            1,
            "the good path was rolled back too"
        );
    }

    #[test]
    fn a_file_stores_its_repository_name_when_put_away() {
        // Roadmap A3: stored at put-away time so SQL can filter by repo; NULL
        // outside a repository (the file's own folder is not a repo tag).
        let (mut stash, root) = stash_in("put-repo");
        let repo = root.join("work/proj");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::write(repo.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let inside = user_file(&root, "proj/docs/a.md", "a");
        let loose = user_file(&root, "loose.md", "l");
        let r = stash.put_away(&put(vec![inside, loose]), T0).unwrap();
        assert_eq!(stored_repo(&stash, &r[0].entry.id).as_deref(), Some("proj"));
        assert_eq!(stored_repo(&stash, &r[1].entry.id), None);
        let e = &r[0].entry;
        assert_eq!(
            (e.repo.as_deref(), e.branch.as_deref()),
            (Some("proj"), Some("main"))
        );
    }

    #[test]
    fn a_second_put_away_refreshes_a_files_repo_but_not_a_notes() {
        let (mut stash, root) = stash_in("put-repo-again");
        let file = user_file(&root, "later/a.md", "a");
        let first = stash.put_away(&put(vec![file.clone()]), T0).unwrap();
        assert_eq!(stored_repo(&stash, &first[0].entry.id), None);
        fs::create_dir_all(root.join("work/later/.git")).unwrap();
        fs::write(root.join("work/later/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        stash.put_away(&put(vec![file]), T0 + 1).unwrap();
        assert_eq!(
            stored_repo(&stash, &first[0].entry.id).as_deref(),
            Some("later")
        );

        let note = stash
            .create_note("# Заметка", Some("couplet"), T0, MSK)
            .unwrap();
        stash
            .put_away(&put(vec![note.path.clone()]), T0 + 2)
            .unwrap();
        assert_eq!(stored_repo(&stash, &note.id).as_deref(), Some("couplet"));
    }

    #[test]
    fn tags_have_one_spelling() {
        assert_eq!(normalize_tag("#Infra").unwrap().as_deref(), Some("infra"));
        assert_eq!(normalize_tag("  ИНФРА ").unwrap().as_deref(), Some("инфра"));
        assert_eq!(normalize_tag("##x").unwrap().as_deref(), Some("x"));
        assert_eq!(normalize_tag("#").unwrap(), None);
        assert_eq!(normalize_tag("").unwrap(), None);
        assert!(normalize_tag("two words").is_err());
        assert!(normalize_tag(&"t".repeat(TAG_MAX_CHARS + 1)).is_err());
        assert_eq!(
            normalize_tags(&["A".into(), "#a".into(), "b".into()]).unwrap(),
            vec!["a", "b"]
        );
    }

    #[test]
    fn tags_are_added_and_removed_in_one_spelling() {
        let (mut stash, _root) = stash_in("tag");
        let note = stash.create_note("x", None, T0, MSK).unwrap();
        let e = stash
            .tag(&note.id, &["#Infra".into(), "ИДЕИ".into()], &[])
            .unwrap();
        assert_eq!(e.tags, vec!["infra", "идеи"]);
        let e = stash
            .tag(&note.id, &["later".into()], &["#INFRA".into()])
            .unwrap();
        assert_eq!(e.tags, vec!["later", "идеи"]);
        assert!(stash.tag(&note.id, &["two words".into()], &[]).is_err());
        assert_eq!(
            stash.get(&note.id).unwrap().tags,
            vec!["later", "идеи"],
            "a refused call changes nothing"
        );
    }

    #[test]
    fn remove_wins_over_add_in_one_call() {
        // Plan D8: `add` runs before `remove`.
        let (mut stash, _root) = stash_in("tag-both");
        let note = stash.create_note("x", None, T0, MSK).unwrap();
        let e = stash.tag(&note.id, &["x".into()], &["x".into()]).unwrap();
        assert!(e.tags.is_empty());
    }

    #[test]
    fn tagging_an_unknown_entry_is_an_error() {
        let (mut stash, _root) = stash_in("tag-unknown");
        assert_eq!(
            stash.tag("s1-dead", &["a".into()], &[]).unwrap_err(),
            "no stash entry s1-dead"
        );
        assert_eq!(rows(&stash, "tags"), 0);
    }

    #[test]
    fn tagging_a_trashed_entry_is_refused() {
        // Roadmap A8, stage 06 D18: a trashed row is inert.
        let (mut stash, _root) = stash_in("tag-trashed");
        let note = stash.create_note("# Удалённая", None, T0, MSK).unwrap();
        stash.tag(&note.id, &["keep".into()], &[]).unwrap();
        set_columns(&stash, &note.id, &format!("deleted_at = {}", T0 + 1));
        let err = stash
            .tag(&note.id, &["new".into()], &["keep".into()])
            .unwrap_err();
        assert_eq!(err, format!("in the trash: {}", note.id));
        assert_eq!(stash.get(&note.id).unwrap().tags, vec!["keep"]);
    }

    #[test]
    fn opening_from_the_stash_is_remembered() {
        let (mut stash, root) = stash_in("opened");
        let file = user_file(&root, "a.md", "a");
        let id = stash
            .put_away(&put(vec![file.clone()]), T0)
            .unwrap()
            .remove(0)
            .entry
            .id;
        assert!(stash.touch_opened(&file, T0 + 10).unwrap());
        assert_eq!(stash.get(&id).unwrap().opened_at, Some(T0 + 10));
        let other = root.join("work/other.md").to_string_lossy().into_owned();
        assert!(
            !stash.touch_opened(&other, T0).unwrap(),
            "not a stash entry"
        );
    }

    #[test]
    fn saving_a_note_updates_its_title_and_time() {
        let (mut stash, _root) = stash_in("written");
        let note = stash.create_note("# Old", None, T0, MSK).unwrap();
        assert!(
            stash
                .file_written(&note.path, "# New\nbody", T0 + 10)
                .unwrap(),
            "title changed"
        );
        let e = stash.get(&note.id).unwrap();
        assert_eq!((e.title.as_deref(), e.modified_at), (Some("New"), T0 + 10));
        assert!(
            !stash
                .file_written(&note.path, "# New\nmore body", T0 + 20)
                .unwrap(),
            "same title: no event"
        );
        assert_eq!(stash.get(&note.id).unwrap().modified_at, T0 + 20);
        assert!(
            !stash.file_written(&note.path, "# Stale", T0 + 15).unwrap(),
            "an older save landing late changes nothing"
        );
        let e = stash.get(&note.id).unwrap();
        assert_eq!((e.title.as_deref(), e.modified_at), (Some("New"), T0 + 20));
    }

    #[test]
    fn saving_a_file_reference_keeps_its_file_name_as_title() {
        // Plan D18.
        let (mut stash, root) = stash_in("written-file");
        let file = user_file(&root, "readme.md", "# Heading");
        let id = stash
            .put_away(&put(vec![file.clone()]), T0)
            .unwrap()
            .remove(0)
            .entry
            .id;
        assert!(!stash
            .file_written(&file, "# Another heading", Y2100)
            .unwrap());
        let e = stash.get(&id).unwrap();
        assert_eq!(e.title.as_deref(), Some("readme.md"));
        assert_eq!(e.modified_at, Y2100);
    }

    /// 2100-01-01: later than any real mtime `put_away` records.
    const Y2100: i64 = 4_102_444_800_000;

    #[test]
    fn saving_a_file_outside_the_stash_changes_nothing() {
        let (mut stash, root) = stash_in("written-none");
        let file = user_file(&root, "x.md", "x");
        assert!(!stash.file_written(&file, "y", T0).unwrap());
        assert_eq!(rows(&stash, "entries"), 0);
    }

    #[test]
    fn saving_a_trashed_note_does_not_touch_its_row() {
        // Roadmap A8, stage 06 D18: opening `.trash/x.md` by hand and saving it
        // must not bump a trashed row's time or title.
        let (mut stash, _root) = stash_in("written-trashed");
        let note = stash.create_note("# Old", None, T0, MSK).unwrap();
        set_columns(&stash, &note.id, &format!("deleted_at = {}", T0 + 1));
        assert!(!stash.file_written(&note.path, "# New", T0 + 10).unwrap());
        let e = stash.get(&note.id).unwrap();
        assert_eq!((e.title.as_deref(), e.modified_at), (Some("Old"), T0));
    }
}
