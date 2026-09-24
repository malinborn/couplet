//! `mdmini mcp` — a stdio MCP (Model Context Protocol) server wrapping the
//! existing command socket protocol (`ai_socket.rs`). One socket command maps
//! to one MCP tool; this module adds no new capability, only a JSON-RPC 2.0
//! transport in front of the same `show`/`edit` verbs. See
//! `docs/ai-interface.md` ("MCP server") and
//! `docs/superpowers/specs/2026-08-22-ai-interface-design.md`.
//!
//! Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout. stdout is the
//! protocol channel — nothing but response lines may ever go there; all
//! logging goes to stderr.

use std::io::{self, BufRead, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::ai_socket::{self, AiRequest, AiResponse};

/// Protocol version advertised when the client's `initialize` params don't
/// name one.
const PROTOCOL_VERSION_DEFAULT: &str = "2025-06-18";

/// App bundle launched on `tools/call` when the command socket is down —
/// mirrors `scripts/mdmini`'s launch step.
const APP_BUNDLE_PATH: &str = "/Applications/md-mini.app";

/// How long to poll for the socket to appear after launching the app.
const LAUNCH_WAIT: Duration = Duration::from_secs(5);

/// How long to wait for a response line once a request has been sent.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);

/// Resolved server configuration for one `mdmini mcp` run.
pub struct McpConfig {
    socket_path: PathBuf,
    /// Whether a down socket should trigger an `open`-launch-and-wait. False
    /// whenever `--socket` was passed explicitly — that always names a
    /// dev/test socket, and launching the release app in that case would be
    /// wrong.
    allow_launch: bool,
}

impl McpConfig {
    /// Parse `mdmini mcp [--socket PATH]` flags (`args` is the slice after
    /// the `mcp` verb).
    fn from_flags(args: &[String]) -> Self {
        let mut socket: Option<String> = None;
        let mut iter = args.iter();
        while let Some(arg) = iter.next() {
            if arg == "--socket" {
                socket = iter.next().cloned();
            }
        }
        match socket {
            Some(s) => McpConfig {
                socket_path: PathBuf::from(s),
                allow_launch: false,
            },
            None => McpConfig {
                socket_path: ai_socket::socket_path("md-mini"),
                allow_launch: true,
            },
        }
    }
}

/// Entry point for `mdmini mcp ...`, called from `main.rs` before Tauri is
/// touched. `args` is the full `std::env::args()` vector (`args[0]` binary,
/// `args[1]` `"mcp"`); everything from `args[2]` on is flags. Reads
/// newline-delimited JSON-RPC requests from stdin until EOF, writing one
/// response line per request to stdout. Always returns 0 — a malformed line
/// is a protocol-level error response, not a process failure.
pub fn run(args: Vec<String>) -> i32 {
    let config = McpConfig::from_flags(&args[2.min(args.len())..]);

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(response) = handle_message(trimmed, &config) {
            if writeln!(out, "{}", response).is_err() || out.flush().is_err() {
                break;
            }
        }
    }
    0
}

/// Route one JSON-RPC message to its handler, returning the response line to
/// write (or `None` for notifications, which never get a reply). Pure aside
/// from `tools/call`'s socket round-trip — kept free of stdio so it's
/// testable directly.
fn handle_message(line: &str, config: &McpConfig) -> Option<String> {
    let value: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return Some(error_response(Value::Null, -32700, e.to_string())),
    };

    // No "id" field at all means this is a notification — never respond,
    // regardless of method (covers `notifications/initialized` and any
    // other notification a client sends).
    let id = value.get("id").cloned()?;

    let method = value.get("method").and_then(Value::as_str).unwrap_or("");
    let params = value.get("params").cloned().unwrap_or(Value::Null);

    match method {
        "initialize" => {
            let protocol_version = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(PROTOCOL_VERSION_DEFAULT);
            Some(success_response(
                id,
                json!({
                    "protocolVersion": protocol_version,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "mdmini", "version": env!("CARGO_PKG_VERSION")}
                }),
            ))
        }
        "ping" => Some(success_response(id, json!({}))),
        "tools/list" => Some(success_response(id, json!({ "tools": tools_list() }))),
        "tools/call" => Some(handle_tools_call(id, &params, config)),
        _ => Some(error_response(id, -32601, "method not found")),
    }
}

/// The tools exposed over MCP — `show`, `edit`, and `ask`, one-to-one with
/// the command socket's verbs.
fn tools_list() -> Value {
    json!([
        {
            "name": "show",
            "description": "Open a file in md-mini (the user's markdown editor), focus its window, and optionally scroll to a location with a pulse highlight — use it to point the user at a specific place. `line` and `find` are mutually exclusive.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the file."
                    },
                    "line": {
                        "type": "integer",
                        "description": "1-based line number to scroll to. Mutually exclusive with `find`."
                    },
                    "find": {
                        "type": "string",
                        "description": "First-occurrence text search to scroll to. Mutually exclusive with `line`."
                    }
                },
                "required": ["path"]
            }
        },
        {
            "name": "edit",
            "description": "Replace the content of a document open in md-mini with new content. md-mini diffs against the live buffer, applies only the changed span, highlights it for the user, and autosaves. Send the COMPLETE new document, never a diff. Opens the file if not already open (must exist on disk).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the file."
                    },
                    "content": {
                        "type": "string",
                        "description": "The complete new document content — never a diff."
                    },
                    "show": {
                        "type": "boolean",
                        "description": "Also scroll to the changed span."
                    }
                },
                "required": ["path", "content"]
            }
        },
        {
            "name": "ask",
            "description": "Ask the user a question with buttons rendered inside their open md-mini document; blocks until they answer. By default single-choice: returns the chosen option as `answer`. Set `multi: true` for checkbox mode — the user may check any number of options (including none) and confirms, and the response carries `answers` (an array) instead. Set `free_text: true` to also offer a free-text field — a typed answer comes back as `custom` (alongside `answers` in multi mode). Use for quick decisions while working on that document. Note: long timeout_secs values may exceed the calling MCP client's own request timeout — pick a value the client can actually wait for.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the file. Must already be open in md-mini, or exist on disk."
                    },
                    "question": {
                        "type": "string",
                        "description": "The question text."
                    },
                    "options": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 2,
                        "maxItems": 6,
                        "description": "Button labels, 2 to 6 of them."
                    },
                    "line": {
                        "type": "integer",
                        "description": "1-based line number to show the question near. Mutually exclusive with `find`."
                    },
                    "find": {
                        "type": "string",
                        "description": "First-occurrence text search to show the question near. Mutually exclusive with `line`."
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "default": 300,
                        "description": "How long to wait for the user to answer, in seconds. Clamped to 10-3600."
                    },
                    "multi": {
                        "type": "boolean",
                        "default": false,
                        "description": "Checkbox mode: the user may check any number of options (including none) and confirms, instead of clicking exactly one. Response carries `answers` (an array) instead of `answer`."
                    },
                    "free_text": {
                        "type": "boolean",
                        "default": false,
                        "description": "Also offer a free-text field: the user may type a custom answer instead of (single mode) or alongside (`multi`) picking options. A typed answer comes back as `custom` in the response."
                    }
                },
                "required": ["path", "question", "options"]
            }
        },
        {
            "name": "question",
            "description": "List open comment threads the user left in documents. Reads .mdmini_comments_*.md files directly — works even when md-mini is not running.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Document or directory to look under. Defaults to the current working directory."
                    }
                },
                "required": []
            }
        },
        {
            "name": "answer",
            "description": "Append a reply to a comment thread and mark it answered. If the document itself needs changing, use edit first, then answer to close the thread.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path of the commented document."},
                    "id": {"type": "string", "description": "Thread id, e.g. c-7f3a2c."},
                    "text": {"type": "string", "description": "The reply text."}
                },
                "required": ["path", "id", "text"]
            }
        }
    ])
}

/// Handle `tools/call`: build the matching `AiRequest`, round-trip it over
/// the command socket, and wrap the result as an MCP tool result. Tool-level
/// failures (socket down, timeout, refusal) come back as `isError: true` text
/// results, not JSON-RPC protocol errors — only a malformed call itself
/// (unknown tool, missing argument) is a protocol error.
fn handle_tools_call(id: Value, params: &Value, config: &McpConfig) -> String {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));

    // `question` and `answer` work directly against the comment files: the
    // source of truth is the file beside the document, so neither the socket
    // nor a running app is needed. Return before `AiRequest` construction and
    // the `send_request` round-trip (with its launch-if-not-running retry)
    // even start.
    if name == "question" {
        let root = arguments
            .get("path")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
        let mut resp = AiResponse::ok();
        resp.threads = Some(crate::comments::collect_open(&root));
        return tool_result_response(id, &resp, false);
    }
    if name == "answer" {
        let (Some(path), Some(thread_id), Some(text)) = (
            arguments.get("path").and_then(Value::as_str),
            arguments.get("id").and_then(Value::as_str),
            arguments.get("text").and_then(Value::as_str),
        ) else {
            return error_response(id, -32602, "answer requires path, id and text");
        };
        return match crate::comments::append_reply(Path::new(path), thread_id, "agent", text) {
            Ok(()) => tool_result_response(id, &AiResponse::ok(), false),
            Err(e) => tool_result_response(id, &AiResponse::error(e), true),
        };
    }

    let request = match name {
        "show" => match build_show_request(&arguments) {
            Ok(req) => req,
            Err(msg) => return error_response(id, -32602, msg),
        },
        "edit" => match build_edit_request(&arguments) {
            Ok(req) => req,
            Err(refusal) => return tool_result_response(id, &refusal, true),
        },
        "ask" => match build_ask_request(&arguments) {
            Ok(req) => req,
            Err(msg) => return error_response(id, -32602, msg),
        },
        other => return error_response(id, -32602, format!("unknown tool: {}", other)),
    };

    match send_request(&request, config) {
        Ok(resp) => {
            let is_error = !resp.ok;
            tool_result_response(id, &resp, is_error)
        }
        Err(msg) => tool_result_response(id, &AiResponse::error(msg), true),
    }
}

fn build_show_request(arguments: &Value) -> Result<AiRequest, String> {
    let path = arguments
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing required argument: path".to_string())?;
    let line = arguments
        .get("line")
        .and_then(Value::as_u64)
        .map(|n| n as usize);
    let find = arguments
        .get("find")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    Ok(AiRequest::Show {
        v: 1,
        path: crate::resolve_path(path, None),
        line,
        find,
        window_binding: None,
        focus: None,
        transient: false,
    })
}

/// Empty content is refused the same way the CLI refuses it (`--allow-empty`
/// has no MCP equivalent — an agent should never mean an empty document), so
/// this returns the refusal `AiResponse` directly instead of an `AiRequest`.
// `AiResponse` crossed clippy's 128-byte result_large_err threshold once `ask`
// picked up its `custom` field; this Result is returned once per call and
// never stored or collected, so boxing it would add indirection for no
// measurable benefit.
#[allow(clippy::result_large_err)]
fn build_edit_request(arguments: &Value) -> Result<AiRequest, AiResponse> {
    let path = arguments
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| AiResponse::error("missing required argument: path"))?;
    let content = arguments
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| AiResponse::error("missing required argument: content"))?;
    if content.is_empty() {
        return Err(AiResponse::error(
            "refusing to apply empty content (use --allow-empty)",
        ));
    }
    let show = arguments
        .get("show")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(AiRequest::Edit {
        v: 1,
        path: crate::resolve_path(path, None),
        content: content.to_string(),
        show,
        window_binding: None,
    })
}

fn build_ask_request(arguments: &Value) -> Result<AiRequest, String> {
    let path = arguments
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing required argument: path".to_string())?;
    let question = arguments
        .get("question")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing required argument: question".to_string())?;
    let options: Vec<String> = arguments
        .get("options")
        .and_then(Value::as_array)
        .ok_or_else(|| "missing required argument: options".to_string())?
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect();
    let line = arguments
        .get("line")
        .and_then(Value::as_u64)
        .map(|n| n as usize);
    let find = arguments
        .get("find")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    let timeout_secs = arguments
        .get("timeout_secs")
        .and_then(Value::as_u64)
        .unwrap_or_else(ai_socket::default_ask_timeout);
    let multi = arguments
        .get("multi")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let free_text = arguments
        .get("free_text")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(AiRequest::Ask {
        v: 1,
        path: crate::resolve_path(path, None),
        question: question.to_string(),
        options,
        line,
        find,
        timeout_secs,
        multi,
        free_text,
        window_binding: None,
    })
}

/// Send one request over the command socket and read back one response line,
/// attempting an `open`-launch-and-wait first if the socket is down and
/// launching is allowed (see `McpConfig::allow_launch`).
fn send_request(request: &AiRequest, config: &McpConfig) -> Result<AiResponse, String> {
    let stream = match UnixStream::connect(&config.socket_path) {
        Ok(s) => s,
        Err(_) if config.allow_launch => {
            launch_and_wait(&config.socket_path)?;
            UnixStream::connect(&config.socket_path)
                .map_err(|_| "md-mini is not running".to_string())?
        }
        Err(_) => return Err("md-mini is not running".to_string()),
    };

    // `ask` blocks server-side on a human clicking a button, so the read
    // timeout must cover that wait (plus margin) instead of the fixed
    // `RESPONSE_TIMEOUT` used for show/edit's near-immediate replies.
    let read_timeout = match request {
        AiRequest::Ask { timeout_secs, .. } => {
            Duration::from_secs(ai_socket::clamp_ask_timeout(*timeout_secs)) + RESPONSE_TIMEOUT
        }
        _ => RESPONSE_TIMEOUT,
    };
    let _ = stream.set_read_timeout(Some(read_timeout));

    let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
    let mut request_line =
        serde_json::to_string(request).map_err(|e| format!("failed to encode request: {}", e))?;
    request_line.push('\n');
    writer
        .write_all(request_line.as_bytes())
        .map_err(|_| "md-mini is not running".to_string())?;

    let mut reader = io::BufReader::new(stream);
    let mut response_line = String::new();
    match reader.read_line(&mut response_line) {
        Ok(0) | Err(_) => Err("timeout waiting for response".to_string()),
        Ok(_) => serde_json::from_str::<AiResponse>(response_line.trim())
            .map_err(|e| format!("failed to parse response: {}", e)),
    }
}

/// `open`-launch the release app and poll for the command socket to appear,
/// mirroring `scripts/mdmini`'s launch step. Only called when
/// `McpConfig::allow_launch` is true, i.e. `--socket` was not passed.
fn launch_and_wait(socket_path: &Path) -> Result<(), String> {
    let _ = std::process::Command::new("open")
        .arg(APP_BUNDLE_PATH)
        .spawn();

    let deadline = Instant::now() + LAUNCH_WAIT;
    while Instant::now() < deadline {
        if socket_path.exists() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("md-mini is not running".to_string())
}

fn tool_result_response(id: Value, response: &AiResponse, is_error: bool) -> String {
    let text = serde_json::to_string(response).unwrap_or_else(|_| "{}".to_string());
    success_response(
        id,
        json!({
            "content": [{"type": "text", "text": text}],
            "isError": is_error
        }),
    )
}

fn success_response(id: Value, result: Value) -> String {
    serde_json::to_string(&json!({"jsonrpc": "2.0", "id": id, "result": result}))
        .unwrap_or_else(|_| r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"failed to encode response"}}"#.to_string())
}

fn error_response(id: Value, code: i32, message: impl Into<String>) -> String {
    serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {"code": code, "message": message.into()}
    }))
    .unwrap_or_else(|_| r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"failed to encode response"}}"#.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;

    fn test_config() -> McpConfig {
        McpConfig {
            socket_path: PathBuf::from("/tmp/mdmini_mcp_test_unused.sock"),
            allow_launch: false,
        }
    }

    static SOCK_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A fresh, never-yet-bound socket path for one test — unique per test
    /// process and call so parallel `cargo test` runs don't collide.
    fn unique_temp_socket() -> PathBuf {
        let n = SOCK_COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("mdmini_mcp_test_{}_{}.sock", std::process::id(), n))
    }

    /// Bind a Unix socket that accepts exactly one connection, reads one
    /// request line (delivered back over the returned receiver), and replies
    /// with `canned`. Mimics the command socket's protocol just enough for
    /// `tools/call` tests.
    fn spawn_fake_socket(canned: AiResponse) -> (PathBuf, mpsc::Receiver<String>) {
        let path = unique_temp_socket();
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).expect("bind fake socket");
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                let mut reader = io::BufReader::new(stream.try_clone().expect("clone stream"));
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
                let _ = tx.send(line.trim().to_string());
                let mut writer = stream;
                let mut resp = serde_json::to_string(&canned).unwrap();
                resp.push('\n');
                let _ = writer.write_all(resp.as_bytes());
            }
        });
        (path, rx)
    }

    #[test]
    fn initialize_echoes_client_protocol_version_and_server_info() {
        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}"#;
        let response = handle_message(request, &test_config()).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["id"], json!(1));
        assert_eq!(v["result"]["protocolVersion"], json!("2024-11-05"));
        assert_eq!(v["result"]["serverInfo"]["name"], json!("mdmini"));
        assert_eq!(v["result"]["capabilities"], json!({"tools": {}}));
    }

    #[test]
    fn initialize_defaults_protocol_version_when_absent() {
        let request = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;
        let response = handle_message(request, &test_config()).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["result"]["protocolVersion"], json!(PROTOCOL_VERSION_DEFAULT));
    }

    #[test]
    fn ping_returns_empty_result() {
        let request = r#"{"jsonrpc":"2.0","id":7,"method":"ping"}"#;
        let response = handle_message(request, &test_config()).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["id"], json!(7));
        assert_eq!(v["result"], json!({}));
    }

    #[test]
    fn tools_list_contains_show_and_edit_with_required_fields() {
        let request = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
        let response = handle_message(request, &test_config()).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        let tools = v["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 5);
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"show"));
        assert!(names.contains(&"edit"));
        assert!(names.contains(&"ask"));
        assert!(names.contains(&"question"));
        assert!(names.contains(&"answer"));
        for tool in tools {
            assert!(!tool["description"].as_str().unwrap().is_empty());
            assert_eq!(tool["inputSchema"]["type"], json!("object"));
            assert!(tool["inputSchema"]["properties"].is_object());
            assert!(tool["inputSchema"]["required"].is_array());
        }
    }

    #[test]
    fn notification_without_id_gets_no_response() {
        let request = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        assert!(handle_message(request, &test_config()).is_none());
    }

    #[test]
    fn any_method_without_id_is_treated_as_a_notification() {
        let request = r#"{"jsonrpc":"2.0","method":"ping"}"#;
        assert!(handle_message(request, &test_config()).is_none());
    }

    #[test]
    fn unknown_method_with_id_errors() {
        let request = r#"{"jsonrpc":"2.0","id":1,"method":"bogus"}"#;
        let response = handle_message(request, &test_config()).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["error"]["code"], json!(-32601));
    }

    #[test]
    fn malformed_json_yields_parse_error_with_null_id() {
        let response = handle_message("not json", &test_config()).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["error"]["code"], json!(-32700));
        assert_eq!(v["id"], Value::Null);
    }

    #[test]
    fn string_id_is_echoed_verbatim() {
        let request = r#"{"jsonrpc":"2.0","id":"abc-123","method":"ping"}"#;
        let response = handle_message(request, &test_config()).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["id"], json!("abc-123"));
    }

    #[test]
    fn unknown_tool_errors_with_invalid_params() {
        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bogus","arguments":{}}}"#;
        let response = handle_message(request, &test_config()).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["error"]["code"], json!(-32602));
    }

    #[test]
    fn tools_call_edit_refuses_empty_content_without_touching_socket() {
        // The socket path deliberately points nowhere — if this test ever
        // tried to connect, it would fail with a connection error rather
        // than the refusal text, so the assertion below also proves the
        // refusal happens before any socket I/O.
        let config = McpConfig {
            socket_path: PathBuf::from("/tmp/mdmini_mcp_test_should_not_be_dialed.sock"),
            allow_launch: false,
        };
        let request = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"edit","arguments":{"path":"/tmp/a.md","content":""}}}"#;
        let response = handle_message(request, &config).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["result"]["isError"], json!(true));
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("refusing to apply empty content"));
    }

    #[test]
    fn tools_call_socket_down_without_launch_is_error() {
        let config = McpConfig {
            socket_path: PathBuf::from("/tmp/mdmini_mcp_test_definitely_not_bound.sock"),
            allow_launch: false,
        };
        let request = r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"show","arguments":{"path":"/tmp/a.md"}}}"#;
        let response = handle_message(request, &config).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["result"]["isError"], json!(true));
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("md-mini is not running"));
    }

    #[test]
    fn tools_call_show_round_trips_request_shape_and_ok_response() {
        let (path, rx) = spawn_fake_socket(AiResponse::ok());
        let config = McpConfig {
            socket_path: path.clone(),
            allow_launch: false,
        };
        let request = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"show","arguments":{"path":"/tmp/a.md","line":5}}}"#;
        let response = handle_message(request, &config).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["result"]["isError"], json!(false));
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(text, r#"{"ok":true}"#);

        let req_line = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let req: Value = serde_json::from_str(&req_line).unwrap();
        assert_eq!(req["v"], json!(1));
        assert_eq!(req["cmd"], json!("show"));
        assert_eq!(req["path"], json!("/tmp/a.md"));
        assert_eq!(req["line"], json!(5));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tools_call_edit_maps_ok_false_response_to_is_error_true() {
        let (path, rx) = spawn_fake_socket(AiResponse::error("target not found"));
        let config = McpConfig {
            socket_path: path.clone(),
            allow_launch: false,
        };
        let request = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"edit","arguments":{"path":"/tmp/a.md","content":"hello"}}}"#;
        let response = handle_message(request, &config).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["result"]["isError"], json!(true));
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(text, r#"{"ok":false,"error":"target not found"}"#);

        let req_line = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let req: Value = serde_json::from_str(&req_line).unwrap();
        assert_eq!(req["cmd"], json!("edit"));
        assert_eq!(req["content"], json!("hello"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tools_call_ask_round_trips_request_shape_and_answer() {
        let canned = AiResponse {
            ok: true,
            answer: Some("Yes".to_string()),
            ..Default::default()
        };
        let (path, rx) = spawn_fake_socket(canned);
        let config = McpConfig {
            socket_path: path.clone(),
            allow_launch: false,
        };
        let request = r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"ask","arguments":{"path":"/tmp/a.md","question":"Ship it?","options":["Yes","No"],"timeout_secs":60}}}"#;
        let response = handle_message(request, &config).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["result"]["isError"], json!(false));
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(text, r#"{"ok":true,"answer":"Yes"}"#);

        let req_line = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let req: Value = serde_json::from_str(&req_line).unwrap();
        assert_eq!(req["cmd"], json!("ask"));
        assert_eq!(req["question"], json!("Ship it?"));
        assert_eq!(req["options"], json!(["Yes", "No"]));
        assert_eq!(req["timeout_secs"], json!(60));
        assert_eq!(req["multi"], json!(false));
        assert_eq!(req["free_text"], json!(false));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tools_call_ask_multi_true_round_trips_request_and_answers() {
        let canned = AiResponse {
            ok: true,
            answers: Some(vec!["A".to_string(), "C".to_string()]),
            ..Default::default()
        };
        let (path, rx) = spawn_fake_socket(canned);
        let config = McpConfig {
            socket_path: path.clone(),
            allow_launch: false,
        };
        let request = r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"ask","arguments":{"path":"/tmp/a.md","question":"Which reviewers?","options":["A","B","C"],"multi":true}}}"#;
        let response = handle_message(request, &config).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["result"]["isError"], json!(false));
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(text, r#"{"ok":true,"answers":["A","C"]}"#);

        let req_line = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let req: Value = serde_json::from_str(&req_line).unwrap();
        assert_eq!(req["cmd"], json!("ask"));
        assert_eq!(req["multi"], json!(true));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tools_call_ask_free_text_true_round_trips_request_and_custom() {
        let canned = AiResponse {
            ok: true,
            custom: Some("Something else".to_string()),
            ..Default::default()
        };
        let (path, rx) = spawn_fake_socket(canned);
        let config = McpConfig {
            socket_path: path.clone(),
            allow_launch: false,
        };
        let request = r#"{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"ask","arguments":{"path":"/tmp/a.md","question":"Ship it?","options":["Yes","No"],"free_text":true}}}"#;
        let response = handle_message(request, &config).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["result"]["isError"], json!(false));
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(text, r#"{"ok":true,"custom":"Something else"}"#);

        let req_line = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let req: Value = serde_json::from_str(&req_line).unwrap();
        assert_eq!(req["cmd"], json!("ask"));
        assert_eq!(req["free_text"], json!(true));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tools_call_ask_missing_options_is_invalid_params() {
        let request = r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"ask","arguments":{"path":"/tmp/a.md","question":"Ship it?"}}}"#;
        let response = handle_message(request, &test_config()).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["error"]["code"], json!(-32602));
    }

    #[test]
    fn from_flags_defaults_to_release_socket_and_allows_launch() {
        let config = McpConfig::from_flags(&[]);
        assert_eq!(config.socket_path, ai_socket::socket_path("md-mini"));
        assert!(config.allow_launch);
    }

    #[test]
    fn from_flags_explicit_socket_disallows_launch() {
        let config = McpConfig::from_flags(&["--socket".to_string(), "/tmp/x.sock".to_string()]);
        assert_eq!(config.socket_path, PathBuf::from("/tmp/x.sock"));
        assert!(!config.allow_launch);
    }

    // `question`/`answer` read and write comment files directly — no socket
    // involved — so these tests use `test_config()`'s socket-to-nowhere on
    // purpose: if either tool ever fell through to `send_request`, these
    // would fail with a connection error instead of the expected result.

    static COMMENT_TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A fresh temp directory containing one document, used as the `path`
    /// argument for `question`/`answer` tests. Mirrors `comments::tests::temp_doc`,
    /// which is private to that module.
    fn temp_doc(name: &str) -> PathBuf {
        let n = COMMENT_TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "mdmini-mcp-comments-test-{}-{}",
            std::process::id(),
            n
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn question_on_a_directory_with_no_comment_files_is_ok_and_empty() {
        let dir = temp_doc("spec.md").parent().unwrap().to_path_buf();
        let request = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"question","arguments":{{"path":"{}"}}}}}}"#,
            dir.display()
        );
        let response = handle_message(&request, &test_config()).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["result"]["isError"], json!(false));
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let resp: AiResponse = serde_json::from_str(text).unwrap();
        assert!(resp.ok);
        assert_eq!(resp.threads.unwrap().len(), 0);
    }

    #[test]
    fn question_finds_an_open_thread_under_the_given_path() {
        let doc = temp_doc("spec.md");
        crate::comments::append_thread(&doc, "c-aaaaaa", 3, "quote here", "Макс", "Вопрос?")
            .unwrap();

        let request = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"question","arguments":{{"path":"{}"}}}}}}"#,
            doc.parent().unwrap().display()
        );
        let response = handle_message(&request, &test_config()).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let resp: AiResponse = serde_json::from_str(text).unwrap();
        let threads = resp.threads.unwrap();
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].thread.id, "c-aaaaaa");
        assert_eq!(threads[0].doc, doc);
    }

    #[test]
    fn answer_missing_any_required_field_is_invalid_params() {
        for arguments in [
            json!({"id": "c-aaaaaa", "text": "hi"}),
            json!({"path": "/tmp/a.md", "text": "hi"}),
            json!({"path": "/tmp/a.md", "id": "c-aaaaaa"}),
        ] {
            let request = json!({
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {"name": "answer", "arguments": arguments}
            });
            let response = handle_message(&request.to_string(), &test_config()).unwrap();
            let v: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(v["error"]["code"], json!(-32602), "arguments: {arguments}");
        }
    }

    #[test]
    fn answer_against_an_unknown_thread_is_a_tool_error_not_a_protocol_error() {
        let doc = temp_doc("spec.md");
        crate::comments::append_thread(&doc, "c-aaaaaa", 1, "q", "Макс", "Вопрос?").unwrap();

        let request = json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": "answer", "arguments": {"path": doc, "id": "c-nope00", "text": "hi"}}
        });
        let response = handle_message(&request.to_string(), &test_config()).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["result"]["isError"], json!(true));
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("c-nope00"), "got {text}");
    }

    #[test]
    fn answer_appends_a_reply_and_marks_the_thread_answered() {
        let doc = temp_doc("spec.md");
        crate::comments::append_thread(&doc, "c-aaaaaa", 1, "q", "Макс", "Вопрос?").unwrap();

        let request = json!({
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": {"name": "answer", "arguments": {"path": doc, "id": "c-aaaaaa", "text": "Ответ."}}
        });
        let response = handle_message(&request.to_string(), &test_config()).unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["result"]["isError"], json!(false));

        let threads = crate::comments::collect_open(doc.parent().unwrap());
        // The thread is now `answered`, not `open`, so `collect_open` no
        // longer returns it — asserting on the file directly instead.
        assert!(threads.is_empty());
        let text = std::fs::read_to_string(crate::comments::sidecar_path(&doc).unwrap()).unwrap();
        assert!(text.contains("status=answered"));
        assert!(text.contains("**agent** ·"));
        assert!(text.contains("Ответ."));
    }
}
