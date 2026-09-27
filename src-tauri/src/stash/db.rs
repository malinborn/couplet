//! The stash database: opening it, its pragmas, forward-only migrations keyed
//! on `PRAGMA user_version`, and the row type. The app, the CLI and the MCP
//! server all open this file (stage 07), concurrently: WAL, a 5 s busy
//! timeout, and migrations that re-read the version under a write lock.
//!
//! A file that cannot be opened is never renamed, removed or rewritten here:
//! the caller reports the stash unavailable and the file stays as evidence.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, Row, TransactionBehavior};

use super::StashKind;

pub(crate) const SCHEMA_VERSION: i64 = 1;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// `MIGRATIONS[i]` takes the schema from version `i` to `i + 1`. Append only:
/// a released migration is never edited, because databases that already ran
/// it will never run it again.
const MIGRATIONS: [&str; 1] = [V1];

/// Schema v1, exactly the roadmap's (its `PRAGMA` lines live in `configure`:
/// they are per connection, not per schema).
const V1: &str = "
CREATE TABLE entries (
  rowid        INTEGER PRIMARY KEY,
  id           TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL CHECK (kind IN ('note','file')),
  path         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  repo         TEXT,
  created_at   INTEGER NOT NULL,
  modified_at  INTEGER NOT NULL,
  stashed_at   INTEGER,
  opened_at    INTEGER,
  deleted_at   INTEGER,
  caret        INTEGER NOT NULL DEFAULT 0,
  top_line     INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE tags (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  PRIMARY KEY (entry_id, tag)
);
CREATE VIRTUAL TABLE entries_fts USING fts5(
  title, body,
  tokenize = 'trigram'
);
";

pub(crate) fn err(e: rusqlite::Error) -> String {
    format!("stash database: {e}")
}

/// Opens (creating if needed) and migrates the database at `path`.
pub(crate) fn open(path: &Path) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let mut conn = Connection::open(path).map_err(err)?;
    configure(&conn)?;
    migrate(&mut conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<(), String> {
    // First: switching to WAL takes a lock, which may have to wait.
    conn.busy_timeout(BUSY_TIMEOUT).map_err(err)?;
    // Before the journal-mode switch, which writes the file header: a newer
    // build's database (or a file that is not a database at all) is refused
    // without a single byte of it changed. `migrate` checks again under the
    // write lock; this early read is only about not touching the file.
    refuse_newer(user_version(conn)?)?;
    let mode: String = conn
        .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
        .map_err(err)?;
    if !mode.eq_ignore_ascii_case("wal") {
        eprintln!(
            "stash: journal_mode is {mode}, not wal — the app and the CLI will block each other more"
        );
    }
    // NORMAL, not FULL: in WAL a commit is then durable once the WAL is
    // checkpointed, not at every commit — a power cut can lose the last few
    // metadata updates, never corrupt the file. The metadata is recoverable
    // (the notes are their own files), and the save hook commits on every
    // autosave: FULL would add an fsync to each one.
    conn.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")
        .map_err(err)
}

fn user_version(conn: &Connection) -> Result<i64, String> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(err)
}

/// Never downgrade: an older build must not write a schema it does not know.
fn refuse_newer(current: i64) -> Result<(), String> {
    if current > SCHEMA_VERSION {
        return Err(format!(
            "stash.db has schema {current}, this build knows up to {SCHEMA_VERSION}: it was written by a newer couplet"
        ));
    }
    Ok(())
}

/// One step per transaction, the version read under the write lock: two
/// processes opening a fresh file at once must not both run `V1`.
pub(crate) fn migrate(conn: &mut Connection) -> Result<(), String> {
    loop {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let current = user_version(&tx)?;
        refuse_newer(current)?;
        if current == SCHEMA_VERSION {
            return tx.commit().map_err(err);
        }
        let step =
            usize::try_from(current).map_err(|_| format!("stash.db has schema {current}"))?;
        tx.execute_batch(MIGRATIONS[step]).map_err(err)?;
        tx.execute_batch(&format!("PRAGMA user_version = {};", current + 1))
            .map_err(err)?;
        tx.commit().map_err(err)?;
    }
}

/// One `entries` row as stored. `title` is `''` for "no title".
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct EntryRow {
    pub rowid: i64,
    pub id: String,
    pub kind: StashKind,
    pub path: String,
    pub title: String,
    pub repo: Option<String>,
    pub created_at: i64,
    pub modified_at: i64,
    pub stashed_at: Option<i64>,
    pub opened_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub caret: i64,
    pub top_line: i64,
}

/// The column list `entry_row` reads, in its order.
pub(crate) const ENTRY_COLUMNS: &str =
    "rowid, id, kind, path, title, repo, created_at, modified_at, stashed_at, opened_at, deleted_at, caret, top_line";

pub(crate) fn entry_row(r: &Row<'_>) -> rusqlite::Result<EntryRow> {
    let kind: String = r.get(2)?;
    Ok(EntryRow {
        rowid: r.get(0)?,
        id: r.get(1)?,
        kind: StashKind::parse(&kind).ok_or_else(|| {
            rusqlite::Error::InvalidColumnType(2, "kind".into(), rusqlite::types::Type::Text)
        })?,
        path: r.get(3)?,
        title: r.get(4)?,
        repo: r.get(5)?,
        created_at: r.get(6)?,
        modified_at: r.get(7)?,
        stashed_at: r.get(8)?,
        opened_at: r.get(9)?,
        deleted_at: r.get(10)?,
        caret: r.get(11)?,
        top_line: r.get(12)?,
    })
}

/// Every entry's tags, alphabetical, keyed by entry id.
pub(crate) fn all_tags(conn: &Connection) -> Result<HashMap<String, Vec<String>>, String> {
    let mut stmt = conn
        .prepare("SELECT entry_id, tag FROM tags ORDER BY entry_id, tag")
        .map_err(err)?;
    let pairs = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for (id, tag) in pairs {
        out.entry(id).or_default().push(tag);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atomic_write::testkit::scratch;
    use std::path::PathBuf;

    fn db_in(tag: &str) -> PathBuf {
        scratch(tag).join("data").join("stash.db")
    }

    fn one<T: rusqlite::types::FromSql>(conn: &Connection, sql: &str) -> T {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    const INSERT_A: &str = "INSERT INTO entries \
        (id, kind, path, title, repo, created_at, modified_at, stashed_at, opened_at, deleted_at, caret, top_line) \
        VALUES ('s1-0001', 'note', '/n/a.md', 'A', 'proj', 1, 2, 3, 4, NULL, 5, 6)";

    #[test]
    fn a_fresh_database_gets_schema_v1_and_the_pragmas() {
        let conn = open(&db_in("db-fresh")).unwrap();
        assert_eq!(one::<i64>(&conn, "PRAGMA user_version"), SCHEMA_VERSION);
        assert_eq!(one::<String>(&conn, "PRAGMA journal_mode"), "wal");
        assert_eq!(one::<i64>(&conn, "PRAGMA foreign_keys"), 1);
        assert_eq!(one::<i64>(&conn, "PRAGMA busy_timeout"), 5000);
        assert_eq!(one::<i64>(&conn, "PRAGMA synchronous"), 1, "NORMAL");
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE name IN ('entries', 'tags', 'entries_fts') ORDER BY name")
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(names, ["entries", "entries_fts", "tags"]);
        assert_eq!(
            one::<i64>(&conn, "SELECT count(*) FROM entries_fts"),
            0,
            "stage 02 leaves the index empty"
        );
    }

    #[test]
    fn opening_twice_migrates_once() {
        let path = db_in("db-twice");
        let first = open(&path).unwrap();
        first.execute(INSERT_A, []).unwrap();
        let second = open(&path).unwrap();
        assert_eq!(one::<i64>(&second, "PRAGMA user_version"), SCHEMA_VERSION);
        assert_eq!(
            one::<i64>(&second, "SELECT count(*) FROM entries"),
            1,
            "the data survived"
        );
    }

    #[test]
    fn a_database_from_a_newer_build_is_refused_and_left_alone() {
        let path = db_in("db-newer");
        {
            let conn = open(&path).unwrap();
            conn.execute(INSERT_A, []).unwrap();
            // A header byte `open` would otherwise rewrite on its way in.
            conn.execute_batch("PRAGMA user_version = 7; PRAGMA journal_mode = DELETE;")
                .unwrap();
        }
        let err = open(&path).unwrap_err();
        assert!(err.contains("newer couplet"), "{err}");
        let conn = Connection::open(&path).unwrap();
        assert_eq!(one::<i64>(&conn, "PRAGMA user_version"), 7);
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM entries"), 1);
        assert_eq!(
            one::<String>(&conn, "PRAGMA journal_mode"),
            "delete",
            "not switched to WAL"
        );
    }

    #[test]
    fn processes_opening_a_fresh_file_at_once_all_get_v1() {
        let path = db_in("db-race");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let (path, barrier) = (path.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    open(&path).map(|c| one::<i64>(&c, "PRAGMA user_version"))
                })
            })
            .collect();
        for h in handles {
            assert_eq!(h.join().unwrap(), Ok(SCHEMA_VERSION));
        }
    }

    #[test]
    fn a_file_that_is_not_a_database_is_refused_and_left_alone() {
        let path = db_in("db-garbage");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let garbage = b"this is not an SQLite file, and it is evidence\n".repeat(200);
        std::fs::write(&path, &garbage).unwrap();
        assert!(open(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), garbage, "never rewritten");
        let mut names: Vec<String> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["stash.db"], "never renamed, no sibling created");
    }

    #[test]
    fn deleting_an_entry_takes_its_tags() {
        let conn = open(&db_in("db-cascade")).unwrap();
        conn.execute(INSERT_A, []).unwrap();
        conn.execute(
            "INSERT INTO tags (entry_id, tag) VALUES ('s1-0001', 'infra')",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM entries WHERE id = 's1-0001'", [])
            .unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM tags"), 0);
    }

    #[test]
    fn a_row_maps_every_column() {
        let conn = open(&db_in("db-row")).unwrap();
        conn.execute(INSERT_A, []).unwrap();
        let row = conn
            .query_row(
                &format!("SELECT {ENTRY_COLUMNS} FROM entries"),
                [],
                entry_row,
            )
            .unwrap();
        assert_eq!(
            row,
            EntryRow {
                rowid: 1,
                id: "s1-0001".into(),
                kind: StashKind::Note,
                path: "/n/a.md".into(),
                title: "A".into(),
                repo: Some("proj".into()),
                created_at: 1,
                modified_at: 2,
                stashed_at: Some(3),
                opened_at: Some(4),
                deleted_at: None,
                caret: 5,
                top_line: 6,
            }
        );
    }

    #[test]
    fn the_schema_refuses_an_unknown_kind() {
        let conn = open(&db_in("db-kind")).unwrap();
        let bad = INSERT_A.replace("'note'", "'folder'");
        assert!(conn.execute(&bad, []).is_err());
    }
}
