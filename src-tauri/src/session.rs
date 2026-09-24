use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

/// The format this build writes, to `session-v2.json`. The pre-tabs v1
/// `session.json` is still read and migrated (`parse_session`), but never
/// written: a rollback to an older build finds its own file as it left it.
pub const SESSION_VERSION: u32 = 2;
const LEGACY_VERSION: u32 = 1;
const SESSION_FILE: &str = "session-v2.json";
const LEGACY_SESSION_FILE: &str = "session.json";

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

/// One tab as it was when the session was captured.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSnapshot {
    /// Stable across a restore; names the tab's untitled sidecar.
    pub tab_id: String,
    /// Absolute path of the open file, or `None` for an untitled tab.
    #[serde(default)]
    pub path: Option<String>,
    /// File name inside `session/` holding an untitled tab's text.
    #[serde(default)]
    pub untitled: Option<String>,
    #[serde(default)]
    pub cursor: usize,
    #[serde(default = "default_top_line")]
    pub top_line: usize,
}

impl TabSnapshot {
    /// Line numbers are 1-based; a stored 0 would panic CodeMirror's `doc.line`.
    fn normalized(&self) -> Self {
        let mut out = self.clone();
        if out.top_line == 0 {
            out.top_line = 1;
        }
        out
    }
}

/// One window: geometry, its tabs in the order it shows them, the active one.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSnapshot {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub tabs: Vec<TabSnapshot>,
    #[serde(default)]
    pub active_tab: Option<String>,
}

impl WindowSnapshot {
    fn empty() -> Self {
        Self {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            tabs: Vec::new(),
            active_tab: None,
        }
    }

    /// A brand-new window holding one reopened file — Cmd+Shift+T when the
    /// window it was closed from is gone. A fresh `tab_id`: it is a new tab.
    pub fn from_closed_entry(entry: crate::closed::ClosedEntry) -> Self {
        let tab_id = new_tab_id();
        Self {
            x: entry.x,
            y: entry.y,
            width: entry.width,
            height: entry.height,
            tabs: vec![TabSnapshot {
                tab_id: tab_id.clone(),
                path: Some(entry.path),
                untitled: None,
                cursor: entry.cursor,
                top_line: entry.top_line,
            }],
            active_tab: Some(tab_id),
        }
    }

    pub fn normalized(&self) -> Self {
        let mut out = self.clone();
        out.tabs = out.tabs.iter().map(TabSnapshot::normalized).collect();
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

/// A window as `session.json` v1 stored it: one document per window.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyWindow {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    untitled: Option<String>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    #[serde(default)]
    cursor: usize,
    #[serde(default = "default_top_line")]
    top_line: usize,
    /// Written since plan 01; an older file has none and gets a fresh one —
    /// harmless, because `untitled` holds the sidecar's literal name.
    #[serde(default = "new_tab_id")]
    tab_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySession {
    saved_at: u64,
    windows: Vec<LegacyWindow>,
}

/// v1 → v2: every old window becomes a window with one tab. The sidecar name
/// is carried verbatim — `untitled-main.md` or `untitled-<tab_id>.md` from an
/// older run is still the file holding that text.
fn migrate_legacy(legacy: LegacySession) -> Session {
    Session {
        version: SESSION_VERSION,
        saved_at: legacy.saved_at,
        windows: legacy
            .windows
            .into_iter()
            .map(|w| WindowSnapshot {
                x: w.x,
                y: w.y,
                width: w.width,
                height: w.height,
                active_tab: Some(w.tab_id.clone()),
                tabs: vec![TabSnapshot {
                    tab_id: w.tab_id,
                    path: w.path,
                    untitled: w.untitled,
                    cursor: w.cursor,
                    top_line: w.top_line,
                }],
            })
            .collect(),
    }
}

/// Name of the sidecar file holding an untitled tab's text — keyed by the
/// tab's id rather than a window label, which every launch reuses.
pub fn untitled_file_name(tab_id: &str) -> String {
    format!("untitled-{}.md", tab_id)
}

/// Drop tabs whose file no longer exists and untitled tabs that never earned a
/// sidecar, then windows left with no tabs. A dropped active tab hands
/// "active" to the window's first remaining tab.
pub fn prune_missing(session: Session, exists: impl Fn(&str) -> bool) -> Session {
    let Session {
        version,
        saved_at,
        windows,
    } = session;
    let windows = windows
        .into_iter()
        .filter_map(|mut w| {
            w.tabs.retain(|t| match &t.path {
                Some(p) => exists(p),
                None => t.untitled.is_some(),
            });
            let first = w.tabs.first()?.tab_id.clone();
            if !w
                .active_tab
                .as_ref()
                .is_some_and(|a| w.tabs.iter().any(|t| &t.tab_id == a))
            {
                w.active_tab = Some(first);
            }
            Some(w)
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

    /// Replace this window's tabs with what the frontend reports, in its order.
    pub fn set_tabs(&self, label: &str, tabs: Vec<TabSnapshot>, active_tab: Option<String>) {
        if self.is_quitting() {
            return;
        }
        let mut map = self.entries.lock().unwrap();
        let entry = map
            .entry(label.to_string())
            .or_insert_with(WindowSnapshot::empty);
        entry.tabs = tabs;
        entry.active_tab = active_tab;
        drop(map);
        self.touch();
    }

    /// The sidecar one untitled tab writes to: the name this window's entry
    /// already records for it, else one derived from its id.
    ///
    /// Keeping a recorded name lets a tab restored from an older session —
    /// sidecar `untitled-main.md` — go on writing to the file it was restored
    /// from instead of orphaning it.
    pub fn untitled_file_for(&self, label: &str, tab_id: &str) -> String {
        let map = self.entries.lock().unwrap();
        map.get(label)
            .and_then(|w| w.tabs.iter().find(|t| t.tab_id == tab_id))
            .and_then(|t| t.untitled.clone())
            .unwrap_or_else(|| untitled_file_name(tab_id))
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

    /// Seed this window's session entry from a restored snapshot — so the
    /// first heartbeat merges into it, keeping every tab's id. No-op if an
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

    /// Sidecar file names referenced by any tab of the live session, the
    /// restore still on offer, or the restore being opened right now.
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
            .flat_map(|w| w.tabs.iter())
            .filter_map(|t| t.untitled.clone())
            .collect()
    }
}

impl Default for SessionState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Deserialize)]
struct VersionProbe {
    version: u32,
}

/// Parse either format. `None` for anything unusable — a corrupt or
/// newer-format file must never take the app down or be half-applied.
pub fn parse_session(data: &str) -> Option<Session> {
    let probe: VersionProbe = serde_json::from_str(data).ok()?;
    let session = match probe.version {
        SESSION_VERSION => serde_json::from_str::<Session>(data).ok()?,
        LEGACY_VERSION => migrate_legacy(serde_json::from_str::<LegacySession>(data).ok()?),
        _ => return None,
    };
    let Session {
        version,
        saved_at,
        windows,
    } = session;
    Some(Session {
        version,
        saved_at,
        windows: windows.iter().map(WindowSnapshot::normalized).collect(),
    })
}

/// The previous run's session: `session-v2.json` when it parses, else the
/// pre-tabs `session.json`, migrated. A v2 file that exists but does not
/// parse falls back too — an older snapshot beats none.
pub fn choose_session(current: Option<&str>, legacy: Option<&str>) -> Option<Session> {
    current
        .and_then(parse_session)
        .or_else(|| legacy.and_then(parse_session))
}

fn data_file(name: &str) -> Result<PathBuf, String> {
    Ok(crate::paths::app_data_dir()?.join(name))
}

/// `<app data dir>/session/` — holds untitled buffers.
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

/// Atomic write, same tmp+rename shape as `recovery.rs`. Always v2, always
/// `session-v2.json` — `session.json` is left alone for a rollback.
pub fn write_session(session: &Session) -> Result<(), String> {
    let path = data_file(SESSION_FILE)?;
    let tmp = path.with_extension("json.tmp");
    let data = serde_json::to_string_pretty(session)
        .map_err(|e| format!("Failed to serialize session: {}", e))?;
    fs::write(&tmp, &data).map_err(|e| format!("Failed to write session: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed to save session: {}", e)
    })
}

/// Read the session (v2, else v1 migrated), dropping tabs whose file has
/// since disappeared.
pub fn read_session() -> Option<Session> {
    let read = |name: &str| data_file(name).ok().and_then(|p| fs::read_to_string(p).ok());
    let current = read(SESSION_FILE);
    let legacy = read(LEGACY_SESSION_FILE);
    let session = choose_session(current.as_deref(), legacy.as_deref())?;
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

/// Delete untitled sidecars nothing refers to any more.
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

/// One tab as the frontend reports it on the heartbeat.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabReport {
    pub tab_id: String,
    pub path: Option<String>,
    pub cursor: usize,
    pub top_line: usize,
    /// An untitled tab's text; `None` for a file tab.
    pub content: Option<String>,
}

/// Turn a heartbeat into snapshots, writing each untitled tab's text to its
/// sidecar through `write`.
///
/// The `is_empty` guard keeps a blank untitled tab out of the next session:
/// no sidecar, no `untitled` name, and `prune_missing` drops it on read. It is
/// also the backstop for any report that beats a window's pending open — a
/// tab about to load a file looks exactly like an empty untitled one, and must
/// not come back as a blank tab instead.
pub fn tab_snapshots(
    state: &SessionState,
    label: &str,
    reports: Vec<TabReport>,
    write: impl Fn(&str, &str) -> Result<(), String>,
) -> Result<Vec<TabSnapshot>, String> {
    reports
        .into_iter()
        .map(|r| {
            let untitled = match (&r.path, &r.content) {
                (None, Some(text)) if !text.is_empty() => {
                    let name = state.untitled_file_for(label, &r.tab_id);
                    write(&name, text)?;
                    Some(name)
                }
                _ => None,
            };
            Ok(TabSnapshot {
                tab_id: r.tab_id,
                path: r.path,
                untitled,
                cursor: r.cursor,
                top_line: r.top_line.max(1),
            })
        })
        .collect()
}

/// Frontend heartbeat: every tab of the window, in order, with positions and
/// untitled text, plus which one is active. Sent on the 5 s recovery cadence
/// and right after every structural change (open, close, switch).
#[tauri::command]
pub async fn tabs_sync(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, SessionState>,
    tabs: Vec<TabReport>,
    active: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;
    let label = window.label().to_string();
    {
        // Released before any `SessionState` lock is taken.
        let open_files = app.state::<crate::window::OpenFiles>();
        let mut reg = open_files.0.lock().unwrap();
        let reported: Vec<(String, Option<String>)> =
            tabs.iter().map(|t| (t.tab_id.clone(), t.path.clone())).collect();
        reg.sync(&label, &reported, active.as_deref());
    }

    let snapshots = tab_snapshots(&state, &label, tabs, write_untitled)?;
    state.set_tabs(&label, snapshots, active);

    // Geometry also rides the heartbeat, because `Moved`/`Resized` never fire for
    // a window the user does not touch — leaving it recorded at 0x0 and restored
    // into the top-left corner under the menu bar.
    if let Some((x, y, width, height)) = window_geometry(&window) {
        state.set_geometry(&label, x, y, width, height);
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
    use std::cell::RefCell;

    fn tab(id: &str, path: Option<&str>) -> TabSnapshot {
        TabSnapshot {
            tab_id: id.to_string(),
            path: path.map(str::to_string),
            untitled: None,
            cursor: 5,
            top_line: 3,
        }
    }

    fn untitled_tab(id: &str, sidecar: &str) -> TabSnapshot {
        TabSnapshot {
            untitled: Some(sidecar.to_string()),
            ..tab(id, None)
        }
    }

    fn window(tabs: Vec<TabSnapshot>) -> WindowSnapshot {
        WindowSnapshot {
            x: 10,
            y: 20,
            width: 900,
            height: 700,
            active_tab: tabs.first().map(|t| t.tab_id.clone()),
            tabs,
        }
    }

    fn session(windows: Vec<WindowSnapshot>) -> Session {
        Session {
            version: SESSION_VERSION,
            saved_at: 0,
            windows,
        }
    }

    #[test]
    fn json_roundtrip_uses_camel_case() {
        let s = Session {
            saved_at: 42,
            ..session(vec![window(vec![tab("t1", Some("/tmp/a.md"))])])
        };
        let json = serde_json::to_string(&s).unwrap();
        for key in ["\"topLine\":3", "\"savedAt\":42", "\"tabId\":\"t1\"", "\"activeTab\":\"t1\""] {
            assert!(json.contains(key), "{key} missing in {json}");
        }
        let back = parse_session(&json).expect("parses");
        assert_eq!(back.windows[0].tabs[0].path.as_deref(), Some("/tmp/a.md"));
    }

    #[test]
    fn a_missing_top_line_defaults_to_one_and_zero_is_normalized() {
        let json = r#"{"version":2,"savedAt":0,"windows":[{"x":0,"y":0,"width":900,"height":700,
            "tabs":[{"tabId":"a","path":"/tmp/a.md"},{"tabId":"b","path":"/tmp/b.md","topLine":0}]}]}"#;
        let s = parse_session(json).unwrap();
        assert_eq!(s.windows[0].tabs[0].top_line, 1);
        assert_eq!(s.windows[0].tabs[0].cursor, 0);
        assert_eq!(s.windows[0].tabs[1].top_line, 1);
    }

    #[test]
    fn parse_session_migrates_a_v1_file_to_one_tab_per_window() {
        let json = r#"{"version":1,"savedAt":7,"windows":[
            {"path":"/tmp/a.md","untitled":null,"x":1,"y":2,"width":900,"height":700,"cursor":4,"topLine":5,"tabId":"11-22-0"},
            {"path":null,"untitled":"untitled-main.md","x":0,"y":0,"width":900,"height":700}
        ]}"#;
        let s = parse_session(json).expect("v1 is still read");
        assert_eq!(s.version, SESSION_VERSION);
        assert_eq!(s.saved_at, 7);
        assert_eq!(s.windows.len(), 2);

        let first = &s.windows[0];
        assert_eq!((first.x, first.y, first.width, first.height), (1, 2, 900, 700));
        assert_eq!(first.tabs.len(), 1);
        assert_eq!(first.tabs[0].tab_id, "11-22-0");
        assert_eq!(first.tabs[0].path.as_deref(), Some("/tmp/a.md"));
        assert_eq!((first.tabs[0].cursor, first.tabs[0].top_line), (4, 5));
        assert_eq!(first.active_tab.as_deref(), Some("11-22-0"));

        let second = &s.windows[1];
        assert!(!second.tabs[0].tab_id.is_empty(), "an entry without tabId gets a fresh one");
        assert_eq!(
            second.tabs[0].untitled.as_deref(),
            Some("untitled-main.md"),
            "the sidecar name is carried verbatim"
        );
        assert_eq!(second.active_tab.as_deref(), Some(second.tabs[0].tab_id.as_str()));
    }

    #[test]
    fn parse_session_rejects_future_versions_and_garbage() {
        assert!(parse_session(r#"{"version":99,"savedAt":0,"windows":[]}"#).is_none());
        assert!(parse_session("not json at all").is_none());
        assert!(parse_session("").is_none());
    }

    #[test]
    fn choose_session_prefers_v2() {
        let v2 = serde_json::to_string(&session(vec![window(vec![tab("t2", Some("/v2.md"))])])).unwrap();
        let v1 = r#"{"version":1,"savedAt":0,"windows":[{"path":"/v1.md","x":0,"y":0,"width":9,"height":9}]}"#;
        let s = choose_session(Some(&v2), Some(v1)).unwrap();
        assert_eq!(s.windows[0].tabs[0].path.as_deref(), Some("/v2.md"));
    }

    #[test]
    fn choose_session_migrates_v1_when_there_is_no_v2_yet() {
        let v1 = r#"{"version":1,"savedAt":0,"windows":[{"path":"/v1.md","x":0,"y":0,"width":9,"height":9}]}"#;
        let s = choose_session(None, Some(v1)).unwrap();
        assert_eq!(s.windows[0].tabs[0].path.as_deref(), Some("/v1.md"));
    }

    #[test]
    fn choose_session_falls_back_to_v1_when_v2_is_corrupt() {
        let v1 = r#"{"version":1,"savedAt":0,"windows":[{"path":"/v1.md","x":0,"y":0,"width":9,"height":9}]}"#;
        let s = choose_session(Some("{truncated"), Some(v1)).unwrap();
        assert_eq!(s.windows[0].tabs[0].path.as_deref(), Some("/v1.md"));
        assert!(choose_session(None, None).is_none());
    }

    #[test]
    fn prune_missing_drops_gone_files_but_keeps_untitled_tabs() {
        let s = session(vec![window(vec![
            tab("gone", Some("/tmp/gone.md")),
            tab("here", Some("/tmp/here.md")),
            untitled_tab("u", "untitled-u.md"),
            tab("blank", None),
        ])]);
        let pruned = prune_missing(s, |p| p == "/tmp/here.md");
        let ids: Vec<&str> = pruned.windows[0].tabs.iter().map(|t| t.tab_id.as_str()).collect();
        assert_eq!(ids, vec!["here", "u"], "an untitled tab without a sidecar never earned a place");
    }

    #[test]
    fn prune_missing_moves_active_to_the_first_surviving_tab() {
        let mut w = window(vec![tab("gone", Some("/tmp/gone.md")), tab("here", Some("/tmp/here.md"))]);
        w.active_tab = Some("gone".to_string());
        let pruned = prune_missing(session(vec![w]), |p| p == "/tmp/here.md");
        assert_eq!(pruned.windows[0].active_tab.as_deref(), Some("here"));
    }

    #[test]
    fn prune_missing_drops_a_window_left_with_no_tabs() {
        let pruned = prune_missing(session(vec![window(vec![tab("a", Some("/gone.md"))])]), |_| false);
        assert!(pruned.windows.is_empty());
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
            let path = format!("/tmp/{}.md", label);
            state.set_tabs(label, vec![tab(label, Some(&path))], Some(label.to_string()));
        }
        let paths: Vec<String> = state
            .snapshot(0)
            .windows
            .into_iter()
            .filter_map(|w| w.tabs[0].path.clone())
            .collect();
        assert_eq!(paths, vec!["/tmp/main.md", "/tmp/editor-2.md", "/tmp/editor-10.md"]);
    }

    #[test]
    fn set_tabs_keeps_geometry() {
        let state = SessionState::new();
        state.set_geometry("editor-1", 7, 8, 500, 600);
        state.set_tabs("editor-1", vec![tab("t", Some("/tmp/a.md"))], Some("t".to_string()));
        let w = &state.snapshot(0).windows[0];
        assert_eq!((w.x, w.y, w.width, w.height), (7, 8, 500, 600));
        assert_eq!(w.tabs[0].path.as_deref(), Some("/tmp/a.md"));
    }

    #[test]
    fn referenced_untitled_covers_every_tab_of_live_windows() {
        let state = SessionState::new();
        state.set_tabs(
            "editor-2",
            vec![untitled_tab("a", "untitled-a.md"), untitled_tab("b", "untitled-b.md")],
            Some("a".to_string()),
        );
        let referenced = state.referenced_untitled();
        assert!(referenced.contains("untitled-a.md"));
        assert!(referenced.contains("untitled-b.md"), "a background tab's draft is kept too");
    }

    #[test]
    fn referenced_untitled_covers_the_pending_restore() {
        // Regression: the live session starts empty at launch while `pending`
        // still holds the previous run, so pruning on the live set alone deleted
        // the very buffer the user was about to reopen.
        let state = SessionState::new();
        state.set_pending(vec![window(vec![untitled_tab("m", "untitled-main.md")])]);
        assert!(state.snapshot(0).windows.is_empty(), "live session is empty");
        assert!(state.referenced_untitled().contains("untitled-main.md"));
    }

    #[test]
    fn restore_keeps_not_yet_opened_windows_drafts_referenced() {
        let state = SessionState::new();
        state.set_pending(vec![
            window(vec![untitled_tab("a", "untitled-a.md")]),
            window(vec![untitled_tab("b", "untitled-b.md")]),
        ]);
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
    fn take_pending_empties_the_queue_once() {
        let state = SessionState::new();
        state.set_pending(vec![window(vec![tab("a", Some("/tmp/a.md"))])]);
        assert_eq!(state.pending_count(), 1);
        assert_eq!(state.take_pending().len(), 1);
        assert_eq!(state.pending_count(), 0);
        assert!(state.take_pending().is_empty());
    }

    #[test]
    fn seed_is_a_noop_while_quitting() {
        let state = SessionState::new();
        state.mark_quitting();
        state.seed("editor-5", window(vec![tab("a", Some("/tmp/a.md"))]));
        assert!(state.snapshot_for("editor-5").is_none());
    }

    #[test]
    fn seed_marks_the_session_dirty_and_never_overwrites() {
        let state = SessionState::new();
        state.seed("editor-5", window(vec![tab("first", Some("/tmp/a.md"))]));
        assert!(state.take_dirty());
        state.seed("editor-5", window(vec![tab("second", Some("/tmp/b.md"))]));
        assert_eq!(state.snapshot_for("editor-5").unwrap().tabs[0].tab_id, "first");
    }

    #[test]
    fn untitled_file_name_is_derived_from_tab_id() {
        assert_eq!(untitled_file_name("17-42-3"), "untitled-17-42-3.md");
    }

    #[test]
    fn tab_id_is_millis_pid_counter_and_so_file_name_safe() {
        let id = new_tab_id();
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 3, "got {}", id);
        assert!(parts.iter().all(|p| p.parse::<u128>().is_ok()), "got {}", id);
        assert_eq!(parts[1], std::process::id().to_string());
        assert_ne!(new_tab_id(), new_tab_id());
    }

    #[test]
    fn untitled_file_for_keeps_a_restored_legacy_name() {
        let state = SessionState::new();
        state.seed("editor-7", window(vec![untitled_tab("t", "untitled-editor-3.md")]));
        assert_eq!(state.untitled_file_for("editor-7", "t"), "untitled-editor-3.md");
    }

    #[test]
    fn untitled_file_for_a_fresh_tab_is_named_by_its_id() {
        let state = SessionState::new();
        assert_eq!(state.untitled_file_for("main", "9-9-9"), "untitled-9-9-9.md");
    }

    #[test]
    fn tab_snapshots_write_each_untitled_tab_under_its_own_name() {
        let state = SessionState::new();
        state.seed("main", window(vec![untitled_tab("old", "untitled-main.md")]));
        let written = RefCell::new(Vec::<(String, String)>::new());
        let reports = vec![
            TabReport { tab_id: "old".into(), path: None, cursor: 1, top_line: 0, content: Some("kept".into()) },
            TabReport { tab_id: "new".into(), path: None, cursor: 0, top_line: 1, content: Some("fresh".into()) },
            TabReport { tab_id: "blank".into(), path: None, cursor: 0, top_line: 1, content: Some(String::new()) },
            TabReport { tab_id: "file".into(), path: Some("/tmp/a.md".into()), cursor: 9, top_line: 4, content: None },
        ];
        let snaps = tab_snapshots(&state, "main", reports, |name, text| {
            written.borrow_mut().push((name.to_string(), text.to_string()));
            Ok(())
        })
        .unwrap();

        assert_eq!(
            written.into_inner(),
            vec![
                ("untitled-main.md".to_string(), "kept".to_string()),
                ("untitled-new.md".to_string(), "fresh".to_string()),
            ]
        );
        let names: Vec<Option<&str>> = snaps.iter().map(|s| s.untitled.as_deref()).collect();
        assert_eq!(names, vec![Some("untitled-main.md"), Some("untitled-new.md"), None, None]);
        assert_eq!(snaps[0].top_line, 1, "a reported 0 is normalized");
        assert_eq!((snaps[3].cursor, snaps[3].top_line), (9, 4));
    }

    #[test]
    fn tab_snapshots_fail_when_a_sidecar_cannot_be_written() {
        let state = SessionState::new();
        let reports = vec![TabReport { tab_id: "u".into(), path: None, cursor: 0, top_line: 1, content: Some("text".into()) }];
        assert!(tab_snapshots(&state, "main", reports, |_, _| Err("disk full".into())).is_err());
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
        assert_eq!((a.x, a.y, a.width, a.height), (11, 22, 800, 600));
        assert_eq!(a.tabs.len(), 1);
        assert_eq!(a.tabs[0].path.as_deref(), Some("/tmp/a.md"));
        assert_eq!((a.tabs[0].cursor, a.tabs[0].top_line), (42, 9));
        assert_eq!(a.active_tab.as_deref(), Some(a.tabs[0].tab_id.as_str()));
        let b = WindowSnapshot::from_closed_entry(entry);
        assert_ne!(a.tabs[0].tab_id, b.tabs[0].tab_id, "every reopened tab is a new tab");
    }

    #[test]
    fn a_second_take_pending_during_a_restore_gets_nothing() {
        let state = SessionState::new();
        state.set_pending(vec![window(vec![tab("a", Some("/tmp/a.md"))])]);
        assert_eq!(state.take_pending().len(), 1);
        assert!(state.take_pending().is_empty());
        assert_eq!(state.pending_count(), 0);
    }

    #[test]
    fn seeded_untitled_stays_referenced_after_the_pending_restore_is_taken() {
        let state = SessionState::new();
        state.set_pending(vec![window(vec![untitled_tab("m", "untitled-main.md")])]);
        let restored = state.take_pending().remove(0);
        state.seed("editor-4", restored);
        state.finish_restore();
        assert!(state.referenced_untitled().contains("untitled-main.md"));
    }

    #[test]
    fn snapshot_for_returns_the_recorded_entry_and_none_for_an_unknown_label() {
        let state = SessionState::new();
        state.set_tabs("editor-1", vec![tab("t", Some("/tmp/a.md"))], Some("t".to_string()));
        let snap = state.snapshot_for("editor-1").expect("entry exists");
        assert_eq!(snap.tabs[0].path.as_deref(), Some("/tmp/a.md"));
        assert!(state.snapshot_for("no-such-window").is_none());
    }

    #[test]
    fn a_migrated_v1_untitled_sidecar_is_referenced_until_its_window_is_restored() {
        // The ticker prunes against `referenced_untitled` from its first tick;
        // a v1 sidecar must survive until the restore has opened its window.
        let v1 = r#"{"version":1,"savedAt":0,"windows":[
            {"path":null,"untitled":"untitled-main.md","x":0,"y":0,"width":900,"height":700,"tabId":"1-2-3"}
        ]}"#;
        let migrated = prune_missing(choose_session(None, Some(v1)).unwrap(), |_| true);
        let state = SessionState::new();
        state.set_pending(migrated.windows);
        assert!(state.referenced_untitled().contains("untitled-main.md"));

        let snapshots = state.take_pending();
        assert_eq!(snapshots[0].tabs[0].tab_id, "1-2-3", "the v1 tab id is carried");
        assert!(state.referenced_untitled().contains("untitled-main.md"), "mid-restore");
        state.seed("editor-1", snapshots[0].clone());
        state.finish_restore();
        assert!(state.referenced_untitled().contains("untitled-main.md"), "after restore");
        assert_eq!(
            state.untitled_file_for("editor-1", "1-2-3"),
            "untitled-main.md",
            "the restored tab goes on writing to the v1 sidecar"
        );
    }

    #[test]
    fn a_heartbeat_with_an_empty_untitled_buffer_drops_the_sidecar_name() {
        let state = SessionState::new();
        state.seed("main", window(vec![untitled_tab("u", "untitled-u.md")]));
        let reports = vec![TabReport { tab_id: "u".into(), path: None, cursor: 0, top_line: 1, content: Some(String::new()) }];
        let snaps = tab_snapshots(&state, "main", reports, |_, _| panic!("no sidecar for an empty buffer")).unwrap();
        state.set_tabs("main", snaps, Some("u".to_string()));
        assert!(!state.referenced_untitled().contains("untitled-u.md"));
        assert!(prune_missing(state.snapshot(0), |_| true).windows.is_empty(), "a blank tab never comes back");
    }

    #[test]
    fn this_build_writes_only_the_v2_file() {
        assert_eq!(SESSION_FILE, "session-v2.json");
        assert_ne!(SESSION_FILE, LEGACY_SESSION_FILE);
    }
}
