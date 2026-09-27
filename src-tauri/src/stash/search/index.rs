//! Keeps `entries_fts` in step with `entries` (rowid = entries.rowid). Every
//! write is an upsert by rowid: `INTEGER PRIMARY KEY` without AUTOINCREMENT
//! reuses the highest rowid after its row is deleted, so a stale FTS row must
//! never be able to attach itself to a new entry — hence `unindex_entry`
//! BEFORE any delete of an `entries` row. Searches JOIN `entries`, so an
//! orphan row is invisible until a rebuild sweeps it.
//!
//! Two rules shape the API:
//! - A trashed row (`deleted_at` set) never has an FTS row (A8). Every writer
//!   here checks it and drops a stale row instead of writing one.
//! - User files are never read while a write transaction — or the stash lock
//!   around the connection — is held (A11, stage 02 review I3): a file ref can
//!   sit on a slow volume. `load_body` reads with no connection at all; the
//!   functions that take a connection only write bodies they were given.

use rusqlite::functions::FunctionFlags;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::path::Path;

use super::text::{cap, is_markdown_path, plain_text, read_capped, Loaded};
use crate::stash::db::err;
use crate::stash::StashKind;

#[cfg(test)]
use super::text::BODY_CAP_BYTES;

/// A rebuild writes one transaction per chunk of this many rows, or fewer
/// once their bodies pass `REBUILD_CHUNK_BYTES`: between chunks the lock is
/// free for saves and stash commands, and memory stays bounded.
const REBUILD_CHUNK_ROWS: usize = 64;
const REBUILD_CHUNK_BYTES: usize = 8 * 1024 * 1024;

/// SQLite's own `lower()` and `LIKE` fold ASCII only; «ок» must find «ОК».
/// Registered by `stash::db::open` on every connection (app, CLI, MCP).
pub fn register_functions(conn: &Connection) -> rusqlite::Result<()> {
    conn.create_scalar_function(
        "stash_fold",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let s: Option<String> = ctx.get(0)?;
            Ok(s.map(|s| s.to_lowercase()))
        },
    )
}

/// What indexing needs to know about one `entries` row.
#[derive(Clone, Debug, PartialEq)]
pub struct LiveRow {
    pub rowid: i64,
    pub id: String,
    pub kind: StashKind,
    pub path: String,
    pub title: String,
    pub modified_at: i64,
    deleted: bool,
}

const ROW_COLUMNS: &str = "rowid, id, kind, path, title, modified_at, deleted_at IS NOT NULL";

fn live_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<LiveRow> {
    let kind: String = r.get(2)?;
    Ok(LiveRow {
        rowid: r.get(0)?,
        id: r.get(1)?,
        kind: StashKind::parse(&kind).ok_or_else(|| {
            rusqlite::Error::InvalidColumnType(2, "kind".into(), rusqlite::types::Type::Text)
        })?,
        path: r.get(3)?,
        title: r.get(4)?,
        modified_at: r.get(5)?,
        deleted: r.get(6)?,
    })
}

fn find(conn: &Connection, key_column: &str, key: &str) -> Result<Option<LiveRow>, String> {
    conn.query_row(
        &format!("SELECT {ROW_COLUMNS} FROM entries WHERE {key_column} = ?1"),
        [key],
        live_row,
    )
    .optional()
    .map_err(err)
}

fn is_markdown(kind: StashKind, path: &str) -> bool {
    kind == StashKind::Note || is_markdown_path(path)
}

/// The index body of the file at `path`: plain, from at most
/// `BODY_CAP_BYTES`. Binary or unreadable → `""` (found by title only),
/// never an error. Reads the disk: call it with no lock and no transaction.
pub fn load_body(path: &str, kind: StashKind) -> String {
    read_body(path, kind).unwrap_or_default()
}

/// `load_body`, except that an unreadable file (logged) is `None`: a writer
/// refreshing a row it already indexed keeps the body it has rather than
/// trade it for nothing — a put-away of a file iCloud evicted, say.
pub fn read_body(path: &str, kind: StashKind) -> Option<String> {
    read_saved(path).map(|text| plain_text(&text, is_markdown(kind, path)))
}

/// At most `BODY_CAP_BYTES` of the file at `path`, as text: `""` for a
/// binary file, `None` (logged) when it can't be read now. Not yet plain —
/// `reindex_path` makes it plain for the row's kind. Reads the disk: call it
/// with no lock and no transaction.
pub fn read_saved(path: &str) -> Option<String> {
    match read_capped(Path::new(path)) {
        Loaded::Text(text) => Some(text),
        Loaded::Binary => Some(String::new()),
        Loaded::Unreadable(why) => {
            eprintln!("stash search: {path} not read for the index: {why}");
            None
        }
    }
}

fn delete_row(conn: &Connection, rowid: i64) -> Result<(), String> {
    conn.execute("DELETE FROM entries_fts WHERE rowid = ?1", params![rowid])
        .map_err(err)?;
    Ok(())
}

/// FTS5 has no upsert: DELETE, then INSERT, by rowid.
pub fn upsert(conn: &Connection, rowid: i64, title: &str, body: &str) -> Result<(), String> {
    delete_row(conn, rowid)?;
    conn.execute(
        "INSERT INTO entries_fts (rowid, title, body) VALUES (?1, ?2, ?3)",
        params![rowid, title, body],
    )
    .map_err(err)?;
    Ok(())
}

/// `true` when `row` got `body`; a trashed row loses its FTS row instead.
fn write_row(conn: &Connection, row: &LiveRow, body: &str) -> Result<bool, String> {
    if row.deleted {
        delete_row(conn, row.rowid)?;
        return Ok(false);
    }
    upsert(conn, row.rowid, &row.title, body)?;
    Ok(true)
}

/// Index entry `id` with `body` (already plain — `load_body`, or a probe's
/// read) under its stored title. `Ok(false)`: no such entry, or it is
/// trashed. Callers treat an error as "search is stale", never as a failed
/// write: log it and carry on (plan D6).
pub fn write_body(conn: &Connection, id: &str, body: &str) -> Result<bool, String> {
    match find(conn, "id", id)? {
        Some(row) => write_row(conn, &row, body),
        None => Ok(false),
    }
}

/// Index entry `id` from `text`, its file's content held in memory (a note
/// just created or imported): no disk read. `Ok(false)` as `write_body`.
pub fn index_text(conn: &Connection, id: &str, text: &str) -> Result<bool, String> {
    let Some(row) = find(conn, "id", id)? else {
        return Ok(false);
    };
    let body = plain_text(cap(text), is_markdown(row.kind, &row.path));
    write_row(conn, &row, &body)
}

/// (Re)index entry `id` from its file on disk. Reads the file while given the
/// connection, which production never does (I3), hence test-only.
#[cfg(test)]
pub fn index_entry(conn: &Connection, id: &str) -> Result<(), String> {
    let row = find(conn, "id", id)?.ok_or_else(|| format!("no stash entry {id}"))?;
    let body = load_body(&row.path, row.kind);
    write_row(conn, &row, &body).map(|_| ())
}

/// Reindex the entry at `path` (already normalized, as stored) from `text`,
/// the content a save just wrote. `Ok(false)`: the path is not a live stash
/// entry. Reads `entries.title`, so call it after the caller's own
/// `title`/`modified_at` update.
pub fn reindex_path(conn: &Connection, path: &str, text: &str) -> Result<bool, String> {
    let Some(row) = find(conn, "path", path)? else {
        return Ok(false);
    };
    let body = plain_text(cap(text), is_markdown(row.kind, &row.path));
    write_row(conn, &row, &body)
}

/// Drop entry `id` from the index. Call it BEFORE deleting the `entries` row,
/// in the same transaction: afterwards its rowid can no longer be found.
pub fn unindex_entry(conn: &Connection, id: &str) -> Result<(), String> {
    if let Some(row) = find(conn, "id", id)? {
        delete_row(conn, row.rowid)?;
    }
    Ok(())
}

/// Every live entry, in rowid order: a rebuild's snapshot.
pub fn live_rows(conn: &Connection) -> Result<Vec<LiveRow>, String> {
    let mut st = conn
        .prepare(&format!(
            "SELECT {ROW_COLUMNS} FROM entries WHERE deleted_at IS NULL ORDER BY rowid"
        ))
        .map_err(err)?;
    let rows = st.query_map([], live_row).map_err(err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(err)
}

/// One rebuild chunk in one IMMEDIATE transaction (a deferred one fails at
/// once with SQLITE_BUSY_SNAPSHOT when another process wrote in between).
/// `rows[i]` gets `bodies[i]` only if it is still live with the same path
/// and `modified_at` as in the snapshot; otherwise whatever changed it has
/// indexed it itself. Returns how many rows were written.
pub fn write_chunk(
    conn: &Connection,
    rows: &[LiveRow],
    bodies: &[String],
) -> Result<usize, String> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(err)?;
    let mut written = 0;
    for (snap, body) in rows.iter().zip(bodies) {
        let Some(now) = find(&tx, "id", &snap.id)? else {
            continue;
        };
        if now.deleted || now.path != snap.path || now.modified_at != snap.modified_at {
            continue;
        }
        upsert(&tx, now.rowid, &now.title, body)?;
        written += 1;
    }
    tx.commit().map_err(err)?;
    Ok(written)
}

/// Drop every FTS row that has no live entry: orphans and trashed rows.
pub fn sweep_index(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "DELETE FROM entries_fts WHERE rowid NOT IN (SELECT rowid FROM entries WHERE deleted_at IS NULL)",
        [],
    )
    .map_err(err)?;
    Ok(())
}

/// Runs `f` on the stash's connection under the stash lock. A rebuild takes
/// the lock once per phase and never across a file read (A11, stage 02
/// review I3), so saves and stash commands wait for a chunk at most, not for
/// every file in the stash.
pub trait Locked {
    fn locked<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String>;
}

impl Locked for crate::stash::StashState {
    fn locked<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        self.with(|s| f(&s.conn))
    }
}

/// A bare connection is its own lock: nobody else holds it.
#[cfg(test)]
impl Locked for Connection {
    fn locked<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        f(self)
    }
}

/// Recreate the index from `entries` and their files: snapshot, then per
/// chunk read the files with the lock free and write them under it in one
/// transaction, then sweep. Returns how many entries were indexed. Deletes
/// nothing but FTS rows.
pub fn rebuild_index<L: Locked + ?Sized>(store: &L) -> Result<usize, String> {
    let rows = store.locked(live_rows)?;
    let mut indexed = 0;
    let mut start = 0;
    while start < rows.len() {
        let mut bodies = Vec::new();
        let mut bytes = 0;
        for row in &rows[start..] {
            if bodies.len() == REBUILD_CHUNK_ROWS || bytes >= REBUILD_CHUNK_BYTES {
                break;
            }
            let body = load_body(&row.path, row.kind);
            bytes += body.len();
            bodies.push(body);
        }
        let end = start + bodies.len();
        indexed += store.locked(|c| write_chunk(c, &rows[start..end], &bodies))?;
        start = end;
    }
    store.locked(sweep_index)?;
    Ok(indexed)
}

/// Bump when what the index stores changes (plain-text rules, the cap, the
/// columns): `ensure_index` then rebuilds every database on its next start.
pub const INDEX_VERSION: i64 = 1;

/// The roadmap's v1 DDL as `db.rs` spells it: `sqlite_master` keeps the
/// text, and a recreated table must be the same table.
const FTS_V1_DDL: &str = "CREATE VIRTUAL TABLE entries_fts USING fts5(
  title, body,
  tokenize = 'trigram'
)";

/// Index bookkeeping, like FTS5's own shadow tables — deliberately outside
/// the `user_version` migrations, so stages 06/07 never race it for a number.
const META_DDL: &str =
    "CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RebuildReason {
    Missing,
    Corrupt,
    Version,
    Stale,
}

/// Run once at startup, off the main thread. Rebuilds the index when it is
/// missing, fails FTS5's own integrity check, was built under another
/// `INDEX_VERSION`, or disagrees with the live entries in row count or by an
/// orphan row. Returns why it rebuilt, or `None`; the caller announces a
/// rebuild (`stash-changed`, reason `reindexed`, A6). The version is written
/// last, so a quit halfway through rebuilds again on the next start.
pub fn ensure_index<L: Locked + ?Sized>(store: &L) -> Result<Option<RebuildReason>, String> {
    let Some(reason) = store.locked(prepare)? else {
        return Ok(None);
    };
    rebuild_index(store)?;
    store.locked(|c| {
        c.execute(
            "INSERT INTO search_meta (key, value) VALUES ('index_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![INDEX_VERSION.to_string()],
        )
        .map_err(err)
    })?;
    Ok(Some(reason))
}

/// Diagnose, and recreate a missing or corrupt table, in one IMMEDIATE
/// transaction — another process (the CLI) diagnosing at the same time sees
/// either the old table or the new one. Only `entries_fts` is ever dropped.
fn prepare(conn: &Connection) -> Result<Option<RebuildReason>, String> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(err)?;
    tx.execute_batch(META_DDL).map_err(err)?;
    let reason = diagnose(&tx)?;
    match reason {
        Some(RebuildReason::Missing) => tx.execute_batch(FTS_V1_DDL).map_err(err)?,
        Some(RebuildReason::Corrupt) => {
            tx.execute_batch("DROP TABLE entries_fts").map_err(err)?;
            tx.execute_batch(FTS_V1_DDL).map_err(err)?;
        }
        Some(RebuildReason::Version | RebuildReason::Stale) | None => {}
    }
    tx.commit().map_err(err)?;
    Ok(reason)
}

fn diagnose(conn: &Connection) -> Result<Option<RebuildReason>, String> {
    let exists: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'entries_fts'",
            [],
            |r| r.get(0),
        )
        .map_err(err)?;
    if exists == 0 {
        return Ok(Some(RebuildReason::Missing));
    }
    if let Err(e) = conn.execute(
        "INSERT INTO entries_fts (entries_fts) VALUES ('integrity-check')",
        [],
    ) {
        // A busy database says nothing about the index: try again next start
        // rather than drop a good table.
        if matches!(
            e.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
        ) {
            return Err(err(e));
        }
        eprintln!("stash search: the index failed its integrity check: {e}");
        return Ok(Some(RebuildReason::Corrupt));
    }
    let version: Option<String> = conn
        .query_row(
            "SELECT value FROM search_meta WHERE key = 'index_version'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    if version.as_deref() != Some(INDEX_VERSION.to_string().as_str()) {
        return Ok(Some(RebuildReason::Version));
    }
    // Trashed rows count as missing from `entries` (A8): an FTS row for one
    // is stale.
    let (live, indexed, orphans): (i64, i64, i64) = conn
        .query_row(
            "SELECT (SELECT count(*) FROM entries WHERE deleted_at IS NULL),
                    (SELECT count(*) FROM entries_fts),
                    (SELECT count(*) FROM entries_fts
                      WHERE rowid NOT IN (SELECT rowid FROM entries WHERE deleted_at IS NULL))",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(err)?;
    if live != indexed || orphans > 0 {
        return Ok(Some(RebuildReason::Stale));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::super::test_support::db;
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::fs;

    #[test]
    fn index_entry_stores_the_title_and_the_plain_body() {
        let d = db("index-plain");
        let rowid = d.note("n1", "# Тайник\n\n- **ключ** от шкафа", 10);
        assert_eq!(
            d.fts_rows(),
            vec![(
                rowid,
                "Тайник".to_string(),
                "Тайник\nключ от шкафа".to_string()
            )]
        );
    }

    #[test]
    fn index_entry_is_idempotent() {
        let d = db("index-twice");
        d.note("n1", "один", 10);
        index_entry(&d.conn, "n1").unwrap();
        index_entry(&d.conn, "n1").unwrap();
        assert_eq!(d.fts_rows().len(), 1);
    }

    #[test]
    fn index_entry_rereads_the_file() {
        let d = db("index-reread");
        d.note("n1", "старое", 10);
        fs::write(d.path_of("n1"), "новое").unwrap();
        index_entry(&d.conn, "n1").unwrap();
        assert_eq!(d.fts_rows()[0].2, "новое");
    }

    #[test]
    fn index_entry_for_an_unknown_id_is_an_error() {
        let d = db("index-unknown");
        assert!(index_entry(&d.conn, "nope").is_err());
    }

    #[test]
    fn reindex_path_uses_the_given_text() {
        let d = db("reindex");
        d.note("n1", "старое", 10);
        let path = d.path_of("n1");
        assert_eq!(reindex_path(&d.conn, &path, "*новое* слово"), Ok(true));
        assert_eq!(d.fts_rows()[0].2, "новое слово");
    }

    #[test]
    fn reindex_path_ignores_a_path_that_is_not_in_the_stash() {
        let d = db("reindex-other");
        assert_eq!(
            reindex_path(&d.conn, "/tmp/not-stashed.md", "текст"),
            Ok(false)
        );
        assert!(d.fts_rows().is_empty());
    }

    #[test]
    fn reindex_path_caps_a_huge_save() {
        let d = db("reindex-huge");
        d.note("n1", "x", 10);
        let huge = "я".repeat(BODY_CAP_BYTES);
        reindex_path(&d.conn, &d.path_of("n1"), &huge).unwrap();
        assert!(d.fts_rows()[0].2.len() <= BODY_CAP_BYTES);
    }

    #[test]
    fn unindex_entry_removes_the_row_and_tolerates_unknown_ids() {
        let d = db("unindex");
        d.note("n1", "текст", 10);
        unindex_entry(&d.conn, "n1").unwrap();
        assert!(d.fts_rows().is_empty());
        unindex_entry(&d.conn, "nope").unwrap();
    }

    #[test]
    fn a_binary_file_is_indexed_by_its_title_only() {
        let d = db("binary");
        d.file("f1", "hdmi-schema.png", &[0x89, b'P', b'N', b'G', 0, 1], 10);
        let rows = d.fts_rows();
        assert_eq!(rows[0].1, "hdmi-schema.png");
        assert_eq!(rows[0].2, "");
    }

    #[test]
    fn a_vanished_file_is_indexed_by_its_title_and_does_not_fail() {
        let d = db("vanished");
        d.file("f1", "gone.md", b"text", 10);
        fs::remove_file(d.path_of("f1")).unwrap();
        index_entry(&d.conn, "f1").unwrap();
        assert_eq!(d.fts_rows()[0].2, "");
    }

    #[test]
    fn a_non_markdown_file_keeps_its_markers() {
        let d = db("code");
        d.file("f1", "setup.py", b"# configure hdmi\nx = 1", 10);
        assert_eq!(d.fts_rows()[0].2, "# configure hdmi\nx = 1");
    }

    #[test]
    fn rebuild_restores_exactly_what_incremental_indexing_built() {
        let d = db("rebuild");
        d.note("n1", "# Тайник\nключ", 10);
        d.note("n2", "документ", 20);
        d.file("f1", "notes.md", b"- hdmi", 30);
        fs::write(d.path_of("n2"), "документация").unwrap();
        reindex_path(&d.conn, &d.path_of("n2"), "документация").unwrap();
        let before = d.fts_rows();

        d.conn.execute("DELETE FROM entries_fts", []).unwrap();
        d.conn
            .execute(
                "INSERT INTO entries_fts (rowid, title, body) VALUES (9999, 'orphan', 'orphan')",
                [],
            )
            .unwrap();
        assert_eq!(rebuild_index(&d.conn).unwrap(), 3);
        assert_eq!(d.fts_rows(), before);
    }

    #[test]
    fn stash_fold_lowercases_cyrillic() {
        let d = db("fold");
        let folded: String = d
            .conn
            .query_row("SELECT stash_fold('ТАЙНИК Ok')", [], |r| r.get(0))
            .unwrap();
        assert_eq!(folded, "тайник ok");
    }

    // A8: a trashed row is never in the index, whoever writes its body.

    #[test]
    fn a_trashed_entry_is_never_indexed() {
        let d = db("trashed");
        d.note("n1", "тайник", 10);
        d.trash("n1");
        assert!(d.fts_rows().is_empty());
        index_entry(&d.conn, "n1").unwrap();
        assert_eq!(write_body(&d.conn, "n1", "тайник"), Ok(false));
        assert_eq!(reindex_path(&d.conn, &d.path_of("n1"), "тайник"), Ok(false));
        assert_eq!(rebuild_index(&d.conn).unwrap(), 0);
        assert!(d.fts_rows().is_empty());
    }

    #[test]
    fn writing_a_body_for_a_trashed_row_drops_its_stale_fts_row() {
        let d = db("trashed-stale");
        // Each note is trashed behind the index's back: its FTS row stays.
        d.note("n1", "тайник", 10);
        d.conn
            .execute("UPDATE entries SET deleted_at = 1 WHERE id = 'n1'", [])
            .unwrap();
        assert_eq!(reindex_path(&d.conn, &d.path_of("n1"), "тайник"), Ok(false));
        assert!(d.fts_rows().is_empty());

        d.note("n2", "ключ", 20);
        d.conn
            .execute("UPDATE entries SET deleted_at = 1 WHERE id = 'n2'", [])
            .unwrap();
        assert_eq!(write_body(&d.conn, "n2", "ключ"), Ok(false));
        assert!(d.fts_rows().is_empty());

        d.note("n3", "шкаф", 30);
        d.conn
            .execute("UPDATE entries SET deleted_at = 1 WHERE id = 'n3'", [])
            .unwrap();
        rebuild_index(&d.conn).unwrap();
        assert!(
            d.fts_rows().is_empty(),
            "the rebuild sweeps trashed rows too"
        );
    }

    #[test]
    fn write_body_upserts_a_live_row_and_ignores_an_unknown_id() {
        let d = db("write-body");
        let rowid = d.note("n1", "# Тайник\nстарое", 10);
        assert_eq!(write_body(&d.conn, "n1", "Тайник\nновое"), Ok(true));
        assert_eq!(
            d.fts_rows(),
            vec![(rowid, "Тайник".to_string(), "Тайник\nновое".to_string())]
        );
        assert_eq!(write_body(&d.conn, "nope", "текст"), Ok(false));
        assert_eq!(d.fts_rows().len(), 1);
    }

    #[test]
    fn load_body_is_markdown_for_notes_and_markdown_paths() {
        let d = db("load-body");
        let md = d.dir.join("a.md");
        let py = d.dir.join("a.py");
        fs::write(&md, "# Заголовок\n**жир**").unwrap();
        fs::write(&py, "# comment").unwrap();
        assert_eq!(
            load_body(&md.to_string_lossy(), StashKind::File),
            "Заголовок\nжир"
        );
        assert_eq!(
            load_body(&py.to_string_lossy(), StashKind::File),
            "# comment"
        );
        assert_eq!(load_body(&py.to_string_lossy(), StashKind::Note), "comment");
        assert_eq!(
            load_body(&d.dir.join("gone.md").to_string_lossy(), StashKind::Note),
            ""
        );
    }

    #[test]
    fn a_rebuild_chunk_skips_a_row_that_changed_since_its_snapshot() {
        let d = db("rebuild-moved");
        d.note("n1", "тайник", 10);
        d.note("n2", "ключ", 20);
        let rows = live_rows(&d.conn).unwrap();
        d.conn.execute("DELETE FROM entries_fts", []).unwrap();
        // A save stamped n1 after the snapshot; that save reindexes it itself.
        d.conn
            .execute("UPDATE entries SET modified_at = 11 WHERE id = 'n1'", [])
            .unwrap();
        let bodies: Vec<String> = rows.iter().map(|r| load_body(&r.path, r.kind)).collect();
        assert_eq!(write_chunk(&d.conn, &rows, &bodies), Ok(1));
        let fts = d.fts_rows();
        assert_eq!(fts.len(), 1);
        assert_eq!(fts[0].2, "ключ");
    }

    fn indexed_count(d: &super::super::test_support::Db) -> i64 {
        d.conn
            .query_row("SELECT count(*) FROM entries_fts", [], |r| r.get(0))
            .unwrap()
    }

    fn fts_ddl(conn: &Connection) -> String {
        conn.query_row(
            "SELECT sql FROM sqlite_master WHERE name = 'entries_fts'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn first_run_has_no_version_and_rebuilds() {
        let d = db("ensure-first");
        d.note("n1", "тайник", 10);
        d.conn.execute("DELETE FROM entries_fts", []).unwrap();
        assert_eq!(ensure_index(&d.conn), Ok(Some(RebuildReason::Version)));
        assert_eq!(indexed_count(&d), 1);
        assert_eq!(
            ensure_index(&d.conn),
            Ok(None),
            "a second run finds nothing to do"
        );
    }

    #[test]
    fn a_dropped_table_is_recreated_and_rebuilt() {
        let d = db("ensure-missing");
        d.note("n1", "тайник", 10);
        ensure_index(&d.conn).unwrap();
        let v1 = fts_ddl(&d.conn);
        d.conn.execute_batch("DROP TABLE entries_fts").unwrap();
        assert_eq!(ensure_index(&d.conn), Ok(Some(RebuildReason::Missing)));
        assert_eq!(indexed_count(&d), 1);
        let hits: i64 = d
            .conn
            .query_row(
                "SELECT count(*) FROM entries_fts WHERE entries_fts MATCH '\"тайн\"'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "the recreated table uses the trigram tokenizer");
        assert_eq!(fts_ddl(&d.conn), v1, "the recreated table is the v1 table");
    }

    #[test]
    fn a_corrupt_index_is_dropped_and_rebuilt() {
        let d = db("ensure-corrupt");
        d.note("n1", "тайник", 10);
        ensure_index(&d.conn).unwrap();
        let v1 = fts_ddl(&d.conn);
        // The segment b-tree and the structure record live here.
        d.conn.execute("DELETE FROM entries_fts_data", []).unwrap();
        assert_eq!(ensure_index(&d.conn), Ok(Some(RebuildReason::Corrupt)));
        assert_eq!(indexed_count(&d), 1);
        assert_eq!(fts_ddl(&d.conn), v1);
        assert_eq!(ensure_index(&d.conn), Ok(None));
    }

    #[test]
    fn rebuilding_never_touches_entries_tags_or_files() {
        let d = db("ensure-hands-off");
        d.note("n1", "# Тайник\nключ", 10);
        d.tag("n1", "infra");
        ensure_index(&d.conn).unwrap();
        d.conn.execute("DELETE FROM entries_fts_data", []).unwrap();
        let entries = |c: &Connection| -> Vec<(String, String, i64)> {
            let mut st = c
                .prepare("SELECT id, title, modified_at FROM entries ORDER BY rowid")
                .unwrap();
            let rows = st
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap();
            rows.collect::<Result<Vec<_>, _>>().unwrap()
        };
        let before = entries(&d.conn);
        assert_eq!(ensure_index(&d.conn), Ok(Some(RebuildReason::Corrupt)));
        assert_eq!(entries(&d.conn), before);
        let tags: i64 = d
            .conn
            .query_row("SELECT count(*) FROM tags", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tags, 1);
        assert_eq!(
            fs::read_to_string(d.path_of("n1")).unwrap(),
            "# Тайник\nключ"
        );
    }

    #[test]
    fn another_index_version_rebuilds() {
        let d = db("ensure-version");
        d.note("n1", "тайник", 10);
        ensure_index(&d.conn).unwrap();
        d.conn
            .execute(
                "UPDATE search_meta SET value = '0' WHERE key = 'index_version'",
                [],
            )
            .unwrap();
        assert_eq!(ensure_index(&d.conn), Ok(Some(RebuildReason::Version)));
        assert_eq!(ensure_index(&d.conn), Ok(None));
    }

    #[test]
    fn an_unindexed_entry_or_an_orphan_row_is_stale() {
        let d = db("ensure-stale");
        d.note("n1", "тайник", 10);
        ensure_index(&d.conn).unwrap();

        d.conn
            .execute(
                "INSERT INTO entries (id, kind, path, title, created_at, modified_at) VALUES ('raw', 'note', '/nowhere.md', 'raw', 1, 1)",
                [],
            )
            .unwrap();
        assert_eq!(ensure_index(&d.conn), Ok(Some(RebuildReason::Stale)));
        assert_eq!(indexed_count(&d), 2);

        d.conn
            .execute("DELETE FROM entries WHERE id = 'raw'", [])
            .unwrap();
        assert_eq!(
            ensure_index(&d.conn),
            Ok(Some(RebuildReason::Stale)),
            "the orphan row"
        );
        assert_eq!(indexed_count(&d), 1);
    }

    #[test]
    fn a_trashed_row_still_in_the_index_is_stale() {
        let d = db("ensure-trashed");
        d.note("n1", "тайник", 10);
        d.note("n2", "ключ", 20);
        ensure_index(&d.conn).unwrap();
        // Trashed behind the index's back (A8): its FTS row stays.
        d.conn
            .execute("UPDATE entries SET deleted_at = 1 WHERE id = 'n1'", [])
            .unwrap();
        assert_eq!(ensure_index(&d.conn), Ok(Some(RebuildReason::Stale)));
        assert_eq!(d.fts_rows().len(), 1);
        assert_eq!(d.fts_rows()[0].2, "ключ");
    }

    /// A `Locked` that counts its calls and runs `between` just before call
    /// number `at` — a write landing while `ensure_index` has the lock free.
    struct Probe<'a> {
        conn: &'a Connection,
        calls: Cell<usize>,
        at: usize,
        between: RefCell<Option<Box<dyn FnOnce(&Connection) + 'a>>>,
    }

    impl<'a> Probe<'a> {
        fn new(conn: &'a Connection) -> Self {
            Self {
                conn,
                calls: Cell::new(0),
                at: 0,
                between: RefCell::new(None),
            }
        }
    }

    impl Locked for Probe<'_> {
        fn locked<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
            self.calls.set(self.calls.get() + 1);
            if self.calls.get() == self.at {
                if let Some(write) = self.between.borrow_mut().take() {
                    write(self.conn);
                }
            }
            f(self.conn)
        }
    }

    #[test]
    fn a_save_while_the_files_are_read_is_not_overwritten() {
        let d = db("ensure-interleaved");
        d.note("n1", "старое", 10);
        let path = d.path_of("n1");
        d.conn.execute("DELETE FROM entries_fts", []).unwrap();
        let mut probe = Probe::new(&d.conn);
        // Lock calls: 1 diagnose, 2 snapshot, 3 first chunk. Before 3 the
        // body of n1 has already been read, outside the lock.
        probe.at = 3;
        let save_path = path.clone();
        probe.between = RefCell::new(Some(Box::new(move |c: &Connection| {
            fs::write(&save_path, "новое").unwrap();
            c.execute("UPDATE entries SET modified_at = 11 WHERE id = 'n1'", [])
                .unwrap();
            reindex_path(c, &save_path, "новое").unwrap();
        })));
        assert_eq!(ensure_index(&probe), Ok(Some(RebuildReason::Version)));
        assert_eq!(d.fts_rows()[0].2, "новое");
    }

    #[test]
    fn a_rebuild_takes_the_lock_once_per_phase_and_chunk() {
        let d = db("ensure-chunks");
        for i in 0..=REBUILD_CHUNK_ROWS {
            d.note(&format!("n{i}"), &format!("заметка {i}"), 10);
        }
        d.conn.execute("DELETE FROM entries_fts", []).unwrap();
        let probe = Probe::new(&d.conn);
        assert_eq!(ensure_index(&probe), Ok(Some(RebuildReason::Version)));
        // diagnose, snapshot, two chunks, sweep, version.
        assert_eq!(probe.calls.get(), 6);
        assert_eq!(indexed_count(&d), REBUILD_CHUNK_ROWS as i64 + 1);
    }

    #[test]
    fn ensure_index_runs_through_the_stash_lock() {
        let root = crate::atomic_write::testkit::scratch("ensure-state");
        let state = crate::stash::StashState::open(Ok(crate::stash::testkit::paths_in(&root)));
        let note = state
            .with(|s| s.create_note("# Тайник\nключ", None, crate::stash::testkit::T0, 0))
            .unwrap();
        assert_eq!(ensure_index(&state), Ok(Some(RebuildReason::Version)));
        let body: String = state
            .with(|s| {
                s.conn
                    .query_row(
                        "SELECT f.body FROM entries_fts f JOIN entries e ON e.rowid = f.rowid WHERE e.id = ?1",
                        [&note.id],
                        |r| r.get(0),
                    )
                    .map_err(err)
            })
            .unwrap();
        assert_eq!(body, "Тайник\nключ");
        assert_eq!(ensure_index(&state), Ok(None));
    }

    #[test]
    fn a_reused_rowid_does_not_inherit_the_old_text() {
        let d = db("rowid-reuse");
        let rowid = d.note("n1", "секрет", 10);
        unindex_entry(&d.conn, "n1").unwrap();
        d.conn
            .execute("DELETE FROM entries WHERE id = 'n1'", [])
            .unwrap();
        let again = d.note("n2", "другое", 20);
        assert_eq!(again, rowid, "SQLite reuses the highest rowid");
        assert_eq!(
            d.fts_rows(),
            vec![(rowid, "другое".to_string(), "другое".to_string())]
        );
    }
}
