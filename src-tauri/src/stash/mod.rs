//! The stash (тайник): everything the human put away or typed without a file
//! name, kept durably. SQLite (`stash.db` in the app data directory) is the
//! source of truth for entries, tags and times; note text lives in plain `.md`
//! files under `~/<product>/` (`~/couplet/`, dev `~/couplet-dev/`), addressed
//! by path, so every file-tab mechanism works on notes unchanged. Spec:
//! `docs/superpowers/specs/2026-09-26-stash-design.md`; contracts:
//! `docs/superpowers/plans/2026-09-27-stash-00-roadmap.md`.

mod backup;
mod clock;
mod db;
mod entries;
mod ids;
mod notes;
mod paths;

pub use paths::StashPaths;

use std::fs;
use std::path::PathBuf;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// What an entry is: a note couplet owns, or a reference to the user's file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StashKind {
    Note,
    File,
}

impl StashKind {
    pub fn as_str(self) -> &'static str {
        match self {
            StashKind::Note => "note",
            StashKind::File => "file",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "note" => Some(StashKind::Note),
            "file" => Some(StashKind::File),
            _ => None,
        }
    }
}

/// One stash entry as the frontend and agents see it (roadmap `StashEntry`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub id: String,
    pub kind: StashKind,
    pub path: String,
    /// `None` → the UI's localized «Без названия». Stored as `''` (roadmap A4).
    pub title: Option<String>,
    /// Notes: the stored window project name. Files: derived git toplevel name.
    pub repo: Option<String>,
    /// Files only, derived at read time.
    pub branch: Option<String>,
    /// Without `#`, alphabetical; the repo tag is not one of them.
    pub tags: Vec<String>,
    pub created_at: i64,
    pub modified_at: i64,
    pub stashed_at: Option<i64>,
    pub opened_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub caret: i64,
    pub top_line: i64,
    /// First ~400 characters of the text; `""` when unreadable.
    pub preview: String,
}

/// `stash_put_away`'s arguments.
#[derive(Clone, Debug, Default)]
pub struct PutAway {
    pub paths: Vec<String>,
    /// Only with exactly one path.
    pub caret: Option<i64>,
    /// Only with exactly one path.
    pub top_line: Option<i64>,
    pub tags: Vec<String>,
}

/// One put-away path's outcome. `created == false`: it was already in the
/// stash (dedup hit) and was raised, re-tagged and re-positioned instead.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PutAwayResult {
    pub entry: StashEntry,
    pub created: bool,
}

/// `stash_list`'s sort (spec: «изменение ⌘L · открытие ⌘R · тип ⌘U»).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ListSort {
    /// `max(modified_at, stashed_at)` (roadmap A9).
    #[default]
    Changed,
    Opened,
    Kind,
}

/// `stash_list`'s arguments.
#[derive(Clone, Debug, Default)]
pub struct ListQuery {
    /// A project's directory name (a path is reduced to it, roadmap A3).
    pub repo: Option<String>,
    pub tag: Option<String>,
    pub kind: Option<StashKind>,
    /// Ignored with `deleted`: the trash is always newest deletion first.
    pub sort: ListSort,
    /// `true`: the trash (trashed notes only) instead of the stash (roadmap A8).
    pub deleted: bool,
    /// Only entries with `COALESCE(stashed_at, modified_at) >= since` (roadmap A9).
    pub since: Option<i64>,
    /// Default 50, clamped to 1..=500.
    pub limit: Option<usize>,
    /// Opaque: the previous page's `next_cursor`.
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub entries: Vec<StashEntry>,
    /// Matching entries across all pages.
    pub total: usize,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashCounts {
    pub total: usize,
    /// Put away since local midnight (roadmap A9).
    pub stashed_today: usize,
    /// Trashed notes, whatever the repo (roadmap A8).
    pub deleted: usize,
}

/// The stash: one database connection and where things live. Synchronous and
/// clock-free — callers pass `now` — so every behaviour is a plain unit test.
pub struct Stash {
    conn: Connection,
    paths: StashPaths,
    notes_dir_ready: bool,
}

impl Stash {
    /// Opens the database. Touches only the app data directory (plan D2).
    pub fn open(paths: StashPaths) -> Result<Self, String> {
        let conn = db::open(&paths.db_path)?;
        Ok(Self { conn, paths, notes_dir_ready: false })
    }

    /// The notes folder, created and put in its one spelling
    /// (`path_norm`, the spelling `OpenFiles` and the `path` column use) the
    /// first time anything needs it.
    fn notes_dir(&mut self) -> Result<PathBuf, String> {
        if !self.notes_dir_ready {
            fs::create_dir_all(&self.paths.notes_dir)
                .map_err(|e| format!("cannot create {}: {e}", self.paths.notes_dir.display()))?;
            self.paths = self
                .paths
                .with_notes_dir(crate::path_norm::normalize_path(&self.paths.notes_dir));
            self.notes_dir_ready = true;
        }
        Ok(self.paths.notes_dir.clone())
    }
}

#[cfg(test)]
pub(crate) mod testkit {
    use super::*;
    use std::path::Path;

    /// 2026-09-26 02:15 in Moscow (+03:00).
    pub(crate) const T0: i64 = 1_790_378_100_000;
    pub(crate) const MSK: i64 = 10_800;

    /// `root/home` stands for the user's home (roadmap A1: notes live in
    /// `~/<product>/`), `root/data` for the app data directory.
    pub(crate) fn paths_in(root: &Path) -> StashPaths {
        StashPaths::from_bases(&root.join("home"), &root.join("data"), "couplet-test")
    }

    pub(crate) fn stash_in(tag: &str) -> (Stash, PathBuf) {
        let root = crate::atomic_write::testkit::scratch(&format!("stash-{tag}"));
        (Stash::open(paths_in(&root)).unwrap(), root)
    }

    /// A user's file outside the notes folder, in its normalized spelling.
    pub(crate) fn user_file(root: &Path, rel: &str, text: &str) -> String {
        let path = root.join("work").join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
        crate::path_norm::normalize_str(&path.to_string_lossy())
    }

    pub(crate) fn rows(stash: &Stash, table: &str) -> i64 {
        stash
            .conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    /// Sets columns of one entry directly, for tests that need exact times.
    pub(crate) fn set_columns(stash: &Stash, id: &str, assignments: &str) {
        stash
            .conn
            .execute(&format!("UPDATE entries SET {assignments} WHERE id = ?1"), [id])
            .unwrap();
    }
}

#[cfg(test)]
mod fts_probe {
    //! Search (stage 05) depends on FTS5 and its `trigram` tokenizer being
    //! compiled into the bundled SQLite. This test is what fails if a
    //! `rusqlite` bump ever builds it without them.

    use rusqlite::Connection;

    fn hits(conn: &Connection, query: &str) -> Vec<i64> {
        let mut stmt = conn
            .prepare("SELECT rowid FROM probe WHERE probe MATCH ?1 ORDER BY rowid")
            .unwrap();
        stmt.query_map([query], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn bundled_sqlite_has_fts5_with_the_trigram_tokenizer() {
        let conn = Connection::open_in_memory().unwrap();
        let version: String = conn
            .query_row("SELECT sqlite_version()", [], |r| r.get(0))
            .unwrap();
        let fts5: i64 = conn
            .query_row("SELECT sqlite_compileoption_used('ENABLE_FTS5')", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(fts5, 1, "SQLite {version} was built without FTS5");

        conn.execute_batch(
            "CREATE VIRTUAL TABLE probe USING fts5(title, body, tokenize = 'trigram');",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO probe (rowid, title, body) VALUES \
             (1, 'Где ключ', 'Ключ лежит в тайнике у двери'), \
             (2, 'Документ', 'план переезда')",
            [],
        )
        .unwrap();

        assert_eq!(
            hits(&conn, "\"тайник\""),
            vec![1],
            "a word form: «тайник» inside «тайнике»"
        );
        assert_eq!(
            hits(&conn, "\"мент\""),
            vec![2],
            "a piece from the middle of a word"
        );
        assert_eq!(
            hits(&conn, "\"ТАЙНИК\""),
            vec![1],
            "case-insensitive for Cyrillic"
        );
    }
}
