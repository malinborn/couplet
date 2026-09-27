//! One search for the drawer and for agents (spec «Поиск»). Candidates come
//! from one SQL query without LIMIT — MATCH for long terms, `stash_fold`
//! title substrings for short ones, tag/kind/repo/trash filters on stored
//! columns — ordered by relevance, then freshness. Only the page's entries
//! and snippets are built. Everything here reads the database alone: the
//! command enriches the page after releasing the stash lock (`Enrich`, I3).

use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde::Serialize;

use super::query::{fts_match, parse_query, short_terms, Term};
use super::snippet::make_snippet;
use crate::stash::db::err;
use crate::stash::entries::{load_entry, normalize_repo, normalize_tag};
use crate::stash::{Enrich, StashEntry, StashKind};

/// bm25 column weights, title then body. A body term contributes at most
/// (k1+1)·idf = 2.2·idf however often it repeats; one title hit contributes
/// ≈1.0·idf at average title length (0.55·idf at 3×), so ×10 makes any title
/// hit outrank any body-only hit — the spec's «совпадение в заголовке весит
/// больше». FTS5's bm25() is lower-is-better; the score is its negation.
const RANK_SQL: &str = "-bm25(entries_fts, 10.0, 1.0)";
/// «При равенстве — свежее отложенное выше.»
const FRESH_SQL: &str = "max(e.modified_at, coalesce(e.stashed_at, 0))";

/// Search's own page sizes, apart from `stash_list`'s: the drawer renders at
/// most 200 cards (`STASH_RENDER_CAP`), and each hit costs a snippet.
const SEARCH_DEFAULT_LIMIT: usize = 50;
const SEARCH_MAX_LIMIT: usize = 200;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashHit {
    pub entry: StashEntry,
    pub snippet: String,
    /// `[from, to)` in UTF-16 units of `snippet`.
    pub ranges: Vec<(u32, u32)>,
    /// Higher is better; 0 when no trigram term was matched.
    pub score: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub hits: Vec<StashHit>,
    /// Matching entries across all pages.
    pub total: usize,
    pub next_cursor: Option<String>,
}

impl Enrich for SearchPage {
    fn enrich(self) -> Self {
        let hits = self
            .hits
            .into_iter()
            .map(|hit| StashHit {
                entry: hit.entry.enrich(),
                ..hit
            })
            .collect();
        Self { hits, ..self }
    }
}

#[derive(Debug, Clone, Default)]
pub struct SearchArgs {
    pub query: String,
    /// A project's directory name (a path is reduced to it, roadmap A3).
    pub repo: Option<String>,
    /// An exact stored tag, `#` and case ignored; ANDed with the query's tags.
    pub tag: Option<String>,
    pub kind: Option<StashKind>,
    /// `true`: trashed notes, matched by title only (roadmap A8).
    pub deleted: bool,
    pub limit: Option<usize>,
    /// Opaque: the previous page's `next_cursor`.
    pub cursor: Option<String>,
}

/// The cursor is an offset into the ranked list, opaque to callers: relevance
/// order has no stable key to build a keyset cursor from.
pub fn parse_cursor(cursor: Option<&str>) -> Result<usize, String> {
    match cursor {
        None => Ok(0),
        Some(c) => c
            .parse::<usize>()
            .map_err(|_| format!("invalid cursor: {c}")),
    }
}

pub fn clamp_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(SEARCH_DEFAULT_LIMIT)
        .clamp(1, SEARCH_MAX_LIMIT)
}

struct Candidate {
    rowid: i64,
    id: String,
    score: f64,
}

/// Pushes `v` and returns its placeholder.
fn bind(values: &mut Vec<Value>, v: String) -> String {
    values.push(Value::Text(v));
    format!("?{}", values.len())
}

/// Every value is bound; the only text spliced in is this file's own constants.
fn candidate_sql(
    terms: &[Term],
    tags: &[String],
    kind: Option<StashKind>,
    repo: Option<&str>,
    deleted: bool,
) -> (String, Vec<Value>) {
    let mut values: Vec<Value> = Vec::new();
    let mut wheres: Vec<String> = Vec::new();
    let (select, order) = if deleted {
        // Trashed notes are out of the index (A8), so every term, long or
        // short, is a folded title substring; the trash has one order.
        wheres.push("e.deleted_at IS NOT NULL AND e.kind = 'note'".into());
        for t in terms {
            let p = bind(&mut values, t.folded());
            wheres.push(format!("instr(stash_fold(e.title), {p}) > 0"));
        }
        (
            "SELECT e.rowid, e.id, 0.0 FROM entries e".to_string(),
            "e.deleted_at DESC, e.rowid DESC".to_string(),
        )
    } else {
        let select = match fts_match(terms) {
            Some(expr) => {
                let p = bind(&mut values, expr);
                wheres.push(format!("entries_fts MATCH {p}"));
                format!(
                    "SELECT e.rowid, e.id, {RANK_SQL} AS score \
                     FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid"
                )
            }
            None => "SELECT e.rowid, e.id, 0.0 AS score FROM entries e".to_string(),
        };
        wheres.push("e.deleted_at IS NULL".into());
        for s in short_terms(terms) {
            let p = bind(&mut values, s);
            wheres.push(format!("instr(stash_fold(e.title), {p}) > 0"));
        }
        (
            select,
            format!("score DESC, {FRESH_SQL} DESC, e.rowid DESC"),
        )
    };
    if let Some(k) = kind {
        let p = bind(&mut values, k.as_str().to_string());
        wheres.push(format!("e.kind = {p}"));
    }
    if let Some(r) = repo {
        let p = bind(&mut values, r.to_string());
        wheres.push(format!("e.repo = {p}"));
    }
    for t in tags {
        let p = bind(&mut values, t.clone());
        wheres.push(format!(
            "EXISTS (SELECT 1 FROM tags t WHERE t.entry_id = e.id AND t.tag = {p})"
        ));
    }
    let sql = format!("{select} WHERE {} ORDER BY {order}", wheres.join(" AND "));
    (sql, values)
}

/// One page of hits from the database alone: see `Enrich` for the rest.
pub fn search(conn: &Connection, args: &SearchArgs) -> Result<SearchPage, String> {
    let offset = parse_cursor(args.cursor.as_deref())?;
    let limit = clamp_limit(args.limit);
    let parsed = parse_query(&args.query);
    let mut tags = parsed.tags;
    match args.tag.as_deref().map(normalize_tag).transpose()? {
        // Given but empty once normalized (`#`): a tag no entry can carry, so
        // nothing matches — as `stash_list` answers it.
        Some(None) => {
            return Ok(SearchPage {
                hits: Vec::new(),
                total: 0,
                next_cursor: None,
            })
        }
        Some(Some(tag)) if !tags.contains(&tag) => tags.push(tag),
        _ => {}
    }
    let repo = normalize_repo(args.repo.as_deref());

    let (sql, values) = candidate_sql(
        &parsed.terms,
        &tags,
        args.kind,
        repo.as_deref(),
        args.deleted,
    );
    let candidates: Vec<Candidate> = {
        let mut st = conn.prepare(&sql).map_err(err)?;
        let rows = st
            .query_map(params_from_iter(values.iter()), |r| {
                Ok(Candidate {
                    rowid: r.get(0)?,
                    id: r.get(1)?,
                    score: r.get(2)?,
                })
            })
            .map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)?
    };

    let total = candidates.len();
    // Short terms matched the title only, so only long ones mark the body.
    let needles: Vec<String> = parsed
        .terms
        .iter()
        .filter(|t| t.is_long())
        .map(Term::folded)
        .collect();
    let mut hits = Vec::new();
    for c in candidates.iter().skip(offset).take(limit) {
        let entry = load_entry(conn, &c.id)?;
        let (snippet, ranges) = if args.deleted {
            // Not in the index (A8): there is no stored body to cut from.
            (String::new(), Vec::new())
        } else {
            let body: String = conn
                .query_row(
                    "SELECT body FROM entries_fts WHERE rowid = ?1",
                    [c.rowid],
                    |r| r.get(0),
                )
                .optional()
                .map_err(err)?
                .unwrap_or_default();
            let s = make_snippet(&body, &needles);
            (s.text, s.ranges)
        };
        hits.push(StashHit {
            entry,
            snippet,
            ranges,
            score: c.score,
        });
    }
    let next = offset + hits.len();
    Ok(SearchPage {
        hits,
        total,
        next_cursor: (next < total).then(|| next.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::super::index::{rebuild_index, reindex_path};
    use super::super::test_support::{db, Db};
    use super::*;
    use crate::stash::StashKind;

    fn ids(d: &Db, query: &str) -> Vec<String> {
        page(
            d,
            SearchArgs {
                query: query.to_string(),
                ..Default::default()
            },
        )
        .hits
        .iter()
        .map(|h| h.entry.id.clone())
        .collect()
    }

    fn sorted_ids(d: &Db, query: &str) -> Vec<String> {
        let mut v = ids(d, query);
        v.sort();
        v
    }

    fn page(d: &Db, args: SearchArgs) -> SearchPage {
        search(&d.conn, &args).unwrap()
    }

    fn page_ids(p: &SearchPage) -> Vec<&str> {
        p.hits.iter().map(|h| h.entry.id.as_str()).collect()
    }

    fn slice16(s: &str, a: u32, b: u32) -> String {
        let units: Vec<u16> = s.encode_utf16().collect();
        String::from_utf16(&units[a as usize..b as usize]).unwrap()
    }

    fn trashed_at(d: &Db, id: &str, at: i64) {
        d.trash(id);
        d.conn
            .execute(
                "UPDATE entries SET deleted_at = ?1 WHERE id = ?2",
                rusqlite::params![at, id],
            )
            .unwrap();
    }

    #[test]
    fn a_word_finds_its_russian_forms() {
        let d = db("forms");
        d.note("n1", "Где лежит тайник", 1);
        d.note("n2", "Нашёл в тайнике ключ", 2);
        d.note("n3", "Карта тайника", 3);
        d.note("n4", "Список покупок", 4);
        assert_eq!(sorted_ids(&d, "тайник"), vec!["n1", "n2", "n3"]);
    }

    #[test]
    fn a_piece_inside_a_word_is_found() {
        let d = db("substring");
        d.note("n1", "Подписать документ", 1);
        d.note("n2", "Позвонить маме", 2);
        assert_eq!(ids(&d, "мент"), vec!["n1"]);
    }

    #[test]
    fn case_does_not_matter() {
        let d = db("case");
        d.note("n1", "тайник и HDMI", 1);
        assert_eq!(ids(&d, "ТАЙНИК"), vec!["n1"]);
        assert_eq!(ids(&d, "Тайник"), vec!["n1"]);
        assert_eq!(ids(&d, "hdmi"), vec!["n1"]);
    }

    #[test]
    fn a_phrase_must_appear_as_written() {
        let d = db("phrase");
        d.note("n1", "переговорка на третьем этаже", 1);
        d.note("n2", "на третьем этаже переговорка", 2);
        assert_eq!(ids(&d, "\"переговорка на третьем\""), vec!["n1"]);
        assert_eq!(sorted_ids(&d, "переговорка третьем"), vec!["n1", "n2"]);
    }

    #[test]
    fn tags_and_text_combine() {
        let d = db("tags");
        d.note("n1", "hdmi кабель", 1);
        d.note("n2", "hdmi кабель", 2);
        d.tag("n1", "infra");
        assert_eq!(ids(&d, "#infra hdmi"), vec!["n1"]);
        assert_eq!(ids(&d, "#INFRA"), vec!["n1"], "a tag alone");
        assert!(
            ids(&d, "#inf").is_empty(),
            "a query tag matches stored tags exactly"
        );
        let with_arg = page(
            &d,
            SearchArgs {
                query: "hdmi".into(),
                tag: Some("#Infra".into()),
                ..Default::default()
            },
        );
        assert_eq!(page_ids(&with_arg), vec!["n1"]);
    }

    #[test]
    fn a_tag_argument_follows_the_list_rules() {
        let d = db("tag-arg");
        d.note("n1", "hdmi кабель", 1);
        d.tag("n1", "infra");
        // Given but empty once normalized: a tag no entry can carry.
        let empty = page(
            &d,
            SearchArgs {
                query: "hdmi".into(),
                tag: Some("#".into()),
                ..Default::default()
            },
        );
        assert_eq!(
            (empty.hits.len(), empty.total, empty.next_cursor),
            (0, 0, None)
        );
        let bad = search(
            &d.conn,
            &SearchArgs {
                tag: Some("two words".into()),
                ..Default::default()
            },
        );
        assert!(
            bad.is_err(),
            "a tag with inner whitespace is refused, as by stash_list"
        );
    }

    #[test]
    fn a_short_query_matches_titles_only() {
        let d = db("short");
        d.note("n1", "# ОК план\nтекст", 1);
        d.note("n2", "# Другое\nок в тексте", 2);
        d.note("n3", "# Abc\n", 3);
        assert_eq!(
            ids(&d, "ок"),
            vec!["n1"],
            "Cyrillic, case-folded, title only"
        );
        assert_eq!(ids(&d, "ab"), vec!["n3"]);
        assert_eq!(ids(&d, "ок план"), vec!["n1"], "short + long");
        assert!(ids(&d, "юю").is_empty());
    }

    #[test]
    fn a_title_hit_outranks_a_fresher_body_hit() {
        let d = db("rank");
        d.note("body", "# Заметки\nгде-то упомянут тайник", 200);
        d.note("title", "# Тайник\nпро другое", 100);
        let p = page(
            &d,
            SearchArgs {
                query: "тайник".into(),
                ..Default::default()
            },
        );
        assert_eq!(page_ids(&p), vec!["title", "body"]);
        assert!(p.hits[0].score > p.hits[1].score);
    }

    #[test]
    fn equal_relevance_puts_the_fresher_first() {
        let d = db("tie");
        d.note("old", "одинаковый тайник", 100);
        d.note("new", "одинаковый тайник", 200);
        assert_eq!(ids(&d, "тайник"), vec!["new", "old"]);
        assert_eq!(ids(&d, ""), vec!["new", "old"], "no terms: newest first");
        assert_eq!(page(&d, SearchArgs::default()).hits[0].score, 0.0);
    }

    #[test]
    fn fts_syntax_in_a_query_is_literal_text() {
        let d = db("inject");
        d.note("cmd", "command and control", 1);
        d.note("near", "nearby shop", 2);
        // A file reference: its title is the file name verbatim, while a
        // note's title_of() may strip `*` as markdown.
        d.file("star", "a*b.txt", b"star", 3);
        let all = page(&d, SearchArgs::default()).total;
        for q in [
            "\"",
            "*",
            "NEAR",
            "AND",
            "a AND b",
            "OR",
            "NOT x",
            "NEAR(nearby, 5)",
            "title:abc",
            "^nea",
            "-nea",
            "\"unterminated",
            "'); DROP TABLE entries; --",
            "(((",
            "\"\"\"",
        ] {
            let r = search(
                &d.conn,
                &SearchArgs {
                    query: q.into(),
                    ..Default::default()
                },
            );
            assert!(r.is_ok(), "{q:?} → {r:?}", r = r.as_ref().err());
        }
        assert_eq!(
            ids(&d, "NEAR"),
            vec!["near"],
            "matched as the letters n-e-a-r"
        );
        assert_eq!(ids(&d, "AND"), vec!["cmd"]);
        assert_eq!(
            ids(&d, "*"),
            vec!["star"],
            "a 1-char query is a title substring"
        );
        assert_eq!(
            page(&d, SearchArgs::default()).total,
            all,
            "the entries table survived"
        );
    }

    #[test]
    fn filters_kind_trash_and_repo() {
        let d = db("filters");
        d.note_in("a", "тайник", 1, Some("repo-a"));
        d.note_in("b", "тайник", 2, Some("repo-b"));
        d.file("f", "тайник.md", b"hdmi", 3);
        d.note("gone", "тайник", 4);
        d.trash("gone");

        assert_eq!(sorted_ids(&d, "тайник"), vec!["a", "b", "f"]);
        let trash = page(
            &d,
            SearchArgs {
                query: "тайник".into(),
                deleted: true,
                ..Default::default()
            },
        );
        assert_eq!(page_ids(&trash), vec!["gone"]);
        let notes = page(
            &d,
            SearchArgs {
                query: "тайник".into(),
                kind: Some(StashKind::Note),
                ..Default::default()
            },
        );
        assert_eq!(notes.total, 2);
        let files = page(
            &d,
            SearchArgs {
                query: "тайник".into(),
                kind: Some(StashKind::File),
                ..Default::default()
            },
        );
        assert_eq!(files.hits[0].entry.id, "f");
        let repo = page(
            &d,
            SearchArgs {
                query: "тайник".into(),
                repo: Some("repo-a".into()),
                ..Default::default()
            },
        );
        assert_eq!(page_ids(&repo), vec!["a"]);
        assert_eq!(repo.total, 1);
    }

    #[test]
    fn the_repo_filter_reads_the_stored_column_for_files_too() {
        let d = db("repo-files");
        d.file("f", "hdmi.md", b"hdmi schema", 1);
        d.note_in("n", "hdmi note", 2, Some("infra"));
        d.conn
            .execute("UPDATE entries SET repo = 'infra' WHERE id = 'f'", [])
            .unwrap();
        let p = page(
            &d,
            SearchArgs {
                query: "hdmi".into(),
                repo: Some("infra".into()),
                ..Default::default()
            },
        );
        assert_eq!(page_ids(&p), vec!["n", "f"]);
        // A window passes its project root; it is reduced to the basename.
        let by_root = page(
            &d,
            SearchArgs {
                query: "hdmi".into(),
                repo: Some("/Users/x/infra".into()),
                ..Default::default()
            },
        );
        assert_eq!(by_root.total, 2);
    }

    #[test]
    fn the_trash_is_searched_by_title_without_the_index() {
        let d = db("trash");
        d.note("live", "# Тайник живой\nтекст", 1);
        d.note("t1", "# Старый тайник\nключ", 2);
        d.note("t2", "# Тайник ОК\nключ", 3);
        d.note("t3", "# Другое\nтайник только в тексте", 4);
        trashed_at(&d, "t1", 100);
        trashed_at(&d, "t2", 200);
        trashed_at(&d, "t3", 300);
        assert!(
            d.fts_rows().iter().all(|(rowid, ..)| {
                let id: String = d
                    .conn
                    .query_row("SELECT id FROM entries WHERE rowid = ?1", [rowid], |r| {
                        r.get(0)
                    })
                    .unwrap();
                id == "live"
            }),
            "trashed notes are out of the index (A8)"
        );

        assert_eq!(
            ids(&d, "тайник"),
            vec!["live"],
            "the stash never shows the trash"
        );
        let trash = page(
            &d,
            SearchArgs {
                query: "тайник".into(),
                deleted: true,
                ..Default::default()
            },
        );
        assert_eq!(
            page_ids(&trash),
            vec!["t2", "t1"],
            "title only, newest deletion first"
        );
        assert!(trash
            .hits
            .iter()
            .all(|h| h.score == 0.0 && h.snippet.is_empty() && h.ranges.is_empty()));
        let short = page(
            &d,
            SearchArgs {
                query: "ок".into(),
                deleted: true,
                ..Default::default()
            },
        );
        assert_eq!(
            page_ids(&short),
            vec!["t2"],
            "short terms fold the same way"
        );
        let all = page(
            &d,
            SearchArgs {
                deleted: true,
                ..Default::default()
            },
        );
        assert_eq!(page_ids(&all), vec!["t3", "t2", "t1"]);
        let files = page(
            &d,
            SearchArgs {
                deleted: true,
                kind: Some(StashKind::File),
                ..Default::default()
            },
        );
        assert_eq!(files.total, 0, "the trash holds notes only");
    }

    #[test]
    fn pages_follow_the_cursor_and_report_the_total() {
        let d = db("pages");
        for i in 0..25 {
            d.note(&format!("n{i:02}"), "общий тайник", i);
        }
        let first = page(
            &d,
            SearchArgs {
                query: "тайник".into(),
                limit: Some(10),
                ..Default::default()
            },
        );
        assert_eq!(
            (first.hits.len(), first.total, first.next_cursor.as_deref()),
            (10, 25, Some("10"))
        );
        let last = page(
            &d,
            SearchArgs {
                query: "тайник".into(),
                limit: Some(10),
                cursor: Some("20".into()),
                ..Default::default()
            },
        );
        assert_eq!(
            (last.hits.len(), last.total, last.next_cursor),
            (5, 25, None)
        );
        let past = page(
            &d,
            SearchArgs {
                query: "тайник".into(),
                cursor: Some("99".into()),
                ..Default::default()
            },
        );
        assert_eq!(
            (past.hits.len(), past.total, past.next_cursor),
            (0, 25, None)
        );
        let mut seen: Vec<String> = Vec::new();
        let mut cursor = None;
        loop {
            let p = page(
                &d,
                SearchArgs {
                    query: "тайник".into(),
                    limit: Some(7),
                    cursor: cursor.clone(),
                    ..Default::default()
                },
            );
            seen.extend(p.hits.iter().map(|h| h.entry.id.clone()));
            match p.next_cursor {
                Some(c) => cursor = Some(c),
                None => break,
            }
        }
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), 25, "every hit exactly once across pages");
        assert!(search(
            &d.conn,
            &SearchArgs {
                cursor: Some("abc".into()),
                ..Default::default()
            }
        )
        .is_err());
    }

    #[test]
    fn a_hit_carries_a_snippet_around_the_match() {
        let d = db("snippet");
        let text = format!(
            "# Длинная\n{}подписать документ{}",
            "слово ".repeat(100),
            " хвост".repeat(100)
        );
        d.note("n1", &text, 1);
        let p = page(
            &d,
            SearchArgs {
                query: "мент".into(),
                ..Default::default()
            },
        );
        let hit = &p.hits[0];
        assert!(hit.snippet.contains("документ"));
        assert!(hit.snippet.starts_with('…'));
        let (a, b) = hit.ranges[0];
        assert_eq!(slice16(&hit.snippet, a, b), "мент");
    }

    #[test]
    fn a_title_only_hit_has_an_unmarked_snippet() {
        let d = db("title-only");
        d.file("f1", "hdmi-schema.png", &[0x89, b'P', 0, 1], 1);
        d.note("n1", "# ОК\nначало текста", 2);
        let p = page(
            &d,
            SearchArgs {
                query: "hdmi".into(),
                ..Default::default()
            },
        );
        assert_eq!(p.hits[0].entry.id, "f1");
        assert_eq!(p.hits[0].snippet, "");
        assert!(p.hits[0].ranges.is_empty());
        let short = page(
            &d,
            SearchArgs {
                query: "ок".into(),
                ..Default::default()
            },
        );
        assert_eq!(
            short.hits[0].snippet, "ОК начало текста",
            "the body's start, unmarked"
        );
        assert!(short.hits[0].ranges.is_empty());
    }

    #[test]
    fn a_hit_is_the_entry_as_the_database_knows_it() {
        let d = db("entry");
        d.note_in("n1", "# Тайник\nтекст", 5, Some("infra"));
        d.tag("n1", "b-tag");
        d.tag("n1", "a-tag");
        let hit = &page(
            &d,
            SearchArgs {
                query: "тайник".into(),
                ..Default::default()
            },
        )
        .hits[0];
        assert_eq!(hit.entry.title.as_deref(), Some("Тайник"));
        assert_eq!(hit.entry.repo.as_deref(), Some("infra"));
        assert_eq!(hit.entry.tags, vec!["a-tag", "b-tag"]);
        assert_eq!(
            hit.entry.preview, "",
            "the preview is the command's Enrich, after the lock"
        );
        let enriched = page(
            &d,
            SearchArgs {
                query: "тайник".into(),
                ..Default::default()
            },
        )
        .enrich();
        assert_eq!(enriched.hits[0].entry.preview, "# Тайник\nтекст");
        assert_eq!(enriched.total, 1);
    }

    #[test]
    fn rebuild_gives_the_same_answers() {
        let d = db("rebuild-eq");
        d.note("n1", "# Тайник\nключ от шкафа", 10);
        d.note("n2", "документ про тайник", 20);
        d.note("n3", "# ОК\nпереговорка на третьем", 30);
        d.file("f1", "hdmi.md", "- hdmi переговорка".as_bytes(), 40);
        d.tag("n2", "infra");
        std::fs::write(d.path_of("n1"), "# Тайник\nключ от сейфа").unwrap();
        reindex_path(&d.conn, &d.path_of("n1"), "# Тайник\nключ от сейфа").unwrap();

        let queries = [
            "тайник",
            "мент",
            "\"на третьем\"",
            "#infra тайник",
            "ок",
            "переговорка",
            "",
        ];
        let snapshot = |d: &Db| -> Vec<Vec<(String, String, Vec<(u32, u32)>, String)>> {
            queries
                .iter()
                .map(|q| {
                    page(
                        d,
                        SearchArgs {
                            query: q.to_string(),
                            ..Default::default()
                        },
                    )
                    .hits
                    .into_iter()
                    .map(|h| {
                        (
                            h.entry.id.clone(),
                            h.snippet,
                            h.ranges,
                            format!("{:.9}", h.score),
                        )
                    })
                    .collect()
                })
                .collect()
        };
        let before = snapshot(&d);
        rebuild_index(&d.conn).unwrap();
        assert_eq!(snapshot(&d), before);
    }

    #[test]
    fn arg_helpers() {
        assert_eq!(parse_cursor(None), Ok(0));
        assert_eq!(parse_cursor(Some("30")), Ok(30));
        assert!(parse_cursor(Some("-1")).is_err());
        assert!(
            parse_cursor(Some("c.123")).is_err(),
            "a stash_list cursor is not a search cursor"
        );
        assert_eq!(clamp_limit(None), SEARCH_DEFAULT_LIMIT);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(10_000)), SEARCH_MAX_LIMIT);
    }

    #[test]
    fn a_page_serializes_to_the_ipc_shape() {
        let d = db("serde");
        d.note("n1", "тайник", 1);
        let v = serde_json::to_value(page(
            &d,
            SearchArgs {
                query: "тайник".into(),
                ..Default::default()
            },
        ))
        .unwrap();
        assert_eq!(v["total"], 1);
        assert!(v["nextCursor"].is_null());
        assert_eq!(v["hits"][0]["entry"]["id"], "n1");
        assert_eq!(v["hits"][0]["ranges"][0], serde_json::json!([0, 6]));
        assert!(v["hits"][0]["score"].as_f64().unwrap() > 0.0);
    }

    /// Not a benchmark, and deliberately no time assertion (machines vary):
    /// it proves 1000 notes search correctly and prints how long it took.
    /// Ignored so the suite stays fast; run it in release and copy the
    /// `stash search perf:` lines into the plan's "Recorded facts":
    /// `cargo test --release … thousand_notes_search_sanity -- --ignored --nocapture`
    #[test]
    #[ignore = "perf sanity: run with --release --ignored --nocapture"]
    fn thousand_notes_search_sanity() {
        const WORDS: [&str; 16] = [
            "тайник",
            "документ",
            "переговорка",
            "ключ",
            "сервер",
            "бэкап",
            "отчёт",
            "задача",
            "кабель",
            "проект",
            "встреча",
            "план",
            "доступ",
            "пароль",
            "сеть",
            "заметка",
        ];
        const RUNS: usize = 21;
        let ms = |d: std::time::Duration| d.as_secs_f64() * 1000.0;
        let file_size = |p: &std::path::Path| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        let checkpoint = |d: &Db| {
            d.conn
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
                .unwrap();
        };

        let d = db("perf");
        let db_path = d.dir.join("stash.db");
        let mut seed: u64 = 42;
        let mut next = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 33) as usize
        };
        let started = std::time::Instant::now();
        let mut text_bytes = 0;
        for i in 0..1000 {
            let title = WORDS[next() % WORDS.len()];
            let body: Vec<&str> = (0..300).map(|_| WORDS[next() % WORDS.len()]).collect();
            let text = format!("# {title} {i}\n{}", body.join(" "));
            text_bytes += text.len();
            d.note(&format!("n{i:04}"), &text, i as i64);
            if i % 10 == 0 {
                d.tag(&format!("n{i:04}"), "infra");
            }
        }
        eprintln!(
            "stash search perf: indexed 1000 notes one by one ({:.1} MiB of text, incl. file writes) in {:.0} ms",
            text_bytes as f64 / 1048576.0,
            ms(started.elapsed())
        );
        checkpoint(&d);
        let with_index = file_size(&db_path);

        // The startup rebuild (missing/corrupt/outdated index): from an empty
        // FTS table, reading every file back.
        d.conn.execute("DELETE FROM entries_fts", []).unwrap();
        d.conn.execute_batch("VACUUM").unwrap();
        checkpoint(&d);
        let without_index = file_size(&db_path);
        let started = std::time::Instant::now();
        assert_eq!(rebuild_index(&d.conn).unwrap(), 1000);
        eprintln!(
            "stash search perf: rebuild_index of 1000 notes from an empty index in {:.0} ms",
            ms(started.elapsed())
        );
        checkpoint(&d);
        eprintln!(
            "stash search perf: stash.db {:.1} MiB with the index ({:.1} MiB incrementally built), {:.1} MiB without it",
            file_size(&db_path) as f64 / 1048576.0,
            with_index as f64 / 1048576.0,
            without_index as f64 / 1048576.0
        );

        let queries: [(&str, &str, bool); 7] = [
            ("long term", "тайник", true),
            ("trigram piece", "мент", true),
            ("phrase", "\"сервер бэкап\"", true),
            ("short, title fallback", "пл", true),
            ("three terms", "ключ доступ пароль", true),
            ("tag + text", "#infra сервер", true),
            ("no hits", "жираф", false),
        ];
        for (label, q, hits_expected) in queries {
            let args = SearchArgs {
                query: q.into(),
                limit: Some(50),
                ..Default::default()
            };
            let mut times = Vec::with_capacity(RUNS);
            let mut last = None;
            for _ in 0..RUNS {
                let started = std::time::Instant::now();
                let p = search(&d.conn, &args).unwrap();
                times.push(started.elapsed());
                last = Some(p);
            }
            let p = last.unwrap();
            let first = times[0];
            times.sort();
            eprintln!(
                "stash search perf: {label} {q:?} → {} of {} hits: median {:.2} ms, first {:.2} ms, max {:.2} ms",
                p.hits.len(),
                p.total,
                ms(times[RUNS / 2]),
                ms(first),
                ms(times[RUNS - 1])
            );
            if hits_expected {
                assert!(p.total > 0, "{q:?} found nothing in 1000 generated notes");
            } else {
                assert_eq!(p.total, 0, "{q:?} must find nothing");
            }
        }

        // The save hook's cost for a note at the body cap: one reindex of
        // ~1 MiB of markdown (plain_text + FTS5 DELETE and INSERT), kept just
        // under the cap so the edit at its end is indexed.
        let line: Vec<&str> = (0..12).map(|_| WORDS[next() % WORDS.len()]).collect();
        let line = format!("- {}\n", line.join(" "));
        let big = format!(
            "# Большая заметка\n{}",
            line.repeat((1024 * 1024 - 4096) / line.len())
        );
        d.note("big", &big, 2000);
        let path = d.path_of("big");
        let mut times = Vec::new();
        for n in 0..5 {
            let edited = format!("{big}правка {n}\n");
            let started = std::time::Instant::now();
            assert!(reindex_path(&d.conn, &path, &edited).unwrap());
            times.push(started.elapsed());
        }
        times.sort();
        eprintln!(
            "stash search perf: reindex_path of a {:.2} MiB note: median {:.1} ms, max {:.1} ms (5 runs)",
            big.len() as f64 / 1048576.0,
            ms(times[2]),
            ms(times[4])
        );
        assert_eq!(ids(&d, "\"правка 4\""), vec!["big"]);
    }
}
