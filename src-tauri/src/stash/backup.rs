//! Second copies of the stash's metadata (note text is already its own
//! `.md` files): a daily online backup of `stash.db` in the app data
//! directory, the 7 newest kept, and a plain `.stash-export.json` beside the
//! notes that a human can read without SQLite (spec «Хранение»).

use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::backup::{Backup, StepResult};
use rusqlite::Connection;
use serde::Serialize;

use crate::atomic_write::{self, NewFileMode};

use super::{clock, db, notes, Stash, StashKind};

pub(crate) const KEEP_BACKUPS: usize = 7;
const PAGES_PER_STEP: i32 = 1024;
/// Between two backup steps when the source is busy or locked by another
/// process (the CLI). Bounded, so a lock nobody releases fails this backup
/// instead of spinning a thread forever; the next write or launch retries.
const BUSY_PAUSE: Duration = Duration::from_millis(10);
const BUSY_RETRIES: u32 = 500;
const EXPORT_VERSION: u32 = 1;

pub(crate) fn backup_name(date: &str) -> String {
    format!("stash-{date}.db")
}

/// Exactly `stash-YYYY-MM-DD.db`: pruning never touches anything else.
fn is_backup_name(name: &str) -> bool {
    let Some(date) = name
        .strip_prefix("stash-")
        .and_then(|r| r.strip_suffix(".db"))
    else {
        return false;
    };
    date.len() == 10
        && date.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
}

/// Today's backup in `dir`, unless it exists. `Ok(None)`: nothing to do.
/// Lives in the app's own data directory, so `.tmp` + `rename` is enough
/// (CLAUDE.md: `atomic_write` is for the user's folders).
pub(crate) fn daily_backup(
    conn: &Connection,
    dir: &Path,
    date: &str,
) -> Result<Option<PathBuf>, String> {
    let target = dir.join(backup_name(date));
    if target.exists() {
        return Ok(None);
    }
    fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let tmp = dir.join(format!("{}.tmp", backup_name(date)));
    // A leftover is an unfinished copy from a crashed run, never a backup.
    let _ = fs::remove_file(&tmp);
    // 0600 before it is published: titles, paths and tags, like the export.
    let copied = copy_into(conn, &tmp).and_then(|()| {
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("cannot make {} private: {e}", tmp.display()))
    });
    if let Err(e) = copied {
        // Our own half-written temp; the database it was copied from is intact.
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    fs::rename(&tmp, &target).map_err(|e| format!("cannot publish {}: {e}", target.display()))?;
    prune(dir, KEEP_BACKUPS);
    Ok(Some(target))
}

/// The online backup API into `tmp`, then a single-file journal: the source
/// is WAL, and a backup must be one file that opens anywhere.
fn copy_into(conn: &Connection, tmp: &Path) -> Result<(), String> {
    let mut dst = Connection::open(tmp).map_err(db::err)?;
    {
        let backup = Backup::new(conn, &mut dst).map_err(db::err)?;
        let mut busy = 0;
        loop {
            match backup.step(PAGES_PER_STEP).map_err(db::err)? {
                StepResult::Done => break,
                StepResult::More => {}
                StepResult::Busy | StepResult::Locked => {
                    busy += 1;
                    if busy > BUSY_RETRIES {
                        return Err("stash database: busy for the whole backup".to_string());
                    }
                    std::thread::sleep(BUSY_PAUSE);
                }
                // `StepResult` is `#[non_exhaustive]`.
                _ => return Err("stash database: unknown backup step result".to_string()),
            }
        }
    }
    let mode: String = dst
        .query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))
        .map_err(db::err)?;
    if !mode.eq_ignore_ascii_case("delete") {
        return Err(format!("stash backup: journal_mode stayed {mode}"));
    }
    Ok(())
}

/// Removes all but the `keep` newest backups. Only regular files named exactly
/// `stash-YYYY-MM-DD.db` are candidates — never a `.tmp`, a stray file or a
/// directory someone put here.
fn prune(dir: &Path, keep: usize) {
    let Ok(read) = fs::read_dir(dir) else { return };
    let mut names: Vec<String> = read
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .filter(|n| is_backup_name(n))
        .collect();
    // The date is zero-padded, so names sort like dates.
    names.sort_unstable_by(|a, b| b.cmp(a));
    for old in names.into_iter().skip(keep) {
        if let Err(e) = fs::remove_file(dir.join(&old)) {
            eprintln!("stash: cannot prune backup {old}: {e}");
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Export {
    version: u32,
    exported_at: i64,
    entries: Vec<ExportEntry>,
}

/// The plain columns and tags; never a preview or any other note text.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportEntry {
    id: String,
    kind: StashKind,
    path: String,
    title: Option<String>,
    repo: Option<String>,
    tags: Vec<String>,
    created_at: i64,
    modified_at: i64,
    stashed_at: Option<i64>,
    opened_at: Option<i64>,
    deleted_at: Option<i64>,
    caret: i64,
    top_line: i64,
}

fn export_json(conn: &Connection, now: i64) -> Result<String, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM entries ORDER BY rowid",
            db::ENTRY_COLUMNS
        ))
        .map_err(db::err)?;
    let rows = stmt
        .query_map([], db::entry_row)
        .map_err(db::err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db::err)?;
    let mut tags: HashMap<String, Vec<String>> = db::all_tags(conn)?;
    let entries = rows
        .into_iter()
        .map(|r| ExportEntry {
            tags: tags.remove(&r.id).unwrap_or_default(),
            title: (!r.title.is_empty()).then_some(r.title),
            id: r.id,
            kind: r.kind,
            path: r.path,
            repo: r.repo,
            created_at: r.created_at,
            modified_at: r.modified_at,
            stashed_at: r.stashed_at,
            opened_at: r.opened_at,
            deleted_at: r.deleted_at,
            caret: r.caret,
            top_line: r.top_line,
        })
        .collect();
    serde_json::to_string_pretty(&Export {
        version: EXPORT_VERSION,
        exported_at: now,
        entries,
    })
    .map_err(|e| format!("cannot serialize the stash export: {e}"))
}

/// In the user's folder, so through `atomic_write`; reserved 0600 first like a
/// note (plan D3, D13), and `save` keeps that mode on every rewrite.
fn write_export(path: &Path, json: &str) -> Result<(), String> {
    match notes::reserve_private(path) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("cannot create {}: {e}", path.display())),
    }
    atomic_write::save(path, json, NewFileMode::Umask)
}

impl Stash {
    pub(crate) fn daily_backup(
        &self,
        now: i64,
        offset_secs: i64,
    ) -> Result<Option<PathBuf>, String> {
        daily_backup(
            &self.conn,
            &self.paths.backups_dir,
            &clock::local_date(now, offset_secs),
        )
    }

    /// Creates the notes folder when it is missing: the export is one of the
    /// two things allowed to (plan D2). Only a write command reaches this, so
    /// the folder never appears for a stash nobody has written to.
    pub(crate) fn export(&mut self, now: i64) -> Result<(), String> {
        self.notes_dir()?;
        let json = export_json(&self.conn, now)?;
        write_export(&self.paths.export_path, &json)
    }

    /// After every write command. Best effort: neither copy may fail the write
    /// that triggered it.
    pub(crate) fn after_write(&mut self, now: i64, offset_secs: i64) {
        if let Err(e) = self.export(now) {
            eprintln!("stash: export: {e}");
        }
        if let Err(e) = self.daily_backup(now, offset_secs) {
            eprintln!("stash: backup: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atomic_write::testkit::{mode_of, scratch};
    use crate::stash::testkit::*;

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_backup_is_a_readable_self_contained_copy() {
        let (mut stash, root) = stash_in("backup");
        let note = stash.create_note("# Keep", None, T0, MSK).unwrap();
        let made = stash
            .daily_backup(T0, MSK)
            .unwrap()
            .expect("first backup of the day");
        assert_eq!(made, root.join("data/stash-backups/stash-2026-09-26.db"));
        assert_eq!(
            names_in(&root.join("data/stash-backups")),
            ["stash-2026-09-26.db"],
            "no -wal, no .tmp"
        );
        let copy = Connection::open(&made).unwrap();
        let id: String = copy
            .query_row("SELECT id FROM entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(id, note.id);
    }

    #[test]
    fn a_backup_is_private() {
        let (stash, _root) = stash_in("backup-mode");
        let made = stash.daily_backup(T0, MSK).unwrap().unwrap();
        assert_eq!(mode_of(&made), 0o600, "titles and paths, like the export");
    }

    #[test]
    fn one_backup_a_day() {
        let (stash, _root) = stash_in("backup-daily");
        assert!(stash.daily_backup(T0, MSK).unwrap().is_some());
        assert!(
            stash.daily_backup(T0 + 3_600_000, MSK).unwrap().is_none(),
            "same local day"
        );
        assert!(
            stash.daily_backup(T0 + 86_400_000, MSK).unwrap().is_some(),
            "the next day"
        );
    }

    #[test]
    fn the_seven_newest_are_kept_and_nothing_else_is_touched() {
        let (stash, root) = stash_in("backup-prune");
        let dir = root.join("data/stash-backups");
        fs::create_dir_all(&dir).unwrap();
        for day in 10..=18 {
            fs::write(dir.join(format!("stash-2026-09-{day}.db")), "old").unwrap();
        }
        fs::write(dir.join("notes.txt"), "mine").unwrap();
        fs::write(dir.join("stash-2026-09-01.db.tmp"), "not a backup").unwrap();
        stash.daily_backup(T0, MSK).unwrap();
        assert_eq!(
            names_in(&dir),
            [
                "notes.txt",
                "stash-2026-09-01.db.tmp",
                "stash-2026-09-13.db",
                "stash-2026-09-14.db",
                "stash-2026-09-15.db",
                "stash-2026-09-16.db",
                "stash-2026-09-17.db",
                "stash-2026-09-18.db",
                "stash-2026-09-26.db",
            ]
        );
    }

    #[test]
    fn backup_names() {
        assert!(is_backup_name("stash-2026-09-26.db"));
        assert!(!is_backup_name("stash-2026-09-26.db.tmp"));
        assert!(!is_backup_name("stash-2026-9-26.db"));
        assert!(!is_backup_name("stash.db"));
        assert!(!is_backup_name("other-2026-09-26.db"));
    }

    #[test]
    fn the_export_is_plain_entries_and_tags() {
        let (mut stash, _root) = stash_in("export");
        let note = stash
            .create_note("# Экспорт\nтекст", Some("couplet"), T0, MSK)
            .unwrap();
        stash.tag(&note.id, &["infra".into()], &[]).unwrap();
        stash.export(T0).unwrap();
        let path = stash.paths.export_path.clone();
        assert_eq!(mode_of(&path), 0o600, "titles and paths are private");
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["version"], 1);
        assert_eq!(json["exportedAt"], T0);
        let e = &json["entries"][0];
        assert_eq!(e["id"], note.id.as_str());
        assert_eq!(e["path"], note.path.as_str());
        assert_eq!(e["title"], "Экспорт");
        assert_eq!(e["repo"], "couplet");
        assert_eq!(e["tags"], serde_json::json!(["infra"]));
        assert!(e.get("preview").is_none(), "no note text in the export");
    }

    #[test]
    fn after_write_survives_a_broken_backups_folder() {
        let (mut stash, root) = stash_in("after-write");
        stash.create_note("x", None, T0, MSK).unwrap();
        fs::write(
            root.join("data/stash-backups"),
            "a file where the folder should be",
        )
        .unwrap();
        stash.after_write(T0, MSK);
        assert!(
            stash.paths.export_path.exists(),
            "the export still happened"
        );
    }

    #[test]
    fn a_leftover_temp_from_a_crash_is_replaced() {
        let dir = scratch("backup-tmp");
        let (stash, _root) = stash_in("backup-tmp-db");
        fs::write(dir.join("stash-2026-09-26.db.tmp"), "half a backup").unwrap();
        let made = daily_backup(&stash.conn, &dir, "2026-09-26")
            .unwrap()
            .unwrap();
        assert!(Connection::open(&made)
            .unwrap()
            .query_row("SELECT count(*) FROM entries", [], |r| r.get::<_, i64>(0))
            .is_ok());
        assert!(!dir.join("stash-2026-09-26.db.tmp").exists());
    }

    #[test]
    fn only_regular_files_are_pruned() {
        let (stash, root) = stash_in("backup-prune-kinds");
        let dir = root.join("data/stash-backups");
        fs::create_dir_all(&dir).unwrap();
        for day in 10..=17 {
            fs::write(dir.join(format!("stash-2026-09-{day}.db")), "old").unwrap();
        }
        // Older than every real backup, so a name-only prune would take them.
        fs::create_dir_all(dir.join("stash-2026-01-01.db")).unwrap();
        fs::write(dir.join("stash-2026-01-01.db/inside"), "keep").unwrap();
        std::os::unix::fs::symlink(root.join("elsewhere"), dir.join("stash-2026-01-02.db"))
            .unwrap();
        stash.daily_backup(T0, MSK).unwrap();
        let names = names_in(&dir);
        assert!(
            names.contains(&"stash-2026-01-01.db".to_string()),
            "{names:?}"
        );
        assert!(
            names.contains(&"stash-2026-01-02.db".to_string()),
            "{names:?}"
        );
        assert!(dir.join("stash-2026-01-01.db/inside").exists());
        let files = names
            .iter()
            .filter(|n| n.as_str() > "stash-2026-09")
            .count();
        assert_eq!(files, KEEP_BACKUPS);
    }

    #[test]
    fn a_rewritten_export_stays_private_and_current() {
        let (mut stash, _root) = stash_in("export-again");
        stash.create_note("# Один", None, T0, MSK).unwrap();
        stash.export(T0).unwrap();
        stash.create_note("# Два", None, T0 + 1, MSK).unwrap();
        stash.export(T0 + 1).unwrap();
        let path = stash.paths.export_path.clone();
        assert_eq!(mode_of(&path), 0o600);
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["exportedAt"], T0 + 1);
        assert_eq!(json["entries"].as_array().unwrap().len(), 2);
    }
}
