use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

pub const SESSION_VERSION: u32 = 1;

fn default_top_line() -> usize {
    1
}

static TAB_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fresh id, unique for the lifetime of this process, salted with the wall
/// clock and the pid so two different launches never collide either — the
/// property `untitled-<label>.md` lacked, since `label` (`main`, `editor-2`, …)
/// is reused by every launch. Only digits and `-`: it ends up in a file name.
pub fn new_tab_id() -> String {
    let millis = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = TAB_ID_COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{}-{}-{}", millis, std::process::id(), n)
}

/// One window as it was when the session was captured.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSnapshot {
    /// Absolute path of the open file, or `None` for an Untitled window.
    #[serde(default)]
    pub path: Option<String>,
    /// File name inside the `session/` directory holding an unsaved buffer.
    #[serde(default)]
    pub untitled: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub cursor: usize,
    #[serde(default = "default_top_line")]
    pub top_line: usize,
    /// Process-and-time-unique id for this window, stable across a restore.
    /// A session.json written before this field existed has none — such an
    /// entry gets a fresh id on load, which is harmless: `untitled` already
    /// holds the sidecar's literal file name from that older run, so restore
    /// still finds the right file regardless of this field's value.
    #[serde(default = "new_tab_id")]
    pub tab_id: String,
}

impl WindowSnapshot {
    fn empty() -> Self {
        Self {
            path: None,
            untitled: None,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            cursor: 0,
            top_line: 1,
            tab_id: new_tab_id(),
        }
    }

    /// Builds a snapshot for Cmd+Shift+T's "reopen last closed" — a brand new
    /// window, so it gets its own fresh `tab_id`.
    pub fn from_closed_entry(entry: crate::closed::ClosedEntry) -> Self {
        Self {
            path: Some(entry.path),
            untitled: None,
            x: entry.x,
            y: entry.y,
            width: entry.width,
            height: entry.height,
            cursor: entry.cursor,
            top_line: entry.top_line,
            tab_id: new_tab_id(),
        }
    }

    /// Line numbers are 1-based; a stored 0 would panic CodeMirror's `doc.line`.
    pub fn normalized(&self) -> Self {
        let mut out = self.clone();
        if out.top_line == 0 {
            out.top_line = 1;
        }
        out
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub version: u32,
    pub saved_at: u64,
    pub windows: Vec<WindowSnapshot>,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            version: SESSION_VERSION,
            saved_at: 0,
            windows: Vec::new(),
        }
    }
}

/// Name of the sidecar file that stores an Untitled window's text — keyed by
/// the window's `tab_id` rather than its label, which every launch reuses.
pub fn untitled_file_name(tab_id: &str) -> String {
    format!("untitled-{}.md", tab_id)
}

/// Drop snapshots whose file no longer exists. Untitled snapshots are always kept
/// — their content lives in our own directory, not at a user path.
pub fn prune_missing(session: Session, exists: impl Fn(&str) -> bool) -> Session {
    // Destructure rather than `..session` — moving `windows` out first would make
    // struct-update syntax a partial-move error.
    let Session {
        version,
        saved_at,
        windows,
    } = session;
    let windows = windows
        .into_iter()
        .filter(|w| match &w.path {
            Some(p) => exists(p),
            None => w.untitled.is_some(),
        })
        .collect();
    Session {
        version,
        saved_at,
        windows,
    }
}

/// Sort key that puts `main` first, then `editor-N` in numeric order. Without
/// this, HashMap iteration order makes both tests and restore order random.
pub(crate) fn label_order(label: &str) -> (u8, u32) {
    if label == "main" {
        return (0, 0);
    }
    let n = label
        .rsplit('-')
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(u32::MAX);
    (1, n)
}

/// The live session plus whatever was loaded from disk at startup.
pub struct SessionState {
    entries: Mutex<HashMap<String, WindowSnapshot>>,
    pending: Mutex<Vec<WindowSnapshot>>,
    /// The restore being opened right now: taken out of `pending`, but not
    /// every window has been seeded into `entries` yet. See `take_pending`.
    restoring: Mutex<Vec<WindowSnapshot>>,
    quitting: AtomicBool,
    dirty: AtomicBool,
}

impl SessionState {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            pending: Mutex::new(Vec::new()),
            restoring: Mutex::new(Vec::new()),
            quitting: AtomicBool::new(false),
            dirty: AtomicBool::new(false),
        }
    }

    pub fn mark_quitting(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    pub fn take_dirty(&self) -> bool {
        self.dirty.swap(false, Ordering::SeqCst)
    }

    fn touch(&self) {
        self.dirty.store(true, Ordering::SeqCst);
    }

    pub fn set_geometry(&self, label: &str, x: i32, y: i32, width: u32, height: u32) {
        if self.is_quitting() {
            return;
        }
        let mut map = self.entries.lock().unwrap();
        let entry = map
            .entry(label.to_string())
            .or_insert_with(WindowSnapshot::empty);
        entry.x = x;
        entry.y = y;
        entry.width = width;
        entry.height = height;
        drop(map);
        self.touch();
    }

    pub fn set_document(
        &self,
        label: &str,
        path: Option<String>,
        cursor: usize,
        top_line: usize,
    ) {
        if self.is_quitting() {
            return;
        }
        let mut map = self.entries.lock().unwrap();
        let entry = map
            .entry(label.to_string())
            .or_insert_with(WindowSnapshot::empty);
        entry.path = path;
        entry.cursor = cursor;
        entry.top_line = top_line.max(1);
        drop(map);
        self.touch();
    }

    /// Record that this window holds an unsaved buffer stored under `file_name`.
    pub fn set_untitled(&self, label: &str, file_name: Option<String>) {
        if self.is_quitting() {
            return;
        }
        let mut map = self.entries.lock().unwrap();
        let entry = map
            .entry(label.to_string())
            .or_insert_with(WindowSnapshot::empty);
        entry.untitled = file_name;
        drop(map);
        self.touch();
    }

    /// Forget a window. A no-op while quitting — see the module docs on why.
    pub fn remove(&self, label: &str) {
        if self.is_quitting() {
            return;
        }
        let mut map = self.entries.lock().unwrap();
        map.remove(label);
        drop(map);
        self.touch();
    }

    /// The persistent tab id for `label`, creating its entry (with a fresh
    /// id) if this is the first time anything has been recorded for it.
    ///
    /// Creating the entry does not mark the session dirty: one with neither a
    /// path nor an untitled name is dropped by `prune_missing` on read, so on
    /// its own it is nothing worth writing.
    #[cfg(test)]
    pub fn tab_id_for(&self, label: &str) -> String {
        let mut map = self.entries.lock().unwrap();
        map.entry(label.to_string())
            .or_insert_with(WindowSnapshot::empty)
            .tab_id
            .clone()
    }

    /// The sidecar this window's unsaved buffer goes to: the name its entry
    /// already carries, else one derived from its `tab_id`.
    ///
    /// Keeping an existing name lets a window restored from an older session,
    /// whose sidecar is still `untitled-<label>.md`, go on writing to the file
    /// it was restored from instead of orphaning it.
    pub fn untitled_file_for(&self, label: &str) -> String {
        let mut map = self.entries.lock().unwrap();
        let entry = map
            .entry(label.to_string())
            .or_insert_with(WindowSnapshot::empty);
        entry
            .untitled
            .clone()
            .unwrap_or_else(|| untitled_file_name(&entry.tab_id))
    }

    /// Seed this window's session entry from a restored snapshot — so the
    /// first heartbeat merges into it, keeping the same `tab_id`. No-op if an
    /// entry already exists.
    pub fn seed(&self, label: &str, snapshot: WindowSnapshot) {
        if self.is_quitting() {
            return;
        }
        let mut map = self.entries.lock().unwrap();
        map.entry(label.to_string()).or_insert(snapshot);
        drop(map);
        self.touch();
    }

    /// A copy of this window's current entry, if it has one.
    pub fn snapshot_for(&self, label: &str) -> Option<WindowSnapshot> {
        self.entries.lock().unwrap().get(label).cloned()
    }

    pub fn snapshot(&self, saved_at: u64) -> Session {
        let map = self.entries.lock().unwrap();
        let mut labelled: Vec<(&String, &WindowSnapshot)> = map.iter().collect();
        labelled.sort_by_key(|(label, _)| label_order(label));
        Session {
            version: SESSION_VERSION,
            saved_at,
            windows: labelled.into_iter().map(|(_, w)| w.normalized()).collect(),
        }
    }

    pub fn set_pending(&self, windows: Vec<WindowSnapshot>) {
        *self.pending.lock().unwrap() = windows;
    }

    pub fn pending_count(&self) -> usize {
        self.pending.lock().unwrap().len()
    }

    /// Hand out the pending restore, once — a second call gets nothing.
    ///
    /// The windows stay referenced (as `restoring`) until `finish_restore`:
    /// the first `seed` marks the session dirty, and the ticker's prune would
    /// otherwise delete the sidecars of every window the loop has not reached
    /// yet, which then restore as nothing at all.
    pub fn take_pending(&self) -> Vec<WindowSnapshot> {
        // `pending` stays locked until the move is complete, so
        // `referenced_untitled` (which locks it first) never sees both lists
        // empty mid-move.
        let mut pending = self.pending.lock().unwrap();
        let taken = std::mem::take(&mut *pending);
        self.restoring.lock().unwrap().extend(taken.iter().cloned());
        taken
    }

    /// The restore loop is done: every window it opened now has its own entry.
    pub fn finish_restore(&self) {
        self.restoring.lock().unwrap().clear();
    }

    /// Sidecar file names referenced by the live session, the restore still on
    /// offer, or the restore being opened right now.
    ///
    /// All of them matter. At startup the live session is deliberately empty — so
    /// that the first write of the new run supersedes the file — while `pending`
    /// still holds the previous run's windows. Collecting only the live half makes
    /// the ticker delete exactly the unsaved buffers the user is about to reopen.
    pub fn referenced_untitled(&self) -> HashSet<String> {
        // All three locks at once, in the one order used everywhere
        // (entries → pending → restoring): read one at a time, a window could be
        // seeded and its restore finished between the reads, and be in neither.
        let entries = self.entries.lock().unwrap();
        let pending = self.pending.lock().unwrap();
        let restoring = self.restoring.lock().unwrap();
        entries
            .values()
            .chain(pending.iter())
            .chain(restoring.iter())
            .filter_map(|w| w.untitled.clone())
            .collect()
    }
}

impl Default for SessionState {
    fn default() -> Self {
        Self::new()
    }
}

/// Parse `session.json`. Returns `None` for anything unusable — a corrupt or
/// newer-format file must never take the app down or be half-applied.
pub fn parse_session(data: &str) -> Option<Session> {
    let session: Session = serde_json::from_str(data).ok()?;
    if session.version != SESSION_VERSION {
        return None;
    }
    let Session {
        version,
        saved_at,
        windows,
    } = session;
    Some(Session {
        version,
        saved_at,
        windows: windows.iter().map(|w| w.normalized()).collect(),
    })
}

fn session_file() -> Result<PathBuf, String> {
    Ok(crate::paths::app_data_dir()?.join("session.json"))
}

/// `<app data dir>/session/` — holds Untitled buffers.
pub fn session_dir() -> Result<PathBuf, String> {
    let dir = crate::paths::app_data_dir()?.join("session");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create session dir: {}", e))?;
    }
    Ok(dir)
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Atomic write, same tmp+rename shape as `recovery.rs` and `commands::write_file`.
pub fn write_session(session: &Session) -> Result<(), String> {
    let path = session_file()?;
    let tmp = path.with_extension("json.tmp");
    let data = serde_json::to_string_pretty(session)
        .map_err(|e| format!("Failed to serialize session: {}", e))?;
    fs::write(&tmp, &data).map_err(|e| format!("Failed to write session: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed to save session: {}", e)
    })
}

/// Read the session, dropping windows whose file has since disappeared.
pub fn read_session() -> Option<Session> {
    let path = session_file().ok()?;
    let data = fs::read_to_string(path).ok()?;
    let session = parse_session(&data)?;
    Some(prune_missing(session, |p| std::path::Path::new(p).exists()))
}

pub fn read_untitled(file_name: &str) -> Option<String> {
    let dir = session_dir().ok()?;
    fs::read_to_string(dir.join(file_name)).ok()
}

pub fn write_untitled(file_name: &str, content: &str) -> Result<(), String> {
    let dir = session_dir()?;
    let path = dir.join(file_name);
    let tmp = dir.join(format!("{}.tmp", file_name));
    fs::write(&tmp, content).map_err(|e| format!("Failed to write untitled buffer: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed to save untitled buffer: {}", e)
    })
}

/// Delete Untitled sidecars nothing refers to any more.
///
/// Take the names from `SessionState::referenced_untitled`, never from the live
/// snapshot alone — see that method for why.
pub fn prune_untitled_files(referenced: &HashSet<String>) {
    let Ok(dir) = session_dir() else { return };
    let Ok(entries) = fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with("untitled-") || !name.ends_with(".md") {
            continue;
        }
        if !referenced.contains(name) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// A window's position and size in **logical** pixels.
///
/// The getters answer in physical pixels, but `WebviewWindowBuilder::position`
/// and `inner_size` consume logical ones — without the conversion every restored
/// window comes back at double size and offset on a 2x display.
pub fn window_geometry(window: &tauri::Window) -> Option<(i32, i32, u32, u32)> {
    let pos = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    let scale = window.scale_factor().ok()?;
    let pos = pos.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    Some((
        pos.x.round() as i32,
        pos.y.round() as i32,
        size.width.round() as u32,
        size.height.round() as u32,
    ))
}

/// Frontend heartbeat: where the caret and viewport are, and the text of an
/// Untitled buffer. Called on the existing 5s recovery cadence.
#[tauri::command]
pub async fn update_session_document(
    window: tauri::Window,
    state: tauri::State<'_, SessionState>,
    path: Option<String>,
    cursor: usize,
    top_line: usize,
    content: Option<String>,
) -> Result<(), String> {
    let label = window.label().to_string();
    state.set_document(&label, path.clone(), cursor, top_line);

    // Geometry also rides the heartbeat, because `Moved`/`Resized` never fire for
    // a window the user does not touch — leaving it recorded at 0x0 and restored
    // into the top-left corner under the menu bar.
    if let Some((x, y, width, height)) = window_geometry(&window) {
        state.set_geometry(&label, x, y, width, height);
    }

    match (path, content) {
        // Untitled window with text — mirror it to a sidecar file.
        //
        // The `is_empty` guard keeps a blank window out of the next session: an
        // empty Untitled buffer earns no sidecar and no `untitled` name, so its
        // entry has neither and is pruned on read. It is also the backstop for
        // any report that beats a window's pending open (the frontend holds its
        // heartbeat until `get_pending_file` settles, but nothing here can rely
        // on that): a window *about* to load a file looks exactly like an empty
        // Untitled one, and must not come back as a blank window instead.
        (None, Some(text)) if !text.is_empty() => {
            let file_name = state.untitled_file_for(&label);
            write_untitled(&file_name, &text)?;
            state.set_untitled(&label, Some(file_name));
        }
        // Saved file, or an empty Untitled window — no sidecar needed.
        _ => state.set_untitled(&label, None),
    }
    Ok(())
}

/// Reopen every window from the previous session. Returns how many were opened.
/// The pending list is consumed, so a second call is a no-op.
pub fn restore_pending(app: &tauri::AppHandle) -> usize {
    use tauri::{Emitter, Manager};

    let state = app.state::<SessionState>();
    let snapshots = state.take_pending();
    let count = snapshots.len();
    for snapshot in &snapshots {
        crate::window::open_restored_window(app, snapshot);
    }
    state.finish_restore();
    crate::closed::refresh_reopen_item(app);
    if count > 0 {
        // Let open windows drop the "restore available" toast.
        let _ = app.emit("session-restored", count);
    }
    count
}

/// How many windows the previous session had. Drives the toast.
#[tauri::command]
pub async fn pending_session_count(
    state: tauri::State<'_, SessionState>,
) -> Result<usize, String> {
    Ok(state.pending_count())
}

#[tauri::command]
pub async fn restore_session(app: tauri::AppHandle) -> Result<usize, String> {
    Ok(restore_pending(&app))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(path: Option<&str>) -> WindowSnapshot {
        WindowSnapshot {
            path: path.map(|p| p.to_string()),
            untitled: None,
            x: 10,
            y: 20,
            width: 900,
            height: 700,
            cursor: 5,
            top_line: 3,
            tab_id: new_tab_id(),
        }
    }

    #[test]
    fn json_roundtrip_uses_camel_case() {
        let session = Session {
            version: SESSION_VERSION,
            saved_at: 42,
            windows: vec![snap(Some("/tmp/a.md"))],
        };
        let json = serde_json::to_string(&session).unwrap();
        assert!(json.contains("\"topLine\":3"), "got {}", json);
        assert!(json.contains("\"savedAt\":42"), "got {}", json);

        let back: Session = serde_json::from_str(&json).unwrap();
        assert_eq!(back.windows.len(), 1);
        assert_eq!(back.windows[0].top_line, 3);
        assert_eq!(back.windows[0].path.as_deref(), Some("/tmp/a.md"));
    }

    #[test]
    fn missing_top_line_defaults_to_one() {
        let json = r#"{"version":1,"savedAt":0,"windows":[
            {"path":"/tmp/a.md","untitled":null,"x":0,"y":0,"width":900,"height":700}
        ]}"#;
        let session: Session = serde_json::from_str(json).unwrap();
        assert_eq!(session.windows[0].top_line, 1);
        assert_eq!(session.windows[0].cursor, 0);
    }

    #[test]
    fn zero_top_line_is_normalized_to_one() {
        let mut s = snap(Some("/tmp/a.md"));
        s.top_line = 0;
        assert_eq!(s.normalized().top_line, 1);
    }

    #[test]
    fn remove_drops_entry_when_not_quitting() {
        let state = SessionState::new();
        state.set_geometry("editor-1", 1, 2, 300, 400);
        assert_eq!(state.snapshot(0).windows.len(), 1);
        state.remove("editor-1");
        assert_eq!(state.snapshot(0).windows.len(), 0);
    }

    #[test]
    fn remove_is_ignored_while_quitting() {
        let state = SessionState::new();
        state.set_geometry("editor-1", 1, 2, 300, 400);
        state.mark_quitting();
        state.remove("editor-1");
        assert_eq!(
            state.snapshot(0).windows.len(),
            1,
            "quitting must freeze the session, otherwise closing every window on \
             exit writes an empty session"
        );
    }

    #[test]
    fn snapshot_orders_main_first_then_numerically() {
        let state = SessionState::new();
        for label in ["editor-10", "editor-2", "main"] {
            state.set_geometry(label, 0, 0, 900, 700);
            state.set_document(label, Some(format!("/tmp/{}.md", label)), 0, 1);
        }
        let paths: Vec<String> = state
            .snapshot(0)
            .windows
            .into_iter()
            .filter_map(|w| w.path)
            .collect();
        assert_eq!(
            paths,
            vec![
                "/tmp/main.md".to_string(),
                "/tmp/editor-2.md".to_string(),
                "/tmp/editor-10.md".to_string()
            ]
        );
    }

    #[test]
    fn prune_missing_drops_entry_with_neither_path_nor_untitled() {
        // A window reports itself at mount, before `get_pending_file` resolves,
        // so it briefly has no path and an empty buffer. That entry must not
        // come back as a blank window.
        let session = Session {
            version: SESSION_VERSION,
            saved_at: 0,
            windows: vec![snap(None)],
        };
        let pruned = prune_missing(session, |_| true);
        assert!(pruned.windows.is_empty());
    }

    #[test]
    fn referenced_untitled_covers_the_pending_restore() {
        // Regression: the live session starts empty at launch while `pending`
        // still holds the previous run, so pruning on the live set alone deleted
        // the very buffer the user was about to reopen.
        let state = SessionState::new();
        let mut pending = snap(None);
        pending.untitled = Some("untitled-main.md".to_string());
        state.set_pending(vec![pending]);
        assert!(state.snapshot(0).windows.is_empty(), "live session is empty");

        let referenced = state.referenced_untitled();
        assert!(referenced.contains("untitled-main.md"));
    }

    #[test]
    fn referenced_untitled_covers_live_windows_too() {
        let state = SessionState::new();
        state.set_untitled("editor-2", Some("untitled-editor-2.md".to_string()));
        let referenced = state.referenced_untitled();
        assert!(referenced.contains("untitled-editor-2.md"));
    }

    #[test]
    fn set_document_keeps_geometry() {
        let state = SessionState::new();
        state.set_geometry("editor-1", 7, 8, 500, 600);
        state.set_document("editor-1", Some("/tmp/a.md".to_string()), 99, 12);
        let w = &state.snapshot(0).windows[0];
        assert_eq!((w.x, w.y, w.width, w.height), (7, 8, 500, 600));
        assert_eq!((w.cursor, w.top_line), (99, 12));
    }

    #[test]
    fn prune_missing_drops_gone_files_but_keeps_untitled() {
        let mut untitled = snap(None);
        untitled.untitled = Some("untitled-editor-3.md".to_string());
        let session = Session {
            version: SESSION_VERSION,
            saved_at: 0,
            windows: vec![snap(Some("/tmp/gone.md")), snap(Some("/tmp/here.md")), untitled],
        };
        let pruned = prune_missing(session, |p| p == "/tmp/here.md");
        assert_eq!(pruned.windows.len(), 2);
        assert_eq!(pruned.windows[0].path.as_deref(), Some("/tmp/here.md"));
        assert!(pruned.windows[1].untitled.is_some());
    }

    #[test]
    fn take_pending_empties_the_queue() {
        let state = SessionState::new();
        state.set_pending(vec![snap(Some("/tmp/a.md"))]);
        assert_eq!(state.pending_count(), 1);
        assert_eq!(state.take_pending().len(), 1);
        assert_eq!(state.pending_count(), 0);
        assert_eq!(state.take_pending().len(), 0);
    }

    #[test]
    fn untitled_file_name_is_derived_from_tab_id() {
        assert_eq!(untitled_file_name("17-42-3"), "untitled-17-42-3.md");
    }

    #[test]
    fn restore_keeps_not_yet_opened_windows_drafts_referenced() {
        // Regression: `take_pending` used to empty `pending` before the loop,
        // and the first `seed` marks the session dirty — so the ticker's prune
        // deleted the sidecars of every window the loop had not reached yet.
        let state = SessionState::new();
        let mut first = snap(None);
        first.untitled = Some("untitled-a.md".to_string());
        let mut second = snap(None);
        second.untitled = Some("untitled-b.md".to_string());
        state.set_pending(vec![first, second]);

        let snapshots = state.take_pending();
        state.seed("editor-1", snapshots[0].clone());

        let mid_restore = state.referenced_untitled();
        assert!(mid_restore.contains("untitled-a.md"));
        assert!(
            mid_restore.contains("untitled-b.md"),
            "a window the restore has not opened yet must keep its draft"
        );

        state.finish_restore();
        let after = state.referenced_untitled();
        assert!(after.contains("untitled-a.md"), "held by the seeded entry");
        assert!(!after.contains("untitled-b.md"), "never opened, now free");
    }

    #[test]
    fn a_second_take_pending_during_a_restore_gets_nothing() {
        let state = SessionState::new();
        state.set_pending(vec![snap(Some("/tmp/a.md"))]);
        assert_eq!(state.take_pending().len(), 1);
        assert!(state.take_pending().is_empty());
        assert_eq!(state.pending_count(), 0);
    }

    #[test]
    fn seed_is_a_noop_while_quitting() {
        let state = SessionState::new();
        state.mark_quitting();
        state.seed("editor-5", snap(Some("/tmp/a.md")));
        assert!(state.snapshot_for("editor-5").is_none());
    }

    #[test]
    fn seed_marks_the_session_dirty() {
        let state = SessionState::new();
        state.seed("editor-5", snap(Some("/tmp/a.md")));
        assert!(state.take_dirty());
    }

    #[test]
    fn tab_id_is_millis_pid_counter_and_so_file_name_safe() {
        let id = new_tab_id();
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 3, "got {}", id);
        assert!(parts.iter().all(|p| p.parse::<u128>().is_ok()), "got {}", id);
        assert_eq!(parts[1], std::process::id().to_string());
    }

    #[test]
    fn two_launches_reusing_the_same_window_label_get_different_tab_ids() {
        // Regression: `untitled-main.md` used to be shared by every launch's
        // "main" window, so starting to type in one before Reopen Session
        // silently overwrote the previous run's unsaved buffer.
        let launch_one = SessionState::new();
        let launch_two = SessionState::new();

        let id_one = launch_one.tab_id_for("main");
        let id_two = launch_two.tab_id_for("main");

        assert_ne!(id_one, id_two);
        assert_ne!(
            launch_one.untitled_file_for("main"),
            launch_two.untitled_file_for("main")
        );
    }

    #[test]
    fn tab_id_for_is_stable_across_repeated_calls() {
        let state = SessionState::new();
        let first = state.tab_id_for("editor-2");
        let second = state.tab_id_for("editor-2");
        assert_eq!(first, second);
    }

    #[test]
    fn tab_id_for_does_not_mark_the_session_dirty() {
        let state = SessionState::new();
        state.tab_id_for("editor-2");
        assert!(!state.take_dirty());
    }

    #[test]
    fn seed_preserves_the_restored_tab_id() {
        let state = SessionState::new();
        let mut snapshot = WindowSnapshot::empty();
        snapshot.tab_id = "restored-id-123".to_string();
        state.seed("editor-5", snapshot);

        assert_eq!(state.tab_id_for("editor-5"), "restored-id-123");
    }

    #[test]
    fn seed_does_not_overwrite_an_entry_that_already_exists() {
        let state = SessionState::new();
        let first_id = state.tab_id_for("editor-5");

        let mut snapshot = WindowSnapshot::empty();
        snapshot.tab_id = "should-be-ignored".to_string();
        state.seed("editor-5", snapshot);

        assert_eq!(state.tab_id_for("editor-5"), first_id);
    }

    #[test]
    fn seeded_untitled_stays_referenced_after_the_pending_restore_is_taken() {
        let state = SessionState::new();
        let mut pending = snap(None);
        pending.untitled = Some("untitled-main.md".to_string());
        state.set_pending(vec![pending]);

        let restored = state.take_pending().remove(0);
        state.seed("editor-4", restored);

        assert!(state.referenced_untitled().contains("untitled-main.md"));
    }

    #[test]
    fn untitled_file_for_keeps_a_restored_legacy_name() {
        // A session written before `tab_id` existed names its sidecar after
        // the old window label. Writing a restored window's buffer anywhere
        // else would orphan that file.
        let state = SessionState::new();
        let mut restored = snap(None);
        restored.untitled = Some("untitled-editor-3.md".to_string());
        state.seed("editor-7", restored);

        assert_eq!(state.untitled_file_for("editor-7"), "untitled-editor-3.md");
    }

    #[test]
    fn untitled_file_for_a_fresh_window_is_named_by_its_tab_id() {
        let state = SessionState::new();
        let tab_id = state.tab_id_for("main");
        assert_eq!(
            state.untitled_file_for("main"),
            format!("untitled-{}.md", tab_id)
        );
    }

    #[test]
    fn legacy_entry_without_tab_id_gets_a_fresh_one_on_load() {
        let json = r#"{"version":1,"savedAt":0,"windows":[
            {"path":null,"untitled":"untitled-main.md","x":0,"y":0,"width":900,"height":700}
        ]}"#;
        let session = parse_session(json).expect("should parse");
        assert!(!session.windows[0].tab_id.is_empty());
        assert_eq!(
            session.windows[0].untitled.as_deref(),
            Some("untitled-main.md")
        );
    }

    #[test]
    fn tab_id_survives_a_json_roundtrip() {
        let mut s = snap(None);
        s.tab_id = "123-45-6".to_string();
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains(r#""tabId":"123-45-6""#), "got {}", json);
        let back: WindowSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(back.tab_id, "123-45-6");
    }

    #[test]
    fn snapshot_for_returns_the_recorded_entry() {
        let state = SessionState::new();
        state.set_document("editor-1", Some("/tmp/a.md".to_string()), 3, 2);
        let snap = state.snapshot_for("editor-1").expect("entry exists");
        assert_eq!(snap.path.as_deref(), Some("/tmp/a.md"));
    }

    #[test]
    fn from_closed_entry_carries_geometry_and_position_with_a_fresh_tab_id() {
        let entry = crate::closed::ClosedEntry {
            path: "/tmp/a.md".to_string(),
            cursor: 42,
            top_line: 9,
            x: 11,
            y: 22,
            width: 800,
            height: 600,
        };
        let a = WindowSnapshot::from_closed_entry(entry.clone());
        assert_eq!(a.path.as_deref(), Some("/tmp/a.md"));
        assert_eq!(a.untitled, None);
        assert_eq!((a.x, a.y, a.width, a.height), (11, 22, 800, 600));
        assert_eq!((a.cursor, a.top_line), (42, 9));
        let b = WindowSnapshot::from_closed_entry(entry);
        assert_ne!(a.tab_id, b.tab_id, "every reopened window is a new window");
    }

    #[test]
    fn snapshot_for_returns_none_for_an_unknown_label() {
        let state = SessionState::new();
        assert!(state.snapshot_for("no-such-window").is_none());
    }

    #[test]
    fn parse_session_accepts_current_version() {
        let json = r#"{"version":1,"savedAt":7,"windows":[
            {"path":"/tmp/a.md","untitled":null,"x":1,"y":2,"width":900,"height":700,
             "cursor":4,"topLine":5}
        ]}"#;
        let session = parse_session(json).expect("should parse");
        assert_eq!(session.saved_at, 7);
        assert_eq!(session.windows[0].cursor, 4);
    }

    #[test]
    fn parse_session_rejects_future_version() {
        let json = r#"{"version":99,"savedAt":0,"windows":[]}"#;
        assert!(
            parse_session(json).is_none(),
            "a newer on-disk format must be ignored, not misread"
        );
    }

    #[test]
    fn parse_session_rejects_garbage() {
        assert!(parse_session("not json at all").is_none());
        assert!(parse_session("").is_none());
    }

    #[test]
    fn parse_session_normalizes_entries() {
        let json = r#"{"version":1,"savedAt":0,"windows":[
            {"path":"/tmp/a.md","x":0,"y":0,"width":900,"height":700,"topLine":0}
        ]}"#;
        let session = parse_session(json).unwrap();
        assert_eq!(session.windows[0].top_line, 1);
    }
}
