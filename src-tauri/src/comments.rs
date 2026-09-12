//! Comment layer: reading and point-edits of `.mdmini_comments_<doc>.md`.
//!
//! The source of truth is the file, not md-mini. That's why there is no store
//! and no GC here: this module only knows how to parse the file and make a
//! minimal change to it. Full rewrite is deliberately absent — both agents
//! and humans edit the file by hand.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

/// Status of a thread.
///
/// `Paused` is the one an agent must not be woken by: it means a human is
/// still typing. It carries a deadline on the marker line ([`Thread::until`]),
/// and once that passes the thread counts as awaiting an answer again — see
/// [`awaiting`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Open,
    Paused,
    Answered,
    Resolved,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Open => "open",
            Status::Paused => "paused",
            Status::Answered => "answered",
            Status::Resolved => "resolved",
        }
    }

    pub fn parse(s: &str) -> Option<Status> {
        match s {
            "open" => Some(Status::Open),
            "paused" => Some(Status::Paused),
            "answered" => Some(Status::Answered),
            "resolved" => Some(Status::Resolved),
            _ => None,
        }
    }
}

/// How long a thread stays paused after the last keystroke, in seconds.
///
/// A starting value, deliberately cheap to change: long enough to finish a
/// sentence and reread it, short enough that nobody sits waiting for it.
/// Mirrored by `COMMENT_PAUSE_SECONDS` in `src/lib/comment-format.ts` — the
/// app counts down against the same number it writes into the file.
pub const PAUSE_SECS: u64 = 20;

/// Does this thread want an agent right now?
///
/// The rule that decides it lives in the file, not in the app's memory, and
/// that is the whole point. md-mini writes `status=paused until=<epoch>` while
/// the human types and flips it to `open` when the pause runs out — but it can
/// be closed, or killed, in the five seconds before that happens. Then nothing
/// would ever flip it and the agent would never come: a worse failure than the
/// mid-sentence wake-up the pause exists to prevent. So a pause whose deadline
/// has passed reads as awaiting, and delivery needs no process to have
/// survived. The app's own commit (on the timer, on "send now", on losing
/// focus, on window close and on quit) only makes it prompt.
///
/// A `paused` thread with no deadline at all — hand-written, or written by a
/// version that did not record one — counts as awaiting for the same reason:
/// when in doubt, the comment gets delivered.
pub fn awaiting(thread: &Thread, now: u64) -> bool {
    match thread.status {
        Status::Open => true,
        Status::Paused => thread.until.is_none_or(|deadline| now >= deadline),
        Status::Answered | Status::Resolved => false,
    }
}

/// The status a thread takes when the user edits their own reply in it.
///
/// The interesting arm is `Open`: it stays open. That is the point of no
/// return — the thread has already been handed to the agent, which may be
/// composing an answer this very second, and a wake-up cannot be taken back.
/// Pausing it again would only create a way to lose the addendum: the agent's
/// reply sets `answered`, overwriting the pause, and the text typed after the
/// wake-up would sit in the file with nothing left to announce it.
///
/// Before that point — a thread being written, one still paused, one the agent
/// has already answered — editing starts or continues a turn nobody has been
/// told about yet, so it pauses.
///
/// **This one match is the whole decision, and it is deliberately the only
/// place that makes it.** Where the point of no return belongs is not settled:
/// `open` is the moment the thread becomes *available* to an agent, which is
/// the earliest defensible answer and the only one md-mini can observe on its
/// own. A later one — a thread claimed by the agent that is actually going to
/// answer it — would need that agent to say so, and nothing in the file says
/// it today. Moving the line means editing this arm, not unpicking a mechanism.
pub fn status_after_edit(current: Status) -> Status {
    match current {
        Status::Open => Status::Open,
        Status::Paused | Status::Answered | Status::Resolved => Status::Paused,
    }
}

/// Path of the comment file for a document: same directory, prefixed name.
pub fn sidecar_path(doc: &Path) -> Option<PathBuf> {
    let name = doc.file_name()?.to_str()?;
    Some(doc.with_file_name(format!(".mdmini_comments_{}", name)))
}

/// `true` if the path is itself a comment file. Such files cannot be
/// commented on and cannot be treated as documents — otherwise it recurses.
pub fn is_sidecar(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with(".mdmini_comments_"))
}

/// Format epoch seconds as `YYYY-MM-DD HH:MM:SS UTC`.
///
/// The zone in the string is mandatory. A human reads the comment file with
/// their own eyes and may commit it, and without the marker a user in UTC+3
/// sees a time three hours in the past in their own file and doesn't
/// understand why. Local time instead of UTC doesn't work either: the file
/// travels between machines and time zones together with the repository, so
/// the same conversation would read differently depending on where it's
/// opened.
///
/// A hand-rolled implementation instead of a date crate: the project has
/// neither `chrono` nor `time`, and exactly one function is needed. The
/// algorithm is civil-from-days: shift the epoch to March 1st, year 0 so the
/// leap day ends up as the last day of the year and falls out of the month
/// arithmetic.
pub fn fmt_utc(epoch_secs: u64) -> String {
    let days = (epoch_secs / 86_400) as i64;
    let secs_of_day = epoch_secs % 86_400;

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC",
        y,
        m,
        d,
        secs_of_day / 3_600,
        (secs_of_day % 3_600) / 60,
        secs_of_day % 60
    )
}

/// Current time as epoch seconds. A separate function so format tests can
/// work with fixed values instead of the clock.
pub fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Short thread id: `c-` plus six hex characters. Not cryptographic —
/// all that's needed is a stable, human-readable key within a single file,
/// hence `DefaultHasher` from std instead of a new dependency.
pub fn new_id(doc: &Path, seed: u64) -> String {
    let mut hasher = DefaultHasher::new();
    doc.hash(&mut hasher);
    seed.hash(&mut hasher);
    format!("c-{:06x}", hasher.finish() & 0xff_ffff)
}

/// Same as above, but guaranteed not to collide with any taken id: on
/// collision it mixes in a counter. A collision on six hex characters is
/// unlikely, but the file lives a long time and is edited by hand — checking
/// is cheaper than chasing a duplicate.
pub fn new_id_avoiding(doc: &Path, seed: u64, taken: &[String]) -> String {
    for bump in 0..1_000 {
        let candidate = new_id(doc, seed.wrapping_add(bump));
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
    // Practically unreachable; better to return a definitely-valid id than to panic.
    new_id(doc, seed ^ now_epoch())
}

/// A single reply within a thread.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Reply {
    pub author: String,
    pub at: String,
    pub text: String,
}

/// A single thread anchored to a fragment of the document.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Thread {
    pub id: String,
    pub status: Status,
    /// Line number as of the last write — a hint and a fallback.
    /// Anchoring is done by searching for `quote`, not by this number.
    pub line: usize,
    pub quote: String,
    /// Document text immediately before the quote, as of the moment the
    /// thread was created. `None` on threads written before this existed and
    /// on ones typed by hand — anchoring degrades to the line hint, it does
    /// not break. See `anchorPosition` in `src/lib/comment-format.ts`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    /// Document text immediately after the quote. See [`Thread::prefix`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suffix: Option<String>,
    /// Epoch seconds at which a [`Status::Paused`] thread stops being paused.
    /// `None` on every other status, and on threads written before pausing
    /// existed. See [`awaiting`] for what a missing deadline means.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<u64>,
    pub replies: Vec<Reply>,
}

/// Text kept on each side of the quote, in characters. Mirrors
/// `ANCHOR_CONTEXT` in `src/lib/comment-format.ts`; the number was measured,
/// see the doc comment on `anchorPosition` there.
pub const ANCHOR_CONTEXT: usize = 32;

/// Surrounding text stored with a thread so a repeated quote can still be
/// told apart from its duplicates.
#[derive(Debug, Clone, Copy, Default)]
pub struct Context<'a> {
    pub prefix: &'a str,
    pub suffix: &'a str,
}

const THREAD_MARKER: &str = "<!-- mdmini:c ";

/// Percent-escape a marker attribute value.
///
/// Attributes are `k=v` pairs split on whitespace, so a value containing a
/// space would be read as two attributes with the tail silently dropped. `>`
/// is escaped too, so no value can spell `-->` and cut the comment short.
/// Everything else — Cyrillic included — stays literal: humans read this file.
///
/// Mirrored by `escapeAttr` in `src/lib/comment-format.ts`; the shared
/// fixture test is what keeps the two honest.
pub fn escape_attr(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_whitespace() || ch == '%' || ch == '>' {
            let mut buf = [0u8; 4];
            for byte in ch.encode_utf8(&mut buf).as_bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// Inverse of [`escape_attr`]. Malformed input is kept as written rather than
/// rejected — a hand-edited file must not lose a thread over a stray `%`.
pub fn unescape_attr(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The first `ANCHOR_CONTEXT` characters of `text`, counted in chars so a
/// multi-byte boundary is never cut.
pub fn context_head(text: &str) -> String {
    text.chars().take(ANCHOR_CONTEXT).collect()
}

/// The last `ANCHOR_CONTEXT` characters of `text`.
pub fn context_tail(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    chars[chars.len().saturating_sub(ANCHOR_CONTEXT)..].iter().collect()
}

/// What a thread marker line declares.
struct Marker {
    id: String,
    status: Status,
    line: usize,
    prefix: Option<String>,
    suffix: Option<String>,
    until: Option<u64>,
}

/// Parse `k=v` attributes from a thread marker line.
fn parse_marker(line: &str) -> Option<Marker> {
    let inner = line.trim().strip_prefix(THREAD_MARKER)?.strip_suffix("-->")?;
    let mut id = None;
    let mut status = None;
    let mut num = None;
    let mut prefix = None;
    let mut suffix = None;
    let mut until = None;
    for pair in inner.split_whitespace() {
        let (key, value) = pair.split_once('=')?;
        match key {
            "id" => id = Some(value.to_string()),
            "status" => status = Status::parse(value),
            "line" => num = value.parse::<usize>().ok(),
            "pre" => prefix = Some(unescape_attr(value)),
            "suf" => suffix = Some(unescape_attr(value)),
            "until" => until = value.parse::<u64>().ok(),
            _ => {} // unknown attributes are ignored intentionally
        }
    }
    Some(Marker {
        id: id?,
        status: status?,
        line: num.unwrap_or(1),
        prefix,
        suffix,
        until,
    })
}

/// Parse a reply header `**author** · at`.
fn parse_reply_header(line: &str) -> Option<(String, String)> {
    let rest = line.strip_prefix("**")?;
    let (author, tail) = rest.split_once("**")?;
    if author.contains('*') {
        return None;
    }
    let at = tail.trim().strip_prefix('·')?.trim();
    Some((author.to_string(), at.to_string()))
}

/// Parse the whole comment file. Broken threads are skipped, the rest are
/// returned — the file never gets lost entirely because of one typo.
pub fn parse(text: &str) -> Vec<Thread> {
    let mut threads: Vec<Thread> = Vec::new();
    let mut current: Option<Thread> = None;
    let mut skipping = false;
    let mut reply: Option<Reply> = None;

    for line in text.lines() {
        if line.trim_start().starts_with(THREAD_MARKER) {
            if let (Some(mut thread), Some(r)) = (current.take(), reply.take()) {
                thread.replies.push(r);
                threads.push(thread);
            } else if let Some(thread) = current.take() {
                threads.push(thread);
            }
            reply = None;
            match parse_marker(line) {
                Some(marker) => {
                    skipping = false;
                    current = Some(Thread {
                        id: marker.id,
                        status: marker.status,
                        line: marker.line,
                        quote: String::new(),
                        prefix: marker.prefix,
                        suffix: marker.suffix,
                        until: marker.until,
                        replies: Vec::new(),
                    });
                }
                None => {
                    skipping = true;
                }
            }
            continue;
        }

        if skipping {
            continue;
        }
        let Some(thread) = current.as_mut() else {
            continue; // file preamble before the first thread
        };

        if reply.is_none() {
            if let Some(quoted) = line.strip_prefix("> ") {
                if !thread.quote.is_empty() {
                    thread.quote.push('\n');
                }
                thread.quote.push_str(quoted.trim_end());
                continue;
            }
        }

        if let Some((author, at)) = parse_reply_header(line) {
            if let Some(previous) = reply.take() {
                thread.replies.push(previous);
            }
            reply = Some(Reply {
                author,
                at,
                text: String::new(),
            });
            continue;
        }

        if let Some(r) = reply.as_mut() {
            if line.trim().is_empty() && r.text.is_empty() {
                continue;
            }
            if !r.text.is_empty() {
                r.text.push('\n');
            }
            r.text.push_str(line);
        }
    }

    if let Some(mut thread) = current.take() {
        if let Some(r) = reply.take() {
            thread.replies.push(r);
        }
        threads.push(thread);
    }

    for thread in &mut threads {
        for r in &mut thread.replies {
            r.text = r.text.trim_end().to_string();
        }
    }
    threads
}

/// Atomic write: `.tmp` first, then `rename`. Two parties edit the file —
/// md-mini and the agent — so there must never be a partially-written state.
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("failed to write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("failed to rename into {}: {e}", path.display()))
}

/// Read the document's threads. A missing file is an empty list, not an error.
pub fn load(doc: &Path) -> Result<Vec<Thread>, String> {
    let path = sidecar_path(doc).ok_or_else(|| "bad document path".to_string())?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(parse(&text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("failed to read {}: {e}", path.display())),
    }
}

fn guard_not_sidecar(doc: &Path) -> Result<(), String> {
    if is_sidecar(doc) {
        return Err("refusing to comment on a comment file".to_string());
    }
    Ok(())
}

/// Render a single thread block — the one place where the format is assembled.
///
/// `pre=`/`suf=`/`until=` are written only when there is something to write.
/// An empty attribute would carry no information and would still have to be
/// read back, and leaving it out keeps the marker of a hand-written thread
/// identical to what a person would type.
#[allow(clippy::too_many_arguments)]
fn render_thread(
    id: &str,
    status: Status,
    line: usize,
    until: Option<u64>,
    quote: &str,
    context: Context<'_>,
    author: &str,
    at: &str,
    text: &str,
) -> String {
    let quoted: String = quote.lines().map(|l| format!("> {l}\n")).collect();
    let mut attrs = String::new();
    if let Some(deadline) = until {
        attrs.push_str(&format!(" until={deadline}"));
    }
    if !context.prefix.is_empty() {
        attrs.push_str(&format!(" pre={}", escape_attr(context.prefix)));
    }
    if !context.suffix.is_empty() {
        attrs.push_str(&format!(" suf={}", escape_attr(context.suffix)));
    }
    format!(
        "<!-- mdmini:c id={id} status={status} line={line}{attrs} -->\n{quoted}\n**{author}** · {at}\n{text}\n",
        status = status.as_str()
    )
}

/// Append a new thread to the end of the file, creating it with a header if needed.
pub fn append_thread(
    doc: &Path,
    id: &str,
    line: usize,
    quote: &str,
    author: &str,
    text: &str,
) -> Result<(), String> {
    append_thread_ctx(doc, id, line, quote, Context::default(), author, text)
}

/// Like [`append_thread`], but records the text surrounding the quote so the
/// thread can be re-found after the document moves. See `anchorPosition`.
pub fn append_thread_ctx(
    doc: &Path,
    id: &str,
    line: usize,
    quote: &str,
    context: Context<'_>,
    author: &str,
    text: &str,
) -> Result<(), String> {
    append_thread_ctx_at(doc, id, line, quote, context, author, text, &fmt_utc(now_epoch()))
}

/// Like [`append_thread`], but the reply's timestamp is given explicitly
/// instead of read from the clock. Needed by the format test: it compares
/// the result byte-for-byte against a fixture, and `now_epoch()` inside
/// would make that impossible.
pub fn append_thread_at(
    doc: &Path,
    id: &str,
    line: usize,
    quote: &str,
    author: &str,
    text: &str,
    at: &str,
) -> Result<(), String> {
    append_thread_ctx_at(doc, id, line, quote, Context::default(), author, text, at)
}

/// [`append_thread`] with the context and the timestamp given explicitly.
/// The thread is created `open` — an agent or a hand edit writing a thread is
/// writing a finished question. The app's own creation path is
/// [`append_thread_paused`]: there the human is still typing it.
#[allow(clippy::too_many_arguments)]
pub fn append_thread_ctx_at(
    doc: &Path,
    id: &str,
    line: usize,
    quote: &str,
    context: Context<'_>,
    author: &str,
    text: &str,
    at: &str,
) -> Result<(), String> {
    append_thread_full(doc, id, line, quote, context, author, text, at, Status::Open, None)
}

/// Create a thread that is being typed: `paused`, with a deadline `PAUSE_SECS`
/// from now.
///
/// Pausing has to happen in the same write that creates the thread. Creating
/// it `open` and pausing it a moment later leaves a window — however short —
/// in which `mdmini watch` sees an open thread and wakes an agent on a comment
/// whose first word is all that has been typed. That window is exactly the bug
/// this feature exists to close, so there must not be one.
#[allow(clippy::too_many_arguments)]
pub fn append_thread_paused(
    doc: &Path,
    id: &str,
    line: usize,
    quote: &str,
    context: Context<'_>,
    author: &str,
    text: &str,
) -> Result<u64, String> {
    let now = now_epoch();
    let until = now + PAUSE_SECS;
    append_thread_full(
        doc,
        id,
        line,
        quote,
        context,
        author,
        text,
        &fmt_utc(now),
        Status::Paused,
        Some(until),
    )?;
    Ok(until)
}

/// The one that does the work: every `append_thread*` lands here.
#[allow(clippy::too_many_arguments)]
fn append_thread_full(
    doc: &Path,
    id: &str,
    line: usize,
    quote: &str,
    context: Context<'_>,
    author: &str,
    text: &str,
    at: &str,
    status: Status,
    until: Option<u64>,
) -> Result<(), String> {
    guard_not_sidecar(doc)?;
    let path = sidecar_path(doc).ok_or_else(|| "bad document path".to_string())?;
    let doc_name = doc
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "bad document path".to_string())?;

    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut out = if existing.trim().is_empty() {
        format!("<!-- mdmini:comments v=1 doc={doc_name} -->\n")
    } else {
        let mut e = existing;
        if !e.ends_with('\n') {
            e.push('\n');
        }
        e
    };
    out.push('\n');
    out.push_str(&render_thread(id, status, line, until, quote, context, author, at, text));
    write_atomic(&path, &out)
}

/// Find a thread's marker line by id. Returns the line index.
fn marker_line_index(lines: &[&str], id: &str) -> Option<usize> {
    lines.iter().position(|line| {
        line.trim_start().starts_with(THREAD_MARKER) && line.contains(&format!("id={id} "))
    })
}

/// Append a reply to the end of the given thread and move it to `answered`.
///
/// The insertion happens right before the next thread marker (or at the end
/// of the file), so the rest of the file is not rewritten — important since
/// it's edited by hand.
pub fn append_reply(doc: &Path, id: &str, author: &str, text: &str) -> Result<(), String> {
    append_reply_at(doc, id, author, text, &fmt_utc(now_epoch()))
}

/// Like [`append_reply`], but the timestamp is given explicitly — see [`append_thread_at`].
pub fn append_reply_at(doc: &Path, id: &str, author: &str, text: &str, at: &str) -> Result<(), String> {
    let path = sidecar_path(doc).ok_or_else(|| "bad document path".to_string())?;
    let existing = std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read {}: {e}", path.display()))?;
    let lines: Vec<&str> = existing.lines().collect();
    let start = marker_line_index(&lines, id).ok_or_else(|| format!("unknown comment id: {id}"))?;

    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| line.trim_start().starts_with(THREAD_MARKER))
        .map(|(i, _)| i)
        .unwrap_or(lines.len());

    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    // An answer ends whatever the thread was waiting for, including a pause
    // the human left half-typed — so the deadline goes with it. Leaving
    // `until=` behind would make the thread look pausable to a later reader.
    out[start] = rewrite_marker(&out[start], Status::Answered, None);

    let block = format!("\n**{author}** · {at}\n{text}");
    let mut insert_at = end;
    while insert_at > start + 1 && out[insert_at - 1].trim().is_empty() {
        insert_at -= 1;
    }
    for (offset, line) in block.lines().enumerate() {
        out.insert(insert_at + offset, line.to_string());
    }

    write_atomic(&path, &format!("{}\n", out.join("\n")))
}

/// The author md-mini writes for the person using it. A trailing reply by
/// this author is the one the comment box edits in place — see
/// [`set_last_reply`].
pub const SELF_AUTHOR: &str = "You";

/// Bounds of the thread block with the given id: the marker line index, and
/// the index one past its last line.
fn thread_bounds(lines: &[&str], id: &str) -> Option<(usize, usize)> {
    let start = marker_line_index(lines, id)?;
    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| line.trim_start().starts_with(THREAD_MARKER))
        .map(|(i, _)| i)
        .unwrap_or(lines.len());
    Some((start, end))
}

/// Write `text` as `author`'s reply, replacing their own trailing reply if
/// they already have one.
///
/// This is what makes the comment box an always-editable area rather than a
/// field with a send button (#23): every keystroke run ends up here, and the
/// thread carries one reply per turn instead of one per pause in typing. The
/// in-place branch is also how editing an existing comment works — as long as
/// nobody has answered yet, the last reply is still the author's own.
///
/// An empty `text` is rejected rather than deleting the reply: removing the
/// only reply would leave a thread that `mdmini question` reports as an empty
/// question, and "delete this comment" already has a name — resolve.
pub fn set_last_reply(doc: &Path, id: &str, author: &str, text: &str) -> Result<(), String> {
    set_last_reply_at(doc, id, author, text, &fmt_utc(now_epoch()))
}

/// Like [`set_last_reply`], but the timestamp is given explicitly — see
/// [`append_thread_at`].
pub fn set_last_reply_at(
    doc: &Path,
    id: &str,
    author: &str,
    text: &str,
    at: &str,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("refusing to write an empty comment".to_string());
    }
    let path = sidecar_path(doc).ok_or_else(|| "bad document path".to_string())?;
    let existing = std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read {}: {e}", path.display()))?;
    let lines: Vec<&str> = existing.lines().collect();
    let (start, end) = thread_bounds(&lines, id).ok_or_else(|| format!("unknown comment id: {id}"))?;

    // The author's own trailing reply, if the last reply in the block is
    // theirs. A reply by anyone else in between (the agent answered) means
    // this turn is a new one and must not overwrite the answer.
    let last_header = (start + 1..end)
        .rev()
        .find(|&i| parse_reply_header(lines[i]).is_some());
    let own_trailing = last_header.filter(|&i| {
        parse_reply_header(lines[i]).is_some_and(|(who, _)| who == author)
    });

    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    match own_trailing {
        Some(header) => {
            // Replace the header (the timestamp is the time of this edit) and
            // everything under it up to the end of the block, minus the blank
            // lines separating it from the next thread.
            let mut body_end = end;
            while body_end > header + 1 && out[body_end - 1].trim().is_empty() {
                body_end -= 1;
            }
            let mut block: Vec<String> = vec![format!("**{author}** · {at}")];
            block.extend(text.lines().map(|l| l.to_string()));
            out.splice(header..body_end, block);
        }
        None => {
            let block = format!("\n**{author}** · {at}\n{text}");
            let mut insert_at = end;
            while insert_at > start + 1 && out[insert_at - 1].trim().is_empty() {
                insert_at -= 1;
            }
            for (offset, line) in block.lines().enumerate() {
                out.insert(insert_at + offset, line.to_string());
            }
        }
    }

    write_atomic(&path, &format!("{}\n", out.join("\n")))
}

/// Read the `status=` value from a marker line; `open` if the attribute is
/// missing or spells something this version does not know. Defaulting to
/// `open` rather than refusing is the same bias as [`awaiting`]: a marker we
/// cannot read must not be able to silence a comment.
fn status_in_marker(line: &str) -> Status {
    line.split_whitespace()
        .find_map(|pair| pair.strip_prefix("status="))
        .and_then(Status::parse)
        .unwrap_or(Status::Open)
}

/// Rewrite the `status=` and `until=` attributes of one marker line, leaving
/// every other attribute — including ones this version does not know — exactly
/// where it was.
///
/// A textual `replace("status=x", "status=y")` was enough while `status` was
/// the only thing that ever changed; it is not enough now that a value has to
/// be added and removed as well. `until=` is placed right after `line=`, so
/// the long `pre=`/`suf=` values stay at the end where a human reading the
/// file expects them.
///
/// A line that is not a marker comes back untouched rather than mangled.
fn rewrite_marker(line: &str, status: Status, until: Option<u64>) -> String {
    let trimmed = line.trim_start();
    let indent = &line[..line.len() - trimmed.len()];
    let Some(inner) = trimmed
        .trim_end()
        .strip_prefix(THREAD_MARKER)
        .and_then(|rest| rest.strip_suffix("-->"))
    else {
        return line.to_string();
    };

    let mut tokens: Vec<String> = Vec::new();
    for pair in inner.split_whitespace() {
        let key = pair.split_once('=').map_or(pair, |(k, _)| k);
        match key {
            "status" => tokens.push(format!("status={}", status.as_str())),
            "until" => {} // re-added below, or dropped
            _ => tokens.push(pair.to_string()),
        }
    }
    if let Some(deadline) = until {
        let at = tokens
            .iter()
            .position(|t| t.starts_with("line="))
            .map_or(tokens.len(), |i| i + 1);
        tokens.insert(at, format!("until={deadline}"));
    }
    format!("{indent}{THREAD_MARKER}{} -->", tokens.join(" "))
}

/// Change a thread's status by rewriting exactly one marker line. Any pause
/// deadline is dropped: every status other than `paused` is a state nobody is
/// counting down in.
pub fn set_status(doc: &Path, id: &str, status: Status) -> Result<(), String> {
    set_status_until(doc, id, status, None)
}

/// [`set_status`] with a pause deadline. `until` is only meaningful for
/// [`Status::Paused`].
pub fn set_status_until(
    doc: &Path,
    id: &str,
    status: Status,
    until: Option<u64>,
) -> Result<(), String> {
    let path = sidecar_path(doc).ok_or_else(|| "bad document path".to_string())?;
    let existing = std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read {}: {e}", path.display()))?;
    let lines: Vec<&str> = existing.lines().collect();
    let index = marker_line_index(&lines, id).ok_or_else(|| format!("unknown comment id: {id}"))?;

    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    out[index] = rewrite_marker(&out[index], status, until);
    write_atomic(&path, &format!("{}\n", out.join("\n")))
}

/// Current status of one thread, without parsing the whole file into threads.
/// `None` means the id is not in the file.
pub fn status_of(doc: &Path, id: &str) -> Result<Option<Status>, String> {
    let path = sidecar_path(doc).ok_or_else(|| "bad document path".to_string())?;
    let existing = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("failed to read {}: {e}", path.display())),
    };
    let lines: Vec<&str> = existing.lines().collect();
    Ok(marker_line_index(&lines, id).map(|i| status_in_marker(lines[i])))
}

/// End the pause on one thread now: `paused` becomes `open`, the deadline goes
/// away, and the agent is woken on the next write the watcher sees.
///
/// Anything other than `paused` is left alone, and that is the whole guard
/// against the race in the middle of this feature: while the countdown runs,
/// an agent can answer the thread. Forcing `open` would then undo an answer
/// nobody asked to undo.
///
/// Returns whether anything was written.
pub fn commit_pause(doc: &Path, id: &str) -> Result<bool, String> {
    if status_of(doc, id)? != Some(Status::Paused) {
        return Ok(false);
    }
    set_status_until(doc, id, Status::Open, None)?;
    Ok(true)
}

/// End the pause on every paused thread of one document, in a single write.
///
/// This is the last-resort commit: the window is closing, or the app is
/// quitting, and whatever countdowns were running are about to stop existing.
/// Scoped to one document because another window may well be holding a
/// half-typed comment on a different file.
///
/// Returns the ids that were committed.
pub fn commit_pauses(doc: &Path) -> Result<Vec<String>, String> {
    let path = sidecar_path(doc).ok_or_else(|| "bad document path".to_string())?;
    let existing = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("failed to read {}: {e}", path.display())),
    };

    let mut committed = Vec::new();
    let mut out: Vec<String> = Vec::new();
    for line in existing.lines() {
        if line.trim_start().starts_with(THREAD_MARKER) && status_in_marker(line) == Status::Paused
        {
            if let Some(marker) = parse_marker(line) {
                committed.push(marker.id);
                out.push(rewrite_marker(line, Status::Open, None));
                continue;
            }
        }
        out.push(line.to_string());
    }
    if committed.is_empty() {
        return Ok(committed);
    }
    write_atomic(&path, &format!("{}\n", out.join("\n")))?;
    Ok(committed)
}

/// A thread together with the document it belongs to.
///
/// `Deserialize` is also needed: `AiResponse` derives both traits (it's the
/// CLI client that drives this requirement, since it deserializes the
/// response back), and `threads: Option<Vec<Located>>` inherits it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Located {
    pub doc: PathBuf,
    pub thread: Thread,
}

/// Walk the directory tree and collect every thread that is waiting for an
/// agent — see [`awaiting`] for what that means, and in particular why a
/// `paused` thread whose deadline has passed is included.
///
/// The scope is the tree, not the set of open windows: `question` and
/// `watch` work with the app closed, and the agent's cwd naturally bounds
/// the selection without any separate scoping logic.
///
/// The clock is read once for the whole walk, so two threads that expire in
/// the same scan cannot be judged against different `now`s.
pub fn collect_open(root: &Path) -> Vec<Located> {
    let mut out = Vec::new();
    collect_open_into(root, &mut out, 0, now_epoch());
    out.sort_by(|a, b| a.doc.cmp(&b.doc).then(a.thread.id.cmp(&b.thread.id)));
    out
}

fn collect_open_into(dir: &Path, out: &mut Vec<Located>, depth: usize, now: u64) {
    if depth > 24 {
        return; // guard against symlink cycles
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            // Don't descend into directories that are known not to contain
            // user documents and are expensive to walk.
            if matches!(name.as_ref(), ".git" | "node_modules" | "target") {
                continue;
            }
            collect_open_into(&path, out, depth + 1, now);
            continue;
        }
        if !is_sidecar(&path) {
            continue;
        }
        let Some(doc_name) = name.strip_prefix(".mdmini_comments_") else {
            continue;
        };
        let doc = path.with_file_name(doc_name);
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        for thread in parse(&text) {
            if awaiting(&thread, now) {
                out.push(Located {
                    doc: doc.clone(),
                    thread,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_path_sits_next_to_the_document() {
        let p = sidecar_path(Path::new("/repo/docs/CLAUDE.md")).unwrap();
        assert_eq!(p, PathBuf::from("/repo/docs/.mdmini_comments_CLAUDE.md"));
    }

    #[test]
    fn sidecar_is_recognised_and_a_document_is_not() {
        assert!(is_sidecar(Path::new("/repo/.mdmini_comments_spec.md")));
        assert!(!is_sidecar(Path::new("/repo/spec.md")));
    }

    #[test]
    fn status_round_trips_through_its_string() {
        for s in [Status::Open, Status::Answered, Status::Resolved] {
            assert_eq!(Status::parse(s.as_str()), Some(s));
        }
        assert_eq!(Status::parse("nonsense"), None);
    }

    #[test]
    fn epoch_formats_as_utc_datetime() {
        // 2026-08-24T14:02:03Z
        assert_eq!(fmt_utc(1787580123), "2026-08-24 14:02:03 UTC");
        // Midnight of the epoch — a boundary case for the algorithm.
        assert_eq!(fmt_utc(0), "1970-01-01 00:00:00 UTC");
        // The last second before a leap day.
        assert_eq!(fmt_utc(1709164799), "2024-02-28 23:59:59 UTC");
        assert_eq!(fmt_utc(1709164800), "2024-02-29 00:00:00 UTC");
    }

    #[test]
    fn ids_look_right_and_differ_by_seed() {
        let a = new_id(Path::new("/repo/spec.md"), 1);
        let b = new_id(Path::new("/repo/spec.md"), 2);
        assert!(a.starts_with("c-"), "got {a}");
        assert_eq!(a.len(), 8, "c- plus six hex chars");
        assert!(a.chars().skip(2).all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "different seeds give different ids");
    }

    #[test]
    fn id_is_unique_against_existing_threads() {
        let taken = ["c-000000".to_string()];
        // A chosen seed whose first hash would collide with a taken id should
        // lead to a different result instead of a collision.
        let id = new_id_avoiding(Path::new("/repo/spec.md"), 1, &taken);
        assert!(!taken.contains(&id));
    }

    const SAMPLE: &str = "\
<!-- mdmini:comments v=1 doc=CLAUDE.md -->

<!-- mdmini:c id=c-7f3a2c status=open line=42 -->
> We ship via Caddy on the host

**Макс** · 2026-08-24 14:02
Почему не nginx? Разверни абзац.

**agent (worktree-foo)** · 2026-08-24 14:05
Nginx там был сломан.
Вторая строка ответа.

<!-- mdmini:c id=c-abc123 status=resolved line=7 -->
> заголовок

**Макс** · 2026-08-24 09:00
Мелочь.
";

    #[test]
    fn parses_threads_replies_and_quotes() {
        let threads = parse(SAMPLE);
        assert_eq!(threads.len(), 2);

        let first = &threads[0];
        assert_eq!(first.id, "c-7f3a2c");
        assert_eq!(first.status, Status::Open);
        assert_eq!(first.line, 42);
        assert_eq!(first.quote, "We ship via Caddy on the host");
        assert_eq!(first.replies.len(), 2);
        assert_eq!(first.replies[0].author, "Макс");
        assert_eq!(first.replies[0].at, "2026-08-24 14:02");
        assert_eq!(first.replies[0].text, "Почему не nginx? Разверни абзац.");
        assert_eq!(first.replies[1].author, "agent (worktree-foo)");
        assert_eq!(
            first.replies[1].text,
            "Nginx там был сломан.\nВторая строка ответа."
        );

        assert_eq!(threads[1].id, "c-abc123");
        assert_eq!(threads[1].status, Status::Resolved);
    }

    #[test]
    fn a_broken_marker_is_skipped_without_losing_the_rest() {
        let text = "\
<!-- mdmini:c status=open line=1 -->
> нет id

**Макс** · 14:00
Пропасть.

<!-- mdmini:c id=c-ok0001 status=open line=2 -->
> есть id

**Макс** · 14:01
Остаться.
";
        let threads = parse(text);
        assert_eq!(threads.len(), 1, "the thread without an id is dropped");
        assert_eq!(threads[0].id, "c-ok0001");
    }

    #[test]
    fn unknown_attributes_are_ignored() {
        let text = "<!-- mdmini:c id=c-111111 status=open line=3 future=yes -->\n> q\n\n**Макс** · 14:00\nt\n";
        let threads = parse(text);
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].line, 3);
    }

    #[test]
    fn multiline_quote_is_joined_with_newlines() {
        let text = "<!-- mdmini:c id=c-222222 status=open line=1 -->\n> первая\n> вторая\n\n**Макс** · 14:00\nt\n";
        assert_eq!(parse(text)[0].quote, "первая\nвторая");
    }

    // Every test below shares the name "spec.md". A seed of `now_epoch()` alone
    // (as originally drafted) collides two ways: within one process, parallel
    // tests in the same second hash to the same dir; across processes, two
    // `cargo test` invocations landing in the same second replay an identical
    // seed sequence (the counter also resets to 0) and inherit the previous
    // run's leftover sidecar file instead of starting clean. Mix in the pid for
    // cross-process entropy, and wipe the dir regardless as a last-resort guard.
    fn temp_doc(name: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let seed = now_epoch()
            .wrapping_mul(1_000_003)
            .wrapping_add(std::process::id() as u64)
            .wrapping_add(COUNTER.fetch_add(1, Ordering::Relaxed));
        let dir = std::env::temp_dir().join(format!("mdmini-comments-test-{}", new_id(Path::new(name), seed)));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn append_creates_the_file_with_a_header() {
        let doc = temp_doc("spec.md");
        append_thread(&doc, "c-aaaaaa", 12, "цитата", "Макс", "Вопрос?").unwrap();

        let text = std::fs::read_to_string(sidecar_path(&doc).unwrap()).unwrap();
        assert!(text.starts_with("<!-- mdmini:comments v=1 doc=spec.md -->"));
        let threads = parse(&text);
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].id, "c-aaaaaa");
        assert_eq!(threads[0].status, Status::Open);
        assert_eq!(threads[0].quote, "цитата");
        assert_eq!(threads[0].replies[0].text, "Вопрос?");
    }

    #[test]
    fn append_reply_lands_in_the_right_thread_and_sets_answered() {
        let doc = temp_doc("spec.md");
        append_thread(&doc, "c-aaaaaa", 1, "q1", "Макс", "Первый?").unwrap();
        append_thread(&doc, "c-bbbbbb", 2, "q2", "Макс", "Второй?").unwrap();

        append_reply(&doc, "c-aaaaaa", "agent", "Ответ на первый.").unwrap();

        let threads = load(&doc).unwrap();
        assert_eq!(threads[0].replies.len(), 2);
        assert_eq!(threads[0].replies[1].author, "agent");
        assert_eq!(threads[0].status, Status::Answered, "a reply moves it to answered");
        assert_eq!(threads[1].replies.len(), 1, "the second thread is untouched");
        assert_eq!(threads[1].status, Status::Open);
    }

    #[test]
    fn set_status_rewrites_only_the_marker() {
        let doc = temp_doc("spec.md");
        append_thread(&doc, "c-aaaaaa", 5, "q", "Макс", "Вопрос?").unwrap();
        let before = std::fs::read_to_string(sidecar_path(&doc).unwrap()).unwrap();

        set_status(&doc, "c-aaaaaa", Status::Resolved).unwrap();

        let after = std::fs::read_to_string(sidecar_path(&doc).unwrap()).unwrap();
        assert_eq!(load(&doc).unwrap()[0].status, Status::Resolved);
        assert_eq!(
            before.lines().count(),
            after.lines().count(),
            "exactly one line changed, the file's structure is the same"
        );
        assert!(after.contains("Вопрос?"), "reply text is intact");
    }

    #[test]
    fn answering_an_unknown_id_is_an_error_and_leaves_the_file_alone() {
        let doc = temp_doc("spec.md");
        append_thread(&doc, "c-aaaaaa", 1, "q", "Макс", "Вопрос?").unwrap();
        let before = std::fs::read_to_string(sidecar_path(&doc).unwrap()).unwrap();

        let err = append_reply(&doc, "c-nope00", "agent", "мимо").unwrap_err();
        assert!(err.contains("c-nope00"), "the error names the id: {err}");
        assert_eq!(
            std::fs::read_to_string(sidecar_path(&doc).unwrap()).unwrap(),
            before
        );
    }

    #[test]
    fn a_comment_file_cannot_itself_be_commented() {
        let doc = temp_doc(".mdmini_comments_spec.md");
        let err = append_thread(&doc, "c-aaaaaa", 1, "q", "Макс", "?").unwrap_err();
        assert!(err.contains("comment file"), "got {err}");
    }

    #[test]
    fn collect_open_walks_the_tree_and_returns_only_open_threads() {
        let doc = temp_doc("spec.md");
        append_thread(&doc, "c-open01", 1, "q1", "Макс", "Открыт?").unwrap();
        append_thread(&doc, "c-done01", 2, "q2", "Макс", "Закрыт?").unwrap();
        set_status(&doc, "c-done01", Status::Resolved).unwrap();

        let found = collect_open(doc.parent().unwrap());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].thread.id, "c-open01");
        assert_eq!(found[0].doc, doc);
    }

    #[test]
    fn escaping_survives_the_characters_that_would_break_a_marker() {
        // A space would split the value into two attributes, and `>` could
        // spell `-->` and end the comment early. Cyrillic must stay readable.
        let raw = "в таблице: 100% > всего\nи перенос";
        let escaped = escape_attr(raw);
        assert!(!escaped.contains(' '));
        assert!(!escaped.contains('>'));
        assert!(!escaped.contains('\n'));
        assert!(escaped.contains("таблице"), "Cyrillic must not be encoded: {escaped}");
        assert_eq!(unescape_attr(&escaped), raw);
    }

    #[test]
    fn unescaping_leaves_a_hand_written_stray_percent_alone() {
        assert_eq!(unescape_attr("100%"), "100%");
        assert_eq!(unescape_attr("%zz"), "%zz");
    }

    #[test]
    fn context_round_trips_through_the_file() {
        let doc = temp_doc("spec.md");
        append_thread_ctx(
            &doc,
            "c-aaaaaa",
            12,
            "Табы",
            Context {
                prefix: "в таблице: ",
                suffix: " и отступы",
            },
            "Макс",
            "Вопрос?",
        )
        .unwrap();
        let threads = load(&doc).unwrap();
        assert_eq!(threads[0].prefix.as_deref(), Some("в таблице: "));
        assert_eq!(threads[0].suffix.as_deref(), Some(" и отступы"));
    }

    #[test]
    fn a_thread_without_context_reads_back_as_none_not_as_empty() {
        // The distinction matters to the frontend: `None` means "resolve by
        // the line hint", not "the fragment sits at the start of the file".
        let doc = temp_doc("spec.md");
        append_thread(&doc, "c-aaaaaa", 12, "цитата", "Макс", "Вопрос?").unwrap();
        let threads = load(&doc).unwrap();
        assert_eq!(threads[0].prefix, None);
        assert_eq!(threads[0].suffix, None);
        let raw = std::fs::read_to_string(sidecar_path(&doc).unwrap()).unwrap();
        assert!(!raw.contains("pre="), "no empty attribute should be written: {raw}");
    }

    #[test]
    fn context_head_and_tail_never_split_a_multibyte_character() {
        let long = "я".repeat(100);
        assert_eq!(context_head(&long).chars().count(), ANCHOR_CONTEXT);
        assert_eq!(context_tail(&long).chars().count(), ANCHOR_CONTEXT);
        assert_eq!(context_head("аб"), "аб");
        assert_eq!(context_tail("аб"), "аб");
    }

    #[test]
    fn set_last_reply_rewrites_the_authors_own_trailing_reply_in_place() {
        let doc = temp_doc("spec.md");
        append_thread(&doc, "c-aaaaaa", 1, "цитата", SELF_AUTHOR, "Поч").unwrap();
        set_last_reply(&doc, "c-aaaaaa", SELF_AUTHOR, "Почему не nginx?").unwrap();
        let threads = load(&doc).unwrap();
        // One reply, not two: typing is not a sequence of separate comments.
        assert_eq!(threads[0].replies.len(), 1);
        assert_eq!(threads[0].replies[0].text, "Почему не nginx?");
    }

    #[test]
    fn set_last_reply_starts_a_new_turn_under_an_agent_answer() {
        let doc = temp_doc("spec.md");
        append_thread(&doc, "c-aaaaaa", 1, "цитата", SELF_AUTHOR, "Почему не nginx?").unwrap();
        append_reply(&doc, "c-aaaaaa", "agent", "Он был сломан.").unwrap();
        set_last_reply(&doc, "c-aaaaaa", SELF_AUTHOR, "А теперь?").unwrap();
        let threads = load(&doc).unwrap();
        // The answer must survive: an agent reply between the turns is exactly
        // what makes the previous one finished.
        assert_eq!(threads[0].replies.len(), 3);
        assert_eq!(threads[0].replies[1].text, "Он был сломан.");
        assert_eq!(threads[0].replies[2].author, SELF_AUTHOR);
        assert_eq!(threads[0].replies[2].text, "А теперь?");
    }

    #[test]
    fn set_last_reply_keeps_a_multi_line_body_whole() {
        let doc = temp_doc("spec.md");
        append_thread(&doc, "c-aaaaaa", 1, "цитата", SELF_AUTHOR, "первая").unwrap();
        set_last_reply(&doc, "c-aaaaaa", SELF_AUTHOR, "первая\nвторая\nтретья").unwrap();
        let threads = load(&doc).unwrap();
        assert_eq!(threads[0].replies[0].text, "первая\nвторая\nтретья");
    }

    #[test]
    fn set_last_reply_does_not_touch_a_neighbouring_thread() {
        let doc = temp_doc("spec.md");
        append_thread(&doc, "c-aaaaaa", 1, "q1", SELF_AUTHOR, "первый").unwrap();
        append_thread(&doc, "c-bbbbbb", 2, "q2", SELF_AUTHOR, "второй").unwrap();
        set_last_reply(&doc, "c-aaaaaa", SELF_AUTHOR, "первый, переписанный").unwrap();
        let threads = load(&doc).unwrap();
        assert_eq!(threads.len(), 2);
        assert_eq!(threads[0].replies[0].text, "первый, переписанный");
        assert_eq!(threads[1].replies[0].text, "второй");
        assert_eq!(threads[1].quote, "q2");
    }

    #[test]
    fn set_last_reply_refuses_to_write_an_empty_comment() {
        let doc = temp_doc("spec.md");
        append_thread(&doc, "c-aaaaaa", 1, "цитата", SELF_AUTHOR, "текст").unwrap();
        assert!(set_last_reply(&doc, "c-aaaaaa", SELF_AUTHOR, "   ").is_err());
        // The previously saved text is still there — clearing the box is not
        // a way to delete a comment, resolving is.
        assert_eq!(load(&doc).unwrap()[0].replies[0].text, "текст");
    }

    #[test]
    fn set_last_reply_on_an_unknown_id_is_an_error_not_a_silent_no_op() {
        let doc = temp_doc("spec.md");
        append_thread(&doc, "c-aaaaaa", 1, "цитата", SELF_AUTHOR, "текст").unwrap();
        assert!(set_last_reply(&doc, "c-nope00", SELF_AUTHOR, "мимо").is_err());
    }

    /// Cross-language contract for the format: this test must generate
    /// exactly `src/lib/__fixtures__/comments-contract.md`, byte for byte.
    /// The mirror test on the TypeScript side (`comment-contract.test.ts`)
    /// parses the same file. One fixture for both languages — a format
    /// change on one side breaks the test on the other, and that's the only
    /// signal we have: without it a format divergence silently kills comment
    /// rendering without failing either language's test suite on its own.
    #[test]
    fn generates_the_shared_contract_fixture_byte_for_byte() {
        const FIXTURE: &str =
            include_str!("../../src/lib/__fixtures__/comments-contract.md");

        let doc = temp_doc("spec.md");
        append_thread_at(
            &doc,
            "c-aaaaaa",
            12,
            "We ship via Caddy on the host",
            "Вы",
            "Почему не nginx? Разверни абзац.",
            "2026-08-24 14:02:00 UTC",
        )
        .unwrap();
        append_thread_at(
            &doc,
            "c-bbbbbb",
            27,
            "первая строка цитаты\nвторая строка цитаты",
            "Вы",
            "Тут точно нужен отдельный раздел?",
            "2026-08-24 15:10:00 UTC",
        )
        .unwrap();
        append_thread_ctx_at(
            &doc,
            "c-cccccc",
            157,
            "Табы",
            Context {
                prefix: "в таблице горячих клавиш: ",
                suffix: " и отступы в списках",
            },
            "Вы",
            "Тут про клавишу или про отступ?",
            "2026-08-24 16:00:00 UTC",
        )
        .unwrap();
        append_reply_at(
            &doc,
            "c-aaaaaa",
            "agent",
            "Nginx на этом хосте был сломан.\nПоэтому переехали на Caddy.",
            "2026-08-24 14:05:00 UTC",
        )
        .unwrap();

        let generated = std::fs::read_to_string(sidecar_path(&doc).unwrap()).unwrap();
        assert_eq!(generated, FIXTURE, "generated file must match the shared fixture byte-for-byte");
    }

    // --- the pause while a human is typing (#36) ---

    fn paused_thread(until: Option<u64>) -> Thread {
        Thread {
            id: "c-aaaaaa".to_string(),
            status: Status::Paused,
            line: 1,
            quote: "цитата".to_string(),
            prefix: None,
            suffix: None,
            until,
            replies: Vec::new(),
        }
    }

    #[test]
    fn a_pause_with_time_left_is_not_awaiting_and_an_expired_one_is() {
        let thread = paused_thread(Some(1_000));
        assert!(!awaiting(&thread, 999), "still being typed");
        assert!(awaiting(&thread, 1_000), "the deadline itself counts");
        assert!(awaiting(&thread, 1_001));
    }

    #[test]
    fn a_pause_with_no_deadline_is_delivered_rather_than_lost() {
        // Hand-written, or written by a version that recorded no deadline.
        // Never waking an agent is the worse failure of the two.
        assert!(awaiting(&paused_thread(None), 0));
    }

    #[test]
    fn only_open_and_expired_pauses_await_an_agent() {
        let mut thread = paused_thread(None);
        for (status, expected) in [
            (Status::Open, true),
            (Status::Answered, false),
            (Status::Resolved, false),
        ] {
            thread.status = status;
            assert_eq!(awaiting(&thread, 0), expected, "{status:?}");
        }
    }

    #[test]
    fn editing_an_open_thread_does_not_take_the_wake_up_back() {
        // The point of no return: the agent has been told, and may already be
        // writing. Pausing again would let its answer overwrite the pause and
        // leave the new text unannounced.
        assert_eq!(status_after_edit(Status::Open), Status::Open);
    }

    #[test]
    fn editing_anything_not_yet_handed_over_pauses_it() {
        assert_eq!(status_after_edit(Status::Paused), Status::Paused);
        assert_eq!(status_after_edit(Status::Answered), Status::Paused);
        assert_eq!(status_after_edit(Status::Resolved), Status::Paused);
    }

    #[test]
    fn a_thread_created_by_the_app_is_born_paused_with_a_deadline() {
        let doc = temp_doc("spec.md");
        let until = append_thread_paused(
            &doc,
            "c-aaaaaa",
            3,
            "цитата",
            Context::default(),
            SELF_AUTHOR,
            "перв",
        )
        .unwrap();
        let threads = load(&doc).unwrap();
        assert_eq!(threads[0].status, Status::Paused);
        assert_eq!(threads[0].until, Some(until));
        assert!(until >= now_epoch(), "the deadline is in the future");
        let text = std::fs::read_to_string(sidecar_path(&doc).unwrap()).unwrap();
        assert!(text.contains("status=paused"), "{text}");
        assert!(text.contains(&format!("until={until}")), "{text}");
    }

    #[test]
    fn a_paused_thread_is_invisible_to_watch_until_its_deadline_passes() {
        let doc = temp_doc("spec.md");
        append_thread_paused(&doc, "c-aaaaaa", 1, "q", Context::default(), SELF_AUTHOR, "пишу")
            .unwrap();
        let dir = doc.parent().unwrap();
        assert!(
            collect_open(dir).is_empty(),
            "a comment still being typed must not wake anyone"
        );

        // The app never got to commit it — closed, or killed. The deadline in
        // the file is what delivers it anyway.
        set_status_until(&doc, "c-aaaaaa", Status::Paused, Some(now_epoch() - 1)).unwrap();
        let open = collect_open(dir);
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].thread.id, "c-aaaaaa");
    }

    #[test]
    fn committing_a_pause_opens_it_and_drops_the_deadline() {
        let doc = temp_doc("spec.md");
        append_thread_paused(&doc, "c-aaaaaa", 1, "q", Context::default(), SELF_AUTHOR, "текст")
            .unwrap();
        assert!(commit_pause(&doc, "c-aaaaaa").unwrap());

        let threads = load(&doc).unwrap();
        assert_eq!(threads[0].status, Status::Open);
        assert_eq!(threads[0].until, None, "nothing is counting down any more");
        assert_eq!(collect_open(doc.parent().unwrap()).len(), 1);
    }

    #[test]
    fn committing_does_not_reopen_a_thread_the_agent_answered_meanwhile() {
        let doc = temp_doc("spec.md");
        append_thread_paused(&doc, "c-aaaaaa", 1, "q", Context::default(), SELF_AUTHOR, "вопрос")
            .unwrap();
        // The agent answered while the countdown was still running.
        append_reply(&doc, "c-aaaaaa", "agent", "ответ").unwrap();
        assert!(!commit_pause(&doc, "c-aaaaaa").unwrap(), "nothing to commit");
        assert_eq!(load(&doc).unwrap()[0].status, Status::Answered);
    }

    #[test]
    fn an_answer_clears_the_pause_deadline() {
        let doc = temp_doc("spec.md");
        append_thread_paused(&doc, "c-aaaaaa", 1, "q", Context::default(), SELF_AUTHOR, "вопрос")
            .unwrap();
        append_reply(&doc, "c-aaaaaa", "agent", "ответ").unwrap();
        let threads = load(&doc).unwrap();
        assert_eq!(threads[0].status, Status::Answered);
        assert_eq!(threads[0].until, None);
    }

    #[test]
    fn closing_a_document_commits_every_pause_on_it_at_once() {
        let doc = temp_doc("spec.md");
        append_thread_paused(&doc, "c-aaaaaa", 1, "q1", Context::default(), SELF_AUTHOR, "раз")
            .unwrap();
        append_thread_paused(&doc, "c-bbbbbb", 2, "q2", Context::default(), SELF_AUTHOR, "два")
            .unwrap();
        append_thread(&doc, "c-cccccc", 3, "q3", SELF_AUTHOR, "три").unwrap();
        set_status(&doc, "c-cccccc", Status::Resolved).unwrap();

        let mut committed = commit_pauses(&doc).unwrap();
        committed.sort();
        assert_eq!(committed, vec!["c-aaaaaa".to_string(), "c-bbbbbb".to_string()]);

        let threads = load(&doc).unwrap();
        assert_eq!(threads[0].status, Status::Open);
        assert_eq!(threads[1].status, Status::Open);
        assert_eq!(threads[2].status, Status::Resolved, "untouched");
        assert!(threads.iter().all(|t| t.until.is_none()));
    }

    #[test]
    fn committing_a_document_with_nothing_paused_writes_nothing() {
        let doc = temp_doc("spec.md");
        append_thread(&doc, "c-aaaaaa", 1, "q", SELF_AUTHOR, "текст").unwrap();
        let before = std::fs::read_to_string(sidecar_path(&doc).unwrap()).unwrap();
        assert!(commit_pauses(&doc).unwrap().is_empty());
        let after = std::fs::read_to_string(sidecar_path(&doc).unwrap()).unwrap();
        assert_eq!(before, after, "no write, so no event for any watcher");
    }

    #[test]
    fn commit_on_a_document_with_no_sidecar_is_not_an_error() {
        let doc = temp_doc("spec.md");
        assert!(commit_pauses(&doc).unwrap().is_empty());
    }

    #[test]
    fn rewriting_a_marker_keeps_every_other_attribute_including_unknown_ones() {
        let line = "<!-- mdmini:c id=c-1 status=open line=7 future=yes pre=a%20b suf=c -->";
        let paused = rewrite_marker(line, Status::Paused, Some(1_700_000_000));
        assert_eq!(
            paused,
            "<!-- mdmini:c id=c-1 status=paused line=7 until=1700000000 future=yes pre=a%20b suf=c -->"
        );
        // And back, with the deadline gone.
        assert_eq!(rewrite_marker(&paused, Status::Open, None), line);
    }

    #[test]
    fn rewriting_leaves_a_line_that_is_not_a_marker_alone() {
        let line = "просто текст со словом status=open внутри";
        assert_eq!(rewrite_marker(line, Status::Resolved, None), line);
    }

    #[test]
    fn a_deadline_survives_a_round_trip_through_the_file() {
        let doc = temp_doc("spec.md");
        append_thread(&doc, "c-aaaaaa", 1, "q", SELF_AUTHOR, "текст").unwrap();
        set_status_until(&doc, "c-aaaaaa", Status::Paused, Some(1_787_580_123)).unwrap();
        assert_eq!(load(&doc).unwrap()[0].until, Some(1_787_580_123));
        assert_eq!(status_of(&doc, "c-aaaaaa").unwrap(), Some(Status::Paused));
    }

    #[test]
    fn status_of_answers_none_for_an_id_that_is_not_there() {
        let doc = temp_doc("spec.md");
        append_thread(&doc, "c-aaaaaa", 1, "q", SELF_AUTHOR, "текст").unwrap();
        assert_eq!(status_of(&doc, "c-nope00").unwrap(), None);
        assert_eq!(status_of(&temp_doc("other.md"), "c-aaaaaa").unwrap(), None);
    }

    /// An older sidecar has no `paused` and no `until` anywhere in it. Nothing
    /// about it may change meaning, or an upgrade would silently reshuffle
    /// which threads an agent is woken for.
    #[test]
    fn a_sidecar_written_before_pausing_existed_still_reads_the_same() {
        let threads = parse(SAMPLE);
        assert_eq!(threads[0].status, Status::Open);
        assert_eq!(threads[0].until, None);
        assert!(awaiting(&threads[0], now_epoch()));
        assert_eq!(threads[1].status, Status::Resolved);
        assert!(!awaiting(&threads[1], now_epoch()));
    }
}
