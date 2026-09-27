//! The stash database: opening it, its pragmas, forward-only migrations keyed
//! on `PRAGMA user_version`, and the row type. The app, the CLI and the MCP
//! server all open this file (stage 07), concurrently: WAL, a 5 s busy
//! timeout, and migrations that re-read the version under a write lock.
//!
//! A file that cannot be opened is never renamed, removed or rewritten here:
//! the caller reports the stash unavailable and the file stays as evidence.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::ErrorKind;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rusqlite::{Connection, ErrorCode, Row, TransactionBehavior};

use super::StashKind;

pub(crate) const SCHEMA_VERSION: i64 = 2;
pub(crate) const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
/// Between two tries of the WAL switch (`switch_to_wal`).
const WAL_RETRY_PAUSE: Duration = Duration::from_millis(5);

/// `MIGRATIONS[i]` takes the schema from version `i` to `i + 1`. Append only:
/// a released migration is never edited, because databases that already ran
/// it will never run it again.
const MIGRATIONS: [&str; 2] = [V1, V2];

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

/// Schema v2 (stash plan 03, A5): which untitled draft — by sidecar name and
/// content fingerprint — became which note. The draft importer's
/// idempotency: a draft seen again with the same content is not imported
/// twice. No `PRAGMA user_version` here: `migrate` sets it.
const V2: &str = "
CREATE TABLE draft_imports (
  source      TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  entry_id    TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (source, fingerprint)
);
";

pub(crate) fn err(e: rusqlite::Error) -> String {
    format!("stash database: {e}")
}

/// Why `open` failed. `Refused` is for good: a newer build's schema, or a
/// file that is not a database — no retry changes either, and the file is
/// never touched (plan D11). `Failed` may pass: a lock held past the busy
/// timeout, a folder that could not be created, a volume not mounted yet.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum OpenError {
    Refused(String),
    Failed(String),
}

impl OpenError {
    pub(crate) fn is_permanent(&self) -> bool {
        matches!(self, OpenError::Refused(_))
    }
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Refused(m) | OpenError::Failed(m) => f.write_str(m),
        }
    }
}

fn open_err(e: rusqlite::Error) -> OpenError {
    if e.sqlite_error_code() == Some(ErrorCode::NotADatabase) {
        OpenError::Refused(err(e))
    } else {
        OpenError::Failed(err(e))
    }
}

/// Opens (creating if needed) and migrates the database at `path`.
pub(crate) fn open(path: &Path) -> Result<Connection, OpenError> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)
            .map_err(|e| OpenError::Failed(format!("cannot create {}: {e}", dir.display())))?;
    }
    create_private(path)?;
    let mut conn = Connection::open(path).map_err(open_err)?;
    configure(&conn)?;
    migrate(&mut conn)?;
    // `stash_fold` backs short-query title matching; every connection needs it.
    crate::stash::search::register_functions(&conn).map_err(open_err)?;
    make_private(path);
    Ok(conn)
}

/// Titles, paths and tags are as private as the export (0600). Created here
/// before SQLite sees the path, because SQLite gives `-wal` and `-shm` the
/// database file's mode: a new stash is private from its first byte.
fn create_private(path: &Path) -> Result<(), OpenError> {
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
    {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(OpenError::Failed(format!(
            "cannot create {}: {e}",
            path.display()
        ))),
    }
}

/// A database a build before this one left readable, with whatever `-wal`
/// and `-shm` sit beside it, made 0600. Only after the open succeeded, so a
/// refused file keeps even its mode; best effort, since a stash that works
/// but stays readable beats one that refuses to open over a `chmod`.
fn make_private(path: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let file = PathBuf::from(format!("{}{suffix}", path.display()));
        let Ok(meta) = fs::metadata(&file) else {
            continue;
        };
        if meta.permissions().mode() & 0o777 == 0o600 {
            continue;
        }
        if let Err(e) = fs::set_permissions(&file, fs::Permissions::from_mode(0o600)) {
            eprintln!("stash: cannot make {} private: {e}", file.display());
        }
    }
}

fn configure(conn: &Connection) -> Result<(), OpenError> {
    // First: switching to WAL takes a lock, which may have to wait.
    conn.busy_timeout(BUSY_TIMEOUT).map_err(open_err)?;
    // Before the journal-mode switch, which writes the file header: a newer
    // build's database (or a file that is not a database at all) is refused
    // without a single byte of it changed. `migrate` checks again under the
    // write lock; this early read is only about not touching the file.
    refuse_newer(user_version(conn)?)?;
    let mode = switch_to_wal(conn)?;
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
        .map_err(open_err)
}

/// `PRAGMA journal_mode = WAL`, retried on `SQLITE_BUSY` for up to the busy
/// timeout. The busy handler cannot cover this statement: the switch reads
/// the header under a shared lock and then asks for an exclusive one, and
/// when two connections both hold the shared lock and both ask, SQLite
/// answers `SQLITE_BUSY` at once instead of calling the handler (waiting
/// could only deadlock). The failed statement has released its lock, so
/// starting it over is safe — and it is what lets several processes open a
/// fresh file at once (measured: 16 of 100 runs of the 8-thread race lost
/// one opener here).
fn switch_to_wal(conn: &Connection) -> Result<String, OpenError> {
    let deadline = Instant::now() + BUSY_TIMEOUT;
    loop {
        match conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0)) {
            Err(e)
                if e.sqlite_error_code() == Some(ErrorCode::DatabaseBusy)
                    && Instant::now() < deadline =>
            {
                std::thread::sleep(WAL_RETRY_PAUSE);
            }
            result => return result.map_err(open_err),
        }
    }
}

fn user_version(conn: &Connection) -> Result<i64, OpenError> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(open_err)
}

/// Never downgrade: an older build must not write a schema it does not know.
fn refuse_newer(current: i64) -> Result<(), OpenError> {
    if current > SCHEMA_VERSION {
        return Err(OpenError::Refused(format!(
            "stash.db has schema {current}, this build knows up to {SCHEMA_VERSION}: it was written by a newer couplet"
        )));
    }
    Ok(())
}

/// A plain read first: a database already at `SCHEMA_VERSION` — every open
/// but the very first — takes no write lock, so it opens while the CLI or the
/// MCP server is in the middle of a write. Only an older one is migrated, one
/// step per transaction, the version re-read under the write lock: two
/// processes opening a fresh file at once must not both run `V1`.
pub(crate) fn migrate(conn: &mut Connection) -> Result<(), OpenError> {
    let current = user_version(conn)?;
    refuse_newer(current)?;
    if current == SCHEMA_VERSION {
        return Ok(());
    }
    loop {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(open_err)?;
        let current = user_version(&tx)?;
        refuse_newer(current)?;
        if current == SCHEMA_VERSION {
            return tx.commit().map_err(open_err);
        }
        let step = usize::try_from(current)
            .map_err(|_| OpenError::Refused(format!("stash.db has schema {current}")))?;
        tx.execute_batch(MIGRATIONS[step]).map_err(open_err)?;
        tx.execute_batch(&format!("PRAGMA user_version = {};", current + 1))
            .map_err(open_err)?;
        tx.commit().map_err(open_err)?;
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
    fn a_fresh_database_gets_the_current_schema_and_the_pragmas() {
        let conn = open(&db_in("db-fresh")).unwrap();
        assert_eq!(one::<i64>(&conn, "PRAGMA user_version"), SCHEMA_VERSION);
        assert_eq!(one::<String>(&conn, "PRAGMA journal_mode"), "wal");
        assert_eq!(one::<i64>(&conn, "PRAGMA foreign_keys"), 1);
        assert_eq!(one::<i64>(&conn, "PRAGMA busy_timeout"), 5000);
        assert_eq!(one::<i64>(&conn, "PRAGMA synchronous"), 1, "NORMAL");
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE name IN ('entries', 'tags', 'entries_fts', 'draft_imports') ORDER BY name")
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(names, ["draft_imports", "entries", "entries_fts", "tags"]);
        assert_eq!(
            one::<i64>(&conn, "SELECT count(*) FROM entries_fts"),
            0,
            "stage 02 leaves the index empty"
        );
    }

    #[test]
    fn the_database_and_its_wal_are_private() {
        use crate::atomic_write::testkit::mode_of;
        let path = db_in("db-mode");
        let conn = open(&path).unwrap();
        conn.execute(INSERT_A, []).unwrap();
        let sibling = |suffix: &str| PathBuf::from(format!("{}{suffix}", path.display()));
        for p in [path.clone(), sibling("-wal"), sibling("-shm")] {
            assert_eq!(mode_of(&p), 0o600, "{}", p.display());
        }
    }

    #[test]
    fn an_existing_readable_database_is_made_private() {
        use crate::atomic_write::testkit::mode_of;
        let path = db_in("db-mode-old");
        drop(open(&path).unwrap());
        let sibling = |suffix: &str| PathBuf::from(format!("{}{suffix}", path.display()));
        // A 0644 database left by a build that did not restrict it, with its
        // WAL still beside it (another connection keeps it open).
        let keep = Connection::open(&path).unwrap();
        keep.execute(INSERT_A, []).unwrap();
        for p in [path.clone(), sibling("-wal"), sibling("-shm")] {
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        drop(open(&path).unwrap());
        for p in [path.clone(), sibling("-wal"), sibling("-shm")] {
            assert_eq!(mode_of(&p), 0o600, "{}", p.display());
        }
        drop(keep);
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
    fn a_fresh_database_is_at_version_2_with_draft_imports() {
        let conn = open(&db_in("db-v2")).unwrap();
        assert_eq!(one::<i64>(&conn, "PRAGMA user_version"), 2);
        conn.execute(
            "INSERT INTO draft_imports (source, fingerprint, entry_id, imported_at) \
             VALUES ('draft-1.md', 'f', 'nope', 1)",
            [],
        )
        .expect_err("entry_id must name an entry");
        conn.execute(INSERT_A, []).unwrap();
        conn.execute(
            "INSERT INTO draft_imports (source, fingerprint, entry_id, imported_at) \
             VALUES ('draft-1.md', 'f', 's1-0001', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO draft_imports (source, fingerprint, entry_id, imported_at) \
             VALUES ('draft-1.md', 'f', 's1-0001', 2)",
            [],
        )
        .expect_err("one row per (source, fingerprint)");
        conn.execute("DELETE FROM entries WHERE id = 's1-0001'", [])
            .unwrap();
        assert_eq!(
            one::<i64>(&conn, "SELECT count(*) FROM draft_imports"),
            0,
            "an import record goes with its entry"
        );
    }

    #[test]
    fn a_version_1_database_gains_draft_imports_and_keeps_its_rows() {
        let path = db_in("db-v1-to-v2");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        {
            // A stash exactly as a stage-02 build left it.
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(V1).unwrap();
            conn.execute_batch("PRAGMA user_version = 1;").unwrap();
            conn.execute(INSERT_A, []).unwrap();
        }
        let conn = open(&path).unwrap();
        assert_eq!(one::<i64>(&conn, "PRAGMA user_version"), 2);
        assert_eq!(
            one::<i64>(
                &conn,
                "SELECT count(*) FROM sqlite_master WHERE name = 'draft_imports'"
            ),
            1
        );
        assert_eq!(
            one::<i64>(&conn, "SELECT count(*) FROM entries"),
            1,
            "the data survived"
        );
    }

    #[test]
    fn a_database_one_version_ahead_is_refused() {
        let path = db_in("db-v3");
        {
            let conn = open(&path).unwrap();
            conn.execute_batch(&format!("PRAGMA user_version = {};", SCHEMA_VERSION + 1))
                .unwrap();
        }
        let err = open(&path).unwrap_err();
        assert!(err.is_permanent(), "{err}");
        assert!(err.to_string().contains("newer couplet"), "{err}");
        let conn = Connection::open(&path).unwrap();
        assert_eq!(
            one::<i64>(&conn, "PRAGMA user_version"),
            SCHEMA_VERSION + 1,
            "never downgraded"
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
        assert!(err.to_string().contains("newer couplet"), "{err}");
        assert!(err.is_permanent(), "no retry can make this build know v7");
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
    fn processes_opening_a_fresh_file_at_once_all_get_the_current_schema() {
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
    fn an_up_to_date_database_opens_while_another_connection_writes() {
        // The app opening while the CLI holds a write transaction (stage 07):
        // a database already at `SCHEMA_VERSION` needs no write lock to open.
        let path = db_in("db-writer");
        drop(open(&path).unwrap());
        let mut writer = Connection::open(&path).unwrap();
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        tx.execute(INSERT_A, []).unwrap();
        let started = std::time::Instant::now();
        let conn = open(&path).unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "did not wait for the writer: {:?}",
            started.elapsed()
        );
        assert_eq!(one::<i64>(&conn, "PRAGMA user_version"), SCHEMA_VERSION);
        tx.commit().unwrap();
    }

    #[test]
    fn a_lock_or_a_missing_folder_is_worth_retrying() {
        let root = scratch("db-retryable");
        std::fs::write(root.join("data"), "a file where the folder should be").unwrap();
        let err = open(&root.join("data").join("stash.db")).unwrap_err();
        assert!(!err.is_permanent(), "{err}");
    }

    #[test]
    fn a_file_that_is_not_a_database_is_refused_and_left_alone() {
        let path = db_in("db-garbage");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let garbage = b"this is not an SQLite file, and it is evidence\n".repeat(200);
        std::fs::write(&path, &garbage).unwrap();
        assert!(open(&path).unwrap_err().is_permanent());
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
