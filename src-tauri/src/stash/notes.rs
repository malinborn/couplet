//! Note files: the display title of a note's text, the note file's stable
//! name, and creating it. The title rules are mirrored by `noteTitle` in
//! `src/lib/stash/note-title.ts` (stage 03); both are held to
//! `src-tauri/tests/fixtures/note-titles.json`, so every rule below is written
//! to be reproducible with plain JavaScript string methods (plan D16).

use std::fs::{self, OpenOptions};
use std::io::ErrorKind;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use crate::atomic_write::{self, NewFileMode};

use super::clock;

/// How many names `create_note_file` tries before giving up. Each try draws a
/// new 16-bit salt, so running out means something is wrong with the folder.
const NAME_ATTEMPTS: usize = 16;

/// Longest title, in Unicode scalar values — `chars()` here, `Array.from` in
/// the mirror; `.length` would count an emoji twice.
pub(crate) const TITLE_MAX_CHARS: usize = 120;

/// Stripped from the start of a non-heading line, repeatedly, in this order
/// (the task markers before the bare bullet they start with). Nothing is
/// trimmed between strips: D16 does not, so neither may the mirror.
const LINE_PREFIXES: [&str; 5] = ["> ", "- [ ] ", "- [x] ", "- [X] ", "- "];

/// Exactly the set JavaScript's `String.prototype.trim` removes, so the mirror
/// can use `.trim()`: Rust's `White_Space` without U+0085 (NEL), plus U+FEFF (BOM).
fn is_title_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

fn trim(s: &str) -> &str {
    s.trim_matches(is_title_space)
}

/// The display title of a note: its first line, a heading's text if that line
/// is one, without markdown markers. `None` for a note with nothing to show
/// (the UI says «Без названия»).
pub(crate) fn title_of(text: &str) -> Option<String> {
    // `split(/\r?\n/)`, not `lines()`: the mirror's split is the contract.
    let line = text
        .split('\n')
        .map(|l| trim(l.strip_suffix('\r').unwrap_or(l)))
        .find(|l| !l.is_empty())?;
    let raw = heading_text(line).unwrap_or_else(|| strip_line_prefixes(line));
    let plain: String = raw.chars().filter(|c| *c != '*' && *c != '`').collect();
    let clipped: String = trim(&plain).chars().take(TITLE_MAX_CHARS).collect();
    let title = clipped.trim_end_matches(is_title_space);
    (!title.is_empty()).then(|| title.to_string())
}

/// The text of an ATX heading (`#` to `######`, then a space, a tab or the end
/// of the line), without an optional closing `#` sequence. `None` when `line`
/// is not a heading — `#tag` and `#######` are ordinary text.
fn heading_text(line: &str) -> Option<&str> {
    let hashes = line.bytes().take_while(|b| *b == b'#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &line[hashes..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    let text = trim(rest);
    let without_closing = text.trim_end_matches('#');
    if without_closing.is_empty() {
        return Some("");
    }
    // `# C#` keeps its `#`: a closing sequence must be separated by a space
    // or a tab (CommonMark), nothing else from the trim set.
    if without_closing.ends_with([' ', '\t']) {
        return Some(trim(without_closing));
    }
    Some(text)
}

fn strip_line_prefixes(line: &str) -> &str {
    let mut rest = line;
    'strip: loop {
        for prefix in LINE_PREFIXES {
            if let Some(after) = rest.strip_prefix(prefix) {
                rest = after;
                continue 'strip;
            }
        }
        return rest;
    }
}

/// `YYYY-MM-DD-HHMM-xxxx.md` in local time. Stable: a note keeps its name for
/// life, whatever its title becomes (spec «Имена»).
pub(crate) fn note_file_name(unix_ms: i64, offset_secs: i64, salt: u16) -> String {
    let t = clock::local_time(unix_ms, offset_secs);
    format!(
        "{:04}-{:02}-{:02}-{:02}{:02}-{:04x}.md",
        t.year, t.month, t.day, t.hour, t.minute, salt
    )
}

/// Creates `path` empty with mode 0600, failing with `AlreadyExists` when
/// anything is there. `atomic_write::save` keeps an existing file's mode, so a
/// file reserved here stays 0600 through every later save (plan D3).
pub(crate) fn reserve_private(path: &Path) -> std::io::Result<()> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map(|_| ())
}

/// A new note file in `dir` holding `text`. `salt` is `ids::random16` in the
/// app; tests pass a fixed sequence. `dir` is created here and not earlier:
/// the notes folder appears only once a note needs it (plan D2).
pub(crate) fn create_note_file(
    dir: &Path,
    text: &str,
    unix_ms: i64,
    offset_secs: i64,
    mut salt: impl FnMut() -> u16,
) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    for _ in 0..NAME_ATTEMPTS {
        let path = dir.join(note_file_name(unix_ms, offset_secs, salt()));
        match reserve_private(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("cannot create {}: {e}", path.display())),
        }
        if let Err(e) = atomic_write::save(&path, text, NewFileMode::Umask) {
            // Only our own empty reservation is removed: the text never reached
            // it, and the caller still holds it.
            if fs::metadata(&path).is_ok_and(|m| m.len() == 0) {
                let _ = fs::remove_file(&path);
            }
            return Err(e);
        }
        return Ok(path);
    }
    Err(format!("no free note file name in {}", dir.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atomic_write::testkit::{content_of, mode_of, scratch, temp_leftovers};
    use std::fs;

    #[derive(serde::Deserialize)]
    struct TitleCase {
        text: String,
        title: Option<String>,
    }

    #[test]
    fn title_of_matches_the_shared_fixture() {
        let cases: Vec<TitleCase> =
            serde_json::from_str(include_str!("../../tests/fixtures/note-titles.json"))
                .expect("fixture is JSON");
        assert!(
            cases.len() >= 15,
            "the fixture is the TS mirror's contract too; keep it rich"
        );
        for case in &cases {
            assert_eq!(title_of(&case.text), case.title, "text: {:?}", case.text);
        }
    }

    #[test]
    fn the_limit_counts_characters_not_bytes() {
        let title = title_of(&"ж".repeat(200)).unwrap();
        assert_eq!(title.chars().count(), TITLE_MAX_CHARS);
    }

    /// 2026-09-26 02:15 in Moscow.
    const T: i64 = 1_790_378_100_000;
    const MSK: i64 = 10_800;

    #[test]
    fn the_file_name_is_the_local_minute_and_a_salt() {
        assert_eq!(note_file_name(T, MSK, 0xa3f9), "2026-09-26-0215-a3f9.md");
        assert_eq!(note_file_name(T, 0, 0x000b), "2026-09-25-2315-000b.md");
    }

    #[test]
    fn a_note_file_is_created_private_with_its_text() {
        // A home-like base: the notes folder is `~/couplet-test`, not under
        // Documents (roadmap A1). It does not exist yet — creating it is ours.
        let dir = scratch("note").join("home/couplet-test");
        let path = create_note_file(&dir, "# Привет\n", T, MSK, || 0xa3f9).unwrap();
        assert_eq!(path, dir.join("2026-09-26-0215-a3f9.md"));
        assert_eq!(content_of(&path), "# Привет\n");
        assert_eq!(mode_of(&path), 0o600, "a note is the human's private text");
        assert!(temp_leftovers(&dir).is_empty());
    }

    #[test]
    fn an_existing_file_is_never_overwritten() {
        let dir = scratch("note-collide");
        fs::write(dir.join("2026-09-26-0215-aaaa.md"), "keep me").unwrap();
        let mut salts = [0xaaaa, 0xbbbb].into_iter();
        let path = create_note_file(&dir, "new", T, MSK, || salts.next().unwrap()).unwrap();
        assert_eq!(path, dir.join("2026-09-26-0215-bbbb.md"));
        assert_eq!(content_of(&dir.join("2026-09-26-0215-aaaa.md")), "keep me");
        assert_eq!(content_of(&path), "new");
    }

    #[test]
    fn it_gives_up_after_a_bounded_number_of_names() {
        let dir = scratch("note-full");
        fs::write(dir.join("2026-09-26-0215-aaaa.md"), "keep me").unwrap();
        let err = create_note_file(&dir, "new", T, MSK, || 0xaaaa).unwrap_err();
        assert!(err.contains("no free note file name"), "{err}");
        assert_eq!(content_of(&dir.join("2026-09-26-0215-aaaa.md")), "keep me");
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            1,
            "nothing else was created"
        );
    }
}
