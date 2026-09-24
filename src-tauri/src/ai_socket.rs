//! Command socket for driving the running app from the CLI (`mdmini show`/`edit`).
//!
//! A small JSON-lines protocol over a Unix domain socket: one request per line,
//! one response per line, connection stays usable across malformed lines. See
//! `docs/superpowers/specs/2026-08-22-ai-interface-design.md`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::window;

/// A parsed command socket request. `v` (protocol version) is accepted but not
/// yet branched on — kept for the future MCP wrapper mentioned in the spec.
#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(tag = "cmd", rename_all = "lowercase")]
pub enum AiRequest {
    Show {
        #[allow(dead_code)] // protocol version, reserved for the future MCP wrapper
        v: u32,
        path: String,
        #[serde(default)]
        line: Option<usize>,
        #[serde(default)]
        find: Option<String>,
        /// `#N` of the window to open it in (spec §5 step 1). Absent: routed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window_binding: Option<u32>,
        /// Make the tab active and bring its window forward. Absent: `true` —
        /// what every `show` did before tabs (spec §5).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        focus: Option<bool>,
        /// A quick look (spec §7): the tab asks «Close / Keep» by itself.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        transient: bool,
    },
    Edit {
        #[allow(dead_code)] // protocol version, reserved for the future MCP wrapper
        v: u32,
        path: String,
        content: String,
        #[serde(default)]
        show: bool,
        /// `#N` of the window to open it in (spec §5 step 1). Absent: routed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window_binding: Option<u32>,
    },
    Ask {
        #[allow(dead_code)] // protocol version, reserved for the future MCP wrapper
        v: u32,
        path: String,
        question: String,
        options: Vec<String>,
        #[serde(default)]
        line: Option<usize>,
        #[serde(default)]
        find: Option<String>,
        #[serde(default = "default_ask_timeout")]
        timeout_secs: u64,
        /// Checkbox mode: the user may select any number of options (including
        /// zero) and confirms instead of picking exactly one. `false` keeps
        /// today's single-choice behavior for callers who omit the field.
        #[serde(default)]
        multi: bool,
        /// Adds a free-text field alongside the option buttons/checkboxes; the
        /// user may type a custom answer instead of (single mode) or in
        /// addition to (multi mode) picking options. `false` keeps today's
        /// options-only behavior for callers who omit the field.
        #[serde(default)]
        free_text: bool,
        /// `#N` of the window to open it in (spec §5 step 1). Absent: routed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window_binding: Option<u32>,
    },
    /// Open a file as a tab — `mdmini <file>` from an agent, or with
    /// `-t`/`-b`/`-f` (spec §4). Routed like `show`.
    Open {
        #[allow(dead_code)] // protocol version, reserved for the future MCP wrapper
        v: u32,
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window_binding: Option<u32>,
        /// The CLI decides it (a human's `-t` focuses, an agent's open does not).
        #[serde(default)]
        focus: bool,
    },
    /// Close the tab holding `path` — the ⌘W way (spec §8).
    Close {
        #[allow(dead_code)] // protocol version, reserved for the future MCP wrapper
        v: u32,
        path: String,
    },
    /// The window listing — `mdmini ls`, MCP `windows`.
    Windows {
        #[allow(dead_code)] // protocol version, reserved for the future MCP wrapper
        v: u32,
    },
}

impl AiRequest {
    fn path(&self) -> &str {
        match self {
            AiRequest::Show { path, .. }
            | AiRequest::Edit { path, .. }
            | AiRequest::Ask { path, .. }
            | AiRequest::Open { path, .. }
            | AiRequest::Close { path, .. } => path,
            AiRequest::Windows { .. } => "",
        }
    }

    /// The path to normalize at the socket's door; `None` for `windows`.
    fn path_mut(&mut self) -> Option<&mut String> {
        match self {
            AiRequest::Show { path, .. }
            | AiRequest::Edit { path, .. }
            | AiRequest::Ask { path, .. }
            | AiRequest::Open { path, .. }
            | AiRequest::Close { path, .. } => Some(path),
            AiRequest::Windows { .. } => None,
        }
    }

    /// Whether the command may take the view. `show` does by default, `open`
    /// when the CLI says so; `edit`, `ask` and `close` never switch tabs.
    fn focus(&self) -> bool {
        match self {
            AiRequest::Show { focus, .. } => focus.unwrap_or(true),
            AiRequest::Open { focus, .. } => *focus,
            AiRequest::Edit { .. } | AiRequest::Ask { .. } | AiRequest::Close { .. } | AiRequest::Windows { .. } => false,
        }
    }

    fn transient(&self) -> bool {
        matches!(self, AiRequest::Show { transient: true, .. })
    }

    fn window_binding(&self) -> Option<u32> {
        match self {
            AiRequest::Show { window_binding, .. }
            | AiRequest::Edit { window_binding, .. }
            | AiRequest::Ask { window_binding, .. }
            | AiRequest::Open { window_binding, .. } => *window_binding,
            AiRequest::Close { .. } | AiRequest::Windows { .. } => None,
        }
    }
}

/// Default `ask` timeout when the request omits `timeout_secs` — five minutes
/// is generous for a human to notice a question and click, without leaving a
/// caller's terminal hung indefinitely if nobody's looking.
pub(crate) fn default_ask_timeout() -> u64 {
    300
}

/// Lower/upper bound accepted for an `ask` timeout. Below 10s a human
/// realistically can't read and answer; above an hour it's almost certainly a
/// mistake (or the caller meant "no timeout", which this protocol doesn't
/// offer) — clamp rather than reject either way, since the caller's intent
/// ("wait a long time" / "wait a short time") is still honored, just bounded.
const ASK_TIMEOUT_MIN_SECS: u64 = 10;
const ASK_TIMEOUT_MAX_SECS: u64 = 3600;

/// Clamp a requested `ask` timeout into the accepted bound. Pure and shared
/// by both the socket-side dispatch (server wait) and the CLI client (its own
/// read timeout must match what the server will actually wait).
pub(crate) fn clamp_ask_timeout(secs: u64) -> u64 {
    secs.clamp(ASK_TIMEOUT_MIN_SECS, ASK_TIMEOUT_MAX_SECS)
}

/// Validate an `ask` request's user-facing fields before touching any window:
/// a non-empty question and 2..=6 non-empty options. Kept separate from
/// dispatch so it can be unit-tested without a running app.
fn validate_ask(question: &str, options: &[String]) -> Result<(), String> {
    if question.trim().is_empty() {
        return Err("question must not be empty".to_string());
    }
    if !(2..=6).contains(&options.len()) {
        return Err("options must have between 2 and 6 entries".to_string());
    }
    if options.iter().any(|o| o.trim().is_empty()) {
        return Err("options must not be empty".to_string());
    }
    Ok(())
}

/// Response written back on the same connection, one JSON object per line.
///
/// `Default` matters beyond convenience: this struct has grown fields twice
/// already (`answers`/`custom` for multi-choice/free-text `ask`, now
/// `threads` for `question`), and every field but `ok` is `Option`. A
/// default-constructed response — `ok: false`, everything else absent — is
/// the semantically right "nothing happened yet" value, and it lets test
/// call sites build one with `..Default::default()` instead of naming every
/// field, so the next field added here doesn't touch them at all.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct AiResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_lines: Option<Vec<[usize; 2]>>,
    /// The option text the user clicked, for single-choice `ask`. `None` for
    /// `show`/`edit` responses, for multi-choice `ask` (see `answers`), and for
    /// any `ask` failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    /// The option texts the user checked, for multi-choice (`multi: true`)
    /// `ask` only. `Some(vec![])` is a valid explicit "confirmed none
    /// selected" — distinct from `None`, which means this wasn't a
    /// multi-choice response at all (single-choice `ask`, `show`, `edit`, or
    /// any failure).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answers: Option<Vec<String>>,
    /// The user's typed answer, for free-text (`free_text: true`) `ask` only.
    /// `None` when free-text wasn't offered, or the user didn't type
    /// anything, or for any non-`ask` response or `ask` failure. Coexists
    /// with `answer` (single mode: the frontend sends `custom` instead of
    /// `answer` when the user typed rather than clicked) and with `answers`
    /// (multi mode: both may be present together).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom: Option<String>,
    /// Открытые треды комментариев, для `question` только. `None` для любого
    /// другого ответа. Живёт в общем `AiResponse`, а не в отдельном типе, чтобы
    /// CLI и MCP печатали одну и ту же форму и MCP переиспользовал
    /// `tool_result_response`, как это уже сделано для `answer`/`answers`/`custom`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threads: Option<Vec<crate::comments::Located>>,
    /// The `#N` of the window that handled the request (spec §5): an agent
    /// passes it back as `window_binding`. Filled in by `ai_respond`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<u32>,
    /// The tab is its window's active tab after the command. `false`: it
    /// landed in the background (the tab shimmers until it is seen).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focused: Option<bool>,
    /// The window listing — `windows` / `mdmini ls --json` only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub windows: Option<Vec<WindowListing>>,
    /// Every tab a multi-file `mdmini <files>` opened — that CLI call only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opened: Option<Vec<OpenedTab>>,
}

impl AiResponse {
    // Counterpart to `error()` below — not called from non-test Rust yet: the
    // "ok" response for `edit`/`show` is built by the frontend and only
    // deserialized here via `ai_respond`. Kept public for symmetry and for the
    // CLI client (Task 5) to construct local responses with.
    #[allow(dead_code)]
    pub fn ok() -> Self {
        Self { ok: true, ..Default::default() }
    }

    pub fn error(msg: impl Into<String>) -> Self {
        Self { ok: false, error: Some(msg.into()), ..Default::default() }
    }
}

/// One tab in the window listing.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ListedTab {
    /// `None`: an untitled tab.
    pub path: Option<String>,
    pub active: bool,
}

/// One window as `mdmini ls --json` and MCP `windows` report it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WindowListing {
    /// `#N`; `None` only when all 99 numbers were taken.
    pub window: Option<u32>,
    /// The project's directory name; `None` for a window that never held a file.
    pub project: Option<String>,
    /// The project's root, absolute — what routing compares.
    pub project_path: Option<String>,
    /// The window the human was in last.
    pub last_focused: bool,
    pub tabs: Vec<ListedTab>,
}

/// One tab a routed `mdmini <files>` opened.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct OpenedTab {
    pub path: String,
    pub window: Option<u32>,
    pub focused: bool,
}

/// Command socket path for a product name: release `/tmp/md_mini_cmd.sock`, dev
/// build `/tmp/md_mini_dev_cmd.sock`. Mirrors the dev/release isolation rule in
/// `paths::dir_name`, applied to a flat filename since the socket lives in
/// `/tmp`, not the app data directory.
pub fn socket_path(product_name: &str) -> PathBuf {
    let sanitized: String = product_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    PathBuf::from(format!("/tmp/{}_cmd.sock", sanitized))
}

/// Parse one line of the JSON-lines protocol into a request.
pub fn parse_request(line: &str) -> Result<AiRequest, String> {
    serde_json::from_str(line).map_err(|e| e.to_string())
}

/// Remove the command socket file on the way out. Called from both quit paths
/// in `lib.rs` — same dual-path rule as `save_session_on_exit`, since Cmd+Q and
/// `app.exit()` fire different `RunEvent`s and neither is a superset of the other.
pub fn remove_socket(app: &AppHandle) {
    let product_name = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "md-mini".to_string());
    let _ = std::fs::remove_file(socket_path(&product_name));
}

/// Start the command socket listener on a background thread.
///
/// Binds at the product-derived path, removing a stale socket left behind by a
/// prior run that didn't exit cleanly (mirrors the single-instance socket
/// gotcha — a `kill -9` leaves the file on disk), and restricts permissions to
/// the owner.
pub fn start(app: &AppHandle) {
    let product_name = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "md-mini".to_string());
    let path = socket_path(&product_name);

    let _ = std::fs::remove_file(&path);

    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Failed to bind command socket at {:?}: {}", path, e);
            return;
        }
    };

    if let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)) {
        eprintln!("Failed to set command socket permissions: {}", e);
    }

    let app_handle = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let handle = app_handle.clone();
                    std::thread::spawn(move || handle_connection(&handle, stream));
                }
                Err(e) => eprintln!("Command socket accept error: {}", e),
            }
        }
    });
}

/// Serve one connection: read requests line by line, dispatch each, write back
/// one response line. A malformed line gets an error response and the
/// connection stays open for the next one.
fn handle_connection(app: &AppHandle, stream: UnixStream) {
    let mut writer = match stream.try_clone() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("Failed to clone command socket stream: {}", e);
            return;
        }
    };
    let reader = BufReader::new(stream);

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break, // connection gone
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let response = match parse_request(trimmed) {
            Ok(req) => {
                // `ask` blocks on a human clicking a button, so it gets its
                // own (clamped) timeout instead of the 8s show/edit wait —
                // computed from the request before dispatch so the wait
                // matches what the caller asked for even if dispatch fails
                // fast.
                let wait = match &req {
                    AiRequest::Ask { timeout_secs, .. } => {
                        Duration::from_secs(clamp_ask_timeout(*timeout_secs))
                    }
                    _ => Duration::from_secs(8),
                };
                let (tx, rx) = mpsc::channel::<AiResponse>();
                let id = dispatch(app, req, tx);
                match rx.recv_timeout(wait) {
                    Ok(resp) => resp,
                    Err(_) => {
                        // Drop the waiting entry so a response that arrives after
                        // we've given up on it is a harmless no-op instead of a
                        // permanent leak in `AiPending`'s map.
                        app.state::<AiPending>().cancel(id);
                        AiResponse::error("timeout waiting for editor")
                    }
                }
            }
            Err(e) => AiResponse::error(e),
        };

        let Ok(mut json) = serde_json::to_string(&response) else {
            continue;
        };
        json.push('\n');
        if writer.write_all(json.as_bytes()).is_err() {
            break; // connection gone
        }
    }
}

/// One request waiting on the frontend.
struct PendingEntry {
    /// The window it was delivered (or queued) to.
    label: String,
    /// The document it is about. `None` only for a request that never had one.
    path: Option<String>,
    tx: mpsc::Sender<AiResponse>,
}

/// Requests waiting on a response from the frontend, keyed by an id the
/// frontend echoes back via `ai_respond`. Each carries the window and the
/// document it is about, so closing a window — or one tab of it — fails
/// exactly its own requests instead of leaving them to time out.
pub struct AiPending {
    map: Mutex<HashMap<u64, PendingEntry>>,
    next: AtomicU64,
}

impl Default for AiPending {
    fn default() -> Self {
        Self::new()
    }
}

impl AiPending {
    pub fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
        }
    }

    /// Allocate an id for a request that will be registered once the window
    /// that will own the response is known (see `dispatch`) — split from
    /// `register` because the payload built for the frontend needs the id
    /// before that window is resolved.
    fn alloc_id(&self) -> u64 {
        self.next.fetch_add(1, Ordering::SeqCst)
    }

    /// Register a waiting request under `id` (from `alloc_id`) before the
    /// payload is delivered, so a response can never arrive first.
    fn register(
        &self,
        id: u64,
        label: impl Into<String>,
        path: Option<String>,
        tx: mpsc::Sender<AiResponse>,
    ) {
        self.map.lock().unwrap().insert(
            id,
            PendingEntry {
                label: label.into(),
                path,
                tx,
            },
        );
    }

    /// Deliver a response to the connection waiting on `id`. An unknown id is a
    /// no-op — the request may have already timed out and been dropped.
    pub fn respond(&self, id: u64, response: AiResponse) {
        if let Some(entry) = self.map.lock().unwrap().remove(&id) {
            let _ = entry.tx.send(response);
        }
    }

    /// `respond` for an answer from a window's frontend: delivered only when
    /// `label` is the window the request was delivered to. Another window
    /// could otherwise answer — or dismiss — an agent's question it never
    /// showed. A refused answer leaves the request waiting; an id nobody
    /// waits on any more is a no-op, as for `respond`.
    pub fn respond_from(&self, id: u64, label: &str, response: AiResponse) -> Result<(), String> {
        let mut map = self.map.lock().unwrap();
        match map.get(&id) {
            None => Ok(()),
            Some(entry) if entry.label != label => {
                Err(format!("request {id} was not delivered to window {label}"))
            }
            Some(_) => {
                if let Some(entry) = map.remove(&id) {
                    let _ = entry.tx.send(response);
                }
                Ok(())
            }
        }
    }

    /// Remove a waiting request without delivering anything — used once the
    /// caller has already given up (the socket listener's own timeout), so a
    /// later `respond` for the same id finds nothing to deliver.
    pub fn cancel(&self, id: u64) {
        self.map.lock().unwrap().remove(&id);
    }

    /// Whether someone is still waiting on `id`: not answered, cancelled, or
    /// given up on by its own timeout.
    pub fn is_pending(&self, id: u64) -> bool {
        self.map.lock().unwrap().contains_key(&id)
    }

    /// Fail every entry matching `matches` with `error` and remove them.
    fn fail_where(&self, error: &str, matches: impl Fn(&PendingEntry) -> bool) {
        let mut map = self.map.lock().unwrap();
        let ids: Vec<u64> = map
            .iter()
            .filter(|(_, entry)| matches(entry))
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            if let Some(entry) = map.remove(&id) {
                let _ = entry.tx.send(AiResponse::error(error));
            }
        }
    }

    /// Fail every entry of a window that closed — `window::untrack_window`.
    pub fn cancel_for_window(&self, label: &str) {
        self.fail_where("window closed", |e| e.label == label);
    }

    /// Fail every entry of `label` about `path` — the tab was closed or
    /// released. An entry with no path is never matched.
    pub fn cancel_for_window_and_path(&self, label: &str, path: &str, error: &str) {
        self.fail_where(error, |e| e.label == label && e.path.as_deref() == Some(path));
    }

    /// The tab holding `path` moved from window `from` to `to` (`tab_move`):
    /// its agents wait on `to` from now on — an answer from there is
    /// accepted (`respond_from`), closing `to` fails them, closing `from`
    /// no longer does. Called under the `OpenFiles` lock (lock order
    /// `OpenFiles → AiPending`; nothing takes them the other way round).
    /// Returns how many requests followed the file.
    pub fn relabel(&self, from: &str, to: &str, path: &str) -> usize {
        let mut map = self.map.lock().unwrap();
        let mut n = 0;
        for entry in map.values_mut().filter(|e| e.label == from && e.path.as_deref() == Some(path)) {
            entry.label = to.to_string();
            n += 1;
        }
        n
    }

    #[cfg(test)]
    fn label_of(&self, id: u64) -> Option<String> {
        self.map.lock().unwrap().get(&id).map(|e| e.label.clone())
    }

    /// A waiting request, for tests in other modules (`register` is private).
    #[cfg(test)]
    pub(crate) fn register_waiting(&self, label: &str, path: Option<&str>) -> (u64, mpsc::Receiver<AiResponse>) {
        let (tx, rx) = mpsc::channel();
        let id = self.alloc_id();
        self.register(id, label, path.map(str::to_string), tx);
        (id, rx)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.map.lock().unwrap().len()
    }
}

/// Commands for windows whose frontend has not mounted yet, pulled once by
/// `ai_pull_pending` after `get_window_init`.
///
/// Lock order: `OpenFiles` → `AiQueue`, never the reverse — `deliver` pushes
/// while holding the registry lock, see `queue_unless_mounted`.
pub struct AiQueue(pub Mutex<HashMap<String, Vec<AiCommandPayload>>>);

impl Default for AiQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl AiQueue {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }

    fn push(&self, label: &str, payload: AiCommandPayload) {
        self.0
            .lock()
            .unwrap()
            .entry(label.to_string())
            .or_default()
            .push(payload);
    }

    /// Drain and return the commands queued for a window, called once on mount.
    pub fn pull(&self, label: &str) -> Vec<AiCommandPayload> {
        self.0.lock().unwrap().remove(label).unwrap_or_default()
    }

    /// Take out every command queued for `label` about `path`.
    pub fn drop_for(&self, label: &str, path: &str) -> Vec<AiCommandPayload> {
        let mut map = self.0.lock().unwrap();
        let Some(queued) = map.get_mut(label) else {
            return Vec::new();
        };
        let (dropped, kept): (Vec<_>, Vec<_>) =
            std::mem::take(queued).into_iter().partition(|p| p.path == path);
        *queued = kept;
        dropped
    }
}

/// Fail every AI command still queued for a window that's closing before its
/// frontend ever pulled the queue — e.g. `open_file_window`'s new window was
/// closed between creation and mount. Without this each queued command's
/// `AiPending` sender leaks until the socket listener's own 8s timeout, and
/// the CLI caller hangs the whole time for no reason.
pub fn cancel_queued_for_window(app: &AppHandle, label: &str) {
    let queued = app.state::<AiQueue>().pull(label);
    if queued.is_empty() {
        return;
    }
    let pending = app.state::<AiPending>();
    for payload in queued {
        pending.respond(
            payload.id,
            AiResponse::error("window closed before the command was delivered"),
        );
    }
}

/// Fail everything addressed to one document of one window — pending and
/// queued alike — with `error`. A queued command left in place would be
/// pulled and applied after its agent had already been told it failed.
pub fn cancel_for_tab(app: &AppHandle, label: &str, path: &str, error: &str) {
    let pending = app.state::<AiPending>();
    for payload in app.state::<AiQueue>().drop_for(label, path) {
        pending.respond(payload.id, AiResponse::error(error));
    }
    pending.cancel_for_window_and_path(label, path, error);
}

/// The event payload sent to the owning window as `ai-command`, and the shape
/// queued in `AiQueue` for a window still being created.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCommandPayload {
    pub id: u64,
    pub cmd: String, // "show" | "edit" | "ask" | "open" | "close"
    pub path: String,
    pub line: Option<usize>,
    pub find: Option<String>,
    pub content: Option<String>,
    pub show: bool,
    /// `ask` only — `None` for `show`/`edit`.
    pub question: Option<String>,
    /// `ask` only — empty for `show`/`edit`.
    pub options: Vec<String>,
    /// `ask` only — `0` for `show`/`edit`.
    pub timeout_secs: u64,
    /// `ask` only — checkbox mode. `false` for `show`/`edit`.
    pub multi: bool,
    /// `ask` only — offers a free-text field alongside the options. `false`
    /// for `show`/`edit`. Wire name `freeText` via the struct's camelCase rename.
    pub free_text: bool,
    /// True on exactly one command over the lifetime of an install: the first
    /// one an agent ever delivers. The frontend uses it to say, at the one
    /// moment the user is definitely paying attention, where this feature
    /// lives. Rides the payload rather than being a separate event so a command
    /// pulled from `AiQueue` by a window that did not exist yet carries it too.
    pub first_use: bool,
    /// The command may take the view (see `AiRequest::focus`). The frontend
    /// still keeps it in the background while the human is typing (spec §5).
    pub focus: bool,
    /// `show(transient: true)` — spec §7.
    pub transient: bool,
    /// Rust opened this file's tab for this very command (a new window): a
    /// quick look may mark only a tab it opened.
    pub fresh: bool,
}

/// How an AI command reaches its window — see `queue_unless_mounted`.
#[derive(Debug)]
enum Delivery {
    /// Waiting in `AiQueue` for the window to pull it.
    Queued,
    /// The window has mounted: send it as an event.
    Emit(AiCommandPayload),
    /// The window is no longer registered: it closed.
    Gone,
}

/// Queue `payload` for `label` while its frontend has not mounted; hand it
/// back to be emitted once it has.
///
/// Called with the `OpenFiles` lock held. `get_window_init` marks a window
/// mounted under that lock and `ai_pull_pending` runs after it, so a command
/// is queued only while the pull is still to come: an event sent before the
/// mount is lost, and one queued after the pull is never pulled.
fn queue_unless_mounted(
    reg: &crate::tabs::TabRegistry,
    queue: &AiQueue,
    label: &str,
    payload: AiCommandPayload,
) -> Delivery {
    if reg.window(label).is_none() {
        return Delivery::Gone;
    }
    if reg.is_mounted(label) {
        return Delivery::Emit(payload);
    }
    queue.push(label, payload);
    Delivery::Queued
}

/// Deliver `payload` to `label`. Its id must already be registered in
/// `AiPending`: a delivery that fails answers it with an error at once.
fn deliver(app: &AppHandle, label: &str, payload: AiCommandPayload) {
    let id = payload.id;
    let delivery = {
        let open_files = app.state::<window::OpenFiles>();
        let reg = open_files.0.lock().unwrap();
        queue_unless_mounted(&reg, &app.state::<AiQueue>(), label, payload)
    };
    let error = match delivery {
        Delivery::Queued => return,
        // `emit_to`, not `emit`: a broadcast reaches every window, and one
        // that does not own the file would race to answer with an error.
        Delivery::Emit(payload) => match app.emit_to(label, "ai-command", &payload) {
            Ok(()) => return,
            Err(_) => "failed to deliver to window",
        },
        Delivery::Gone => "window closed before the command was delivered",
    };
    app.state::<AiPending>().respond(id, AiResponse::error(error));
}

/// How long to wait for the open (run on the main thread) to report which
/// window took the file before giving up on a freshly opened file.
const OPEN_WINDOW_TIMEOUT: Duration = Duration::from_secs(2);

/// The event payload for `req`, delivered as `ai-command`.
fn payload_for(req: &AiRequest, id: u64, first_use: bool) -> AiCommandPayload {
    let mut p = AiCommandPayload {
        id,
        first_use,
        cmd: String::new(),
        path: req.path().to_string(),
        line: None,
        find: None,
        content: None,
        show: false,
        question: None,
        options: Vec::new(),
        timeout_secs: 0,
        multi: false,
        free_text: false,
        focus: req.focus(),
        transient: req.transient(),
        fresh: false,
    };
    match req {
        AiRequest::Show { line, find, .. } => {
            p.cmd = "show".to_string();
            p.line = *line;
            p.find = find.clone();
        }
        AiRequest::Edit { content, show, .. } => {
            p.cmd = "edit".to_string();
            p.content = Some(content.clone());
            p.show = *show;
        }
        AiRequest::Ask { question, options, line, find, timeout_secs, multi, free_text, .. } => {
            p.cmd = "ask".to_string();
            p.question = Some(question.clone());
            p.options = options.clone();
            p.line = *line;
            p.find = find.clone();
            p.timeout_secs = clamp_ask_timeout(*timeout_secs);
            p.multi = *multi;
            p.free_text = *free_text;
        }
        AiRequest::Open { .. } => p.cmd = "open".to_string(),
        AiRequest::Close { .. } => p.cmd = "close".to_string(),
        // Answered by Rust itself, never delivered to a window.
        AiRequest::Windows { .. } => p.cmd = "windows".to_string(),
    }
    p
}

/// Route a parsed request to its window (spec §5 — see `routing::route`),
/// opening one first if needed, and arrange for the response to come back on `tx`.
/// Returns the id registered for this request in `AiPending` — `0` (never a
/// real id, since `AiPending::next` starts at 1) if the request was answered
/// directly on `tx` without ever registering, so the caller's later
/// `AiPending::cancel(id)` on timeout is a harmless no-op.
fn dispatch(app: &AppHandle, mut req: AiRequest, tx: mpsc::Sender<AiResponse>) -> u64 {
    // MCP and raw clients converge on the spelling the CLI resolves to, so
    // one file is one tab however the caller wrote it.
    if let Some(path) = req.path_mut() {
        match request_path(path) {
            Ok(normalized) => *path = normalized,
            Err(e) => {
                let _ = tx.send(AiResponse::error(e));
                return 0;
            }
        }
    }
    match &req {
        AiRequest::Windows { .. } => {
            let mut resp = AiResponse::ok();
            resp.windows = Some(crate::routing::windows_now(app));
            let _ = tx.send(resp);
            return 0;
        }
        AiRequest::Close { .. } => return dispatch_close(app, &req, tx),
        _ => {}
    }

    let path = req.path().to_string();

    // `show` on a path that doesn't exist would otherwise fall through to
    // `open_file_window`, happily creating a new empty window for a file that
    // can never be shown. Fail fast instead. `edit` keeps the
    // create-window-then-apply behavior — a nonexistent path there is a
    // normal "start a new file" request.
    if matches!(&req, AiRequest::Show { .. }) && !std::path::Path::new(&path).exists() {
        let _ = tx.send(AiResponse::error("file does not exist"));
        return 0;
    }

    if let AiRequest::Ask {
        question, options, ..
    } = &req
    {
        if let Err(msg) = validate_ask(question, options) {
            let _ = tx.send(AiResponse::error(msg));
            return 0;
        }
        // Unlike `edit`, `ask` has no "start a new file" meaning — a question
        // about a file that neither exists on disk nor is already open (which
        // would let us route to it regardless of disk state) can never be
        // answered.
        let already_open = {
            let open_files = app.state::<window::OpenFiles>();
            let reg = open_files.0.lock().unwrap();
            reg.contains_path(&path)
        };
        if !already_open && !std::path::Path::new(&path).exists() {
            let _ = tx.send(AiResponse::error("file does not exist"));
            return 0;
        }
    }

    // Where it goes (spec §5), decided before anything is allocated: a dead
    // window number is answered here and must not burn the first-use toast.
    let target = match crate::routing::route_now(app, &path, req.window_binding()) {
        crate::routing::Route::DeadNumber(number) => {
            let listing = crate::routing::windows_now(app);
            let _ = tx.send(AiResponse::error(crate::routing::dead_number_error(number, &listing)));
            return 0;
        }
        crate::routing::Route::Existing(label) => Some(label),
        crate::routing::Route::NewWindow => None,
    };

    // The id is handed to the frontend in the payload before we know which
    // window will own the response — `AiPending::register` (which needs that
    // window's label) happens later, at each point below where the label
    // becomes known.
    let id = app.state::<AiPending>().alloc_id();
    // Check-and-set, here rather than earlier: the request has passed validation
    // and is about to be dispatched, so "an agent successfully reached us" is
    // true. A rejected request must not burn the one first-use notification.
    let first_use = crate::onboarding::mark_connected(
        app.config().version.as_deref().unwrap_or("0.0.0"),
    );
    let mut payload = payload_for(&req, id, first_use);

    if let Some(label) = target {
        app.state::<AiPending>().register(id, label.clone(), Some(path), tx);
        deliver(app, &label, payload);
        return id;
    }

    // Step 4: a window of its own, in the background unless the command may
    // take the view (spec §4). Window creation must happen on the main
    // thread — this listener runs on a background thread per connection —
    // and its outcome comes back on `opened_rx`: the file may have been
    // opened elsewhere since `route_now`, and then this command's tab is the
    // one the human already had.
    let activation = if payload.focus { window::Activation::Foreground } else { window::Activation::Background };
    let (opened_tx, opened_rx) = mpsc::channel();
    let ticket = Arc::new(OpenTicket::new());
    let ticket_for_open = Arc::clone(&ticket);
    let handle = app.clone();
    let path_for_open = path.clone();
    if app
        .run_on_main_thread(move || {
            if ticket_for_open.start() {
                let _ = opened_tx.send(window::try_open_file_window_with(&handle, Some(path_for_open), activation));
            }
        })
        .is_err()
    {
        let _ = tx.send(AiResponse::error("failed to open window for file"));
        return id;
    }
    let outcome = match opened_rx.recv_timeout(OPEN_WINDOW_TIMEOUT) {
        Ok(outcome) => Some(outcome),
        // The open started before the deadline: it is building the window
        // right now, and that window must get the command.
        Err(mpsc::RecvTimeoutError::Timeout) if !ticket.abandon() => opened_rx.recv().ok(),
        Err(_) => None,
    };
    let label = match outcome {
        Some(Ok(opened)) => land_on(opened, &mut payload),
        Some(Err(e)) => {
            eprintln!("ai: failed to open a window for {path}: {e}");
            let _ = tx.send(AiResponse::error("failed to open window for file"));
            return id;
        }
        None => {
            let _ = tx.send(AiResponse::error("failed to open window for file"));
            return id;
        }
    };
    app.state::<AiPending>().register(id, label.clone(), Some(path), tx);
    deliver(app, &label, payload);
    id
}

/// A request's path in its one spelling (`path_norm::normalize_path`). It
/// must be absolute: this process's own directory means nothing to the
/// caller, and resolving against it would open some other file. A `..` that
/// survives normalization would name a file by a spelling nobody else uses.
fn request_path(raw: &str) -> Result<String, String> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err("path must be absolute".to_string());
    }
    let normalized = crate::path_norm::normalize_path(path);
    if normalized.components().any(|c| c == std::path::Component::ParentDir) {
        return Err("path must be absolute".to_string());
    }
    Ok(normalized.to_string_lossy().into_owned())
}

/// `close`: to the window holding the file. Registered **without a path**:
/// the tab it closes fails its document's agents (`cancel_for_tab`), and this
/// request must not be one of them. No first-use toast — nothing is shown.
///
/// Only a file tab can be named by a path, so an agent's `close` can never
/// reach an untitled tab (spec §8). Rust closes nothing here: the window's
/// frontend decides, the ⌘W way.
fn dispatch_close(app: &AppHandle, req: &AiRequest, tx: mpsc::Sender<AiResponse>) -> u64 {
    let owner = {
        let open_files = app.state::<window::OpenFiles>();
        let reg = open_files.0.lock().unwrap();
        reg.label_of(req.path())
    }
    .filter(|label| app.get_webview_window(label).is_some());
    let Some(label) = owner else {
        let _ = tx.send(AiResponse::error("file is not open"));
        return 0;
    };
    let id = app.state::<AiPending>().alloc_id();
    app.state::<AiPending>().register(id, label.clone(), None, tx);
    deliver(app, &label, payload_for(req, id, false));
    id
}

/// A main-thread open the connection thread may give up on. Exactly one side
/// wins: the open starts, or the wait abandons it — an agent answered
/// "failed to open" never gets a window built for it afterwards.
struct OpenTicket(AtomicU8);

impl OpenTicket {
    const WAITING: u8 = 0;
    const STARTED: u8 = 1;
    const ABANDONED: u8 = 2;

    fn new() -> Self {
        Self(AtomicU8::new(Self::WAITING))
    }

    /// The open may run. `false`: it was abandoned, and must not.
    fn start(&self) -> bool {
        self.0
            .compare_exchange(Self::WAITING, Self::STARTED, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Give up on the open. `false`: it has started, and its result is coming.
    fn abandon(&self) -> bool {
        self.0
            .compare_exchange(Self::WAITING, Self::ABANDONED, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
}

/// The window `opened` put the file in. `fresh` only for a tab created for
/// this very command: a quick look must never mark a tab the human already
/// had (spec §7).
fn land_on(opened: window::Opened, payload: &mut AiCommandPayload) -> String {
    match opened {
        window::Opened::Created(label) => {
            payload.fresh = true;
            label
        }
        window::Opened::Existing(label) => label,
    }
}

/// IPC command: deliver the frontend's answer to an AI command back to the CLI
/// connection waiting on it — only from the window it was delivered to — with
/// that window's `#N` added (spec §5).
#[tauri::command]
pub async fn ai_respond(
    app: AppHandle,
    window: tauri::WebviewWindow,
    id: u64,
    mut response: AiResponse,
) -> Result<(), String> {
    let label = window.label().to_string();
    // The registry guard drops at the end of this block, before `AiPending`
    // is locked: the two are never held together.
    {
        let open_files = app.state::<window::OpenFiles>();
        let reg = open_files.0.lock().unwrap();
        stamp_window(&reg, &label, &mut response);
    }
    app.state::<AiPending>().respond_from(id, &label, response)
}

/// Set `response.window` to `label`'s `#N` from the registry — always, over
/// whatever the frontend sent: the number an agent binds to next must be the
/// one Rust knows. `None` for a window that has no number.
fn stamp_window(reg: &crate::tabs::TabRegistry, label: &str, response: &mut AiResponse) {
    response.window = reg.window(label).and_then(|w| w.number);
}

/// IPC command: whether the command `id` still has an agent waiting on it. A
/// command can wait in the frontend's tab queue past its cancellation (the
/// tab it was for was closed or released) or its timeout; applied then, it would
/// act for an agent that was already told it failed.
#[tauri::command]
pub async fn ai_is_pending(app: AppHandle, id: u64) -> Result<bool, String> {
    Ok(app.state::<AiPending>().is_pending(id))
}

/// IPC command: drain the AI commands queued for the calling window — commands
/// that arrived for a file before its window existed. Called once on mount,
/// like `get_window_init`.
#[tauri::command]
pub async fn ai_pull_pending(
    window: tauri::Window,
    state: tauri::State<'_, AiQueue>,
) -> Result<Vec<AiCommandPayload>, String> {
    Ok(state.pull(window.label()))
}

// ---------------------------------------------------------------------------
// CLI client (`mdmini ai show|edit ...`) — std only, never touches Tauri.
// ---------------------------------------------------------------------------

/// Default command socket path, overridable with `--socket` for dev builds
/// and tests (the dev app binds `/tmp/md_mini_dev_cmd.sock` instead — see
/// `socket_path`).
const DEFAULT_SOCKET_PATH: &str = "/tmp/md_mini_cmd.sock";

/// Parsed `ai <verb> <file> [flags]` arguments, verb-specific flags in `verb`.
#[derive(Debug, PartialEq)]
struct CliArgs {
    path: String,
    verb: CliVerb,
    socket: Option<String>,
}

#[derive(Debug, PartialEq)]
enum CliVerb {
    Show {
        line: Option<usize>,
        find: Option<String>,
        window: Option<u32>,
        /// `-b` → `Some(false)`, `-f` → `Some(true)`; absent: the default (focus).
        focus: Option<bool>,
        transient: bool,
    },
    Edit {
        show: bool,
        allow_empty: bool,
        window: Option<u32>,
    },
    Ask {
        question: String,
        options: Vec<String>,
        line: Option<usize>,
        find: Option<String>,
        timeout_secs: u64,
        multi: bool,
        free_text: bool,
        window: Option<u32>,
    },
    /// `mdmini <files> [-t N] [-b | -f]` routed through the socket (spec §4).
    Open {
        paths: Vec<String>,
        window: Option<u32>,
        focus: Option<bool>,
    },
    /// `mdmini ls [--json]`.
    Ls { json: bool },
    /// `mdmini close <file>`.
    Close,
    /// Local, offline: prints the full CLI reference. No file arg, no flags.
    Help,
    /// Local, offline: prints the agent-onboarding instruction block. No file
    /// arg. `mcp: true` (`--mcp`) prints the MCP-flavored behavioral snippet
    /// instead of the CLI-syntax one.
    Agent { mcp: bool },
    /// Local, offline: prints open comment threads. Path optional — without
    /// it, threads are collected from every document under cwd.
    Question,
    /// Local, offline: appends a reply to a comment thread. Text from stdin.
    Answer { id: String },
    /// Local, offline: streams one line per newly-open comment thread, for
    /// Claude Code Monitor.
    Watch,
}

const USAGE: &str = "usage: mdmini ai show <file> [--line N | --find TEXT] [-t N] [-b | -f] [--transient] [--socket PATH]\n       mdmini ai edit <file> [--show] [--allow-empty] [-t N] [--socket PATH]\n       mdmini ai ask <file> --question TEXT --option TEXT [--option TEXT ...] [--multi] [--free-text] [--at-line N | --at-find TEXT] [--timeout SECS] [-t N] [--socket PATH]\n       mdmini ai open <file>... [-t N] [-b | -f] [--socket PATH]\n       mdmini ai ls [--json] [--socket PATH]\n       mdmini ai close <file> [--socket PATH]\n       mdmini ai help\n       mdmini ai agent [--mcp]\n       mdmini ai question [<file>]\n       mdmini ai answer <file> --id ID\n       mdmini ai watch [<dir>]";

/// `-t N` / `--window N`: a window number, plain digits from 1 (spec §3: the
/// CLI has no `#`).
fn parse_window(value: Option<&String>) -> Result<u32, String> {
    let v = value.ok_or("-t requires a window number")?;
    // `parse` alone would also take `+7`.
    let digits = !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit());
    match v.parse::<u32>() {
        Ok(n) if digits && n >= 1 => Ok(n),
        _ => Err(format!("invalid window number: {v}")),
    }
}

/// `-b` / `-f` into `slot`; both on one command is an error.
fn set_focus(slot: &mut Option<bool>, value: bool) -> Result<(), String> {
    match *slot {
        Some(existing) if existing != value => Err("-b and -f are mutually exclusive".to_string()),
        _ => {
            *slot = Some(value);
            Ok(())
        }
    }
}

/// Parse the CLI args that follow the `ai` verb dispatch in `main.rs`, i.e.
/// `["show", "<file>", "--line", "42"]` or `["edit", "<file>", "--show"]`.
/// `help` and `agent` take no file arg — checked before the file-arg parsing
/// shared by `show`/`edit` below. `agent` accepts one optional flag, `--mcp`;
/// `help` accepts none.
fn parse_cli_args(args: &[String]) -> Result<CliArgs, String> {
    let mut iter = args.iter();
    let verb = iter.next().ok_or_else(|| USAGE.to_string())?;

    if verb == "help" {
        if iter.next().is_some() {
            return Err("help takes no arguments".to_string());
        }
        return Ok(CliArgs {
            path: String::new(),
            verb: CliVerb::Help,
            socket: None,
        });
    }
    if verb == "agent" {
        let mut mcp = false;
        for arg in iter.by_ref() {
            if arg == "--mcp" {
                mcp = true;
            } else {
                return Err(format!(
                    "agent takes no arguments (except --mcp): unknown flag: {}",
                    arg
                ));
            }
        }
        return Ok(CliArgs {
            path: String::new(),
            verb: CliVerb::Agent { mcp },
            socket: None,
        });
    }
    if verb == "question" || verb == "watch" {
        // Путь (или каталог для `watch`) необязателен: пусто = cwd.
        let path = iter.next().cloned().unwrap_or_default();
        if let Some(extra) = iter.next() {
            return Err(format!("{verb} takes at most one path: unexpected {extra}"));
        }
        return Ok(CliArgs {
            path,
            verb: if verb == "question" {
                CliVerb::Question
            } else {
                CliVerb::Watch
            },
            socket: None,
        });
    }
    if verb == "answer" {
        let path = iter.next().ok_or_else(|| USAGE.to_string())?.clone();
        let mut id: Option<String> = None;
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--id" => id = iter.next().cloned(),
                other => return Err(format!("unknown flag for answer: {other}")),
            }
        }
        let id = id.ok_or_else(|| "answer requires --id".to_string())?;
        return Ok(CliArgs {
            path,
            verb: CliVerb::Answer { id },
            socket: None,
        });
    }
    if verb == "open" {
        let mut paths = Vec::new();
        let mut window = None;
        let mut focus = None;
        let mut socket = None;
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "-t" | "--window" => window = Some(parse_window(iter.next())?),
                "-b" | "--background" => set_focus(&mut focus, false)?,
                "-f" | "--focus" => set_focus(&mut focus, true)?,
                "--socket" => socket = Some(iter.next().ok_or("--socket requires a value")?.clone()),
                other if other.starts_with('-') => return Err(format!("unknown flag: {other}")),
                _ => paths.push(arg.clone()),
            }
        }
        if paths.is_empty() {
            return Err("open needs at least one file".to_string());
        }
        return Ok(CliArgs { path: String::new(), verb: CliVerb::Open { paths, window, focus }, socket });
    }
    if verb == "ls" {
        let mut json = false;
        let mut socket = None;
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--json" => json = true,
                "--socket" => socket = Some(iter.next().ok_or("--socket requires a value")?.clone()),
                other => return Err(format!("ls takes only --json and --socket: unexpected {other}")),
            }
        }
        return Ok(CliArgs { path: String::new(), verb: CliVerb::Ls { json }, socket });
    }

    let path = iter.next().ok_or_else(|| USAGE.to_string())?.clone();
    let mut socket: Option<String> = None;

    match verb.as_str() {
        "show" => {
            let mut line: Option<usize> = None;
            let mut find: Option<String> = None;
            let mut window = None;
            let mut focus = None;
            let mut transient = false;
            while let Some(arg) = iter.next() {
                match arg.as_str() {
                    "--line" => {
                        let v = iter.next().ok_or("--line requires a value")?;
                        line = Some(
                            v.parse::<usize>()
                                .map_err(|_| format!("invalid --line value: {}", v))?,
                        );
                    }
                    "--find" => {
                        let v = iter.next().ok_or("--find requires a value")?;
                        find = Some(v.clone());
                    }
                    "-t" | "--window" => window = Some(parse_window(iter.next())?),
                    "-b" | "--background" => set_focus(&mut focus, false)?,
                    "-f" | "--focus" => set_focus(&mut focus, true)?,
                    "--transient" => transient = true,
                    "--socket" => {
                        let v = iter.next().ok_or("--socket requires a value")?;
                        socket = Some(v.clone());
                    }
                    other => return Err(format!("unknown flag: {}", other)),
                }
            }
            if line.is_some() && find.is_some() {
                return Err("--line and --find are mutually exclusive".to_string());
            }
            Ok(CliArgs {
                path,
                verb: CliVerb::Show { line, find, window, focus, transient },
                socket,
            })
        }
        "edit" => {
            let mut show = false;
            let mut allow_empty = false;
            let mut window = None;
            while let Some(arg) = iter.next() {
                match arg.as_str() {
                    "--show" => show = true,
                    "--allow-empty" => allow_empty = true,
                    "-t" | "--window" => window = Some(parse_window(iter.next())?),
                    "--socket" => {
                        let v = iter.next().ok_or("--socket requires a value")?;
                        socket = Some(v.clone());
                    }
                    other => return Err(format!("unknown flag: {}", other)),
                }
            }
            Ok(CliArgs {
                path,
                verb: CliVerb::Edit { show, allow_empty, window },
                socket,
            })
        }
        "ask" => {
            let mut question: Option<String> = None;
            let mut options: Vec<String> = Vec::new();
            let mut line: Option<usize> = None;
            let mut find: Option<String> = None;
            let mut timeout_secs = default_ask_timeout();
            let mut multi = false;
            let mut free_text = false;
            let mut window = None;
            while let Some(arg) = iter.next() {
                match arg.as_str() {
                    "-t" | "--window" => window = Some(parse_window(iter.next())?),
                    "--question" => {
                        let v = iter.next().ok_or("--question requires a value")?;
                        question = Some(v.clone());
                    }
                    "--option" => {
                        let v = iter.next().ok_or("--option requires a value")?;
                        options.push(v.clone());
                    }
                    "--multi" => multi = true,
                    "--free-text" => free_text = true,
                    "--at-line" => {
                        let v = iter.next().ok_or("--at-line requires a value")?;
                        line = Some(
                            v.parse::<usize>()
                                .map_err(|_| format!("invalid --at-line value: {}", v))?,
                        );
                    }
                    "--at-find" => {
                        let v = iter.next().ok_or("--at-find requires a value")?;
                        find = Some(v.clone());
                    }
                    "--timeout" => {
                        let v = iter.next().ok_or("--timeout requires a value")?;
                        timeout_secs = v
                            .parse::<u64>()
                            .map_err(|_| format!("invalid --timeout value: {}", v))?;
                    }
                    "--socket" => {
                        let v = iter.next().ok_or("--socket requires a value")?;
                        socket = Some(v.clone());
                    }
                    other => return Err(format!("unknown flag: {}", other)),
                }
            }
            if line.is_some() && find.is_some() {
                return Err("--at-line and --at-find are mutually exclusive".to_string());
            }
            let question = question.ok_or("--question is required")?;
            if !(2..=6).contains(&options.len()) {
                return Err("--option must be given between 2 and 6 times".to_string());
            }
            Ok(CliArgs {
                path,
                verb: CliVerb::Ask {
                    question,
                    options,
                    line,
                    find,
                    timeout_secs: clamp_ask_timeout(timeout_secs),
                    multi,
                    free_text,
                    window,
                },
                socket,
            })
        }
        "close" => {
            while let Some(arg) = iter.next() {
                match arg.as_str() {
                    "--socket" => socket = Some(iter.next().ok_or("--socket requires a value")?.clone()),
                    other => return Err(format!("unknown flag: {other}")),
                }
            }
            Ok(CliArgs { path, verb: CliVerb::Close, socket })
        }
        other => Err(format!("unknown command: {}", other)),
    }
}

/// Whether an `edit` with this stdin content should be refused before ever
/// touching the socket: empty content without `--allow-empty` is almost
/// always a shell mistake (`cat /dev/null | mdmini edit file.md`, a failed
/// upstream command whose empty output got piped in) that would otherwise
/// silently truncate the live buffer to nothing.
fn refuse_empty_edit(content: &str, allow_empty: bool) -> Option<AiResponse> {
    if content.is_empty() && !allow_empty {
        Some(AiResponse::error(
            "refusing to apply empty content (use --allow-empty)",
        ))
    } else {
        None
    }
}

/// The process exit code for a response line: `0` if it deserializes to an
/// `ok: true` `AiResponse`, `1` otherwise.
fn exit_code_for(response_json: &str) -> i32 {
    match serde_json::from_str::<AiResponse>(response_json) {
        Ok(resp) if resp.ok => 0,
        _ => 1,
    }
}

/// Print `response` to stdout and return the process exit code.
fn print_response_and_exit_code(response_json: &str) -> i32 {
    println!("{response_json}");
    exit_code_for(response_json)
}

/// Full reference for every `mdmini` verb — printed by `mdmini help`. Single
/// source of truth: keep in sync with `docs/ai-interface.md` by hand (the doc
/// says as much). Local and offline — works whether or not md-mini is
/// installed or running.
fn help_text() -> String {
    // Uses `###`-delimited raw string, not `#` — the body contains a literal
    // `"##` sequence (`--find "## Deploy"`) that would otherwise terminate a
    // single-hash raw string early.
    r###"mdmini — minimalist live-preview markdown editor for macOS

USAGE
  mdmini <file>... [-t N] [-b | -f]         Open files as tabs (see "Opening files")
  mdmini show <file> [--line N | --find TEXT] [-t N] [-b | -f] [--transient] [--socket PATH]
  mdmini edit <file> [--show] [--allow-empty] [-t N] [--socket PATH] < new-content
  mdmini ask <file> --question TEXT --option TEXT [--option TEXT ...] [--multi] [--free-text] [--at-line N | --at-find TEXT] [--timeout SECS] [-t N] [--socket PATH]
  mdmini ls [--json]
  mdmini close <file>
  mdmini question [<file>]
  mdmini answer <file> --id ID < reply-text
  mdmini watch [<dir>]
  mdmini mcp [--socket PATH]
  mdmini help
  mdmini agent [--mcp]

OPENING FILES
  mdmini notes.md report.md
      Opens the files as tabs of one new window; a file already open is
      focused where it is. Relative paths are resolved against the current
      directory. If md-mini isn't running, it is launched via `open`; an
      already-running instance receives the file list over a single-instance
      socket.
  mdmini notes.md -t 7        A tab in window #7, focused.
  mdmini notes.md -t 7 -b     The same in the background: the tab shimmers,
                              focus stays where it was.
  mdmini notes.md -b          In the background, routed (see "Windows").
  With CLAUDECODE set (an agent), `mdmini <file>` is routed and opens in the
  background by default; -f opens it in focus. A routed open prints one line
  of JSON: {"ok":true,"window":7,"focused":false,"opened":[...]}.

WINDOWS
  Every window has a number (#7 in its title) and a project: the git
  toplevel of the first file it held (a worktree is its own project), or
  that file's directory outside git.
  mdmini ls [--json]
      The open windows: number, project, tabs. --json prints
      {"ok":true,"windows":[{"window":7,"project":"md-mini",...}]}.
  mdmini close <file>
      Closes the tab holding <file>, saved first. Refused while it has
      unsaved changes, or while the user is typing in it.
  Routing, for show, edit, ask and routed opens:
    -t N  → window #N (a number no window has is an error that lists the
            open windows); a file already open → its tab, wherever it is;
            a window of the file's project → a new tab there (the one
            focused last); otherwise a new window.
  "window" in every answer is the #N to pass back with -t.

SHOW — point at a location in an already-open (or newly opened) window
  mdmini show <file> [--line N | --find "text"] [--socket PATH]

  Opens <file> (or focuses its window if already open) and scrolls the
  target into view with a ~1.6s pulse highlight.
    --line N        1-based line number, clamped to the document.
    --find TEXT     Locate the first substring match (case-sensitive).
                    Mutually exclusive with --line.
    --socket PATH   Talk to a non-default command socket (see "Dev builds").
    -t N, --window N  Open it in window #N (see "Windows").
    -b, --background  Do not switch to it: it opens (or stays) in the
                      background and shimmers until the user looks.
    -f, --focus       Switch to it and bring its window forward (default).
    --transient       A quick look: the tab asks the user "Close / Keep" by
                      itself; nothing comes back to you.
  The tab the user is typing in is never taken from them: while they type,
  show lands in the background and answers "focused":false.
  Neither --line nor --find: just opens/focuses the file, no scroll.

  Examples:
    mdmini show notes.md --line 42
    mdmini show notes.md --find "## Deploy"

EDIT — replace the live buffer with new content, diffed and highlighted
  cat new.md | mdmini edit <file> [--show] [--allow-empty] [--socket PATH]

  Reads the COMPLETE new document from stdin, diffs it against what's
  currently in the live buffer, applies only the changed span, and marks it
  with a persistent highlight. If the file isn't open yet, md-mini opens a
  window for it first, then applies the edit.
    --show          Also scroll the changed span into view.
    --allow-empty   Permit empty stdin (otherwise refused — see below).
    --socket PATH   Talk to a non-default command socket.
    -t N            Window #N (see "Windows").

  Always send the FULL new document on stdin, never a diff/patch — md-mini
  computes the diff itself against the live buffer.
  An edit to a background tab is applied there and saved at once; the user
  sees it highlighted, with undo, when they open the tab.

  Empty stdin is refused by default:
    {"ok":false,"error":"refusing to apply empty content (use --allow-empty)"}
  exit 2. This guards against a shell mistake (e.g. `cat /dev/null | mdmini
  edit file.md`) silently truncating the buffer. Pass --allow-empty to
  intentionally clear a file.

  Example:
    cat new.md | mdmini edit notes.md --show

ASK — post a question with option buttons, block until the user answers
  mdmini ask <file> --question TEXT --option TEXT [--option TEXT ...] \
    [--multi] [--free-text] [--at-line N | --at-find TEXT] [--timeout SECS] [--socket PATH]

  Renders the question and 2-6 option buttons inside the open (or newly
  opened) document, blocks until the user answers, and returns the choice.
  Use for a quick decision while working on that document.
    --question TEXT   The question text. Required.
    --option TEXT     One button's label. Repeat 2-6 times. Required.
    --multi           Checkbox mode: the user may check any number of
                       options (including none) and confirms, instead of
                       clicking exactly one. Response carries "answers" (an
                       array) instead of "answer" — see JSON RESPONSE
                       CONTRACT below.
    --free-text       Also offer a free-text field: the user may type a
                       custom answer instead of (single mode) or alongside
                       (--multi) picking options. A typed answer comes back
                       as "custom" in the response — see JSON RESPONSE
                       CONTRACT below.
    --at-line N       Show the question near this 1-based line number.
                       Mutually exclusive with --at-find.
    --at-find TEXT    Show the question near the first substring match.
                       Mutually exclusive with --at-line.
    --timeout SECS    How long to wait for an answer. Default 300, clamped
                       to 10-3600.
    --socket PATH     Talk to a non-default command socket.
    -t N              Window #N (see "Windows").
  Neither --at-line nor --at-find: the question appears at the current view.

  Examples:
    mdmini ask notes.md --question "Ship it?" --option Yes --option No
    mdmini ask notes.md --question "Which reviewers?" --option A --option B --option C --multi
    mdmini ask notes.md --question "Ship it?" --option Yes --option No --free-text
  An ask for a background tab waits there (the tab shimmers) and appears
  when the user opens it. The timeout still counts from now.

COMMENTS — the reverse direction: the user comments, you answer
  mdmini question [<file>]
  mdmini answer <file> --id ID < reply-text
  mdmini watch [<dir>]

  The user selects a fragment in a document and writes a comment. Threads live
  in `.mdmini_comments_<doc>.md` beside the document, as plain markdown — so
  these three verbs are LOCAL and OFFLINE: no command socket, no running app.
  (Contrast show/edit/ask, which drive a live window and need one.)

    question [<file>]   List open threads: id, status, anchor line, quoted
                        fragment, and every reply. With a path, that document
                        only; without one, everything under the current
                        directory. Prints {"ok":true,"threads":[...]}.
    answer <file> --id ID
                        Append your reply from stdin and mark the thread
                        answered. Empty stdin is refused.
    watch [<dir>]       Long-running. Prints one line per newly-open thread and
                        never repeats one. Hand it to a Claude Code Monitor with
                        persistent: true — each line then interrupts your live
                        session, so you answer with full context instead of
                        polling. Without persistent: true the monitor dies after
                        five minutes, and silence looks exactly like "no
                        comments".

  If a comment asks for a change rather than an answer, make the change with
  `edit`, then close the thread with `answer`.

  No MCP and no md-mini? The file is readable markdown — read the sidecar and
  append a reply with ordinary file tools. Same result.

  Examples:
    mdmini question
    mdmini question docs/spec.md
    echo "Because nginx was broken on that host." | mdmini answer docs/spec.md --id c-7f3a2c

JSON RESPONSE CONTRACT
  show, edit, ask, close, ls --json and a routed open each print exactly one
  line of JSON to stdout. Without CLAUDECODE (a human), the error of a routed
  open, close or ls is also said in words on stderr.

    show, success:                    {"ok":true,"window":7,"focused":true}
    show in the background:           {"ok":true,"window":7,"focused":false}
    edit, success:                    {"ok":true,"changed_lines":[[12,15]],"window":7,"focused":true}
    edit, no-op (identical content):  {"ok":true,"changed_lines":[]}
    ask, success:                     {"ok":true,"answer":"Yes"}
    ask --multi, success:             {"ok":true,"answers":["A","C"]}
    ask --multi, confirmed none:      {"ok":true,"answers":[]}
    ask --free-text, typed answer:    {"ok":true,"custom":"Something else"}
    ask --multi --free-text, both:    {"ok":true,"answers":["A"],"custom":"and also this"}
    error (any verb):                 {"ok":false,"error":"target not found"}

  changed_lines holds one [start,end] pair per changed region, 1-based
  inclusive line numbers in the resulting document. Edits scattered across the
  file report several pairs rather than one span covering everything between
  them; a block that was rewritten wholesale is reported in full.

EXIT CODES
    0   Request reached md-mini and succeeded ("ok":true).
    1   Request reached md-mini but was rejected ("ok":false), or the CLI's
        own wait for a reply timed out (10s for show/edit, the ask timeout
        plus 10s for ask).
    2   Usage error (bad flags, missing file, unknown verb), edit refused
        empty stdin without --allow-empty, ask given fewer than 2 or more
        than 6 --option flags or no --question, or md-mini isn't running /
        didn't start in time.

MCP — stdio MCP server exposing show/edit/ask as tools, for agents that speak MCP
  mdmini mcp [--socket PATH]
      Runs a Model Context Protocol server on stdin/stdout instead of the CLI
      verbs above: same show/edit/ask operations, wrapped as MCP tools over
      JSON-RPC 2.0. Launches md-mini via `open` if the command socket is down
      (skipped when --socket is given explicitly). Register once with:
        claude mcp add --scope user mdmini -- mdmini mcp
      See docs/ai-interface.md ("MCP server") for the generic mcpServers JSON
      shape and the full method/tool reference.

HELP
  mdmini help
      Prints this reference. Exit 0. Local and offline — works even if
      md-mini isn't installed or running.

AGENT
  mdmini agent [--mcp]
      Prints a ready-to-paste instruction block for an AI agent's
      instruction file (CLAUDE.md, AGENTS.md, etc.). Without --mcp:
      the CLI-syntax show/edit/ask reference, for agents driving mdmini
      as a shell command. With --mcp: a shorter behavioral snippet for
      agents already connected via `mdmini mcp` — the tools are
      self-describing there, so this covers usage culture instead
      (when to ask in the document vs. chat, reading multi-choice/
      free-text answers). Exit 0. Local and offline either way.

DEV BUILDS
  Release and dev builds use different command sockets:
    Release (md-mini)   /tmp/md_mini_cmd.sock
    Dev (md-mini-dev)   /tmp/md_mini_dev_cmd.sock
  Pass --socket explicitly to target a dev build's socket.

See docs/ai-interface.md in the md-mini repository for the full protocol,
routing behavior, and troubleshooting."###
        .to_string()
}

/// The fenced instruction block reused verbatim by `mdmini agent` and by
/// `docs/ai-interface.md`'s "Using this from an AI agent's CLAUDE.md"
/// section. Keep both in sync by hand when this changes.
pub(crate) const AGENT_SNIPPET: &str = r#"## md-mini AI interface

If `mdmini` is available, use it to point at things in the user's open editor and to push edits into the live buffer, instead of only writing files to disk:

- `mdmini show <file> --line N` — scroll to line N in the file's tab and pulse-highlight it.
- `mdmini show <file> --find "some text"` — same, but locate the first match of the text instead of a line number.
- `cat new-content.md | mdmini edit <file> [--show]` — replace the file's live buffer with the **complete** new content read from stdin. md-mini diffs it against what's on screen, applies only the changed span, and highlights it. `--show` also scrolls to the change.
- `mdmini ask <file> --question "..." --option A --option B [--option ...]` — post a question with 2-6 option buttons inside the document and block until the user clicks one; prints `{"ok":true,"answer":"A"}` with the chosen option's text. Add `--multi` for checkbox mode (any number of options, including none, checked and confirmed) — prints `{"ok":true,"answers":["A","C"]}` instead. Add `--free-text` to also let the user type a custom answer — prints `{"ok":true,"custom":"..."}` (or alongside `answers` in `--multi` mode) when they do.
- `mdmini <file>` — open a file as a tab. From you (an agent, `CLAUDECODE` set) it opens in the background: the tab shimmers until the user looks; `-f` brings it to the front. When the user should read something now, use `mdmini show <file>` (or `-f`).
- `mdmini ls` — the open windows: number, project, tabs (`--json` for machine-readable output). `mdmini close <file>` — close a tab you opened and no longer need.

Windows: every answer names the window it landed in — `{"ok":true,"window":7,"focused":true}`. Pass `-t 7` to `show`/`edit`/`ask`/`mdmini <file>` to keep working in that window. Without `-t` a file goes to its own tab if it is open (wherever that is — the answer's `window` says where), else to a window of its project (the git toplevel), else to a new window. The tab the user is typing in is never taken from them: `"focused":false` means your show landed in the background — tell them where to look instead of retrying. If they are typing in that very tab, the answer is `"focused":true` but nothing moves: the target only pulses, possibly off-screen. An `edit` of a background tab is applied and saved there; an `ask` for one waits there until they open it, and its timeout still counts from the call. Use `mdmini show <file> --transient` for a quick look: the tab asks them "Close / Keep" by itself.

All verbs print one line of JSON to stdout: `{"ok":true}` (plus `"window"`/`"focused"`, `"changed_lines":[[start,end]]` for `edit`, `"answer":"..."` for `ask`, `"answers":[...]` for `ask --multi`, or `"custom":"..."` for a typed `ask --free-text` answer) on success, `{"ok":false,"error":"..."}` on failure. Exit code 0 = success, 1 = md-mini rejected the request, 2 = md-mini isn't running or the command was malformed. If the target file isn't open yet, `edit`/`show` open it as a tab by the rule above — for `show` it must already exist on disk (`ask` requires the same: already open, or existing on disk). Always send the full document on stdin for `edit`, never a diff.

### Comments the user leaves for you

The user can also comment on a fragment of a document and expect you to answer. Threads live in `.mdmini_comments_<doc>.md` beside the document as plain markdown, so these verbs need no running app:

- `mdmini question [<file>]` — list open threads (id, status, anchor, quoted fragment, replies). Without a path, everything under the current directory.
- `echo "reply" | mdmini answer <file> --id c-7f3a2c` — append your reply and mark the thread answered.
- `mdmini watch [<dir>]` — long-running; prints one line per newly-open thread.

A thread the user is still typing has `status=paused` and is deliberately invisible to both `question` and `watch` — you are told about it about twenty seconds after they stop typing, or the moment they press "send now". So a comment can exist for half a minute before you hear about it, and that is working as intended, not a delivery failure.

If your harness can react to a stream (Claude Code: `Monitor({command: "mdmini watch", description: "new mdmini comments", persistent: true})`), arm it once per session and you get woken in this same session, with your context intact, instead of polling. `persistent: true` matters: without it the monitor dies after five minutes and its silence looks exactly like "no comments". Also add a `Stop` hook running `mdmini question` that blocks the turn while anything is open — a monitor that emits too much is stopped by the harness without telling you, and the hook is what stops comments piling up unseen.

If your harness cannot do either, check `mdmini question` at natural points: before asking the user something in chat, and before reporting that you are done. A comment line is an interruption, not a user message — finish the current step cleanly, then answer. If a comment asks for a change rather than an answer, make it with `edit`, then close the thread with `answer`."#;

/// Common instruction-file locations, shared by `mdmini agent`'s CLI-syntax
/// snippet and its `--mcp` behavioral-snippet counterpart below.
pub(crate) const INSTRUCTION_FILE_LOCATIONS: &str = "\
\x20 CLAUDE.md                         Claude Code — project root, or ~/.claude/CLAUDE.md for all projects\n\
\x20 AGENTS.md                         Codex CLI / generic agent standard — project root\n\
\x20 GEMINI.md                         Gemini CLI\n\
\x20 .cursor/rules or .cursorrules     Cursor\n\
\x20 .github/copilot-instructions.md   GitHub Copilot";

/// Text for `mdmini agent` — printed by `mdmini help` for
/// `mdmini agent`. Local and offline.
fn agent_text() -> String {
    format!(
        "Paste the block below into your AI agent's instruction file. Common locations:\n\n\
        {}\n\n\
        --- copy from here ---\n\
        {}\n\n\
        Prefer MCP? `claude mcp add --scope user mdmini -- mdmini mcp` registers md-mini's show/edit/ask tools directly — then no instruction-file snippet is needed; run `mdmini agent --mcp` for a short usage-culture snippet worth pasting alongside it.",
        INSTRUCTION_FILE_LOCATIONS, AGENT_SNIPPET
    )
}

/// The fenced instruction block reused verbatim by `mdmini agent --mcp` and by
/// `docs/ai-interface.md`'s "MCP server" section. Keep both in sync by hand
/// when this changes — same discipline as `AGENT_SNIPPET`.
///
/// Unlike `AGENT_SNIPPET`, this isn't CLI syntax — an MCP-connected agent
/// already gets `show`/`edit`/`ask` as self-describing tools via `tools/list`.
/// What it needs instead is usage culture: when to reach for `ask` over
/// chatting, how to read multi-choice/free-text answers, and how to be
/// considerate of the user's attention.
pub(crate) const MCP_AGENT_SNIPPET: &str = r#"## md-mini via MCP — how to use it well

- Before asking the user something about a document, use `show` (line or find) so they're looking at the relevant part when the question arrives — or anchor the `ask` itself there with line/find.
- Prefer `ask` in the document over asking in chat when the question is about the document the user has open: single choice for decisions, `multi` for pick-several, `free_text` when their own words matter. An empty `answers` array means "none of these", not an error.
- Chain questions: read each answer and build the next ask from it. Answers arrive as `answer` (string), `answers` (array), and/or `custom` (their typed text).
- After edits, the changed span stays highlighted until the user presses Esc or you edit again — use `show: true` on the edit when they should see the change immediately.
- Respect their attention: batch related questions into one `ask` with options rather than many small ones; timeouts/dismissals mean "not now", not failure — fall back to chat.
- `edit` takes the COMPLETE new document, never a diff; md-mini diffs internally and preserves their scroll position and undo history.
- Windows: every answer names the `window` (#N) it landed in. Pass it back as `window_binding` to keep working in that window; call `windows` to see what is open (projects, tabs) and pick one. Without a binding a file goes to its own tab if it is open anywhere, else to a window of its project, else to a new window.
- `show` switches to the tab by default; `focus: false` opens it in the background, where it shimmers until the user looks. A user who is typing always keeps their tab — the answer then says `focused: false`: tell them where to look instead of retrying. If they are typing in that very tab, the answer is `focused: true` but nothing moves: the target only pulses.
- `transient: true` is for a quick look — something they glance at once. The tab asks them «Close / Keep» by itself; leave it off for documents you will keep working in.
- An `edit` of a background tab is applied and saved there, highlighted when they open it; an `ask` for one waits there until they do, and its timeout still counts from the call.
- Close what you opened and no longer need with `close` — hygiene, not isolation.

### Comments the user leaves for you

- Arm this once at the start of a session: `Monitor({command: "mdmini watch", description: "new mdmini comments", persistent: true})`. Every line it prints is a new comment, delivered as an interruption in this session — so you answer with the context you already have. `persistent: true` is not optional: without it the monitor dies after five minutes and its silence is indistinguishable from "no comments".
- A monitor line is an interruption, not a message from the user. Bring the current step to a consistent state first, then answer at that checkpoint — abandoning a half-finished edit to reply is worse for them than replying a minute later.
- Use the `question` tool to read open threads and `answer` to reply. Also check `question` before asking them something in chat and before reporting that you are done: they may have already answered you in the document.
- If a comment asks for a change rather than an answer, make it with `edit`, then close the thread with `answer`.
- Add a `Stop` hook that runs `mdmini question` and blocks the turn while anything is still open. This is the backstop that matters: a monitor emitting too much is stopped by the harness, and you will not necessarily notice — without the hook, comments pile up in silence."#;

/// Text for `mdmini agent --mcp` — printed by `mdmini help` for `mdmini agent
/// [--mcp]`. Local and offline.
fn mcp_agent_text() -> String {
    format!(
        "Paste the block below into your AI agent's instruction file if md-mini is connected via MCP (mdmini mcp). Common locations:\n\n\
        {}\n\n\
        --- copy from here ---\n\
        {}",
        INSTRUCTION_FILE_LOCATIONS, MCP_AGENT_SNIPPET
    )
}

/// `CLAUDECODE` set and non-empty: an agent is calling (spec §4). Claude Code
/// sets `1`; any non-empty value counts.
fn is_agent(claudecode: Option<&str>) -> bool {
    claudecode.is_some_and(|v| !v.is_empty())
}

/// A human reads errors, not JSON: say it on stderr too (stdout keeps the
/// one JSON line of the contract).
fn tell_human(response_line: &str) {
    if let Ok(resp) = serde_json::from_str::<AiResponse>(response_line) {
        if let Some(error) = resp.error {
            eprintln!("mdmini: {error}");
        }
    }
}

/// One request and its one response line, over a fresh connection. `Err`
/// carries the JSON line to print and the exit code, for a request that never
/// reached the app or never got an answer.
fn exchange(socket_path: &Path, request: &AiRequest) -> Result<String, (String, i32)> {
    let fail = |msg: String, code: i32| (serde_json::to_string(&AiResponse::error(msg)).unwrap(), code);
    let mut stream =
        UnixStream::connect(socket_path).map_err(|_| fail("md-mini is not running".to_string(), 2))?;
    // `ask` blocks server-side on a human clicking a button, so the CLI's own
    // read timeout must cover that wait (plus 10s of margin) instead of the
    // fixed 10s used for everything else.
    let read_timeout = match request {
        AiRequest::Ask { timeout_secs, .. } => Duration::from_secs(timeout_secs + 10),
        _ => Duration::from_secs(10),
    };
    let _ = stream.set_read_timeout(Some(read_timeout));
    let mut line = serde_json::to_string(request).map_err(|e| fail(format!("failed to encode request: {e}"), 1))?;
    line.push('\n');
    stream
        .write_all(line.as_bytes())
        .map_err(|_| fail("md-mini is not running".to_string(), 2))?;
    let mut reader = BufReader::new(stream);
    let mut response_line = String::new();
    match reader.read_line(&mut response_line) {
        Ok(0) | Err(_) => Err(fail("timeout waiting for response".to_string(), 1)),
        Ok(_) => Ok(response_line.trim().to_string()),
    }
}

/// One line for several opens: `window`/`focused` of the first tab, every tab in `opened`.
fn open_summary(opened: Vec<OpenedTab>, error: Option<String>) -> AiResponse {
    AiResponse {
        ok: error.is_none(),
        error,
        window: opened.first().and_then(|t| t.window),
        focused: opened.first().map(|t| t.focused),
        opened: Some(opened),
        ..Default::default()
    }
}

/// The most files one `mdmini <files>` opens: each is a round trip and a tab,
/// and a stray glob should not fill the app.
const MAX_OPEN_FILES: usize = 50;

/// One `open` per file through `send`, summed up in one answer and its exit
/// code. A file the app refuses is reported and the rest still open; a
/// transport failure (the app went away, no answer) stops there, and the
/// answer still lists what had opened — with the transport's exit code.
fn open_all(
    paths: &[String],
    window: Option<u32>,
    focus: bool,
    mut send: impl FnMut(&AiRequest) -> Result<String, (String, i32)>,
) -> (AiResponse, i32) {
    if paths.len() > MAX_OPEN_FILES {
        let msg = format!("too many files: {} (at most {MAX_OPEN_FILES} at once)", paths.len());
        return (AiResponse::error(msg), 2);
    }
    let mut opened = Vec::new();
    let mut first_error = None;
    let mut transport_code = None;
    for path in paths {
        let abs = crate::resolve_path(path, None);
        let request = AiRequest::Open { v: 1, path: abs.clone(), window_binding: window, focus };
        let resp = match send(&request) {
            Ok(line) => serde_json::from_str::<AiResponse>(&line)
                .unwrap_or_else(|e| AiResponse::error(format!("failed to parse response: {e}"))),
            Err((line, code)) => {
                transport_code = Some(code);
                serde_json::from_str::<AiResponse>(&line).unwrap_or_else(|_| AiResponse::error(line))
            }
        };
        if resp.ok {
            opened.push(OpenedTab { path: abs, window: resp.window, focused: resp.focused.unwrap_or(false) });
        } else if first_error.is_none() {
            first_error = resp.error;
        }
        if transport_code.is_some() {
            break;
        }
    }
    let summary = open_summary(opened, first_error);
    let code = transport_code.unwrap_or(if summary.ok { 0 } else { 1 });
    (summary, code)
}

/// `mdmini <files>` routed: one `open` per file, one summary line.
fn run_open(socket_path: &Path, paths: &[String], window: Option<u32>, focus: bool, agent: bool) -> i32 {
    let (summary, code) = open_all(paths, window, focus, |request| exchange(socket_path, request));
    let line = serde_json::to_string(&summary).unwrap();
    println!("{line}");
    if code != 0 && !agent {
        tell_human(&line);
    }
    code
}

/// `mdmini ls`: the listing as text, or the JSON answer with `--json`.
fn run_ls(socket_path: &Path, json: bool) -> i32 {
    let line = match exchange(socket_path, &AiRequest::Windows { v: 1 }) {
        Ok(line) => line,
        Err((line, code)) => {
            println!("{line}");
            // The text listing is for a human: say it in words as well.
            if !json {
                tell_human(&line);
            }
            return code;
        }
    };
    if json {
        return print_response_and_exit_code(&line);
    }
    match serde_json::from_str::<AiResponse>(&line) {
        Ok(resp) if resp.ok => {
            let windows = resp.windows.unwrap_or_default();
            if windows.is_empty() {
                println!("No windows are open.");
            } else {
                println!("{}", crate::routing::format_listing(&windows, None, ""));
            }
            0
        }
        _ => {
            println!("{line}");
            tell_human(&line);
            1
        }
    }
}

/// Entry point for `mdmini ai <verb> ...`, called from `main.rs` before Tauri
/// is touched. `args` is the full `std::env::args()` vector (`args[0]` is the
/// binary path, `args[1]` is `"ai"`); everything from `args[2]` on is the verb
/// and its flags. Returns the process exit code.
pub fn run_ai_cli(args: Vec<String>) -> i32 {
    let parsed = match parse_cli_args(&args[2.min(args.len())..]) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{}", e);
            return 2;
        }
    };

    // `help`/`agent` are local and offline — no path, no stdin, no socket.
    match parsed.verb {
        CliVerb::Help => {
            println!("{}", help_text());
            return 0;
        }
        CliVerb::Agent { mcp } => {
            println!("{}", if mcp { mcp_agent_text() } else { agent_text() });
            return 0;
        }
        CliVerb::Question => {
            let root = if parsed.path.is_empty() {
                std::env::current_dir().unwrap_or_default()
            } else {
                PathBuf::from(crate::resolve_path(&parsed.path, None))
            };
            let mut resp = AiResponse::ok();
            resp.threads = Some(crate::comments::collect_open(&root));
            println!("{}", serde_json::to_string(&resp).unwrap());
            return 0;
        }
        CliVerb::Watch => {
            let root = if parsed.path.is_empty() {
                std::env::current_dir().unwrap_or_default()
            } else {
                PathBuf::from(crate::resolve_path(&parsed.path, None))
            };
            return crate::watch::run(&root);
        }
        CliVerb::Answer { ref id } => {
            let doc = PathBuf::from(crate::resolve_path(&parsed.path, None));
            let mut text = String::new();
            if std::io::stdin().read_to_string(&mut text).is_err() {
                println!(
                    "{}",
                    serde_json::to_string(&AiResponse::error("failed to read stdin")).unwrap()
                );
                return 2;
            }
            if text.trim().is_empty() {
                println!(
                    "{}",
                    serde_json::to_string(&AiResponse::error("refusing to post an empty answer"))
                        .unwrap()
                );
                return 2;
            }
            return match crate::comments::append_reply(&doc, id, "agent", text.trim()) {
                Ok(()) => {
                    println!("{}", serde_json::to_string(&AiResponse::ok()).unwrap());
                    0
                }
                Err(e) => {
                    println!("{}", serde_json::to_string(&AiResponse::error(&e)).unwrap());
                    1
                }
            };
        }
        _ => {}
    }

    let socket_path = parsed
        .socket
        .clone()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_SOCKET_PATH));
    let agent = is_agent(std::env::var("CLAUDECODE").ok().as_deref());
    match &parsed.verb {
        // A human's `-t` focuses; an agent's open lands in the background (spec §4).
        CliVerb::Open { paths, window, focus } => {
            return run_open(&socket_path, paths, *window, focus.unwrap_or(!agent), agent)
        }
        CliVerb::Ls { json } => return run_ls(&socket_path, *json),
        _ => {}
    }

    let abs_path = crate::resolve_path(&parsed.path, None);

    let content = if matches!(parsed.verb, CliVerb::Edit { .. }) {
        let mut buf = String::new();
        if std::io::stdin().read_to_string(&mut buf).is_err() {
            eprintln!("failed to read stdin");
            return 2;
        }
        Some(buf)
    } else {
        None
    };

    if let CliVerb::Edit { allow_empty, .. } = &parsed.verb {
        if let Some(resp) = refuse_empty_edit(content.as_deref().unwrap_or(""), *allow_empty) {
            println!("{}", serde_json::to_string(&resp).unwrap());
            return 2;
        }
    }

    let request = match parsed.verb {
        CliVerb::Show { line, find, window, focus, transient } => AiRequest::Show {
            v: 1,
            path: abs_path,
            line,
            find,
            window_binding: window,
            focus,
            transient,
        },
        CliVerb::Edit { show, window, .. } => AiRequest::Edit {
            v: 1,
            path: abs_path,
            content: content.unwrap_or_default(),
            show,
            window_binding: window,
        },
        CliVerb::Ask { question, options, line, find, timeout_secs, multi, free_text, window } => AiRequest::Ask {
            v: 1,
            path: abs_path,
            question,
            options,
            line,
            find,
            timeout_secs,
            multi,
            free_text,
            window_binding: window,
        },
        CliVerb::Close => AiRequest::Close { v: 1, path: abs_path },
        CliVerb::Open { .. }
        | CliVerb::Ls { .. }
        | CliVerb::Help
        | CliVerb::Agent { .. }
        | CliVerb::Question
        | CliVerb::Answer { .. }
        | CliVerb::Watch => {
            unreachable!("handled above, before this match")
        }
    };

    let is_close = matches!(request, AiRequest::Close { .. });
    match exchange(&socket_path, &request) {
        Ok(line) => {
            let code = print_response_and_exit_code(&line);
            if code != 0 && is_close && !agent {
                tell_human(&line);
            }
            code
        }
        Err((line, code)) => {
            println!("{line}");
            if is_close && !agent {
                tell_human(&line);
            }
            code
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_path_release_and_dev_differ() {
        assert_eq!(
            socket_path("md-mini"),
            PathBuf::from("/tmp/md_mini_cmd.sock")
        );
        assert_eq!(
            socket_path("md-mini-dev"),
            PathBuf::from("/tmp/md_mini_dev_cmd.sock")
        );
    }

    #[test]
    fn parses_show_with_line() {
        let req = parse_request(r#"{"v":1,"cmd":"show","path":"/a.md","line":42}"#).unwrap();
        match req {
            AiRequest::Show {
                line, find, path, ..
            } => {
                assert_eq!(line, Some(42));
                assert_eq!(find, None);
                assert_eq!(path, "/a.md");
            }
            _ => panic!("expected Show"),
        }
    }

    #[test]
    fn parses_edit_with_default_show() {
        let req = parse_request(r#"{"v":1,"cmd":"edit","path":"/a.md","content":"x"}"#).unwrap();
        match req {
            AiRequest::Edit { show, content, .. } => {
                assert!(!show);
                assert_eq!(content, "x");
            }
            _ => panic!("expected Edit"),
        }
    }

    #[test]
    fn parses_ask_with_default_timeout() {
        let req = parse_request(
            r#"{"v":1,"cmd":"ask","path":"/a.md","question":"Ship it?","options":["Yes","No"]}"#,
        )
        .unwrap();
        match req {
            AiRequest::Ask {
                question,
                options,
                timeout_secs,
                line,
                find,
                multi,
                free_text,
                ..
            } => {
                assert_eq!(question, "Ship it?");
                assert_eq!(options, vec!["Yes".to_string(), "No".to_string()]);
                assert_eq!(timeout_secs, 300);
                assert_eq!(line, None);
                assert_eq!(find, None);
                assert!(!multi, "multi should default to false when omitted");
                assert!(!free_text, "free_text should default to false when omitted");
            }
            _ => panic!("expected Ask"),
        }
    }

    #[test]
    fn parses_ask_with_multi_true() {
        let req = parse_request(
            r#"{"v":1,"cmd":"ask","path":"/a.md","question":"Which?","options":["A","B"],"multi":true}"#,
        )
        .unwrap();
        match req {
            AiRequest::Ask { multi, .. } => assert!(multi),
            _ => panic!("expected Ask"),
        }
    }

    #[test]
    fn parses_ask_with_free_text_true() {
        let req = parse_request(
            r#"{"v":1,"cmd":"ask","path":"/a.md","question":"Which?","options":["A","B"],"free_text":true}"#,
        )
        .unwrap();
        match req {
            AiRequest::Ask { free_text, .. } => assert!(free_text),
            _ => panic!("expected Ask"),
        }
    }

    #[test]
    fn parses_ask_with_explicit_timeout_and_options() {
        let req = parse_request(
            r#"{"v":1,"cmd":"ask","path":"/a.md","question":"Which?","options":["A","B","C"],"timeout_secs":60}"#,
        )
        .unwrap();
        match req {
            AiRequest::Ask {
                options,
                timeout_secs,
                ..
            } => {
                assert_eq!(options, vec!["A".to_string(), "B".to_string(), "C".to_string()]);
                assert_eq!(timeout_secs, 60);
            }
            _ => panic!("expected Ask"),
        }
    }

    #[test]
    fn clamp_ask_timeout_clamps_below_and_above_bounds() {
        assert_eq!(clamp_ask_timeout(5), 10);
        assert_eq!(clamp_ask_timeout(7200), 3600);
        assert_eq!(clamp_ask_timeout(60), 60);
    }

    #[test]
    fn validate_ask_rejects_one_option() {
        let err = validate_ask("Ship it?", &["Yes".to_string()]).unwrap_err();
        assert!(err.contains("between 2 and 6"));
    }

    #[test]
    fn validate_ask_rejects_seven_options() {
        let options: Vec<String> = (0..7).map(|n| n.to_string()).collect();
        let err = validate_ask("Ship it?", &options).unwrap_err();
        assert!(err.contains("between 2 and 6"));
    }

    #[test]
    fn validate_ask_rejects_empty_question() {
        let err = validate_ask("  ", &["Yes".to_string(), "No".to_string()]).unwrap_err();
        assert!(err.contains("question"));
    }

    #[test]
    fn validate_ask_rejects_empty_option() {
        let err = validate_ask("Ship it?", &["Yes".to_string(), "  ".to_string()]).unwrap_err();
        assert!(err.contains("options"));
    }

    #[test]
    fn validate_ask_accepts_valid_input() {
        assert!(validate_ask("Ship it?", &["Yes".to_string(), "No".to_string()]).is_ok());
    }

    #[test]
    fn malformed_line_yields_error_response() {
        assert!(parse_request("not json").is_err());

        let resp = AiResponse::error("boom");
        let json = serde_json::to_string(&resp).unwrap();
        assert_eq!(json, r#"{"ok":false,"error":"boom"}"#);
        assert!(!json.contains("changed_lines"));
    }

    #[test]
    fn ai_response_custom_only_round_trips() {
        let resp = AiResponse {
            ok: true,
            custom: Some("Something else".to_string()),
            ..Default::default()
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert_eq!(json, r#"{"ok":true,"custom":"Something else"}"#);
        assert!(!json.contains("\"answer\""));
        assert!(!json.contains("\"answers\""));

        let round_tripped: AiResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(round_tripped.custom.as_deref(), Some("Something else"));
        assert_eq!(round_tripped.answer, None);
        assert_eq!(round_tripped.answers, None);
    }

    #[test]
    fn ai_response_answers_and_custom_round_trip_together() {
        let resp = AiResponse {
            ok: true,
            answers: Some(vec!["A".to_string()]),
            custom: Some("and also this".to_string()),
            ..Default::default()
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert_eq!(json, r#"{"ok":true,"answers":["A"],"custom":"and also this"}"#);

        let round_tripped: AiResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(round_tripped.answers, Some(vec!["A".to_string()]));
        assert_eq!(round_tripped.custom.as_deref(), Some("and also this"));
    }

    #[test]
    fn ai_response_answer_only_shape_is_unchanged_by_custom_field() {
        // Single-choice ask, no free text offered/typed — `custom` stays
        // absent from the wire, exactly as before this field was added.
        let json = r#"{"ok":true,"answer":"Yes"}"#;
        let resp: AiResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.answer.as_deref(), Some("Yes"));
        assert_eq!(resp.custom, None);
        assert_eq!(resp.answers, None);

        let re_serialized = serde_json::to_string(&resp).unwrap();
        assert_eq!(re_serialized, json);
    }

    fn test_payload(cmd: &str) -> AiCommandPayload {
        AiCommandPayload {
            id: 1,
            cmd: cmd.to_string(),
            path: "/a.md".to_string(),
            line: None,
            find: None,
            content: None,
            show: false,
            question: None,
            options: Vec::new(),
            timeout_secs: 0,
            multi: false,
            free_text: false,
            first_use: false,
            focus: false,
            transient: false,
            fresh: false,
        }
    }

    #[test]
    fn a_show_without_the_tab_fields_keeps_todays_behaviour() {
        let req = parse_request(r#"{"v":1,"cmd":"show","path":"/a.md","line":3,"find":null}"#).unwrap();
        match &req {
            AiRequest::Show { window_binding, focus, transient, .. } => {
                assert_eq!(*window_binding, None);
                assert_eq!(*focus, None);
                assert!(!transient);
            }
            _ => panic!("expected Show"),
        }
        assert!(req.focus(), "an old show still takes the view");
        assert!(!req.transient());
    }

    #[test]
    fn edit_and_ask_without_the_tab_fields_parse_and_never_take_the_view() {
        let edit = parse_request(r#"{"v":1,"cmd":"edit","path":"/a.md","content":"x"}"#).unwrap();
        let ask = parse_request(
            r#"{"v":1,"cmd":"ask","path":"/a.md","question":"Q?","options":["A","B"]}"#,
        )
        .unwrap();
        for req in [&edit, &ask] {
            assert!(!req.focus(), "edit and ask never switch tabs");
            assert!(!req.transient());
        }
    }

    #[test]
    fn the_tab_fields_parse() {
        let req = parse_request(
            r#"{"v":1,"cmd":"show","path":"/a.md","window_binding":7,"focus":false,"transient":true}"#,
        )
        .unwrap();
        match &req {
            AiRequest::Show { window_binding, .. } => assert_eq!(*window_binding, Some(7)),
            _ => panic!("expected Show"),
        }
        assert!(!req.focus());
        assert!(req.transient());
    }

    #[test]
    fn an_old_style_request_serializes_exactly_as_before() {
        let req = AiRequest::Show {
            v: 1,
            path: "/a.md".to_string(),
            line: Some(3),
            find: None,
            window_binding: None,
            focus: None,
            transient: false,
        };
        assert_eq!(
            serde_json::to_string(&req).unwrap(),
            r#"{"cmd":"show","v":1,"path":"/a.md","line":3,"find":null}"#
        );
    }

    #[test]
    fn a_response_without_window_or_focused_serializes_as_before() {
        assert_eq!(serde_json::to_string(&AiResponse::ok()).unwrap(), r#"{"ok":true}"#);
        let r = AiResponse { ok: true, window: Some(7), focused: Some(false), ..Default::default() };
        assert_eq!(serde_json::to_string(&r).unwrap(), r#"{"ok":true,"window":7,"focused":false}"#);
    }

    #[test]
    fn the_payload_carries_focus_and_transient_for_the_frontend() {
        let show = parse_request(r#"{"v":1,"cmd":"show","path":"/a.md","transient":true}"#).unwrap();
        let p = payload_for(&show, 9, false);
        assert_eq!((p.id, p.cmd.as_str(), p.focus, p.transient, p.fresh), (9, "show", true, true, false));
        let json = serde_json::to_string(&p).unwrap();
        for key in [r#""focus":true"#, r#""transient":true"#, r#""fresh":false"#] {
            assert!(json.contains(key), "{key} missing in {json}");
        }
        let ask = parse_request(
            r#"{"v":1,"cmd":"ask","path":"/a.md","question":"Q?","options":["A","B"],"timeout_secs":5}"#,
        )
        .unwrap();
        let p = payload_for(&ask, 1, false);
        assert_eq!((p.cmd.as_str(), p.focus, p.timeout_secs), ("ask", false, 10), "timeout clamped");
    }

    #[test]
    fn only_a_tab_opened_for_the_command_is_fresh() {
        let show = parse_request(r#"{"v":1,"cmd":"show","path":"/a.md","transient":true}"#).unwrap();
        let mut p = payload_for(&show, 1, false);
        assert_eq!(land_on(window::Opened::Existing("main".to_string()), &mut p), "main");
        assert!(!p.fresh, "the file was open already: the human's tab never becomes a quick look");
        assert_eq!(land_on(window::Opened::Created("editor-4".to_string()), &mut p), "editor-4");
        assert!(p.fresh);
    }

    #[test]
    fn an_abandoned_open_never_starts() {
        let ticket = OpenTicket::new();
        assert!(ticket.abandon());
        assert!(!ticket.start(), "the agent was told it failed: no window is built after all");
    }

    #[test]
    fn a_started_open_cannot_be_abandoned() {
        let ticket = OpenTicket::new();
        assert!(ticket.start());
        assert!(!ticket.abandon(), "the wait goes on for the window being built");
        assert!(!ticket.start(), "it starts once");
    }

    #[test]
    fn an_answer_is_taken_only_from_the_window_the_request_went_to() {
        let pending = AiPending::new();
        let (id, rx) = waiting(&pending, "editor-2", Some("/a.md"));
        assert!(pending.respond_from(id, "editor-3", AiResponse::ok()).is_err());
        assert!(pending.is_pending(id), "a refused answer leaves the request waiting");
        assert!(rx.try_recv().is_err());
        pending.respond_from(id, "editor-2", AiResponse::ok()).unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap().ok);
        assert!(
            pending.respond_from(id, "editor-2", AiResponse::ok()).is_ok(),
            "an answer after the request is gone is a harmless no-op"
        );
    }

    #[test]
    fn the_window_number_in_an_answer_always_comes_from_the_registry() {
        let mut reg = crate::tabs::TabRegistry::new();
        reg.set_number("editor-2", Some(4));
        reg.set_number("editor-3", None);
        let mut numbered = AiResponse { ok: true, window: Some(99), ..Default::default() };
        stamp_window(&reg, "editor-2", &mut numbered);
        assert_eq!(numbered.window, Some(4), "a frontend-supplied number is replaced");
        let mut unnumbered = AiResponse { ok: true, window: Some(99), ..Default::default() };
        stamp_window(&reg, "editor-3", &mut unnumbered);
        assert_eq!(unnumbered.window, None, "a window without a number answers none");
    }

    #[test]
    fn an_ask_parked_in_a_background_tab_is_answered_by_its_window_later() {
        // Nothing about a tab going to the background touches `AiPending`: the
        // entry waits until its window answers, however many switches later.
        let pending = AiPending::new();
        let (id, rx) = waiting(&pending, "editor-2", Some("/b.md"));
        pending.cancel_for_window_and_path("editor-2", "/a.md", "tab closed");
        assert!(pending.is_pending(id), "another tab closing leaves it alone");
        let answer = AiResponse { ok: true, answer: Some("Yes".to_string()), ..Default::default() };
        pending.respond_from(id, "editor-2", answer).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap().answer.as_deref(), Some("Yes"));
    }

    #[test]
    fn a_parked_ask_fails_clearly_when_its_tab_or_its_window_closes() {
        let pending = AiPending::new();
        let (_, tab_rx) = waiting(&pending, "editor-2", Some("/b.md"));
        let (_, window_rx) = waiting(&pending, "editor-3", Some("/c.md"));
        pending.cancel_for_window_and_path("editor-2", "/b.md", "tab closed");
        pending.cancel_for_window("editor-3");
        assert_eq!(tab_rx.recv_timeout(Duration::from_secs(1)).unwrap().error.as_deref(), Some("tab closed"));
        assert_eq!(
            window_rx.recv_timeout(Duration::from_secs(1)).unwrap().error.as_deref(),
            Some("window closed")
        );
    }

    #[test]
    fn a_command_for_an_unmounted_window_waits_in_the_queue() {
        let mut reg = crate::tabs::TabRegistry::new();
        reg.add_tab("editor-3", "t", Some("/tmp/a.md".to_string()));
        let queue = AiQueue::new();
        assert!(matches!(
            queue_unless_mounted(&reg, &queue, "editor-3", test_payload("show")),
            Delivery::Queued
        ));
        assert_eq!(queue.pull("editor-3").len(), 1, "pulled after get_window_init");
    }

    #[test]
    fn a_command_for_a_mounted_window_is_emitted_never_queued() {
        let mut reg = crate::tabs::TabRegistry::new();
        reg.add_tab("editor-3", "t", Some("/tmp/a.md".to_string()));
        reg.mark_mounted("editor-3");
        let queue = AiQueue::new();
        match queue_unless_mounted(&reg, &queue, "editor-3", test_payload("edit")) {
            Delivery::Emit(p) => assert_eq!(p.cmd, "edit"),
            other => panic!("expected Emit, got {other:?}"),
        }
        assert!(queue.pull("editor-3").is_empty(), "a queue nobody pulls again");
    }

    #[test]
    fn a_command_for_a_window_no_longer_registered_is_not_queued() {
        let reg = crate::tabs::TabRegistry::new();
        let queue = AiQueue::new();
        assert!(matches!(
            queue_unless_mounted(&reg, &queue, "editor-3", test_payload("ask")),
            Delivery::Gone
        ));
        assert!(queue.pull("editor-3").is_empty());
    }

    #[test]
    fn pending_queue_drains_once() {
        let queue = AiQueue::new();
        queue.push("editor-3", test_payload("show"));
        queue.push("editor-3", test_payload("edit"));

        let drained = queue.pull("editor-3");
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].cmd, "show");
        assert_eq!(drained[1].cmd, "edit");

        assert!(queue.pull("editor-3").is_empty());
    }

    /// Register a waiting request for `label`/`path`, returning its id and receiver.
    fn waiting(
        pending: &AiPending,
        label: &str,
        path: Option<&str>,
    ) -> (u64, mpsc::Receiver<AiResponse>) {
        let (tx, rx) = mpsc::channel();
        let id = pending.alloc_id();
        pending.register(id, label, path.map(str::to_string), tx);
        (id, rx)
    }

    #[test]
    fn respond_routes_to_waiting_request() {
        let pending = AiPending::new();
        let (id, rx) = waiting(&pending, "editor-1", Some("/a.md"));
        pending.respond(id, AiResponse::ok());
        assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap().ok);
        assert_eq!(pending.len(), 0);
        // Unknown id is a no-op — must not panic or block.
        pending.respond(9999, AiResponse::error("ignored"));
    }

    #[test]
    fn is_pending_until_answered_cancelled_or_given_up_on() {
        let pending = AiPending::new();
        let (answered, _rx1) = waiting(&pending, "editor-1", Some("/a.md"));
        let (cancelled, _rx2) = waiting(&pending, "editor-1", Some("/b.md"));
        let (timed_out, _rx3) = waiting(&pending, "editor-1", Some("/c.md"));
        assert!(pending.is_pending(answered));
        assert!(!pending.is_pending(9999), "an id nobody registered");

        pending.respond(answered, AiResponse::ok());
        pending.cancel_for_window_and_path("editor-1", "/b.md", "switched away from this document");
        pending.cancel(timed_out);

        assert!(!pending.is_pending(answered));
        assert!(!pending.is_pending(cancelled));
        assert!(!pending.is_pending(timed_out));
    }

    #[test]
    fn cancel_for_window_fails_that_windows_entries_only() {
        let pending = AiPending::new();
        let (_, rx_a) = waiting(&pending, "editor-1", Some("/a.md"));
        let (_, rx_b) = waiting(&pending, "editor-2", Some("/a.md"));
        pending.cancel_for_window("editor-1");
        let a = rx_a.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(a.error.as_deref(), Some("window closed"));
        assert!(rx_b.try_recv().is_err());
        assert_eq!(pending.len(), 1);
        pending.cancel_for_window("no-such-window");
    }

    #[test]
    fn cancel_for_window_and_path_fails_only_the_matching_document() {
        let pending = AiPending::new();
        let (_, rx_a) = waiting(&pending, "editor-1", Some("/tmp/a.md"));
        let (_, rx_b) = waiting(&pending, "editor-1", Some("/tmp/b.md"));
        let (_, rx_other) = waiting(&pending, "editor-2", Some("/tmp/a.md"));
        let (_, rx_none) = waiting(&pending, "editor-1", None);

        pending.cancel_for_window_and_path("editor-1", "/tmp/a.md", "tab closed");

        let a = rx_a.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(a.error.as_deref(), Some("tab closed"));
        assert!(rx_b.try_recv().is_err(), "another document in the same window");
        assert!(rx_other.try_recv().is_err(), "the same path in another window");
        assert!(rx_none.try_recv().is_err(), "an entry without a path is never matched");
        assert_eq!(pending.len(), 3);
    }

    #[test]
    fn relabel_hands_a_moved_documents_agents_to_the_target_window() {
        let pending = AiPending::new();
        let (moved, rx) = waiting(&pending, "main", Some("/a.md"));
        let (_other_doc, _rx2) = waiting(&pending, "main", Some("/b.md"));
        assert_eq!(pending.relabel("main", "editor-2", "/a.md"), 1);
        assert!(
            pending.respond_from(moved, "main", AiResponse::ok()).is_err(),
            "the old window no longer answers it"
        );
        pending.cancel_for_window("main");
        assert!(pending.is_pending(moved), "closing the old window does not fail it");
        pending.respond_from(moved, "editor-2", AiResponse::ok()).unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap().ok);
    }

    #[test]
    fn relabel_leaves_other_windows_and_pathless_requests_alone() {
        let pending = AiPending::new();
        let (elsewhere, _r1) = waiting(&pending, "editor-3", Some("/a.md"));
        let (pathless, _r2) = waiting(&pending, "main", None);
        assert_eq!(pending.relabel("main", "editor-2", "/a.md"), 0);
        assert_eq!(pending.label_of(elsewhere).as_deref(), Some("editor-3"));
        assert_eq!(pending.label_of(pathless).as_deref(), Some("main"), "a close request has no document to follow");
    }

    #[test]
    fn queue_drop_for_removes_only_that_windows_payloads_for_that_path() {
        let queue = AiQueue::new();
        let mut a = test_payload("edit");
        a.id = 1;
        let mut b = test_payload("show");
        b.id = 2;
        b.path = "/b.md".to_string();
        queue.push("editor-3", a);
        queue.push("editor-3", b);
        queue.push("editor-4", test_payload("show"));

        let dropped = queue.drop_for("editor-3", "/a.md");
        assert_eq!(dropped.iter().map(|p| p.id).collect::<Vec<_>>(), vec![1]);
        assert_eq!(queue.pull("editor-3").iter().map(|p| p.id).collect::<Vec<_>>(), vec![2]);
        assert_eq!(queue.pull("editor-4").len(), 1);
    }

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn ai_cli_args_show_with_line() {
        let parsed = parse_cli_args(&args(&["show", "/a.md", "--line", "42"])).unwrap();
        assert_eq!(parsed.path, "/a.md");
        assert_eq!(parsed.socket, None);
        match parsed.verb {
            CliVerb::Show { line, find, .. } => {
                assert_eq!(line, Some(42));
                assert_eq!(find, None);
            }
            _ => panic!("expected Show"),
        }
    }

    #[test]
    fn ai_cli_args_show_with_find_and_socket() {
        let parsed = parse_cli_args(&args(&[
            "show",
            "/a.md",
            "--find",
            "hello world",
            "--socket",
            "/tmp/custom.sock",
        ]))
        .unwrap();
        assert_eq!(parsed.socket, Some("/tmp/custom.sock".to_string()));
        match parsed.verb {
            CliVerb::Show { line, find, .. } => {
                assert_eq!(line, None);
                assert_eq!(find, Some("hello world".to_string()));
            }
            _ => panic!("expected Show"),
        }
    }

    #[test]
    fn ai_cli_args_show_line_and_find_conflict() {
        let err = parse_cli_args(&args(&["show", "/a.md", "--line", "1", "--find", "x"]))
            .unwrap_err();
        assert!(err.contains("mutually exclusive"));
    }

    #[test]
    fn ai_cli_args_edit_reads_flags() {
        let parsed = parse_cli_args(&args(&[
            "edit",
            "/a.md",
            "--show",
            "--allow-empty",
            "--socket",
            "/tmp/s.sock",
        ]))
        .unwrap();
        assert_eq!(parsed.path, "/a.md");
        assert_eq!(parsed.socket, Some("/tmp/s.sock".to_string()));
        match parsed.verb {
            CliVerb::Edit { show, allow_empty, .. } => {
                assert!(show);
                assert!(allow_empty);
            }
            _ => panic!("expected Edit"),
        }
    }

    #[test]
    fn ai_cli_args_edit_defaults_show_and_allow_empty_false() {
        let parsed = parse_cli_args(&args(&["edit", "/a.md"])).unwrap();
        match parsed.verb {
            CliVerb::Edit { show, allow_empty, .. } => {
                assert!(!show);
                assert!(!allow_empty);
            }
            _ => panic!("expected Edit"),
        }
    }

    #[test]
    fn ai_cli_args_ask_happy_path() {
        let parsed = parse_cli_args(&args(&[
            "ask",
            "/a.md",
            "--question",
            "Ship it?",
            "--option",
            "Yes",
            "--option",
            "No",
            "--option",
            "Later",
            "--at-line",
            "5",
            "--timeout",
            "60",
            "--socket",
            "/tmp/s.sock",
        ]))
        .unwrap();
        assert_eq!(parsed.path, "/a.md");
        assert_eq!(parsed.socket, Some("/tmp/s.sock".to_string()));
        match parsed.verb {
            CliVerb::Ask {
                question,
                options,
                line,
                find,
                timeout_secs,
                multi,
                free_text,
                ..
            } => {
                assert_eq!(question, "Ship it?");
                assert_eq!(
                    options,
                    vec!["Yes".to_string(), "No".to_string(), "Later".to_string()]
                );
                assert_eq!(line, Some(5));
                assert_eq!(find, None);
                assert_eq!(timeout_secs, 60);
                assert!(!multi, "--multi not passed, should default to false");
                assert!(!free_text, "--free-text not passed, should default to false");
            }
            _ => panic!("expected Ask"),
        }
    }

    #[test]
    fn ai_cli_args_ask_multi_flag_parses() {
        let parsed = parse_cli_args(&args(&[
            "ask",
            "/a.md",
            "--question",
            "Which reviewers?",
            "--option",
            "A",
            "--option",
            "B",
            "--multi",
        ]))
        .unwrap();
        match parsed.verb {
            CliVerb::Ask { multi, .. } => assert!(multi),
            _ => panic!("expected Ask"),
        }
    }

    #[test]
    fn ai_cli_args_ask_free_text_flag_parses() {
        let parsed = parse_cli_args(&args(&[
            "ask",
            "/a.md",
            "--question",
            "Ship it?",
            "--option",
            "Yes",
            "--option",
            "No",
            "--free-text",
        ]))
        .unwrap();
        match parsed.verb {
            CliVerb::Ask { free_text, .. } => assert!(free_text),
            _ => panic!("expected Ask"),
        }
    }

    #[test]
    fn ai_cli_args_ask_clamps_timeout() {
        let parsed = parse_cli_args(&args(&[
            "ask",
            "/a.md",
            "--question",
            "Ship it?",
            "--option",
            "Yes",
            "--option",
            "No",
            "--timeout",
            "5",
        ]))
        .unwrap();
        match parsed.verb {
            CliVerb::Ask { timeout_secs, .. } => assert_eq!(timeout_secs, 10),
            _ => panic!("expected Ask"),
        }
    }

    #[test]
    fn ai_cli_args_ask_missing_question_errors() {
        let err = parse_cli_args(&args(&[
            "ask", "/a.md", "--option", "Yes", "--option", "No",
        ]))
        .unwrap_err();
        assert!(err.contains("--question is required"));
    }

    #[test]
    fn ai_cli_args_ask_one_option_errors() {
        let err = parse_cli_args(&args(&[
            "ask",
            "/a.md",
            "--question",
            "Ship it?",
            "--option",
            "Yes",
        ]))
        .unwrap_err();
        assert!(err.contains("between 2 and 6"));
    }

    #[test]
    fn ai_cli_args_ask_at_line_and_at_find_conflict() {
        let err = parse_cli_args(&args(&[
            "ask",
            "/a.md",
            "--question",
            "Ship it?",
            "--option",
            "Yes",
            "--option",
            "No",
            "--at-line",
            "1",
            "--at-find",
            "x",
        ]))
        .unwrap_err();
        assert!(err.contains("mutually exclusive"));
    }

    #[test]
    fn ai_cli_args_help_parses() {
        let parsed = parse_cli_args(&args(&["help"])).unwrap();
        assert_eq!(parsed.verb, CliVerb::Help);
    }

    #[test]
    fn ai_cli_args_agent_parses() {
        let parsed = parse_cli_args(&args(&["agent"])).unwrap();
        assert_eq!(parsed.verb, CliVerb::Agent { mcp: false });
    }

    #[test]
    fn ai_cli_args_agent_mcp_flag_parses() {
        let parsed = parse_cli_args(&args(&["agent", "--mcp"])).unwrap();
        assert_eq!(parsed.verb, CliVerb::Agent { mcp: true });
    }

    #[test]
    fn ai_cli_args_help_rejects_extra_args() {
        let err = parse_cli_args(&args(&["help", "extra"])).unwrap_err();
        assert!(err.contains("takes no arguments"));
    }

    #[test]
    fn ai_cli_args_agent_rejects_extra_args() {
        let err = parse_cli_args(&args(&["agent", "--socket", "/tmp/s.sock"])).unwrap_err();
        assert!(err.contains("takes no arguments"));
    }

    #[test]
    fn ai_cli_args_agent_mcp_rejects_further_extra_args() {
        // --mcp is the only flag agent accepts; anything after it (or instead
        // of it) is still an error, same as before --mcp existed.
        let err = parse_cli_args(&args(&["agent", "--mcp", "extra"])).unwrap_err();
        assert!(err.contains("takes no arguments"));
    }

    #[test]
    fn help_text_mentions_all_verbs() {
        let text = help_text();
        for verb in [
            "show", "edit", "ask", "question", "answer", "watch", "mcp", "help", "agent",
        ] {
            assert!(text.contains(verb), "help text missing verb: {}", verb);
        }
        assert!(text.contains("--line"));
        assert!(text.contains("--find"));
        assert!(text.contains("--show"));
        assert!(text.contains("--allow-empty"));
        assert!(text.contains("--socket"));
        assert!(text.contains("--question"));
        assert!(text.contains("--option"));
        assert!(text.contains("--at-line"));
        assert!(text.contains("--at-find"));
        assert!(text.contains("--timeout"));
        assert!(text.contains("--multi"));
        assert!(text.contains("\"answers\""));
        assert!(text.contains("--free-text"));
        assert!(text.contains("\"custom\""));
        assert!(text.contains("--mcp"));
        assert!(text.contains("--id"));
        for flag in ["-t N", "--background", "--focus", "--transient", "mdmini ls", "mdmini close", "CLAUDECODE", "\"window\""] {
            assert!(text.contains(flag), "help text missing {flag}");
        }
        // The three comment verbs are useless to an agent that doesn't learn
        // they work with the app closed, and Monitor is useless without the
        // flag — so the help text is asserted to say both.
        assert!(text.contains(".mdmini_comments_"));
        assert!(text.contains("persistent: true"));
    }

    #[test]
    fn agent_text_contains_instruction_file_names_and_heading() {
        let text = agent_text();
        assert!(text.contains("CLAUDE.md"));
        assert!(text.contains("AGENTS.md"));
        assert!(text.contains("## md-mini AI interface"));
        assert!(text.contains("--mcp"), "should point at agent --mcp for MCP setups");
        for needle in ["-t 7", "mdmini ls", "mdmini close", "--transient", "\"focused\":false"] {
            assert!(text.contains(needle), "agent snippet missing {needle}");
        }
    }

    #[test]
    fn mcp_agent_text_contains_behavioral_snippet_and_locations() {
        let text = mcp_agent_text();
        assert!(text.contains("CLAUDE.md"));
        assert!(text.contains("AGENTS.md"));
        assert!(text.contains("## md-mini via MCP"));
        assert!(text.contains("MCP"));
        assert!(text.contains("`show`"));
        assert!(text.contains("`ask`"));
        assert!(text.contains("`edit`"));
        assert!(text.contains("multi"));
        assert!(text.contains("free_text"));
        // This is a behavioral snippet, not CLI syntax — it should not carry
        // the `mdmini ask <file> --question ...` shell-command shape.
        assert!(!text.contains("mdmini ask <file>"));
        for needle in ["window_binding", "`windows`", "`close`", "transient", "focused: false"] {
            assert!(text.contains(needle), "MCP snippet missing {needle}");
        }
    }

    #[test]
    fn ai_cli_args_unknown_verb_errors() {
        let err = parse_cli_args(&args(&["delete", "/a.md"])).unwrap_err();
        assert!(err.contains("unknown command"));
    }

    #[test]
    fn ai_cli_args_missing_file_errors() {
        assert!(parse_cli_args(&args(&["show"])).is_err());
        assert!(parse_cli_args(&args(&[])).is_err());
    }

    #[test]
    fn ai_cli_args_unknown_flag_errors() {
        let err = parse_cli_args(&args(&["show", "/a.md", "--bogus"])).unwrap_err();
        assert!(err.contains("unknown flag"));
    }

    #[test]
    fn print_response_and_exit_code_matches_ok_field() {
        assert_eq!(print_response_and_exit_code(r#"{"ok":true}"#), 0);
        assert_eq!(
            print_response_and_exit_code(r#"{"ok":false,"error":"boom"}"#),
            1
        );
        // Malformed JSON also falls through to the non-zero exit path.
        assert_eq!(print_response_and_exit_code("not json"), 1);
    }

    #[test]
    fn refuse_empty_edit_blocks_empty_content_without_flag() {
        let resp = refuse_empty_edit("", false).expect("should refuse");
        assert!(!resp.ok);
        assert_eq!(
            resp.error.as_deref(),
            Some("refusing to apply empty content (use --allow-empty)")
        );
    }

    #[test]
    fn refuse_empty_edit_allows_empty_content_with_flag() {
        assert!(refuse_empty_edit("", true).is_none());
    }

    #[test]
    fn refuse_empty_edit_allows_nonempty_content_regardless_of_flag() {
        assert!(refuse_empty_edit("hello", false).is_none());
        assert!(refuse_empty_edit("hello", true).is_none());
    }

    #[test]
    fn cancel_makes_a_later_respond_a_noop() {
        let pending = AiPending::new();
        let (tx, rx) = mpsc::channel();
        let id = pending.alloc_id();
        pending.register(id, "editor-1", None, tx);

        pending.cancel(id);
        assert_eq!(pending.len(), 0);
        // A response that arrives after the caller gave up must not be
        // delivered — the receiver should see nothing, ever.
        pending.respond(id, AiResponse::ok());
        assert!(rx.try_recv().is_err());

        // Cancelling twice, or an id that was never registered, must not panic.
        pending.cancel(id);
        pending.cancel(9999);
    }

    #[test]
    fn parses_question_with_optional_path() {
        let args = vec!["question".to_string(), "/repo/spec.md".to_string()];
        let parsed = parse_cli_args(&args).unwrap();
        assert_eq!(parsed.verb, CliVerb::Question);
        assert_eq!(parsed.path, "/repo/spec.md");
    }

    #[test]
    fn parses_question_without_path() {
        let args = vec!["question".to_string()];
        let parsed = parse_cli_args(&args).unwrap();
        assert_eq!(parsed.verb, CliVerb::Question);
        assert_eq!(parsed.path, "");
    }

    #[test]
    fn parses_watch_with_optional_dir() {
        let args = vec!["watch".to_string(), "/repo".to_string()];
        let parsed = parse_cli_args(&args).unwrap();
        assert_eq!(parsed.verb, CliVerb::Watch);
        assert_eq!(parsed.path, "/repo");
    }

    #[test]
    fn question_rejects_a_second_positional_argument() {
        let args = vec![
            "question".to_string(),
            "/repo/spec.md".to_string(),
            "extra".to_string(),
        ];
        assert!(parse_cli_args(&args).is_err());
    }

    #[test]
    fn parses_answer_with_id() {
        let args = vec![
            "answer".to_string(),
            "/repo/spec.md".to_string(),
            "--id".to_string(),
            "c-7f3a2c".to_string(),
        ];
        let parsed = parse_cli_args(&args).unwrap();
        assert_eq!(
            parsed.verb,
            CliVerb::Answer {
                id: "c-7f3a2c".to_string()
            }
        );
    }

    #[test]
    fn answer_without_id_is_a_usage_error() {
        let args = vec!["answer".to_string(), "/repo/spec.md".to_string()];
        assert!(parse_cli_args(&args).is_err());
    }

    #[test]
    fn ai_cli_args_open_takes_files_and_flags() {
        let parsed = parse_cli_args(&args(&["open", "a.md", "b.md", "-t", "7", "-b", "--socket", "/s.sock"])).unwrap();
        assert_eq!(parsed.socket.as_deref(), Some("/s.sock"));
        assert_eq!(
            parsed.verb,
            CliVerb::Open { paths: vec!["a.md".to_string(), "b.md".to_string()], window: Some(7), focus: Some(false) }
        );
        let plain = parse_cli_args(&args(&["open", "a.md", "--focus"])).unwrap();
        assert_eq!(plain.verb, CliVerb::Open { paths: vec!["a.md".to_string()], window: None, focus: Some(true) });
    }

    #[test]
    fn ai_cli_args_open_needs_a_file_and_knows_its_flags() {
        assert!(parse_cli_args(&args(&["open", "-b"])).unwrap_err().contains("at least one file"));
        assert!(parse_cli_args(&args(&["open", "a.md", "--nope"])).unwrap_err().contains("unknown flag"));
    }

    #[test]
    fn ai_cli_args_background_and_focus_are_mutually_exclusive() {
        for verb in ["open", "show"] {
            let err = parse_cli_args(&args(&[verb, "a.md", "-b", "-f"])).unwrap_err();
            assert!(err.contains("mutually exclusive"), "{verb}: {err}");
        }
    }

    #[test]
    fn ai_cli_args_a_window_number_is_plain_digits_from_1() {
        for bad in ["0", "x", "#7", "-3"] {
            let err = parse_cli_args(&args(&["open", "a.md", "-t", bad])).unwrap_err();
            assert!(err.contains("invalid window number"), "{bad}: {err}");
        }
        assert!(parse_cli_args(&args(&["open", "a.md", "-t"])).unwrap_err().contains("-t requires"));
    }

    #[test]
    fn ai_cli_args_ls_parses_json_and_nothing_else() {
        assert_eq!(parse_cli_args(&args(&["ls"])).unwrap().verb, CliVerb::Ls { json: false });
        let parsed = parse_cli_args(&args(&["ls", "--json", "--socket", "/s.sock"])).unwrap();
        assert_eq!((parsed.verb, parsed.socket.as_deref()), (CliVerb::Ls { json: true }, Some("/s.sock")));
        assert!(parse_cli_args(&args(&["ls", "a.md"])).is_err());
    }

    #[test]
    fn ai_cli_args_close_needs_a_file() {
        let parsed = parse_cli_args(&args(&["close", "/a.md"])).unwrap();
        assert_eq!((parsed.path.as_str(), parsed.verb), ("/a.md", CliVerb::Close));
        assert!(parse_cli_args(&args(&["close"])).is_err());
    }

    #[test]
    fn ai_cli_args_show_takes_a_window_focus_and_transient() {
        let parsed = parse_cli_args(&args(&["show", "/a.md", "--line", "3", "-t", "4", "-b", "--transient"])).unwrap();
        assert_eq!(
            parsed.verb,
            CliVerb::Show { line: Some(3), find: None, window: Some(4), focus: Some(false), transient: true }
        );
    }

    #[test]
    fn ai_cli_args_edit_and_ask_take_a_window() {
        let edit = parse_cli_args(&args(&["edit", "/a.md", "--window", "2"])).unwrap();
        assert!(matches!(edit.verb, CliVerb::Edit { window: Some(2), .. }));
        let ask = parse_cli_args(&args(&["ask", "/a.md", "--question", "Q?", "--option", "A", "--option", "B", "-t", "5"])).unwrap();
        assert!(matches!(ask.verb, CliVerb::Ask { window: Some(5), .. }));
    }

    #[test]
    fn an_agent_is_whoever_has_claudecode_set() {
        assert!(!is_agent(None));
        assert!(!is_agent(Some("")));
        assert!(is_agent(Some("1")));
        assert!(is_agent(Some("yes")));
    }

    #[test]
    fn the_open_summary_names_the_first_window_and_every_tab() {
        let tabs = vec![
            OpenedTab { path: "/a.md".to_string(), window: Some(7), focused: false },
            OpenedTab { path: "/b.md".to_string(), window: Some(7), focused: false },
        ];
        let ok = open_summary(tabs.clone(), None);
        assert_eq!(
            serde_json::to_string(&ok).unwrap(),
            r#"{"ok":true,"window":7,"focused":false,"opened":[{"path":"/a.md","window":7,"focused":false},{"path":"/b.md","window":7,"focused":false}]}"#
        );
        let failed = open_summary(tabs, Some("no window #9".to_string()));
        assert!(!failed.ok);
        assert_eq!(failed.error.as_deref(), Some("no window #9"));
    }

    #[test]
    fn open_close_and_windows_requests_parse_with_their_defaults() {
        let open = parse_request(r#"{"v":1,"cmd":"open","path":"/a.md"}"#).unwrap();
        assert_eq!((open.focus(), open.window_binding(), open.path()), (false, None, "/a.md"));
        let open = parse_request(r#"{"v":1,"cmd":"open","path":"/a.md","window_binding":3,"focus":true}"#).unwrap();
        assert_eq!((open.focus(), open.window_binding()), (true, Some(3)));
        assert_eq!(payload_for(&open, 1, false).cmd, "open");
        let close = parse_request(r#"{"v":1,"cmd":"close","path":"/a.md"}"#).unwrap();
        assert_eq!((payload_for(&close, 2, false).cmd.as_str(), close.focus()), ("close", false));
        assert!(matches!(parse_request(r#"{"v":1,"cmd":"windows"}"#).unwrap(), AiRequest::Windows { .. }));
    }

    fn files(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("/nope-open/{i}.md")).collect()
    }

    fn opened_in_7() -> Result<String, (String, i32)> {
        Ok(r#"{"ok":true,"window":7,"focused":false}"#.to_string())
    }

    #[test]
    fn a_transport_failure_mid_list_keeps_what_opened_and_its_exit_code() {
        let mut calls = 0;
        let (summary, code) = open_all(&files(3), None, false, |_| {
            calls += 1;
            match calls {
                1 => opened_in_7(),
                _ => Err((r#"{"ok":false,"error":"md-mini is not running"}"#.to_string(), 2)),
            }
        });
        assert_eq!((calls, code), (2, 2), "stops at the failure, exits with the transport's code");
        assert!(!summary.ok);
        assert_eq!(summary.error.as_deref(), Some("md-mini is not running"));
        assert_eq!(summary.opened.unwrap().iter().map(|t| t.path.as_str()).collect::<Vec<_>>(), vec!["/nope-open/0.md"]);
        assert_eq!(summary.window, Some(7));
    }

    #[test]
    fn a_refused_file_is_reported_and_the_rest_still_open() {
        let mut calls = 0;
        let (summary, code) = open_all(&files(3), Some(7), true, |req| {
            calls += 1;
            assert!(matches!(req, AiRequest::Open { window_binding: Some(7), focus: true, .. }));
            if calls == 2 {
                Ok(r#"{"ok":false,"error":"could not read the file"}"#.to_string())
            } else {
                opened_in_7()
            }
        });
        assert_eq!((calls, code), (3, 1));
        assert_eq!(summary.error.as_deref(), Some("could not read the file"));
        assert_eq!(summary.opened.map(|o| o.len()), Some(2));
    }

    #[test]
    fn at_most_fifty_files_open_at_once() {
        let (summary, code) = open_all(&files(51), None, false, |_| panic!("nothing is sent"));
        assert_eq!(code, 2);
        assert_eq!(summary.error.as_deref(), Some("too many files: 51 (at most 50 at once)"));
        let (summary, code) = open_all(&files(50), None, false, |_| opened_in_7());
        assert_eq!((summary.ok, code), (true, 0));
    }

    #[test]
    fn a_request_path_must_be_absolute_and_comes_out_normalized() {
        for bad in ["", "a.md", "./a.md", "../a.md"] {
            assert_eq!(request_path(bad), Err("path must be absolute".to_string()), "{bad:?}");
        }
        assert_eq!(request_path("/nope-x/../nope-a.md").as_deref(), Ok("/nope-a.md"));
        assert_eq!(request_path("/nope-x/./nope-a.md").as_deref(), Ok("/nope-x/nope-a.md"));
    }

    #[test]
    fn every_path_carrying_request_is_normalized_and_windows_is_not() {
        let mut req = parse_request(r#"{"v":1,"cmd":"close","path":"/x/../a.md"}"#).unwrap();
        *req.path_mut().unwrap() = request_path(req.path()).unwrap();
        assert_eq!(req.path(), "/a.md");
        for line in [
            r#"{"v":1,"cmd":"show","path":"/a"}"#,
            r#"{"v":1,"cmd":"edit","path":"/a","content":""}"#,
            r#"{"v":1,"cmd":"ask","path":"/a","question":"Q","options":["A","B"]}"#,
            r#"{"v":1,"cmd":"open","path":"/a"}"#,
        ] {
            assert!(parse_request(line).unwrap().path_mut().is_some(), "{line}");
        }
        assert!(AiRequest::Windows { v: 1 }.path_mut().is_none());
    }

    #[test]
    fn a_stale_socket_file_is_not_running_exit_2() {
        // What `scripts/mdmini` probes with `ai ls --json` after a crash: the
        // file is there, nobody accepts on it.
        let path = std::env::temp_dir().join(format!("mdmini-stale-{}.sock", crate::session::new_tab_id()));
        drop(UnixListener::bind(&path).unwrap());
        assert!(path.exists());
        let (_, code) = exchange(&path, &AiRequest::Windows { v: 1 }).unwrap_err();
        let _ = std::fs::remove_file(&path);
        assert_eq!(code, 2);
    }

    #[test]
    fn exchange_reports_a_socket_nobody_listens_on_as_not_running() {
        let (line, code) = exchange(Path::new("/tmp/mdmini_test_nobody_listens.sock"), &AiRequest::Windows { v: 1 })
            .unwrap_err();
        assert_eq!(code, 2);
        assert_eq!(line, r#"{"ok":false,"error":"md-mini is not running"}"#);
    }
}
