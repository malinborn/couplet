//! The stash's Tauri commands, stage 02 of the roadmap's IPC table. Each runs
//! on the blocking pool (SQLite and the file system block; the stash lock is
//! never held across an `await`) and, after a write that changed something,
//! emits `stash-changed` once through `emit_changed`.

use tauri::{AppHandle, State};

use super::{
    clock, emit_changed, ListQuery, ListResult, ListSort, PutAway, PutAwayResult, Stash,
    StashCounts, StashEntry, StashKind, StashState,
};

async fn run<T: Send + 'static>(
    state: &StashState,
    f: impl FnOnce(&mut Stash) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || state.with(f))
        .await
        .map_err(|e| format!("stash task failed: {e}"))?
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
    state: State<'_, StashState>,
    paths: Vec<String>,
    caret: Option<i64>,
    top_line: Option<i64>,
    tags: Option<Vec<String>>,
) -> Result<Vec<PutAwayResult>, String> {
    let req = PutAway {
        paths,
        caret,
        top_line,
        tags: tags.unwrap_or_default(),
    };
    let results = run(&state, move |s| {
        let now = clock::now_ms();
        let results = s.put_away(&req, now)?;
        s.after_write(now, offset_at(now));
        Ok(results)
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

#[tauri::command]
pub async fn stash_tag(
    app: AppHandle,
    state: State<'_, StashState>,
    id: String,
    add: Option<Vec<String>>,
    remove: Option<Vec<String>>,
) -> Result<StashEntry, String> {
    let entry = run(&state, move |s| {
        let now = clock::now_ms();
        let entry = s.tag(&id, &add.unwrap_or_default(), &remove.unwrap_or_default())?;
        s.after_write(now, offset_at(now));
        Ok(entry)
    })
    .await?;
    emit_changed(&app, "tagged", Some(vec![entry.id.clone()]));
    Ok(entry)
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
