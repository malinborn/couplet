//! The piece of an entry's text a hit is shown with, and where the query sits
//! in it (spec: «в превью показан фрагмент вокруг совпадения»; agent API:
//! «сниппет … ~200 символов»). Our own windowing over the stored plain body,
//! not FTS5 `snippet()`: that one counts its window in tokens (≤ 64, and a
//! trigram token is about one character) and returns no offsets.

/// About this many characters of text around the match.
pub const SNIPPET_CHARS: usize = 200;
/// How much text before the earliest match is kept.
const LEAD_CHARS: usize = 60;
/// A cut moves at most this far to land on a space instead of mid-word.
const WORD_SNAP: usize = 16;
const ELLIPSIS: char = '…';

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snippet {
    pub text: String,
    /// `[from, to)` in UTF-16 code units of `text` — the unit JavaScript's
    /// `String.slice` counts in, so the webview cuts without converting.
    /// Sorted, non-overlapping.
    pub ranges: Vec<(u32, u32)>,
}

/// The snippet a hit is shown with. A note's first line is its title — on the
/// card already, so the snippet is cut from the lines below it (the webview's
/// `dropFirstLine` for the preview), and a note hit only in its title gets
/// none: the card then shows its normal preview. A file reference's title is
/// its name, so its body is cut whole, marked or not.
pub fn hit_snippet(body: &str, note: bool, needles: &[String]) -> Snippet {
    if !note {
        return make_snippet(body, needles);
    }
    // The stored body is plain: non-empty lines only, so its first line is
    // the note's first non-blank one.
    let rest = body.split_once('\n').map_or("", |(_, rest)| rest);
    let s = make_snippet(rest, needles);
    if s.ranges.is_empty() {
        return Snippet {
            text: String::new(),
            ranges: Vec::new(),
        };
    }
    s
}

/// `needles` are lower-cased already (`Term::folded`). `ё` stays `ё` (D13).
pub fn make_snippet(body: &str, needles: &[String]) -> Snippet {
    // One-for-one, so every char index stays valid: a snippet is one run of text.
    let chars: Vec<char> = body.chars().map(|c| if c == '\n' { ' ' } else { c }).collect();
    let hits = find_all(&chars, needles);
    let (start, end) = window(&chars, hits.first().copied());
    build(&chars, start, end, &hits)
}

/// Every occurrence of every needle, as char ranges of `chars`, sorted.
fn find_all(chars: &[char], needles: &[String]) -> Vec<(usize, usize)> {
    // Fold once: `folded[k]` came from `chars[origin[k]]`. One char may fold
    // to several ('İ' → "i̇"), so the two sequences can differ in length and a
    // match must be mapped back through `origin`, never read off `folded`.
    let mut folded: Vec<char> = Vec::with_capacity(chars.len());
    let mut origin: Vec<usize> = Vec::with_capacity(chars.len());
    for (i, c) in chars.iter().enumerate() {
        for l in c.to_lowercase() {
            folded.push(l);
            origin.push(i);
        }
    }
    let mut hits = Vec::new();
    for needle in needles {
        let n: Vec<char> = needle.chars().map(|c| if c == '\n' { ' ' } else { c }).collect();
        if n.is_empty() || n.len() > folded.len() {
            continue;
        }
        let mut k = 0;
        while k + n.len() <= folded.len() {
            if folded[k] == n[0] && folded[k..k + n.len()] == n[..] {
                hits.push((origin[k], origin[k + n.len() - 1] + 1));
                k += n.len();
            } else {
                k += 1;
            }
        }
    }
    hits.sort_unstable();
    hits
}

/// The char window `[start, end)` shown for a body whose earliest match is `first`.
fn window(chars: &[char], first: Option<(usize, usize)>) -> (usize, usize) {
    let len = chars.len();
    if len <= SNIPPET_CHARS {
        return (0, len);
    }
    let (anchor, anchor_end) = first.unwrap_or((0, 0));
    let mut start = anchor.saturating_sub(LEAD_CHARS);
    if start > 0 {
        if let Some(p) = (start..(start + WORD_SNAP).min(anchor)).find(|&i| chars[i] == ' ') {
            start = p + 1;
        }
    }
    // Never cut the anchoring match itself, however long the phrase.
    let mut end = (start + SNIPPET_CHARS).min(len).max(anchor_end.min(len));
    if end < len {
        let floor = end.saturating_sub(WORD_SNAP).max(anchor_end);
        if let Some(p) = (floor..end).rev().find(|&i| chars[i] == ' ') {
            end = p;
        }
    }
    (start, end)
}

fn build(chars: &[char], start: usize, end: usize, hits: &[(usize, usize)]) -> Snippet {
    let mut text = String::new();
    let mut units: u32 = 0;
    // UTF-16 offset of each char of the window, plus one past its end.
    let mut at: Vec<u32> = Vec::with_capacity(end - start + 1);
    if start > 0 {
        text.push(ELLIPSIS);
        units += 1;
    }
    for &c in &chars[start..end] {
        at.push(units);
        text.push(c);
        units += c.len_utf16() as u32;
    }
    at.push(units);
    if end < chars.len() {
        text.push(ELLIPSIS);
    }
    let mut ranges: Vec<(u32, u32)> = Vec::new();
    for &(a, b) in hits {
        let (a, b) = (a.max(start), b.min(end));
        if a >= b {
            continue;
        }
        let r = (at[a - start], at[b - start]);
        match ranges.last_mut() {
            Some(last) if r.0 <= last.1 => last.1 = last.1.max(r.1),
            _ => ranges.push(r),
        }
    }
    Snippet { text, ranges }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn needles(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    /// `s[a..b]` in UTF-16 units — what the webview's `String.slice` returns.
    fn slice16(s: &str, a: u32, b: u32) -> String {
        let units: Vec<u16> = s.encode_utf16().collect();
        String::from_utf16(&units[a as usize..b as usize]).unwrap()
    }

    #[test]
    fn a_short_body_is_returned_whole_with_its_word_form_marked() {
        let s = make_snippet("Нашёл в тайнике ключ", &needles(&["тайник"]));
        assert_eq!(s.text, "Нашёл в тайнике ключ");
        assert_eq!(s.ranges, vec![(8, 14)]);
        assert_eq!(slice16(&s.text, 8, 14), "тайник");
    }

    #[test]
    fn matching_ignores_case() {
        let s = make_snippet("ТАЙНИК в шкафу", &needles(&["тайник"]));
        assert_eq!(s.ranges, vec![(0, 6)]);
    }

    #[test]
    fn ranges_are_utf16_units_so_an_emoji_counts_two() {
        let s = make_snippet("😀 тайник", &needles(&["тайник"]));
        assert_eq!(s.ranges, vec![(3, 9)]);
        assert_eq!(slice16(&s.text, 3, 9), "тайник");
    }

    #[test]
    fn a_deep_match_is_shown_in_a_window_around_it() {
        let body = format!("{}документ{}", "слово ".repeat(100), " хвост".repeat(100));
        let s = make_snippet(&body, &needles(&["мент"]));
        assert!(s.text.starts_with('…'), "{:?}", s.text);
        assert!(s.text.ends_with('…'), "{:?}", s.text);
        assert!(s.text.contains("документ"));
        assert!(s.text.chars().count() <= SNIPPET_CHARS + 2);
        assert_eq!(s.ranges.len(), 1);
        let (a, b) = s.ranges[0];
        assert_eq!(slice16(&s.text, a, b), "мент");
        // The cut landed on a space, not mid-word.
        assert!(s.text.starts_with("…слово"), "{:?}", s.text);
    }

    #[test]
    fn no_match_in_the_body_shows_its_start() {
        let body = "начало ".repeat(60);
        let s = make_snippet(&body, &needles(&["тайник"]));
        assert!(s.text.starts_with("начало"));
        assert!(s.text.ends_with('…'));
        assert!(s.ranges.is_empty());
    }

    #[test]
    fn no_needles_show_the_start_unmarked() {
        let s = make_snippet("коротко", &[]);
        assert_eq!(s, Snippet { text: "коротко".to_string(), ranges: vec![] });
    }

    #[test]
    fn overlapping_matches_merge_and_stay_sorted() {
        let s = make_snippet("документация и документ", &needles(&["документ", "мент"]));
        assert_eq!(s.ranges, vec![(0, 8), (15, 23)]);
    }

    #[test]
    fn newlines_become_spaces() {
        let s = make_snippet("строка один\nстрока два", &needles(&["два"]));
        assert_eq!(s.text, "строка один строка два");
        assert_eq!(slice16(&s.text, s.ranges[0].0, s.ranges[0].1), "два");
    }

    #[test]
    fn an_empty_body_is_an_empty_snippet() {
        assert_eq!(make_snippet("", &needles(&["abc"])), Snippet { text: String::new(), ranges: vec![] });
    }

    // `'İ'.to_lowercase()` is two chars ("i" + U+0307), so the folded text is
    // longer than the original: positions must map back through the fold, not
    // be read off the folded string.
    #[test]
    fn a_char_that_folds_longer_does_not_shift_later_ranges() {
        let s = make_snippet("İstanbul и тайник", &needles(&["тайник"]));
        assert_eq!(s.ranges, vec![(11, 17)]);
        assert_eq!(slice16(&s.text, 11, 17), "тайник");
    }

    #[test]
    fn a_needle_folded_from_a_longer_char_marks_the_original_word() {
        let s = make_snippet("İstanbul и тайник", &needles(&[&"İSTANBUL".to_lowercase(), "тайник"]));
        assert_eq!(s.ranges, vec![(0, 8), (11, 17)]);
        assert_eq!(slice16(&s.text, 0, 8), "İstanbul");
    }

    // A needle that matches only part of a char's fold marks the whole char.
    #[test]
    fn a_match_inside_a_fold_expansion_marks_the_whole_char() {
        let s = make_snippet("İ", &needles(&["i"]));
        assert_eq!(s.ranges, vec![(0, 1)]);
    }

    #[test]
    fn yo_is_not_folded_to_ye() {
        assert!(make_snippet("ёжик", &needles(&["ежик"])).ranges.is_empty());
        assert_eq!(make_snippet("ЁЖИК", &needles(&["ёжик"])).ranges, vec![(0, 4)]);
    }

    #[test]
    fn a_windowed_snippet_counts_emoji_as_two_units() {
        let body = format!("{}😀😀 тайник{}", "слово ".repeat(100), " хвост".repeat(100));
        let s = make_snippet(&body, &needles(&["тайник"]));
        assert!(s.text.starts_with('…'), "{:?}", s.text);
        let (a, b) = s.ranges[0];
        assert_eq!(slice16(&s.text, a, b), "тайник");
        let before: String = s.text.chars().take_while(|&c| c != 'т').collect();
        assert_eq!(a as usize, before.encode_utf16().count());
    }

    #[test]
    fn a_note_snippet_skips_the_title_line() {
        let s = hit_snippet("Тайник\nключ от тайника", true, &needles(&["тайник"]));
        assert_eq!(s.text, "ключ от тайника");
        assert_eq!(s.ranges, vec![(8, 14)]);
        let empty = Snippet { text: String::new(), ranges: vec![] };
        assert_eq!(hit_snippet("Тайник\nпро другое", true, &needles(&["тайник"])), empty);
        assert_eq!(hit_snippet("Тайник", true, &needles(&["тайник"])), empty);
    }

    #[test]
    fn a_file_snippet_keeps_its_first_line() {
        let s = hit_snippet("hdmi\nкабель", false, &needles(&["hdmi"]));
        assert_eq!(s.text, "hdmi кабель");
        assert_eq!(hit_snippet("кабель", false, &needles(&["hdmi"])).text, "кабель");
    }

    #[test]
    fn every_match_inside_the_window_is_marked() {
        let s = make_snippet("ключ, ещё ключ и КЛЮЧ", &needles(&["ключ"]));
        assert_eq!(s.ranges, vec![(0, 4), (10, 14), (17, 21)]);
    }
}
