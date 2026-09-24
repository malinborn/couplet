//! Command socket for driving the running app from the CLI (`mdmini show`/`edit`).
//!
//! A small JSON-lines protocol over a Unix domain socket: one request per line,
//! one response per line, connection stays usable across malformed lines. See
//! `docs/superpowers/specs/2026-08-22-ai-interface-design.md`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

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
    },
    Edit {
        #[allow(dead_code)] // protocol version, reserved for the future MCP wrapper
        v: u32,
        path: String,
        content: String,
        #[serde(default)]
        show: bool,
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
    },
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
}

impl AiResponse {
    // Counterpart to `error()` below — not called from non-test Rust yet: the
    // "ok" response for `edit`/`show` is built by the frontend and only
    // deserialized here via `ai_respond`. Kept public for symmetry and for the
    // CLI client (Task 5) to construct local responses with.
    #[allow(dead_code)]
    pub fn ok() -> Self {
        Self {
            ok: true,
            error: None,
            changed_lines: None,
            answer: None,
            answers: None,
            custom: None,
            threads: None,
        }
    }

    pub fn error(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(msg.into()),
            changed_lines: None,
            answer: None,
            answers: None,
            custom: None,
            threads: None,
        }
    }
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

    /// Remove a waiting request without delivering anything — used once the
    /// caller has already given up (the socket listener's own timeout), so a
    /// later `respond` for the same id finds nothing to deliver.
    pub fn cancel(&self, id: u64) {
        self.map.lock().unwrap().remove(&id);
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

    /// Fail every entry of `label` about `path` — the tab was switched away
    /// from or closed. An entry with no path is never matched.
    pub fn cancel_for_window_and_path(&self, label: &str, path: &str, error: &str) {
        self.fail_where(error, |e| e.label == label && e.path.as_deref() == Some(path));
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.map.lock().unwrap().len()
    }
}

/// Commands for windows created by an AI request, pulled by the frontend on mount.
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
    pub cmd: String, // "show" | "edit" | "ask"
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
}

/// How long to wait for `open_file_window` (run on the main thread) to register
/// the new window's label in `OpenFiles` before giving up on a freshly opened file.
const OPEN_WINDOW_TIMEOUT: Duration = Duration::from_secs(2);

/// Route a parsed request to the window that owns the file, opening one first if
/// it isn't open yet, and arrange for the response to come back on `tx`.
/// Returns the id registered for this request in `AiPending` — `0` (never a
/// real id, since `AiPending::next` starts at 1) if the request was answered
/// directly on `tx` without ever registering, so the caller's later
/// `AiPending::cancel(id)` on timeout is a harmless no-op.
fn dispatch(app: &AppHandle, req: AiRequest, tx: mpsc::Sender<AiResponse>) -> u64 {
    let path = match &req {
        AiRequest::Show { path, .. } => path.clone(),
        AiRequest::Edit { path, .. } => path.clone(),
        AiRequest::Ask { path, .. } => path.clone(),
    };

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
    let payload = AiCommandPayload {
        id,
        first_use,
        cmd: match &req {
            AiRequest::Show { .. } => "show".to_string(),
            AiRequest::Edit { .. } => "edit".to_string(),
            AiRequest::Ask { .. } => "ask".to_string(),
        },
        path: path.clone(),
        line: match &req {
            AiRequest::Show { line, .. } => *line,
            AiRequest::Edit { .. } => None,
            AiRequest::Ask { line, .. } => *line,
        },
        find: match &req {
            AiRequest::Show { find, .. } => find.clone(),
            AiRequest::Edit { .. } => None,
            AiRequest::Ask { find, .. } => find.clone(),
        },
        content: match &req {
            AiRequest::Show { .. } => None,
            AiRequest::Edit { content, .. } => Some(content.clone()),
            AiRequest::Ask { .. } => None,
        },
        show: match &req {
            AiRequest::Show { .. } => false,
            AiRequest::Edit { show, .. } => *show,
            AiRequest::Ask { .. } => false,
        },
        question: match &req {
            AiRequest::Ask { question, .. } => Some(question.clone()),
            _ => None,
        },
        options: match &req {
            AiRequest::Ask { options, .. } => options.clone(),
            _ => Vec::new(),
        },
        timeout_secs: match &req {
            AiRequest::Ask { timeout_secs, .. } => clamp_ask_timeout(*timeout_secs),
            _ => 0,
        },
        multi: match &req {
            AiRequest::Ask { multi, .. } => *multi,
            _ => false,
        },
        free_text: match &req {
            AiRequest::Ask { free_text, .. } => *free_text,
            _ => false,
        },
    };

    let existing_label = {
        let open_files = app.state::<window::OpenFiles>();
        let reg = open_files.0.lock().unwrap();
        reg.label_of(&path)
    };

    if let Some(label) = existing_label {
        if let Some(win) = app.get_webview_window(&label) {
            app.state::<AiPending>().register(id, label.clone(), Some(path.clone()), tx);
            // emit() broadcasts to every window — a window that does not own the
            // file would race to answer with an error. Target the owner only.
            if win.emit_to(label.as_str(), "ai-command", &payload).is_ok() {
                return id;
            }
            // Registered but never delivered — fail now instead of leaking
            // until the connection's own timeout.
            app.state::<AiPending>()
                .respond(id, AiResponse::error("failed to deliver to window"));
            return id;
        }
        // Label was in OpenFiles but the window is already gone (closed between
        // the lookup above and here) — fall through and open a fresh one.
    }

    // Not open yet. Window creation must happen on the main thread — this
    // listener runs on a background thread per connection.
    let handle = app.clone();
    let path_for_open = path.clone();
    if app
        .run_on_main_thread(move || window::open_file_window(&handle, Some(path_for_open)))
        .is_err()
    {
        let _ = tx.send(AiResponse::error("failed to open window for file"));
        return id;
    }

    // `open_file_window` registers the new label in `OpenFiles` synchronously,
    // but on the main thread — poll briefly from here rather than racing it.
    let deadline = Instant::now() + OPEN_WINDOW_TIMEOUT;
    loop {
        let label = {
            let open_files = app.state::<window::OpenFiles>();
            let reg = open_files.0.lock().unwrap();
            reg.label_of(&path)
        };
        if let Some(label) = label {
            app.state::<AiPending>().register(id, label.clone(), Some(path.clone()), tx);
            app.state::<AiQueue>().push(&label, payload);
            return id;
        }
        if Instant::now() >= deadline {
            let _ = tx.send(AiResponse::error("failed to open window for file"));
            return id;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// IPC command: deliver the frontend's answer to an AI command back to the CLI
/// connection waiting on it.
#[tauri::command]
pub async fn ai_respond(app: AppHandle, id: u64, response: AiResponse) -> Result<(), String> {
    app.state::<AiPending>().respond(id, response);
    Ok(())
}

/// IPC command: fail every `show`/`edit`/`ask` for `path` in the calling window — pending and queued — before the window stops showing it.
#[tauri::command]
pub async fn cancel_ai_ask(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<(), String> {
    cancel_for_tab(&app, window.label(), &path, "switched away from this document");
    Ok(())
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
    },
    Edit {
        show: bool,
        allow_empty: bool,
    },
    Ask {
        question: String,
        options: Vec<String>,
        line: Option<usize>,
        find: Option<String>,
        timeout_secs: u64,
        multi: bool,
        free_text: bool,
    },
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

const USAGE: &str = "usage: mdmini ai show <file> [--line N | --find TEXT] [--socket PATH]\n       mdmini ai edit <file> [--show] [--allow-empty] [--socket PATH]\n       mdmini ai ask <file> --question TEXT --option TEXT [--option TEXT ...] [--multi] [--free-text] [--at-line N | --at-find TEXT] [--timeout SECS] [--socket PATH]\n       mdmini ai help\n       mdmini ai agent [--mcp]\n       mdmini ai question [<file>]\n       mdmini ai answer <file> --id ID\n       mdmini ai watch [<dir>]";

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

    let path = iter.next().ok_or_else(|| USAGE.to_string())?.clone();
    let mut socket: Option<String> = None;

    match verb.as_str() {
        "show" => {
            let mut line: Option<usize> = None;
            let mut find: Option<String> = None;
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
                verb: CliVerb::Show { line, find },
                socket,
            })
        }
        "edit" => {
            let mut show = false;
            let mut allow_empty = false;
            while let Some(arg) = iter.next() {
                match arg.as_str() {
                    "--show" => show = true,
                    "--allow-empty" => allow_empty = true,
                    "--socket" => {
                        let v = iter.next().ok_or("--socket requires a value")?;
                        socket = Some(v.clone());
                    }
                    other => return Err(format!("unknown flag: {}", other)),
                }
            }
            Ok(CliArgs {
                path,
                verb: CliVerb::Edit { show, allow_empty },
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
            while let Some(arg) = iter.next() {
                match arg.as_str() {
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
                },
                socket,
            })
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

/// Print `response` to stdout and return the process exit code: `0` if it
/// deserializes to an `ok: true` `AiResponse`, `1` otherwise.
fn print_response_and_exit_code(response_json: &str) -> i32 {
    println!("{}", response_json);
    match serde_json::from_str::<AiResponse>(response_json) {
        Ok(resp) if resp.ok => 0,
        _ => 1,
    }
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
  mdmini <file>...                          Open one or more files (or focus existing windows)
  mdmini show <file> [--line N | --find TEXT] [--socket PATH]
  mdmini edit <file> [--show] [--allow-empty] [--socket PATH] < new-content
  mdmini ask <file> --question TEXT --option TEXT [--option TEXT ...] [--multi] [--free-text] [--at-line N | --at-find TEXT] [--timeout SECS] [--socket PATH]
  mdmini question [<file>]
  mdmini answer <file> --id ID < reply-text
  mdmini watch [<dir>]
  mdmini mcp [--socket PATH]
  mdmini help
  mdmini agent [--mcp]

OPENING FILES
  mdmini notes.md report.md
      Opens each file in its own window (or focuses it if already open).
      Relative paths are resolved against the current directory. If md-mini
      isn't running, it is launched via `open`; an already-running instance
      receives the file list over a single-instance socket.

SHOW — point at a location in an already-open (or newly opened) window
  mdmini show <file> [--line N | --find "text"] [--socket PATH]

  Opens <file> (or focuses its window if already open) and scrolls the
  target into view with a ~1.6s pulse highlight.
    --line N        1-based line number, clamped to the document.
    --find TEXT     Locate the first substring match (case-sensitive).
                    Mutually exclusive with --line.
    --socket PATH   Talk to a non-default command socket (see "Dev builds").
  Neither flag: just opens/focuses the file, no scroll.

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

  Always send the FULL new document on stdin, never a diff/patch — md-mini
  computes the diff itself against the live buffer.

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
  Neither --at-line nor --at-find: the question appears at the current view.

  Examples:
    mdmini ask notes.md --question "Ship it?" --option Yes --option No
    mdmini ask notes.md --question "Which reviewers?" --option A --option B --option C --multi
    mdmini ask notes.md --question "Ship it?" --option Yes --option No --free-text

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
  show, edit, and ask each print exactly one line of JSON to stdout, never
  stderr.

    show, success:                    {"ok":true}
    edit, success:                    {"ok":true,"changed_lines":[[12,15]]}
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

- `mdmini show <file> --line N` — scroll to line N in the open window and pulse-highlight it.
- `mdmini show <file> --find "some text"` — same, but locate the first match of the text instead of a line number.
- `cat new-content.md | mdmini edit <file> [--show]` — replace the file's live buffer with the **complete** new content read from stdin. md-mini diffs it against what's on screen, applies only the changed span, and highlights it. `--show` also scrolls to the change.
- `mdmini ask <file> --question "..." --option A --option B [--option ...]` — post a question with 2-6 option buttons inside the document and block until the user clicks one; prints `{"ok":true,"answer":"A"}` with the chosen option's text. Add `--multi` for checkbox mode (any number of options, including none, checked and confirmed) — prints `{"ok":true,"answers":["A","C"]}` instead. Add `--free-text` to also let the user type a custom answer — prints `{"ok":true,"custom":"..."}` (or alongside `answers` in `--multi` mode) when they do.

All three verbs print one line of JSON to stdout: `{"ok":true}` (plus `"changed_lines":[[start,end]]` for `edit`, `"answer":"..."` for `ask`, `"answers":[...]` for `ask --multi`, or `"custom":"..."` for a typed `ask --free-text` answer) on success, `{"ok":false,"error":"..."}` on failure. Exit code 0 = success, 1 = md-mini rejected the request, 2 = md-mini isn't running or the command was malformed. If the target file isn't already open, `edit`/`show` open a new window for it automatically — the file must already exist on disk (`ask` requires the same: already open, or existing on disk). Always send the full document on stdin for `edit`, never a diff.

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
        CliVerb::Show { line, find } => AiRequest::Show {
            v: 1,
            path: abs_path,
            line,
            find,
        },
        CliVerb::Edit { show, .. } => AiRequest::Edit {
            v: 1,
            path: abs_path,
            content: content.unwrap_or_default(),
            show,
        },
        CliVerb::Ask {
            question,
            options,
            line,
            find,
            timeout_secs,
            multi,
            free_text,
        } => AiRequest::Ask {
            v: 1,
            path: abs_path,
            question,
            options,
            line,
            find,
            timeout_secs,
            multi,
            free_text,
        },
        CliVerb::Help
        | CliVerb::Agent { .. }
        | CliVerb::Question
        | CliVerb::Answer { .. }
        | CliVerb::Watch => {
            unreachable!("local verbs return early above, before this match")
        }
    };

    let socket_path = parsed
        .socket
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_SOCKET_PATH));

    let mut stream = match UnixStream::connect(&socket_path) {
        Ok(s) => s,
        Err(_) => {
            println!(
                "{}",
                serde_json::to_string(&AiResponse::error("md-mini is not running")).unwrap()
            );
            return 2;
        }
    };

    // `ask` blocks server-side on a human clicking a button, so the CLI's own
    // read timeout must cover that wait (plus 10s of margin) instead of the
    // fixed 10s used for show/edit's near-immediate replies.
    let read_timeout = match &request {
        AiRequest::Ask { timeout_secs, .. } => Duration::from_secs(timeout_secs + 10),
        _ => Duration::from_secs(10),
    };
    let _ = stream.set_read_timeout(Some(read_timeout));

    let mut request_line = match serde_json::to_string(&request) {
        Ok(s) => s,
        Err(e) => {
            println!(
                "{}",
                serde_json::to_string(&AiResponse::error(format!(
                    "failed to encode request: {}",
                    e
                )))
                .unwrap()
            );
            return 1;
        }
    };
    request_line.push('\n');

    if stream.write_all(request_line.as_bytes()).is_err() {
        println!(
            "{}",
            serde_json::to_string(&AiResponse::error("md-mini is not running")).unwrap()
        );
        return 2;
    }

    let mut reader = BufReader::new(stream);
    let mut response_line = String::new();
    match reader.read_line(&mut response_line) {
        Ok(0) | Err(_) => {
            println!(
                "{}",
                serde_json::to_string(&AiResponse::error("timeout waiting for response"))
                    .unwrap()
            );
            1
        }
        Ok(_) => print_response_and_exit_code(response_line.trim()),
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
        }
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
            CliVerb::Show { line, find } => {
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
            CliVerb::Show { line, find } => {
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
            CliVerb::Edit { show, allow_empty } => {
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
            CliVerb::Edit { show, allow_empty } => {
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
}
