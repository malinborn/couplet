//! Full-text search over the stash (spec «Поиск»): one index, one query
//! language and one ranking for the drawer and for agents.
//!
//! `entries_fts` (roadmap schema v1, trigram tokenizer, rowid = entries.rowid)
//! is derived data: everything here may fail without losing anything, and
//! `rebuild_index` recreates it from the entries and their files.

// Siblings reach each other as `super::query::…`. No re-export until code
// outside `search` needs one: an unused `pub use` is a warning of its own.
mod index;
mod query;
mod run;
mod snippet;
#[cfg(test)]
mod test_support;
mod text;

pub(crate) use index::{
    ensure_index, index_text, read_body, read_saved, register_functions, reindex_path,
    unindex_entry, write_body,
};
pub(crate) use run::{select_page, SearchArgs, SearchPage};

/// The ids a plain search for `q` finds, best first: for the writers' tests
/// outside `search`.
#[cfg(test)]
pub(crate) fn found(conn: &rusqlite::Connection, q: &str) -> Vec<String> {
    let args = run::SearchArgs {
        query: q.into(),
        ..Default::default()
    };
    run::search(conn, &args)
        .unwrap()
        .hits
        .iter()
        .map(|h| h.entry.id.clone())
        .collect()
}

/// Every stash writer indexes as it writes (reconciliation §1c). These call
/// the `Stash` methods and the save hook's body (`stash::saved`) directly:
/// the process-wide hook is a `OnceLock` that exactly one test may install
/// (`commands.rs`).
#[cfg(test)]
mod hooks_tests {
    use std::cell::{Cell, RefCell};
    use std::fs;

    use crate::stash::testkit::{paths_in, stash_in, user_file, MSK, T0};
    use crate::stash::{saved, PutAway, Stash, StashState};

    fn found(stash: &Stash, q: &str) -> Vec<String> {
        super::found(&stash.conn, q)
    }

    fn found_in(state: &StashState, q: &str) -> Vec<String> {
        state.with(|s| Ok(found(s, q))).unwrap()
    }

    fn state_in(tag: &str) -> (StashState, std::path::PathBuf) {
        let root = crate::atomic_write::testkit::scratch(&format!("stash-{tag}"));
        (StashState::open(Ok(paths_in(&root))), root)
    }

    #[test]
    fn a_created_note_is_searchable_at_once() {
        let (mut stash, _root) = stash_in("hook-create");
        let entry = stash
            .create_note("# Тайник\nключи от серверной", None, T0, MSK)
            .unwrap();
        assert_eq!(found(&stash, "серверн"), vec![entry.id]);
    }

    #[test]
    fn a_put_away_file_is_searchable_and_a_second_put_away_reindexes() {
        let (mut stash, root) = stash_in("hook-put-away");
        let path = user_file(&root, "hdmi.md", "переговорка на третьем");
        let req = PutAway {
            paths: vec![path.clone()],
            ..Default::default()
        };
        let id = stash.put_away(&req, T0).unwrap()[0].entry.id.clone();
        assert_eq!(found(&stash, "переговорка"), vec![id.clone()]);

        fs::write(&path, "проектор в холле").unwrap();
        stash.put_away(&req, T0 + 10).unwrap();
        assert_eq!(found(&stash, "проектор"), vec![id]);
        assert!(found(&stash, "переговорка").is_empty());
    }

    #[test]
    fn an_unreadable_file_on_a_second_put_away_keeps_what_the_index_has() {
        let (mut stash, root) = stash_in("hook-put-away-gone");
        let path = user_file(&root, "gone.md", "архив логов");
        let req = PutAway {
            paths: vec![path.clone()],
            ..Default::default()
        };
        let id = stash.put_away(&req, T0).unwrap()[0].entry.id.clone();
        fs::remove_file(&path).unwrap();
        stash.put_away(&req, T0 + 10).unwrap();
        assert_eq!(found(&stash, "архив"), vec![id]);
    }

    #[test]
    fn a_saved_stash_file_is_reindexed() {
        let (mut stash, _root) = stash_in("hook-written");
        let entry = stash.create_note("старый текст", None, T0, MSK).unwrap();
        fs::write(&entry.path, "новый текст про бэкап").unwrap();
        let written = stash.file_written(&entry.path, None, T0 + 10).unwrap();
        assert!(written.stamped);
        assert!(stash
            .reindex_written(&entry.path, "новый текст про бэкап", T0 + 10)
            .unwrap());
        assert_eq!(found(&stash, "бэкап"), vec![entry.id]);
        assert!(found(&stash, "старый").is_empty());
    }

    #[test]
    fn a_save_superseded_before_its_reindex_leaves_the_newer_text() {
        // Two pool tasks out of order: B (newer) stamps and reindexes, then
        // A's reindex arrives with the older text and must not overwrite it.
        let (mut stash, _root) = stash_in("hook-order");
        let entry = stash.create_note("начало", None, T0, MSK).unwrap();
        assert!(
            stash
                .file_written(&entry.path, None, T0 + 10)
                .unwrap()
                .stamped
        );
        assert!(
            stash
                .file_written(&entry.path, None, T0 + 20)
                .unwrap()
                .stamped
        );
        assert!(stash
            .reindex_written(&entry.path, "вторая версия", T0 + 20)
            .unwrap());
        assert!(!stash
            .reindex_written(&entry.path, "первая версия", T0 + 10)
            .unwrap());
        assert_eq!(found(&stash, "вторая"), vec![entry.id]);
        assert!(found(&stash, "первая").is_empty());
    }

    #[test]
    fn two_saves_in_one_millisecond_index_the_later_text() {
        // Save A stamps and reads the first text; before its reindex, save B
        // (same millisecond) writes, stamps, reads and reindexes the second.
        // A's reindex must not land over B's: B's row stamp is `now + 1`, and
        // each task reindexes under the stamp its row took.
        let (state, _root) = state_in("hook-same-ms");
        let note = state
            .with(|s| s.create_note("# Заметка\nначало", None, T0, MSK))
            .unwrap();
        fs::write(&note.path, "# Заметка\nпервая правка").unwrap();
        let path = note.path.clone();
        saved(
            &state,
            &note.path,
            Some("Заметка"),
            T0 + 10,
            |p: &str| {
                let first = super::read_saved(p);
                fs::write(&path, "# Заметка\nвторая правка").unwrap();
                saved(&state, &path, Some("Заметка"), T0 + 10, super::read_saved, &|_: &str| {});
                first
            },
            &|_: &str| {},
        );
        assert_eq!(found_in(&state, "вторая"), vec![note.id]);
        assert!(found_in(&state, "первая").is_empty());
    }

    #[test]
    fn saving_a_file_outside_the_stash_is_not_stamped() {
        let (mut stash, root) = stash_in("hook-outside");
        let file = user_file(&root, "x.md", "x");
        let written = stash.file_written(&file, Some("y"), T0).unwrap();
        assert!(!written.stamped && !written.title_changed);
    }

    #[test]
    fn the_save_hook_makes_a_saved_note_searchable_before_it_notifies() {
        let (state, _root) = state_in("hook-saved");
        let note = state
            .with(|s| s.create_note("# Старое\nтекст", None, T0, MSK))
            .unwrap();
        fs::write(&note.path, "# Новое\nпро резервные копии").unwrap();
        let seen: RefCell<Vec<(String, Vec<String>)>> = RefCell::new(Vec::new());
        saved(
            &state,
            &note.path,
            Some("Новое"),
            T0 + 10,
            super::read_saved,
            &|reason: &str| {
                // Notified after the reindex: a drawer re-searching now finds it.
                let hits = found_in(&state, "резервн");
                seen.borrow_mut().push((reason.to_string(), hits));
            },
        );
        assert_eq!(
            seen.into_inner(),
            vec![("title".to_string(), vec![note.id.clone()])]
        );
        assert!(found_in(&state, "текст").is_empty());
    }

    #[test]
    fn the_save_hook_reads_nothing_for_a_file_outside_the_stash() {
        let (state, root) = state_in("hook-foreign");
        let file = user_file(&root, "notes.md", "# Чужой");
        let reads = Cell::new(0);
        saved(
            &state,
            &file,
            Some("Чужой"),
            T0,
            |_: &str| {
                reads.set(reads.get() + 1);
                Some(String::new())
            },
            &|_: &str| panic!("nothing to announce"),
        );
        assert_eq!(reads.get(), 0, "a save outside the stash costs no read");
    }

    #[test]
    fn a_save_under_another_spelling_reaches_the_entry() {
        // The hook normalizes before it asks the stash: a caller that did not
        // must not silently miss the row. Moved here from `entries.rs` when
        // `file_written` began to take the normalized path.
        let (state, _root) = state_in("hook-spelling");
        let note = state
            .with(|s| s.create_note("# Old", None, T0, MSK))
            .unwrap();
        let path = std::path::Path::new(&note.path);
        let dotted = format!(
            "{}/./sub/../{}",
            path.parent().unwrap().display(),
            path.file_name().unwrap().to_string_lossy()
        );
        assert_ne!(dotted, note.path);
        fs::write(&note.path, "# New\nсвежий текст").unwrap();
        let notified = Cell::new(false);
        saved(
            &state,
            &dotted,
            Some("New"),
            T0 + 10,
            super::read_saved,
            &|_: &str| notified.set(true),
        );
        assert!(notified.get());
        let e = state.with(|s| s.get(&note.id)).unwrap();
        assert_eq!((e.title.as_deref(), e.modified_at), (Some("New"), T0 + 10));
        assert_eq!(found_in(&state, "свежий"), vec![note.id]);
    }
}
