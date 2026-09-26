//! The stash (тайник): everything the human put away or typed without a file
//! name, kept durably. SQLite (`stash.db` in the app data directory) is the
//! source of truth for entries, tags and times; note text lives in plain `.md`
//! files under `~/<product>/` (`~/couplet/`, dev `~/couplet-dev/`), addressed
//! by path, so every file-tab mechanism works on notes unchanged. Spec:
//! `docs/superpowers/specs/2026-09-26-stash-design.md`; contracts:
//! `docs/superpowers/plans/2026-09-27-stash-00-roadmap.md`.

mod backup;
mod clock;
pub(crate) mod commands;
mod db;
mod entries;
mod ids;
mod notes;
mod paths;

pub use paths::StashPaths;

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

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

    /// The notes folder in the same one spelling, for comparing a path
    /// against — never created: putting a file away must neither make the
    /// folder appear nor fail because something else sits at its name.
    fn notes_dir_spelling(&self) -> PathBuf {
        if self.notes_dir_ready {
            self.paths.notes_dir.clone()
        } else {
            crate::path_norm::normalize_path(&self.paths.notes_dir)
        }
    }
}

/// Emitted once with `app.emit` after a write that changed the stash — a
/// window's emit is a broadcast (CLAUDE.md), so never per window.
pub const STASH_CHANGED: &str = "stash-changed";

/// `stash-changed`'s payload (roadmap A6). `reason` is one of the roadmap's
/// list (`created`, `put-away`, `title`, `tagged`, …); `ids` is left out of
/// the JSON when the emitter does not know which entries changed.
#[derive(Clone, Debug, Serialize)]
pub struct StashChanged {
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ids: Option<Vec<String>>,
}

impl StashChanged {
    pub fn new(reason: &str, ids: Option<Vec<String>>) -> Self {
        Self {
            reason: reason.to_string(),
            ids,
        }
    }
}

/// The one place that emits `stash-changed`. Best effort: the write it
/// reports has already happened, and a window that missed the event reloads
/// on its next stash open.
pub fn emit_changed(app: &AppHandle, reason: &str, ids: Option<Vec<String>>) {
    let _ = app.emit(STASH_CHANGED, StashChanged::new(reason, ids));
}

/// The Tauri-managed stash. `Err` holds why it could not open (plan D11):
/// the app runs on, every command answers with the reason, the database file
/// is left as it was.
///
/// Lock order (roadmap A11): this mutex is taken with no other lock held —
/// never while holding `OpenFiles`, `PendingFiles` or `ClosedStack` — and
/// nothing inside a `with` call takes one of those.
#[derive(Clone)]
pub struct StashState(Arc<Mutex<Result<Stash, String>>>);

impl StashState {
    pub fn open(paths: Result<StashPaths, String>) -> Self {
        let stash = paths.and_then(Stash::open);
        if let Err(e) = &stash {
            eprintln!("stash: unavailable: {e}");
        }
        Self(Arc::new(Mutex::new(stash)))
    }

    /// Runs `f` on the stash under its lock. Blocking (SQLite waits up to its
    /// busy timeout for the CLI or MCP): call it on the blocking pool, never
    /// across an `await`. A panic inside an earlier call poisons nothing that
    /// matters: its transaction rolled back when it was dropped.
    pub fn with<T>(&self, f: impl FnOnce(&mut Stash) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_mut() {
            Ok(stash) => f(stash),
            Err(e) => Err(format!("stash unavailable: {e}")),
        }
    }

    pub fn is_available(&self) -> bool {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).is_ok()
    }

    /// Today's backup, off the launch path (plan D12).
    pub fn backup_in_background(&self) {
        let state = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let now = clock::now_ms();
            let offset = clock::local_offset_secs(now.div_euclid(1000));
            if let Err(e) = state.with(|s| s.daily_backup(now, offset)) {
                eprintln!("stash: backup: {e}");
            }
        });
    }
}

type Notify = Box<dyn Fn(&str) + Send + Sync>;

struct WriteHook {
    state: StashState,
    notify: Notify,
}

/// Process-wide, so `commands::write_file` keeps its signature (and its tests)
/// and still reaches the stash (plan D9).
static WRITE_HOOK: OnceLock<WriteHook> = OnceLock::new();

/// Installs the save hook once. `notify` receives the event reason when a
/// save changed what the stash shows. `false`: one was already installed.
pub fn install_write_hook(
    state: StashState,
    notify: impl Fn(&str) + Send + Sync + 'static,
) -> bool {
    WRITE_HOOK
        .set(WriteHook {
            state,
            notify: Box::new(notify),
        })
        .is_ok()
}

/// Called by `write_file` after every successful save. Best effort and off
/// the save's thread: a busy database must never delay an autosave, and the
/// save has already succeeded whatever happens here. Notifies `title` only
/// when a note's title changed (roadmap A6) — autosave runs every 300 ms.
pub fn on_file_written(path: &str, text: &str) {
    let Some(hook) = WRITE_HOOK.get() else {
        return;
    };
    let now = clock::now_ms();
    let (path, text) = (path.to_owned(), text.to_owned());
    tauri::async_runtime::spawn_blocking(move || {
        match hook.state.with(|s| s.file_written(&path, &text, now)) {
            Ok(true) => (hook.notify)("title"),
            Ok(false) => {}
            Err(e) => eprintln!("stash: after saving {path}: {e}"),
        }
    });
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
mod tests {
    use super::*;
    use crate::atomic_write::testkit::scratch;

    #[test]
    fn an_unavailable_stash_answers_every_call_with_the_reason() {
        let state = StashState::open(Err("paths::init has not run".to_string()));
        assert!(!state.is_available());
        assert_eq!(
            state.with(|s| s.get("s1-0000")).unwrap_err(),
            "stash unavailable: paths::init has not run"
        );
    }

    #[test]
    fn a_database_that_will_not_open_is_left_alone() {
        let root = scratch("stash-bad-db");
        let paths = testkit::paths_in(&root);
        fs::create_dir_all(paths.db_path.parent().unwrap()).unwrap();
        fs::write(&paths.db_path, b"not a database, and it must survive").unwrap();
        let state = StashState::open(Ok(paths.clone()));
        assert!(!state.is_available());
        assert_eq!(
            fs::read(&paths.db_path).unwrap(),
            b"not a database, and it must survive"
        );
    }

    #[test]
    fn a_panic_inside_one_call_does_not_lock_the_stash_forever() {
        let root = scratch("stash-poison");
        let state = StashState::open(Ok(testkit::paths_in(&root)));
        let clone = state.clone();
        let _ =
            std::thread::spawn(move || clone.with(|_| -> Result<(), String> { panic!("boom") }))
                .join();
        assert!(state.with(|s| s.list(&ListQuery::default())).is_ok());
    }

    #[test]
    fn the_event_payload_omits_ids_it_does_not_have() {
        // Roadmap A6: `{ reason: string, ids?: string[] }`.
        let bare = serde_json::to_value(StashChanged::new("title", None)).unwrap();
        assert_eq!(bare, serde_json::json!({ "reason": "title" }));
        let with_ids =
            serde_json::to_value(StashChanged::new("tagged", Some(vec!["s1-0000".into()])))
                .unwrap();
        assert_eq!(
            with_ids,
            serde_json::json!({ "reason": "tagged", "ids": ["s1-0000"] })
        );
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
