# Stash 05 — Search Implementation Plan

> **⚠️ Roadmap amendments override this plan.** Read the section «Amendments after planning» in `2026-09-27-stash-00-roadmap.md` first. Most visible here: **A1 — the notes folder is `~/couplet/` (dev `~/couplet-dev/`), not `~/Documents/…`**: use `dirs::home_dir()` instead of `dirs::document_dir()`, rename every `Documents` base in tests to a home base, and drop every TCC-prompt note or step (the home root is not TCC-protected). Also A2 (offline build, `functions` feature), A3 (`repo` = directory name) and A5 (schema v2).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One search for the human and the agent: keep the FTS5 trigram index `entries_fts` in step with the stash, parse the query language (`plain words`, `#tag`, `"phrases"`), rank by bm25 with title above body, return ~200-char snippets with highlight ranges through `stash_search`, and switch the stash drawer's filter from substring matching to that command, with highlighted snippets in the cards.

**Architecture:** A Rust submodule `src-tauri/src/stash/search/` owns everything about the index: turning an entry's text into the plain, capped body the index stores (`text.rs`), keeping `entries_fts` in sync and rebuilding it (`index.rs`), the query language (`query.rs`), snippets with UTF-16 highlight ranges (`snippet.rs`) and the SQL that runs a search (`run.rs`). Stage 02/03's domain functions (create note, put away, `on_file_written`) call the index functions, so every writer — the app, and later the CLI/MCP of stage 07 — indexes the same way. The frontend gets a TypeScript copy of the query parser (both copies are checked against one JSON fixture), a debounced "last one wins" search runner, and the drawer wiring. Whenever the search fails (the browser dev server, an index error), the drawer falls back to stage 04's local substring filter.

**Tech Stack:** Tauri 2 (Rust), `rusqlite` (bundled SQLite: FTS5 `trigram` tokenizer, `bm25()`, a scalar function via the `functions` feature), Svelte 5 runes, vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-09-26-stash-design.md`, section «Поиск» (and «Агент» for the snippet size). Spec wins on behaviour. Roadmap row 05 and shared contracts: `docs/superpowers/plans/2026-09-27-stash-00-roadmap.md`.

**Contract additions made by this stage** (the roadmap requires a stage to say so in its header):

| Addition | Where | Why |
|---|---|---|
| `stash_search` takes an optional `deleted?: boolean` (default `false`) | IPC table | The «Удалённые» view (stage 06) filters with the same box; without it the trash can't be searched. |
| `StashHit.ranges` are **UTF-16 code units** of `snippet`; `score` is `-bm25` (higher is better), `0` when no FTS term was used | `types.ts` / Rust `StashHit` | The contract says "offsets" without a unit. JS `String.slice` counts UTF-16 units; Cyrillic is 1 unit per char, emoji are 2. |
| `nextCursor` is an opaque string (a decimal offset today) | IPC | Relevance order has no stable key to build a keyset cursor from. |
| Table `search_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`, created by `search::ensure_index` with `CREATE TABLE IF NOT EXISTS`, **outside** `user_version` | `stash.db` | Records `index_version`, so a change to what the index stores triggers a rebuild. It is index bookkeeping like FTS5's own shadow tables, not user data. Keeping it out of `user_version` avoids clashing with stages 06/07 over the migration number. |
| SQL function `stash_fold(text)` (Rust `to_lowercase`), registered in `stash::db::open` | every connection | SQLite's `lower()` and `LIKE` fold ASCII only, so without it «ок» would not find «ОК» in a title. |
| `rusqlite` feature `functions` | `src-tauri/Cargo.toml` | Needed for `create_scalar_function`. It is a feature of a crate already in the tree, not a new dependency, and needs no network fetch. |
| The module is a directory `stash/search/` (`mod.rs` + 5 files) instead of one `search.rs` | Rust layout | Same module path `stash::search`. Five concerns, each with its own tests, are easier to handle as separate files than one ~1000-line file. |
| The FTS `body` column holds **plain text** (markdown markers stripped, link URLs kept), capped at 1 MiB of source | `entries_fts` | Snippets are cut from the stored body, so matching and snippets agree on one text. `**` and `#` never become search hits. |

---

## Conventions for every task

- **Worktree / branch:** the stash implementation worktree named in `docs/superpowers/plans/2026-09-27-stash-implementer-prompt.md`, branch `feat/stash`, with stages 02–04 already committed. Run every command from the worktree root. Never `git stash`, `checkout`, `reset` or `restore`. `git add` takes explicit paths only, and each commit uses the same pathspec.
- **Rust:** every cargo command is prefixed with `CARGO_TARGET_DIR=~/.cargo/stash-impl-target`. Per task: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::search`. After every Rust task, check clippy against the baseline recorded in Task 0: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo clippy --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "generated [0-9]+ warning"`.
- **Frontend:** `npx vitest run <file>` per task, `npx vitest run --dir src` for the full suite (plain `npm run test` overcounts stale worktree copies), `npm run check` for types.
- **Never** `npm run tauri dev` / `npm run tauri build` / `npm run build:universal`, or anything that touches `~/Documents/couplet/` or the release `stash.db`. For live checks use `npm run dev:app -- --features mcp-bridge` (dev identity, own `CARGO_TARGET_DIR`), per `CLAUDE.md`.
- **Commits:** conventional, one per task, ending with the trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- No `any`. Runes outside components need `*.svelte.ts`. Comments state only the constraints the code can't show.
- **Data safety:** this stage deletes nothing but rows of the derived index. `rebuild_index` and `ensure_index` never touch `entries`, `tags` or any file.

## Design decisions this plan commits to

| # | Decision | Why |
|---|---|---|
| D1 | Every query term with **≥ 3 Unicode scalar values** becomes a double-quoted FTS5 string (`"тайник"`), with `"` doubled, all joined with ` AND `, **bound as a parameter**. | Inside an FTS5 string, `AND`/`OR`/`NOT`/`NEAR`/`*`/`^`/`:`/parentheses are plain characters, and `""` is FTS5's only escape. The user's syntax therefore can't reach the query parser or the SQL. With trigrams, a quoted string is a substring match, so word forms and word middles come for free. |
| D2 | Terms of **1–2 chars** are matched as `instr(stash_fold(e.title), ?) > 0`, i.e. substring of the title, case-folded in Rust. They are ANDed with the rest of the query. | This is the spec rule («короче трёх символов … ищет по заголовкам простым вхождением»). Trigram MATCH finds nothing for them. SQLite's `LIKE`/`lower()` fold only ASCII, and `instr` needs no `%`/`_` escaping. |
| D3 | Rank = `-bm25(entries_fts, 10.0, 1.0)` (title 10, body 1); ties broken by `max(modified_at, coalesce(stashed_at, 0)) DESC`, then `rowid DESC`. | A body term's bm25 contribution is bounded by `(k1+1)·idf = 2.2·idf`. A single title hit on a title of average length contributes `idf·2.2/(1+1.2) = 1.0·idf`, and still `0.55·idf` at 3× average length. At weight 10 that is ≥ `5.5·idf > 2.2·idf`, so **any title hit outranks any body-only hit** for the same terms, which is what the spec asks. The title line is also part of the body, so a title match never loses its body score. `rowid` makes the order total, which keeps pagination deterministic. |
| D4 | Snippets are computed in Rust by our own windowing over the stored plain body, **not** by FTS5 `snippet()`/`highlight()`. | `snippet()` counts its window in tokens (≤ 64). For trigrams a token is roughly one character, so it can't produce ~200 chars. `highlight()` embeds markers in the text, which would then have to be parsed back out, and the text can contain the markers. Neither gives offsets. Neither covers title-only hits (short terms, binary files). Our windowing returns `(text, ranges)` directly, with ranges in UTF-16 units. |
| D5 | Snippet window: 200 chars, starting ≤ 60 chars before the **earliest** match. Each cut moves up to 16 chars to land on a space. `…` is added at a cut end. Every match inside the window is highlighted (overlaps merged). No match in the body (a title-only hit) → the first 200 chars, no ranges. | The spec asks for «фрагмент вокруг совпадения, а не начало текста». Anchoring on the earliest match is simple and predictable. |
| D6 | The index stores `title` = `entries.title` and `body` = plain text of the file. The body is taken from at most **1 MiB** (`BODY_CAP_BYTES = 1_048_576`) of the file. A NUL in the first 8 KiB means binary: title only. An unreadable or missing file: title only, logged. Indexing never fails the caller's write. | A file reference can point at anything (a log, a dump), and a put-away must not read gigabytes under the stash lock. Past the cap, a file is still found by its title and its first MiB. |
| D7 | `index_entry(conn, id)` re-reads the file. `reindex_path(conn, path, text)` uses the text it was given (the write that just landed). `unindex_entry(conn, id)` must run **before** the `entries` row is deleted. Upsert = `DELETE` + `INSERT` by rowid. | `INTEGER PRIMARY KEY` without `AUTOINCREMENT` reuses the highest rowid after its row is deleted, so an orphan FTS row could attach itself to a new entry. Every write overwrites by rowid, and search always `JOIN`s `entries`, so an orphan is never visible. `ensure_index` sweeps orphans at startup. |
| D8 | `ensure_index` runs once at app startup on a background thread. It rebuilds when the FTS table is **missing**, fails FTS5 `integrity-check` (**corrupt**, dropped and recreated with the exact v1 DDL), has a `search_meta.index_version` other than `INDEX_VERSION` (**version**), or has a row count or orphans that disagree with `entries` (**stale**). After a rebuild it emits `stash-changed` `{ reason: "index-rebuilt" }`. | The index is derived and always rebuildable (spec «Хранение»). The first launch of this stage finds no version and indexes everything stages 02–04 stored. |
| D9 | Candidates (rowid, id, kind, repo, score) come from **one SQL query without LIMIT**. The `repo` filter is applied in Rust: notes compare the `repo` column, files use the repo stage 02 derives when it loads the entry. Then `total` is counted and the page sliced. Snippets and full entries are built for the page only. | The roadmap stores `repo = NULL` for files and derives it at read time, so SQL can't filter it. Filtering in Rust keeps `total` and the cursor correct. Candidates are small tuples, so thousands cost nothing. |
| D10 | An empty query, or one with no terms (only tags, or only `"`), returns every entry that passes the filters, newest first, with score 0. | Consistent behaviour, and it keeps `#tag` alone useful. The drawer never sends an empty query (it shows stage 04's list then). |
| D11 | The drawer calls `stash_search` for any non-blank query, debounced 120 ms, through `latestOnly()`. A new keystroke invalidates in-flight results at once, and the previous hits stay on screen until new ones arrive. While a query is active the list is in **relevance order**: ⌘L/⌘R/⌘U change the order only once the query is cleared. On error, `hits = null` and stage 04's substring filter applies. | Avoids flicker. A stale prefix result never overwrites a newer one. The drawer keeps working in `npm run dev` (no IPC) and if the index breaks. |
| D12 | The query parser exists twice (Rust `parse_query`, TS `parseSearchQuery`). Both are held to one fixture file, `src-tauri/tests/fixtures/stash-queries.json`. Separators are an explicit set (`' ' \t \n \r U+00A0 U+3000`), not "Unicode whitespace". Length is counted in Unicode scalar values. | The drawer highlights with the TS parse, while Rust searches. They must agree on what a term is. JS `\s` and Rust `char::is_whitespace` differ on U+FEFF and U+0085. This is the same pattern as the menu-accelerator mirror. |
| D13 | Case folding: FTS5 trigram (`case_sensitive=0`, Unicode folding) for long terms, Rust `to_lowercase` for short terms and snippets, JS `toLowerCase` for title highlight. `ё` is **not** folded to `е`. | Same as the tabs drawer's filter («`ё` does not match `е`, as in the mockup»). |

## Assumed surface from stages 02–04

The stage 02–04 plans were written in parallel with this one, so their exact identifiers could not be read. This plan relies on the names below. **Task 0 checks each one.** If only a *name* differs, substitute the real name everywhere this plan uses it (a mechanical rename). If the *semantics* differ (e.g. no function returns a `StashEntry` for an id), stop and report before writing code.

| Used here as | Expected (roadmap) | Stage |
|---|---|---|
| `crate::stash::db::open(path: &Path) -> Result<rusqlite::Connection, String>` — opens, sets pragmas, runs `migrate` | `db.rs` "open, pragmas, migrate" | 02 |
| `crate::stash::StashEntry` (`Serialize`, fields per roadmap: `id`, `kind`, `path`, `title: Option<String>`, `repo: Option<String>`, …) | `mod.rs` public API | 02 |
| `crate::stash::entries::get(conn: &Connection, id: &str) -> Result<StashEntry, String>` — loads one entry with tags, derived `repo`/`branch` and `preview` | backs `stash_get` | 02 |
| `crate::stash::entries::create_note(...)` — inserts a note row after its file is written; returns the `StashEntry` | backs `stash_create_note` | 02 |
| `crate::stash::entries::put_away(...)` — insert-or-bump per path; returns `Vec<PutAwayResult>` | backs `stash_put_away` | 02 |
| `crate::stash::on_file_written(path: &str, text: &str)` and the connection-level function it calls (named `entries::file_written(conn, path, text)` below) | hook in `commands.rs::write_file` | 02 |
| `crate::stash::notes::title_of(text: &str) -> Option<String>` | `notes.rs` | 02 |
| `crate::stash::StashState` with the connection in a field `conn: Mutex<Connection>` | `mod.rs` | 02 |
| `src/lib/stash/types.ts` exports `StashEntry`, `StashHit`, `StashKind` | roadmap types | 03 |
| `src/lib/stash/ipc.ts` wraps `invoke` from `@tauri-apps/api/core` | roadmap | 03 |
| `src/lib/stash/stash-store.svelte.ts`: a store with `query: string`, `repoFilter: string \| null`, `tagFilter: string \| null`, `trash: boolean`, and a derived list of visible entries built from the substring filter in `stash-query.ts` | roadmap | 04 |
| `StashDrawer.svelte` renders `StashCard` per visible entry; the stash colour is a CSS custom property (named `--stash-accent` below) | roadmap / mockup | 04 |

## File Structure

| File | Responsibility |
|---|---|
| `src-tauri/src/stash/search/mod.rs` (new) | Module doc; re-exports the public search API. |
| `src-tauri/src/stash/search/query.rs` (new) | Pure: `parse_query`, `Term`, `SearchQuery`, `fts_match`, `short_terms`, `TRIGRAM_MIN`. |
| `src-tauri/src/stash/search/text.rs` (new) | Pure + disk read: `plain_text`, `plain_line`, `is_markdown_path`, `read_capped`, `cap`, `BODY_CAP_BYTES`. |
| `src-tauri/src/stash/search/snippet.rs` (new) | Pure: `make_snippet` → `Snippet { text, ranges (UTF-16) }`. |
| `src-tauri/src/stash/search/index.rs` (new) | `register_functions`, `index_entry`, `reindex_path`, `unindex_entry`, `rebuild_index`, `ensure_index`, `RebuildReason`, `INDEX_VERSION`. |
| `src-tauri/src/stash/search/run.rs` (new) | `search` (SQL, filters, ranking, pagination, snippets), `SearchArgs`, `SearchPage`, `StashHit`, arg helpers. |
| `src-tauri/src/stash/search/test_support.rs` (new, `cfg(test)`) | Scratch DB + helpers to insert and index notes/files/tags. |
| `src-tauri/tests/fixtures/stash-queries.json` (new) | Shared parser fixture (Rust + TS). |
| `src-tauri/src/stash/mod.rs` (modify) | `pub mod search;`; `on_file_written` → `reindex_path`. |
| `src-tauri/src/stash/db.rs` (modify) | `open` registers `stash_fold`. |
| `src-tauri/src/stash/entries.rs` (modify) | `create_note` / `put_away` call `index_entry`. |
| `src-tauri/src/stash/commands.rs` (modify) | `stash_search` command. |
| `src-tauri/src/lib.rs` (modify) | Register `stash_search`; start-up `ensure_index` thread. |
| `src-tauri/Cargo.toml` (modify) | `rusqlite` feature `functions`. |
| `src/lib/stash/stash-query.ts` (modify) | `parseSearchQuery`, `isLongTerm`, `highlightTerms`, `segmentsFromRanges`. |
| `src/lib/stash/stash-query-search.test.ts` (new) | Fixture parity + highlight tests. |
| `src/lib/stash/types.ts`, `src/lib/stash/ipc.ts` (modify) | `StashSearchArgs`, `StashSearchResult`, `stashSearch`. |
| `src/lib/stash/stash-search.ts` (+ test) (new) | Debounced latest-only runner, `toArgs`, `visibleFromHits`. |
| `src/lib/stash/stash-store.svelte.ts`, `StashDrawer.svelte`, `StashCard.svelte` (modify) | Hits in the store, runner wiring, highlighted title + snippet. |
| `locales/{ru,en,de,es,fr,zh}/app.json` (modify) | `stash.search.none`, `stash.search.more`. |
| `CLAUDE.md` (modify) | Architecture line + search gotchas. |

---

### Task 0: Preflight (no commit)

**Files:** none changed.

- [ ] **Step 1: Confirm stages 02–04 are on the branch**

Run: `git log --oneline -40 | grep -E "stash" | head -40`
Expected: commits from stages 02, 03 and 04. If stage 04's drawer commits are missing, stop: this plan wires into its drawer.

- [ ] **Step 2: Check the assumed Rust surface**

Run:
```bash
grep -n "pub fn open" src-tauri/src/stash/db.rs
grep -n "pub struct StashEntry\|pub struct StashState\|pub fn on_file_written\|pub mod\|^mod " src-tauri/src/stash/mod.rs
grep -n "pub fn " src-tauri/src/stash/entries.rs src-tauri/src/stash/notes.rs
grep -n "conn" src-tauri/src/stash/mod.rs | head -20
grep -n "entries_fts" -r src-tauri/src/stash
grep -n "rusqlite" src-tauri/Cargo.toml
ls src-tauri/tests/fixtures/ 2>/dev/null
```
Expected: every row of "Assumed surface from stages 02–04" is found (possibly under another name). `entries_fts` appears only in the v1 DDL in `db.rs`. `rusqlite` has `bundled`. Write down each real name next to the assumed one. The following tasks use the assumed names, so substitute as you go.

- [ ] **Step 3: Check the assumed frontend surface**

Run:
```bash
ls src/lib/stash/
grep -n "export" src/lib/stash/types.ts src/lib/stash/ipc.ts src/lib/stash/stash-query.ts
grep -n "\$state\|\$derived" src/lib/stash/stash-store.svelte.ts
grep -n "StashCard\|stash-query\|--stash" src/lib/stash/StashDrawer.svelte | head -20
grep -rn "stash-changed" src/lib/stash | head
```
Expected: the fields and the card usage listed in the table. Write down the real names of the query, repo filter, tag filter and trash-mode fields, the derived visible list, the predicate that hides entries open as tabs in this window, and the stash colour custom property.

- [ ] **Step 4: Record baselines**

Run:
```bash
npx vitest run --dir src 2>&1 | tail -4
CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^test result"
CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo clippy --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "generated [0-9]+ warning"
```
Write down the three numbers in the night report under "stage 05 baselines". Every later clippy check expects the same warning count.

---

### Task 1: The query language in Rust, and the shared fixture

**Files:**
- Create: `src-tauri/tests/fixtures/stash-queries.json`
- Create: `src-tauri/src/stash/search/mod.rs`
- Create: `src-tauri/src/stash/search/query.rs`
- Modify: `src-tauri/src/stash/mod.rs` (add `pub mod search;`)

- [ ] **Step 1: Write the shared fixture**

Create `src-tauri/tests/fixtures/stash-queries.json` (create the directory with `mkdir -p src-tauri/tests/fixtures` if stage 03 has not):

```json
[
  { "input": "", "tags": [], "terms": [] },
  { "input": "тайник", "tags": [], "terms": [{ "text": "тайник", "phrase": false }] },
  { "input": "  Тайник   мент ", "tags": [], "terms": [{ "text": "Тайник", "phrase": false }, { "text": "мент", "phrase": false }] },
  { "input": "#Infra hdmi", "tags": ["infra"], "terms": [{ "text": "hdmi", "phrase": false }] },
  { "input": "#infra #INFRA", "tags": ["infra"], "terms": [] },
  { "input": "\"переговорка на третьем\" hdmi", "tags": [], "terms": [{ "text": "переговорка на третьем", "phrase": true }, { "text": "hdmi", "phrase": false }] },
  { "input": "\"незакрытая фраза", "tags": [], "terms": [{ "text": "незакрытая фраза", "phrase": true }] },
  { "input": "a\"b c\"d", "tags": [], "terms": [{ "text": "a", "phrase": false }, { "text": "b c", "phrase": true }, { "text": "d", "phrase": false }] },
  { "input": "#", "tags": [], "terms": [{ "text": "#", "phrase": false }] },
  { "input": "\"\"", "tags": [], "terms": [] },
  { "input": "\"   \"", "tags": [], "terms": [] },
  { "input": "NEAR(a b)", "tags": [], "terms": [{ "text": "NEAR(a", "phrase": false }, { "text": "b)", "phrase": false }] },
  { "input": "x y", "tags": [], "terms": [{ "text": "x", "phrase": false }, { "text": "y", "phrase": false }] },
  { "input": "\"#tag inside\"", "tags": [], "terms": [{ "text": "#tag inside", "phrase": true }] },
  { "input": "ТАЙНИК#tag", "tags": [], "terms": [{ "text": "ТАЙНИК#tag", "phrase": false }] },
  { "input": "*", "tags": [], "terms": [{ "text": "*", "phrase": false }] },
  { "input": "\" пробелы по краям \"", "tags": [], "terms": [{ "text": "пробелы по краям", "phrase": true }] },
  { "input": "#Тайник ключ", "tags": ["тайник"], "terms": [{ "text": "ключ", "phrase": false }] }
]
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/stash/search/query.rs` containing only the tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Case {
        input: String,
        tags: Vec<String>,
        terms: Vec<Term>,
    }

    #[test]
    fn parses_every_shared_fixture_case() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../../tests/fixtures/stash-queries.json")).unwrap();
        assert!(cases.len() >= 18, "the fixture lost cases");
        for case in cases {
            let q = parse_query(&case.input);
            assert_eq!(q.tags, case.tags, "tags of {:?}", case.input);
            assert_eq!(q.terms, case.terms, "terms of {:?}", case.input);
        }
    }

    fn term(text: &str) -> Term {
        Term { text: text.to_string(), phrase: false }
    }

    #[test]
    fn length_is_counted_in_chars_not_bytes() {
        assert!(term("тай").is_long(), "3 Cyrillic chars are 6 bytes but 3 chars");
        assert!(!term("ай").is_long());
        assert!(term("😀😀😀").is_long());
        assert!(!term("ab").is_long());
    }

    #[test]
    fn fts_match_quotes_every_long_term_and_ands_them() {
        let q = parse_query("тайник \"на третьем\" ок");
        assert_eq!(fts_match(&q.terms).as_deref(), Some("\"тайник\" AND \"на третьем\""));
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
            assert_eq!(fts_match(&parse_query(input).terms).as_deref(), Some(expected), "{input}");
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
    fn short_terms_are_folded() {
        assert_eq!(short_terms(&parse_query("ОК тайник Ab").terms), vec!["ок", "ab"]);
    }
}
```

Create `src-tauri/src/stash/search/mod.rs`:

```rust
//! Full-text search over the stash (spec «Поиск»): one index, one query
//! language and one ranking for the drawer and for agents.
//!
//! `entries_fts` (roadmap schema v1, trigram tokenizer, rowid = entries.rowid)
//! is derived data: everything here may fail without losing anything, and
//! `rebuild_index` recreates it from the entries and their files.

mod query;

pub use query::{fts_match, parse_query, short_terms, SearchQuery, Term, TRIGRAM_MIN};
```

In `src-tauri/src/stash/mod.rs`, next to the other module declarations, add:

```rust
pub mod search;
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::search::query`
Expected: FAIL to compile with `cannot find function parse_query` / `cannot find type Term`.

- [ ] **Step 4: Implement the parser**

Add above the test module in `src-tauri/src/stash/search/query.rs`:

```rust
//! The stash query language: plain words, `#tag`, "quoted phrases", all
//! ANDed. Mirrored by `parseSearchQuery` in `src/lib/stash/stash-query.ts`;
//! both are held to `src-tauri/tests/fixtures/stash-queries.json`.

use serde::Deserialize;

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
        self.text.to_lowercase()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchQuery {
    /// Lower-case, without '#', no duplicates, in order of appearance.
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
            let phrase: String = chars[start..end.min(chars.len())].iter().collect();
            let phrase = phrase.trim_matches(is_separator);
            if !phrase.is_empty() {
                q.terms.push(Term { text: phrase.to_string(), phrase: true });
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
        match word.strip_prefix('#') {
            Some(tag) if !tag.is_empty() => {
                let tag = tag.to_lowercase();
                if !q.tags.contains(&tag) {
                    q.tags.push(tag);
                }
            }
            _ => q.terms.push(Term { text: word, phrase: false }),
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
    terms.iter().filter(|t| !t.is_long()).map(Term::folded).collect()
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::search::query`
Expected: PASS, 7 tests. Run clippy and compare with the Task 0 baseline. If clippy reports `dead_code` for a re-export that nothing calls yet, that is expected until Task 7 uses it. Write the count down and re-check at Task 7, where it must return to the baseline.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/tests/fixtures/stash-queries.json src-tauri/src/stash/search/mod.rs src-tauri/src/stash/search/query.rs src-tauri/src/stash/mod.rs
git commit -m "feat(stash): search query language — words, #tags, phrases, safe FTS5 MATCH

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src-tauri/tests/fixtures/stash-queries.json src-tauri/src/stash/search/mod.rs src-tauri/src/stash/search/query.rs src-tauri/src/stash/mod.rs
```

---

### Task 2: The query language in TypeScript, and highlight helpers

**Files:**
- Modify: `src/lib/stash/stash-query.ts` (append; stage 04's substring filter stays)
- Create: `src/lib/stash/stash-query-search.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/stash/stash-query-search.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseSearchQuery,
  isLongTerm,
  highlightTerms,
  segmentsFromRanges,
  type SearchTerm,
} from './stash-query';

const FIXTURE = fileURLToPath(
  new URL('../../../src-tauri/tests/fixtures/stash-queries.json', import.meta.url)
);

interface Case {
  input: string;
  tags: string[];
  terms: SearchTerm[];
}

const cases = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Case[];

describe('parseSearchQuery', () => {
  it('HasTheWholeSharedFixture', () => {
    expect(cases.length).toBeGreaterThanOrEqual(18);
  });

  it.each(cases)('ParsesLikeRust %j', (c) => {
    expect(parseSearchQuery(c.input)).toEqual({ tags: c.tags, terms: c.terms });
  });
});

describe('isLongTerm', () => {
  it('CountsCodePointsNotUtf16Units', () => {
    expect(isLongTerm({ text: 'тай', phrase: false })).toBe(true);
    expect(isLongTerm({ text: 'ай', phrase: false })).toBe(false);
    // 3 code points, 6 UTF-16 units: long, as in Rust.
    expect(isLongTerm({ text: '😀😀😀', phrase: false })).toBe(true);
    // 1 code point, 2 UTF-16 units: short.
    expect(isLongTerm({ text: '😀', phrase: false })).toBe(false);
  });
});

describe('highlightTerms', () => {
  const t = (text: string): SearchTerm => ({ text, phrase: false });

  it('MarksEveryOccurrenceIgnoringCase_Cyrillic', () => {
    expect(highlightTerms('Тайник и тайники', [t('тайник')])).toEqual([
      { text: 'Тайник', hit: true },
      { text: ' и ', hit: false },
      { text: 'тайник', hit: true },
      { text: 'и', hit: false },
    ]);
  });

  it('MergesOverlappingTerms', () => {
    expect(highlightTerms('документация', [t('документ'), t('мент')])).toEqual([
      { text: 'документ', hit: true },
      { text: 'ация', hit: false },
    ]);
  });

  it('NoTerms_WholeTextUnmarked', () => {
    expect(highlightTerms('заметка', [])).toEqual([{ text: 'заметка', hit: false }]);
  });

  it('LowercasingChangesLength_NoHighlightRatherThanWrongCuts', () => {
    expect(highlightTerms('İstanbul', [t('stan')])).toEqual([{ text: 'İstanbul', hit: false }]);
  });
});

describe('segmentsFromRanges', () => {
  it('CutsAtUtf16Offsets_EmojiBeforeTheHit', () => {
    // '😀' is two UTF-16 units, so «тайник» spans [3, 9).
    expect(segmentsFromRanges('😀 тайник', [[3, 9]])).toEqual([
      { text: '😀 ', hit: false },
      { text: 'тайник', hit: true },
    ]);
  });

  it('SortsMergesAndClampsRanges', () => {
    expect(
      segmentsFromRanges('abcdef', [
        [4, 99],
        [0, 2],
        [1, 3],
        [5, 5],
      ])
    ).toEqual([
      { text: 'abc', hit: true },
      { text: 'd', hit: false },
      { text: 'ef', hit: true },
    ]);
  });

  it('NoRanges_WholeTextUnmarked', () => {
    expect(segmentsFromRanges('текст', [])).toEqual([{ text: 'текст', hit: false }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/stash/stash-query-search.test.ts`
Expected: FAIL — `parseSearchQuery` is not exported from `./stash-query`.

- [ ] **Step 3: Implement**

Append to `src/lib/stash/stash-query.ts` (keep everything stage 04 put there; add the `Segment` import at the top with the other imports):

```ts
import type { Segment } from '../tabs/drawer-filter';

/*
 * The search query language (spec «Поиск»), mirrored from Rust
 * `stash::search::parse_query`. Both are held to
 * `src-tauri/tests/fixtures/stash-queries.json`: the drawer highlights with
 * this parse while Rust searches with its own, and the two must agree on what
 * a term is.
 */

/** FTS5's trigram tokenizer matches nothing for a string shorter than this. */
export const TRIGRAM_MIN = 3;

export interface SearchTerm {
  text: string;
  phrase: boolean;
}

export interface SearchQuery {
  /** Lower-case, without '#', no duplicates, in order of appearance. */
  tags: string[];
  terms: SearchTerm[];
}

// Not `\s`: JavaScript's `\s` and Rust's White_Space disagree (U+FEFF,
// U+0085), and the two parsers must split identically.
const SEPARATORS = new Set([' ', '\t', '\n', '\r', ' ', '　']);

function isSeparator(c: string): boolean {
  return SEPARATORS.has(c);
}

function trimSeparators(chars: string[]): string {
  let a = 0;
  let b = chars.length;
  while (a < b && isSeparator(chars[a])) a++;
  while (b > a && isSeparator(chars[b - 1])) b--;
  return chars.slice(a, b).join('');
}

export function parseSearchQuery(input: string): SearchQuery {
  // Code points, like Rust's chars: a surrogate pair is one element.
  const chars = [...input];
  const q: SearchQuery = { tags: [], terms: [] };
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (isSeparator(c)) {
      i++;
      continue;
    }
    if (c === '"') {
      let end = i + 1;
      while (end < chars.length && chars[end] !== '"') end++;
      const phrase = trimSeparators(chars.slice(i + 1, end));
      if (phrase) q.terms.push({ text: phrase, phrase: true });
      // Past the closing quote; an unterminated phrase ran to the end.
      i = end + 1;
      continue;
    }
    const start = i;
    while (i < chars.length && !isSeparator(chars[i]) && chars[i] !== '"') i++;
    const word = chars.slice(start, i).join('');
    if (word.startsWith('#') && word.length > 1) {
      const tag = word.slice(1).toLowerCase();
      if (!q.tags.includes(tag)) q.tags.push(tag);
    } else {
      q.terms.push({ text: word, phrase: false });
    }
  }
  return q;
}

/** Long enough for trigrams; counted in code points, as Rust counts chars. */
export function isLongTerm(term: SearchTerm): boolean {
  return [...term.text].length >= TRIGRAM_MIN;
}

/** `text` split into runs, every occurrence of every term marked, overlaps merged. */
export function highlightTerms(text: string, terms: readonly SearchTerm[]): Segment[] {
  const lower = text.toLowerCase();
  // Lowercasing can change the length ('İ'); offsets into `lower` would then
  // cut `text` in the wrong places.
  if (lower.length !== text.length) return [{ text, hit: false }];
  const ranges: [number, number][] = [];
  for (const term of terms) {
    const needle = term.text.toLowerCase();
    if (!needle) continue;
    for (let j = lower.indexOf(needle); j !== -1; j = lower.indexOf(needle, j + needle.length)) {
      ranges.push([j, j + needle.length]);
    }
  }
  return segmentsFromRanges(text, ranges);
}

/**
 * `text` split into runs at `ranges` — `[from, to)` in UTF-16 units, the
 * unit Rust's `StashHit.ranges` are given in. Unsorted, overlapping and
 * out-of-range input is tolerated.
 */
export function segmentsFromRanges(
  text: string,
  ranges: readonly (readonly [number, number])[]
): Segment[] {
  const clamp = (n: number): number => Math.max(0, Math.min(n, text.length));
  const sorted = ranges
    .map(([a, b]): [number, number] => [clamp(a), clamp(b)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: [number, number][] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out: Segment[] = [];
  let i = 0;
  for (const [a, b] of merged) {
    if (a > i) out.push({ text: text.slice(i, a), hit: false });
    out.push({ text: text.slice(a, b), hit: true });
    i = b;
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false });
  return out.length > 0 ? out : [{ text, hit: false }];
}
```

If stage 04's `stash-query.ts` has its own `#tag` extraction for the substring filter, replace that extraction with `parseSearchQuery(query).tags`. There must be one definition of a tag. Keep its signature, and run its existing tests after the change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/stash/stash-query-search.test.ts src/lib/stash/`
Expected: PASS (the new file, plus stage 04's stash tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/lib/stash/stash-query.ts src/lib/stash/stash-query-search.test.ts
git commit -m "feat(stash): TypeScript mirror of the search query language + highlight helpers

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/lib/stash/stash-query.ts src/lib/stash/stash-query-search.test.ts
```

---

### Task 3: What the index stores — plain, capped text

**Files:**
- Create: `src-tauri/src/stash/search/text.rs`
- Modify: `src-tauri/src/stash/search/mod.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/stash/search/text.rs` containing only the tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "couplet-stash-text-{}-{}-{}",
            tag,
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

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
        assert_eq!(plain_text(md, true), "до\n# not a heading\nlet x = 1;\nпосле");
    }

    #[test]
    fn crlf_bom_and_blank_lines_are_normalized() {
        assert_eq!(plain_text("\u{feff}один\r\n\r\n  два  \r\n", true), "один\nдва");
    }

    #[test]
    fn a_tag_line_is_not_a_heading() {
        assert_eq!(plain_text("#infra заметка", true), "#infra заметка");
    }

    #[test]
    fn non_markdown_text_keeps_its_markers() {
        assert_eq!(plain_text("# python comment\n  x = 1  ", false), "# python comment\nx = 1");
    }

    #[test]
    fn markdown_paths_are_recognized() {
        assert!(is_markdown_path("/a/b/Note.MD"));
        assert!(is_markdown_path("/a/b/readme.markdown"));
        assert!(!is_markdown_path("/a/b/main.rs"));
    }

    #[test]
    fn read_capped_returns_small_text_whole() {
        let dir = scratch("small");
        let p = dir.join("a.md");
        fs::write(&p, "тайник").unwrap();
        assert_eq!(read_capped(&p), Loaded::Text("тайник".to_string()));
    }

    #[test]
    fn read_capped_stops_at_the_cap() {
        let dir = scratch("huge");
        let p = dir.join("big.log");
        // 'x' first so the cap falls in the middle of a 2-byte 'а'.
        let mut text = String::from("x");
        while text.len() < BODY_CAP_BYTES + 500_000 {
            text.push('а');
        }
        fs::write(&p, &text).unwrap();
        let Loaded::Text(read) = read_capped(&p) else { panic!("expected text") };
        assert!(read.starts_with('x'));
        assert_eq!(read.chars().filter(|&c| c == 'а').count(), (BODY_CAP_BYTES - 1) / 2);
        assert!(read.len() <= BODY_CAP_BYTES + 3, "one replacement char at most past the cap");
    }

    #[test]
    fn read_capped_detects_binary() {
        let dir = scratch("bin");
        let p = dir.join("shot.png");
        fs::write(&p, [0x89u8, b'P', b'N', b'G', 0, 1, 2, 3]).unwrap();
        assert_eq!(read_capped(&p), Loaded::Binary);
    }

    #[test]
    fn read_capped_reports_missing_and_directories_as_unreadable() {
        let dir = scratch("gone");
        assert!(matches!(read_capped(&dir.join("nope.md")), Loaded::Unreadable(_)));
        assert!(matches!(read_capped(&dir), Loaded::Unreadable(_)));
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
```

In `src-tauri/src/stash/search/mod.rs` add `mod text;` under `mod query;`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::search::text`
Expected: FAIL to compile — `plain_text`, `read_capped`, `Loaded`, `cap`, `BODY_CAP_BYTES` not found.

- [ ] **Step 3: Implement**

Add above the tests in `src-tauri/src/stash/search/text.rs`:

```rust
//! What the index stores for an entry: the text a reader sees — markdown
//! markers gone, link URLs kept — from at most `BODY_CAP_BYTES` of the file.
//! Snippets are cut from this same text, so a hit and its snippet always
//! agree.

use std::fs::File;
use std::io::Read;
use std::path::Path;

/// At most this much of a file is read and indexed (1 MiB). A stash entry can
/// reference any file — a log, a dump — and one put-away must not read
/// gigabytes under the stash lock. Past the cap a file is still found by its
/// title and by what its first MiB says.
pub const BODY_CAP_BYTES: usize = 1024 * 1024;

/// A NUL in the first 8 KiB means binary: the title is indexed, the body not.
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum Loaded {
    Text(String),
    Binary,
    Unreadable(String),
}

pub fn read_capped(path: &Path) -> Loaded {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) => return Loaded::Unreadable(e.to_string()),
    };
    let mut buf = Vec::new();
    if let Err(e) = file.take(BODY_CAP_BYTES as u64).read_to_end(&mut buf) {
        return Loaded::Unreadable(e.to_string());
    }
    if buf[..buf.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
        return Loaded::Binary;
    }
    // Lossy: a char cut by the cap, or a non-UTF-8 file, still indexes.
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
    [".md", ".markdown", ".mdown", ".mkd"].iter().any(|ext| lower.ends_with(ext))
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
        let line = if markdown && !in_code { plain_line(raw) } else { raw.trim().to_string() };
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
        .replace('`', "")
        .replace('*', "")
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::search::text`
Expected: PASS, 11 tests. The functions are not used outside tests yet, so clippy may list them as `dead_code`. That clears in Task 5.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/stash/search/text.rs src-tauri/src/stash/search/mod.rs
git commit -m "feat(stash): plain, capped index body — markdown stripped, binary and unreadable files safe

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src-tauri/src/stash/search/text.rs src-tauri/src/stash/search/mod.rs
```

---

### Task 4: Snippets with UTF-16 highlight ranges

**Files:**
- Create: `src-tauri/src/stash/search/snippet.rs`
- Modify: `src-tauri/src/stash/search/mod.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/stash/search/snippet.rs` containing only the tests:

```rust
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
}
```

In `src-tauri/src/stash/search/mod.rs` add `mod snippet;`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::search::snippet`
Expected: FAIL to compile — `make_snippet`, `Snippet`, `SNIPPET_CHARS` not found.

- [ ] **Step 3: Implement**

Add above the tests in `src-tauri/src/stash/search/snippet.rs`:

```rust
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

/// `needles` are lower-cased already (`Term::folded`).
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
    // to several ('İ' → "i̇"), so the two sequences can differ in length.
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::search::snippet`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/stash/search/snippet.rs src-tauri/src/stash/search/mod.rs
git commit -m "feat(stash): search snippets — ~200 chars around the match, UTF-16 highlight ranges

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src-tauri/src/stash/search/snippet.rs src-tauri/src/stash/search/mod.rs
```

---

### Task 5: Index maintenance — index, reindex, unindex, rebuild

**Files:**
- Modify: `src-tauri/Cargo.toml` (`rusqlite` feature `functions`)
- Create: `src-tauri/src/stash/search/index.rs`
- Create: `src-tauri/src/stash/search/test_support.rs`
- Modify: `src-tauri/src/stash/search/mod.rs`
- Modify: `src-tauri/src/stash/db.rs` (`open` registers `stash_fold`)

- [ ] **Step 1: Enable the `functions` feature**

In `src-tauri/Cargo.toml`, add `"functions"` to the existing `rusqlite` features. Keep stage 02's version, and keep every other feature it listed:

```toml
rusqlite = { version = "<stage 02's version, unchanged>", features = ["bundled", "functions"] }
```

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo build --manifest-path src-tauri/Cargo.toml --offline 2>&1 | tail -3`
Expected: builds. `functions` pulls in no new crate, so `--offline` succeeds, and `Cargo.lock` changes only in the feature set, if at all.

- [ ] **Step 2: Write the test support module**

Create `src-tauri/src/stash/search/test_support.rs`:

```rust
//! A scratch stash database for the search tests. Rows go in through SQL
//! against the roadmap schema (a fixed contract), so these tests do not
//! depend on the shape of stage 02's entry API.

use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

static SEQ: AtomicUsize = AtomicUsize::new(0);

pub fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "couplet-stash-search-{}-{}-{}",
        tag,
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

pub struct Db {
    pub dir: PathBuf,
    pub conn: Connection,
}

pub fn db(tag: &str) -> Db {
    let dir = scratch(tag);
    let conn = crate::stash::db::open(&dir.join("stash.db")).expect("open stash db");
    Db { dir, conn }
}

impl Db {
    /// A note whose file holds `text`, indexed the way the app indexes it.
    /// `fresh` is its modified_at and stashed_at.
    pub fn note(&self, id: &str, text: &str, fresh: i64) -> i64 {
        self.note_in(id, text, fresh, None)
    }

    pub fn note_in(&self, id: &str, text: &str, fresh: i64, repo: Option<&str>) -> i64 {
        let path = self.dir.join(format!("{id}.md"));
        fs::write(&path, text).unwrap();
        let title = crate::stash::notes::title_of(text).unwrap_or_default();
        self.insert(id, "note", &path, &title, repo, fresh)
    }

    /// A file reference to `name` holding `bytes`; its title is the file name.
    pub fn file(&self, id: &str, name: &str, bytes: &[u8], fresh: i64) -> i64 {
        let path = self.dir.join(name);
        fs::write(&path, bytes).unwrap();
        self.insert(id, "file", &path, name, None, fresh)
    }

    pub fn path_of(&self, id: &str) -> String {
        self.conn
            .query_row("SELECT path FROM entries WHERE id = ?1", [id], |r| r.get(0))
            .unwrap()
    }

    pub fn tag(&self, id: &str, tag: &str) {
        self.conn
            .execute("INSERT INTO tags (entry_id, tag) VALUES (?1, ?2)", params![id, tag])
            .unwrap();
    }

    pub fn trash(&self, id: &str) {
        self.conn
            .execute("UPDATE entries SET deleted_at = 1 WHERE id = ?1", [id])
            .unwrap();
    }

    /// Every FTS row, in rowid order — the index's whole state.
    pub fn fts_rows(&self) -> Vec<(i64, String, String)> {
        let mut st = self
            .conn
            .prepare("SELECT rowid, title, body FROM entries_fts ORDER BY rowid")
            .unwrap();
        let rows = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        rows.collect::<Result<Vec<_>, _>>().unwrap()
    }

    fn insert(&self, id: &str, kind: &str, path: &Path, title: &str, repo: Option<&str>, fresh: i64) -> i64 {
        self.conn
            .execute(
                "INSERT INTO entries (id, kind, path, title, repo, created_at, modified_at, stashed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6)",
                params![id, kind, path.to_string_lossy(), title, repo, fresh],
            )
            .unwrap();
        let rowid = self.conn.last_insert_rowid();
        super::index_entry(&self.conn, id).unwrap();
        rowid
    }
}
```

- [ ] **Step 3: Write the failing tests**

Create `src-tauri/src/stash/search/index.rs` containing only the tests:

```rust
#[cfg(test)]
mod tests {
    use super::super::test_support::db;
    use super::*;
    use std::fs;

    #[test]
    fn index_entry_stores_the_title_and_the_plain_body() {
        let d = db("index-plain");
        let rowid = d.note("n1", "# Тайник\n\n- **ключ** от шкафа", 10);
        assert_eq!(d.fts_rows(), vec![(rowid, "Тайник".to_string(), "Тайник\nключ от шкафа".to_string())]);
    }

    #[test]
    fn index_entry_is_idempotent() {
        let d = db("index-twice");
        d.note("n1", "один", 10);
        index_entry(&d.conn, "n1").unwrap();
        index_entry(&d.conn, "n1").unwrap();
        assert_eq!(d.fts_rows().len(), 1);
    }

    #[test]
    fn index_entry_rereads_the_file() {
        let d = db("index-reread");
        d.note("n1", "старое", 10);
        fs::write(d.path_of("n1"), "новое").unwrap();
        index_entry(&d.conn, "n1").unwrap();
        assert_eq!(d.fts_rows()[0].2, "новое");
    }

    #[test]
    fn index_entry_for_an_unknown_id_is_an_error() {
        let d = db("index-unknown");
        assert!(index_entry(&d.conn, "nope").is_err());
    }

    #[test]
    fn reindex_path_uses_the_given_text() {
        let d = db("reindex");
        d.note("n1", "старое", 10);
        let path = d.path_of("n1");
        assert_eq!(reindex_path(&d.conn, &path, "*новое* слово"), Ok(true));
        assert_eq!(d.fts_rows()[0].2, "новое слово");
    }

    #[test]
    fn reindex_path_ignores_a_path_that_is_not_in_the_stash() {
        let d = db("reindex-other");
        assert_eq!(reindex_path(&d.conn, "/tmp/not-stashed.md", "текст"), Ok(false));
        assert!(d.fts_rows().is_empty());
    }

    #[test]
    fn reindex_path_caps_a_huge_save() {
        let d = db("reindex-huge");
        d.note("n1", "x", 10);
        let huge = "я".repeat(BODY_CAP_BYTES);
        reindex_path(&d.conn, &d.path_of("n1"), &huge).unwrap();
        assert!(d.fts_rows()[0].2.len() <= BODY_CAP_BYTES);
    }

    #[test]
    fn unindex_entry_removes_the_row_and_tolerates_unknown_ids() {
        let d = db("unindex");
        d.note("n1", "текст", 10);
        unindex_entry(&d.conn, "n1").unwrap();
        assert!(d.fts_rows().is_empty());
        unindex_entry(&d.conn, "nope").unwrap();
    }

    #[test]
    fn a_binary_file_is_indexed_by_its_title_only() {
        let d = db("binary");
        d.file("f1", "hdmi-schema.png", &[0x89, b'P', b'N', b'G', 0, 1], 10);
        let rows = d.fts_rows();
        assert_eq!(rows[0].1, "hdmi-schema.png");
        assert_eq!(rows[0].2, "");
    }

    #[test]
    fn a_vanished_file_is_indexed_by_its_title_and_does_not_fail() {
        let d = db("vanished");
        d.file("f1", "gone.md", b"text", 10);
        fs::remove_file(d.path_of("f1")).unwrap();
        index_entry(&d.conn, "f1").unwrap();
        assert_eq!(d.fts_rows()[0].2, "");
    }

    #[test]
    fn a_non_markdown_file_keeps_its_markers() {
        let d = db("code");
        d.file("f1", "setup.py", b"# configure hdmi\nx = 1", 10);
        assert_eq!(d.fts_rows()[0].2, "# configure hdmi\nx = 1");
    }

    #[test]
    fn rebuild_restores_exactly_what_incremental_indexing_built() {
        let d = db("rebuild");
        d.note("n1", "# Тайник\nключ", 10);
        d.note("n2", "документ", 20);
        d.file("f1", "notes.md", b"- hdmi", 30);
        fs::write(d.path_of("n2"), "документация").unwrap();
        reindex_path(&d.conn, &d.path_of("n2"), "документация").unwrap();
        let before = d.fts_rows();

        d.conn.execute("DELETE FROM entries_fts", []).unwrap();
        d.conn
            .execute("INSERT INTO entries_fts (rowid, title, body) VALUES (9999, 'orphan', 'orphan')", [])
            .unwrap();
        assert_eq!(rebuild_index(&d.conn).unwrap(), 3);
        assert_eq!(d.fts_rows(), before);
    }

    #[test]
    fn stash_fold_lowercases_cyrillic() {
        let d = db("fold");
        let folded: String = d.conn.query_row("SELECT stash_fold('ТАЙНИК Ok')", [], |r| r.get(0)).unwrap();
        assert_eq!(folded, "тайник ok");
    }
}
```

In `src-tauri/src/stash/search/mod.rs`:

```rust
mod index;
mod query;
mod snippet;
mod text;
#[cfg(test)]
mod test_support;

pub use index::{index_entry, rebuild_index, register_functions, reindex_path, unindex_entry};
pub use query::{fts_match, parse_query, short_terms, SearchQuery, Term, TRIGRAM_MIN};
```

(`test_support` calls `super::index_entry`, which is this re-export.)

- [ ] **Step 4: Run the tests to verify they fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::search::index`
Expected: FAIL to compile — `index_entry`, `reindex_path`, `unindex_entry`, `rebuild_index`, `register_functions` not found.

- [ ] **Step 5: Implement**

Add above the tests in `src-tauri/src/stash/search/index.rs`:

```rust
//! Keeps `entries_fts` in step with `entries` (rowid = entries.rowid). Every
//! write is an upsert by rowid: `INTEGER PRIMARY KEY` without AUTOINCREMENT
//! reuses the highest rowid after its row is deleted, so a stale FTS row must
//! never be able to attach itself to a new entry. Searches JOIN `entries`, so
//! an orphan row is invisible until `ensure_index` sweeps it.

use rusqlite::functions::FunctionFlags;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

use super::text::{cap, is_markdown_path, plain_text, read_capped, Loaded};

pub use super::text::BODY_CAP_BYTES;

/// SQLite's own `lower()` and `LIKE` fold ASCII only; «ок» must find «ОК».
/// Registered by `stash::db::open` on every connection (app, CLI, MCP).
pub fn register_functions(conn: &Connection) -> rusqlite::Result<()> {
    conn.create_scalar_function(
        "stash_fold",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let s: Option<String> = ctx.get(0)?;
            Ok(s.map(|s| s.to_lowercase()))
        },
    )
}

struct Row {
    rowid: i64,
    kind: String,
    path: String,
    title: String,
}

const ROW_BY_ID: &str = "SELECT rowid, kind, path, title FROM entries WHERE id = ?1";
const ROW_BY_PATH: &str = "SELECT rowid, kind, path, title FROM entries WHERE path = ?1";

fn err(e: rusqlite::Error) -> String {
    e.to_string()
}

fn find(conn: &Connection, sql: &str, key: &str) -> Result<Option<Row>, String> {
    conn.query_row(sql, [key], |r| {
        Ok(Row { rowid: r.get(0)?, kind: r.get(1)?, path: r.get(2)?, title: r.get(3)? })
    })
    .optional()
    .map_err(err)
}

fn is_markdown(row: &Row) -> bool {
    row.kind == "note" || is_markdown_path(&row.path)
}

fn body_from_disk(row: &Row) -> String {
    match read_capped(Path::new(&row.path)) {
        Loaded::Text(text) => plain_text(&text, is_markdown(row)),
        Loaded::Binary => String::new(),
        Loaded::Unreadable(why) => {
            eprintln!("stash search: {} indexed by title only: {why}", row.path);
            String::new()
        }
    }
}

fn upsert(conn: &Connection, rowid: i64, title: &str, body: &str) -> Result<(), String> {
    conn.execute("DELETE FROM entries_fts WHERE rowid = ?1", params![rowid]).map_err(err)?;
    conn.execute(
        "INSERT INTO entries_fts (rowid, title, body) VALUES (?1, ?2, ?3)",
        params![rowid, title, body],
    )
    .map_err(err)?;
    Ok(())
}

/// (Re)index entry `id` from its file on disk. Callers treat an error as
/// "search is stale", never as a failed write: log it and carry on.
pub fn index_entry(conn: &Connection, id: &str) -> Result<(), String> {
    let row = find(conn, ROW_BY_ID, id)?.ok_or_else(|| format!("no stash entry {id}"))?;
    let body = body_from_disk(&row);
    upsert(conn, row.rowid, &row.title, &body)
}

/// Reindex the entry at `path` from `text`, the content a save just wrote.
/// `Ok(false)`: the path is not in the stash. Reads `entries.title`, so call
/// it after the caller's own `title`/`modified_at` update.
pub fn reindex_path(conn: &Connection, path: &str, text: &str) -> Result<bool, String> {
    let Some(row) = find(conn, ROW_BY_PATH, path)? else { return Ok(false) };
    let body = plain_text(cap(text), is_markdown(&row));
    upsert(conn, row.rowid, &row.title, &body)?;
    Ok(true)
}

/// Drop entry `id` from the index. Call it BEFORE deleting the `entries` row,
/// in the same transaction: afterwards its rowid can no longer be found.
pub fn unindex_entry(conn: &Connection, id: &str) -> Result<(), String> {
    if let Some(row) = find(conn, ROW_BY_ID, id)? {
        conn.execute("DELETE FROM entries_fts WHERE rowid = ?1", params![row.rowid])
            .map_err(err)?;
    }
    Ok(())
}

/// Recreate every FTS row from `entries` and their files, in one transaction.
/// Returns the number of entries indexed. Files are read one at a time inside
/// the transaction: memory stays bounded by one body, at the cost of holding
/// the write lock for the duration (startup only).
pub fn rebuild_index(conn: &Connection) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    tx.execute("DELETE FROM entries_fts", []).map_err(err)?;
    let rows: Vec<Row> = {
        let mut st = tx
            .prepare("SELECT rowid, kind, path, title FROM entries ORDER BY rowid")
            .map_err(err)?;
        let mapped = st
            .query_map([], |r| {
                Ok(Row { rowid: r.get(0)?, kind: r.get(1)?, path: r.get(2)?, title: r.get(3)? })
            })
            .map_err(err)?;
        mapped.collect::<Result<Vec<_>, _>>().map_err(err)?
    };
    {
        let mut insert = tx
            .prepare("INSERT INTO entries_fts (rowid, title, body) VALUES (?1, ?2, ?3)")
            .map_err(err)?;
        for row in &rows {
            let body = body_from_disk(row);
            insert.execute(params![row.rowid, row.title, body]).map_err(err)?;
        }
    }
    tx.commit().map_err(err)?;
    Ok(rows.len())
}
```

In `src-tauri/src/stash/db.rs`, at the end of `open` just before it returns the connection (after pragmas and `migrate`), add:

```rust
    // `stash_fold` backs short-query title matching; every connection needs it.
    crate::stash::search::register_functions(&conn).map_err(|e| e.to_string())?;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::search`
Expected: PASS — all `index` tests (13) plus the earlier query/text/snippet tests. Then run the whole stash suite to confirm `db::open` still works for stage 02's tests: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/stash/search/index.rs src-tauri/src/stash/search/test_support.rs src-tauri/src/stash/search/mod.rs src-tauri/src/stash/db.rs
git commit -m "feat(stash): keep entries_fts in sync — index, reindex, unindex, rebuild; stash_fold()

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/stash/search/index.rs src-tauri/src/stash/search/test_support.rs src-tauri/src/stash/search/mod.rs src-tauri/src/stash/db.rs
```

(If `Cargo.lock` did not change, drop it from both pathspecs.)

---

### Task 6: `ensure_index` — rebuild when missing, corrupt, outdated or stale

**Files:**
- Modify: `src-tauri/src/stash/search/index.rs`
- Modify: `src-tauri/src/stash/search/mod.rs`

- [ ] **Step 1: Write the failing tests**

Append inside the `tests` module of `src-tauri/src/stash/search/index.rs`:

```rust
    fn indexed_count(d: &super::super::test_support::Db) -> i64 {
        d.conn.query_row("SELECT count(*) FROM entries_fts", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn first_run_has_no_version_and_rebuilds() {
        let d = db("ensure-first");
        d.note("n1", "тайник", 10);
        d.conn.execute("DELETE FROM entries_fts", []).unwrap();
        assert_eq!(ensure_index(&d.conn), Ok(Some(RebuildReason::Version)));
        assert_eq!(indexed_count(&d), 1);
        assert_eq!(ensure_index(&d.conn), Ok(None), "a second run finds nothing to do");
    }

    #[test]
    fn a_dropped_table_is_recreated_and_rebuilt() {
        let d = db("ensure-missing");
        d.note("n1", "тайник", 10);
        ensure_index(&d.conn).unwrap();
        d.conn.execute_batch("DROP TABLE entries_fts").unwrap();
        assert_eq!(ensure_index(&d.conn), Ok(Some(RebuildReason::Missing)));
        assert_eq!(indexed_count(&d), 1);
        let hits: i64 = d
            .conn
            .query_row("SELECT count(*) FROM entries_fts WHERE entries_fts MATCH '\"тайн\"'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(hits, 1, "the recreated table uses the trigram tokenizer");
    }

    #[test]
    fn a_corrupt_index_is_dropped_and_rebuilt() {
        let d = db("ensure-corrupt");
        d.note("n1", "тайник", 10);
        ensure_index(&d.conn).unwrap();
        // The segment b-tree and the structure record live here.
        d.conn.execute("DELETE FROM entries_fts_data", []).unwrap();
        assert_eq!(ensure_index(&d.conn), Ok(Some(RebuildReason::Corrupt)));
        assert_eq!(indexed_count(&d), 1);
        assert_eq!(ensure_index(&d.conn), Ok(None));
    }

    #[test]
    fn another_index_version_rebuilds() {
        let d = db("ensure-version");
        d.note("n1", "тайник", 10);
        ensure_index(&d.conn).unwrap();
        d.conn.execute("UPDATE search_meta SET value = '0' WHERE key = 'index_version'", []).unwrap();
        assert_eq!(ensure_index(&d.conn), Ok(Some(RebuildReason::Version)));
        assert_eq!(ensure_index(&d.conn), Ok(None));
    }

    #[test]
    fn an_unindexed_entry_or_an_orphan_row_is_stale() {
        let d = db("ensure-stale");
        d.note("n1", "тайник", 10);
        ensure_index(&d.conn).unwrap();

        d.conn
            .execute(
                "INSERT INTO entries (id, kind, path, title, created_at, modified_at) VALUES ('raw', 'note', '/nowhere.md', 'raw', 1, 1)",
                [],
            )
            .unwrap();
        assert_eq!(ensure_index(&d.conn), Ok(Some(RebuildReason::Stale)));
        assert_eq!(indexed_count(&d), 2);

        d.conn.execute("DELETE FROM entries WHERE id = 'raw'", []).unwrap();
        assert_eq!(ensure_index(&d.conn), Ok(Some(RebuildReason::Stale)), "the orphan row");
        assert_eq!(indexed_count(&d), 1);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::search::index`
Expected: FAIL to compile — `ensure_index`, `RebuildReason` not found.

- [ ] **Step 3: Implement**

Add to `src-tauri/src/stash/search/index.rs`, below `rebuild_index`:

```rust
/// Bump when what the index stores changes (plain-text rules, the cap, the
/// columns): `ensure_index` then rebuilds every database on its next start.
pub const INDEX_VERSION: i64 = 1;

/// The roadmap's v1 DDL, verbatim — a recreated table must be the same table.
const FTS_DDL: &str = "CREATE VIRTUAL TABLE entries_fts USING fts5(title, body, tokenize = 'trigram')";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RebuildReason {
    Missing,
    Corrupt,
    Version,
    Stale,
}

/// Run at startup. Rebuilds the index when it is missing, fails FTS5's own
/// integrity check, was built under another `INDEX_VERSION`, or disagrees with
/// `entries` in row count or by an orphan row. Returns why it rebuilt, or
/// `None`. `search_meta` is index bookkeeping (like FTS5's shadow tables),
/// deliberately outside `user_version` migrations.
pub fn ensure_index(conn: &Connection) -> Result<Option<RebuildReason>, String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        .map_err(err)?;
    let reason = diagnose(conn)?;
    if let Some(r) = reason {
        match r {
            RebuildReason::Missing => conn.execute_batch(FTS_DDL).map_err(err)?,
            RebuildReason::Corrupt => {
                conn.execute_batch("DROP TABLE IF EXISTS entries_fts").map_err(err)?;
                conn.execute_batch(FTS_DDL).map_err(err)?;
            }
            RebuildReason::Version | RebuildReason::Stale => {}
        }
        rebuild_index(conn)?;
        conn.execute(
            "INSERT INTO search_meta (key, value) VALUES ('index_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![INDEX_VERSION.to_string()],
        )
        .map_err(err)?;
    }
    Ok(reason)
}

fn diagnose(conn: &Connection) -> Result<Option<RebuildReason>, String> {
    let exists: i64 = conn
        .query_row("SELECT count(*) FROM sqlite_master WHERE name = 'entries_fts'", [], |r| r.get(0))
        .map_err(err)?;
    if exists == 0 {
        return Ok(Some(RebuildReason::Missing));
    }
    if conn.execute("INSERT INTO entries_fts (entries_fts) VALUES ('integrity-check')", []).is_err() {
        return Ok(Some(RebuildReason::Corrupt));
    }
    let version: Option<String> = conn
        .query_row("SELECT value FROM search_meta WHERE key = 'index_version'", [], |r| r.get(0))
        .optional()
        .map_err(err)?;
    if version.as_deref() != Some(INDEX_VERSION.to_string().as_str()) {
        return Ok(Some(RebuildReason::Version));
    }
    let (entries, indexed, orphans): (i64, i64, i64) = conn
        .query_row(
            "SELECT (SELECT count(*) FROM entries),
                    (SELECT count(*) FROM entries_fts),
                    (SELECT count(*) FROM entries_fts WHERE rowid NOT IN (SELECT rowid FROM entries))",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(err)?;
    if entries != indexed || orphans > 0 {
        return Ok(Some(RebuildReason::Stale));
    }
    Ok(None)
}
```

Update the re-export line in `src-tauri/src/stash/search/mod.rs`:

```rust
pub use index::{
    ensure_index, index_entry, rebuild_index, register_functions, reindex_path, unindex_entry,
    RebuildReason, INDEX_VERSION,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::search::index`
Expected: PASS, 18 tests. If `a_corrupt_index_is_dropped_and_rebuilt` fails because `integrity-check` still passes with an empty `entries_fts_data`, **stop and report**: detecting corruption would then need another probe. Do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/stash/search/index.rs src-tauri/src/stash/search/mod.rs
git commit -m "feat(stash): ensure_index — rebuild a missing, corrupt, outdated or stale search index

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src-tauri/src/stash/search/index.rs src-tauri/src/stash/search/mod.rs
```

---

### Task 7: Running a search — MATCH, filters, bm25, pagination, snippets

**Files:**
- Create: `src-tauri/src/stash/search/run.rs`
- Modify: `src-tauri/src/stash/search/mod.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/stash/search/run.rs` containing only the tests:

```rust
#[cfg(test)]
mod tests {
    use super::super::test_support::{db, Db};
    use super::*;

    fn ids(d: &Db, query: &str) -> Vec<String> {
        page(d, SearchArgs { query: query.to_string(), ..Default::default() })
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

    fn slice16(s: &str, a: u32, b: u32) -> String {
        let units: Vec<u16> = s.encode_utf16().collect();
        String::from_utf16(&units[a as usize..b as usize]).unwrap()
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
        let with_arg = page(&d, SearchArgs { query: "hdmi".into(), tag: Some("#Infra".into()), ..Default::default() });
        assert_eq!(with_arg.hits.iter().map(|h| h.entry.id.as_str()).collect::<Vec<_>>(), vec!["n1"]);
    }

    #[test]
    fn a_short_query_matches_titles_only() {
        let d = db("short");
        d.note("n1", "# ОК план\nтекст", 1);
        d.note("n2", "# Другое\nок в тексте", 2);
        d.note("n3", "# Abc\n", 3);
        assert_eq!(ids(&d, "ок"), vec!["n1"], "Cyrillic, case-folded, title only");
        assert_eq!(ids(&d, "ab"), vec!["n3"]);
        assert_eq!(ids(&d, "ок план"), vec!["n1"], "short + long");
        assert!(ids(&d, "юю").is_empty());
    }

    #[test]
    fn a_title_hit_outranks_a_fresher_body_hit() {
        let d = db("rank");
        d.note("body", "# Заметки\nгде-то упомянут тайник", 200);
        d.note("title", "# Тайник\nпро другое", 100);
        let p = page(&d, SearchArgs { query: "тайник".into(), ..Default::default() });
        assert_eq!(p.hits.iter().map(|h| h.entry.id.as_str()).collect::<Vec<_>>(), vec!["title", "body"]);
        assert!(p.hits[0].score > p.hits[1].score);
    }

    #[test]
    fn equal_relevance_puts_the_fresher_first() {
        let d = db("tie");
        d.note("old", "одинаковый тайник", 100);
        d.note("new", "одинаковый тайник", 200);
        assert_eq!(ids(&d, "тайник"), vec!["new", "old"]);
        assert_eq!(ids(&d, ""), vec!["new", "old"], "no terms: newest first");
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
            "\"", "*", "NEAR", "AND", "a AND b", "OR", "NOT x", "NEAR(nearby, 5)", "title:abc",
            "^nea", "-nea", "\"unterminated", "'); DROP TABLE entries; --", "(((", "\"\"\"",
        ] {
            let r = search(&d.conn, &SearchArgs { query: q.into(), ..Default::default() });
            assert!(r.is_ok(), "{q:?} → {r:?}", r = r.as_ref().err());
        }
        assert_eq!(ids(&d, "NEAR"), vec!["near"], "matched as the letters n-e-a-r");
        assert_eq!(ids(&d, "AND"), vec!["cmd"]);
        assert_eq!(ids(&d, "*"), vec!["star"], "a 1-char query is a title substring");
        assert_eq!(page(&d, SearchArgs::default()).total, all, "the entries table survived");
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
        let trash = page(&d, SearchArgs { query: "тайник".into(), deleted: true, ..Default::default() });
        assert_eq!(trash.hits.iter().map(|h| h.entry.id.as_str()).collect::<Vec<_>>(), vec!["gone"]);
        let notes = page(&d, SearchArgs { query: "тайник".into(), kind: Some("note".into()), ..Default::default() });
        assert_eq!(notes.total, 2);
        let files = page(&d, SearchArgs { query: "тайник".into(), kind: Some("file".into()), ..Default::default() });
        assert_eq!(files.hits[0].entry.id, "f");
        let repo = page(&d, SearchArgs { query: "тайник".into(), repo: Some("repo-a".into()), ..Default::default() });
        assert_eq!(repo.hits.iter().map(|h| h.entry.id.as_str()).collect::<Vec<_>>(), vec!["a"]);
        assert_eq!(repo.total, 1);
        assert!(search(&d.conn, &SearchArgs { kind: Some("folder".into()), ..Default::default() }).is_err());
    }

    #[test]
    fn pages_follow_the_cursor_and_report_the_total() {
        let d = db("pages");
        for i in 0..25 {
            d.note(&format!("n{i:02}"), "общий тайник", i);
        }
        let first = page(&d, SearchArgs { query: "тайник".into(), limit: Some(10), ..Default::default() });
        assert_eq!((first.hits.len(), first.total, first.next_cursor.as_deref()), (10, 25, Some("10")));
        let last = page(&d, SearchArgs { query: "тайник".into(), limit: Some(10), cursor: Some("20".into()), ..Default::default() });
        assert_eq!((last.hits.len(), last.total, last.next_cursor), (5, 25, None));
        let mut seen: Vec<String> = Vec::new();
        let mut cursor = None;
        loop {
            let p = page(&d, SearchArgs { query: "тайник".into(), limit: Some(7), cursor: cursor.clone(), ..Default::default() });
            seen.extend(p.hits.iter().map(|h| h.entry.id.clone()));
            match p.next_cursor { Some(c) => cursor = Some(c), None => break }
        }
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), 25, "every hit exactly once across pages");
        assert!(search(&d.conn, &SearchArgs { cursor: Some("abc".into()), ..Default::default() }).is_err());
    }

    #[test]
    fn a_hit_carries_a_snippet_around_the_match() {
        let d = db("snippet");
        let text = format!("# Длинная\n{}подписать документ{}", "слово ".repeat(100), " хвост".repeat(100));
        d.note("n1", &text, 1);
        let p = page(&d, SearchArgs { query: "мент".into(), ..Default::default() });
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
        let p = page(&d, SearchArgs { query: "hdmi".into(), ..Default::default() });
        assert_eq!(p.hits[0].entry.id, "f1");
        assert_eq!(p.hits[0].snippet, "");
        assert!(p.hits[0].ranges.is_empty());
    }

    #[test]
    fn rebuild_gives_the_same_answers() {
        let d = db("rebuild-eq");
        d.note("n1", "# Тайник\nключ от шкафа", 10);
        d.note("n2", "документ про тайник", 20);
        d.note("n3", "# ОК\nпереговорка на третьем", 30);
        d.file("f1", "hdmi.md", b"- hdmi переговорка", 40);
        d.tag("n2", "infra");
        std::fs::write(d.path_of("n1"), "# Тайник\nключ от сейфа").unwrap();
        crate::stash::search::reindex_path(&d.conn, &d.path_of("n1"), "# Тайник\nключ от сейфа").unwrap();

        let queries = ["тайник", "мент", "\"на третьем\"", "#infra тайник", "ок", "переговорка", ""];
        let snapshot = |d: &Db| -> Vec<Vec<(String, String, Vec<(u32, u32)>, String)>> {
            queries
                .iter()
                .map(|q| {
                    page(d, SearchArgs { query: q.to_string(), ..Default::default() })
                        .hits
                        .into_iter()
                        .map(|h| (h.entry.id.clone(), h.snippet, h.ranges, format!("{:.9}", h.score)))
                        .collect()
                })
                .collect()
        };
        let before = snapshot(&d);
        crate::stash::search::rebuild_index(&d.conn).unwrap();
        assert_eq!(snapshot(&d), before);
    }

    #[test]
    fn arg_helpers() {
        assert_eq!(parse_cursor(None), Ok(0));
        assert_eq!(parse_cursor(Some("30")), Ok(30));
        assert!(parse_cursor(Some("-1")).is_err());
        assert_eq!(clamp_limit(None), DEFAULT_LIMIT as usize);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(10_000)), MAX_LIMIT as usize);
        assert_eq!(normalize_tag(" #Infra "), Some("infra".to_string()));
        assert_eq!(normalize_tag("#"), None);
    }

    #[test]
    fn a_page_serializes_to_the_ipc_shape() {
        let d = db("serde");
        d.note("n1", "тайник", 1);
        let v = serde_json::to_value(page(&d, SearchArgs { query: "тайник".into(), ..Default::default() })).unwrap();
        assert_eq!(v["total"], 1);
        assert!(v["nextCursor"].is_null());
        assert_eq!(v["hits"][0]["entry"]["id"], "n1");
        assert_eq!(v["hits"][0]["ranges"][0], serde_json::json!([0, 6]));
        assert!(v["hits"][0]["score"].as_f64().unwrap() > 0.0);
    }
}
```

In `src-tauri/src/stash/search/mod.rs` add `mod run;` and the re-export:

```rust
pub use run::{clamp_limit, normalize_tag, parse_cursor, search, SearchArgs, SearchPage, StashHit, DEFAULT_LIMIT, MAX_LIMIT};
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::search::run`
Expected: FAIL to compile — `search`, `SearchArgs`, `SearchPage`, … not found.

- [ ] **Step 3: Implement**

Add above the tests in `src-tauri/src/stash/search/run.rs`:

```rust
//! One search for the drawer and for agents (spec «Поиск»). Candidates come
//! from one SQL query without LIMIT — MATCH for long terms, `stash_fold`
//! title substrings for short ones, tag/kind/trash filters — ordered by
//! relevance then freshness. The repo filter runs in Rust (a file's repo is
//! derived at read time, so SQL cannot see it); then the page is sliced and
//! only its entries and snippets are built.

use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;

use super::query::{fts_match, parse_query, short_terms, Term};
use super::snippet::make_snippet;
use crate::stash::entries::get as get_entry;
use crate::stash::StashEntry;

/// bm25 column weights, title then body. A body term contributes at most
/// (k1+1)·idf = 2.2·idf however often it repeats; one title hit contributes
/// ≈1.0·idf at average title length (0.55·idf at 3×), so ×10 makes any title
/// hit outrank any body-only hit — the spec's «совпадение в заголовке весит
/// больше». FTS5's bm25() is lower-is-better; the score is its negation.
const RANK_SQL: &str = "-bm25(entries_fts, 10.0, 1.0)";
/// «При равенстве — свежее отложенное выше.»
const FRESH_SQL: &str = "max(e.modified_at, coalesce(e.stashed_at, 0))";

pub const DEFAULT_LIMIT: u32 = 50;
pub const MAX_LIMIT: u32 = 200;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashHit {
    pub entry: StashEntry,
    pub snippet: String,
    /// `[from, to)` in UTF-16 units of `snippet`.
    pub ranges: Vec<(u32, u32)>,
    /// Higher is better; 0 when the query had no trigram term.
    pub score: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub hits: Vec<StashHit>,
    pub total: u32,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SearchArgs {
    pub query: String,
    pub repo: Option<String>,
    pub tag: Option<String>,
    pub kind: Option<String>,
    pub deleted: bool,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

/// The cursor is an offset into the ranked list. Opaque to callers: relevance
/// order has no stable key to build a keyset cursor from.
pub fn parse_cursor(cursor: Option<&str>) -> Result<usize, String> {
    match cursor {
        None => Ok(0),
        Some(c) => c.parse::<usize>().map_err(|_| format!("invalid cursor: {c}")),
    }
}

pub fn clamp_limit(limit: Option<u32>) -> usize {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as usize
}

/// Tags are stored lower-case without '#' (roadmap schema).
pub fn normalize_tag(tag: &str) -> Option<String> {
    let t = tag.trim().trim_start_matches('#').to_lowercase();
    (!t.is_empty()).then_some(t)
}

fn check_kind(kind: Option<&str>) -> Result<Option<&str>, String> {
    match kind {
        None => Ok(None),
        Some(k @ ("note" | "file")) => Ok(Some(k)),
        Some(k) => Err(format!("unknown kind: {k}")),
    }
}

struct Candidate {
    rowid: i64,
    id: String,
    kind: String,
    repo: Option<String>,
    score: f64,
}

fn err(e: rusqlite::Error) -> String {
    e.to_string()
}

fn bind(values: &mut Vec<Value>, v: Value) -> String {
    values.push(v);
    format!("?{}", values.len())
}

/// Every value is bound; the only text spliced in is this file's own constants.
fn candidate_sql(
    fts: Option<&str>,
    short: &[String],
    tags: &[String],
    kind: Option<&str>,
    deleted: bool,
) -> (String, Vec<Value>) {
    let mut values: Vec<Value> = Vec::new();
    let mut wheres: Vec<String> = Vec::new();
    let mut sql = match fts {
        Some(expr) => {
            let p = bind(&mut values, Value::Text(expr.to_string()));
            wheres.push(format!("entries_fts MATCH {p}"));
            format!(
                "SELECT e.rowid, e.id, e.kind, e.repo, {RANK_SQL} AS score, {FRESH_SQL} AS fresh
                 FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid"
            )
        }
        None => format!("SELECT e.rowid, e.id, e.kind, e.repo, 0.0 AS score, {FRESH_SQL} AS fresh FROM entries e"),
    };
    wheres.push(if deleted { "e.deleted_at IS NOT NULL".into() } else { "e.deleted_at IS NULL".into() });
    if let Some(k) = kind {
        let p = bind(&mut values, Value::Text(k.to_string()));
        wheres.push(format!("e.kind = {p}"));
    }
    for s in short {
        let p = bind(&mut values, Value::Text(s.clone()));
        wheres.push(format!("instr(stash_fold(e.title), {p}) > 0"));
    }
    for t in tags {
        let p = bind(&mut values, Value::Text(t.clone()));
        wheres.push(format!("EXISTS (SELECT 1 FROM tags t WHERE t.entry_id = e.id AND t.tag = {p})"));
    }
    sql.push_str(" WHERE ");
    sql.push_str(&wheres.join(" AND "));
    sql.push_str(" ORDER BY score DESC, fresh DESC, e.rowid DESC");
    (sql, values)
}

pub fn search(conn: &Connection, args: &SearchArgs) -> Result<SearchPage, String> {
    let offset = parse_cursor(args.cursor.as_deref())?;
    let limit = clamp_limit(args.limit);
    let kind = check_kind(args.kind.as_deref())?;
    let parsed = parse_query(&args.query);
    let mut tags = parsed.tags.clone();
    if let Some(t) = args.tag.as_deref().and_then(normalize_tag) {
        if !tags.contains(&t) {
            tags.push(t);
        }
    }
    let fts = fts_match(&parsed.terms);
    let short = short_terms(&parsed.terms);

    let (sql, values) = candidate_sql(fts.as_deref(), &short, &tags, kind, args.deleted);
    let candidates: Vec<Candidate> = {
        let mut st = conn.prepare(&sql).map_err(err)?;
        let rows = st
            .query_map(params_from_iter(values.iter()), |r| {
                Ok(Candidate {
                    rowid: r.get(0)?,
                    id: r.get(1)?,
                    kind: r.get(2)?,
                    repo: r.get(3)?,
                    score: r.get(4)?,
                })
            })
            .map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)?
    };

    let mut loaded: HashMap<String, StashEntry> = HashMap::new();
    let mut kept: Vec<Candidate> = Vec::with_capacity(candidates.len());
    for c in candidates {
        if let Some(repo) = args.repo.as_deref() {
            let matches = if c.kind == "note" {
                c.repo.as_deref() == Some(repo)
            } else {
                match get_entry(conn, &c.id) {
                    Ok(entry) => {
                        let m = entry.repo.as_deref() == Some(repo);
                        loaded.insert(c.id.clone(), entry);
                        m
                    }
                    Err(_) => false,
                }
            };
            if !matches {
                continue;
            }
        }
        kept.push(c);
    }

    let total = kept.len();
    let needles: Vec<String> = parsed.terms.iter().filter(|t| t.is_long()).map(Term::folded).collect();
    let mut hits = Vec::new();
    for c in kept.iter().skip(offset).take(limit) {
        let entry = match loaded.remove(&c.id) {
            Some(e) => e,
            None => get_entry(conn, &c.id)?,
        };
        let body: String = conn
            .query_row("SELECT body FROM entries_fts WHERE rowid = ?1", [c.rowid], |r| r.get(0))
            .optional()
            .map_err(err)?
            .unwrap_or_default();
        let snippet = make_snippet(&body, &needles);
        hits.push(StashHit { entry, snippet: snippet.text, ranges: snippet.ranges, score: c.score });
    }
    let next = offset + hits.len();
    Ok(SearchPage {
        hits,
        total: total as u32,
        next_cursor: (next < total).then(|| next.to_string()),
    })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::search`
Expected: PASS — every `run` test (16) and everything before it.

If `case_does_not_matter` fails for Cyrillic while Latin passes, the bundled SQLite's trigram tokenizer is not folding non-ASCII. **Stop and report.** The fix (folding `title`/`body` in Rust before indexing and folding every MATCH term) changes what the index stores and needs an `INDEX_VERSION` bump plus snippet mapping. That is a design change, not a patch.

Run clippy. From here on the count must equal the Task 0 baseline. If `unindex_entry` is reported as `dead_code` (its caller arrives in stage 06), add exactly this above it and nothing broader:

```rust
#[allow(dead_code)] // called by stage 06 (trash): delete of a file reference, purge
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/stash/search/run.rs src-tauri/src/stash/search/mod.rs src-tauri/src/stash/search/index.rs
git commit -m "feat(stash): search — trigram MATCH, short-query title fallback, bm25 title>body, cursor pages, snippets

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src-tauri/src/stash/search/run.rs src-tauri/src/stash/search/mod.rs src-tauri/src/stash/search/index.rs
```

---

### Task 8: Performance sanity with 1000 notes

**Files:**
- Modify: `src-tauri/src/stash/search/run.rs` (tests module)

- [ ] **Step 1: Write the test**

Append inside the `tests` module of `src-tauri/src/stash/search/run.rs`:

```rust
    /// Not a benchmark, and deliberately no time assertion (machines vary):
    /// it proves 1000 notes search correctly and prints how long it took.
    /// Record the release-mode numbers in the plan's "Recorded facts".
    #[test]
    fn thousand_notes_search_sanity() {
        const WORDS: [&str; 16] = [
            "тайник", "документ", "переговорка", "ключ", "сервер", "бэкап", "отчёт", "задача",
            "кабель", "проект", "встреча", "план", "доступ", "пароль", "сеть", "заметка",
        ];
        let d = db("perf");
        let mut seed: u64 = 42;
        let mut next = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) as usize
        };
        let started = std::time::Instant::now();
        for i in 0..1000 {
            let title = WORDS[next() % WORDS.len()];
            let body: Vec<&str> = (0..300).map(|_| WORDS[next() % WORDS.len()]).collect();
            d.note(&format!("n{i:04}"), &format!("# {title} {i}\n{}", body.join(" ")), i as i64);
        }
        eprintln!("stash search perf: indexed 1000 notes in {:?}", started.elapsed());

        for q in ["тайник", "мент", "\"сервер бэкап\"", "пл", "ключ доступ пароль"] {
            let started = std::time::Instant::now();
            let p = search(&d.conn, &SearchArgs { query: q.into(), limit: Some(50), ..Default::default() }).unwrap();
            let took = started.elapsed();
            eprintln!("stash search perf: {q:?} → {} of {} hits in {:.2} ms", p.hits.len(), p.total, took.as_secs_f64() * 1000.0);
            assert!(p.total > 0, "{q:?} found nothing in 1000 generated notes");
        }
    }
```

- [ ] **Step 2: Run it in debug, then in release**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::search::run::tests::thousand_notes_search_sanity -- --nocapture`
Expected: PASS, with six `stash search perf:` lines.

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --release --manifest-path src-tauri/Cargo.toml stash::search::run::tests::thousand_notes_search_sanity -- --nocapture`
Expected: PASS. Copy the six release lines into "Recorded facts" at the end of this plan and into the night report. The target is < 50 ms per query in release. If a query is slower, say which one and by how much, and keep going: no assert fails on time.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/stash/search/run.rs docs/superpowers/plans/2026-09-27-stash-05-search.md
git commit -m "test(stash): search sanity over 1000 generated notes, timings recorded

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src-tauri/src/stash/search/run.rs docs/superpowers/plans/2026-09-27-stash-05-search.md
```

---

### Task 9: Hook the index into every stash write, and check it at startup

**Files:**
- Modify: `src-tauri/src/stash/entries.rs` (`create_note`, `put_away`, and the connection-level `file_written` behind `on_file_written`)
- Modify: `src-tauri/src/stash/mod.rs` (only if `on_file_written`'s SQL lives there)
- Modify: `src-tauri/src/lib.rs` (startup thread)
- Test: `src-tauri/src/stash/search/mod.rs` (`hooks_tests`)

The hooks go into the **domain functions**, not into the Tauri commands. Stage 07's CLI and MCP call the same functions, so their writes get indexed too.

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/stash/search/mod.rs`. The three calls below use stage 02's functions. Adjust **only the argument lists** to the real signatures recorded in Task 0; the assertions stay as written.

```rust
#[cfg(test)]
mod hooks_tests {
    use super::test_support::db;
    use super::{search, SearchArgs};

    fn found(conn: &rusqlite::Connection, q: &str) -> Vec<String> {
        search(conn, &SearchArgs { query: q.into(), ..Default::default() })
            .unwrap()
            .hits
            .iter()
            .map(|h| h.entry.id.clone())
            .collect()
    }

    #[test]
    fn a_created_note_is_searchable_at_once() {
        let d = db("hook-create");
        let paths = crate::stash::StashPaths::for_test(&d.dir);
        let entry = crate::stash::entries::create_note(&d.conn, &paths, "# Тайник\nключи от серверной", None).unwrap();
        assert_eq!(found(&d.conn, "серверн"), vec![entry.id]);
    }

    #[test]
    fn a_put_away_file_is_searchable_and_a_second_put_away_reindexes() {
        let d = db("hook-put-away");
        let file = d.dir.join("hdmi.md");
        std::fs::write(&file, "переговорка на третьем").unwrap();
        let path = file.to_string_lossy().into_owned();
        let first = crate::stash::entries::put_away(&d.conn, &[path.clone()], None, None, &[]).unwrap();
        assert_eq!(found(&d.conn, "переговорка"), vec![first[0].entry.id.clone()]);

        std::fs::write(&file, "проектор в холле").unwrap();
        crate::stash::entries::put_away(&d.conn, &[path], None, None, &[]).unwrap();
        assert_eq!(found(&d.conn, "проектор"), vec![first[0].entry.id.clone()]);
        assert!(found(&d.conn, "переговорка").is_empty());
    }

    #[test]
    fn a_saved_stash_file_is_reindexed() {
        let d = db("hook-written");
        let paths = crate::stash::StashPaths::for_test(&d.dir);
        let entry = crate::stash::entries::create_note(&d.conn, &paths, "старый текст", None).unwrap();
        std::fs::write(&entry.path, "новый текст про бэкап").unwrap();
        crate::stash::entries::file_written(&d.conn, &entry.path, "новый текст про бэкап").unwrap();
        assert_eq!(found(&d.conn, "бэкап"), vec![entry.id]);
        assert!(found(&d.conn, "старый").is_empty());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::search::hooks_tests`
Expected: they compile (after the argument lists are adjusted) and FAIL on the `found(...)` assertions with empty results: nothing indexes yet.

- [ ] **Step 3: Call the index from the three write paths**

In `src-tauri/src/stash/entries.rs`, inside `create_note`, at the point where **both** the note file is on disk (`index_entry` reads it back) **and** the `INSERT INTO entries` for the new note has succeeded (inside its transaction if it uses one, before `commit`), add:

```rust
    // Best effort: a failed index update never fails the note. ensure_index
    // repairs the index at the next start.
    if let Err(e) = crate::stash::search::index_entry(&conn, &id) {
        eprintln!("stash search: index {id}: {e}");
    }
```

Here `conn` is the connection or transaction `create_note` writes with, and `id` is the new entry's id. Rename both to the local variable names used there.

Inside `put_away`, in the per-path loop, after the insert-or-bump for a path has succeeded (both the `created` and the dedup branch), add:

```rust
        if let Err(e) = crate::stash::search::index_entry(&conn, &entry_id) {
            eprintln!("stash search: index {entry_id}: {e}");
        }
```

(`entry_id` = the id of the row that was inserted or bumped.)

In the connection-level function behind `stash::on_file_written` (named `entries::file_written(conn, path, text)` in the test), after its `UPDATE entries SET modified_at …, title …` has succeeded, add:

```rust
    if let Err(e) = crate::stash::search::reindex_path(conn, path, text) {
        eprintln!("stash search: reindex {path}: {e}");
    }
```

It must come **after** the title update: `reindex_path` reads `entries.title`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::`
Expected: PASS — the three hook tests and every stage 02–04 stash test (unchanged behaviour: indexing only adds FTS rows).

- [ ] **Step 5: Check the index at startup**

In `src-tauri/src/lib.rs`, inside `.setup(|app| { … })`, directly after the line where stage 02 does `app.manage(StashState …)`, add:

```rust
            // The search index is derived: rebuild it off the main thread when
            // it is missing, corrupt, outdated or stale, then tell open stash
            // drawers to search again.
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let Some(state) = handle.try_state::<crate::stash::StashState>() else { return };
                    let rebuilt = match state.conn.lock() {
                        Ok(conn) => crate::stash::search::ensure_index(&conn),
                        Err(e) => Err(e.to_string()),
                    };
                    match rebuilt {
                        Ok(Some(reason)) => {
                            eprintln!("stash search: index rebuilt ({reason:?})");
                            let _ = handle.emit("stash-changed", serde_json::json!({ "reason": "index-rebuilt" }));
                        }
                        Ok(None) => {}
                        Err(e) => eprintln!("stash search: index check failed: {e}"),
                    }
                });
            }
```

If `tauri::Emitter` is not yet imported in `lib.rs`, add `use tauri::Emitter;` with the other `tauri` imports. If stage 02 provides a helper for emitting `stash-changed`, call that instead of `handle.emit`. Either way there is exactly one app-wide emit, per the roadmap.

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3`
Expected: builds. Clippy count equals the baseline.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/stash/entries.rs src-tauri/src/stash/mod.rs src-tauri/src/stash/search/mod.rs src-tauri/src/lib.rs
git commit -m "feat(stash): index on note create, put-away and save; ensure_index at startup

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src-tauri/src/stash/entries.rs src-tauri/src/stash/mod.rs src-tauri/src/stash/search/mod.rs src-tauri/src/lib.rs
```

---

### Task 10: The `stash_search` command

**Files:**
- Modify: `src-tauri/src/stash/commands.rs`
- Modify: `src-tauri/src/lib.rs` (`generate_handler!`)

- [ ] **Step 1: Add the command**

Append to `src-tauri/src/stash/commands.rs`:

```rust
/// IPC `stash_search` (roadmap, plus `deleted` for the trash view). The
/// arguments are flat because the contract is; Tauri maps each by name.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn stash_search(
    state: tauri::State<'_, crate::stash::StashState>,
    query: String,
    repo: Option<String>,
    tag: Option<String>,
    kind: Option<String>,
    deleted: Option<bool>,
    limit: Option<u32>,
    cursor: Option<String>,
) -> Result<crate::stash::search::SearchPage, String> {
    let args = crate::stash::search::SearchArgs {
        query,
        repo,
        tag,
        kind,
        deleted: deleted.unwrap_or(false),
        limit,
        cursor,
    };
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    crate::stash::search::search(&conn, &args)
}
```

In `src-tauri/src/lib.rs`, add `stash::commands::stash_search,` to the `tauri::generate_handler![…]` list next to stage 02's `stash_*` commands.

- [ ] **Step 2: Build and run the Rust suite**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::`
Expected: PASS. The command is a thin wrapper. Its logic and IPC shape are covered by `run` tests (`arg_helpers`, `a_page_serializes_to_the_ipc_shape`), and it is exercised live in Task 12.

Run clippy. Expected: the baseline count. The `too_many_arguments` allow is scoped to this one function because the IPC contract is flat.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/stash/commands.rs src-tauri/src/lib.rs
git commit -m "feat(stash): stash_search IPC command

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src-tauri/src/stash/commands.rs src-tauri/src/lib.rs
```

---

### Task 11: Frontend IPC and the debounced, latest-only search runner

**Files:**
- Modify: `src/lib/stash/types.ts`
- Modify: `src/lib/stash/ipc.ts`
- Create: `src/lib/stash/stash-search.ts`
- Create: `src/lib/stash/stash-search.test.ts`

- [ ] **Step 1: Add the types and the IPC wrapper**

Append to `src/lib/stash/types.ts`:

```ts
export interface StashSearchArgs {
  query: string;
  repo?: string;
  tag?: string;
  kind?: StashKind;
  /** Search the trash («Удалённые») instead of the stash. */
  deleted?: boolean;
  limit?: number;
  cursor?: string;
}

export interface StashSearchResult {
  hits: StashHit[];
  total: number;
  nextCursor: string | null;
}
```

Append to `src/lib/stash/ipc.ts` (with `StashSearchArgs, StashSearchResult` added to its type import from `./types`):

```ts
export function stashSearch(args: StashSearchArgs): Promise<StashSearchResult> {
  return invoke<StashSearchResult>('stash_search', { ...args });
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/lib/stash/stash-search.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSearchRunner,
  toArgs,
  visibleFromHits,
  SEARCH_DEBOUNCE_MS,
  SEARCH_LIMIT,
  type SearchRequest,
} from './stash-search';
import type { StashEntry, StashHit, StashSearchArgs, StashSearchResult } from './types';

function entry(id: string, path = `/n/${id}.md`): StashEntry {
  return {
    id,
    kind: 'note',
    path,
    title: id,
    repo: null,
    branch: null,
    tags: [],
    createdAt: 0,
    modifiedAt: 0,
    stashedAt: null,
    openedAt: null,
    deletedAt: null,
    caret: 0,
    topLine: 1,
    preview: '',
  };
}

function result(...ids: string[]): StashSearchResult {
  return {
    hits: ids.map((id) => ({ entry: entry(id), snippet: id, ranges: [], score: 1 })),
    total: ids.length,
    nextCursor: null,
  };
}

const req = (query: string, extra: Partial<SearchRequest> = {}): SearchRequest => ({
  query,
  repo: null,
  tag: null,
  deleted: false,
  ...extra,
});

/** A search whose answers the test releases by hand, in any order. */
function manualSearch() {
  const pending: { args: StashSearchArgs; resolve: (r: StashSearchResult) => void; reject: (e: unknown) => void }[] = [];
  const search = vi.fn(
    (args: StashSearchArgs) =>
      new Promise<StashSearchResult>((resolve, reject) => pending.push({ args, resolve, reject }))
  );
  return { search, pending };
}

describe('createSearchRunner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('Debounce_TypingFastSendsOnlyTheLastQuery', () => {
    const { search } = manualSearch();
    const runner = createSearchRunner({ search, onResult: vi.fn(), onError: vi.fn() });
    runner.request(req('т'));
    runner.request(req('та'));
    runner.request(req('тай'));
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    expect(search).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0].query).toBe('тай');
  });

  it('BlankQuery_ClearsAtOnceWithoutSearching', () => {
    const { search } = manualSearch();
    const onResult = vi.fn();
    const runner = createSearchRunner({ search, onResult, onError: vi.fn() });
    runner.request(req('тай'));
    runner.request(req('   '));
    expect(onResult).toHaveBeenCalledWith(null);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
    expect(search).not.toHaveBeenCalled();
  });

  it('LatestOnly_AnOlderAnswerArrivingLateIsDropped', async () => {
    const { search, pending } = manualSearch();
    const onResult = vi.fn();
    const runner = createSearchRunner({ search, onResult, onError: vi.fn() });
    runner.request(req('тай'));
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    runner.request(req('тайник'));
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    pending[1].resolve(result('new'));
    pending[0].resolve(result('old'));
    await vi.runAllTimersAsync();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0].hits[0].entry.id).toBe('new');
  });

  it('LatestOnly_AnAnswerArrivingDuringTheNextDebounceIsDropped', async () => {
    const { search, pending } = manualSearch();
    const onResult = vi.fn();
    const runner = createSearchRunner({ search, onResult, onError: vi.fn() });
    runner.request(req('тай'));
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    runner.request(req('тайн'));
    pending[0].resolve(result('old'));
    await Promise.resolve();
    await Promise.resolve();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('Error_ReportedOnlyForTheCurrentRequest', async () => {
    const { search, pending } = manualSearch();
    const onError = vi.fn();
    const runner = createSearchRunner({ search, onResult: vi.fn(), onError });
    runner.request(req('тай'));
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    pending[0].reject(new Error('index broken'));
    await vi.runAllTimersAsync();
    expect(onError).toHaveBeenCalledTimes(1);

    runner.request(req('ключ'));
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    runner.request(req('ключи'));
    pending[1].reject(new Error('stale'));
    await vi.runAllTimersAsync();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('Refresh_RerunsTheActiveQueryNow', () => {
    const { search } = manualSearch();
    const runner = createSearchRunner({ search, onResult: vi.fn(), onError: vi.fn() });
    runner.request(req('тай'));
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    runner.refresh();
    expect(search).toHaveBeenCalledTimes(2);
    runner.request(req(''));
    runner.refresh();
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('Dispose_APendingSearchNeverRuns', () => {
    const { search } = manualSearch();
    const runner = createSearchRunner({ search, onResult: vi.fn(), onError: vi.fn() });
    runner.request(req('тай'));
    runner.dispose();
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
    expect(search).not.toHaveBeenCalled();
  });
});

describe('toArgs', () => {
  it('OmitsAbsentFiltersAndAsksForAWholePage', () => {
    expect(toArgs(req('тай'))).toEqual({ query: 'тай', deleted: false, limit: SEARCH_LIMIT });
    expect(toArgs(req('тай', { repo: 'md-mini', tag: 'infra', deleted: true }))).toEqual({
      query: 'тай',
      repo: 'md-mini',
      tag: 'infra',
      deleted: true,
      limit: SEARCH_LIMIT,
    });
  });
});

describe('visibleFromHits', () => {
  it('KeepsRelevanceOrderAndDropsHiddenEntries', () => {
    const hits: StashHit[] = result('a', 'b', 'c').hits;
    expect(visibleFromHits(hits, (e) => e.id === 'b').map((h) => h.entry.id)).toEqual(['a', 'c']);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/lib/stash/stash-search.test.ts`
Expected: FAIL — cannot resolve `./stash-search`.

- [ ] **Step 4: Implement**

Create `src/lib/stash/stash-search.ts`:

```ts
/**
 * The stash drawer's search (spec «Поиск»: «фильтр по мере набора»). Typing
 * is debounced; every new keystroke retires the answers still in flight, so a
 * slow answer to «тай» can never overwrite the one for «тайник», and the
 * previous hits stay on screen until the new ones arrive (no flicker).
 */
import { latestOnly } from '../editor/latest-only';
import type { StashEntry, StashHit, StashSearchArgs, StashSearchResult } from './types';

export const SEARCH_DEBOUNCE_MS = 120;
/** The drawer shows one page; Rust caps `limit` at 200. */
export const SEARCH_LIMIT = 200;

export interface SearchRequest {
  query: string;
  repo: string | null;
  tag: string | null;
  deleted: boolean;
}

export interface SearchRunner {
  request(r: SearchRequest): void;
  /** Search the active query again now (the stash changed underneath). */
  refresh(): void;
  dispose(): void;
}

export function toArgs(r: SearchRequest): StashSearchArgs {
  const args: StashSearchArgs = { query: r.query, deleted: r.deleted, limit: SEARCH_LIMIT };
  if (r.repo) args.repo = r.repo;
  if (r.tag) args.tag = r.tag;
  return args;
}

export function createSearchRunner(deps: {
  search: (args: StashSearchArgs) => Promise<StashSearchResult>;
  /** `null`: no active query — show the unfiltered list. */
  onResult: (result: StashSearchResult | null) => void;
  onError: (error: unknown) => void;
}): SearchRunner {
  const latest = latestOnly();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: SearchRequest | null = null;

  const active = (r: SearchRequest | null): r is SearchRequest => r !== null && r.query.trim() !== '';

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function run(r: SearchRequest): void {
    const current = latest.begin();
    deps.search(toArgs(r)).then(
      (res) => {
        if (current()) deps.onResult(res);
      },
      (error: unknown) => {
        if (current()) deps.onError(error);
      }
    );
  }

  return {
    request(r) {
      last = r;
      cancelTimer();
      latest.invalidate();
      if (!active(r)) {
        deps.onResult(null);
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        run(r);
      }, SEARCH_DEBOUNCE_MS);
    },
    refresh() {
      if (active(last) && timer === null) run(last);
    },
    dispose() {
      cancelTimer();
      latest.invalidate();
      last = null;
    },
  };
}

/** Hits in relevance order, minus entries the drawer hides (open as a tab here). */
export function visibleFromHits(
  hits: readonly StashHit[],
  hidden: (entry: StashEntry) => boolean
): StashHit[] {
  return hits.filter((h) => !hidden(h.entry));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/stash/stash-search.test.ts && npm run check`
Expected: PASS (10 tests), and `svelte-check` reports 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/stash/types.ts src/lib/stash/ipc.ts src/lib/stash/stash-search.ts src/lib/stash/stash-search.test.ts
git commit -m "feat(stash): stash_search IPC wrapper and a debounced latest-only search runner

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/lib/stash/types.ts src/lib/stash/ipc.ts src/lib/stash/stash-search.ts src/lib/stash/stash-search.test.ts
```

---

### Task 12: The drawer searches — hits, highlighted titles, snippets

**Files:**
- Modify: `src/lib/stash/stash-store.svelte.ts`
- Modify: `src/lib/stash/StashDrawer.svelte`
- Modify: `src/lib/stash/StashCard.svelte`
- Modify: `locales/{ru,en,de,es,fr,zh}/app.json`

Field names below (`query`, `repoFilter`, `tagFilter`, `trash`, the visible list, the "open here" predicate, `--stash-accent`) are the assumed names. Use the real ones recorded in Task 0.

- [ ] **Step 1: Add the strings**

Add the two keys to each `locales/<lang>/app.json`, next to stage 04's `stash.*` keys (these are flat JSON objects):

| file | `stash.search.none` | `stash.search.more` |
|---|---|---|
| `locales/ru/app.json` | `"Ничего не нашлось"` | `"Показаны первые {shown} из {total} — уточните запрос"` |
| `locales/en/app.json` | `"Nothing found"` | `"Showing the first {shown} of {total} — refine the search"` |
| `locales/de/app.json` | `"Nichts gefunden"` | `"Die ersten {shown} von {total} — Suche verfeinern"` |
| `locales/es/app.json` | `"No se encontró nada"` | `"Se muestran los primeros {shown} de {total}: afina la búsqueda"` |
| `locales/fr/app.json` | `"Aucun résultat"` | `"Les {shown} premiers sur {total} — affinez la recherche"` |
| `locales/zh/app.json` | `"未找到内容"` | `"显示前 {shown} 条，共 {total} 条 — 请缩小搜索范围"` |

If stage 04 already has an empty-filter string with the same meaning, use that one for "none" and add only `stash.search.more`.

Run: `npx vitest run src/lib/i18n.test.ts`
Expected: PASS (the catalog parity checks see the keys in all six languages).

- [ ] **Step 2: Hold the hits in the store**

In `src/lib/stash/stash-store.svelte.ts`, add next to the store's other `$state` fields (the class-field form is shown; if the store is a plain `$state({...})` object, add the same two keys to it):

```ts
  /** Search results while a query is active; `null` = no query, or the search failed and the local substring filter applies. */
  hits = $state<StashHit[] | null>(null);
  /** How many entries matched in all, for «первые N из M». */
  searchTotal = $state(0);
```

Add `StashHit` to the store's type import from `./types`.

- [ ] **Step 3: Run the search from the drawer**

In `src/lib/stash/StashDrawer.svelte` `<script lang="ts">`, add:

```ts
  import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
  import { stashSearch } from './ipc';
  import { parseSearchQuery } from './stash-query';
  import { createSearchRunner, visibleFromHits } from './stash-search';
  import type { StashHit } from './types';

  const runner = createSearchRunner({
    search: stashSearch,
    onResult: (res) => {
      store.hits = res?.hits ?? null;
      store.searchTotal = res?.total ?? 0;
    },
    onError: (error) => {
      // `npm run dev` has no IPC, and a broken index must not blank the drawer.
      console.error('stash search failed; using the local filter', error);
      store.hits = null;
      store.searchTotal = 0;
    },
  });

  $effect(() => {
    runner.request({
      query: store.query,
      repo: store.repoFilter,
      tag: store.tagFilter,
      deleted: store.trash,
    });
  });

  $effect(() => {
    let unlisten: (() => void) | null = null;
    let gone = false;
    try {
      getCurrentWebviewWindow()
        .listen('stash-changed', () => runner.refresh())
        .then((u) => {
          if (gone) u();
          else unlisten = u;
        })
        .catch(() => {});
    } catch {
      // No Tauri window (browser dev server): nothing will change underneath.
    }
    return () => {
      gone = true;
      unlisten?.();
      runner.dispose();
    };
  });

  const terms = $derived(parseSearchQuery(store.query).terms);
  const hitById = $derived(new Map<string, StashHit>((store.hits ?? []).map((h) => [h.entry.id, h])));
```

Then replace the expression the drawer iterates over (stage 04's derived list of visible entries, called `visible` here) with:

```ts
  const shown = $derived(
    store.hits
      ? visibleFromHits(store.hits, isOpenHere).map((h) => h.entry)
      : visible
  );
```

`isOpenHere` is stage 04's predicate for "open as a tab in this window" (spec «Перенос»). Iterate `shown` in the `{#each}` instead of `visible`. Pass the hit and the terms to each card:

```svelte
<StashCard {entry} hit={hitById.get(entry.id) ?? null} {terms} /* stage 04's other props unchanged */ />
```

Below the list, inside the list container, add the empty and truncated states:

```svelte
{#if store.hits && shown.length === 0}
  <div class="search-note">{t('stash.search.none')}</div>
{:else if store.hits && store.searchTotal > store.hits.length}
  <div class="search-note">
    {t('stash.search.more', { shown: String(store.hits.length), total: String(store.searchTotal) })}
  </div>
{/if}
```

and in its `<style>`:

```css
  .search-note {
    padding: 10px 14px;
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
  }
```

While `store.hits` is non-null the list is in relevance order: stage 04's sort (⌘L/⌘R/⌘U) is not applied to `shown`. That is intentional (D11). The sort control keeps its state and applies again once the query is cleared.

- [ ] **Step 4: Highlight the title, show the snippet**

In `src/lib/stash/StashCard.svelte` `<script lang="ts">`, add the props and derivations:

```ts
  import { highlightTerms, segmentsFromRanges, type SearchTerm } from './stash-query';
  import type { StashHit } from './types';
```

Extend the `$props()` destructuring and its type with:

```ts
    hit = null,
    terms = [],
```

```ts
    /** The search hit for this card while a query is active. */
    hit?: StashHit | null;
    /** The query's terms: short ones match titles, so titles are marked with all of them. */
    terms?: readonly SearchTerm[];
```

and below:

```ts
  const titleSegments = $derived(highlightTerms(titleText, terms));
  const snippetSegments = $derived(hit ? segmentsFromRanges(hit.snippet, hit.ranges) : null);
```

`titleText` is the string stage 04 already shows as the card title, including the localized «Без названия» fallback. If the card computes it inline in the markup, lift that expression into `const titleText = $derived(…)` first.

In the markup, render the title through the segments (this replaces the plain title text node):

```svelte
{#each titleSegments as s, i (i)}{#if s.hit}<mark>{s.text}</mark>{:else}{s.text}{/if}{/each}
```

and wrap stage 04's preview element so the snippet replaces it while a hit exists:

```svelte
{#if snippetSegments && hit && hit.snippet}
  <div class="preview snippet">{#each snippetSegments as s, i (i)}{#if s.hit}<mark>{s.text}</mark>{:else}{s.text}{/if}{/each}</div>
{:else}
  <!-- stage 04's preview element, unchanged -->
{/if}
```

(A title-only hit has an empty snippet, and the card keeps its normal preview.) Add the mark style, tinted with the stash colour the way `TabCard.svelte` tints its marks with the tabs accent:

```css
  mark {
    background: color-mix(in oklab, var(--stash-accent) 24%, transparent);
    color: inherit;
    border-radius: 3px;
    padding: 0 1px;
    box-shadow: 0 0 0 1px color-mix(in oklab, var(--stash-accent) 30%, transparent);
  }
```

Everything comes from data. No `{@html}` over note text, same as `TabCard.svelte`.

- [ ] **Step 5: Type-check and run the frontend suite**

Run: `npm run check && npx vitest run --dir src 2>&1 | tail -4`
Expected: 0 type errors. Test count = Task 0 baseline + the tests added in Tasks 2 and 11, all passing. `theme-tokens.test.ts` passes, since `--stash-accent` is stage 04's defined token.

- [ ] **Step 6: Verify live in the dev app**

Run in its own terminal (the dev identity, never the production one):

```bash
CARGO_TARGET_DIR=~/.cargo/stash-impl-target npm run dev:app -- --features mcp-bridge \
  --config '{"app":{"windows":[{"title":"stash search · local"}]}}'
```

Using the MCP bridge (`webview_execute_js` with the fire-then-read pattern, and synthetic keys carrying `e.code` dispatched on `document.body`, per `CLAUDE.md`):
1. ⌘T, type `# Тайник для ключей` + Enter + `подписать документ`; ⌘T, type `Список покупок`; put both away (⌃T).
2. ⌃S opens the stash. Type `тайн`. Expected: one card. Its title shows `<mark>Тайн</mark>ик для ключей`: `webview_find_element` with selector `.stash-drawer mark` finds it.
3. Type `мент` instead. Expected: the first card's preview is the snippet, with `мент` inside `документ` marked.
4. Type `#nosuchtag`. Expected: «Ничего не нашлось».
5. Esc clears the query. Expected: the full list in stage 04's sort order, no marks.
6. `webview_screenshot` of step 3, attached to the night report.

Also open `npm run dev` (browser, no IPC) and type in the stash filter. Expected: stage 04's substring filter still works, and the console shows `stash search failed; using the local filter` once per query. That is the fallback path (D11).

- [ ] **Step 7: Commit**

```bash
git add src/lib/stash/stash-store.svelte.ts src/lib/stash/StashDrawer.svelte src/lib/stash/StashCard.svelte locales/ru/app.json locales/en/app.json locales/de/app.json locales/es/app.json locales/fr/app.json locales/zh/app.json
git commit -m "feat(stash): drawer filter searches the index — highlighted titles and match snippets

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/lib/stash/stash-store.svelte.ts src/lib/stash/StashDrawer.svelte src/lib/stash/StashCard.svelte locales/ru/app.json locales/en/app.json locales/de/app.json locales/es/app.json locales/fr/app.json locales/zh/app.json
```

---

### Task 13: Documentation and stage-end verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document the module and its traps**

In `CLAUDE.md` → Architecture, under the `src-tauri/src/` block (next to stage 02's `stash/` line), add:

```
  stash/search/         # Search (stage 05): text.rs (plain capped body), index.rs (entries_fts sync, rebuild, ensure_index), query.rs (#tag/"phrase"/words → safe MATCH), snippet.rs (UTF-16 ranges), run.rs (bm25 title 10 : body 1, cursor pages)
```

In `CLAUDE.md` → Gotchas, add:

```markdown
- **FTS5 trigram finds nothing for a term shorter than 3 characters,** and SQLite's own `lower()`/`LIKE` fold ASCII only. Short terms therefore match titles through `instr(stash_fold(title), ?)`, where `stash_fold` is a Rust `to_lowercase` registered in `stash::db::open` — any connection opened another way has no `stash_fold`, and a short query on it fails.
- **Every stash search term is a quoted FTS5 string, bound as a parameter** (`stash::search::fts_match`): inside quotes `AND`/`NEAR`/`*`/`:` are letters and `""` is the only escape. Never build a MATCH expression by concatenating user text outside quotes.
- **`StashHit.ranges` are UTF-16 code units** of the snippet, because the webview cuts with `String.slice`. Cyrillic is one unit per char and hides the difference; an emoji before the match is two — `snippet.rs` tests pin it.
- **`entries_fts` is derived; its body is plain text, not markdown.** Change what `text.rs` produces (or the 1 MiB cap) → bump `search::INDEX_VERSION`, or old rows keep the old text until something rewrites them. `ensure_index` (startup) rebuilds on a missing/corrupt/outdated/stale index and emits `stash-changed`.
- **Delete an `entries` row only after `search::unindex_entry`,** in the same transaction — afterwards its rowid is gone, and SQLite reuses the highest rowid, so a leftover FTS row would lend its text to the next entry until the next start's `ensure_index`. Searches `JOIN entries`, so it is never shown in the meantime.
- **Index hooks live in the stash domain functions** (`create_note`, `put_away`, the function behind `on_file_written`), not in Tauri commands, so the CLI/MCP writers index too. A file reference edited *outside* couplet is not reindexed until it is put away again or the index is rebuilt.
```

- [ ] **Step 2: Full verification**

Run each and compare with the Task 0 baselines:

```bash
CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^test result"
CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo clippy --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "generated [0-9]+ warning"
CARGO_TARGET_DIR=~/.cargo/stash-impl-target npm run check:x86
npx vitest run --dir src 2>&1 | tail -4
npm run check
```

Expected: cargo = baseline + the stage 05 tests (7 query + 11 text + 9 snippet + 18 index + 16 run + 1 perf + 3 hooks = 65), 0 failed. Clippy = baseline. The x86 check compiles. Vitest = baseline + stage 05's frontend tests, 0 failed. `svelte-check` 0 errors.

- [ ] **Step 3: Code review**

Dispatch the `code-reviewer` agent over the stage diff (`git diff <stage-04-last-commit>..HEAD`), pointing it at this plan's design decisions and the roadmap's data-safety rules. Fix the findings, with one commit per fix (`fix(stash): …`), and re-run Step 2.

- [ ] **Step 4: Commit and report**

```bash
git add CLAUDE.md
git commit -m "docs(stash): search module and its gotchas in CLAUDE.md

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- CLAUDE.md
```

Push `feat/stash`, and update the night report with: the stage 05 test counts, the recorded perf numbers, the screenshot from Task 12, and the known gaps below.

---

## Spec coverage (self-review)

| Spec «Поиск» requirement | Where |
|---|---|
| One search for human and agent, one index | `stash::search::search` is called by the command (Task 10) and will be called by stage 07's CLI/MCP; hooks in domain functions (Task 9) |
| Trigram: word forms, word middles, case-insensitive | D1; tests `a_word_finds_its_russian_forms`, `a_piece_inside_a_word_is_found`, `case_does_not_matter` (Task 7) |
| bm25, title > body, ties → fresher first | D3; `a_title_hit_outranks_a_fresher_body_hit`, `equal_relevance_puts_the_fresher_first` |
| Query language: text, `#tag`, phrase, combined | Tasks 1–2 (shared fixture); `a_phrase_must_appear_as_written`, `tags_and_text_combine` |
| < 3 chars → title substring | D2; `a_short_query_matches_titles_only` |
| Drawer: filter as you type, hit highlighted, snippet instead of text start | Tasks 11–12 |
| Agent: snippet ~200 chars, `total`, cursor | Tasks 4, 7 (`pages_follow_the_cursor_and_report_the_total`) |
| Index is derived and rebuildable | Tasks 5–6, `rebuild_gives_the_same_answers`, `rebuild_restores_exactly_what_incremental_indexing_built` |
| Injection safety | `fts_syntax_stays_inside_quotes`, `fts_syntax_in_a_query_is_literal_text` |
| Performance sanity | Task 8 |

## Known gaps and risks carried out of this plan

- **File references edited outside couplet** stay indexed with their old text until put away again or rebuilt. Only the active tab has a watcher, and a stashed file has no tab. A cheap later fix: reindex a file entry when `stash_touch_opened` fires, or compare mtimes in `ensure_index`.
- **`ё` ≠ `е`**, as in the tabs drawer. FTS5 trigram's `remove_diacritics` does not cover it, and Rust/JS lowercasing does not either.
- **Case is not folded for paths**, which is irrelevant here: search never compares paths.
- **Repo filter for file references** loads each matching file entry to learn its derived repo. This is fine for hundreds of file refs. At thousands, stage 02 should store the derived repo at put-away time (see the report to the caller).
- **Startup rebuild holds the stash lock** for its duration. For 1000 notes this is well under a second (Task 8 records indexing time). A stash of many large file references could push a concurrent CLI write past the 5 s busy timeout at launch.
- **A 1-char query like `а`** matches every title containing that letter. That is the spec rule, accepted.
- **The snippet anchors on the earliest match**, not the densest cluster of matches.

## Recorded facts

Filled in by Task 8 (release build, `--nocapture`):

| Measurement | Value |
|---|---|
| Machine / date | — |
| Index 1000 notes (incl. file writes) | — |
| `"тайник"` | — |
| `"мент"` | — |
| `"\"сервер бэкап\""` | — |
| `"пл"` (short, title fallback) | — |
| `"ключ доступ пароль"` | — |
