//! The stash for agents and the command line — `couplet stash …` and the MCP
//! `stash_*` tools (spec «Агент»). Runs WITHOUT a Tauri context, over its own
//! connection to the same `stash.db` the app uses (WAL + 5 s busy timeout),
//! so it works whether or not couplet is running.
//!
//! An agent never gets the whole stash: search answers snippets, list answers
//! metadata, and only `get` returns text — of one entry, capped.

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    /// Stage 07 is written against these signatures (plan Task 1, mapped onto
    /// the real stage 02–06 API by the reconcile). A mismatch fails to compile
    /// here, in one place.
    #[test]
    fn the_stage_api_is_what_stage_07_assumes() {
        use crate::stash::entries::{self, PutAwayPlan};
        use crate::stash::trash::Deleted;
        use crate::stash::{
            db, search, ListQuery, ListResult, ListSort, PutAway, PutAwayResult, Stash, StashEntry,
            StashKind, StashPaths, Tagged,
        };
        use rusqlite::Connection;

        let _: fn(&Path, &Path, &str) -> StashPaths = StashPaths::from_bases;
        let _: fn(StashPaths) -> Result<Stash, db::OpenError> = Stash::open;
        let _: fn(&mut Stash, &str, Option<&str>, i64, i64) -> Result<StashEntry, String> =
            Stash::create_note;
        let _: fn(&PutAway, &Path, i64) -> Result<PutAwayPlan, String> = entries::plan_put_away;
        let _: fn(&mut Stash, PutAwayPlan, i64) -> Result<Vec<PutAwayResult>, String> =
            Stash::put_away_probed;
        let _: fn(&Stash, &ListQuery) -> Result<ListResult, String> = Stash::list;
        let _: fn(&Stash, &str) -> Result<StashEntry, String> = Stash::get;
        let _: fn(&mut Stash, &str, &[String], &[String]) -> Result<Tagged, String> = Stash::tag;
        let _: fn(&mut Stash, &str, i64) -> Result<Deleted, String> = Stash::delete_entry;
        let _: fn(&mut Stash, i64, i64) = Stash::after_write;
        let _: fn(&str) -> Result<Option<String>, String> = entries::normalize_tag;
        let _: fn(Option<&str>) -> Option<String> = entries::normalize_repo;
        let _: fn(&Path) -> Result<std::fs::File, String> = entries::open_readable_now;
        let _: fn(&tauri::AppHandle, &str, Option<Vec<String>>) = crate::stash::emit_changed;
        // `select_page`'s draft type is not nameable outside `search::run`.
        let _ = |c: &Connection, a: &search::SearchArgs| {
            search::select_page(c, a).map(|d| d.into_page())
        };

        // The fields stage 07 reads: a missing or retyped one fails here.
        fn fields(
            p: &StashPaths,
            e: &StashEntry,
            l: &ListResult,
            s: &search::SearchPage,
            r: &PutAwayResult,
            t: &Tagged,
        ) {
            let _: (&PathBuf, &PathBuf) = (&p.db_path, &p.notes_dir);
            let _: (
                &String,
                StashKind,
                &String,
                &Option<String>,
                &Option<String>,
                &Option<String>,
                &Vec<String>,
            ) = (
                &e.id, e.kind, &e.path, &e.title, &e.repo, &e.branch, &e.tags,
            );
            let _: (i64, Option<i64>, Option<i64>) = (e.modified_at, e.stashed_at, e.deleted_at);
            let _: (&Vec<StashEntry>, usize, &Option<String>) =
                (&l.entries, l.total, &l.next_cursor);
            let _: (usize, &Option<String>) = (s.total, &s.next_cursor);
            let _: Vec<(&StashEntry, &String)> =
                s.hits.iter().map(|h| (&h.entry, &h.snippet)).collect();
            let _: (&StashEntry, bool) = (&r.entry, r.created);
            let _: (&StashEntry, bool) = (&t.entry, t.changed);
        }
        let _ = fields;
        let _ = ListQuery {
            repo: None,
            tag: None,
            kind: Some(StashKind::Note),
            sort: ListSort::Changed,
            deleted: false,
            since: None,
            limit: Some(1),
            cursor: None,
        };
        let _ = search::SearchArgs {
            query: String::new(),
            repo: None,
            tag: None,
            kind: Some(StashKind::File),
            deleted: false,
            limit: Some(1),
            cursor: None,
        };
        let _ = PutAway {
            paths: vec![],
            caret: None,
            top_line: None,
            tags: vec![],
            project: None,
        };
        let _: Option<StashKind> = StashKind::parse("note");
    }
}
