//! Untitled drafts become stash notes (stash plan 03, D11/D12; roadmap A13).
//!
//! Runs at every startup, after `StashState` exists and before the session
//! restore plans a window — idempotent through `draft_imports(source,
//! fingerprint)`, so a draft written later (a failed note birth, a
//! rolled-back build) is rescued on the next launch. Every sidecar directly
//! in `session/` is a candidate, whether the session names it or not;
//! `session/.trash/` never is. Per draft, in this order:
//!
//! 1. note file (never over an existing one), then its `entries` row and its
//!    `draft_imports` row in one IMMEDIATE transaction;
//! 2. the note read back and compared byte for byte with the draft;
//! 3. every tab naming the draft pointed at the note, and `session-v2.json`
//!    rewritten with the same `saved_at`;
//! 4. only then the draft moved into `session/.trash/` (hard link under a
//!    `.trashed-<secs>` name the 30-day purge knows, then unlink).
//!
//! A crash between any two steps leaves the text in at least two places, and
//! the next run finds the note through `draft_imports` instead of making a
//! second one. Steps run as batches (all imports, one session write, all
//! moves), which keeps that order for every draft and writes the session once.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{params, OptionalExtension, TransactionBehavior};

use super::{clock, db, entries, ids, notes, Stash, StashEntry};
use crate::session::{is_untitled_sidecar, Session};

/// Where drafts are read from, where a moved one goes, where the rewritten
/// `session-v2.json` is written.
pub(crate) struct DraftDirs<'a> {
    pub session_dir: &'a Path,
    pub trash_dir: &'a Path,
    pub data_dir: &'a Path,
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct ImportReport {
    /// Drafts that became a new note on this run.
    pub imported: usize,
    /// The entry ids of those notes, one per `imported` — what
    /// `stash-changed` (`imported`) names. A reused note is not here: it was
    /// made by an earlier run.
    pub ids: Vec<String>,
    /// Drafts whose note an earlier, interrupted run had already made.
    pub reused: usize,
    /// Drafts moved into `session/.trash/`.
    pub trashed: usize,
    /// Session tabs that now open a note instead of a draft.
    pub rewritten_tabs: usize,
    pub errors: Vec<String>,
}

struct Draft {
    name: String,
    path: PathBuf,
    text: String,
    mtime_ms: i64,
    fingerprint: String,
}

/// FNV-1a 64 of `bytes`, and their length — tells two contents of one
/// sidecar name apart (`untitled-main.md` was reused by every v1 launch). No
/// new dependency; stable across Rust releases, unlike `DefaultHasher`.
fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}-{}", bytes.len())
}

fn mtime_ms(path: &Path, fallback: i64) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(fallback)
}

/// The drafts directly in `dir` worth importing: a regular file (never
/// through a symlink) named like a sidecar, UTF-8, not blank. By name.
/// A blank draft holds nothing to keep; a non-UTF-8 one cannot be a note
/// without changing its bytes — both stay where they are.
fn scan(dir: &Path, now: i64, report: &mut ImportReport) -> Vec<Draft> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut drafts = Vec::new();
    for entry in read.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !is_untitled_sidecar(&name) {
            continue;
        }
        // `DirEntry::file_type` does not follow a symlink: a link is never
        // "a file", so neither it nor its target is read, imported or moved.
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                report.errors.push(format!("{name}: {e} — left in place"));
                continue;
            }
        };
        let Ok(text) = String::from_utf8(bytes) else {
            report
                .errors
                .push(format!("{name}: not UTF-8 — left in place"));
            continue;
        };
        if text.trim().is_empty() {
            continue;
        }
        let fingerprint = fingerprint(text.as_bytes());
        drafts.push(Draft {
            mtime_ms: mtime_ms(&path, now),
            name,
            path,
            text,
            fingerprint,
        });
    }
    drafts.sort_by(|a, b| a.name.cmp(&b.name));
    drafts
}

/// The project of the window whose tab holds draft `name` — stored as its
/// directory name by `insert_note_row` (A3). `None` for an orphaned draft.
fn project_of_draft(session: Option<&Session>, name: &str) -> Option<String> {
    session?
        .windows
        .iter()
        .find(|w| w.tabs.iter().any(|t| t.untitled.as_deref() == Some(name)))
        .and_then(|w| w.project.clone())
}

/// The note this very content of `draft` became on an earlier run, or a new
/// one — created at the draft's mtime, stashed then, recorded in
/// `draft_imports` in the same transaction. `true`: created now.
///
/// An earlier note is reused only while it is live and its file is there: a
/// note trashed in the stash or gone from disk no longer holds this text, and
/// the draft may be its only copy.
fn import_one(
    stash: &mut Stash,
    draft: &Draft,
    repo: Option<&str>,
    now: i64,
) -> Result<(StashEntry, bool), String> {
    let previous: Option<String> = stash
        .conn
        .query_row(
            "SELECT entry_id FROM draft_imports WHERE source = ?1 AND fingerprint = ?2",
            params![draft.name, draft.fingerprint],
            |r| r.get(0),
        )
        .optional()
        .map_err(db::err)?;
    if let Some(id) = previous {
        if let Ok(entry) = stash.get(&id) {
            if entry.deleted_at.is_none() && fs::symlink_metadata(&entry.path).is_ok() {
                return Ok((entry, false));
            }
        }
    }
    let at = draft.mtime_ms;
    let dir = stash.notes_dir()?;
    // `create_new`: never overwrites anything already in the folder.
    let path = notes::create_note_file(
        &dir,
        &draft.text,
        at,
        clock::local_offset_secs(at.div_euclid(1000)),
        ids::random16,
    )?;
    let path_buf = path;
    let path = path_buf.to_string_lossy().into_owned();
    match record_import(stash, &path, draft, repo, now) {
        Ok(id) => Ok((stash.get(&id)?, true)),
        // The draft is not moved, so its text is still there. The unrecorded
        // note file would be an orphan, and every launch with the cause still
        // present would add one more — so it goes, but only while the draft
        // provably still holds the very same text.
        Err(e) if drop_unrecorded_note(&path_buf, draft) => {
            Err(format!("not recorded in the stash: {e}"))
        }
        Err(e) => Err(format!(
            "note saved to {path} but not recorded in the stash: {e}"
        )),
    }
}

/// Removes `note`, a note file `import_one` just created and could not
/// record, only if both it and the draft it came from — each re-read now —
/// hold exactly the draft's text: the draft is then a full copy. Anything
/// else (the draft changed or gone, the note not what was written) keeps
/// the note. `true`: removed.
fn drop_unrecorded_note(note: &Path, draft: &Draft) -> bool {
    holds(note, &draft.text) && holds(&draft.path, &draft.text) && fs::remove_file(note).is_ok()
}

/// Step 1's transaction: the note's row, stashed at the draft's mtime, and
/// the import record — all or nothing.
fn record_import(
    stash: &mut Stash,
    path: &str,
    draft: &Draft,
    repo: Option<&str>,
    now: i64,
) -> Result<String, String> {
    let tx = stash
        .conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db::err)?;
    let id = entries::insert_note_row(&tx, path, &draft.text, repo, draft.mtime_ms)?;
    tx.execute(
        "UPDATE entries SET stashed_at = ?1 WHERE id = ?2",
        params![draft.mtime_ms, id],
    )
    .map_err(db::err)?;
    // REPLACE: a record naming a note that is trashed or gone (see
    // `import_one`) gives way to the new note.
    tx.execute(
        "INSERT OR REPLACE INTO draft_imports (source, fingerprint, entry_id, imported_at) \
         VALUES (?1, ?2, ?3, ?4)",
        params![draft.name, draft.fingerprint, id, now],
    )
    .map_err(db::err)?;
    tx.commit().map_err(db::err)?;
    Ok(id)
}

/// The note a draft `name` became on an earlier run, when that draft is gone
/// from `session/` — for a session that still names it (a v1 file written
/// by an older build after the import, say).
fn note_from_history(stash: &Stash, name: &str) -> Option<String> {
    let id: String = stash
        .conn
        .query_row(
            "SELECT entry_id FROM draft_imports WHERE source = ?1 \
             ORDER BY imported_at DESC, rowid DESC LIMIT 1",
            [name],
            |r| r.get(0),
        )
        .optional()
        .ok()??;
    let entry = stash.get(&id).ok()?;
    (entry.deleted_at.is_none() && Path::new(&entry.path).exists()).then_some(entry.path)
}

/// Whether `path` is a regular file holding exactly `text` — the note after
/// step 1 (does the copy hold the draft?) and the draft before step 4 (is it
/// still what was copied?).
fn holds(path: &Path, text: &str) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file())
        && fs::read(path).is_ok_and(|b| b == text.as_bytes())
}

/// Point every tab naming a draft in `notes` at its note, as a file tab
/// (same id, caret, times). Returns how many.
fn rewrite(session: &mut Session, notes: &HashMap<String, String>) -> usize {
    let mut n = 0;
    for tab in session.windows.iter_mut().flat_map(|w| w.tabs.iter_mut()) {
        let Some(note) = tab.untitled.as_ref().and_then(|name| notes.get(name)) else {
            continue;
        };
        tab.path = Some(note.clone());
        tab.untitled = None;
        n += 1;
    }
    n
}

/// The importer's core, on injected directories — see the module comment.
/// Returns the session the restore should plan from: `session` with every
/// tab of an imported draft opening its note.
pub(crate) fn import_drafts(
    stash: &mut Stash,
    dirs: &DraftDirs<'_>,
    session: Option<Session>,
    now: i64,
) -> (Option<Session>, ImportReport) {
    let mut report = ImportReport::default();
    let drafts = scan(dirs.session_dir, now, &mut report);

    // Steps 1-2. Draft name → note path, for drafts whose note reads back.
    let mut notes: HashMap<String, String> = HashMap::new();
    let mut verified: Vec<&Draft> = Vec::new();
    for draft in &drafts {
        let repo = project_of_draft(session.as_ref(), &draft.name);
        match import_one(stash, draft, repo.as_deref(), now) {
            Ok((entry, created)) => {
                if !holds(Path::new(&entry.path), &draft.text) {
                    report.errors.push(format!(
                        "{}: note {} does not read back as the draft — draft kept",
                        draft.name, entry.path
                    ));
                    continue;
                }
                if created {
                    report.imported += 1;
                    report.ids.push(entry.id.clone());
                } else {
                    report.reused += 1;
                }
                notes.insert(draft.name.clone(), entry.path);
                verified.push(draft);
            }
            Err(e) => report
                .errors
                .push(format!("{}: {e} — draft kept", draft.name)),
        }
    }
    if report.imported > 0 {
        stash.after_write(now, clock::local_offset_secs(now.div_euclid(1000)));
    }

    // Step 3. When the session file cannot be rewritten, the drafts it names
    // stay: the next launch reads that file, finds them and reuses their notes.
    let mut keep: HashSet<String> = HashSet::new();
    let mut session = session;
    if let Some(s) = session.as_mut() {
        let named: HashSet<String> = s
            .windows
            .iter()
            .flat_map(|w| w.tabs.iter())
            .filter_map(|t| t.untitled.clone())
            .collect();
        // Tabs naming a draft no longer in `session/`: an earlier run moved
        // it; its note is in `draft_imports`. Only sidecar names — the name
        // is joined onto `session_dir`.
        for name in &named {
            if notes.contains_key(name)
                || !is_untitled_sidecar(name)
                || name.contains('/')
                || fs::symlink_metadata(dirs.session_dir.join(name)).is_ok()
            {
                continue;
            }
            if let Some(note) = note_from_history(stash, name) {
                notes.insert(name.clone(), note);
            }
        }
        report.rewritten_tabs = rewrite(s, &notes);
        if report.rewritten_tabs > 0 {
            // Same `saved_at`: the rewrite must not out-date a newer
            // `session.json` (`choose_session` takes v2 on a tie).
            if let Err(e) = crate::session::write_session_in(dirs.data_dir, s) {
                report.errors.push(format!(
                    "session not rewritten, the drafts it names kept: {e}"
                ));
                keep = named;
            }
        }
    }

    // Step 4.
    let now_secs = u64::try_from(now.div_euclid(1000)).unwrap_or(0);
    for draft in verified {
        if keep.contains(&draft.name) {
            continue;
        }
        // Nothing writes `session/` before the first window, but the move
        // must never take text the note does not hold.
        if !holds(&draft.path, &draft.text) {
            report.errors.push(format!(
                "{}: changed since its import — left in place",
                draft.name
            ));
            continue;
        }
        match crate::session::move_to_trash(&draft.path, dirs.trash_dir, now_secs) {
            Ok(_) => report.trashed += 1,
            Err(e) => report
                .errors
                .push(format!("{}: {e} — left in place", draft.name)),
        }
    }
    (session, report)
}

/// `import_drafts` for the live app, in `setup`: after `StashState` is
/// managed, before `set_pending` — no window exists yet, so nothing writes
/// `session/` meanwhile and no other lock is held (A11). Never blocks
/// startup: without a stash, or on any failure, the session comes back as it
/// was read.
pub(crate) fn run_at_startup(app: &tauri::AppHandle, loaded: Option<Session>) -> Option<Session> {
    use tauri::Manager;
    let Some(state) = app.try_state::<super::StashState>() else {
        return loaded;
    };
    let (Ok(session_dir), Ok(trash_dir), Ok(data_dir)) = (
        crate::session::session_dir(),
        crate::session::drafts_trash_dir(),
        crate::paths::app_data_dir(),
    ) else {
        return loaded;
    };
    let dirs = DraftDirs {
        session_dir: &session_dir,
        trash_dir: &trash_dir,
        data_dir: &data_dir,
    };
    let backup = loaded.clone();
    // A panic here would come back on every launch — the drafts are still
    // there — so it must cost this launch's import, not the app.
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        state.with(|s| Ok(import_drafts(s, &dirs, loaded, clock::now_ms())))
    }));
    match outcome {
        Ok(Ok((session, report))) => {
            if report != ImportReport::default() {
                eprintln!(
                    "stash: drafts → notes: {} imported, {} reused, {} moved to session/.trash, {} tabs now open notes",
                    report.imported, report.reused, report.trashed, report.rewritten_tabs
                );
                for e in &report.errors {
                    eprintln!("stash: draft import: {e}");
                }
            }
            // Best effort: in `setup` no window listens yet, and a drawer
            // reads the stash when it opens anyway. The event is for any
            // listener that is already there.
            if !report.ids.is_empty() {
                super::emit_changed(app, "imported", Some(report.ids));
            }
            session
        }
        Ok(Err(e)) => {
            eprintln!("stash: draft import skipped: {e}");
            backup
        }
        Err(_) => {
            eprintln!("stash: draft import panicked; the session is restored as it was read");
            backup
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{
        parse_session, SessionState, TabSnapshot, WindowSnapshot, SESSION_VERSION,
    };
    use crate::stash::testkit::{rows, stash_in};
    use std::time::{Duration, SystemTime};

    const NOW: i64 = 1_790_000_000_000;
    const NOW_SECS: i64 = NOW / 1000;
    const MTIME: i64 = 1_780_000_000_000;

    struct Dirs {
        session: PathBuf,
        trash: PathBuf,
        data: PathBuf,
    }

    fn dirs(tag: &str) -> Dirs {
        let data = crate::atomic_write::testkit::scratch(&format!("drafts-{tag}"));
        let session = data.join("session");
        fs::create_dir_all(&session).unwrap();
        Dirs {
            trash: session.join(".trash"),
            session,
            data,
        }
    }

    fn draft_dirs(d: &Dirs) -> DraftDirs<'_> {
        DraftDirs {
            session_dir: &d.session,
            trash_dir: &d.trash,
            data_dir: &d.data,
        }
    }

    fn write_draft(d: &Dirs, name: &str, bytes: &[u8]) -> PathBuf {
        let path = d.session.join(name);
        fs::write(&path, bytes).unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH + Duration::from_millis(MTIME as u64))
            .unwrap();
        path
    }

    fn untitled(id: &str, name: &str) -> TabSnapshot {
        TabSnapshot {
            tab_id: id.into(),
            untitled: Some(name.into()),
            cursor: 3,
            top_line: 1,
            ..Default::default()
        }
    }

    fn window(project: Option<&str>, tabs: Vec<TabSnapshot>) -> WindowSnapshot {
        WindowSnapshot {
            number: Some(1),
            project: project.map(str::to_string),
            x: 0,
            y: 0,
            width: 900,
            height: 700,
            active_tab: tabs.first().map(|t| t.tab_id.clone()),
            tabs,
        }
    }

    fn one_window(project: Option<&str>, tabs: Vec<TabSnapshot>) -> Session {
        Session {
            version: SESSION_VERSION,
            saved_at: 42,
            windows: vec![window(project, tabs)],
        }
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .map(|r| {
                r.map(|e| e.unwrap().file_name().into_string().unwrap())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    fn session_on_disk(d: &Dirs) -> Session {
        parse_session(&fs::read_to_string(d.data.join("session-v2.json")).unwrap()).unwrap()
    }

    fn only_draft(d: &Dirs) -> Draft {
        let mut drafts = scan(&d.session, NOW, &mut ImportReport::default());
        assert_eq!(drafts.len(), 1);
        drafts.remove(0)
    }

    #[test]
    fn the_fingerprint_is_fnv1a_64_and_the_length() {
        assert_eq!(fingerprint(b"abc"), "e71fa2190541574b-3");
        assert_eq!(fingerprint(b""), "cbf29ce484222325-0");
    }

    #[test]
    fn a_referenced_draft_becomes_a_note_and_its_tab_opens_it() {
        let (mut stash, _root) = stash_in("drafts-ref");
        let d = dirs("ref");
        let src = write_draft(&d, "draft-1-2-3.md", "# План\nтекст".as_bytes());
        let session = one_window(Some("/p/proj"), vec![untitled("1-2-3", "draft-1-2-3.md")]);

        let (session, report) = import_drafts(&mut stash, &draft_dirs(&d), Some(session), NOW);

        assert_eq!(
            (report.imported, report.trashed, report.rewritten_tabs),
            (1, 1, 1),
            "{report:?}"
        );
        assert!(report.errors.is_empty(), "{report:?}");
        let tab = &session.as_ref().unwrap().windows[0].tabs[0];
        let note_path = tab.path.clone().expect("the tab names the note");
        assert_eq!(tab.untitled, None);
        assert_eq!(
            (tab.tab_id.as_str(), tab.cursor),
            ("1-2-3", 3),
            "the tab keeps its id and caret"
        );
        assert_eq!(fs::read(&note_path).unwrap(), "# План\nтекст".as_bytes());

        let entry = stash.entry_for_path(&note_path).unwrap().unwrap();
        assert_eq!(entry.kind, crate::stash::StashKind::Note);
        assert_eq!(entry.title.as_deref(), Some("План"));
        assert_eq!(
            entry.stashed_at,
            Some(MTIME),
            "stashed when the draft was last written"
        );
        assert_eq!(entry.created_at, MTIME);
        assert_eq!(
            entry.repo.as_deref(),
            Some("proj"),
            "the window's project, by its name (A3)"
        );
        assert_eq!(rows(&stash, "entries"), 1);
        assert_eq!(rows(&stash, "draft_imports"), 1);

        assert!(!src.exists(), "the source left session/");
        assert_eq!(
            names_in(&d.trash),
            vec![format!("draft-1-2-3.trashed-{NOW_SECS}.md")],
            "a stamped name the purge knows"
        );
        assert_eq!(
            fs::read(d.trash.join(format!("draft-1-2-3.trashed-{NOW_SECS}.md"))).unwrap(),
            "# План\nтекст".as_bytes(),
            "into the trash, intact"
        );

        let on_disk = session_on_disk(&d);
        assert_eq!(
            on_disk.saved_at, 42,
            "saved_at kept: the rewrite must not out-date a newer v1"
        );
        assert_eq!(
            on_disk.windows[0].tabs[0].path.as_deref(),
            Some(note_path.as_str())
        );
        assert_eq!(on_disk.windows[0].tabs[0].untitled, None);
    }

    #[test]
    fn an_orphaned_draft_is_imported_without_any_session() {
        let (mut stash, _root) = stash_in("drafts-orphan");
        let d = dirs("orphan");
        write_draft(&d, "untitled-main.md", b"old v1 draft");
        let (session, report) = import_drafts(&mut stash, &draft_dirs(&d), None, NOW);
        assert!(session.is_none());
        assert_eq!(
            (report.imported, report.trashed, report.rewritten_tabs),
            (1, 1, 0),
            "{report:?}"
        );
        assert_eq!(rows(&stash, "entries"), 1);
        let entry = stash.list(&Default::default()).unwrap().entries.remove(0);
        assert_eq!(fs::read(&entry.path).unwrap(), b"old v1 draft");
        assert_eq!(entry.repo, None, "no window, no project");
        assert_eq!(
            names_in(&d.trash),
            vec![format!("untitled-main.trashed-{NOW_SECS}.md")]
        );
        assert!(
            !d.data.join("session-v2.json").exists(),
            "no session, nothing to rewrite"
        );
    }

    #[test]
    fn an_orphaned_draft_beside_a_session_leaves_the_session_file_alone() {
        let (mut stash, _root) = stash_in("drafts-orphan-beside");
        let d = dirs("orphan-beside");
        write_draft(&d, "draft-7.md", b"nobody names me");
        let session = one_window(
            Some("/p/proj"),
            vec![TabSnapshot {
                tab_id: "1".into(),
                path: Some("/p/proj/a.md".into()),
                ..Default::default()
            }],
        );
        let (session, report) = import_drafts(&mut stash, &draft_dirs(&d), Some(session), NOW);
        assert_eq!(
            (report.imported, report.trashed, report.rewritten_tabs),
            (1, 1, 0),
            "{report:?}"
        );
        assert_eq!(
            session.unwrap().windows[0].tabs[0].path.as_deref(),
            Some("/p/proj/a.md")
        );
        let entry = stash.list(&Default::default()).unwrap().entries.remove(0);
        assert_eq!(entry.repo, None, "an orphan belongs to no window");
        assert!(
            !d.data.join("session-v2.json").exists(),
            "no tab changed, nothing written"
        );
    }

    #[test]
    fn blank_non_utf8_and_foreign_files_stay_where_they_are() {
        let (mut stash, _root) = stash_in("drafts-skip");
        let d = dirs("skip");
        write_draft(&d, "draft-a.md", b"");
        write_draft(&d, "draft-b.md", b"  \n\t ");
        write_draft(&d, "draft-c.md", &[0xff, 0xfe, 0x00]);
        write_draft(&d, "notes.md", b"not a sidecar");
        write_draft(&d, "draft-d.md.tmp", b"a temp file");
        let session = one_window(
            None,
            vec![untitled("a", "draft-a.md"), untitled("c", "draft-c.md")],
        );
        let (session, report) = import_drafts(&mut stash, &draft_dirs(&d), Some(session), NOW);
        assert_eq!(
            (report.imported, report.trashed, report.rewritten_tabs),
            (0, 0, 0),
            "{report:?}"
        );
        assert_eq!(rows(&stash, "entries"), 0);
        for name in [
            "draft-a.md",
            "draft-b.md",
            "draft-c.md",
            "notes.md",
            "draft-d.md.tmp",
        ] {
            assert!(d.session.join(name).exists(), "{name} untouched");
        }
        assert_eq!(
            fs::read(d.session.join("draft-c.md")).unwrap(),
            [0xff, 0xfe, 0x00]
        );
        let tabs = &session.unwrap().windows[0].tabs;
        assert_eq!(
            tabs[1].untitled.as_deref(),
            Some("draft-c.md"),
            "its tab still names it"
        );
        assert!(!d.trash.exists(), "nothing thrown away");
        assert_eq!(
            report.errors.len(),
            1,
            "only the non-UTF-8 draft is worth a line: {report:?}"
        );
    }

    #[test]
    fn a_symlinked_sidecar_is_not_followed() {
        let (mut stash, _root) = stash_in("drafts-link");
        let d = dirs("link");
        let target = d.data.join("elsewhere.md");
        fs::write(&target, b"someone else's text").unwrap();
        std::os::unix::fs::symlink(&target, d.session.join("draft-l.md")).unwrap();
        let (_, report) = import_drafts(&mut stash, &draft_dirs(&d), None, NOW);
        assert_eq!((report.imported, report.trashed), (0, 0));
        assert_eq!(rows(&stash, "entries"), 0);
        assert!(fs::symlink_metadata(d.session.join("draft-l.md"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&target).unwrap(), b"someone else's text");
    }

    #[test]
    fn the_trash_folder_is_never_imported() {
        let (mut stash, _root) = stash_in("drafts-trash-dir");
        let d = dirs("trash-dir");
        fs::create_dir_all(&d.trash).unwrap();
        fs::write(d.trash.join("draft-z.md"), b"thrown away").unwrap();
        fs::write(
            d.trash.join("draft-z.trashed-1700000000.md"),
            b"thrown away too",
        )
        .unwrap();
        let (_, report) = import_drafts(&mut stash, &draft_dirs(&d), None, NOW);
        assert_eq!(report, ImportReport::default());
        assert_eq!(rows(&stash, "entries"), 0);
        assert_eq!(
            names_in(&d.trash),
            vec!["draft-z.md", "draft-z.trashed-1700000000.md"]
        );
    }

    #[test]
    fn a_second_run_imports_nothing_again() {
        let (mut stash, _root) = stash_in("drafts-twice");
        let d = dirs("twice");
        write_draft(&d, "draft-1.md", b"once");
        let session = one_window(None, vec![untitled("1", "draft-1.md")]);
        let (session, first) = import_drafts(&mut stash, &draft_dirs(&d), Some(session), NOW);
        assert_eq!(first.imported, 1);
        let (_, again) = import_drafts(&mut stash, &draft_dirs(&d), session, NOW);
        assert_eq!(again, ImportReport::default());
        assert_eq!(rows(&stash, "entries"), 1);
        assert_eq!(rows(&stash, "draft_imports"), 1);
    }

    #[test]
    fn the_report_names_the_entries_it_imported_and_a_no_op_run_names_none() {
        let (mut stash, _root) = stash_in("drafts-ids");
        let d = dirs("ids");
        write_draft(&d, "draft-1.md", b"referenced");
        write_draft(&d, "untitled-main.md", b"orphaned");
        let session = one_window(None, vec![untitled("1", "draft-1.md")]);

        let (session, first) = import_drafts(&mut stash, &draft_dirs(&d), Some(session), NOW);

        let mut all: Vec<String> = stash
            .conn
            .prepare("SELECT id FROM entries")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        all.sort();
        let mut ids = first.ids.clone();
        ids.sort();
        assert_eq!(first.imported, 2, "{first:?}");
        assert_eq!(ids, all, "every entry made on this run, once each");

        let (_, again) = import_drafts(&mut stash, &draft_dirs(&d), session, NOW);
        assert!(again.ids.is_empty(), "{again:?}");
    }

    #[test]
    fn a_reused_note_is_not_reported_as_imported() {
        let (mut stash, _root) = stash_in("drafts-ids-reused");
        let d = dirs("ids-reused");
        write_draft(&d, "draft-9.md", b"half done");
        import_one(&mut stash, &only_draft(&d), None, NOW).unwrap();

        let (_, report) = import_drafts(&mut stash, &draft_dirs(&d), None, NOW);
        assert_eq!((report.imported, report.reused), (0, 1), "{report:?}");
        assert!(report.ids.is_empty(), "{report:?}");
    }

    #[test]
    fn a_run_cut_short_after_the_import_resumes_without_a_duplicate() {
        let (mut stash, _root) = stash_in("drafts-resume");
        let d = dirs("resume");
        let src = write_draft(&d, "draft-9.md", b"half done");
        // The crash: the note and its import row were committed, nothing else.
        let (entry, created) = import_one(&mut stash, &only_draft(&d), None, NOW).unwrap();
        assert!(created);

        let session = one_window(Some("/p/proj"), vec![untitled("9", "draft-9.md")]);
        let (session, report) = import_drafts(&mut stash, &draft_dirs(&d), Some(session), NOW);
        assert_eq!(
            (
                report.imported,
                report.reused,
                report.trashed,
                report.rewritten_tabs
            ),
            (0, 1, 1, 1),
            "{report:?}"
        );
        assert_eq!(rows(&stash, "entries"), 1, "the first run's note is reused");
        assert_eq!(rows(&stash, "draft_imports"), 1);
        assert_eq!(
            session.unwrap().windows[0].tabs[0].path.as_deref(),
            Some(entry.path.as_str())
        );
        assert_eq!(
            session_on_disk(&d).windows[0].tabs[0].path.as_deref(),
            Some(entry.path.as_str())
        );
        assert!(!src.exists());
    }

    #[test]
    fn a_run_cut_short_before_the_move_finishes_without_a_duplicate() {
        let (mut stash, _root) = stash_in("drafts-before-move");
        let d = dirs("before-move");
        let src = write_draft(&d, "draft-8.md", b"almost there");
        // The crash: steps 1-3 done — note, rows, and the session on disk
        // naming the note — but the draft never left session/.
        let (entry, _) = import_one(&mut stash, &only_draft(&d), None, NOW).unwrap();
        let mut rewritten = one_window(None, vec![untitled("8", "draft-8.md")]);
        rewritten.windows[0].tabs[0].untitled = None;
        rewritten.windows[0].tabs[0].path = Some(entry.path.clone());
        crate::session::write_session_in(&d.data, &rewritten).unwrap();

        // The next launch reads that session back: the draft is an orphan now.
        let (session, report) = import_drafts(&mut stash, &draft_dirs(&d), Some(rewritten), NOW);
        assert_eq!(
            (
                report.imported,
                report.reused,
                report.trashed,
                report.rewritten_tabs
            ),
            (0, 1, 1, 0),
            "{report:?}"
        );
        assert_eq!(rows(&stash, "entries"), 1, "no duplicate note");
        assert_eq!(rows(&stash, "draft_imports"), 1);
        assert_eq!(
            session.unwrap().windows[0].tabs[0].path.as_deref(),
            Some(entry.path.as_str())
        );
        assert!(!src.exists());
        assert_eq!(
            fs::read(d.trash.join(format!("draft-8.trashed-{NOW_SECS}.md"))).unwrap(),
            b"almost there"
        );
    }

    #[test]
    fn a_note_that_does_not_read_back_keeps_its_draft_and_its_tab() {
        let (mut stash, _root) = stash_in("drafts-verify");
        let d = dirs("verify");
        let src = write_draft(&d, "draft-v.md", b"the real text");
        let (entry, _) = import_one(&mut stash, &only_draft(&d), None, NOW).unwrap();
        fs::write(&entry.path, b"something else").unwrap();

        let session = one_window(None, vec![untitled("v", "draft-v.md")]);
        let (session, report) = import_drafts(&mut stash, &draft_dirs(&d), Some(session), NOW);
        assert_eq!(
            fs::read(&src).unwrap(),
            b"the real text",
            "never moved: its note does not hold it"
        );
        assert_eq!(
            session.unwrap().windows[0].tabs[0].untitled.as_deref(),
            Some("draft-v.md")
        );
        assert_eq!((report.trashed, report.rewritten_tabs), (0, 0));
        assert_eq!(report.errors.len(), 1, "{report:?}");
        assert!(!d.data.join("session-v2.json").exists());
        assert!(!d.trash.exists());
    }

    fn note_files(root: &Path) -> Vec<PathBuf> {
        fs::read_dir(root.join("home/couplet-test"))
            .map(|r| {
                r.map(|e| e.unwrap().path())
                    .filter(|p| notes::is_note_file_name(p.file_name().unwrap().to_str().unwrap()))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn a_failed_transaction_takes_its_note_file_back_while_the_draft_holds_the_text() {
        // Otherwise every launch with the cause still there adds one more
        // orphan note file holding the same text.
        let (mut stash, root) = stash_in("drafts-tx-fails");
        let d = dirs("tx-fails");
        let src = write_draft(&d, "draft-t.md", b"twice, never none");
        stash
            .conn
            .execute_batch(
                "CREATE TEMP TRIGGER no_imports BEFORE INSERT ON draft_imports \
                 BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            )
            .unwrap();
        for _launch in 0..2 {
            let session = one_window(None, vec![untitled("t", "draft-t.md")]);
            let (session, report) = import_drafts(&mut stash, &draft_dirs(&d), Some(session), NOW);
            assert_eq!(
                (report.imported, report.trashed, report.rewritten_tabs),
                (0, 0, 0),
                "{report:?}"
            );
            assert_eq!(report.errors.len(), 1, "{report:?}");
            assert_eq!(
                rows(&stash, "entries"),
                0,
                "the note's row went with the transaction"
            );
            assert_eq!(
                fs::read(&src).unwrap(),
                b"twice, never none",
                "the draft stays"
            );
            assert_eq!(
                session.unwrap().windows[0].tabs[0].untitled.as_deref(),
                Some("draft-t.md")
            );
            assert!(
                note_files(&root).is_empty(),
                "no orphan note: the draft still holds the text"
            );
        }

        // Once the cause is gone, the next run imports it for good.
        stash
            .conn
            .execute_batch("DROP TRIGGER no_imports;")
            .unwrap();
        let again = one_window(None, vec![untitled("t", "draft-t.md")]);
        let (_, report) = import_drafts(&mut stash, &draft_dirs(&d), Some(again), NOW);
        assert_eq!(
            (report.imported, report.trashed, report.rewritten_tabs),
            (1, 1, 1),
            "{report:?}"
        );
        assert!(!src.exists());
        assert_eq!(note_files(&root).len(), 1);
    }

    #[test]
    fn an_unrecorded_note_stays_unless_the_draft_still_holds_the_same_text() {
        let d = dirs("unrecorded");
        let src = write_draft(&d, "draft-u.md", b"the text");
        let draft = only_draft(&d);
        let note = d.data.join("2026-09-26-0215-abcd.md");

        fs::write(&note, b"the text").unwrap();
        fs::write(&src, b"the text, edited since").unwrap();
        assert!(!drop_unrecorded_note(&note, &draft), "the draft changed");
        assert_eq!(fs::read(&note).unwrap(), b"the text");

        fs::remove_file(&src).unwrap();
        assert!(!drop_unrecorded_note(&note, &draft), "the draft is gone");
        assert_eq!(fs::read(&note).unwrap(), b"the text");

        fs::write(&src, b"the text").unwrap();
        fs::write(&note, b"the text and more").unwrap();
        assert!(!drop_unrecorded_note(&note, &draft), "the note differs");
        assert!(note.exists());

        fs::write(&note, b"the text").unwrap();
        assert!(drop_unrecorded_note(&note, &draft));
        assert!(!note.exists());
        assert_eq!(fs::read(&src).unwrap(), b"the text", "the draft stays");
    }

    #[test]
    fn a_note_whose_file_is_gone_is_made_again() {
        let (mut stash, _root) = stash_in("drafts-gone");
        let d = dirs("gone");
        let src = write_draft(&d, "draft-g.md", b"still here");
        let (entry, _) = import_one(&mut stash, &only_draft(&d), None, NOW).unwrap();
        fs::remove_file(&entry.path).unwrap();

        let (_, report) = import_drafts(&mut stash, &draft_dirs(&d), None, NOW);
        assert_eq!(
            (report.imported, report.reused, report.trashed),
            (1, 0, 1),
            "{report:?}"
        );
        assert!(!src.exists());
        let id: String = stash
            .conn
            .query_row("SELECT entry_id FROM draft_imports", [], |r| r.get(0))
            .unwrap();
        assert_ne!(id, entry.id, "the import record names the new note");
        assert_eq!(
            fs::read(stash.get(&id).unwrap().path).unwrap(),
            b"still here"
        );
    }

    #[test]
    fn a_stale_session_finds_the_note_of_a_draft_already_moved() {
        let (mut stash, _root) = stash_in("drafts-history");
        let d = dirs("history");
        write_draft(&d, "draft-h.md", b"history");
        let stale = one_window(None, vec![untitled("h", "draft-h.md")]);
        let (fresh, _) = import_drafts(&mut stash, &draft_dirs(&d), Some(stale.clone()), NOW);
        let note = fresh.unwrap().windows[0].tabs[0].path.clone().unwrap();

        // A session still naming the moved draft (a v1 file written later, say).
        let (again, report) = import_drafts(&mut stash, &draft_dirs(&d), Some(stale), NOW);
        assert_eq!(
            again.unwrap().windows[0].tabs[0].path.as_deref(),
            Some(note.as_str())
        );
        assert_eq!((report.imported, report.rewritten_tabs), (0, 1));
        assert_eq!(rows(&stash, "entries"), 1);
    }

    #[test]
    fn a_second_content_under_one_name_is_a_second_note_and_the_trash_keeps_both() {
        let (mut stash, _root) = stash_in("drafts-same-name");
        let d = dirs("same-name");
        write_draft(&d, "untitled-main.md", b"one");
        import_drafts(&mut stash, &draft_dirs(&d), None, NOW);
        write_draft(&d, "untitled-main.md", b"two");
        let (_, report) = import_drafts(&mut stash, &draft_dirs(&d), None, NOW);
        assert_eq!((report.imported, report.trashed), (1, 1), "{report:?}");
        assert_eq!(rows(&stash, "entries"), 2);
        assert_eq!(rows(&stash, "draft_imports"), 2);
        let first = format!("untitled-main.trashed-{NOW_SECS}.md");
        let second = format!("untitled-main.trashed-{NOW_SECS}-1.md");
        assert_eq!(names_in(&d.trash), vec![second.clone(), first.clone()]);
        assert_eq!(
            fs::read(d.trash.join(first)).unwrap(),
            b"one",
            "never overwritten"
        );
        assert_eq!(fs::read(d.trash.join(second)).unwrap(), b"two");
    }

    #[test]
    fn a_symlinked_trash_keeps_the_draft_in_place() {
        let (mut stash, _root) = stash_in("drafts-trash-link");
        let d = dirs("trash-link");
        let elsewhere = d.data.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &d.trash).unwrap();
        let src = write_draft(&d, "draft-s.md", b"stay");
        let (_, report) = import_drafts(&mut stash, &draft_dirs(&d), None, NOW);
        assert_eq!((report.imported, report.trashed), (1, 0), "{report:?}");
        assert_eq!(report.errors.len(), 1, "{report:?}");
        assert_eq!(
            fs::read(&src).unwrap(),
            b"stay",
            "the draft stays: the text is in two places"
        );
        assert!(names_in(&elsewhere).is_empty(), "nothing followed the link");
    }

    #[test]
    fn a_session_that_cannot_be_written_keeps_the_drafts_it_names() {
        let (mut stash, _root) = stash_in("drafts-no-session");
        let d = dirs("no-session");
        let named = write_draft(&d, "draft-n.md", b"named");
        let orphan = write_draft(&d, "draft-o.md", b"orphan");
        let nowhere = d.data.join("missing-dir");
        let dirs = DraftDirs {
            session_dir: &d.session,
            trash_dir: &d.trash,
            data_dir: &nowhere,
        };
        let session = one_window(None, vec![untitled("n", "draft-n.md")]);

        let (session, report) = import_drafts(&mut stash, &dirs, Some(session), NOW);
        assert_eq!((report.imported, report.trashed), (2, 1), "{report:?}");
        assert_eq!(report.errors.len(), 1, "{report:?}");
        assert_eq!(
            fs::read(&named).unwrap(),
            b"named",
            "the file on disk still names it: it stays"
        );
        assert!(!orphan.exists(), "nothing names the orphan: it goes");
        assert!(
            session.unwrap().windows[0].tabs[0].path.is_some(),
            "this launch still opens the note"
        );

        // The next launch, with the session file as it was, finishes the job.
        let again = one_window(None, vec![untitled("n", "draft-n.md")]);
        let (_, report) = import_drafts(&mut stash, &draft_dirs(&d), Some(again), NOW);
        assert_eq!(
            (
                report.imported,
                report.reused,
                report.trashed,
                report.rewritten_tabs
            ),
            (0, 1, 1, 1),
            "{report:?}"
        );
        assert_eq!(rows(&stash, "entries"), 2);
    }

    #[test]
    fn a_window_whose_drafts_became_notes_is_no_longer_carried_unrestored() {
        let (mut stash, _root) = stash_in("drafts-carried");
        let d = dirs("carried");
        write_draft(&d, "draft-c1.md", b"becomes a note");
        write_draft(&d, "draft-c2.md", b"");
        let loaded = Session {
            version: SESSION_VERSION,
            saved_at: 42,
            windows: vec![
                window(None, vec![untitled("11", "draft-c1.md")]),
                window(None, vec![untitled("22", "draft-c2.md")]),
            ],
        };
        let (session, _) = import_drafts(&mut stash, &draft_dirs(&d), Some(loaded), NOW);

        let state = SessionState::new();
        state.set_pending(session.unwrap().windows);
        state.set_tabs(
            "main",
            vec![TabSnapshot {
                tab_id: "33".into(),
                path: Some("/a.md".into()),
                ..Default::default()
            }],
            None,
        );
        let written = state.snapshot(1);
        let ids: Vec<&str> = written
            .windows
            .iter()
            .map(|w| w.tabs[0].tab_id.as_str())
            .collect();
        assert_eq!(
            ids,
            vec!["33", "22"],
            "the note window is not carried; the blank draft's window still is"
        );
    }
}
