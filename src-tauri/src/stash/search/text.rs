//! What the index stores for an entry: the text a reader sees — markdown
//! markers gone, link URLs kept — from at most `BODY_CAP_BYTES` of the file.
//! Snippets are cut from this same text, so a hit and its snippet always
//! agree.

use std::io::Read;
use std::path::Path;

use crate::stash::entries::open_readable_now;

/// At most this much of a file is read and indexed (1 MiB). A stash entry can
/// reference any file — a log, a dump — and one put-away must not read
/// gigabytes. Past the cap a file is still found by its title and by what its
/// first MiB says.
pub const BODY_CAP_BYTES: usize = 1024 * 1024;

/// A NUL in the first 8 KiB means binary: the title is indexed, the body not.
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum Loaded {
    Text(String),
    Binary,
    Unreadable(String),
}

/// At most `BODY_CAP_BYTES` of a file, opened through stage 02's guard: a
/// FIFO, a device or a dataless iCloud file is `Unreadable` at once instead of
/// hanging the indexer.
pub fn read_capped(path: &Path) -> Loaded {
    let file = match open_readable_now(path) {
        Ok(f) => f,
        Err(e) => return Loaded::Unreadable(e),
    };
    let mut buf = Vec::new();
    if let Err(e) = file.take(BODY_CAP_BYTES as u64).read_to_end(&mut buf) {
        return Loaded::Unreadable(e.to_string());
    }
    if buf[..buf.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
        return Loaded::Binary;
    }
    // Lossy, unlike a preview: a char cut by the cap, or a non-UTF-8 file,
    // still indexes.
    Loaded::Text(String::from_utf8_lossy(&buf).into_owned())
}

/// `text` cut to `BODY_CAP_BYTES` on a char boundary — the in-memory twin of
/// `read_capped`, for text that just came from a save.
pub fn cap(text: &str) -> &str {
    if text.len() <= BODY_CAP_BYTES {
        return text;
    }
    let mut end = BODY_CAP_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

pub fn is_markdown_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    [".md", ".markdown", ".mdown", ".mkd"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// Non-empty lines as a reader sees them, joined with '\n'. For markdown the
/// same rules as the tabs drawer's `plainLine` (`src/lib/tabs/drawer-filter.ts`),
/// except that a link keeps its URL: agents search for addresses.
pub fn plain_text(text: &str, markdown: bool) -> String {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut out: Vec<String> = Vec::new();
    let mut in_code = false;
    for raw in text.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        if markdown && is_fence(raw) {
            in_code = !in_code;
            continue;
        }
        // Inside a fence `#` and `*` are code, not markup.
        let line = if markdown && !in_code {
            plain_line(raw)
        } else {
            raw.trim().to_string()
        };
        if !line.is_empty() {
            out.push(line);
        }
    }
    out.join("\n")
}

fn is_fence(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("```") || t.starts_with("~~~")
}

fn plain_line(line: &str) -> String {
    let s = strip_heading(line);
    let s = strip_task(s);
    let s = strip_list(s);
    let s = strip_quote(s);
    unlink(s)
        .replace("**", "")
        .replace("~~", "")
        .replace(['`', '*'], "")
        .trim()
        .to_string()
}

/// `^#{1,6}\s+` — `#tag` (no space) is text, not a heading.
fn strip_heading(s: &str) -> &str {
    let hashes = s.bytes().take_while(|&b| b == b'#').count();
    if (1..=6).contains(&hashes) {
        let rest = &s[hashes..];
        let trimmed = rest.trim_start();
        if trimmed.len() < rest.len() {
            return trimmed;
        }
    }
    s
}

/// `^\s*[-*+] \[[ xX]\] `
fn strip_task(s: &str) -> &str {
    let t = s.trim_start();
    let b = t.as_bytes();
    if b.len() >= 6
        && matches!(b[0], b'-' | b'*' | b'+')
        && b[1] == b' '
        && b[2] == b'['
        && matches!(b[3], b' ' | b'x' | b'X')
        && b[4] == b']'
        && b[5] == b' '
    {
        &t[6..]
    } else {
        s
    }
}

/// `^\s*(?:[-*+]|\d+\.) `
fn strip_list(s: &str) -> &str {
    let t = s.trim_start();
    let b = t.as_bytes();
    if b.len() >= 2 && matches!(b[0], b'-' | b'*' | b'+') && b[1] == b' ' {
        return &t[2..];
    }
    let digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 && b.len() >= digits + 2 && b[digits] == b'.' && b[digits + 1] == b' ' {
        return &t[digits + 2..];
    }
    s
}

/// `^>\s?`
fn strip_quote(s: &str) -> &str {
    match s.strip_prefix('>') {
        Some(r) => r.strip_prefix(' ').unwrap_or(r),
        None => s,
    }
}

/// `[label](url)` → `label (url)`; `[label]()` → `label`.
fn unlink(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(open) = rest.find('[') {
        let after = &rest[open + 1..];
        let Some(close) = after.find(']') else { break };
        let label = &after[..close];
        let tail = &after[close + 1..];
        if !label.is_empty() && tail.starts_with('(') {
            if let Some(end) = tail.find(')') {
                let url = &tail[1..end];
                out.push_str(&rest[..open]);
                out.push_str(label);
                if !url.is_empty() {
                    out.push_str(" (");
                    out.push_str(url);
                    out.push(')');
                }
                rest = &tail[end + 1..];
                continue;
            }
        }
        out.push_str(&rest[..open + 1]);
        rest = after;
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atomic_write::testkit::scratch;
    use std::fs;

    #[test]
    fn markdown_markers_are_stripped_and_link_urls_kept() {
        let md = "# Тайник\n\n- [x] **жирный** пункт\n1. `код` и *курсив*\n> цитата\n[сайт](https://couplet.pro) ~~старое~~";
        assert_eq!(
            plain_text(md, true),
            "Тайник\nжирный пункт\nкод и курсив\nцитата\nсайт (https://couplet.pro) старое"
        );
    }

    #[test]
    fn fence_lines_are_dropped_and_code_kept_verbatim() {
        let md = "до\n```rust\n# not a heading\n  let x = 1;\n```\nпосле";
        assert_eq!(
            plain_text(md, true),
            "до\n# not a heading\nlet x = 1;\nпосле"
        );
    }

    #[test]
    fn crlf_bom_and_blank_lines_are_normalized() {
        assert_eq!(
            plain_text("\u{feff}один\r\n\r\n  два  \r\n", true),
            "один\nдва"
        );
    }

    #[test]
    fn a_tag_line_is_not_a_heading() {
        assert_eq!(plain_text("#infra заметка", true), "#infra заметка");
    }

    #[test]
    fn non_markdown_text_keeps_its_markers() {
        assert_eq!(
            plain_text("# python comment\n  x = 1  ", false),
            "# python comment\nx = 1"
        );
    }

    #[test]
    fn markdown_paths_are_recognized() {
        assert!(is_markdown_path("/a/b/Note.MD"));
        assert!(is_markdown_path("/a/b/readme.markdown"));
        assert!(!is_markdown_path("/a/b/main.rs"));
    }

    #[test]
    fn read_capped_returns_small_text_whole() {
        let dir = scratch("text-small");
        let p = dir.join("a.md");
        fs::write(&p, "тайник").unwrap();
        assert_eq!(read_capped(&p), Loaded::Text("тайник".to_string()));
    }

    #[test]
    fn read_capped_stops_at_the_cap() {
        let dir = scratch("text-huge");
        let p = dir.join("big.log");
        // 'x' first so the cap falls in the middle of a 2-byte 'а'.
        let mut text = String::from("x");
        while text.len() < BODY_CAP_BYTES + 500_000 {
            text.push('а');
        }
        fs::write(&p, &text).unwrap();
        let Loaded::Text(read) = read_capped(&p) else {
            panic!("expected text")
        };
        assert!(read.starts_with('x'));
        assert_eq!(
            read.chars().filter(|&c| c == 'а').count(),
            (BODY_CAP_BYTES - 1) / 2
        );
        assert!(
            read.len() <= BODY_CAP_BYTES + 3,
            "one replacement char at most past the cap"
        );
    }

    #[test]
    fn read_capped_accepts_non_utf8_text() {
        // Unlike a preview, the index keeps a Latin-1 log searchable.
        let dir = scratch("text-latin1");
        let p = dir.join("old.txt");
        fs::write(&p, b"caf\xe9 tainik").unwrap();
        assert_eq!(
            read_capped(&p),
            Loaded::Text("caf\u{fffd} tainik".to_string())
        );
    }

    #[test]
    fn read_capped_detects_binary() {
        let dir = scratch("text-bin");
        let p = dir.join("shot.png");
        fs::write(&p, [0x89u8, b'P', b'N', b'G', 0, 1, 2, 3]).unwrap();
        assert_eq!(read_capped(&p), Loaded::Binary);
    }

    #[test]
    fn read_capped_reports_missing_and_directories_as_unreadable() {
        let dir = scratch("text-gone");
        assert!(matches!(
            read_capped(&dir.join("nope.md")),
            Loaded::Unreadable(_)
        ));
        assert!(matches!(read_capped(&dir), Loaded::Unreadable(_)));
    }

    #[test]
    fn read_capped_on_a_fifo_is_unreadable_at_once() {
        // Opening a FIFO for reading blocks until a writer comes; indexing
        // must not wait for one that never will.
        let dir = scratch("text-fifo");
        let fifo = dir.join("pipe.md");
        let c_path = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        let started = std::time::Instant::now();
        assert!(matches!(read_capped(&fifo), Loaded::Unreadable(_)));
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn cap_cuts_on_a_char_boundary() {
        let text = "я".repeat(BODY_CAP_BYTES);
        let capped = cap(&text);
        assert!(capped.len() <= BODY_CAP_BYTES);
        assert!(capped.len() > BODY_CAP_BYTES - 4);
        assert!(capped.chars().all(|c| c == 'я'));
        assert_eq!(cap("коротко"), "коротко");
    }
}
