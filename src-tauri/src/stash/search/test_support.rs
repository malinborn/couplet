//! A scratch stash database for the search tests. Rows go in through SQL
//! against the roadmap schema (a fixed contract), so these tests do not
//! depend on the shape of stage 02's entry API.

use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};

use crate::atomic_write::testkit::scratch;

pub struct Db {
    pub dir: PathBuf,
    pub conn: Connection,
}

pub fn db(tag: &str) -> Db {
    let dir = scratch(tag);
    let conn = crate::stash::db::open(&dir.join("stash.db")).expect("open stash db");
    Db { dir, conn }
}

impl Db {
    /// A note whose file holds `text`, indexed the way the app indexes it.
    /// `fresh` is its modified_at and stashed_at.
    pub fn note(&self, id: &str, text: &str, fresh: i64) -> i64 {
        self.note_in(id, text, fresh, None)
    }

    pub fn note_in(&self, id: &str, text: &str, fresh: i64, repo: Option<&str>) -> i64 {
        let path = self.dir.join(format!("{id}.md"));
        fs::write(&path, text).unwrap();
        let title = crate::stash::notes::title_of(text).unwrap_or_default();
        self.insert(id, "note", &path, &title, repo, fresh)
    }

    /// A file reference to `name` holding `bytes`; its title is the file name.
    pub fn file(&self, id: &str, name: &str, bytes: &[u8], fresh: i64) -> i64 {
        let path = self.dir.join(name);
        fs::write(&path, bytes).unwrap();
        self.insert(id, "file", &path, name, None, fresh)
    }

    pub fn path_of(&self, id: &str) -> String {
        self.conn
            .query_row("SELECT path FROM entries WHERE id = ?1", [id], |r| r.get(0))
            .unwrap()
    }

    pub fn tag(&self, id: &str, tag: &str) {
        self.conn
            .execute(
                "INSERT INTO tags (entry_id, tag) VALUES (?1, ?2)",
                params![id, tag],
            )
            .unwrap();
    }

    /// Trashes `id` the way stage 06 will (A8): out of the index first, then
    /// stamped. Without the unindex, trash tests would pass for the wrong
    /// reason.
    pub fn trash(&self, id: &str) {
        super::index::unindex_entry(&self.conn, id).unwrap();
        self.conn
            .execute("UPDATE entries SET deleted_at = 1 WHERE id = ?1", [id])
            .unwrap();
    }

    /// Every FTS row, in rowid order — the index's whole state.
    pub fn fts_rows(&self) -> Vec<(i64, String, String)> {
        let mut st = self
            .conn
            .prepare("SELECT rowid, title, body FROM entries_fts ORDER BY rowid")
            .unwrap();
        let rows = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        rows.collect::<Result<Vec<_>, _>>().unwrap()
    }

    fn insert(
        &self,
        id: &str,
        kind: &str,
        path: &Path,
        title: &str,
        repo: Option<&str>,
        fresh: i64,
    ) -> i64 {
        self.conn
            .execute(
                "INSERT INTO entries (id, kind, path, title, repo, created_at, modified_at, stashed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6)",
                params![id, kind, path.to_string_lossy(), title, repo, fresh],
            )
            .unwrap();
        let rowid = self.conn.last_insert_rowid();
        super::index::index_entry(&self.conn, id).unwrap();
        rowid
    }
}
