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
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Open,
    Answered,
    Resolved,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Open => "open",
            Status::Answered => "answered",
            Status::Resolved => "resolved",
        }
    }

    pub fn parse(s: &str) -> Option<Status> {
        match s {
            "open" => Some(Status::Open),
            "answered" => Some(Status::Answered),
            "resolved" => Some(Status::Resolved),
            _ => None,
        }
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
}

/// Parse `k=v` attributes from a thread marker line.
fn parse_marker(line: &str) -> Option<Marker> {
    let inner = line.trim().strip_prefix(THREAD_MARKER)?.strip_suffix("-->")?;
    let mut id = None;
    let mut status = None;
    let mut num = None;
    let mut prefix = None;
    let mut suffix = None;
    for pair in inner.split_whitespace() {
        let (key, value) = pair.split_once('=')?;
        match key {
            "id" => id = Some(value.to_string()),
            "status" => status = Status::parse(value),
            "line" => num = value.parse::<usize>().ok(),
            "pre" => prefix = Some(unescape_attr(value)),
            "suf" => suffix = Some(unescape_attr(value)),
            _ => {} // unknown attributes are ignored intentionally
        }
    }
    Some(Marker {
        id: id?,
        status: status?,
        line: num.unwrap_or(1),
        prefix,
        suffix,
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
/// `pre=`/`suf=` are written only when there is context to write. An empty
/// attribute would carry no information and would still have to be read back,
/// and leaving it out keeps the marker of a hand-written thread identical to
/// what a person would type.
fn render_thread(
    id: &str,
    status: Status,
    line: usize,
    quote: &str,
    context: Context<'_>,
    author: &str,
    at: &str,
    text: &str,
) -> String {
    let quoted: String = quote.lines().map(|l| format!("> {l}\n")).collect();
    let mut attrs = String::new();
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

/// The one that does the work: [`append_thread`] with both the context and
/// the timestamp given explicitly.
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
    out.push_str(&render_thread(id, Status::Open, line, quote, context, author, at, text));
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
    out[start] = out[start].replace(
        &format!("status={}", status_in_marker(&out[start])),
        &format!("status={}", Status::Answered.as_str()),
    );

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

/// Read the `status=` value from a marker line; `open` if the attribute is missing.
fn status_in_marker(line: &str) -> &str {
    line.split_whitespace()
        .find_map(|pair| pair.strip_prefix("status="))
        .unwrap_or("open")
}

/// Change a thread's status by rewriting exactly one marker line.
pub fn set_status(doc: &Path, id: &str, status: Status) -> Result<(), String> {
    let path = sidecar_path(doc).ok_or_else(|| "bad document path".to_string())?;
    let existing = std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read {}: {e}", path.display()))?;
    let lines: Vec<&str> = existing.lines().collect();
    let index = marker_line_index(&lines, id).ok_or_else(|| format!("unknown comment id: {id}"))?;

    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    let old = status_in_marker(&out[index]).to_string();
    out[index] = out[index].replace(&format!("status={old}"), &format!("status={}", status.as_str()));
    write_atomic(&path, &format!("{}\n", out.join("\n")))
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

/// Walk the directory tree and collect all threads with status `open`.
///
/// The scope is the tree, not the set of open windows: `question` and
/// `watch` work with the app closed, and the agent's cwd naturally bounds
/// the selection without any separate scoping logic.
pub fn collect_open(root: &Path) -> Vec<Located> {
    let mut out = Vec::new();
    collect_open_into(root, &mut out, 0);
    out.sort_by(|a, b| a.doc.cmp(&b.doc).then(a.thread.id.cmp(&b.thread.id)));
    out
}

fn collect_open_into(dir: &Path, out: &mut Vec<Located>, depth: usize) {
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
            collect_open_into(&path, out, depth + 1);
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
            if thread.status == Status::Open {
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
}
