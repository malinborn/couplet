//! The stash query language: plain words, `#tag`, "quoted phrases", all
//! ANDed. Mirrored by `parseSearchQuery` in `src/lib/stash/stash-query.ts`;
//! both are held to `src-tauri/tests/fixtures/stash-queries.json`.

use serde::Deserialize;

use crate::stash::entries::normalize_tag;

/// FTS5's trigram tokenizer matches nothing for a string shorter than this.
pub const TRIGRAM_MIN: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Term {
    pub text: String,
    pub phrase: bool,
}

impl Term {
    /// Long enough for trigrams. Counted in chars: FTS5 counts Unicode
    /// characters, and «тай» is three of them in six bytes.
    pub fn is_long(&self) -> bool {
        self.text.chars().count() >= TRIGRAM_MIN
    }

    pub fn folded(&self) -> String {
        fold(&self.text)
    }
}

/// The one case fold of search: needles, `stash_fold` titles and snippet
/// bodies all go through it, so an FTS hit is always marked. Char by char,
/// not `str::to_lowercase`: that one turns a word-final Σ into ς, while a
/// body folded one char at a time (to map offsets back) gets σ. FTS5's own
/// fold makes all three sigmas one, and so does this. `ё` stays `ё` (D13).
pub fn fold_char(c: char) -> impl Iterator<Item = char> {
    c.to_lowercase().map(|l| if l == 'ς' { 'σ' } else { l })
}

pub fn fold(s: &str) -> String {
    s.chars().flat_map(fold_char).collect()
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchQuery {
    /// As `entries::normalize_tag` stores them (a `#tag` term matches stored
    /// tags exactly), no duplicates, in order of appearance.
    pub tags: Vec<String>,
    pub terms: Vec<Term>,
}

/// The separators both parsers agree on. Not `char::is_whitespace`: Rust's
/// White_Space and JavaScript's `\s` disagree (U+FEFF, U+0085), and the two
/// parsers must split identically.
fn is_separator(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{a0}' | '\u{3000}')
}

pub fn parse_query(input: &str) -> SearchQuery {
    let chars: Vec<char> = input.chars().collect();
    let mut q = SearchQuery::default();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if is_separator(c) {
            i += 1;
            continue;
        }
        if c == '"' {
            let start = i + 1;
            let mut end = start;
            while end < chars.len() && chars[end] != '"' {
                end += 1;
            }
            let phrase: String = chars[start..end].iter().collect();
            let phrase = phrase.trim_matches(is_separator);
            if !phrase.is_empty() {
                q.terms.push(Term {
                    text: phrase.to_string(),
                    phrase: true,
                });
            }
            // Past the closing quote; an unterminated phrase ran to the end.
            i = end + 1;
            continue;
        }
        let start = i;
        while i < chars.len() && !is_separator(chars[i]) && chars[i] != '"' {
            i += 1;
        }
        let word: String = chars[start..i].iter().collect();
        // A word that is no storable tag (only '#'s, whitespace inside, over
        // the length cap) stays a plain term: as a tag it could match nothing,
        // and dropping it would widen the result.
        let tag = if word.starts_with('#') {
            normalize_tag(&word).ok().flatten()
        } else {
            None
        };
        match tag {
            Some(tag) => {
                if !q.tags.contains(&tag) {
                    q.tags.push(tag);
                }
            }
            None => q.terms.push(Term {
                text: word,
                phrase: false,
            }),
        }
    }
    q
}

/// The FTS5 MATCH expression for the long terms, or `None` when there are
/// none. Each term becomes a double-quoted FTS5 string — inside one, `AND`,
/// `NEAR`, `*`, `^`, `:` and parentheses are plain characters — with `"`
/// doubled, FTS5's only escape. Bind the result as a parameter; never splice
/// it into SQL.
pub fn fts_match(terms: &[Term]) -> Option<String> {
    let parts: Vec<String> = terms
        .iter()
        .filter(|t| t.is_long())
        .map(|t| format!("\"{}\"", t.text.replace('"', "\"\"")))
        .collect();
    (!parts.is_empty()).then(|| parts.join(" AND "))
}

/// The terms trigrams cannot see, folded for `instr(stash_fold(title), ?)`.
pub fn short_terms(terms: &[Term]) -> Vec<String> {
    terms
        .iter()
        .filter(|t| !t.is_long())
        .map(Term::folded)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Case {
        input: String,
        tags: Vec<String>,
        terms: Vec<Term>,
    }

    #[test]
    fn parses_every_shared_fixture_case() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../../tests/fixtures/stash-queries.json"))
                .unwrap();
        // Pinned exactly, like `note-titles.json`: the TS mirror's test says 25
        // too, so a case lost from the file fails here instead of passing.
        assert_eq!(
            cases.len(),
            25,
            "the fixture is the TS mirror's contract too; keep both counts in step"
        );
        for case in cases {
            let q = parse_query(&case.input);
            assert_eq!(q.tags, case.tags, "tags of {:?}", case.input);
            assert_eq!(q.terms, case.terms, "terms of {:?}", case.input);
        }
    }

    fn term(text: &str) -> Term {
        Term {
            text: text.to_string(),
            phrase: false,
        }
    }

    #[test]
    fn length_is_counted_in_chars_not_bytes() {
        assert!(
            term("тай").is_long(),
            "3 Cyrillic chars are 6 bytes but 3 chars"
        );
        assert!(!term("ай").is_long());
        assert!(term("😀😀😀").is_long());
        assert!(!term("ab").is_long());
    }

    #[test]
    fn fts_match_quotes_every_long_term_and_ands_them() {
        let q = parse_query("тайник \"на третьем\" ок");
        assert_eq!(
            fts_match(&q.terms).as_deref(),
            Some("\"тайник\" AND \"на третьем\"")
        );
    }

    #[test]
    fn fts_match_is_none_without_long_terms() {
        assert_eq!(fts_match(&parse_query("ок #tag").terms), None);
        assert_eq!(fts_match(&[]), None);
    }

    #[test]
    fn fts_syntax_stays_inside_quotes() {
        for (input, expected) in [
            ("NEAR", "\"NEAR\""),
            ("AND", "\"AND\""),
            ("abc*", "\"abc*\""),
            ("^abc", "\"^abc\""),
            ("title:abc", "\"title:abc\""),
            ("-abc", "\"-abc\""),
        ] {
            assert_eq!(
                fts_match(&parse_query(input).terms).as_deref(),
                Some(expected),
                "{input}"
            );
        }
    }

    #[test]
    fn a_quote_inside_a_term_is_doubled() {
        // The parser never produces one (a quote opens a phrase), but a caller
        // building terms by hand must not be able to break out of the string.
        let terms = vec![term("ab\"c OR x")];
        assert_eq!(fts_match(&terms).as_deref(), Some("\"ab\"\"c OR x\""));
    }

    #[test]
    fn fold_is_char_by_char_with_every_sigma_alike() {
        // `str::to_lowercase` turns a word-final Σ into ς, `char::to_lowercase`
        // into σ; FTS5 folds both to σ, so this fold does too.
        assert_eq!(fold("ΟΔΟΣ"), "οδοσ");
        assert_eq!(fold("οδος"), "οδοσ");
        assert_eq!(fold("ТАЙНИК Ok"), "тайник ok");
        assert_eq!(fold("Ёлка"), "ёлка", "ё stays ё (D13)");
        assert_eq!(term("ΟΔΟΣ").folded(), "οδοσ");
    }

    #[test]
    fn short_terms_are_folded() {
        assert_eq!(
            short_terms(&parse_query("ОК тайник Ab").terms),
            vec!["ок", "ab"]
        );
    }

    #[test]
    fn a_query_tag_is_what_a_stored_tag_would_be() {
        // `#tag` matches stored tags exactly, so the query side must normalize
        // the way `entries::normalize_tag` stored them.
        for raw in ["#Infra", "##Infra", "#INFRA"] {
            assert_eq!(parse_query(raw).tags, vec!["infra"], "{raw}");
        }
        // No tag can be stored for these, so they stay text: dropping them
        // would widen the result, and as a tag they could never match.
        let long = format!("#{}", "я".repeat(65));
        assert_eq!(parse_query(&long).terms, vec![term(&long)]);
        assert!(parse_query(&long).tags.is_empty());
    }
}
