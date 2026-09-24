# AI Interface — `mdmini show` / `mdmini edit`

Lets an AI agent (Claude Code and similar) drive a running md-mini window directly: point at a location ("look here"), push new content into the live buffer, or ask a blocking question with option buttons — instead of writing the file to disk and hoping the watcher/autosave/reload path catches up. No daemon required either way — the interface is the existing `mdmini` CLI plus a small command socket served by the already-running app, reachable either as plain CLI verbs or, for agents that speak it, as an MCP server (`mdmini mcp`) wrapping the same socket protocol — see "MCP server" below.

## CLI verbs

| Command | Behavior |
|---------|----------|
| `mdmini show <file> [--line N \| --find "text"]` | Open the file (or focus its existing window) and scroll the target into view with a ~1.6s pulse highlight. `--line` is 1-based, clamped to the document. `--find` locates the first substring match (case-sensitive). Neither flag → just open/focus, no scroll. `--line` and `--find` are mutually exclusive. |
| `cat new.md \| mdmini edit <file> [--show] [--allow-empty]` | Read the **complete** new document content from stdin, diff it against the live buffer, apply only the changed span, and highlight it. `--show` additionally scrolls the change into view. If the file isn't open yet, md-mini opens a window for it first, then applies the edit. Empty stdin is refused by default (`--allow-empty` to intentionally clear the buffer) — see below. |
| `mdmini ask <file> --question TEXT --option TEXT [--option TEXT ...] [--multi] [--free-text] [--at-line N \| --at-find TEXT] [--timeout SECS]` | Post `TEXT` as a question with 2-6 option buttons (one per `--option`, repeatable) inside the file's document, **blocking until the user answers**, and return the choice. Single-choice (default): blocks until one click, returns the chosen option's text as `answer`. `--multi`: checkbox mode — the user may check any number of options (including none) and confirms, returning the checked options as `answers` (an array; `[]` is a valid explicit "confirmed none"). `--free-text`: also offers a free-text field — a typed answer comes back as `custom`, alongside `answers` in `--multi` mode. `--at-line`/`--at-find` (mutually exclusive) place the question near a location, same semantics as `show`'s `--line`/`--find`. `--timeout` bounds the wait, default 300s, clamped to 10-3600s. The file must already be open, or exist on disk — unlike `edit`, `ask` cannot "start a new file". |
| `mdmini question [<file>]` | List the open comment threads the user has left in documents — id, status, anchor line, quoted fragment, and the whole thread. With a path, only that document; without one, everything under the current directory. **Local and offline** — reads the comment files directly, so it works with md-mini closed. See "Comments: the reverse direction" below. |
| `mdmini answer <file> --id ID` | Append a reply to thread `ID` from stdin and mark it `answered`. Local and offline, same as `question`. Refuses empty stdin. |
| `mdmini watch [<dir>]` | Long-running: watch a directory tree (default: the current directory) for comment files and print **one line per newly-open thread**. Meant to be handed to a Claude Code Monitor, which turns each line into an interruption in the live session. Local and offline. |
| `mdmini mcp [--socket PATH]` | Run a stdio MCP server exposing `show`/`edit`/`ask`/`question`/`answer` as MCP tools instead of CLI verbs — see "MCP server" below. |
| `mdmini help` | Print a complete reference of every `mdmini` verb (opening files, `show`, `edit`, `ask`, `question`, `answer`, `watch`, `mcp`, `help`, `agent`) plus the JSON response contract and exit codes. Local and offline — no running app required. |
| `mdmini agent [--mcp]` | Print a ready-to-paste instruction block for an AI agent's instruction file (CLAUDE.md, AGENTS.md, etc.). Without `--mcp`: the CLI-syntax show/edit/ask reference — see below. With `--mcp`: a shorter behavioral snippet for agents already connected via `mdmini mcp`, where the tools are self-describing and what's missing is usage culture — see "MCP server" below. Local and offline either way. |

Examples:

```bash
mdmini show notes.md --line 42
mdmini show notes.md --find "## Deploy"
cat new.md | mdmini edit notes.md --show
mdmini ask notes.md --question "Ship it?" --option Yes --option No
mdmini ask notes.md --question "Which reviewers?" --option A --option B --option C --multi
mdmini ask notes.md --question "Ship it?" --option Yes --option No --free-text
```

All three verbs accept `--socket <path>` to target a non-default command socket (dev builds — see below).

Always send the **full** new document on stdin for `edit`, not a diff or patch — md-mini computes the diff itself against what's currently in the buffer.

By default, `edit` refuses empty stdin — `{"ok": false, "error": "refusing to apply empty content (use --allow-empty)"}`, exit `2`, checked locally before any socket connection is attempted. This guards against a shell mistake (`cat /dev/null | mdmini edit file.md`, or piping in the empty output of a failed upstream command) silently truncating the live buffer. Pass `--allow-empty` to intentionally clear a file.

## JSON response contract

One line of JSON on stdout, always. No JSON on stderr.

```jsonc
// show, success
{"ok": true}

// edit, success — one [start, end] pair per changed span, 1-based inclusive line numbers,
// in the resulting document. Empty array if the content was already identical.
{"ok": true, "changed_lines": [[12, 15]]}
{"ok": true, "changed_lines": []}

// ask, success — the text of the option the user clicked
{"ok": true, "answer": "Yes"}

// ask --multi, success — the texts of the options the user checked and confirmed
{"ok": true, "answers": ["A", "C"]}
{"ok": true, "answers": []}  // confirmed with nothing checked — a valid explicit "none"

// ask --free-text, success — the user typed a custom answer instead of (single mode)
// or alongside (--multi) picking options
{"ok": true, "custom": "Something else"}
{"ok": true, "answers": ["A"], "custom": "and also this"}

// error (any verb)
{"ok": false, "error": "target not found"}
```

`changed_lines` holds one `[start, end]` pair per changed region, 1-based inclusive, in the resulting document. Edits scattered across the file report several pairs, not one span covering everything between the first and last of them. A region is either the lines that actually differ, or — when a block was created or rewritten wholesale — the whole block. A pure deletion has no resulting lines to name, so it reports the single line the deletion point now sits on.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Request reached md-mini and succeeded (`"ok":true`). |
| `1` | Request reached md-mini but it rejected it (`"ok":false"`), or the CLI's own read timed out waiting for a reply after the socket accepted the request (`{"ok":false,"error":"timeout waiting for response"}`) — 10s for `show`/`edit`, the (clamped) `ask` timeout plus 10s for `ask`. |
| `2` | Usage error (bad flags, missing file arg, unknown verb), `edit` refused empty stdin without `--allow-empty`, `ask` given no `--question` or an `--option` count outside 2-6, or md-mini isn't running / didn't start in time (`{"ok":false,"error":"md-mini is not running"}` or `"md-mini did not start in time"`). |

## Socket protocol

JSON-lines over a Unix domain socket: one request object per line, one response object per line, connection stays open across malformed lines (bad line → error response, socket keeps serving).

Request shapes (`"v":1` is a protocol version, reserved for a future MCP wrapper — currently accepted but not branched on):

```json
{"v": 1, "cmd": "show", "path": "/abs/file.md", "line": 42, "find": null}
{"v": 1, "cmd": "show", "path": "/abs/file.md", "line": null, "find": "## Deploy"}
{"v": 1, "cmd": "edit", "path": "/abs/file.md", "content": "<full new document>", "show": false}
{"v": 1, "cmd": "ask", "path": "/abs/file.md", "question": "Ship it?", "options": ["Yes", "No"], "line": null, "find": null, "timeout_secs": 300, "multi": false, "free_text": false}
```

`ask`'s `timeout_secs` defaults to `300` and is clamped server-side to `10..=3600`; `question` must be non-empty and `options` must have 2 to 6 non-empty entries, checked before any window is touched. `multi` (default `false`, omittable) switches the response shape from a single `answer` string to an `answers` array; `free_text` (default `false`, omittable) additionally offers a free-text field, whose typed value comes back as `custom` — see the JSON response contract above.

`path` must be absolute — the CLI resolves relative paths against the current directory (and canonicalizes them) before sending.

Socket path, derived from the product name (same dev/release isolation rule as the app data directory):

| Build | Socket |
|-------|--------|
| Release (`md-mini`) | `/tmp/md_mini_cmd.sock` |
| Dev (`md-mini-dev`) | `/tmp/md_mini_dev_cmd.sock` |

Created with `0600` permissions on startup (`ai_socket::start`, spawned at the end of Rust `setup`, on its own background thread). A stale socket file left behind by a prior run that didn't exit cleanly (`kill -9`) is unlinked and rebound automatically — no manual cleanup needed, unlike the single-instance socket. Removed on both clean-exit paths (`RunEvent::ExitRequested` and `RunEvent::Exit` — see `remove_socket` in `ai_socket.rs`).

Server-side, a request that reaches a live window but gets no frontend reply within its wait — **8s** for `show`/`edit`, the (clamped) `timeout_secs` for `ask` — returns `{"ok":false,"error":"timeout waiting for editor"}` (window closed mid-request, or frozen, or for `ask`, nobody clicked in time). The CLI itself gives up after **10s** (**timeout + 10s** for `ask`) with `"timeout waiting for response"` if it never gets a line back at all.

### Routing to a window

Requests are dispatched to the window that owns `path`, looked up in the existing `OpenFiles` registry:

- `show` on a path that doesn't exist on disk fails immediately with `{"ok":false,"error":"file does not exist"}`, without going through the open-window path at all. `edit` is unaffected — a nonexistent path there still opens a fresh window and applies the edit as a new file. `ask` takes the middle ground: it fails the same way only when the file is **both** not already open **and** missing from disk — an already-open file with no matching path on disk (e.g. deleted after opening) still routes normally.
- File already open → the payload is emitted as an `ai-command` event to that window; the frontend answers by invoking `ai_respond` with the same request id, which the socket listener correlates back to the waiting connection.
- File not open → md-mini opens a new window for it on the main thread (`window::open_file_window`), polls `OpenFiles` for up to 2s for the new window's label, and queues the command for it. The new window's frontend drains its queue once, on mount, via `ai_pull_pending`. If the window never registers within 2s, the request fails with `"failed to open window for file"`. If the window is closed before it ever mounts to pull that queue, the queued command is failed with `"window closed before the command was delivered"` instead of hanging until the listener timeout.
- Once a request has been **delivered** to a window (emitted or pulled from the queue on mount) but the window closes before the frontend ever answers it — most relevant to `ask`, which can sit waiting on a click for minutes — `window::untrack_window` calls `AiPending::cancel_for_window`, which fails every entry registered under that window's label with `{"ok":false,"error":"window closed"}` instead of leaving the caller to wait out the full timeout.
- Each socket connection is served on its own thread and blocks on its own reply channel, but that is not the same as one-command-per-window serialization — two connections can dispatch to the same window concurrently. What actually prevents two concurrent `edit`s from clobbering each other is the frontend: `handleAiCommand`'s edit branch reads the document and calls `dispatch` synchronously, with no `await` in between.

## Launch-if-not-running flow

`scripts/mdmini` handles `show`/`edit`/`ask` before falling into the normal file-open path:

1. If the command socket already exists (`-S "$CMD_SOCK"`) → skip straight to step 3.
2. Otherwise `open /Applications/md-mini.app` (no pending-files handoff needed — the request itself carries the file) and poll for the socket every 0.1s, up to 5s. Times out with `{"ok":false,"error":"md-mini did not start in time"}`, exit 2.
3. `exec "$BIN" ai "$@"` — hands off to the binary's own CLI client (`run_ai_cli` in `ai_socket.rs`), which does the actual socket round-trip. stdin passes through untouched, so `cat new.md | mdmini edit file.md` still works after the launch wait.

The `ai` subcommand is intercepted in `main.rs` before Tauri initializes anything — `mdmini ai show|edit ...` never starts a second GUI instance.

## Highlight behavior

- **`show`**: scrolls the target into view (`EditorView.scrollIntoView(pos, {y:'center'})`) and adds a `cm-ai-pulse` line decoration that plays a ~1.6s CSS fade (`cm-ai-pulse` keyframes, background from `--ai-edit-bg` to transparent). A timer clears the pulse after 1.6s — but only if no `edit` highlight has been installed in the meantime, so a `show` right before an `edit` doesn't wipe the edit's highlight.
- **`edit`**: the changed span gets a persistent `cm-ai-edit` mark (subtle background, theme-aware via `--ai-edit-bg` in both `light.css` and `dark.css`). It survives further typing nearby — CM6 maps the range through subsequent edits — and is cleared only by:
  - the **next** `edit` command (installs its own range, replacing the old one), or
  - pressing **Esc** in the editor (`aiHighlightKeymap`; a no-op, falling through to other Esc handlers, if there's nothing to clear).
  - Not persisted across app restarts — it's in-memory CM6 state (`aiHighlightField`), not saved with the document.
- Edits go through the same single-span `ChangeSet` + scroll-snapshot mechanism as an external file reload, but — unlike a reload — stay a normal, undoable history step: an AI edit is content the user didn't author, and Cmd+Z is how they reject it. (Contrast an external-reload or session-restore transaction, which does use `Transaction.addToHistory.of(false)`.) The document-changed listener still fires normally, so the edit still marks the file dirty and schedules the regular autosave — the file on disk catches up like any other in-app edit.

## Comments: the reverse direction

`show`, `edit` and `ask` all run agent → document. Comments run the other way: the
user selects a fragment, writes a comment, and an agent answers **in the live
working session that already has the context** — not in a fresh background one.

### Where comments live

For a document `CLAUDE.md`, its comments live in `.mdmini_comments_CLAUDE.md` in
the same directory. The markdown of the document itself is never touched, so a
full-document `edit` from an agent cannot destroy a comment, and `git diff` on
the document stays clean.

The file is ordinary markdown, and its format is a contract that md-mini, agents
and humans all write to:

```markdown
<!-- mdmini:comments v=1 doc=CLAUDE.md -->

<!-- mdmini:c id=c-7f3a2c status=open line=42 -->
> We ship via Caddy on the host

**Вы** · 2026-08-24 14:02:00 UTC
Почему не nginx? Разверни абзац.

**agent** · 2026-08-24 14:05:00 UTC
Nginx on this host was broken, so…
```

- A thread starts at a line beginning `<!-- mdmini:c `. Attributes are `k=v`,
  space-separated; unknown ones are ignored, and a malformed marker is skipped
  rather than costing you the rest of the file.
- The `> ` lines right after the marker are the anchor quote. Re-attachment is by
  **searching for that quote**; `line=` is only a hint and a fallback. If the
  quote is gone, the thread is shown at its stored line and marked detached — it
  never silently disappears.
- A reply is `**author** · timestamp` followed by its body, up to the next reply
  or the next thread.
- Statuses are `open` / `paused` / `answered` / `resolved`. Threads are never
  deleted; `resolved` is history.
- `paused` means **a human is typing in this thread right now**. The comment box
  saves as you type, and every save used to set `open` — so `watch` woke an agent
  on the first three words of a question. A paused thread carries a deadline,
  `until=<epoch seconds>`, and counts as waiting only once that moment has
  passed:

  ```markdown
  <!-- mdmini:c id=c-7f3a2c status=paused line=42 until=1787580123 -->
  ```

  Twenty seconds of quiet flips it to `open`; so does the card's "send now"
  button, leaving md-mini, closing the window, or quitting. If none of that
  happens — the app was killed — the deadline in the file is enough on its own:
  `question` and `watch` read an expired pause as waiting. A `paused` thread with
  no `until` at all also counts as waiting. The bias is deliberate: a comment
  delivered late is a nuisance, a comment never delivered is a lie.
- **Answering a paused thread is fine.** Nothing about `answer` changes: it finds
  the thread by id, appends the reply and sets `answered`, deadline included.
  What you will not do is *arrive* at one on your own — that is the point.
- An **older `mdmini` binary** reading a `paused` thread cannot parse its status
  and skips the thread, which for `question` and `watch` amounts to the same
  behaviour as this version: no wake-up while someone is typing. It still
  answers such a thread by id if you give it one, because the point-edits go by
  id and not by parsed status.
- md-mini only ever appends a thread, appends a reply, or rewrites one marker
  line. It never regenerates the file, because you may have edited it by hand.

**Nothing here needs md-mini running.** `question`, `answer` and `watch` read and
write these files directly — no command socket, unlike `show`/`edit`/`ask`, which
need a live window. When the app *is* open, an agent's reply reaches the UI
through md-mini's file watcher.

**`.gitignore` is your call, and md-mini never edits it.** Ignoring
`.mdmini_comments_*` keeps review chatter out of history; committing it makes
review threads travel with the branch into a PR. Both are reasonable.

**Worktrees resolve themselves.** Comments sit beside the copy of the document
they were written on, and the answering agent is the one whose session is
watching that tree. There is nothing to route.

### Tier 1 — Claude Code: Monitor plus a Stop hook

Once per session the agent arms a monitor:

```js
Monitor({
  command: "mdmini watch",
  description: "new mdmini comments",
  persistent: true,
})
```

Every line of stdout becomes an interruption in that same live session — no
polling, no subagent, full context retained.

Three things this needs, and each one is load-bearing:

1. **`persistent: true` is mandatory.** Without it the monitor's default timeout
   is five minutes (one hour maximum). It would die mid-session, and silence from
   a dead monitor looks exactly like "no comments".
2. **A Stop hook is the mandatory second layer, not a nicety.** A monitor that
   emits too much is stopped automatically by the harness, and the agent is not
   guaranteed to notice. "Monitor dead, comments piling up silently" is a real
   path, and the only thing that closes it is a check when the turn ends: run
   `mdmini question`, and if anything is `open`, block the stop and hand the
   threads back as text.
3. **`watch` emits once per thread becoming open, and never re-emits.** Otherwise
   a burst of edits floods the monitor and gets it killed. A thread that is
   answered and then gets a further human reply becomes open again — and that is
   a new event, deliberately, because the user is waiting again.

**Interruption discipline.** A monitor line arrives mid-work. The default should
be: bring the current step to a consistent state, then answer at that checkpoint.
Dropping everything halfway through an edit to answer a comment is worse for the
user than answering thirty seconds later.

**Stop hook — verify the contract for your version before relying on it.** The
mechanism that is stable across Claude Code versions is the exit-code one: exit
`2` from the hook to block, with the text you want the model to see on stderr.
The hook receives JSON on stdin including `stop_hook_active`, which it must check
— if it is already true, exit `0` and let the turn end, or you risk looping.
There is also a JSON-decision form, but its exact field names have moved between
versions, so check `/hooks` or the current docs rather than copying a snippet
from anywhere (including this file) as though it were pinned.

### Tier 2 — agents with no wake-up mechanism

Codex, Cursor and similar have no way for an outside process to interrupt a local
session: the turn only returns to the model when a tool returns. For those, the
comment card has a **"send to agent"** button that copies a ready-made prompt
naming the comment file, the document and the thread id. Paste it into whatever
agent you are already talking to.

This path needs neither MCP nor md-mini's verbs — the comment file is plain
markdown, so an agent can read it and append a reply with ordinary file tools.
That is also why the feature is useful from day one, before any instruction-file
or hook setup exists.

A blocking, self-looping `question` was considered and deliberately rejected: a
model told to spin in a polling loop drops out of it, and the timeouts cost
turns. One reliable path beats two, one of which lies.

## MCP server

`mdmini mcp` runs a stdio [MCP](https://modelcontextprotocol.io) server instead of the CLI verbs above: same `show`/`edit`/`ask` operations, same command socket underneath, wrapped as MCP tools over JSON-RPC 2.0 on stdin/stdout. Nothing new to run — it's the existing socket protocol with a different transport in front, implemented in `mcp_server.rs` (`ai_socket.rs` stays focused on the socket protocol itself).

Register it once and CLAUDE.md/AGENTS.md instruction snippets become unnecessary — the tools are discoverable natively:

```bash
claude mcp add --scope user mdmini -- mdmini mcp
```

Generic `mcpServers` config (Claude Desktop, other MCP clients):

```json
{
  "mcpServers": {
    "mdmini": {
      "command": "mdmini",
      "args": ["mcp"]
    }
  }
}
```

### Methods

| Method | Behavior |
|--------|----------|
| `initialize` | Echoes the client's `protocolVersion` back (defaults to `2025-06-18` if absent). Result includes `capabilities: {"tools": {}}` and `serverInfo: {"name": "mdmini", "version": "<crate version>"}`. |
| `notifications/initialized` | Notification, no response. |
| `ping` | `{}`. |
| `tools/list` | Returns the `show`, `edit`, and `ask` tools, each with a JSON Schema `inputSchema`. |
| `tools/call` | Dispatches to the command socket — see below. |

Any other method that carries an `id` gets a JSON-RPC `-32601` ("method not found") error. A message with no `id` at all is treated as a notification and never gets a response, regardless of method. Malformed JSON gets a `-32700` ("parse error") response with `id: null`.

### Tools

Same shapes as the CLI verbs, as MCP tools:

- **`show`** — `path` (string, required, absolute), `line` (integer, 1-based) or `find` (string, first-occurrence text search); `line` and `find` are mutually exclusive.
- **`edit`** — `path` (string, required), `content` (string, required, the **complete** new document), `show` (boolean, scroll to the change on completion). Empty `content` is refused with the same message the CLI gives for empty stdin — there's no `--allow-empty` equivalent over MCP, since an agent should never *mean* to send an empty document.
- **`ask`** — `path` (string, required), `question` (string, required), `options` (array of string, required, 2-6 entries), `line` (integer, 1-based) or `find` (string), mutually exclusive, `timeout_secs` (integer, default 300, clamped to 10-3600), `multi` (boolean, default `false`), `free_text` (boolean, default `false`). Blocks the `tools/call` response until the user answers. Single-choice (default): returns the chosen option's text as `answer`. `multi: true`: checkbox mode — the user may check any number of options (including none) and confirms; returns the checked options as `answers` (an array; `[]` is a valid explicit "confirmed none") instead of `answer`. `free_text: true`: also offers a free-text field — the user may type a custom answer instead of (single mode) or alongside (`multi`) picking options; a typed answer comes back as `custom`. Missing `path`/`question`/`options` is a JSON-RPC `-32602` ("invalid params") error, same as `show`'s missing `path` — the question/option-count and empty-string validation happens socket-side and comes back as a normal `isError: true` tool result instead. **Note:** a long `timeout_secs` may exceed the calling MCP client's own request timeout — pick a value the client can actually wait for.

`tools/call` builds the matching command-socket request (`{"v":1,"cmd":...}`), sends it, and wraps the raw `AiResponse` JSON line as the tool result text:

```jsonc
{"content": [{"type": "text", "text": "{\"ok\":true,\"changed_lines\":[[12,15]]}"}], "isError": false}
{"content": [{"type": "text", "text": "{\"ok\":true,\"answer\":\"Yes\"}"}], "isError": false}
{"content": [{"type": "text", "text": "{\"ok\":true,\"answers\":[\"A\",\"C\"]}"}], "isError": false}
{"content": [{"type": "text", "text": "{\"ok\":true,\"custom\":\"Something else\"}"}], "isError": false}
```

`isError` is `true` whenever the underlying response has `"ok":false` (routing failure, refusal, target not found, etc.) — this is a *tool-level* failure, reported inside a normal JSON-RPC success result, not a JSON-RPC protocol error. Only a malformed call itself (unknown tool name, missing required argument) becomes a JSON-RPC `-32602` ("invalid params") error.

### Socket resolution and launch

Same default socket as the CLI (`ai_socket::socket_path("md-mini")`, i.e. `/tmp/md_mini_cmd.sock`), overridable with `mdmini mcp --socket PATH`. On `tools/call`, if the socket isn't there:

- **No `--socket` override** (the normal case): launch `open /Applications/md-mini.app` and poll for the socket up to 5s, same as `scripts/mdmini`'s launch-if-not-running step, then retry the connection once.
- **`--socket` given explicitly** (dev/test socket): never attempt a launch — a dev socket being down just means the dev build isn't running, and launching the *release* app would be wrong. Fails straight to `{"ok":false,"error":"md-mini is not running"}` as an `isError: true` text result.

The read timeout on the socket connection is `10s` for `show`/`edit`, matching the CLI, but the (clamped) `timeout_secs` plus `10s` for `ask` — otherwise the MCP transport would time out its own read before a slow-to-answer `ask` ever gets a chance to.

### Using this well as an MCP-connected agent

An agent connected over MCP already gets `show`/`edit`/`ask` as self-describing tools via `tools/list` — it doesn't need CLI syntax. What it benefits from instead is usage culture: when to reach for `ask` in the document instead of asking in chat, how to read multi-choice/free-text answers, and how to stay considerate of the user's attention. Run `mdmini agent --mcp` to print the block below along with the same list of common instruction-file locations as `mdmini agent` — generated by `mcp_agent_text` in `ai_socket.rs` (`MCP_AGENT_SNIPPET`); keep this fenced block in sync with that constant if either changes.

```markdown
## md-mini via MCP — how to use it well

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
- Add a `Stop` hook that runs `mdmini question` and blocks the turn while anything is still open. This is the backstop that matters: a monitor emitting too much is stopped by the harness, and you will not necessarily notice — without the hook, comments pile up in silence.
```

## Using this from an AI agent's CLAUDE.md

Run `mdmini agent` to print this block along with a list of common instruction-file locations (CLAUDE.md, AGENTS.md, GEMINI.md, `.cursor/rules`, `.github/copilot-instructions.md`) — generated by `mdmini agent` (`agent_text` in `ai_socket.rs`); keep this fenced block in sync with that function if either changes. Paste it into a project's `CLAUDE.md` if the user has md-mini installed:

```markdown
## md-mini AI interface

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

If your harness can react to a stream (Claude Code: `Monitor({command: "mdmini watch", description: "new mdmini comments", persistent: true})`), arm it once per session and you get woken in this same session, with your context intact, instead of polling. `persistent: true` matters: without it the monitor dies after five minutes and its silence looks exactly like "no comments". Also add a `Stop` hook running `mdmini question` that blocks the turn while anything is open — a monitor that emits too much is stopped by the harness without telling you, and the hook is what stops comments piling up unseen.

If your harness cannot do either, check `mdmini question` at natural points: before asking the user something in chat, and before reporting that you are done. A comment line is an interruption, not a user message — finish the current step cleanly, then answer. If a comment asks for a change rather than an answer, make it with `edit`, then close the thread with `answer`.
```

Prefer MCP? `claude mcp add --scope user mdmini -- mdmini mcp` registers md-mini's show/edit/ask tools directly — then no instruction-file snippet is needed; run `mdmini agent --mcp` for a short usage-culture snippet worth pasting alongside it.

## Discoverability

None of the above helps a user who doesn't know the interface exists — the reported failure
mode after 1.0. Three surfaces address it, and all three name the same place, the **AI** menu's
**Teach Your AI mdmini**, so someone who sets this up once and forgets has a way back. Design:
`docs/superpowers/specs/2026-08-23-ai-discoverability-design.md` (written when the menu still
carried four setup documents; 1.3.0 collapsed them into that one item and its prompt).

| Surface | Raised when |
|---------|-------------|
| Startup toast (`ai-nudge`) | `main` window, at launch, while `ai-connected` is absent: at most 3 times, at most once a day, never on a launch that also opened the welcome window. Following or closing it retires it permanently (`ai-nudge.json` → `dismissed`). |
| Welcome doc | Shown once per version on launch, and again from the toast's CTA — the same bundled `welcome.md` either way. Points at one menu item and otherwise covers themes, engines and the OCD toggle. |
| `Teach Your AI mdmini` doc | The AI menu's first item. Not instructions to follow by hand: it hands over a prompt that makes the agent register MCP, write itself a skill and add a short note to its own config. |
| First-use toast (`ai-first-use`) | The first AI command this install ever handles. |

Both the marker and the toast come out of one check-and-set: `dispatch` calls
`onboarding::mark_connected` after validation but before routing, and the single call that
observes the transition sets `first_use: true` on that command's `AiCommandPayload`. Riding the
payload rather than a separate event means a command drained from `AiQueue` by a window that
didn't exist yet carries it too. Exactly one command per install can ever carry the flag; a
rejected request never burns it.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `{"ok":false,"error":"md-mini is not running"}`, exit 2 | Couldn't connect to the command socket. | Run the command again (the wrapper auto-launches the app); if it recurs, check the app actually started (`ps aux \| grep md-mini`) and that no crash left a stale socket blocking the port — the app rebinds stale sockets automatically on startup, so just relaunch it. |
| `{"ok":false,"error":"md-mini did not start in time"}`, exit 2 | App didn't finish launching within the wrapper's 5s poll. | Launch it manually once (`open /Applications/md-mini.app`) and retry. |
| `{"ok":false,"error":"window does not own this file"}` | The request's `path` doesn't exactly match the path the target window has open (symlink, relative-vs-canonical, or the file is genuinely open in a different window / not open at all and routing raced). | Pass the same absolute, canonicalized path used to open the file; avoid symlinks. |
| `{"ok":false,"error":"target not found"}` (`show`) | `--find` text isn't a substring of the current buffer (exact, case-sensitive match). | Check the text against the file's current content — it may have changed since you last read it. |
| `{"ok":false,"error":"file does not exist"}` (`show`, `ask`) | Target path doesn't exist on disk (`show`), or doesn't exist on disk **and** isn't already open (`ask`). | `show` requires the file to already exist; `ask` requires it to already exist or already be open. `edit` has no such restriction — it opens a window and applies the edit as a new file. |
| `{"ok":false,"error":"question must not be empty"}` / `"options must have between 2 and 6 entries"` / `"options must not be empty"` (`ask`), exit `1` | The request's `question` was blank, or `options` had fewer than 2 / more than 6 entries, or contained a blank entry. CLI catches the option-count case earlier as a usage error (exit `2`); the rest reach the socket and come back this way. | Fix the `--question`/`--option` values (CLI) or the MCP tool call's `question`/`options` arguments. |
| `{"ok":false,"error":"window closed"}` (`ask`) | The window the question was posted to closed before the user clicked an option. | Ask again once the file is open, or check why the window closed. |
| `{"ok":false,"error":"switched away from this document"}` (`show`, `edit`, `ask`) | The user switched that window to another tab (or replaced its document) before the request was answered — for `ask`, before an option was clicked. | Re-send once the file is open again; `mdmini show <file>` reopens it. |
| `{"ok":false,"error":"tab closed"}` (`show`, `edit`, `ask`) | The tab holding the file was closed before the request was answered (or before a queued request was delivered). | Re-send; `mdmini show <file>` reopens it. |
| `{"ok":false,"error":"tab released"}` (`show`, `edit`, `ask`) | The tab that was to show the file never came to show it — its file could not be read when the window opened, or the open was abandoned — so the request had nowhere to land. | Check the file is readable, then re-send. |
| `{"ok":false,"error":"the current tab has unsaved changes"}` | The file is in a background tab and the window could not leave its active tab: that tab's latest save has not landed. | Retry in a moment. |
| `{"ok":false,"error":"the window is showing another agent's question"}` | The file is in a background tab, and the active tab shows a pending `ask`. | Wait for that question to be answered, or ask the user to switch tabs. |
| `{"ok":false,"error":"could not open the tab"}` | The background tab's file could no longer be read (permissions, not valid text). | Check the file. |
| `{"ok":false,"error":"refusing to apply empty content (use --allow-empty)"}`, exit `2` (`edit`) | stdin was empty and `--allow-empty` wasn't passed. | Pass `--allow-empty` if clearing the file is actually intended; otherwise check what produced the empty stdin. |
| `{"ok":false,"error":"timeout waiting for editor"}` | Socket accepted the request, but the frontend didn't answer within 8s (window frozen or closed mid-request). | Check the app isn't hung; retry. |
| `{"ok":false,"error":"timeout waiting for response"}`, exit 1 | CLI's own 10s wait for any reply line expired. | App likely crashed after accepting the connection; check for a crash and relaunch. |
| `{"ok":false,"error":"failed to open window for file"}` | File wasn't open, and the new window didn't register within 2s. | Verify the file exists and is readable; retry. |
| Command hits the wrong build (dev vs release) | Release and dev builds use different sockets. | Pass `--socket /tmp/md_mini_dev_cmd.sock` explicitly when targeting a dev build. |
