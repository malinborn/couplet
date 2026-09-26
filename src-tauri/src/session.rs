use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
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
/// clock and the pid so two different launches never collide either — a
/// window label (`main`, `editor-2`, …) cannot name a sidecar, because every
/// launch reuses it. Only digits and `-`: it ends up in a file name.
pub fn new_tab_id() -> String {
    let millis = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = TAB_ID_COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{}-{}-{}", millis, std::process::id(), n)
}

/// Whether `id` has the shape `new_tab_id` produces. An id names a sidecar
/// file, so anything else — a `/`, a `..` — must never reach one.
pub fn is_valid_tab_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit() || b == b'-')
}

/// Refuse a heartbeat carrying any tab id `new_tab_id` could not have made.
pub fn check_tab_ids(reports: &[TabReport]) -> Result<(), String> {
    match reports.iter().find(|r| !is_valid_tab_id(&r.tab_id)) {
        Some(bad) => Err(format!("invalid tab id: {:?}", bad.tab_id)),
        None => Ok(()),
    }
}

/// One tab as it was when the session was captured.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
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
    /// When the tab was opened, ms since the epoch — the drawer's ⌘L. `0`:
    /// unknown (a session written before the drawer); the frontend stamps it.
    #[serde(default)]
    pub opened_at: u64,
    /// The last moment it was the active tab of a focused window — ⌘R. `0`: never.
    #[serde(default)]
    pub viewed_at: u64,
    /// The last change to its text, by the human or an agent — the drawer
    /// card's time. `0`: none, or a session written before the stamp.
    #[serde(default)]
    pub edited_at: u64,
    /// An agent put it up while nobody was looking, and nobody has since
    /// (spec §2) — it shimmers until it is seen.
    #[serde(default)]
    pub unviewed: bool,
    /// A quick look (spec §7) still waiting for «Закрыть / Оставить»
    /// (tabs-questions Q8). Absent in sessions written before Q8: an ordinary tab.
    #[serde(default)]
    pub transient: bool,
    /// When the human first saw the quick look, ms since the epoch — its hour
    /// counts from here, across a restart too. `0`: not seen yet.
    #[serde(default)]
    pub transient_seen_at: u64,
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
    /// The window's `#N`, kept across restarts. Absent in migrated v1 data.
    #[serde(default)]
    pub number: Option<u32>,
    /// The project the window is bound to (`WindowTabs::project`). Absent in
    /// sessions written before projects: bound again from the first file.
    #[serde(default)]
    pub project: Option<String>,
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
            number: None,
            project: None,
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
    /// The number of the window it was closed from comes along;
    /// `open_restored_window` keeps it when it is free.
    pub fn from_closed_entry(entry: crate::closed::ClosedEntry) -> Self {
        let tab_id = new_tab_id();
        Self {
            number: entry.number,
            project: None,
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
                ..Default::default()
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
    /// Optional: a file without one gets a fresh id — harmless, because
    /// `untitled` holds the sidecar's literal name.
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
                number: None,
                project: None,
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
                    ..Default::default()
                }],
            })
            .collect(),
    }
}

/// Prefix of every untitled sidecar this build names (`untitled_file_name`).
const DRAFT_PREFIX: &str = "draft-";

/// Prefix of the sidecars older builds named: `untitled-<label>.md` (v1) and
/// `untitled-<tab_id>.md` (tabs before Q3). Still read, still kept by the GC;
/// never given to a new tab.
const LEGACY_UNTITLED_PREFIX: &str = "untitled-";

/// Name of the sidecar file holding an untitled tab's text — keyed by the
/// tab's id rather than a window label, which every launch reuses.
///
/// `draft-`, not `untitled-` (tabs-questions Q3): a pre-tabs build prunes
/// every `untitled-*.md` its own `session.json` does not name, and it never
/// reads `session-v2.json` — after a rollback it would delete the drafts this
/// build made. A `draft-` file it neither shows nor deletes. A sidecar that
/// already has an `untitled-` name keeps it (`SessionState::untitled_file_for`):
/// renaming the only copy of an unsaved draft buys nothing but a window in
/// which the GC sees neither name referenced.
pub fn untitled_file_name(tab_id: &str) -> String {
    format!("{DRAFT_PREFIX}{tab_id}.md")
}

/// Whether `name` is an untitled sidecar of this build or an older one — what
/// `prune_untitled_files` may move to the trash when nothing refers to it. Its temp file
/// (`<name>.tmp`) is not.
pub fn is_untitled_sidecar(name: &str) -> bool {
    (name.starts_with(DRAFT_PREFIX) || name.starts_with(LEGACY_UNTITLED_PREFIX)) && name.ends_with(".md")
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

/// The windows of the previous session nobody has restored yet — still in
/// `pending`, or taken by a restore that has not seeded them — that hold an
/// untitled draft. `snapshot` writes them after the live windows.
///
/// Restoring is opt-in, so a launch may never restore; without these, the
/// file it writes stops naming their drafts and the next launch's GC takes
/// them (the 2026-09-26 loss, stash-01 plan). A window of file tabs only is
/// not carried: its files are on disk, and carrying it would grow the restore
/// offer with every launch. A window with any live tab has been seeded by a
/// restore and is written as that live window, never twice.
fn unrestored_draft_windows<'a>(
    live: &[WindowSnapshot],
    waiting: impl Iterator<Item = &'a WindowSnapshot>,
) -> Vec<WindowSnapshot> {
    let live_ids: HashSet<&str> = live
        .iter()
        .flat_map(|w| w.tabs.iter())
        .map(|t| t.tab_id.as_str())
        .collect();
    waiting
        .filter(|w| w.tabs.iter().any(|t| t.path.is_none() && t.untitled.is_some()))
        .filter(|w| !w.tabs.iter().any(|t| live_ids.contains(t.tab_id.as_str())))
        .map(WindowSnapshot::normalized)
        .collect()
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

    /// Replace this window's tabs outright. The heartbeat goes through
    /// `set_reported_tabs`, which keeps tabs a report omitted.
    #[cfg(test)]
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

    /// `set_tabs` for a heartbeat: tabs the registry still holds
    /// (`registry_ids`) but the report omitted keep their current snapshot —
    /// see `with_omitted_tabs`. Merged under the same lock that stores it, so
    /// two heartbeats cannot interleave between the read and the write.
    pub fn set_reported_tabs(
        &self,
        label: &str,
        reported: Vec<TabSnapshot>,
        active_tab: Option<String>,
        registry_ids: &[String],
    ) {
        if self.is_quitting() {
            return;
        }
        let mut map = self.entries.lock().unwrap();
        let entry = map
            .entry(label.to_string())
            .or_insert_with(WindowSnapshot::empty);
        entry.tabs = with_omitted_tabs(reported, registry_ids, Some(&*entry));
        entry.active_tab = active_tab;
        drop(map);
        self.touch();
    }

    pub fn set_number(&self, label: &str, number: Option<u32>) {
        if self.is_quitting() {
            return;
        }
        let mut map = self.entries.lock().unwrap();
        let entry = map
            .entry(label.to_string())
            .or_insert_with(WindowSnapshot::empty);
        entry.number = number;
        drop(map);
        self.touch();
    }

    pub fn set_project(&self, label: &str, project: Option<String>) {
        if self.is_quitting() {
            return;
        }
        let mut map = self.entries.lock().unwrap();
        let entry = map
            .entry(label.to_string())
            .or_insert_with(WindowSnapshot::empty);
        entry.project = project;
        drop(map);
        self.touch();
    }

    /// The sidecar one untitled tab writes to: the name this window's entry
    /// already records for it, else one derived from its id.
    ///
    /// Keeping a recorded name lets a tab restored from an older session —
    /// sidecar `untitled-main.md`, or `untitled-<tab_id>.md` from before
    /// `draft-` — go on writing to the file it was restored from instead of
    /// orphaning it.
    pub fn untitled_file_for(&self, label: &str, tab_id: &str) -> String {
        let map = self.entries.lock().unwrap();
        map.get(label)
            .and_then(|w| w.tabs.iter().find(|t| t.tab_id == tab_id))
            .and_then(|t| t.untitled.clone())
            .unwrap_or_else(|| untitled_file_name(tab_id))
    }

    /// Drop one closed tab from its window's entry now, so a quit before the
    /// next heartbeat does not bring it back.
    pub fn remove_tab(&self, label: &str, tab_id: &str) {
        if self.is_quitting() {
            return;
        }
        let mut map = self.entries.lock().unwrap();
        if let Some(entry) = map.get_mut(label) {
            entry.tabs.retain(|t| t.tab_id != tab_id);
            if entry.active_tab.as_deref() == Some(tab_id) {
                entry.active_tab = entry.tabs.first().map(|t| t.tab_id.clone());
            }
        }
        drop(map);
        self.touch();
    }

    /// A tab moved to another window (`tab_move`): its snapshot leaves
    /// `from`'s entry and joins `to`'s now, not at the next heartbeat — a
    /// quit in between would otherwise restore it in neither window. The
    /// `untitled` name the source recorded is kept, so the draft goes on
    /// being written to (and referenced as) the file it already has.
    pub fn move_tab(&self, from: &str, to: &str, mut tab: TabSnapshot) {
        if self.is_quitting() {
            return;
        }
        let mut map = self.entries.lock().unwrap();
        let old = map.get_mut(from).and_then(|w| {
            let at = w.tabs.iter().position(|t| t.tab_id == tab.tab_id)?;
            let old = w.tabs.remove(at);
            if w.active_tab.as_deref() == Some(tab.tab_id.as_str()) {
                w.active_tab = w.tabs.first().map(|t| t.tab_id.clone());
            }
            Some(old)
        });
        if tab.untitled.is_none() {
            tab.untitled = old.and_then(|t| t.untitled);
        }
        let entry = map.entry(to.to_string()).or_insert_with(WindowSnapshot::empty);
        entry.tabs.retain(|t| t.tab_id != tab.tab_id);
        entry.tabs.push(tab);
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

    /// The session to write: the live windows (main first), then the
    /// un-restored ones that hold drafts (`unrestored_draft_windows`).
    pub fn snapshot(&self, saved_at: u64) -> Session {
        self.snapshot_counting_live(saved_at).0
    }

    /// What the exit path writes, or `None` to leave the file on disk alone.
    ///
    /// `None` when no window is live. That means the windows were destroyed
    /// before the exit path ran (the red button on the last window) — not
    /// that the user had nothing open — so the last good file is the better
    /// answer. The carried windows must not count: `[W1]` written over the
    /// ticker's `[main, W1]` would drop `main`.
    ///
    /// Skipping keeps the un-restored drafts named too. `pending` was read
    /// from the file on disk, so until this run writes, that file names every
    /// window in it; and every write of this run (`snapshot`) carries them.
    /// Either way the file left standing names them.
    pub fn exit_snapshot(&self, saved_at: u64) -> Option<Session> {
        let (session, live) = self.snapshot_counting_live(saved_at);
        (live > 0).then_some(session)
    }

    /// `snapshot`, plus how many of its windows are live — both under one
    /// hold of the locks, so the count describes the same session.
    fn snapshot_counting_live(&self, saved_at: u64) -> (Session, usize) {
        // entries → pending → restoring: the one lock order (`referenced_untitled`).
        let map = self.entries.lock().unwrap();
        let pending = self.pending.lock().unwrap();
        let restoring = self.restoring.lock().unwrap();
        let mut labelled: Vec<(&String, &WindowSnapshot)> = map.iter().collect();
        labelled.sort_by_key(|(label, _)| label_order(label));
        let mut windows: Vec<WindowSnapshot> =
            labelled.into_iter().map(|(_, w)| w.normalized()).collect();
        let live = windows.len();
        let carried = unrestored_draft_windows(&windows, pending.iter().chain(restoring.iter()));
        windows.extend(carried);
        let session = Session {
            version: SESSION_VERSION,
            saved_at,
            windows,
        };
        (session, live)
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
    /// All of them matter. At startup the live session is empty while `pending`
    /// still holds the previous run's windows. Collecting only the live half makes
    /// the ticker trash exactly the unsaved buffers the user is about to reopen.
    /// This protects them for this run; `snapshot` carries them to the next one.
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

/// The previous run's session: whichever of `session-v2.json` and the
/// pre-tabs `session.json` (migrated) was saved last, v2 on a tie. A file
/// that does not parse loses to one that does — an older snapshot beats none.
///
/// Newest, not "v2 first": an older build run after this one (a rollback, or
/// a dev build of another branch sharing the data dir) writes only
/// `session.json`, and preferring the stale v2 would restore the wrong
/// windows and leave the newer file's sidecars unreferenced — the first
/// prune deletes them.
pub fn choose_session(current: Option<&str>, legacy: Option<&str>) -> Option<Session> {
    let current = current.and_then(parse_session);
    let legacy = legacy.and_then(parse_session);
    match (current, legacy) {
        (Some(current), Some(legacy)) if legacy.saved_at > current.saved_at => Some(legacy),
        (current, legacy) => current.or(legacy),
    }
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

/// Read the session (the newer of v2 and v1 migrated), dropping tabs whose
/// file has since disappeared.
pub fn read_session() -> Option<Session> {
    let read = |name: &str| data_file(name).ok().and_then(|p| fs::read_to_string(p).ok());
    let current = read(SESSION_FILE);
    let legacy = read(LEGACY_SESSION_FILE);
    let session = choose_session(current.as_deref(), legacy.as_deref())?;
    let session = with_paths_normalized(session, crate::path_norm::normalize_str);
    Some(prune_missing(session, |p| std::path::Path::new(p).exists()))
}

/// Every file path and project of `session` through `normalize`, before any
/// of it is registered: a session written before paths were normalized holds
/// `/tmp/a.md` where agents now send `/private/tmp/a.md` — one file, two tabs.
pub fn with_paths_normalized(session: Session, normalize: impl Fn(&str) -> String) -> Session {
    let Session {
        version,
        saved_at,
        mut windows,
    } = session;
    for w in &mut windows {
        w.project = w.project.as_deref().map(&normalize);
        for t in &mut w.tabs {
            t.path = t.path.as_deref().map(&normalize);
        }
    }
    Session {
        version,
        saved_at,
        windows,
    }
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

/// Folder inside `session/` that receives every draft the session lets go of.
/// A dot-name: `is_untitled_sidecar` never matches it, so the GC never
/// treats the folder itself as something to move.
const DRAFTS_TRASH_DIR: &str = ".trash";

/// Marks when a file entered the trash, inside its name: `rename` keeps the
/// old mtime, so the name is the only record of when it was thrown away.
const TRASHED_MARK: &str = ".trashed-";

/// `Ok` only when `trash` is a real directory. A symlink there would send
/// the drafts — and the purge's deletions — to wherever it points.
fn require_real_trash_dir(trash: &Path) -> Result<(), String> {
    match fs::symlink_metadata(trash) {
        Ok(meta) if meta.file_type().is_dir() => Ok(()),
        Ok(_) => Err(format!("{} is not a real directory", trash.display())),
        Err(e) => Err(format!("{}: {e}", trash.display())),
    }
}

/// Hard-link `src` into `trash` under the first free name for `stem` thrown
/// away at `now_secs`: `<stem>.trashed-<secs>.md`, then `…-<secs>-1.md`, …
///
/// The link is the free-name check: `hard_link` refuses a name that exists
/// (`AlreadyExists`, next name), where a check followed by `rename` would
/// replace a file that appeared in between. `src` is never touched.
fn link_into_trash(src: &Path, trash: &Path, stem: &str, now_secs: u64) -> Result<PathBuf, String> {
    for n in 0..1000u32 {
        let name = if n == 0 {
            format!("{stem}{TRASHED_MARK}{now_secs}.md")
        } else {
            format!("{stem}{TRASHED_MARK}{now_secs}-{n}.md")
        };
        let dest = trash.join(name);
        match fs::hard_link(src, &dest) {
            Ok(()) => return Ok(dest),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("link {} into the trash: {e}", src.display())),
        }
    }
    Err(format!("no free trash name for {stem}"))
}

/// When a trash file was thrown away, read back from its name. `None` for
/// any name this module did not make — the purge never touches those. The
/// tail is exactly what `link_into_trash` writes: `<secs>` or `<secs>-<n>`.
fn trashed_at(name: &str) -> Option<u64> {
    let rest = name.strip_suffix(".md")?;
    let at = rest.rfind(TRASHED_MARK)?;
    let tail = &rest[at + TRASHED_MARK.len()..];
    let (secs, n) = match tail.split_once('-') {
        Some((secs, n)) => (secs, Some(n)),
        None => (tail, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(secs) || n.is_some_and(|n| !digits(n)) {
        return None;
    }
    secs.parse().ok()
}

/// Move one sidecar into `trash`: link it in (`link_into_trash`), then
/// unlink the original — at every moment at least one name holds the text.
/// When the link fails the file stays where it was; when only the unlink
/// fails both names remain, which the next pass retries.
fn move_to_trash(src: &Path, trash: &Path, now_secs: u64) -> Result<PathBuf, String> {
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("not a UTF-8 file name: {}", src.display()))?;
    let stem = name.strip_suffix(".md").unwrap_or(name);
    fs::create_dir_all(trash).map_err(|e| format!("create {}: {e}", trash.display()))?;
    require_real_trash_dir(trash)?;
    let dest = link_into_trash(src, trash, stem, now_secs)?;
    fs::remove_file(src).map_err(|e| format!("{name} is in the trash but still in session/: {e}"))?;
    Ok(dest)
}

/// Move untitled sidecars nothing refers to any more into `session/.trash/`.
/// Never deletes: a draft leaves the session only with a copy kept.
///
/// Take the names from `SessionState::referenced_untitled`, never from the live
/// snapshot alone — see that method for why.
pub fn prune_untitled_files(referenced: &HashSet<String>) {
    let Ok(dir) = session_dir() else { return };
    prune_untitled_files_in(&dir, referenced, now_secs());
}

/// `prune_untitled_files` in `dir`: both sidecar prefixes (`is_untitled_sidecar`).
fn prune_untitled_files_in(dir: &Path, referenced: &HashSet<String>, now_secs: u64) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let trash = dir.join(DRAFTS_TRASH_DIR);
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !is_untitled_sidecar(name) || referenced.contains(name) {
            continue;
        }
        if let Err(e) = move_to_trash(&entry.path(), &trash, now_secs) {
            eprintln!("session: kept an unreferenced draft in place: {e}");
        }
    }
}

/// `<app data dir>/session/.trash/` — created on demand by whoever puts
/// something there.
pub fn drafts_trash_dir() -> Result<PathBuf, String> {
    Ok(session_dir()?.join(DRAFTS_TRASH_DIR))
}

/// How long a draft stays in `session/.trash/`, counted from the stamp in its name.
pub const DRAFTS_TRASH_KEEP_SECS: u64 = 30 * 24 * 60 * 60;

/// How often a running app purges the trash; it also purges on its first tick.
pub const DRAFTS_TRASH_PURGE_EVERY: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

/// Delete trash files thrown away more than `DRAFTS_TRASH_KEEP_SECS` ago —
/// the end of the retention the trash promised, the only deletion of user
/// text there is.
pub fn purge_drafts_trash(now_secs: u64) {
    let Ok(trash) = drafts_trash_dir() else { return };
    purge_trash_in(&trash, now_secs);
}

/// `purge_drafts_trash` in `trash`. Only regular files whose name carries a
/// stamp this module wrote; anything else is left alone.
fn purge_trash_in(trash: &Path, now_secs: u64) {
    if fs::symlink_metadata(trash).is_err() {
        return; // Nothing thrown away yet.
    }
    if let Err(e) = require_real_trash_dir(trash) {
        eprintln!("session: not purging the draft trash: {e}");
        return;
    }
    let Ok(entries) = fs::read_dir(trash) else { return };
    for entry in entries.flatten() {
        // `DirEntry::file_type` does not follow symlinks: a link is never
        // "a file", so neither it nor its target is ever removed.
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let name = entry.file_name();
        let Some(at) = name.to_str().and_then(trashed_at) else { continue };
        if now_secs.saturating_sub(at) > DRAFTS_TRASH_KEEP_SECS {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// ⌘W on an untitled tab with text — a deliberate discard (tabs spec §8) —
/// keeps that text as `session/.trash/closed-<tab_id>.trashed-<secs>.md`.
/// The sidecar alone can be a heartbeat (5 s) behind what was on screen.
pub fn rescue_untitled(tab_id: &str, text: &str) -> Result<PathBuf, String> {
    rescue_untitled_in(&drafts_trash_dir()?, tab_id, text, now_secs())
}

fn rescue_untitled_in(trash: &Path, tab_id: &str, text: &str, now_secs: u64) -> Result<PathBuf, String> {
    if !is_valid_tab_id(tab_id) {
        return Err(format!("invalid tab id: {tab_id:?}"));
    }
    fs::create_dir_all(trash).map_err(|e| format!("create {}: {e}", trash.display()))?;
    require_real_trash_dir(trash)?;
    let tmp = trash.join(format!(".closed-{tab_id}.tmp"));
    fs::write(&tmp, text).map_err(|e| format!("write the rescue copy: {e}"))?;
    // Linked, not renamed, so an earlier trash file of the same name is never
    // replaced. The temp is only a second name for what the link now holds.
    let linked = link_into_trash(&tmp, trash, &format!("closed-{tab_id}"), now_secs);
    let _ = fs::remove_file(&tmp);
    linked.map_err(|e| format!("save the rescue copy: {e}"))
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
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabReport {
    pub tab_id: String,
    pub path: Option<String>,
    pub cursor: usize,
    pub top_line: usize,
    /// An untitled tab's text; `None` for a file tab.
    pub content: Option<String>,
    /// Drawer stamps — see `TabSnapshot`. Defaulted so a heartbeat from a
    /// frontend without the drawer is still accepted.
    #[serde(default)]
    pub opened_at: u64,
    #[serde(default)]
    pub viewed_at: u64,
    #[serde(default)]
    pub edited_at: u64,
    #[serde(default)]
    pub unviewed: bool,
    /// Quick-look state — see `TabSnapshot`. Defaulted like the stamps.
    #[serde(default)]
    pub transient: bool,
    #[serde(default)]
    pub transient_seen_at: u64,
}

/// Turn a heartbeat into snapshots, plus the sidecar writes it calls for
/// (`(file name, text)`), not yet made — see `record_heartbeat` on why.
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
) -> (Vec<TabSnapshot>, Vec<(String, String)>) {
    let mut writes = Vec::new();
    let snapshots = reports
        .into_iter()
        .map(|r| {
            let untitled = match (&r.path, r.content) {
                (None, Some(text)) if !text.is_empty() => {
                    let name = state.untitled_file_for(label, &r.tab_id);
                    writes.push((name.clone(), text));
                    Some(name)
                }
                _ => None,
            };
            TabSnapshot {
                tab_id: r.tab_id,
                path: r.path,
                untitled,
                cursor: r.cursor,
                top_line: r.top_line.max(1),
                opened_at: r.opened_at,
                viewed_at: r.viewed_at,
                edited_at: r.edited_at,
                unviewed: r.unviewed,
                transient: r.transient,
                transient_seen_at: r.transient_seen_at,
            }
        })
        .collect();
    (snapshots, writes)
}

/// `reported`, followed — in `registry_ids` order — by the tabs of
/// `previous` that the registry still holds but the report left out.
///
/// The registry keeps such tabs (a claim can be in flight while an older
/// report is on its way, see `TabRegistry::sync`); dropping them here would
/// strip a background untitled tab of its `untitled` name, and the next
/// prune would delete its draft.
pub fn with_omitted_tabs(
    mut reported: Vec<TabSnapshot>,
    registry_ids: &[String],
    previous: Option<&WindowSnapshot>,
) -> Vec<TabSnapshot> {
    let Some(previous) = previous else {
        return reported;
    };
    for id in registry_ids {
        if reported.iter().any(|t| &t.tab_id == id) {
            continue;
        }
        if let Some(tab) = previous.tabs.iter().find(|t| &t.tab_id == id) {
            reported.push(tab.clone());
        }
    }
    reported
}

/// Record one heartbeat: the window's tabs into `state`, then each untitled
/// tab's text into its sidecar through `write`.
///
/// In that order on purpose. The ticker prunes every sidecar
/// `referenced_untitled` does not name; a first sidecar written before its
/// name is recorded could be deleted in between, and a quit right then loses
/// the draft. A name recorded before its file exists is harmless: restore
/// skips an untitled tab whose sidecar cannot be read.
///
/// Tabs in `closed` (the registry's tombstones for this window) are left out
/// entirely: the report was sent before they were closed, and recording one
/// — or rewriting its sidecar — would bring a discarded tab back next launch.
pub fn record_heartbeat(
    state: &SessionState,
    label: &str,
    mut reports: Vec<TabReport>,
    active: Option<String>,
    registry_ids: &[String],
    closed: &HashSet<String>,
    write: impl Fn(&str, &str) -> Result<(), String>,
) -> Result<(), String> {
    reports.retain(|r| !closed.contains(&r.tab_id));
    let active = active.filter(|a| !closed.contains(a));
    let (snapshots, writes) = tab_snapshots(state, label, reports);
    state.set_reported_tabs(label, snapshots, active, registry_ids);
    let mut first_error = None;
    for (name, text) in &writes {
        if let Err(e) = write(name, text) {
            first_error.get_or_insert(e);
        }
    }
    first_error.map_or(Ok(()), Err)
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
    check_tab_ids(&tabs)?;
    let label = window.label().to_string();
    // Before the registry lock: binding walks the file system.
    crate::routing::bind_missing_projects(&app);
    let (registry_ids, closed, number, project) = {
        // Released before any `SessionState` lock is taken.
        let open_files = app.state::<crate::window::OpenFiles>();
        let mut reg = open_files.0.lock().unwrap();
        let reported: Vec<(String, Option<String>)> =
            tabs.iter().map(|t| (t.tab_id.clone(), t.path.clone())).collect();
        reg.sync(&label, &reported, active.as_deref());
        let window = reg.window(&label);
        let registry_ids: Vec<String> = window
            .map(|w| w.tabs.iter().map(|t| t.id.clone()).collect())
            .unwrap_or_default();
        let closed: HashSet<String> = window.map(|w| w.closed_ids.clone()).unwrap_or_default();
        (
            registry_ids,
            closed,
            window.and_then(|w| w.number),
            window.and_then(|w| w.project.clone()),
        )
    };

    state.set_number(&label, number);
    state.set_project(&label, project);
    record_heartbeat(&state, &label, tabs, active, &registry_ids, &closed, write_untitled)?;

    // Geometry also rides the heartbeat, because `Moved`/`Resized` never fire for
    // a window the user does not touch — leaving it recorded at 0x0 and restored
    // into the top-left corner under the menu bar.
    if let Some((x, y, width, height)) = window_geometry(&window) {
        state.set_geometry(&label, x, y, width, height);
    }
    Ok(())
}

/// The valid numbers of the windows a restore will build.
fn reserved_numbers<'a>(snapshots: impl Iterator<Item = &'a WindowSnapshot>) -> HashSet<u32> {
    snapshots
        .filter_map(|s| s.number)
        .filter(|n| crate::window_numbers::is_valid(*n))
        .collect()
}

/// Reopen every window from the previous session. Returns how many were opened.
/// The pending list is consumed, so a second call is a no-op.
pub fn restore_pending(app: &tauri::AppHandle) -> usize {
    use tauri::{Emitter, Manager};

    let state = app.state::<SessionState>();
    let snapshots = state.take_pending();
    let count = snapshots.len();
    // Planned first: only a window that will be built keeps its number free —
    // one whose files are all open elsewhere must not move `main` off #1.
    let plans: Vec<_> = snapshots
        .iter()
        .filter_map(|s| crate::window::plan_restore(app, s).map(|plan| (s, plan)))
        .collect();
    let reserved = reserved_numbers(plans.iter().map(|(s, _)| *s));
    // Every restored window's own number, kept free for it: `main` moves off
    // one, and a window whose number is taken falls back past them.
    crate::window::make_room_for_restore_now(app, &reserved);
    for (snapshot, plan) in plans {
        crate::window::build_restored_window(app, snapshot, plan, &reserved);
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
            ..Default::default()
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
            number: None,
            project: None,
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

    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("couplet-{tag}-{}", new_tab_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Names of the regular files directly in `dir`, sorted; empty when `dir` is missing.
    fn files_in(dir: &std::path::Path) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
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
    fn a_newer_v1_from_a_rolled_back_build_wins() {
        let v2 = serde_json::to_string(&Session {
            saved_at: 5,
            ..session(vec![window(vec![tab("t2", Some("/v2.md"))])])
        })
        .unwrap();
        let v1 = r#"{"version":1,"savedAt":9,"windows":[{"path":"/v1.md","x":0,"y":0,"width":9,"height":9}]}"#;
        let s = choose_session(Some(&v2), Some(v1)).unwrap();
        assert_eq!(s.windows[0].tabs[0].path.as_deref(), Some("/v1.md"));

        let older_v1 = r#"{"version":1,"savedAt":4,"windows":[{"path":"/v1.md","x":0,"y":0,"width":9,"height":9}]}"#;
        let s = choose_session(Some(&v2), Some(older_v1)).unwrap();
        assert_eq!(s.windows[0].tabs[0].path.as_deref(), Some("/v2.md"), "an older v1 still loses");
    }

    #[test]
    fn a_session_with_an_old_spelling_restores_to_the_normalized_one() {
        let mut w = window(vec![tab("a", Some("/nope-s/../nope-a.md")), tab("u", None)]);
        w.project = Some("/nope-s/./proj".to_string());
        let v2 = serde_json::to_string(&session(vec![w])).unwrap();
        let s = with_paths_normalized(choose_session(Some(&v2), None).unwrap(), crate::path_norm::normalize_str);
        assert_eq!(s.windows[0].tabs[0].path.as_deref(), Some("/nope-a.md"));
        assert_eq!(s.windows[0].tabs[1].path, None, "an untitled tab stays untitled");
        assert_eq!(s.windows[0].project.as_deref(), Some("/nope-s/proj"));

        let v1 = r#"{"version":1,"savedAt":0,"windows":[{"path":"/nope-s/./v1.md","x":0,"y":0,"width":9,"height":9}]}"#;
        let s = with_paths_normalized(choose_session(None, Some(v1)).unwrap(), crate::path_norm::normalize_str);
        assert_eq!(s.windows[0].tabs[0].path.as_deref(), Some("/nope-s/v1.md"), "a migrated v1 too");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_slash_tmp_tab_from_an_older_session_restores_as_slash_private_tmp() {
        let s = with_paths_normalized(session(vec![window(vec![tab("a", Some("/tmp/nope-s.md"))])]), crate::path_norm::normalize_str);
        assert_eq!(s.windows[0].tabs[0].path.as_deref(), Some("/private/tmp/nope-s.md"));
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
        assert!(state.snapshot_for("main").is_none(), "no live window holds it");
        assert!(state.referenced_untitled().contains("untitled-main.md"));
    }

    #[test]
    fn a_session_written_before_the_restore_still_names_its_drafts() {
        let state = SessionState::new();
        state.set_pending(vec![window(vec![untitled_tab("plans", "draft-plans.md")])]);
        state.set_tabs("main", vec![tab("blank", None)], Some("blank".to_string()));
        let written = state.snapshot(1);
        assert_eq!(written.windows.len(), 2, "main, then the window nobody restored");
        assert_eq!(written.windows[1].tabs[0].untitled.as_deref(), Some("draft-plans.md"));
    }

    #[test]
    fn upgrade_then_language_restart_before_a_restore_keeps_the_draft() {
        // 2026-09-26: `brew upgrade` 2.0.0 -> 2.0.1. 2.0.1's first run held
        // 2.0.0's session in `pending`; nobody restored it (the welcome window
        // was in front); 18 s later a language switch restarted the app, and
        // the restarted process's first tick deleted the draft.
        let dir = scratch_dir("incident");
        std::fs::write(dir.join("draft-plans.md"), "- [ ] plans").unwrap();

        let first = SessionState::new();
        first.set_pending(vec![window(vec![untitled_tab("plans", "draft-plans.md")])]);
        first.set_tabs("main", vec![tab("blank", None)], Some("blank".to_string()));
        first.set_tabs(
            "editor-1",
            vec![tab("welcome", Some("/tmp/welcome-2.0.1-en.md"))],
            Some("welcome".to_string()),
        );
        prune_untitled_files_in(&dir, &first.referenced_untitled(), 1);
        // What the first tick, the quit and the language restart all write.
        let on_disk = serde_json::to_string(&first.snapshot(1)).unwrap();

        let second = SessionState::new();
        second.set_pending(parse_session(&on_disk).expect("parses").windows);
        second.set_tabs("main", vec![tab("blank-2", None)], Some("blank-2".to_string()));
        prune_untitled_files_in(&dir, &second.referenced_untitled(), 2);

        assert_eq!(std::fs::read_to_string(dir.join("draft-plans.md")).unwrap(), "- [ ] plans");
        assert!(files_in(&dir.join(".trash")).is_empty(), "nothing was thrown away");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_window_the_restore_has_not_reached_yet_is_still_written() {
        let state = SessionState::new();
        state.set_pending(vec![window(vec![untitled_tab("u", "draft-u.md")])]);
        let _taken = state.take_pending();
        let written = state.snapshot(0);
        assert_eq!(written.windows.len(), 1, "a quit mid-restore keeps it");
        assert_eq!(written.windows[0].tabs[0].untitled.as_deref(), Some("draft-u.md"));
    }

    #[test]
    fn a_quit_with_no_live_window_writes_nothing_even_with_drafts_waiting() {
        // The carried window alone must not count as "something to record":
        // the file on disk already names it (see `exit_snapshot`).
        let state = SessionState::new();
        state.set_pending(vec![window(vec![untitled_tab("u", "draft-u.md")])]);
        assert!(state.exit_snapshot(0).is_none());
    }

    #[test]
    fn a_quit_with_live_windows_writes_them_and_the_unrestored_drafts() {
        let state = SessionState::new();
        state.set_pending(vec![window(vec![untitled_tab("u", "draft-u.md")])]);
        state.set_tabs("main", vec![untitled_tab("m", "draft-m.md")], Some("m".to_string()));
        let written = state.exit_snapshot(0).expect("a live window is worth recording");
        let drafts: Vec<Option<&str>> =
            written.windows.iter().map(|w| w.tabs[0].untitled.as_deref()).collect();
        assert_eq!(drafts, vec![Some("draft-m.md"), Some("draft-u.md")], "live first, then carried");
    }

    #[test]
    fn closing_the_last_window_keeps_the_file_that_names_both_drafts() {
        // Review I1: an un-restored draft W1 is carried; the user types in
        // `main` (draft-m); the ticker writes [main, W1]; the red button
        // destroys `main` before the exit path runs. Writing the snapshot
        // then ([W1]) would drop `main` — so the exit writes nothing and the
        // ticker's file stands.
        let state = SessionState::new();
        state.set_pending(vec![window(vec![untitled_tab("u", "draft-u.md")])]);
        state.set_tabs("main", vec![untitled_tab("m", "draft-m.md")], Some("m".to_string()));
        let on_disk = serde_json::to_string(&state.snapshot(1)).unwrap();
        state.remove("main");
        assert!(state.exit_snapshot(2).is_none(), "nothing overwrites the ticker's file");
        let next = parse_session(&on_disk).expect("parses");
        let names: HashSet<&str> = next
            .windows
            .iter()
            .flat_map(|w| w.tabs.iter())
            .filter_map(|t| t.untitled.as_deref())
            .collect();
        assert_eq!(names, HashSet::from(["draft-m.md", "draft-u.md"]));
    }

    #[test]
    fn a_restored_window_is_written_once_as_the_live_window() {
        let state = SessionState::new();
        state.set_pending(vec![window(vec![untitled_tab("u", "draft-u.md")])]);
        let taken = state.take_pending();
        state.seed("editor-1", taken[0].clone());
        assert_eq!(state.snapshot(0).windows.len(), 1, "seeded, not also carried");
        state.finish_restore();
        assert_eq!(state.snapshot(0).windows.len(), 1);
    }

    #[test]
    fn an_unrestored_window_of_files_only_is_not_carried() {
        let state = SessionState::new();
        state.set_pending(vec![window(vec![tab("a", Some("/tmp/a.md"))])]);
        assert!(state.snapshot(0).windows.is_empty(), "its files are on disk");
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
        assert_eq!(untitled_file_name("17-42-3"), "draft-17-42-3.md");
    }

    #[test]
    fn the_gc_knows_both_sidecar_prefixes_and_nothing_else() {
        for name in ["draft-1-2-3.md", "untitled-1-2-3.md", "untitled-main.md"] {
            assert!(is_untitled_sidecar(name), "{name}");
        }
        for name in ["draft-1-2-3.md.tmp", "untitled-main.md.tmp", "session-v2.json", "recent.json", "drafts.md"] {
            assert!(!is_untitled_sidecar(name), "{name}");
        }
    }

    #[test]
    fn a_new_draft_is_not_one_a_pre_tabs_gc_would_delete() {
        // Q3: the old build prunes `untitled-*.md` it does not know.
        assert!(!untitled_file_name("1-2-3").starts_with("untitled-"));
    }

    #[test]
    fn the_prune_keeps_referenced_sidecars_of_both_prefixes() {
        let dir = scratch_dir("prune");
        for name in ["draft-a.md", "draft-b.md", "untitled-c.md", "untitled-d.md", "notes.md"] {
            std::fs::write(dir.join(name), "x").unwrap();
        }
        let referenced: HashSet<String> = ["draft-a.md", "untitled-c.md"].map(String::from).into();
        prune_untitled_files_in(&dir, &referenced, 1_000);
        assert_eq!(files_in(&dir), vec!["draft-a.md", "notes.md", "untitled-c.md"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_prune_moves_unreferenced_drafts_to_the_trash_and_deletes_nothing() {
        let dir = scratch_dir("prune-trash");
        std::fs::write(dir.join("draft-b.md"), "b text").unwrap();
        std::fs::write(dir.join("untitled-editor-1.md"), "legacy text").unwrap();
        prune_untitled_files_in(&dir, &HashSet::new(), 1_000);

        assert!(files_in(&dir).is_empty(), "no sidecar left in session/");
        let trash = dir.join(".trash");
        assert_eq!(
            files_in(&trash),
            vec!["draft-b.trashed-1000.md", "untitled-editor-1.trashed-1000.md"]
        );
        assert_eq!(std::fs::read_to_string(trash.join("draft-b.trashed-1000.md")).unwrap(), "b text");
        assert_eq!(
            std::fs::read_to_string(trash.join("untitled-editor-1.trashed-1000.md")).unwrap(),
            "legacy text"
        );

        // The trash folder itself is never prey for the next pass.
        prune_untitled_files_in(&dir, &HashSet::new(), 2_000);
        assert_eq!(files_in(&trash).len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_same_name_thrown_away_in_the_same_second_gets_its_own_trash_name() {
        let dir = scratch_dir("prune-clash");
        let trash = dir.join(".trash");
        std::fs::create_dir_all(&trash).unwrap();
        std::fs::write(trash.join("draft-b.trashed-1000.md"), "first").unwrap();
        std::fs::write(dir.join("draft-b.md"), "second").unwrap();

        prune_untitled_files_in(&dir, &HashSet::new(), 1_000);

        assert_eq!(files_in(&trash), vec!["draft-b.trashed-1000-1.md", "draft-b.trashed-1000.md"]);
        assert_eq!(std::fs::read_to_string(trash.join("draft-b.trashed-1000.md")).unwrap(), "first");
        assert_eq!(std::fs::read_to_string(trash.join("draft-b.trashed-1000-1.md")).unwrap(), "second");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn linking_into_the_trash_never_replaces_an_occupied_name() {
        // Review M2: a free-name check followed by `rename` could replace a
        // file that appeared in between. The link itself refuses a taken name.
        let dir = scratch_dir("link-occupied");
        let trash = dir.join(".trash");
        std::fs::create_dir_all(&trash).unwrap();
        std::fs::write(trash.join("draft-b.trashed-1000.md"), "first").unwrap();
        std::fs::write(trash.join("draft-b.trashed-1000-1.md"), "second").unwrap();
        let src = dir.join("draft-b.md");
        std::fs::write(&src, "third").unwrap();

        let dest = link_into_trash(&src, &trash, "draft-b", 1000).unwrap();

        assert_eq!(dest, trash.join("draft-b.trashed-1000-2.md"));
        assert_eq!(std::fs::read_to_string(trash.join("draft-b.trashed-1000.md")).unwrap(), "first");
        assert_eq!(std::fs::read_to_string(trash.join("draft-b.trashed-1000-1.md")).unwrap(), "second");
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "third");
        assert_eq!(std::fs::read_to_string(&src).unwrap(), "third", "a link removes nothing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_move_the_trash_refuses_leaves_the_draft_in_place() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch_dir("move-refused");
        let trash = dir.join(".trash");
        std::fs::create_dir_all(&trash).unwrap();
        std::fs::set_permissions(&trash, std::fs::Permissions::from_mode(0o500)).unwrap();
        let src = dir.join("draft-b.md");
        std::fs::write(&src, "keep me").unwrap();

        let moved = move_to_trash(&src, &trash, 1000);

        std::fs::set_permissions(&trash, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(moved.is_err());
        assert_eq!(std::fs::read_to_string(&src).unwrap(), "keep me");
        assert!(files_in(&trash).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_rescue_never_replaces_an_existing_trash_file() {
        let root = scratch_dir("rescue-occupied");
        let trash = root.join(".trash");
        std::fs::create_dir_all(&trash).unwrap();
        std::fs::write(trash.join("closed-1-2-3.trashed-500.md"), "earlier").unwrap();

        let path = rescue_untitled_in(&trash, "1-2-3", "later", 500).unwrap();

        assert_eq!(path, trash.join("closed-1-2-3.trashed-500-1.md"));
        assert_eq!(std::fs::read_to_string(trash.join("closed-1-2-3.trashed-500.md")).unwrap(), "earlier");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "later");
        assert_eq!(files_in(&trash).len(), 2, "no temp file left");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_symlinked_trash_is_never_purged() {
        let root = scratch_dir("purge-symlinked");
        let elsewhere = root.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("draft-old.trashed-1.md"), "not ours").unwrap();
        let trash = root.join(".trash");
        std::os::unix::fs::symlink(&elsewhere, &trash).unwrap();

        purge_trash_in(&trash, u64::MAX);

        assert_eq!(files_in(&elsewhere), vec!["draft-old.trashed-1.md"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_symlink_inside_the_trash_survives_the_purge() {
        // `DirEntry::file_type` does not follow symlinks: an old-stamped link
        // is not a regular file, so neither it nor its target is touched.
        let root = scratch_dir("purge-file-link");
        let target = root.join("target.md");
        std::fs::write(&target, "outside").unwrap();
        let trash = root.join(".trash");
        std::fs::create_dir_all(&trash).unwrap();
        let link = trash.join("old-link.trashed-1.md");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        purge_trash_in(&trash, u64::MAX);

        assert!(std::fs::symlink_metadata(&link).is_ok(), "the link is still there");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "outside");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_symlinked_trash_is_never_written() {
        let root = scratch_dir("move-symlinked");
        let elsewhere = root.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let trash = root.join(".trash");
        std::os::unix::fs::symlink(&elsewhere, &trash).unwrap();
        let src = root.join("draft-b.md");
        std::fs::write(&src, "keep me").unwrap();

        assert!(move_to_trash(&src, &trash, 1000).is_err());
        assert!(rescue_untitled_in(&trash, "1-2-3", "text", 1000).is_err());

        assert_eq!(std::fs::read_to_string(&src).unwrap(), "keep me");
        assert!(files_in(&elsewhere).is_empty(), "nothing lands through the link");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn trashed_at_reads_the_stamp_back_and_refuses_foreign_names() {
        assert_eq!(trashed_at("draft-b.trashed-1000.md"), Some(1000));
        assert_eq!(trashed_at("draft-b.trashed-1000-3.md"), Some(1000));
        assert_eq!(trashed_at("closed-1-2-3.trashed-77.md"), Some(77));
        for foreign in [
            "notes.md",
            "draft-b.md",
            "draft-b.trashed-.md",
            "draft-b.trashed-12x.md",
            ".closed-1-2-3.tmp",
            "x.trashed-5-foo.md",
            "x.trashed-5-.md",
            "x.trashed-5-1-2.md",
            "x.trashed--5.md",
        ] {
            assert_eq!(trashed_at(foreign), None, "{foreign}");
        }
    }

    #[test]
    fn the_purge_removes_only_trash_older_than_thirty_days() {
        let trash = scratch_dir("purge");
        let now = 100 * DRAFTS_TRASH_KEEP_SECS;
        let old = format!("draft-old.trashed-{}.md", now - DRAFTS_TRASH_KEEP_SECS - 1);
        let edge = format!("draft-edge.trashed-{}.md", now - DRAFTS_TRASH_KEEP_SECS);
        let fresh = format!("closed-1-2-3.trashed-{}.md", now - 10);
        for name in [old.as_str(), edge.as_str(), fresh.as_str(), "notes.md", ".closed-9.tmp"] {
            std::fs::write(trash.join(name), "x").unwrap();
        }
        std::fs::create_dir_all(trash.join("sub.trashed-1.md")).unwrap();

        purge_trash_in(&trash, now);

        let mut expected = vec![".closed-9.tmp".to_string(), fresh, edge, "notes.md".to_string()];
        expected.sort();
        assert_eq!(files_in(&trash), expected, "only the file past 30 days goes");
        assert!(trash.join("sub.trashed-1.md").is_dir(), "a directory is never removed");
        let _ = std::fs::remove_dir_all(&trash);
    }

    #[test]
    fn purging_a_trash_that_does_not_exist_is_a_noop() {
        let missing = std::env::temp_dir().join(format!("couplet-no-trash-{}", new_tab_id()));
        purge_trash_in(&missing, u64::MAX);
        assert!(!missing.exists());
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
        // A pre-Q3 tab-id name is not renamed to `draft-` either.
        state.seed("editor-8", window(vec![untitled_tab("1-2-3", "untitled-1-2-3.md")]));
        assert_eq!(state.untitled_file_for("editor-8", "1-2-3"), "untitled-1-2-3.md");
    }

    #[test]
    fn untitled_file_for_a_fresh_tab_is_named_by_its_id() {
        let state = SessionState::new();
        assert_eq!(state.untitled_file_for("main", "9-9-9"), "draft-9-9-9.md");
    }

    #[test]
    fn tab_snapshots_write_each_untitled_tab_under_its_own_name() {
        let state = SessionState::new();
        state.seed("main", window(vec![untitled_tab("old", "untitled-main.md")]));
        let written = RefCell::new(Vec::<(String, String)>::new());
        let reports = vec![
            TabReport { tab_id: "old".into(), path: None, cursor: 1, top_line: 0, content: Some("kept".into()), ..Default::default() },
            TabReport { tab_id: "new".into(), path: None, cursor: 0, top_line: 1, content: Some("fresh".into()), ..Default::default() },
            TabReport { tab_id: "blank".into(), path: None, cursor: 0, top_line: 1, content: Some(String::new()), ..Default::default() },
            TabReport { tab_id: "file".into(), path: Some("/tmp/a.md".into()), cursor: 9, top_line: 4, content: None, ..Default::default() },
        ];
        let ids: Vec<String> = ["old", "new", "blank", "file"].map(String::from).to_vec();
        record_heartbeat(&state, "main", reports, Some("old".to_string()), &ids, &HashSet::new(), |name, text| {
            written.borrow_mut().push((name.to_string(), text.to_string()));
            Ok(())
        })
        .unwrap();

        assert_eq!(
            written.into_inner(),
            vec![
                ("untitled-main.md".to_string(), "kept".to_string()),
                ("draft-new.md".to_string(), "fresh".to_string()),
            ]
        );
        let snaps = state.snapshot_for("main").unwrap().tabs;
        let names: Vec<Option<&str>> = snaps.iter().map(|s| s.untitled.as_deref()).collect();
        assert_eq!(names, vec![Some("untitled-main.md"), Some("draft-new.md"), None, None]);
        assert_eq!(snaps[0].top_line, 1, "a reported 0 is normalized");
        assert_eq!((snaps[3].cursor, snaps[3].top_line), (9, 4));
    }

    #[test]
    fn a_heartbeat_fails_when_a_sidecar_cannot_be_written() {
        let state = SessionState::new();
        let reports = vec![TabReport { tab_id: "u".into(), path: None, cursor: 0, top_line: 1, content: Some("text".into()), ..Default::default() }];
        assert!(record_heartbeat(&state, "main", reports, None, &[], &HashSet::new(), |_, _| Err("disk full".into())).is_err());
    }

    #[test]
    fn a_sidecar_is_referenced_before_it_is_written() {
        // The ticker prunes whatever `referenced_untitled` does not name; a
        // first sidecar written before its name is recorded can be deleted
        // before the name lands.
        let state = SessionState::new();
        let reports = vec![TabReport { tab_id: "u".into(), path: None, cursor: 0, top_line: 1, content: Some("text".into()), ..Default::default() }];
        let checked = RefCell::new(false);
        record_heartbeat(&state, "main", reports, Some("u".to_string()), &["u".to_string()], &HashSet::new(), |name, _| {
            assert!(state.referenced_untitled().contains(name), "{name} written before it was referenced");
            *checked.borrow_mut() = true;
            Ok(())
        })
        .unwrap();
        assert!(checked.into_inner());
    }

    #[test]
    fn a_report_without_a_background_untitled_tab_does_not_release_its_sidecar() {
        let state = SessionState::new();
        state.seed(
            "main",
            window(vec![tab("a", Some("/tmp/a.md")), untitled_tab("u", "untitled-u.md")]),
        );
        let reports = vec![TabReport { tab_id: "a".into(), path: Some("/tmp/a.md".into()), cursor: 7, top_line: 2, content: None, ..Default::default() }];
        let ids = ["a", "u"].map(String::from).to_vec();
        record_heartbeat(&state, "main", reports, Some("a".to_string()), &ids, &HashSet::new(), |_, _| Ok(())).unwrap();

        assert!(state.referenced_untitled().contains("untitled-u.md"));
        let tabs = state.snapshot_for("main").unwrap().tabs;
        let order: Vec<&str> = tabs.iter().map(|t| t.tab_id.as_str()).collect();
        assert_eq!(order, vec!["a", "u"]);
        assert_eq!(tabs[0].cursor, 7, "the reported tab is updated");
    }

    #[test]
    fn a_tab_the_registry_no_longer_holds_is_dropped_from_the_session() {
        let state = SessionState::new();
        state.seed("main", window(vec![tab("a", Some("/tmp/a.md")), untitled_tab("u", "untitled-u.md")]));
        let reports = vec![TabReport { tab_id: "a".into(), path: Some("/tmp/a.md".into()), cursor: 0, top_line: 1, content: None, ..Default::default() }];
        record_heartbeat(&state, "main", reports, Some("a".to_string()), &["a".to_string()], &HashSet::new(), |_, _| Ok(())).unwrap();
        assert!(!state.referenced_untitled().contains("untitled-u.md"));
        assert_eq!(state.snapshot_for("main").unwrap().tabs.len(), 1);
    }

    #[test]
    fn a_heartbeat_that_arrives_after_tab_close_does_not_bring_the_tab_back() {
        let state = SessionState::new();
        state.seed("main", window(vec![tab("a", Some("/tmp/a.md")), untitled_tab("u", "untitled-u.md")]));
        let mut reg = crate::tabs::TabRegistry::new();
        reg.add_tab("main", "a", Some("/tmp/a.md".to_string()));
        reg.add_tab("main", "u", None);
        // Sent before ⌘W on `u`, processed after `tab_close`.
        let stale = vec![
            TabReport { tab_id: "a".into(), path: Some("/tmp/a.md".into()), cursor: 0, top_line: 1, content: None, ..Default::default() },
            TabReport { tab_id: "u".into(), path: None, cursor: 0, top_line: 1, content: Some("draft".into()), ..Default::default() },
        ];
        reg.remove_tab("main", "u");
        state.remove_tab("main", "u");

        let reported: Vec<(String, Option<String>)> =
            stale.iter().map(|t| (t.tab_id.clone(), t.path.clone())).collect();
        reg.sync("main", &reported, Some("u"));
        let w = reg.window("main").unwrap();
        let ids: Vec<String> = w.tabs.iter().map(|t| t.id.clone()).collect();
        record_heartbeat(&state, "main", stale, Some("u".to_string()), &ids, &w.closed_ids, |name, _| {
            panic!("{name} rewritten for a closed tab")
        })
        .unwrap();

        let snap = state.snapshot_for("main").unwrap();
        assert_eq!(snap.tabs.iter().map(|t| t.tab_id.as_str()).collect::<Vec<_>>(), vec!["a"]);
        assert_ne!(snap.active_tab.as_deref(), Some("u"));
        assert!(!state.referenced_untitled().contains("untitled-u.md"), "the discarded draft is prunable");
    }

    #[test]
    fn only_ids_new_tab_id_could_make_pass() {
        assert!(is_valid_tab_id(&new_tab_id()));
        assert!(is_valid_tab_id("1-2-3"));
        for bad in ["", "../x", "a/b", "u", "1.2", "1 2", "..", "1-2-3\0"] {
            assert!(!is_valid_tab_id(bad), "{bad:?} accepted");
        }
        let report = |id: &str| TabReport { tab_id: id.into(), path: None, cursor: 0, top_line: 1, content: None, ..Default::default() };
        assert!(check_tab_ids(&[report("1-2"), report("3-4")]).is_ok());
        assert!(check_tab_ids(&[report("1-2"), report("../../evil")]).is_err());
    }

    #[test]
    fn from_closed_entry_carries_geometry_position_and_number_with_a_fresh_tab_id() {
        let entry = crate::closed::ClosedEntry {
            path: "/tmp/a.md".to_string(),
            cursor: 42,
            top_line: 9,
            label: "editor-3".to_string(),
            number: Some(7),
            x: 11,
            y: 22,
            width: 800,
            height: 600,
        };
        let a = WindowSnapshot::from_closed_entry(entry.clone());
        assert_eq!((a.x, a.y, a.width, a.height), (11, 22, 800, 600));
        assert_eq!(a.number, Some(7));
        assert_eq!(a.tabs.len(), 1);
        assert_eq!(a.tabs[0].path.as_deref(), Some("/tmp/a.md"));
        assert_eq!((a.tabs[0].cursor, a.tabs[0].top_line), (42, 9));
        assert_eq!(a.active_tab.as_deref(), Some(a.tabs[0].tab_id.as_str()));
        let b = WindowSnapshot::from_closed_entry(entry);
        assert_ne!(a.tabs[0].tab_id, b.tabs[0].tab_id, "every reopened tab is a new tab");
    }

    #[test]
    fn remove_tab_drops_one_tab_and_moves_active() {
        let state = SessionState::new();
        state.set_tabs("main", vec![tab("a", Some("/a.md")), tab("b", Some("/b.md"))], Some("a".to_string()));
        state.remove_tab("main", "a");
        let w = state.snapshot_for("main").unwrap();
        assert_eq!(w.tabs.iter().map(|t| t.tab_id.as_str()).collect::<Vec<_>>(), vec!["b"]);
        assert_eq!(w.active_tab.as_deref(), Some("b"));
    }

    #[test]
    fn remove_tab_changes_nothing_while_quitting() {
        let state = SessionState::new();
        state.set_tabs("main", vec![tab("a", Some("/a.md"))], Some("a".to_string()));
        state.mark_quitting();
        state.remove_tab("main", "a");
        assert_eq!(state.snapshot_for("main").unwrap().tabs.len(), 1, "a quit keeps every tab");
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
        let reports = vec![TabReport { tab_id: "u".into(), path: None, cursor: 0, top_line: 1, content: Some(String::new()), ..Default::default() }];
        record_heartbeat(&state, "main", reports, Some("u".to_string()), &["u".to_string()], &HashSet::new(), |_, _| {
            panic!("no sidecar for an empty buffer")
        })
        .unwrap();
        assert!(!state.referenced_untitled().contains("untitled-u.md"));
        assert!(prune_missing(state.snapshot(0), |_| true).windows.is_empty(), "a blank tab never comes back");
    }

    #[test]
    fn the_window_number_survives_a_json_roundtrip_and_v1_has_none() {
        let mut w = window(vec![tab("t", Some("/tmp/a.md"))]);
        w.number = Some(7);
        let json = serde_json::to_string(&session(vec![w])).unwrap();
        assert!(json.contains("\"number\":7"), "got {json}");
        assert_eq!(parse_session(&json).unwrap().windows[0].number, Some(7));

        let v1 = r#"{"version":1,"savedAt":0,"windows":[{"path":"/a.md","x":0,"y":0,"width":9,"height":9}]}"#;
        assert_eq!(parse_session(v1).unwrap().windows[0].number, None);
    }

    #[test]
    fn only_valid_numbers_are_reserved() {
        let mut a = WindowSnapshot::empty();
        a.number = Some(1);
        let mut b = WindowSnapshot::empty();
        b.number = Some(0);
        let c = WindowSnapshot::empty();
        let mut d = WindowSnapshot::empty();
        d.number = Some(100);
        let reserved = reserved_numbers([&a, &b, &c, &d].into_iter());
        assert_eq!(reserved, [1].into_iter().collect());
    }

    #[test]
    fn a_heartbeat_keeps_the_window_number() {
        let state = SessionState::new();
        state.set_number("editor-2", Some(7));
        let reports = vec![TabReport { tab_id: "a".into(), path: Some("/tmp/a.md".into()), cursor: 0, top_line: 1, content: None, ..Default::default() }];
        record_heartbeat(&state, "editor-2", reports, Some("a".to_string()), &["a".to_string()], &HashSet::new(), |_, _| Ok(())).unwrap();
        assert_eq!(state.snapshot_for("editor-2").unwrap().number, Some(7));
    }

    #[test]
    fn this_build_writes_only_the_v2_file() {
        assert_eq!(SESSION_FILE, "session-v2.json");
        assert_ne!(SESSION_FILE, LEGACY_SESSION_FILE);
    }

    #[test]
    fn drawer_stamps_ride_the_heartbeat_into_the_snapshot() {
        let state = SessionState::new();
        let reports = vec![TabReport {
            tab_id: "a".into(),
            path: Some("/tmp/a.md".into()),
            cursor: 0,
            top_line: 1,
            content: None,
            opened_at: 1_700_000_000_123,
            viewed_at: 1_700_000_000_456,
            edited_at: 1_700_000_000_789,
            unviewed: true,
            ..Default::default()
        }];
        let (snapshots, _) = tab_snapshots(&state, "main", reports);
        assert_eq!(snapshots[0].opened_at, 1_700_000_000_123);
        assert_eq!(snapshots[0].viewed_at, 1_700_000_000_456);
        assert_eq!(snapshots[0].edited_at, 1_700_000_000_789);
        assert!(snapshots[0].unviewed);
    }

    #[test]
    fn a_quick_look_rides_the_heartbeat_into_the_snapshot() {
        let state = SessionState::new();
        let report: TabReport = serde_json::from_str(
            r#"{"tabId":"a","path":"/tmp/a.md","cursor":0,"topLine":1,"content":null,
                "transient":true,"transientSeenAt":1700000000789}"#,
        )
        .unwrap();
        let (snapshots, _) = tab_snapshots(&state, "main", vec![report]);
        assert!(snapshots[0].transient);
        assert_eq!(snapshots[0].transient_seen_at, 1_700_000_000_789);
    }

    #[test]
    fn a_heartbeat_without_stamps_is_still_accepted() {
        let report: TabReport =
            serde_json::from_str(r#"{"tabId":"1","path":null,"cursor":0,"topLine":1,"content":null}"#).unwrap();
        assert_eq!((report.opened_at, report.viewed_at, report.unviewed), (0, 0, false));
        assert_eq!(report.edited_at, 0);
        assert_eq!((report.transient, report.transient_seen_at), (false, 0));
    }

    #[test]
    fn a_session_written_before_the_drawer_parses_with_empty_stamps() {
        let json = r#"{"version":2,"savedAt":1,"windows":[{"x":0,"y":0,"width":900,"height":700,
            "tabs":[{"tabId":"1-2-3","path":"/tmp/a.md","cursor":0,"topLine":1}],"activeTab":"1-2-3"}]}"#;
        let s = parse_session(json).expect("parses");
        let t = &s.windows[0].tabs[0];
        assert_eq!((t.opened_at, t.viewed_at, t.unviewed), (0, 0, false));
        assert_eq!(t.edited_at, 0, "a session from before the card's time: never edited");
        assert_eq!((t.transient, t.transient_seen_at), (false, 0), "a session from before Q8: ordinary tabs");
    }

    #[test]
    fn drawer_stamps_round_trip_through_the_session_file() {
        let mut t = tab("t1", Some("/tmp/a.md"));
        t.opened_at = 5;
        t.viewed_at = 7;
        t.edited_at = 9;
        t.unviewed = true;
        let json = serde_json::to_string(&session(vec![window(vec![t.clone()])])).unwrap();
        for key in [r#""openedAt":5"#, r#""viewedAt":7"#, r#""editedAt":9"#, r#""unviewed":true"#] {
            assert!(json.contains(key), "{key} missing in {json}");
        }
        assert_eq!(parse_session(&json).unwrap().windows[0].tabs[0], t);
    }

    #[test]
    fn a_quick_look_round_trips_through_the_session_file_without_a_version_bump() {
        let mut t = tab("t1", Some("/tmp/a.md"));
        t.transient = true;
        t.transient_seen_at = 9;
        let json = serde_json::to_string(&session(vec![window(vec![t.clone()])])).unwrap();
        for key in [r#""transient":true"#, r#""transientSeenAt":9"#, r#""version":2"#] {
            assert!(json.contains(key), "{key} missing in {json}");
        }
        assert_eq!(parse_session(&json).unwrap().windows[0].tabs[0], t);
    }

    #[test]
    fn a_window_project_round_trips_through_the_session_file() {
        let mut w = window(vec![tab("t1", Some("/p/a.md"))]);
        w.project = Some("/p".to_string());
        let json = serde_json::to_string(&session(vec![w])).unwrap();
        assert!(json.contains(r#""project":"/p""#), "{json}");
        assert_eq!(parse_session(&json).unwrap().windows[0].project.as_deref(), Some("/p"));
    }

    #[test]
    fn a_session_written_before_projects_parses_without_one() {
        let json = r#"{"version":2,"savedAt":1,"windows":[{"x":0,"y":0,"width":900,"height":700,
            "tabs":[{"tabId":"1-2-3","path":"/tmp/a.md","cursor":0,"topLine":1}],"activeTab":"1-2-3"}]}"#;
        assert_eq!(parse_session(json).unwrap().windows[0].project, None);
    }

    #[test]
    fn set_project_records_the_windows_binding() {
        let state = SessionState::new();
        state.set_project("main", Some("/p".to_string()));
        assert_eq!(state.snapshot_for("main").unwrap().project.as_deref(), Some("/p"));
    }

    fn moved_snap(id: &str, path: Option<&str>) -> TabSnapshot {
        TabSnapshot { tab_id: id.to_string(), path: path.map(str::to_string), top_line: 1, ..Default::default() }
    }

    #[test]
    fn a_moved_tab_takes_its_snapshot_and_sidecar_name_to_the_target() {
        let state = SessionState::new();
        state.set_tabs(
            "main",
            vec![
                moved_snap("a", Some("/a.md")),
                TabSnapshot { untitled: Some("untitled-main.md".into()), ..moved_snap("u", None) },
            ],
            Some("u".into()),
        );
        state.set_tabs("editor-2", vec![moved_snap("x", None)], Some("x".into()));
        state.move_tab("main", "editor-2", TabSnapshot { cursor: 4, opened_at: 7, ..moved_snap("u", None) });

        let main = state.snapshot_for("main").unwrap();
        assert_eq!(main.tabs.iter().map(|t| t.tab_id.as_str()).collect::<Vec<_>>(), vec!["a"]);
        assert_eq!(main.active_tab.as_deref(), Some("a"));
        let target = state.snapshot_for("editor-2").unwrap();
        let u = target.tabs.iter().find(|t| t.tab_id == "u").unwrap();
        assert_eq!(u.untitled.as_deref(), Some("untitled-main.md"), "a migrated draft keeps writing to its file");
        assert_eq!((u.cursor, u.opened_at), (4, 7));
        assert_eq!(state.untitled_file_for("editor-2", "u"), "untitled-main.md");
    }

    #[test]
    fn a_moved_draft_stays_referenced_so_the_prune_keeps_it() {
        let state = SessionState::new();
        state.set_tabs(
            "main",
            vec![TabSnapshot { untitled: Some("untitled-1-2-3.md".into()), ..moved_snap("1-2-3", None) }],
            None,
        );
        state.move_tab("main", "editor-4", moved_snap("1-2-3", None));
        assert!(state.referenced_untitled().contains("untitled-1-2-3.md"));
    }

    #[test]
    fn a_tab_the_source_never_recorded_still_lands_in_the_target() {
        let state = SessionState::new();
        state.move_tab("main", "editor-2", moved_snap("n", Some("/n.md")));
        assert_eq!(state.snapshot_for("editor-2").unwrap().tabs, vec![moved_snap("n", Some("/n.md"))]);
    }

    #[test]
    fn move_tab_changes_nothing_while_quitting() {
        let state = SessionState::new();
        state.set_tabs("main", vec![moved_snap("a", None)], None);
        state.mark_quitting();
        state.move_tab("main", "editor-2", moved_snap("a", None));
        assert_eq!(state.snapshot_for("main").unwrap().tabs.len(), 1);
        assert!(state.snapshot_for("editor-2").is_none());
    }

    #[test]
    fn a_rescue_copy_lands_in_the_trash_with_the_text() {
        let root = scratch_dir("rescue");
        let trash = root.join(".trash");
        let path = rescue_untitled_in(&trash, "1-2-3", "- [ ] plan", 500).unwrap();
        assert_eq!(path, trash.join("closed-1-2-3.trashed-500.md"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "- [ ] plan");
        assert_eq!(files_in(&trash), vec!["closed-1-2-3.trashed-500.md"], "no temp file left");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_rescue_refuses_a_tab_id_that_could_name_another_file() {
        let root = scratch_dir("rescue-bad-id");
        let trash = root.join(".trash");
        assert!(rescue_untitled_in(&trash, "../x", "text", 1).is_err());
        assert!(files_in(&trash).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
