//! The stash's Tauri commands, stage 02 of the roadmap's IPC table. Each runs
//! on the blocking pool (SQLite and the file system block; the stash lock is
//! never held across an `await`) and, after a write that changed something,
//! emits `stash-changed` once through `emit_changed`.
//!
//! The stash lock covers SQL only. Whatever reads the user's files — an
//! entry's preview and live repository (`Enrich`), a put-away's probes
//! (`plan_put_away`) — runs in the same blocking task but outside the lock
//! (I3): one slow volume must not queue every other stash call behind it.

use tauri::{AppHandle, State};

use super::entries::plan_put_away;
use super::search::{self, SearchArgs, SearchPage};
use super::{
    clock, emit_changed, DeleteOutcome, Enrich, ListQuery, ListResult, ListSort, PutAway, PutAwayResult, Stash,
    StashCounts, StashEntry, StashKind, StashState,
};

/// One trip to the blocking pool. `f` takes the stash lock itself, only
/// around its SQL (`StashState::with`); its answer is enriched from the disk
/// after that lock is released.
async fn off_lock<T: Enrich + Send + 'static>(
    state: &StashState,
    f: impl FnOnce(&StashState) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || f(&state).map(Enrich::enrich))
        .await
        .map_err(|e| format!("stash task failed: {e}"))?
}

/// `off_lock` for a command whose locked part is one `Stash` call.
async fn run<T: Enrich + Send + 'static>(
    state: &StashState,
    f: impl FnOnce(&mut Stash) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    off_lock(state, move |state| state.with(f)).await
}

fn offset_at(now: i64) -> i64 {
    clock::local_offset_secs(now.div_euclid(1000))
}

#[tauri::command]
pub async fn stash_create_note(
    app: AppHandle,
    state: State<'_, StashState>,
    text: String,
    repo: Option<String>,
) -> Result<StashEntry, String> {
    let entry = run(&state, move |s| {
        let now = clock::now_ms();
        let entry = s.create_note(&text, repo.as_deref(), now, offset_at(now))?;
        s.after_write(now, offset_at(now));
        Ok(entry)
    })
    .await?;
    emit_changed(&app, "created", Some(vec![entry.id.clone()]));
    Ok(entry)
}

#[tauri::command]
pub async fn stash_put_away(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, StashState>,
    paths: Vec<String>,
    caret: Option<i64>,
    top_line: Option<i64>,
    tags: Option<Vec<String>>,
) -> Result<Vec<PutAwayResult>, String> {
    let (project_app, label) = (app.clone(), window.label().to_string());
    let results = off_lock(&state, move |state| {
        // The calling window's project: a loose file's repo (A3). Binding
        // walks the file system, so it runs here on the pool; the registry
        // lock is released before the stash's is taken (A11).
        let req = PutAway {
            paths,
            caret,
            top_line,
            tags: tags.unwrap_or_default(),
            project: crate::tab_commands::project_root_of(&project_app, &label),
        };
        let now = clock::now_ms();
        // The folder's spelling asks the file system: named under the lock,
        // spelled outside it — only SQL under the stash lock (A11).
        let notes_dir = state.with(|s| Ok(s.paths.notes_dir.clone()))?;
        let notes_dir = crate::path_norm::normalize_path(&notes_dir);
        // Metadata, titles and `.git` walks on the user's paths: unlocked.
        let plan = plan_put_away(&req, &notes_dir, now)?;
        state.with(|s| {
            let results = s.put_away_probed(plan, now)?;
            // No paths, nothing written.
            if !results.is_empty() {
                s.after_write(now, offset_at(now));
            }
            Ok(results)
        })
    })
    .await?;
    if !results.is_empty() {
        let ids = results.iter().map(|r| r.entry.id.clone()).collect();
        emit_changed(&app, "put-away", Some(ids));
    }
    Ok(results)
}

#[tauri::command]
// The IPC contract passes the filters flat: `stash_list { repo?, tag?, … }`.
#[allow(clippy::too_many_arguments)]
pub async fn stash_list(
    state: State<'_, StashState>,
    repo: Option<String>,
    tag: Option<String>,
    kind: Option<StashKind>,
    sort: Option<ListSort>,
    deleted: Option<bool>,
    since: Option<i64>,
    limit: Option<usize>,
    cursor: Option<String>,
) -> Result<ListResult, String> {
    let q = ListQuery {
        repo,
        tag,
        kind,
        sort: sort.unwrap_or_default(),
        deleted: deleted.unwrap_or(false),
        since,
        limit,
        cursor,
    };
    run(&state, move |s| s.list(&q)).await
}

#[tauri::command]
pub async fn stash_get(state: State<'_, StashState>, id: String) -> Result<StashEntry, String> {
    run(&state, move |s| s.get(&id)).await
}

/// The stash entry of a tab's file, if it has one (stash plan 03), trashed or
/// not. Only the frontend's display cache asks this; what a close does to the
/// stash is decided in `tab_close` from the database itself.
#[tauri::command]
pub async fn stash_entry_for_path(
    state: State<'_, StashState>,
    path: String,
) -> Result<Option<StashEntry>, String> {
    off_lock(&state, move |state| {
        // Outside the lock: normalizing asks the file system.
        let path = crate::path_norm::normalize_str(&path);
        state.with(|s| s.entry_for_path(&path))
    })
    .await
}

#[tauri::command]
pub async fn stash_tag(
    app: AppHandle,
    state: State<'_, StashState>,
    id: String,
    add: Option<Vec<String>>,
    remove: Option<Vec<String>>,
) -> Result<StashEntry, String> {
    let tagged = run(&state, move |s| {
        let now = clock::now_ms();
        let tagged = s.tag(&id, &add.unwrap_or_default(), &remove.unwrap_or_default())?;
        // A no-op (nothing given, tags already so) rewrites no export and
        // emits nothing: every window would reload the drawer for it.
        if tagged.changed {
            s.after_write(now, offset_at(now));
        }
        Ok(tagged)
    })
    .await?;
    if tagged.changed {
        emit_changed(&app, "tagged", Some(vec![tagged.entry.id.clone()]));
    }
    Ok(tagged.entry)
}

/// Emits `opened` — not in roadmap A6's reason list, which names no reason for
/// this write; the frontend treats the reason as opaque and reloads on any.
#[tauri::command]
pub async fn stash_touch_opened(
    app: AppHandle,
    state: State<'_, StashState>,
    path: String,
) -> Result<(), String> {
    let touched = run(&state, move |s| {
        let now = clock::now_ms();
        let touched = s.touch_opened(&path, now)?;
        if touched {
            s.after_write(now, offset_at(now));
        }
        Ok(touched)
    })
    .await?;
    if touched {
        emit_changed(&app, "opened", None);
    }
    Ok(())
}

/// «убрать из тайника» (stage 04: file references only; stage 06 adds the
/// note trash, roadmap A7). The user's file is never touched. Emits `deleted`
/// with the id, so an open tab drops its «in the stash» mark at once.
#[tauri::command]
pub async fn stash_delete(
    app: AppHandle,
    state: State<'_, StashState>,
    id: String,
) -> Result<DeleteOutcome, String> {
    let removed_id = id.clone();
    let outcome = run(&state, move |s| {
        let now = clock::now_ms();
        let outcome = s.remove_file_ref(&id)?;
        s.after_write(now, offset_at(now));
        Ok(outcome)
    })
    .await?;
    emit_changed(&app, "deleted", Some(vec![removed_id]));
    Ok(outcome)
}

#[tauri::command]
pub async fn stash_counts(
    state: State<'_, StashState>,
    repo: Option<String>,
) -> Result<StashCounts, String> {
    run(&state, move |s| {
        let now = clock::now_ms();
        s.counts(
            repo.as_deref(),
            clock::local_day_start_ms(now, offset_at(now)),
        )
    })
    .await
}

/// IPC `stash_search` (roadmap, plus `deleted` for the trash, A8): one search
/// for the drawer and, from stage 07, for agents.
#[tauri::command]
// The IPC contract passes the filters flat: `stash_search { query, repo?, … }`.
#[allow(clippy::too_many_arguments)]
pub async fn stash_search(
    state: State<'_, StashState>,
    query: String,
    repo: Option<String>,
    tag: Option<String>,
    kind: Option<StashKind>,
    deleted: Option<bool>,
    limit: Option<usize>,
    cursor: Option<String>,
) -> Result<SearchPage, String> {
    let args = SearchArgs {
        query,
        repo,
        tag,
        kind,
        deleted: deleted.unwrap_or(false),
        limit,
        cursor,
    };
    search_page(&state, args).await
}

/// The command without Tauri's `State`, for tests: only the SQL runs under
/// the stash lock; hits are enriched from the disk after it (I3).
async fn search_page(state: &StashState, args: SearchArgs) -> Result<SearchPage, String> {
    run(state, move |s| search::search(&s.conn, &args)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stash::testkit::{paths_in, MSK, T0};

    fn state_in(tag: &str) -> StashState {
        let root = crate::atomic_write::testkit::scratch(&format!("stash-{tag}"));
        StashState::open(Ok(paths_in(&root)))
    }

    fn args(query: &str) -> SearchArgs {
        SearchArgs {
            query: query.into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_search_page_is_enriched_after_the_lock_and_keeps_the_ipc_shape() {
        let state = state_in("cmd-search");
        let note = state
            .with(|s| s.create_note("# Тайник\nключи от серверной", None, T0, MSK))
            .unwrap();
        let page = tauri::async_runtime::block_on(search_page(&state, args("серверн"))).unwrap();
        // The SQL half leaves `preview` empty; the disk half fills it.
        assert_eq!(page.hits[0].entry.preview, "# Тайник\nключи от серверной");
        let v = serde_json::to_value(&page).unwrap();
        assert_eq!(v["total"], 1);
        assert!(v["nextCursor"].is_null());
        assert_eq!(v["hits"][0]["entry"]["id"], note.id.as_str());
        assert!(v["hits"][0]["snippet"]
            .as_str()
            .unwrap()
            .contains("серверной"));
        assert!(v["hits"][0]["ranges"][0].is_array());
        assert!(v["hits"][0]["score"].as_f64().unwrap() > 0.0);
    }

    #[test]
    fn a_bad_cursor_is_an_error_not_an_empty_page() {
        let state = state_in("cmd-search-cursor");
        let bad = SearchArgs {
            cursor: Some("c.oops".into()),
            ..args("тайник")
        };
        let err = tauri::async_runtime::block_on(search_page(&state, bad)).unwrap_err();
        assert!(err.contains("invalid cursor"), "{err}");
    }
}
