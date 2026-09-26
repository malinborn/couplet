//! Note files: the display title of a note's text, the note file's stable
//! name, and creating it. The title rules are mirrored by `noteTitle` in
//! `src/lib/stash/note-title.ts` (stage 03); both are held to
//! `src-tauri/tests/fixtures/note-titles.json`, so every rule below is written
//! to be reproducible with plain JavaScript string methods (plan D16).

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
