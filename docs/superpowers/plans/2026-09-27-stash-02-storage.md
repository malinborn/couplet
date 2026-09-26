# Stash 02 — Storage Implementation Plan

> **⚠️ Roadmap amendments override this plan.** Read the section «Amendments after planning» in `2026-09-27-stash-00-roadmap.md` first. Most visible here: **A1 — the notes folder is `~/couplet/` (dev `~/couplet-dev/`), not `~/Documents/…`**: use `dirs::home_dir()` instead of `dirs::document_dir()`, rename every `Documents` base in tests to a home base, and drop every TCC-prompt note or step (the home root is not TCC-protected). Also A2 (offline build, `functions` feature), A3 (`repo` = directory name) and A5 (schema v2).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Rust `stash` module that owns the stash database (`stash.db`, SQLite via `rusqlite` bundled, schema v1 with an empty FTS5 trigram table) and the note files (`~/Documents/<product>/YYYY-MM-DD-HHMM-xxxx.md`), with put-away / list / get / tag / counts / touch-opened, dedup by normalized path, title extraction shared with the future TypeScript mirror through one fixture, daily backups and a plain JSON export, the stage-02 Tauri commands, and the save hook in `write_file`. Rust only, no UI.

**Architecture:** `src-tauri/src/stash/` is a self-contained module. `Stash` (one `rusqlite::Connection` + `StashPaths`) does all the work synchronously and takes `now` / time-zone offsets as arguments, so every behaviour is a plain unit test over a unique temp directory. `StashState` (Tauri-managed, `Arc<Mutex<Result<Stash, String>>>`) is created in `setup` after `paths::init`; commands run on the blocking pool and emit `stash-changed` once after a write. `commands.rs::write_file` calls `stash::on_file_written`, a process-wide hook that updates `modified_at`/`title` off the save's thread.

**Tech Stack:** Rust (Tauri 2), `rusqlite` 0.37 (`bundled`, `backup`), `libc` (already a direct dependency) for the local time-zone offset, cargo test.

**Spec:** `docs/superpowers/specs/2026-09-26-stash-design.md` (sections «Модель», «Хранение», «Агент» for the data it will serve). **Contracts:** `docs/superpowers/plans/2026-09-27-stash-00-roadmap.md` (paths, schema v1, module table, IPC table, `title_of`, `StashEntry`). Spec wins on behaviour, the roadmap on names.

**Additions to the roadmap contracts made by this stage** (the roadmap allows it when the stage says so):

| Addition | Why |
|---|---|
| `stash/clock.rs` — `now_ms`, `local_offset_secs`, `civil_from_days`, `local_time`, `local_date`, `local_day_start_ms` | Three files need the local calendar without `chrono` (note names, `stashedToday`, backup names); one place for it. |
| `StashPaths` with **fields** `notes_dir`, `export_path`, `db_path`, `backups_dir` and `StashPaths::resolve()`, instead of free functions `stash::paths::notes_dir()` etc. | Free functions nobody calls are `dead_code` warnings; the struct is what every function takes anyway (roadmap: "or a `StashPaths` struct"). `notes_trash_dir` is added by stage 06, which first uses it. |
| `paths::current_dir_name()` | The notes folder is named like the data directory (`couplet` / `couplet-dev`), and `paths.rs` is the one owner of that name. |
| `git_info::repo_info(file)` | A file reference's repo is "the git toplevel"; `git_info` falls back to the file's own folder outside a repository, which must not become a repo tag. |
| `stash::STASH_CHANGED`, `stash::StashChanged`, `stash::install_write_hook`, `StashState::{open, with, is_available, backup_in_background}` | Wiring of the event and hook named in the roadmap. |
| `PutAway`, `ListQuery`, `ListSort`, `ListResult`, `StashCounts` Rust types | The Rust side of the IPC table's argument/return shapes. |

---

## Conventions for every task

- **Worktree:** `/Users/maximkovalevskij/playground/md-mini/.claude/worktrees/stash-impl`, branch `feat/stash` (created from `fix/draft-safety`, stage 01). Run every command from there. Never `git stash`, `checkout`, `reset` or `restore`; `git add` explicit paths only.
- **Rust:** every cargo command is prefixed with `CARGO_TARGET_DIR=~/.cargo/stash-impl-target`. Per task: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml <filter>`.
- **Warnings between tasks.** Tasks 2–12 add items whose production caller is wired in Task 13, so a plain `cargo build`/`cargo clippy` shows `dead_code` warnings for `stash::*` until then — expected. **Never add `#[allow(dead_code)]`.** Task 14 checks the clippy warning count equals the baseline recorded in Task 1.
- **Never** `npm run tauri dev`, `npm run tauri build`, `npm run build:universal`; nothing in this stage touches `~/Documents/couplet/`, `~/Documents/couplet-dev/` or any real `stash.db` — tests only use `crate::atomic_write::testkit::scratch` directories under the OS temp dir.
- **Commits:** conventional, one per task, trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Comments state constraints the code can't show. `rusqlite` APIs used here are the long-stable ones (`Connection::open`, `busy_timeout`, `execute`, `execute_batch`, `query_row`, `prepare`/`query_map`, `transaction_with_behavior`, `OptionalExtension::optional`, `backup::Backup::new`/`run_to_completion`). If one does not compile against the resolved version, check it with context7 (`resolve-library-id rusqlite`) and adapt the call, not the behaviour.
- Line numbers are deliberately absent; stage 01 edits nearby files. Find functions by name.

## Design decisions this plan commits to

| # | Decision | Why |
|---|---|---|
| D1 | The `repo` column and every `repo` filter hold the project's **directory name** (`couplet`), not a path. Any value containing `/` is reduced to its last component (`normalize_repo`). | Windows know their project as an absolute root (`routing::project_of`), a file reference's repo is derived by `git_info` as a name, and the drawer/agent filter must meet in one spelling. The TS type comment says "derived git toplevel name". |
| D2 | `~/Documents/<product>/` is not created, listed or even `stat`ed until the first note or export needs it (`Stash::notes_dir()`); opening the stash touches only Application Support. | `~/Documents` is TCC-protected: the first access from couplet raises a macOS consent dialog. It must never pop at launch. |
| D3 | A note file is reserved with `create_new` at mode `0600`, then written with `atomic_write::save` (which keeps the reserved file's mode). A name collision retries a new 4-hex suffix, up to 16 times. An existing file is never overwritten. | CLAUDE.md: "an unknown-confidentiality file is one to keep closed". `atomic_write::save` alone would overwrite a same-named file. The export uses the same `0600` reservation. |
| D4 | `put_away` is one `BEGIN IMMEDIATE` transaction: all paths or none. A path must be absolute; a path not yet in the stash must be an existing regular file. `caret`/`topLine` with more than one path is refused. | "Every multi-row change is one transaction". A single caret cannot describe several documents. |
| D5 | `kind` of a new entry: `note` when the path is inside the notes folder, else `file`. | A note file written by hand into the folder is still a note; nothing else needs a flag. |
| D6 | `stash_list` and `stash_counts` run one SQL query for the filters SQL can decide, then filter by derived repo, sort and paginate in memory. The cursor is keyset: `"<k1>.<k2>.<rowid>"` of the last returned entry's sort key; the next page is everything strictly after it. Default limit 50, clamped to 1..=500. | A file reference's repo is derived at read time, so SQL cannot filter it. A stash is hundreds to thousands of rows. A keyset cursor never repeats an entry that was raised between two pages (test `an_entry_raised_between_pages_is_not_repeated`). |
| D7 | Sort keys, all descending: `changed` = `max(modified_at, stashed_at)`; `opened` = `opened_at` (never opened = 0) then `changed`; `kind` = notes before files, then `changed`. `rowid` breaks every tie. | Spec: «по умолчанию "изменение" — недавно отложенное сверху»; a re-put-away (dedup hit) must rise to the top, and so must an edit. |
| D8 | Tags: trim, strip leading `#`s, Unicode lower-case; empty → skipped; whitespace inside or more than 64 characters → error; duplicates collapse. In `stash_tag`, `add` runs before `remove`. | `#tag` query parsing (stage 05) splits on spaces, so a tag with a space could never be searched for. |
| D9 | `on_file_written` is a process-wide hook (`OnceLock`) holding a `StashState` clone and a notifier, so `write_file` keeps its signature and tests. It runs on the blocking pool, updates only `WHERE modified_at <= now` (a late, older save cannot roll a title back), and notifies — `stash-changed { reason: "written" }` — only when the title changed. The hook is installed only when the stash opened. | Autosave runs every 300 ms: an event per save would repaint every window's stash drawer constantly, and a busy database (the CLI holding a write, 5 s busy timeout) must never delay the save. |
| D10 | `migrate` reads `user_version` inside a `BEGIN IMMEDIATE` transaction and loops one step at a time. A schema newer than this build knows is an error: the stash is unavailable, the file is left alone. | The app, the CLI and MCP can open the database at the same moment (roadmap: they share it). Never downgrade, never delete. |
| D11 | A database that cannot open leaves `StashState` *unavailable*: every command answers `stash unavailable: <reason>`, the app keeps running, the file is not renamed or removed. | Losing the stash's index must not cost the editor; the file is evidence. |
| D12 | Backups: `stash-backups/stash-YYYY-MM-DD.db` (local date), written by the online backup API to `.tmp`, switched to `journal_mode=DELETE` so it is one self-contained file, then renamed. Taken at launch (background) and after any command write when today's is missing. Keep the 7 newest; prune only names matching exactly `stash-YYYY-MM-DD.db`. | App data dir: `.tmp` + `rename` is the CLAUDE.md-sanctioned shape there (no user metadata). Backups copy metadata, not note text (that lives in the `.md` files). |
| D13 | `.stash-export.json` is rewritten after every command write (not by the save hook): `{version: 1, exportedAt, entries: [...plain columns..., tags]}`, no note text, `0600`, via `atomic_write::save` (it lives in the user's folder). | A human-readable second copy of the metadata beside the notes; the hook's 300 ms cadence is too frequent for a full rewrite. |
| D14 | Local time without `chrono`: the offset comes from `libc::localtime_r` (`tm_gmtoff`) at the instant in question, the calendar from Howard Hinnant's `civil_from_days`. | No new dependency. On a DST-change day the offset is taken at `now`, which can shift "today" by an hour for one night — accepted. |
| D15 | Ids: `s<unix ms>-<4 hex>`; the 16 bits come from std's per-process random `RandomState` hashing a counter, the pid and the nanosecond clock. Uniqueness is enforced by checking inside the insert transaction (8 attempts). | No `rand`/`uuid` dependency; short ids for `couplet stash get <id>`; collisions are handled, not assumed away. |
| D16 | `title_of` rules, exactly (the TS mirror in stage 03 copies them): split lines like `split(/\r?\n/)`; trim with exactly JS `String.prototype.trim`'s set (Rust `White_Space` minus U+0085, plus U+FEFF); first non-blank line; if it is an ATX heading (`#{1,6}` followed by space, tab or end of line) take its text minus an optional closing `#` sequence, else strip leading `"> "`, `"- [ ] "`, `"- [x] "`, `"- [X] "`, `"- "` repeatedly; then delete every `*` and `` ` ``; trim; keep the first 120 Unicode scalar values (`Array.from`, not `.length`); trim the end; empty → `None`. The DB stores `None` as `''`. | Roadmap rule made precise enough for two implementations to agree on every fixture case. |
| D17 | Preview: at most 1600 bytes read (regular files only, opened `O_NONBLOCK`, like `git_info::read_small`), cut back to the last complete UTF-8 character, invalid UTF-8 → `""`, `\r\n` → `\n`, first 400 characters. Unreadable → `""`. | A FIFO or a device in the stash must not hang a listing; a binary file has no preview. |
| D18 | `created_at` of a file reference is the first put-away time; its `modified_at` is the file's mtime at that moment; `title` is its file name and never changes through the save hook. | Roadmap: "file: file name". |

## File Structure

| File | Responsibility |
|---|---|
| `src-tauri/Cargo.toml` (modify) | `rusqlite = { version = "0.37", features = ["bundled", "backup"] }` |
| `src-tauri/src/lib.rs` (modify) | `mod stash;`, the seven commands in `generate_handler!`, `StashState` + write hook + launch backup in `setup` after `paths::init` |
| `src-tauri/src/paths.rs` (modify) | `current_dir_name()` |
| `src-tauri/src/git_info.rs` (modify) | `repo_info()`; `git_info()` rebuilt on it |
| `src-tauri/src/commands.rs` (modify) | `write_file` calls `stash::on_file_written` after a successful save |
| `src-tauri/src/stash/mod.rs` (new) | public types, `Stash`, `StashState`, write hook, test kit, FTS probe |
| `src-tauri/src/stash/clock.rs` (new) | local calendar without `chrono` |
| `src-tauri/src/stash/ids.rs` (new) | `new_id`, `random16` |
| `src-tauri/src/stash/notes.rs` (new) | `title_of`, `note_file_name`, `reserve_private`, `create_note_file` |
| `src-tauri/src/stash/paths.rs` (new) | `StashPaths` |
| `src-tauri/src/stash/db.rs` (new) | open, pragmas, `migrate`, `EntryRow`, `all_tags` |
| `src-tauri/src/stash/entries.rs` (new) | create note, get, put-away, tag, touch-opened, file-written, list, counts, preview |
| `src-tauri/src/stash/backup.rs` (new) | daily backup, prune, export |
| `src-tauri/src/stash/commands.rs` (new) | `stash_create_note`, `stash_put_away`, `stash_list`, `stash_get`, `stash_tag`, `stash_touch_opened`, `stash_counts` |
| `src-tauri/tests/fixtures/note-titles.json` (new) | shared `title_of` / `noteTitle` fixture (33 cases) |
| `CLAUDE.md` (modify) | architecture lines for `stash/`, two gotchas |

---

### Task 1: `rusqlite` with FTS5 trigram, proven by a test

**Files:**
- Create: `src-tauri/src/stash/mod.rs`
- Modify: `src-tauri/src/lib.rs` (module list)
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Record the baselines**

```bash
CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^test result"
CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo clippy --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "generated [0-9]+ warning"
npm run build
CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo build --release --manifest-path src-tauri/Cargo.toml 2>&1 | tail -1
ls -l ~/.cargo/stash-impl-target/release/md-mini | awk '{print $5}'
```

`npm run build` is the frontend-only build (`generate_context!` embeds `dist/` in a release compile); the release `cargo build` makes a bare binary, no bundle, no install. Write the numbers (tests passed/ignored, clippy warning count, release binary bytes) into the **Measurements** section at the end of this file under "Before". Expected: all tests pass; one clippy line such as `warning: \`md-mini\` (lib) generated N warnings`.

- [ ] **Step 2: Write the failing probe**

Create `src-tauri/src/stash/mod.rs`:

```rust
//! The stash (тайник): everything the human put away or typed without a file
//! name, kept durably. SQLite (`stash.db` in the app data directory) is the
//! source of truth for entries, tags and times; note text lives in plain `.md`
//! files under `~/Documents/<product>/`, addressed by path, so every file-tab
//! mechanism works on notes unchanged. Spec:
//! `docs/superpowers/specs/2026-09-26-stash-design.md`; contracts:
//! `docs/superpowers/plans/2026-09-27-stash-00-roadmap.md`.

#[cfg(test)]
mod fts_probe {
    //! Search (stage 05) depends on FTS5 and its `trigram` tokenizer being
    //! compiled into the bundled SQLite. This test is what fails if a
    //! `rusqlite` bump ever builds it without them.

    use rusqlite::Connection;

    fn hits(conn: &Connection, query: &str) -> Vec<i64> {
        let mut stmt = conn
            .prepare("SELECT rowid FROM probe WHERE probe MATCH ?1 ORDER BY rowid")
            .unwrap();
        stmt.query_map([query], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn bundled_sqlite_has_fts5_with_the_trigram_tokenizer() {
        let conn = Connection::open_in_memory().unwrap();
        let version: String = conn.query_row("SELECT sqlite_version()", [], |r| r.get(0)).unwrap();
        let fts5: i64 = conn
            .query_row("SELECT sqlite_compileoption_used('ENABLE_FTS5')", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fts5, 1, "SQLite {version} was built without FTS5");

        conn.execute_batch("CREATE VIRTUAL TABLE probe USING fts5(title, body, tokenize = 'trigram');")
            .unwrap();
        conn.execute(
            "INSERT INTO probe (rowid, title, body) VALUES \
             (1, 'Где ключ', 'Ключ лежит в тайнике у двери'), \
             (2, 'Документ', 'план переезда')",
            [],
        )
        .unwrap();

        assert_eq!(hits(&conn, "\"тайник\""), vec![1], "a word form: «тайник» inside «тайнике»");
        assert_eq!(hits(&conn, "\"мент\""), vec![2], "a piece from the middle of a word");
        assert_eq!(hits(&conn, "\"ТАЙНИК\""), vec![1], "case-insensitive for Cyrillic");
    }
}
```

Add `mod stash;` to the module list at the top of `src-tauri/src/lib.rs`, alphabetically between `mod session;` and `mod tab_commands;`.

- [ ] **Step 3: Run it to see it fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::fts_probe`
Expected: FAIL to compile — `use of unresolved module or unlinked crate \`rusqlite\``.

- [ ] **Step 4: Add the dependency**

In `src-tauri/Cargo.toml`, `[dependencies]`, after the `core-foundation` line:

```toml
# The stash database (`src/stash/`). `bundled` compiles SQLite from source so
# FTS5 and its `trigram` tokenizer (search, stage 05) never depend on the macOS
# system library; `backup` exposes the online backup API (`stash::backup`).
# The one new dependency the stash is allowed (roadmap).
rusqlite = { version = "0.37", features = ["bundled", "backup"] }
```

If the fetch fails for lack of network (`Couldn't connect to server` for `index.crates.io`), stop this stage: nothing in stages 02–07 can proceed without it. Record it as a question in `docs/superpowers/plans/stash-questions.md` per the implementer prompt and report.

- [ ] **Step 5: Confirm the features in the crate sources**

```bash
grep -nE '^(backup|bundled) *=' ~/.cargo/registry/src/*/rusqlite-0.37.*/Cargo.toml
grep -n 'SQLITE_ENABLE_FTS5' ~/.cargo/registry/src/*/libsqlite3-sys-*/build.rs
```

Expected: `backup = [...]` and `bundled = [...]` lines from rusqlite's manifest, and a `-DSQLITE_ENABLE_FTS5` flag line in libsqlite3-sys's bundled build. Paste both outputs (with the versions in the paths) into **Measurements → FTS5 source check**.

- [ ] **Step 6: Run the probe**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::fts_probe`
Expected: PASS — `test stash::fts_probe::bundled_sqlite_has_fts5_with_the_trigram_tokenizer ... ok`, `1 passed`. The first build compiles SQLite's C amalgamation (tens of seconds).

**If the FTS5 assertion fails** (`built without FTS5`): create `.cargo/config.toml` at the worktree root with

```toml
# libsqlite3-sys reads extra -D flags for its bundled build from this variable.
[env]
LIBSQLITE3_FLAGS = "-DSQLITE_ENABLE_FTS5"
```

then `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo clean --manifest-path src-tauri/Cargo.toml -p libsqlite3-sys` and re-run; add `.cargo/config.toml` to this task's commit and note it in the night report. **If only the `ТАЙНИК` assertion fails:** the tokenizer is present but does not fold Cyrillic case — replace that assertion with `assert!(hits(&conn, "\"ТАЙНИК\"").is_empty(), "…")`, record it in the night report and in `stash-questions.md` (stage 05 must then lower-case both the indexed text and the query). Any other failure (e.g. `no such tokenizer: trigram`) means the bundled SQLite is older than 3.34: raise the rusqlite version until the probe passes.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/stash/mod.rs src-tauri/src/lib.rs docs/superpowers/plans/2026-09-27-stash-02-storage.md
git commit -m "$(cat <<'EOF'
build(stash): add rusqlite (bundled, backup) and prove FTS5 trigram

A probe test creates an FTS5 trigram table and matches a Russian word
form, a mid-word piece and an upper-case query against the bundled SQLite.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `clock.rs` — the local calendar without `chrono`

**Files:**
- Create: `src-tauri/src/stash/clock.rs`
- Modify: `src-tauri/src/stash/mod.rs` (module list)

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/stash/clock.rs` with only the tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-09-26 02:15 in Moscow (+03:00) = 2026-09-25 23:15 UTC.
    const T: i64 = 1_790_378_100_000;

    #[test]
    fn now_is_a_plausible_unix_millisecond() {
        assert!(now_ms() > 1_700_000_000_000);
    }

    #[test]
    fn the_local_offset_is_a_real_time_zone() {
        let offset = local_offset_secs(now_ms() / 1000);
        assert!((-14 * 3600..=14 * 3600).contains(&offset), "{offset}");
    }

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(11_017), (2000, 3, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        assert_eq!(civil_from_days(20_722), (2026, 9, 26));
    }

    #[test]
    fn local_time_in_three_zones() {
        let at = |y, mo, d, h, mi| LocalTime { year: y, month: mo, day: d, hour: h, minute: mi };
        assert_eq!(local_time(T, 10_800), at(2026, 9, 26, 2, 15));
        assert_eq!(local_time(T, 0), at(2026, 9, 25, 23, 15));
        assert_eq!(local_time(T, -18_000), at(2026, 9, 25, 18, 15));
    }

    #[test]
    fn the_local_day_starts_at_local_midnight() {
        assert_eq!(local_day_start_ms(T, 10_800), 1_790_370_000_000);
        assert_eq!(local_day_start_ms(T, 0), 1_790_294_400_000);
        assert_eq!(local_day_start_ms(T, -18_000), 1_790_312_400_000);
    }

    #[test]
    fn local_date_is_iso() {
        assert_eq!(local_date(T, 10_800), "2026-09-26");
        assert_eq!(local_date(T, 0), "2026-09-25");
    }
}
```

Add `mod clock;` to `src-tauri/src/stash/mod.rs`, right after the module doc comment.

- [ ] **Step 2: Run them to see them fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::clock`
Expected: FAIL to compile — `cannot find function now_ms`, `cannot find struct LocalTime`.

- [ ] **Step 3: Implement**

Prepend to `src-tauri/src/stash/clock.rs`:

```rust
//! Wall clock and the user's local calendar, without `chrono`: note file
//! names (`2026-09-26-0215-…`), "put away today" and backup names are all in
//! the user's local time. The offset comes from the C library's time-zone
//! database (`localtime_r`), the calendar arithmetic from Howard Hinnant's
//! `civil_from_days` (http://howardhinnant.github.io/date_algorithms.html).

use std::time::{SystemTime, UNIX_EPOCH};

const DAY_SECS: i64 = 86_400;

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Seconds east of UTC in the user's time zone at `unix_secs`. `0` when the C
/// library cannot say — a date off by the zone's offset is not worth failing
/// a note over.
///
/// `time_t` and `c_long` are both `i64` on every target this app builds
/// (aarch64 and x86_64 macOS), so no casts; a 32-bit target would fail to
/// compile here, which is the signal wanted.
pub(crate) fn local_offset_secs(unix_secs: i64) -> i64 {
    let t: libc::time_t = unix_secs;
    // SAFETY: an all-zero `tm` is a valid value (its one pointer field is null).
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: both pointers are valid for the call; `localtime_r` writes only into `tm`.
    let filled = unsafe { !libc::localtime_r(&t, &mut tm).is_null() };
    if filled {
        tm.tm_gmtoff
    } else {
        0
    }
}

/// `(year, month 1–12, day 1–31)` of the proleptic Gregorian calendar for a
/// count of days since 1970-01-01 (negative before it).
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LocalTime {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
}

pub(crate) fn local_time(unix_ms: i64, offset_secs: i64) -> LocalTime {
    let local = unix_ms.div_euclid(1000) + offset_secs;
    let (year, month, day) = civil_from_days(local.div_euclid(DAY_SECS));
    let secs_of_day = local.rem_euclid(DAY_SECS);
    LocalTime {
        year,
        month,
        day,
        hour: (secs_of_day / 3600) as u32,
        minute: (secs_of_day % 3600 / 60) as u32,
    }
}

/// `YYYY-MM-DD` of `unix_ms` in local time.
pub(crate) fn local_date(unix_ms: i64, offset_secs: i64) -> String {
    let t = local_time(unix_ms, offset_secs);
    format!("{:04}-{:02}-{:02}", t.year, t.month, t.day)
}

/// Unix ms of the local midnight that starts the day containing `now_ms`.
/// Uses one offset for both ends, so on a DST-change day "today" can be off by
/// the shift for one night — accepted (plan D14).
pub(crate) fn local_day_start_ms(now_ms: i64, offset_secs: i64) -> i64 {
    let local = now_ms.div_euclid(1000) + offset_secs;
    (local.div_euclid(DAY_SECS) * DAY_SECS - offset_secs) * 1000
}
```

- [ ] **Step 4: Run the tests**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::clock`
Expected: PASS, `6 passed`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/stash/clock.rs src-tauri/src/stash/mod.rs
git commit -m "$(cat <<'EOF'
feat(stash): local calendar without chrono

localtime_r for the offset, civil_from_days for the date: note names,
"put away today" and backup names are in the user's local time.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `ids.rs` — stable public ids

**Files:**
- Create: `src-tauri/src/stash/ids.rs`
- Modify: `src-tauri/src/stash/mod.rs` (module list)

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/stash/ids.rs` with only the tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn has_id_shape(id: &str) -> bool {
        let Some(rest) = id.strip_prefix('s') else { return false };
        let Some((ms, hex)) = rest.split_once('-') else { return false };
        !ms.is_empty()
            && ms.bytes().all(|b| b.is_ascii_digit())
            && hex.len() == 4
            && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }

    #[test]
    fn an_id_is_the_millisecond_and_four_hex_digits() {
        assert_eq!(id_at(1_790_378_408_605, 0x3f9a), "s1790378408605-3f9a");
        assert_eq!(id_at(5, 0x000b), "s5-000b");
    }

    #[test]
    fn new_ids_have_the_shape() {
        for _ in 0..100 {
            let id = new_id();
            assert!(has_id_shape(&id), "{id}");
        }
    }

    #[test]
    fn the_salt_is_spread_even_within_one_millisecond() {
        let salts: HashSet<u16> = (0..1000).map(|_| random16()).collect();
        assert!(salts.len() >= 900, "only {} distinct salts in 1000", salts.len());
    }
}
```

Add `mod ids;` to the module list in `src-tauri/src/stash/mod.rs` (alphabetical: after `mod clock;`).

- [ ] **Step 2: Run them to see them fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::ids`
Expected: FAIL to compile — `cannot find function id_at`.

- [ ] **Step 3: Implement**

Prepend to `src-tauri/src/stash/ids.rs`:

```rust
//! Public ids of stash entries, `s<unix ms>-<4 hex>` (e.g. `s1790378408605-3f9a`):
//! short enough to type in `couplet stash get <id>`, sortable by creation.
//! Sixteen bits of salt cannot be unique by themselves — the insert checks the
//! id is free inside its transaction and draws again (`entries::unique_id`).

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) fn new_id() -> String {
    id_at(super::clock::now_ms(), random16())
}

fn id_at(unix_ms: i64, salt: u16) -> String {
    format!("s{unix_ms}-{salt:04x}")
}

/// Sixteen unpredictable bits without a `rand` dependency: std seeds every
/// `RandomState` from the OS once per thread and varies it per instance; the
/// counter, the pid and the clock make two draws in one nanosecond, or in two
/// processes (the app and the CLI), still differ.
pub(crate) fn random16() -> u16 {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    hasher.write_u32(std::process::id());
    hasher.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    (hasher.finish() & 0xffff) as u16
}
```

- [ ] **Step 4: Run the tests**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::ids`
Expected: PASS, `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/stash/ids.rs src-tauri/src/stash/mod.rs
git commit -m "$(cat <<'EOF'
feat(stash): entry ids without a new dependency

s<ms>-<4 hex>, salted from std's per-process RandomState.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `title_of` and the shared fixture

**Files:**
- Create: `src-tauri/tests/fixtures/note-titles.json`
- Create: `src-tauri/src/stash/notes.rs`
- Modify: `src-tauri/src/stash/mod.rs` (module list)

- [ ] **Step 1: Generate the fixture**

The fixture has strings whose exact length matters (120, 130 characters, emoji). Generate it instead of typing it:

```bash
mkdir -p src-tauri/tests/fixtures
python3 - <<'PY'
import json
cases = [
    ("", None),
    ("   \n\t\n  ", None),
    ("# Заголовок\nтекст под ним", "Заголовок"),
    ("## Второй уровень", "Второй уровень"),
    ("### Третий", "Третий"),
    ("#### Четвёртый", "Четвёртый"),
    ("##### Пятый", "Пятый"),
    ("###### Шестой", "Шестой"),
    ("####### семь решёток — не заголовок", "####### семь решёток — не заголовок"),
    ("#тег без пробела", "#тег без пробела"),
    ("## Title ##", "Title"),
    ("# C#", "C#"),
    ("#\tTab heading", "Tab heading"),
    ("  # Отступ перед решёткой", "Отступ перед решёткой"),
    ("#", None),
    ("# **Жирный заголовок**", "Жирный заголовок"),
    ("\n\n   Первая строка   \nвторая строка", "Первая строка"),
    ("Сначала текст\n# Заголовок ниже", "Сначала текст"),
    ("- [ ] купить молоко", "купить молоко"),
    ("- [x] сделано", "сделано"),
    ("- [X] Done", "Done"),
    ("- пункт списка", "пункт списка"),
    ("* звёздочка-маркер", "звёздочка-маркер"),
    ("> цитата", "цитата"),
    ("> - [ ] задача в цитате", "задача в цитате"),
    ("**Жирный** и *курсив* и `код`", "Жирный и курсив и код"),
    ("**", None),
    ("first line\r\nsecond line", "first line"),
    ("  Неразрывный пробел ", "Неразрывный пробел"),
    ("﻿# С BOM", "С BOM"),
    ("а" * 130, "а" * 120),
    ("x" * 119 + " yyyy", "x" * 119),
    ("\U0001F600" * 121, "\U0001F600" * 120),
]
with open("src-tauri/tests/fixtures/note-titles.json", "w", encoding="utf-8") as f:
    json.dump([{"text": t, "title": ti} for t, ti in cases], f, ensure_ascii=False, indent=2)
    f.write("\n")
print(len(cases))
PY
```

Expected output: `33`. Open the file and check a few entries by eye (`"title": null` for the first two). The TypeScript mirror (stage 03, `src/lib/stash/note-title.test.ts`) reads this same file; changing a case changes both contracts.

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/stash/notes.rs` with only the tests:

```rust
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
            serde_json::from_str(include_str!("../../tests/fixtures/note-titles.json")).expect("fixture is JSON");
        assert!(cases.len() >= 15, "the fixture is the TS mirror's contract too; keep it rich");
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
```

Add `mod notes;` to the module list in `src-tauri/src/stash/mod.rs` (after `mod ids;`).

- [ ] **Step 3: Run them to see them fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::notes`
Expected: FAIL to compile — `cannot find function title_of`.

- [ ] **Step 4: Implement**

Prepend to `src-tauri/src/stash/notes.rs`:

```rust
//! Note files: the display title of a note's text, the note file's stable
//! name, and creating it. The title rules are mirrored by `noteTitle` in
//! `src/lib/stash/note-title.ts` (stage 03); both are held to
//! `src-tauri/tests/fixtures/note-titles.json`, so every rule below is written
//! to be reproducible with plain JavaScript string methods (plan D16).

/// Longest title, in Unicode scalar values — `chars()` here, `Array.from` in
/// the mirror; `.length` would count an emoji twice.
pub(crate) const TITLE_MAX_CHARS: usize = 120;

/// Stripped from the start of a non-heading line, repeatedly, in this order
/// (the task markers before the bare bullet they start with).
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
    let line = text.lines().map(trim).find(|l| !l.is_empty())?;
    let raw = heading_text(line).unwrap_or_else(|| strip_line_prefixes(line));
    let plain: String = raw.chars().filter(|c| *c != '*' && *c != '`').collect();
    let clipped: String = trim(&plain).chars().take(TITLE_MAX_CHARS).collect();
    let title = trim(&clipped);
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
    // `# C#` keeps its `#`: a closing sequence must be separated by a space.
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
                rest = trim(after);
                continue 'strip;
            }
        }
        return rest;
    }
}
```

- [ ] **Step 5: Run the tests**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::notes`
Expected: PASS, `2 passed`. A fixture mismatch prints the offending `text`; fix the code, never the fixture, unless the case contradicts D16 — then fix the case and say so in the commit.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/tests/fixtures/note-titles.json src-tauri/src/stash/notes.rs src-tauri/src/stash/mod.rs
git commit -m "$(cat <<'EOF'
feat(stash): note titles and the shared title fixture

title_of follows the roadmap rule, made exact enough for the stage-03
TypeScript mirror; both read tests/fixtures/note-titles.json (33 cases:
all heading levels, checkboxes, bold, blank, BOM, NBSP, 120-char limit).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: note file names and creating a note file

**Files:**
- Modify: `src-tauri/src/stash/notes.rs`

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `src-tauri/src/stash/notes.rs` (after the existing tests; extend its `use` lines as shown):

```rust
    use crate::atomic_write::testkit::{content_of, mode_of, scratch, temp_leftovers};
    use std::fs;

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
        let dir = scratch("note").join("Documents/couplet-test");
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
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "nothing else was created");
    }
```

- [ ] **Step 2: Run them to see them fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::notes`
Expected: FAIL to compile — `cannot find function note_file_name`, `create_note_file`.

- [ ] **Step 3: Implement**

In `src-tauri/src/stash/notes.rs`, below the module doc comment and above `TITLE_MAX_CHARS`, add:

```rust
use std::fs::{self, OpenOptions};
use std::io::ErrorKind;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use crate::atomic_write::{self, NewFileMode};

use super::clock;

/// How many names `create_note_file` tries before giving up. Each try draws a
/// new 16-bit salt, so running out means something is wrong with the folder.
const NAME_ATTEMPTS: usize = 16;
```

And at the end of the non-test code (above `#[cfg(test)]`):

```rust
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
/// app; tests pass a fixed sequence.
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
```

- [ ] **Step 4: Run the tests**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::notes`
Expected: PASS, `6 passed`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/stash/notes.rs
git commit -m "$(cat <<'EOF'
feat(stash): stable note file names, created 0600 via atomic_write

YYYY-MM-DD-HHMM-xxxx.md in local time; a reserved create_new file means
an existing note is never overwritten by a colliding name.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `StashPaths` — dev and release apart

**Files:**
- Create: `src-tauri/src/stash/paths.rs`
- Modify: `src-tauri/src/stash/mod.rs` (module list, re-export)
- Modify: `src-tauri/src/paths.rs` (`current_dir_name`)

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/stash/paths.rs` with only the tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn dev_and_release_keep_notes_in_separate_folders() {
        let docs = Path::new("/Users/u/Documents");
        let dev_data = Path::new("/Users/u/Library/Application Support/couplet-dev");
        let dev = StashPaths::from_bases(docs, dev_data, &crate::paths::dir_name("couplet-dev"));
        assert_eq!(dev.notes_dir, PathBuf::from("/Users/u/Documents/couplet-dev"));
        assert_eq!(dev.export_path, PathBuf::from("/Users/u/Documents/couplet-dev/.stash-export.json"));
        assert_eq!(dev.db_path, dev_data.join("stash.db"));
        assert_eq!(dev.backups_dir, dev_data.join("stash-backups"));

        let release_data = Path::new("/Users/u/Library/Application Support/couplet");
        let release = StashPaths::from_bases(docs, release_data, &crate::paths::dir_name("couplet"));
        assert_eq!(release.notes_dir, PathBuf::from("/Users/u/Documents/couplet"));
        assert_ne!(release.notes_dir, dev.notes_dir);
        assert_ne!(release.db_path, dev.db_path);
    }

    #[test]
    fn building_the_paths_touches_nothing() {
        let root = crate::atomic_write::testkit::scratch("stash-paths");
        let _ = StashPaths::from_bases(&root.join("Documents"), &root.join("data"), "couplet-test");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    }

    #[test]
    fn a_new_notes_dir_moves_the_export_with_it() {
        let paths = StashPaths::from_bases(Path::new("/d"), Path::new("/a"), "couplet");
        let moved = paths.with_notes_dir(PathBuf::from("/private/d/couplet"));
        assert_eq!(moved.notes_dir, PathBuf::from("/private/d/couplet"));
        assert_eq!(moved.export_path, PathBuf::from("/private/d/couplet/.stash-export.json"));
        assert_eq!(moved.db_path, paths.db_path);
        assert_eq!(moved.backups_dir, paths.backups_dir);
    }
}
```

Add to `src-tauri/src/stash/mod.rs`: `mod paths;` in the module list (after `mod notes;`), and below the module list:

```rust
pub use paths::StashPaths;
```

- [ ] **Step 2: Run them to see them fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::paths`
Expected: FAIL to compile — `cannot find type StashPaths`.

- [ ] **Step 3: Implement**

Prepend to `src-tauri/src/stash/paths.rs`:

```rust
//! Where the stash lives (roadmap «Paths»). Every function that touches disk
//! takes a `StashPaths`, so tests point it at a temp directory and never at
//! the real `~/Documents/couplet/` or `stash.db`.

use std::path::{Path, PathBuf};

pub(crate) const DB_FILE: &str = "stash.db";
pub(crate) const BACKUPS_DIR: &str = "stash-backups";
pub(crate) const EXPORT_FILE: &str = ".stash-export.json";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StashPaths {
    /// `~/Documents/<product>/`: the note files. Neither created nor looked at
    /// until a note or the export needs it — `~/Documents` is TCC-protected
    /// and the first access raises a macOS consent dialog (plan D2).
    pub notes_dir: PathBuf,
    /// `<notes_dir>/.stash-export.json`, the plain metadata snapshot.
    pub export_path: PathBuf,
    /// `<app data>/stash.db`.
    pub db_path: PathBuf,
    /// `<app data>/stash-backups/`.
    pub backups_dir: PathBuf,
}

impl StashPaths {
    /// Pure: names the paths, creates nothing. `product_dir` is
    /// `paths::dir_name(product)` — `couplet` or `couplet-dev`.
    pub fn from_bases(documents: &Path, app_data: &Path, product_dir: &str) -> Self {
        let notes_dir = documents.join(product_dir);
        Self {
            export_path: notes_dir.join(EXPORT_FILE),
            notes_dir,
            db_path: app_data.join(DB_FILE),
            backups_dir: app_data.join(BACKUPS_DIR),
        }
    }

    /// The live app's paths. Only after `paths::init` (CLAUDE.md: before it,
    /// `app_data_dir` refuses and the name is unknown).
    pub fn resolve() -> Result<Self, String> {
        let product_dir = crate::paths::current_dir_name().ok_or("paths::init has not run")?;
        let documents = dirs::document_dir().ok_or("Cannot determine the Documents folder")?;
        Ok(Self::from_bases(&documents, &crate::paths::app_data_dir()?, product_dir))
    }

    /// The same paths with `notes_dir` replaced (by its normalized spelling,
    /// once it exists) and the export following it.
    pub(crate) fn with_notes_dir(&self, notes_dir: PathBuf) -> Self {
        Self {
            export_path: notes_dir.join(EXPORT_FILE),
            notes_dir,
            ..self.clone()
        }
    }
}
```

In `src-tauri/src/paths.rs`, add right after `pub fn init(…)`:

```rust
/// The directory name `init` settled on — `couplet`, or `couplet-dev` for the
/// dev build — for app state kept outside the data directory: the stash's
/// notes folder in `~/Documents` is named the same way so a dev build never
/// writes into the installed app's notes. `None` before `init`.
pub fn current_dir_name() -> Option<&'static str> {
    APP_DIR_NAME.get().map(String::as_str)
}
```

(No unit test for this getter: exercising it means calling `init`, which fixes the process-wide name for every other test in the binary.)

- [ ] **Step 4: Run the tests**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::paths`
Expected: PASS, `3 passed`. Also `… cargo test --manifest-path src-tauri/Cargo.toml paths::tests` — the existing `paths.rs` tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/stash/paths.rs src-tauri/src/stash/mod.rs src-tauri/src/paths.rs
git commit -m "$(cat <<'EOF'
feat(stash): StashPaths, named after the product like the data dir

~/Documents/couplet-dev for the dev build, never the installed app's
notes; nothing is created by naming the paths.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `db.rs` — open, pragmas, forward-only migrations, schema v1

**Files:**
- Create: `src-tauri/src/stash/db.rs`
- Modify: `src-tauri/src/stash/mod.rs` (module list, `StashKind`)

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/stash/db.rs` with only the tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::atomic_write::testkit::scratch;
    use std::path::PathBuf;

    fn db_in(tag: &str) -> PathBuf {
        scratch(tag).join("data").join("stash.db")
    }

    fn one<T: rusqlite::types::FromSql>(conn: &Connection, sql: &str) -> T {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    const INSERT_A: &str = "INSERT INTO entries \
        (id, kind, path, title, repo, created_at, modified_at, stashed_at, opened_at, deleted_at, caret, top_line) \
        VALUES ('s1-0001', 'note', '/n/a.md', 'A', 'proj', 1, 2, 3, 4, NULL, 5, 6)";

    #[test]
    fn a_fresh_database_gets_schema_v1_and_the_pragmas() {
        let conn = open(&db_in("db-fresh")).unwrap();
        assert_eq!(one::<i64>(&conn, "PRAGMA user_version"), SCHEMA_VERSION);
        assert_eq!(one::<String>(&conn, "PRAGMA journal_mode"), "wal");
        assert_eq!(one::<i64>(&conn, "PRAGMA foreign_keys"), 1);
        assert_eq!(one::<i64>(&conn, "PRAGMA busy_timeout"), 5000);
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE name IN ('entries', 'tags', 'entries_fts') ORDER BY name")
            .unwrap();
        let names: Vec<String> = stmt.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(names, ["entries", "entries_fts", "tags"]);
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM entries_fts"), 0, "stage 02 leaves the index empty");
    }

    #[test]
    fn opening_twice_migrates_once() {
        let path = db_in("db-twice");
        let first = open(&path).unwrap();
        first.execute(INSERT_A, []).unwrap();
        let second = open(&path).unwrap();
        assert_eq!(one::<i64>(&second, "PRAGMA user_version"), SCHEMA_VERSION);
        assert_eq!(one::<i64>(&second, "SELECT count(*) FROM entries"), 1, "the data survived");
    }

    #[test]
    fn a_database_from_a_newer_build_is_refused_and_left_alone() {
        let path = db_in("db-newer");
        {
            let conn = open(&path).unwrap();
            conn.execute(INSERT_A, []).unwrap();
            conn.execute_batch("PRAGMA user_version = 7;").unwrap();
        }
        let err = open(&path).unwrap_err();
        assert!(err.contains("newer couplet"), "{err}");
        let conn = Connection::open(&path).unwrap();
        assert_eq!(one::<i64>(&conn, "PRAGMA user_version"), 7);
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM entries"), 1);
    }

    #[test]
    fn deleting_an_entry_takes_its_tags() {
        let conn = open(&db_in("db-cascade")).unwrap();
        conn.execute(INSERT_A, []).unwrap();
        conn.execute("INSERT INTO tags (entry_id, tag) VALUES ('s1-0001', 'infra')", []).unwrap();
        conn.execute("DELETE FROM entries WHERE id = 's1-0001'", []).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM tags"), 0);
    }

    #[test]
    fn a_row_maps_every_column() {
        let conn = open(&db_in("db-row")).unwrap();
        conn.execute(INSERT_A, []).unwrap();
        let row = conn
            .query_row(&format!("SELECT {ENTRY_COLUMNS} FROM entries"), [], entry_row)
            .unwrap();
        assert_eq!(
            row,
            EntryRow {
                rowid: 1,
                id: "s1-0001".into(),
                kind: StashKind::Note,
                path: "/n/a.md".into(),
                title: "A".into(),
                repo: Some("proj".into()),
                created_at: 1,
                modified_at: 2,
                stashed_at: Some(3),
                opened_at: Some(4),
                deleted_at: None,
                caret: 5,
                top_line: 6,
            }
        );
    }

    #[test]
    fn the_schema_refuses_an_unknown_kind() {
        let conn = open(&db_in("db-kind")).unwrap();
        let bad = INSERT_A.replace("'note'", "'folder'");
        assert!(conn.execute(&bad, []).is_err());
    }
}
```

In `src-tauri/src/stash/mod.rs`: add `mod db;` to the module list (after `mod clock;`), and below `pub use paths::StashPaths;`:

```rust
use serde::{Deserialize, Serialize};

/// What an entry is: a note couplet owns, or a reference to the user's file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StashKind {
    Note,
    File,
}

impl StashKind {
    pub fn as_str(self) -> &'static str {
        match self {
            StashKind::Note => "note",
            StashKind::File => "file",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "note" => Some(StashKind::Note),
            "file" => Some(StashKind::File),
            _ => None,
        }
    }
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::db`
Expected: FAIL to compile — `cannot find function open`, `cannot find struct EntryRow`.

- [ ] **Step 3: Implement**

Prepend to `src-tauri/src/stash/db.rs`:

```rust
//! The stash database: opening it, its pragmas, forward-only migrations keyed
//! on `PRAGMA user_version`, and the row type. The app, the CLI and the MCP
//! server all open this file (stage 07), concurrently: WAL, a 5 s busy
//! timeout, and migrations that re-read the version under a write lock.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, Row, TransactionBehavior};

use super::StashKind;

pub(crate) const SCHEMA_VERSION: i64 = 1;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// `MIGRATIONS[i]` takes the schema from version `i` to `i + 1`. Append only:
/// a released migration is never edited, because databases that already ran
/// it will never run it again.
const MIGRATIONS: [&str; 1] = [V1];

/// Schema v1, exactly the roadmap's (its `PRAGMA` lines live in `configure`:
/// they are per connection, not per schema).
const V1: &str = "
CREATE TABLE entries (
  rowid        INTEGER PRIMARY KEY,
  id           TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL CHECK (kind IN ('note','file')),
  path         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  repo         TEXT,
  created_at   INTEGER NOT NULL,
  modified_at  INTEGER NOT NULL,
  stashed_at   INTEGER,
  opened_at    INTEGER,
  deleted_at   INTEGER,
  caret        INTEGER NOT NULL DEFAULT 0,
  top_line     INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE tags (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  PRIMARY KEY (entry_id, tag)
);
CREATE VIRTUAL TABLE entries_fts USING fts5(
  title, body,
  tokenize = 'trigram'
);
";

pub(crate) fn err(e: rusqlite::Error) -> String {
    format!("stash database: {e}")
}

/// Opens (creating if needed) and migrates the database at `path`.
pub(crate) fn open(path: &Path) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let mut conn = Connection::open(path).map_err(err)?;
    configure(&conn)?;
    migrate(&mut conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<(), String> {
    // First: switching to WAL takes a lock, which may have to wait.
    conn.busy_timeout(BUSY_TIMEOUT).map_err(err)?;
    let mode: String = conn
        .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
        .map_err(err)?;
    if !mode.eq_ignore_ascii_case("wal") {
        eprintln!("stash: journal_mode is {mode}, not wal — the app and the CLI will block each other more");
    }
    conn.execute_batch("PRAGMA foreign_keys = ON;").map_err(err)
}

fn user_version(conn: &Connection) -> Result<i64, String> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(err)
}

/// One step per transaction, the version read under the write lock: two
/// processes opening a fresh file at once must not both run `V1`.
pub(crate) fn migrate(conn: &mut Connection) -> Result<(), String> {
    loop {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let current = user_version(&tx)?;
        if current > SCHEMA_VERSION {
            return Err(format!(
                "stash.db has schema {current}, this build knows up to {SCHEMA_VERSION}: it was written by a newer couplet"
            ));
        }
        if current == SCHEMA_VERSION {
            return tx.commit().map_err(err);
        }
        let step = usize::try_from(current).map_err(|_| format!("stash.db has schema {current}"))?;
        tx.execute_batch(MIGRATIONS[step]).map_err(err)?;
        tx.execute_batch(&format!("PRAGMA user_version = {};", current + 1))
            .map_err(err)?;
        tx.commit().map_err(err)?;
    }
}

/// One `entries` row as stored. `title` is `''` for "no title".
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct EntryRow {
    pub rowid: i64,
    pub id: String,
    pub kind: StashKind,
    pub path: String,
    pub title: String,
    pub repo: Option<String>,
    pub created_at: i64,
    pub modified_at: i64,
    pub stashed_at: Option<i64>,
    pub opened_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub caret: i64,
    pub top_line: i64,
}

/// The column list `entry_row` reads, in its order.
pub(crate) const ENTRY_COLUMNS: &str =
    "rowid, id, kind, path, title, repo, created_at, modified_at, stashed_at, opened_at, deleted_at, caret, top_line";

pub(crate) fn entry_row(r: &Row<'_>) -> rusqlite::Result<EntryRow> {
    let kind: String = r.get(2)?;
    Ok(EntryRow {
        rowid: r.get(0)?,
        id: r.get(1)?,
        kind: StashKind::parse(&kind)
            .ok_or_else(|| rusqlite::Error::InvalidColumnType(2, "kind".into(), rusqlite::types::Type::Text))?,
        path: r.get(3)?,
        title: r.get(4)?,
        repo: r.get(5)?,
        created_at: r.get(6)?,
        modified_at: r.get(7)?,
        stashed_at: r.get(8)?,
        opened_at: r.get(9)?,
        deleted_at: r.get(10)?,
        caret: r.get(11)?,
        top_line: r.get(12)?,
    })
}

/// Every entry's tags, alphabetical, keyed by entry id.
pub(crate) fn all_tags(conn: &Connection) -> Result<HashMap<String, Vec<String>>, String> {
    let mut stmt = conn
        .prepare("SELECT entry_id, tag FROM tags ORDER BY entry_id, tag")
        .map_err(err)?;
    let pairs = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for (id, tag) in pairs {
        out.entry(id).or_default().push(tag);
    }
    Ok(out)
}
```

- [ ] **Step 4: Run the tests**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::db`
Expected: PASS, `6 passed`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/stash/db.rs src-tauri/src/stash/mod.rs
git commit -m "$(cat <<'EOF'
feat(stash): database with schema v1 and forward-only migrations

WAL, foreign keys, 5 s busy timeout; user_version re-read under an
IMMEDIATE lock so the app and the CLI cannot both run V1; a newer schema
is refused and left untouched. The FTS5 table exists and stays empty.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `Stash`, `StashEntry`, creating a note, reading an entry

**Files:**
- Modify: `src-tauri/src/git_info.rs` (`repo_info`)
- Create: `src-tauri/src/stash/entries.rs`
- Modify: `src-tauri/src/stash/mod.rs` (types, `Stash`, test kit)

- [ ] **Step 1: Write the failing `git_info` tests**

Add to the `tests` module of `src-tauri/src/git_info.rs`:

```rust
    #[test]
    fn repo_info_is_the_toplevel_inside_a_repository() {
        let root = scratch("repo-info").join("couplet");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/HEAD"), "ref: refs/heads/feat/stash\n").unwrap();
        assert_eq!(
            repo_info(&root.join("docs/plan.md")),
            Some(GitInfo { project: "couplet".into(), branch: Some("feat/stash".into()) })
        );
    }

    #[test]
    fn repo_info_is_none_outside_a_repository_where_git_info_falls_back() {
        let dir = scratch("repo-info-none").join("loose");
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(repo_info(&dir.join("a.md")), None, "no repo tag for a loose file");
        assert_eq!(
            git_info(&dir.join("a.md")),
            Some(GitInfo { project: "loose".into(), branch: None }),
            "the drawer's grey line is unchanged"
        );
    }
```

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml git_info::`
Expected: FAIL to compile — `cannot find function repo_info`.

- [ ] **Step 2: Implement `repo_info`**

In `src-tauri/src/git_info.rs`, replace the body of `pub fn git_info` and add `repo_info` above it:

```rust
/// `git_info` only for a file inside a repository. The stash's repo tag for a
/// file reference is "the git toplevel"; a loose file has none — unlike a
/// drawer card, whose grey line falls back to the file's folder.
pub fn repo_info(file: &Path) -> Option<GitInfo> {
    if !is_acceptable(file) {
        return None;
    }
    let (toplevel, dot_git) = find_dot_git(file)?;
    let branch = resolve_git_dir(&toplevel, &dot_git)
        .and_then(|dir| read_small(&dir.join("HEAD")))
        .and_then(|head| branch_from_head(&head));
    Some(GitInfo { project: dir_name(&toplevel), branch })
}

pub fn git_info(file: &Path) -> Option<GitInfo> {
    if !is_acceptable(file) {
        return None;
    }
    let parent = file.parent().filter(|p| !p.as_os_str().is_empty())?;
    repo_info(file).or_else(|| Some(GitInfo { project: dir_name(parent), branch: None }))
}
```

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml git_info::`
Expected: PASS — every existing `git_info` test plus the two new ones.

- [ ] **Step 3: Write the failing stash tests**

Create `src-tauri/src/stash/entries.rs` with only the tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::atomic_write::testkit::scratch;
    use crate::stash::testkit::*;

    #[test]
    fn creating_a_note_writes_its_file_and_its_entry() {
        let (mut stash, root) = stash_in("create");
        let e = stash
            .create_note("# Список покупок\n- молоко\n", Some("/Users/u/src/couplet"), T0, MSK)
            .unwrap();
        assert_eq!(e.kind, StashKind::Note);
        assert_eq!(e.title.as_deref(), Some("Список покупок"));
        assert_eq!((e.repo.as_deref(), e.branch.as_deref()), (Some("couplet"), None));
        let notes = crate::path_norm::normalize_path(&root.join("Documents/couplet-test"));
        assert!(Path::new(&e.path).starts_with(&notes), "{} not under {}", e.path, notes.display());
        let name = Path::new(&e.path).file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("2026-09-26-0215-") && name.ends_with(".md"), "{name}");
        assert_eq!(fs::read_to_string(&e.path).unwrap(), "# Список покупок\n- молоко\n");
        assert_eq!((e.created_at, e.modified_at), (T0, T0));
        assert_eq!((e.stashed_at, e.opened_at, e.deleted_at), (None, None, None), "open, not put away");
        assert_eq!((e.caret, e.top_line), (0, 1));
        assert!(e.tags.is_empty());
        assert_eq!(e.preview, "# Список покупок\n- молоко\n");
        assert_eq!(stash.get(&e.id).unwrap(), e);
    }

    #[test]
    fn a_blank_note_is_refused_and_creates_nothing() {
        let (mut stash, root) = stash_in("blank");
        assert!(stash.create_note(" \n\t", None, T0, MSK).is_err());
        assert!(!root.join("Documents").exists());
        assert_eq!(rows(&stash, "entries"), 0);
    }

    #[test]
    fn opening_the_stash_does_not_touch_the_documents_folder() {
        let (_stash, root) = stash_in("tcc");
        assert!(root.join("data/stash.db").exists());
        assert!(!root.join("Documents").exists(), "no TCC prompt at launch");
    }

    #[test]
    fn an_unknown_id_is_an_error() {
        let (stash, _root) = stash_in("unknown");
        assert_eq!(stash.get("s1-dead").unwrap_err(), "no stash entry s1-dead");
    }

    #[test]
    fn repo_names_meet_in_one_spelling() {
        assert_eq!(normalize_repo(None), None);
        assert_eq!(normalize_repo(Some("  ")), None);
        assert_eq!(normalize_repo(Some("/Users/u/src/couplet")).as_deref(), Some("couplet"));
        assert_eq!(normalize_repo(Some("/Users/u/src/couplet/")).as_deref(), Some("couplet"));
        assert_eq!(normalize_repo(Some(" couplet ")).as_deref(), Some("couplet"));
        assert_eq!(normalize_repo(Some("/")), None);
    }

    #[test]
    fn a_preview_is_the_first_400_characters_and_never_fails() {
        let dir = scratch("preview");
        let long = dir.join("long.md");
        fs::write(&long, "ж".repeat(1000)).unwrap();
        assert_eq!(read_preview(&long), "ж".repeat(PREVIEW_CHARS));

        let split = dir.join("split.md");
        fs::write(&split, format!("a{}", "ж".repeat(1000))).unwrap();
        assert_eq!(read_preview(&split), format!("a{}", "ж".repeat(PREVIEW_CHARS - 1)), "a character cut by the read limit is dropped");

        let crlf = dir.join("crlf.md");
        fs::write(&crlf, "a\r\nb").unwrap();
        assert_eq!(read_preview(&crlf), "a\nb");

        let binary = dir.join("bin.md");
        fs::write(&binary, [0xff_u8, 0xfe, 0x00]).unwrap();
        assert_eq!(read_preview(&binary), "");
        assert_eq!(read_preview(&dir.join("missing.md")), "");
        assert_eq!(read_preview(&dir), "", "a directory");
    }
}
```

In `src-tauri/src/stash/mod.rs`: add `mod entries;` to the module list (after `mod db;`); replace the `use serde::{Deserialize, Serialize};` line with

```rust
use std::fs;
use std::path::PathBuf;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
```

and add below `impl StashKind { … }`:

```rust
/// One stash entry as the frontend and agents see it (roadmap `StashEntry`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub id: String,
    pub kind: StashKind,
    pub path: String,
    /// `None` → the UI's localized «Без названия».
    pub title: Option<String>,
    /// Notes: the stored window project name. Files: derived git toplevel name.
    pub repo: Option<String>,
    /// Files only, derived at read time.
    pub branch: Option<String>,
    /// Without `#`, alphabetical; the repo tag is not one of them.
    pub tags: Vec<String>,
    pub created_at: i64,
    pub modified_at: i64,
    pub stashed_at: Option<i64>,
    pub opened_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub caret: i64,
    pub top_line: i64,
    /// First ~400 characters of the text; `""` when unreadable.
    pub preview: String,
}

/// The stash: one database connection and where things live. Synchronous and
/// clock-free — callers pass `now` — so every behaviour is a plain unit test.
pub struct Stash {
    conn: Connection,
    paths: StashPaths,
    notes_dir_ready: bool,
}

impl Stash {
    /// Opens the database. Touches only the app data directory (plan D2).
    pub fn open(paths: StashPaths) -> Result<Self, String> {
        let conn = db::open(&paths.db_path)?;
        Ok(Self { conn, paths, notes_dir_ready: false })
    }

    /// The notes folder, created and put in its one spelling
    /// (`path_norm`, the spelling `OpenFiles` and the `path` column use) the
    /// first time anything needs it.
    fn notes_dir(&mut self) -> Result<PathBuf, String> {
        if !self.notes_dir_ready {
            fs::create_dir_all(&self.paths.notes_dir)
                .map_err(|e| format!("cannot create {}: {e}", self.paths.notes_dir.display()))?;
            self.paths = self
                .paths
                .with_notes_dir(crate::path_norm::normalize_path(&self.paths.notes_dir));
            self.notes_dir_ready = true;
        }
        Ok(self.paths.notes_dir.clone())
    }
}

#[cfg(test)]
pub(crate) mod testkit {
    use super::*;
    use std::path::Path;

    /// 2026-09-26 02:15 in Moscow (+03:00).
    pub(crate) const T0: i64 = 1_790_378_100_000;
    pub(crate) const MSK: i64 = 10_800;

    pub(crate) fn paths_in(root: &Path) -> StashPaths {
        StashPaths::from_bases(&root.join("Documents"), &root.join("data"), "couplet-test")
    }

    pub(crate) fn stash_in(tag: &str) -> (Stash, PathBuf) {
        let root = crate::atomic_write::testkit::scratch(&format!("stash-{tag}"));
        (Stash::open(paths_in(&root)).unwrap(), root)
    }

    /// A user's file outside the notes folder, in its normalized spelling.
    pub(crate) fn user_file(root: &Path, rel: &str, text: &str) -> String {
        let path = root.join("work").join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
        crate::path_norm::normalize_str(&path.to_string_lossy())
    }

    pub(crate) fn rows(stash: &Stash, table: &str) -> i64 {
        stash
            .conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    /// Sets columns of one entry directly, for tests that need exact times.
    pub(crate) fn set_columns(stash: &Stash, id: &str, assignments: &str) {
        stash
            .conn
            .execute(&format!("UPDATE entries SET {assignments} WHERE id = ?1"), [id])
            .unwrap();
    }
}
```

- [ ] **Step 4: Run them to see them fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::entries`
Expected: FAIL to compile — `no method named create_note`, `cannot find function normalize_repo`, `read_preview`.

- [ ] **Step 5: Implement**

Prepend to `src-tauri/src/stash/entries.rs`:

```rust
//! Entries: creating notes, reading, putting away, tags, list and counts.
//! Every multi-row change is one `BEGIN IMMEDIATE` transaction (roadmap).

use std::fs::{self, OpenOptions};
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::db::{self, EntryRow, ENTRY_COLUMNS};
use super::{ids, notes, Stash, StashEntry, StashKind};

/// Preview length in characters (roadmap: "first ~400 chars").
pub(crate) const PREVIEW_CHARS: usize = 400;
/// Bytes read for a preview: 400 characters of up to 4 UTF-8 bytes each.
const PREVIEW_BYTES: u64 = (PREVIEW_CHARS * 4) as u64;
const ID_ATTEMPTS: usize = 8;

/// The repo tag as the stash stores and filters it: a project's directory
/// name. A window knows its project as an absolute root, `git_info` gives a
/// file's as a name; both meet here (plan D1).
pub(crate) fn normalize_repo(repo: Option<&str>) -> Option<String> {
    let repo = repo?.trim();
    if repo.is_empty() {
        return None;
    }
    if repo.contains('/') {
        let name = crate::git_info::dir_name(Path::new(repo.trim_end_matches('/')));
        return (!name.is_empty()).then_some(name);
    }
    Some(repo.to_string())
}

/// The first `PREVIEW_CHARS` characters of a regular file, `""` for anything
/// unreadable, not a regular file, or not UTF-8. Checked and opened like
/// `git_info::read_small`: a FIFO or a device must not hang a listing.
pub(crate) fn read_preview(path: &Path) -> String {
    if !fs::metadata(path).is_ok_and(|m| m.is_file()) {
        return String::new();
    }
    let Ok(file) = OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(path) else {
        return String::new();
    };
    if !file.metadata().is_ok_and(|m| m.is_file()) {
        return String::new();
    }
    let mut bytes = Vec::new();
    if file.take(PREVIEW_BYTES).read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text,
        // Cut inside the last character by the read limit: keep what came before it.
        Err(e) if e.error_len().is_none() => std::str::from_utf8(&bytes[..e.valid_up_to()]).unwrap_or(""),
        Err(_) => return String::new(),
    };
    text.replace("\r\n", "\n").chars().take(PREVIEW_CHARS).collect()
}

/// A fresh id not yet in `entries`, checked inside the caller's transaction.
fn unique_id(conn: &Connection) -> Result<String, String> {
    for _ in 0..ID_ATTEMPTS {
        let id = ids::new_id();
        let taken = conn
            .query_row("SELECT 1 FROM entries WHERE id = ?1", [&id], |_| Ok(()))
            .optional()
            .map_err(db::err)?
            .is_some();
        if !taken {
            return Ok(id);
        }
    }
    Err("could not pick a free stash id".to_string())
}

/// `(repo, branch)` as the entry shows them: stored for a note, derived from
/// the file's repository for a file reference.
fn derived_repo(row: &EntryRow) -> (Option<String>, Option<String>) {
    match row.kind {
        StashKind::Note => (row.repo.clone(), None),
        StashKind::File => match crate::git_info::repo_info(Path::new(&row.path)) {
            Some(info) => (Some(info.project), info.branch),
            None => (None, None),
        },
    }
}

fn entry_from(row: EntryRow, tags: Vec<String>, repo: Option<String>, branch: Option<String>, preview: String) -> StashEntry {
    StashEntry {
        title: (!row.title.is_empty()).then_some(row.title),
        id: row.id,
        kind: row.kind,
        path: row.path,
        repo,
        branch,
        tags,
        created_at: row.created_at,
        modified_at: row.modified_at,
        stashed_at: row.stashed_at,
        opened_at: row.opened_at,
        deleted_at: row.deleted_at,
        caret: row.caret,
        top_line: row.top_line,
        preview,
    }
}

impl Stash {
    /// A new note: its file in the notes folder, then its entry. Not put away
    /// (`stashed_at` is NULL): the note is open in the tab that typed it.
    pub fn create_note(&mut self, text: &str, repo: Option<&str>, now: i64, offset_secs: i64) -> Result<StashEntry, String> {
        if text.trim().is_empty() {
            return Err("a note needs text".to_string());
        }
        let dir = self.notes_dir()?;
        // If the insert below fails, the file stays: it holds the human's text.
        let path = notes::create_note_file(&dir, text, now, offset_secs, ids::random16)?;
        let path = path.to_string_lossy().into_owned();
        let title = notes::title_of(text).unwrap_or_default();
        let repo = normalize_repo(repo);
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db::err)?;
        let id = unique_id(&tx)?;
        tx.execute(
            "INSERT INTO entries (id, kind, path, title, repo, created_at, modified_at) \
             VALUES (?1, 'note', ?2, ?3, ?4, ?5, ?5)",
            params![id, path, title, repo, now],
        )
        .map_err(db::err)?;
        tx.commit().map_err(db::err)?;
        self.get(&id)
    }

    pub fn get(&self, id: &str) -> Result<StashEntry, String> {
        let row = self
            .conn
            .query_row(&format!("SELECT {ENTRY_COLUMNS} FROM entries WHERE id = ?1"), [id], db::entry_row)
            .optional()
            .map_err(db::err)?
            .ok_or_else(|| format!("no stash entry {id}"))?;
        let tags = self.tags_of(&row.id)?;
        let (repo, branch) = derived_repo(&row);
        let preview = read_preview(Path::new(&row.path));
        Ok(entry_from(row, tags, repo, branch, preview))
    }

    fn tags_of(&self, id: &str) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT tag FROM tags WHERE entry_id = ?1 ORDER BY tag")
            .map_err(db::err)?;
        let tags = stmt
            .query_map([id], |r| r.get(0))
            .map_err(db::err)?
            .collect::<Result<Vec<String>, _>>()
            .map_err(db::err)?;
        Ok(tags)
    }
}
```

- [ ] **Step 6: Run the tests**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::entries`
Expected: PASS, `6 passed`.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/git_info.rs src-tauri/src/stash/entries.rs src-tauri/src/stash/mod.rs
git commit -m "$(cat <<'EOF'
feat(stash): Stash, StashEntry, create a note, read an entry

Notes are created lazily in ~/Documents/<product>/ (no TCC prompt at
launch); file references get repo/branch from git_info::repo_info at read
time; previews are the first 400 characters, never an error.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: put away — dedup by normalized path, merged tags

**Files:**
- Modify: `src-tauri/src/stash/entries.rs`
- Modify: `src-tauri/src/stash/mod.rs` (`PutAway`, `PutAwayResult`)

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `src-tauri/src/stash/entries.rs` (and `use crate::stash::PutAway;` at its top):

```rust
    fn put(paths: Vec<String>) -> PutAway {
        PutAway { paths, ..PutAway::default() }
    }

    #[test]
    fn putting_away_a_file_creates_a_reference() {
        let (mut stash, root) = stash_in("put-file");
        let file = user_file(&root, "plan.md", "# План\n");
        let req = PutAway { paths: vec![file.clone()], caret: Some(7), top_line: Some(3), tags: vec!["#Infra".into(), "infra".into()] };
        let r = stash.put_away(&req, T0).unwrap();
        assert_eq!(r.len(), 1);
        assert!(r[0].created);
        let e = &r[0].entry;
        assert_eq!((e.kind, e.path.as_str(), e.title.as_deref()), (StashKind::File, file.as_str(), Some("plan.md")));
        assert_eq!((e.stashed_at, e.created_at), (Some(T0), T0));
        assert_eq!((e.caret, e.top_line), (7, 3));
        assert_eq!(e.tags, vec!["infra"]);
        assert_eq!(e.repo, None, "a loose file has no repo tag");
        assert_eq!(e.preview, "# План\n");
    }

    #[test]
    fn putting_away_again_is_a_dedup_hit() {
        let (mut stash, root) = stash_in("dedup");
        let file = user_file(&root, "todo.md", "todo");
        let first = stash
            .put_away(&PutAway { paths: vec![file.clone()], caret: Some(1), top_line: Some(3), tags: vec!["a".into()] }, T0)
            .unwrap();
        let again = stash
            .put_away(&PutAway { paths: vec![file], caret: Some(9), top_line: None, tags: vec!["B".into()] }, T0 + 60_000)
            .unwrap();
        assert!(!again[0].created, "a second put-away is a dedup hit");
        let e = &again[0].entry;
        assert_eq!(e.id, first[0].entry.id);
        assert_eq!(e.stashed_at, Some(T0 + 60_000), "raised to the top");
        assert_eq!(e.tags, vec!["a", "b"], "tags merged");
        assert_eq!((e.caret, e.top_line), (9, 3), "caret updated, an absent topLine kept");
        assert_eq!(e.created_at, T0);
        assert_eq!(rows(&stash, "entries"), 1);
    }

    #[test]
    fn two_spellings_of_one_file_are_one_entry() {
        let (mut stash, root) = stash_in("alias");
        let real = root.join("work/real");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("a.md"), "a").unwrap();
        std::os::unix::fs::symlink(&real, root.join("work/link")).unwrap();
        let via_link = root.join("work/link/a.md").to_string_lossy().into_owned();
        let via_dots = root.join("work/real/./a.md").to_string_lossy().into_owned();
        let first = stash.put_away(&put(vec![via_link]), T0).unwrap();
        let second = stash.put_away(&put(vec![via_dots]), T0 + 1).unwrap();
        assert!(first[0].created && !second[0].created);
        assert_eq!(first[0].entry.id, second[0].entry.id);
        assert_eq!(rows(&stash, "entries"), 1);
    }

    #[test]
    fn putting_away_a_note_keeps_its_entry() {
        let (mut stash, _root) = stash_in("put-note");
        let note = stash.create_note("# Идея", Some("couplet"), T0, MSK).unwrap();
        let req = PutAway { paths: vec![note.path.clone()], caret: Some(4), top_line: Some(1), tags: vec![] };
        let r = stash.put_away(&req, T0 + 5).unwrap();
        assert!(!r[0].created);
        let e = &r[0].entry;
        assert_eq!((e.id.as_str(), e.kind, e.repo.as_deref()), (note.id.as_str(), StashKind::Note, Some("couplet")));
        assert_eq!((e.stashed_at, e.caret), (Some(T0 + 5), 4));
    }

    #[test]
    fn a_file_in_the_notes_folder_is_a_note() {
        let (mut stash, _root) = stash_in("note-folder");
        let path = stash.notes_dir().unwrap().join("hand-made.md");
        fs::write(&path, "- [ ] позвонить\n").unwrap();
        let r = stash.put_away(&put(vec![path.to_string_lossy().into_owned()]), T0).unwrap();
        assert_eq!(r[0].entry.kind, StashKind::Note);
        assert_eq!(r[0].entry.title.as_deref(), Some("позвонить"));
    }

    #[test]
    fn one_bad_path_rolls_the_whole_request_back() {
        let (mut stash, root) = stash_in("rollback");
        let good = user_file(&root, "good.md", "g");
        let err = stash.put_away(&put(vec![good.clone(), "relative.md".into()]), T0).unwrap_err();
        assert!(err.contains("absolute"), "{err}");
        let missing = root.join("work/missing.md").to_string_lossy().into_owned();
        assert!(stash.put_away(&put(vec![good, missing]), T0).is_err());
        assert_eq!(rows(&stash, "entries"), 0, "all or nothing");
    }

    #[test]
    fn a_caret_with_several_paths_is_refused() {
        let (mut stash, root) = stash_in("caret-many");
        let a = user_file(&root, "a.md", "a");
        let b = user_file(&root, "b.md", "b");
        let req = PutAway { paths: vec![a, b], caret: Some(1), ..PutAway::default() };
        assert!(stash.put_away(&req, T0).is_err());
        assert_eq!(rows(&stash, "entries"), 0);
    }

    #[test]
    fn a_directory_is_not_put_away() {
        let (mut stash, root) = stash_in("dir");
        let dir = root.join("work/folder");
        fs::create_dir_all(&dir).unwrap();
        let err = stash.put_away(&put(vec![dir.to_string_lossy().into_owned()]), T0).unwrap_err();
        assert!(err.contains("not a file"), "{err}");
    }

    #[test]
    fn tags_have_one_spelling() {
        assert_eq!(normalize_tag("#Infra").unwrap().as_deref(), Some("infra"));
        assert_eq!(normalize_tag("  ИНФРА ").unwrap().as_deref(), Some("инфра"));
        assert_eq!(normalize_tag("##x").unwrap().as_deref(), Some("x"));
        assert_eq!(normalize_tag("#").unwrap(), None);
        assert_eq!(normalize_tag("").unwrap(), None);
        assert!(normalize_tag("two words").is_err());
        assert!(normalize_tag(&"t".repeat(TAG_MAX_CHARS + 1)).is_err());
        assert_eq!(normalize_tags(&["A".into(), "#a".into(), "b".into()]).unwrap(), vec!["a", "b"]);
    }
```

In `src-tauri/src/stash/mod.rs`, below `StashEntry`:

```rust
/// `stash_put_away`'s arguments.
#[derive(Clone, Debug, Default)]
pub struct PutAway {
    pub paths: Vec<String>,
    /// Only with exactly one path.
    pub caret: Option<i64>,
    /// Only with exactly one path.
    pub top_line: Option<i64>,
    pub tags: Vec<String>,
}

/// One put-away path's outcome. `created == false`: it was already in the
/// stash (dedup hit) and was raised, re-tagged and re-positioned instead.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PutAwayResult {
    pub entry: StashEntry,
    pub created: bool,
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::entries`
Expected: FAIL to compile — `no method named put_away`, `cannot find function normalize_tag`.

- [ ] **Step 3: Implement**

In `src-tauri/src/stash/entries.rs`: change the `use super::{…}` line to

```rust
use super::{ids, notes, PutAway, PutAwayResult, Stash, StashEntry, StashKind};
```

add `use std::time::UNIX_EPOCH;` to the std imports, and add below `ID_ATTEMPTS`:

```rust
/// Longest tag, in characters.
pub(crate) const TAG_MAX_CHARS: usize = 64;

/// A tag as stored: trimmed, without leading `#`, lower-case. `Ok(None)` for
/// nothing left; an error for whitespace inside (a `#tag` query could never
/// find it) or an absurd length (plan D8).
pub(crate) fn normalize_tag(raw: &str) -> Result<Option<String>, String> {
    let tag = raw.trim().trim_start_matches('#').trim();
    if tag.is_empty() {
        return Ok(None);
    }
    if tag.chars().any(char::is_whitespace) {
        return Err(format!("a tag cannot contain spaces: {raw:?}"));
    }
    if tag.chars().count() > TAG_MAX_CHARS {
        return Err(format!("a tag is at most {TAG_MAX_CHARS} characters: {raw:?}"));
    }
    Ok(Some(tag.to_lowercase()))
}

/// `normalize_tag` over a list, empties dropped, duplicates collapsed in order.
pub(crate) fn normalize_tags(raw: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for r in raw {
        if let Some(tag) = normalize_tag(r)? {
            if !out.contains(&tag) {
                out.push(tag);
            }
        }
    }
    Ok(out)
}

fn file_title(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// A path not yet in the stash becomes an entry: a note when it lies in the
/// notes folder, a file reference otherwise (plan D5, D18).
fn insert_new(tx: &Connection, path: &str, notes_dir: &Path, req: &PutAway, now: i64) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| format!("cannot put away {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("cannot put away {path}: not a file"));
    }
    let kind = if Path::new(path).starts_with(notes_dir) { StashKind::Note } else { StashKind::File };
    let title = match kind {
        StashKind::Note => fs::read_to_string(path).ok().and_then(|t| notes::title_of(&t)).unwrap_or_default(),
        StashKind::File => file_title(path),
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(now);
    let id = unique_id(tx)?;
    tx.execute(
        "INSERT INTO entries (id, kind, path, title, repo, created_at, modified_at, stashed_at, caret, top_line) \
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?5, ?7, ?8)",
        params![id, kind.as_str(), path, title, now, modified, req.caret.unwrap_or(0), req.top_line.unwrap_or(1)],
    )
    .map_err(db::err)?;
    Ok(id)
}
```

Add inside `impl Stash`:

```rust
    /// Puts documents away: new ones become entries, ones already in the stash
    /// are raised (`stashed_at = now`), re-tagged (union) and re-positioned.
    /// Paths are normalized here — the dedup key is `path_norm`'s spelling —
    /// and the whole request is one transaction (plan D4).
    pub fn put_away(&mut self, req: &PutAway, now: i64) -> Result<Vec<PutAwayResult>, String> {
        if req.paths.len() > 1 && (req.caret.is_some() || req.top_line.is_some()) {
            return Err("caret and topLine belong to a single path".to_string());
        }
        let tags = normalize_tags(&req.tags)?;
        let paths: Vec<String> = req.paths.iter().map(|p| crate::path_norm::normalize_str(p)).collect();
        let notes_dir = self.notes_dir()?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db::err)?;
        let mut done: Vec<(String, bool)> = Vec::with_capacity(paths.len());
        for path in &paths {
            if !Path::new(path).is_absolute() {
                return Err(format!("path must be absolute: {path}"));
            }
            let existing: Option<String> = tx
                .query_row("SELECT id FROM entries WHERE path = ?1", [path], |r| r.get(0))
                .optional()
                .map_err(db::err)?;
            let (id, created) = match existing {
                Some(id) => {
                    tx.execute(
                        "UPDATE entries SET stashed_at = ?1, caret = COALESCE(?2, caret), \
                         top_line = COALESCE(?3, top_line) WHERE id = ?4",
                        params![now, req.caret, req.top_line, id],
                    )
                    .map_err(db::err)?;
                    (id, false)
                }
                None => (insert_new(&tx, path, &notes_dir, req, now)?, true),
            };
            for tag in &tags {
                tx.execute("INSERT OR IGNORE INTO tags (entry_id, tag) VALUES (?1, ?2)", params![id, tag])
                    .map_err(db::err)?;
            }
            done.push((id, created));
        }
        tx.commit().map_err(db::err)?;
        done.into_iter()
            .map(|(id, created)| Ok(PutAwayResult { entry: self.get(&id)?, created }))
            .collect()
    }
```

- [ ] **Step 4: Run the tests**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::entries`
Expected: PASS, `15 passed`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/stash/entries.rs src-tauri/src/stash/mod.rs
git commit -m "$(cat <<'EOF'
feat(stash): put away with dedup by normalized path

One entry per document: a second put-away raises it, merges tags and
updates the caret (created=false). The whole request is one IMMEDIATE
transaction; tags are lower-case without '#'.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: tags, touch-opened, the save hook's update

**Files:**
- Modify: `src-tauri/src/stash/entries.rs`

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `src-tauri/src/stash/entries.rs`:

```rust
    #[test]
    fn tags_are_added_and_removed_in_one_spelling() {
        let (mut stash, _root) = stash_in("tag");
        let note = stash.create_note("x", None, T0, MSK).unwrap();
        let e = stash.tag(&note.id, &["#Infra".into(), "ИДЕИ".into()], &[]).unwrap();
        assert_eq!(e.tags, vec!["infra", "идеи"]);
        let e = stash.tag(&note.id, &["later".into()], &["#INFRA".into()]).unwrap();
        assert_eq!(e.tags, vec!["later", "идеи"]);
        assert!(stash.tag(&note.id, &["two words".into()], &[]).is_err());
        assert_eq!(stash.get(&note.id).unwrap().tags, vec!["later", "идеи"], "a refused call changes nothing");
    }

    #[test]
    fn remove_wins_over_add_in_one_call() {
        let (mut stash, _root) = stash_in("tag-both");
        let note = stash.create_note("x", None, T0, MSK).unwrap();
        let e = stash.tag(&note.id, &["x".into()], &["x".into()]).unwrap();
        assert!(e.tags.is_empty());
    }

    #[test]
    fn tagging_an_unknown_entry_is_an_error() {
        let (mut stash, _root) = stash_in("tag-unknown");
        assert_eq!(stash.tag("s1-dead", &["a".into()], &[]).unwrap_err(), "no stash entry s1-dead");
        assert_eq!(rows(&stash, "tags"), 0);
    }

    #[test]
    fn opening_from_the_stash_is_remembered() {
        let (mut stash, root) = stash_in("opened");
        let file = user_file(&root, "a.md", "a");
        let id = stash.put_away(&put(vec![file.clone()]), T0).unwrap().remove(0).entry.id;
        assert!(stash.touch_opened(&file, T0 + 10).unwrap());
        assert_eq!(stash.get(&id).unwrap().opened_at, Some(T0 + 10));
        let other = root.join("work/other.md").to_string_lossy().into_owned();
        assert!(!stash.touch_opened(&other, T0).unwrap(), "not a stash entry");
    }

    #[test]
    fn saving_a_note_updates_its_title_and_time() {
        let (mut stash, _root) = stash_in("written");
        let note = stash.create_note("# Old", None, T0, MSK).unwrap();
        assert!(stash.file_written(&note.path, "# New\nbody", T0 + 10).unwrap(), "title changed");
        let e = stash.get(&note.id).unwrap();
        assert_eq!((e.title.as_deref(), e.modified_at), (Some("New"), T0 + 10));
        assert!(!stash.file_written(&note.path, "# New\nmore body", T0 + 20).unwrap(), "same title: no event");
        assert_eq!(stash.get(&note.id).unwrap().modified_at, T0 + 20);
        assert!(!stash.file_written(&note.path, "# Stale", T0 + 15).unwrap(), "an older save landing late changes nothing");
        let e = stash.get(&note.id).unwrap();
        assert_eq!((e.title.as_deref(), e.modified_at), (Some("New"), T0 + 20));
    }

    #[test]
    fn saving_a_file_reference_keeps_its_file_name_as_title() {
        let (mut stash, root) = stash_in("written-file");
        let file = user_file(&root, "readme.md", "# Heading");
        let id = stash.put_away(&put(vec![file.clone()]), T0).unwrap().remove(0).entry.id;
        assert!(!stash.file_written(&file, "# Another heading", Y2100).unwrap());
        let e = stash.get(&id).unwrap();
        assert_eq!(e.title.as_deref(), Some("readme.md"));
        assert_eq!(e.modified_at, Y2100);
    }

    /// 2100-01-01: later than any real mtime `put_away` records.
    const Y2100: i64 = 4_102_444_800_000;

    #[test]
    fn saving_a_file_outside_the_stash_changes_nothing() {
        let (mut stash, root) = stash_in("written-none");
        let file = user_file(&root, "x.md", "x");
        assert!(!stash.file_written(&file, "y", T0).unwrap());
        assert_eq!(rows(&stash, "entries"), 0);
    }
```

(`put_away` records a file reference's real mtime as `modified_at`, which is later than `T0`; hence `Y2100`.)

- [ ] **Step 2: Run them to see them fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::entries`
Expected: FAIL to compile — `no method named tag`, `touch_opened`, `file_written`.

- [ ] **Step 3: Implement**

Add inside `impl Stash` in `src-tauri/src/stash/entries.rs`:

```rust
    /// Adds then removes tags (so a tag in both lists ends up absent).
    pub fn tag(&mut self, id: &str, add: &[String], remove: &[String]) -> Result<StashEntry, String> {
        let add = normalize_tags(add)?;
        let remove = normalize_tags(remove)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db::err)?;
        let exists = tx
            .query_row("SELECT 1 FROM entries WHERE id = ?1", [id], |_| Ok(()))
            .optional()
            .map_err(db::err)?
            .is_some();
        if !exists {
            return Err(format!("no stash entry {id}"));
        }
        for tag in &add {
            tx.execute("INSERT OR IGNORE INTO tags (entry_id, tag) VALUES (?1, ?2)", params![id, tag])
                .map_err(db::err)?;
        }
        for tag in &remove {
            tx.execute("DELETE FROM tags WHERE entry_id = ?1 AND tag = ?2", params![id, tag])
                .map_err(db::err)?;
        }
        tx.commit().map_err(db::err)?;
        self.get(id)
    }

    /// Records that a document was opened from the stash. `false` when the
    /// path is not a stash entry (opening any other file is not stash news).
    pub fn touch_opened(&mut self, path: &str, now: i64) -> Result<bool, String> {
        let path = crate::path_norm::normalize_str(path);
        let changed = self
            .conn
            .execute("UPDATE entries SET opened_at = ?1 WHERE path = ?2", params![now, path])
            .map_err(db::err)?;
        Ok(changed > 0)
    }

    /// The save hook's work: a stash entry's `modified_at`, and a note's title.
    /// `path` is the spelling the editor saved under — already the registry's
    /// normalized one. Only moves forward in time, so a late, older save cannot
    /// roll a title back (plan D9). `true` when the title changed.
    pub fn file_written(&mut self, path: &str, text: &str, now: i64) -> Result<bool, String> {
        let row: Option<(String, String)> = self
            .conn
            .query_row("SELECT kind, title FROM entries WHERE path = ?1", [path], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(db::err)?;
        let Some((kind, old_title)) = row else {
            return Ok(false);
        };
        let title = if kind == StashKind::Note.as_str() {
            notes::title_of(text).unwrap_or_default()
        } else {
            old_title.clone()
        };
        let changed = self
            .conn
            .execute(
                "UPDATE entries SET modified_at = ?1, title = ?2 WHERE path = ?3 AND modified_at <= ?1",
                params![now, title, path],
            )
            .map_err(db::err)?;
        Ok(changed > 0 && title != old_title)
    }
```

- [ ] **Step 4: Run the tests**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::entries`
Expected: PASS, `22 passed`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/stash/entries.rs
git commit -m "$(cat <<'EOF'
feat(stash): tags, opened-from-stash time, save-hook update

file_written only moves forward in time and reports a title change, so
the hook can stay quiet on the 300 ms autosave cadence.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: list and counts

**Files:**
- Modify: `src-tauri/src/stash/entries.rs`
- Modify: `src-tauri/src/stash/mod.rs` (`ListSort`, `ListQuery`, `ListResult`, `StashCounts`)

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `src-tauri/src/stash/entries.rs` (and `use crate::stash::{ListQuery, ListResult, ListSort, StashCounts};` at its top):

```rust
    struct Seeded {
        a: String,
        b: String,
        c: String,
        d: String,
        e: String,
    }

    /// a: note (repo couplet), b: file in a git repo "couplet", c: note (repo
    /// other, #infra), d: loose file, e: deleted note (repo couplet). Times are
    /// set directly: changed = a 100, b 300, c 500, d 600.
    fn seed(stash: &mut Stash, root: &Path) -> Seeded {
        let a = stash.create_note("# A", Some("/src/couplet"), T0, MSK).unwrap().id;
        let repo = root.join("work/couplet");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::write(repo.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let b = stash.put_away(&put(vec![user_file(root, "couplet/b.md", "b")]), T0).unwrap().remove(0).entry.id;
        let c = stash.create_note("# C", Some("other"), T0, MSK).unwrap().id;
        stash.tag(&c, &["infra".into()], &[]).unwrap();
        let d = stash.put_away(&put(vec![user_file(root, "loose/d.md", "d")]), T0).unwrap().remove(0).entry.id;
        let e = stash.create_note("# E", Some("couplet"), T0, MSK).unwrap().id;
        set_columns(stash, &a, "modified_at = 100, stashed_at = NULL, opened_at = 900");
        set_columns(stash, &b, "modified_at = 200, stashed_at = 300, opened_at = NULL");
        set_columns(stash, &c, "modified_at = 400, stashed_at = 500, opened_at = 100");
        set_columns(stash, &d, "modified_at = 50, stashed_at = 600, opened_at = NULL");
        set_columns(stash, &e, "modified_at = 800, stashed_at = NULL, deleted_at = 700");
        Seeded { a, b, c, d, e }
    }

    fn ids(r: &ListResult) -> Vec<String> {
        r.entries.iter().map(|e| e.id.clone()).collect()
    }

    fn query(f: impl FnOnce(&mut ListQuery)) -> ListQuery {
        let mut q = ListQuery::default();
        f(&mut q);
        q
    }

    #[test]
    fn the_default_list_is_newest_change_first_without_the_trash() {
        let (mut stash, root) = stash_in("list");
        let s = seed(&mut stash, &root);
        let r = stash.list(&ListQuery::default()).unwrap();
        assert_eq!(ids(&r), vec![s.d.clone(), s.c.clone(), s.b.clone(), s.a.clone()]);
        assert_eq!((r.total, r.next_cursor), (4, None));
        let b = r.entries.iter().find(|e| e.id == s.b).unwrap();
        assert_eq!((b.repo.as_deref(), b.branch.as_deref()), (Some("couplet"), Some("main")));
    }

    #[test]
    fn the_other_sorts() {
        let (mut stash, root) = stash_in("list-sorts");
        let s = seed(&mut stash, &root);
        let opened = stash.list(&query(|q| q.sort = ListSort::Opened)).unwrap();
        assert_eq!(ids(&opened), vec![s.a.clone(), s.c.clone(), s.d.clone(), s.b.clone()]);
        let kind = stash.list(&query(|q| q.sort = ListSort::Kind)).unwrap();
        assert_eq!(ids(&kind), vec![s.c.clone(), s.a.clone(), s.d.clone(), s.b.clone()], "notes first");
    }

    #[test]
    fn filters() {
        let (mut stash, root) = stash_in("list-filters");
        let s = seed(&mut stash, &root);
        let list = |q: ListQuery| ids(&stash.list(&q).unwrap());
        assert_eq!(list(query(|q| q.kind = Some(StashKind::File))), vec![s.d.clone(), s.b.clone()]);
        assert_eq!(list(query(|q| q.kind = Some(StashKind::Note))), vec![s.c.clone(), s.a.clone()]);
        assert_eq!(list(query(|q| q.tag = Some("#INFRA".into()))), vec![s.c.clone()]);
        assert_eq!(list(query(|q| q.repo = Some("couplet".into()))), vec![s.b.clone(), s.a.clone()]);
        assert_eq!(list(query(|q| q.repo = Some("/Users/u/src/couplet".into()))), vec![s.b.clone(), s.a.clone()]);
        assert_eq!(list(query(|q| q.deleted = true)), vec![s.e.clone()]);
    }

    #[test]
    fn pages_follow_the_cursor() {
        let (mut stash, root) = stash_in("list-pages");
        let s = seed(&mut stash, &root);
        let first = stash.list(&query(|q| q.limit = Some(2))).unwrap();
        assert_eq!(ids(&first), vec![s.d.clone(), s.c.clone()]);
        assert_eq!(first.total, 4);
        let second = stash.list(&query(|q| { q.limit = Some(2); q.cursor = first.next_cursor.clone(); })).unwrap();
        assert_eq!(ids(&second), vec![s.b.clone(), s.a.clone()]);
        assert_eq!((second.total, second.next_cursor), (4, None));
        let one = stash.list(&query(|q| q.limit = Some(0))).unwrap();
        assert_eq!(one.entries.len(), 1, "a limit is at least 1");
    }

    #[test]
    fn an_entry_raised_between_pages_is_not_repeated() {
        let (mut stash, root) = stash_in("list-raised");
        let s = seed(&mut stash, &root);
        let first = stash.list(&query(|q| q.limit = Some(2))).unwrap();
        set_columns(&stash, &s.a, "stashed_at = 10000");
        let second = stash.list(&query(|q| { q.limit = Some(2); q.cursor = first.next_cursor.clone(); })).unwrap();
        assert_eq!(ids(&second), vec![s.b.clone()]);
    }

    #[test]
    fn a_malformed_cursor_is_an_error() {
        let (stash, _root) = stash_in("list-cursor");
        for bad in ["x", "1.2", "1.2.3.4", "a.b.c"] {
            assert!(stash.list(&query(|q| q.cursor = Some(bad.into()))).is_err(), "{bad}");
        }
    }

    #[test]
    fn counts() {
        let (mut stash, root) = stash_in("counts");
        seed(&mut stash, &root);
        assert_eq!(stash.counts(None, 450).unwrap(), StashCounts { total: 4, stashed_today: 2, deleted: 1 });
        assert_eq!(stash.counts(Some("couplet"), 0).unwrap(), StashCounts { total: 2, stashed_today: 1, deleted: 1 });
    }
```

In `src-tauri/src/stash/mod.rs`, below `PutAwayResult`:

```rust
/// `stash_list`'s sort (spec: «изменение ⌘L · открытие ⌘R · тип ⌘U»).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ListSort {
    #[default]
    Changed,
    Opened,
    Kind,
}

/// `stash_list`'s arguments.
#[derive(Clone, Debug, Default)]
pub struct ListQuery {
    pub repo: Option<String>,
    pub tag: Option<String>,
    pub kind: Option<StashKind>,
    pub sort: ListSort,
    /// `true`: the trash instead of the stash.
    pub deleted: bool,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub entries: Vec<StashEntry>,
    /// Matching entries across all pages.
    pub total: usize,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashCounts {
    pub total: usize,
    pub stashed_today: usize,
    pub deleted: usize,
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::entries`
Expected: FAIL to compile — `no method named list`, `counts`.

- [ ] **Step 3: Implement**

In `src-tauri/src/stash/entries.rs`: change the `use super::{…}` line to

```rust
use super::{ids, notes, ListQuery, ListResult, ListSort, PutAway, PutAwayResult, Stash, StashCounts, StashEntry, StashKind};
```

add `use std::cmp::Reverse;` to the std imports, and add below `TAG_MAX_CHARS`:

```rust
pub(crate) const DEFAULT_LIMIT: usize = 50;
pub(crate) const MAX_LIMIT: usize = 500;

/// A row that passed the filters, with what the listing derives for it.
struct Candidate {
    row: EntryRow,
    tags: Vec<String>,
    repo: Option<String>,
    branch: Option<String>,
}

/// Descending sort key; `rowid` last, so every key is unique and a keyset
/// cursor is exact (plan D6, D7).
type SortKey = (i64, i64, i64);

fn changed_at(row: &EntryRow) -> i64 {
    row.modified_at.max(row.stashed_at.unwrap_or(i64::MIN))
}

fn sort_key(row: &EntryRow, sort: ListSort) -> SortKey {
    match sort {
        ListSort::Changed => (changed_at(row), 0, row.rowid),
        ListSort::Opened => (row.opened_at.unwrap_or(0), changed_at(row), row.rowid),
        ListSort::Kind => (i64::from(row.kind == StashKind::Note), changed_at(row), row.rowid),
    }
}

fn encode_cursor(key: SortKey) -> String {
    format!("{}.{}.{}", key.0, key.1, key.2)
}

fn decode_cursor(cursor: &str) -> Result<SortKey, String> {
    let mut parts = cursor.split('.').map(str::parse::<i64>);
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(Ok(a)), Some(Ok(b)), Some(Ok(c)), None) => Ok((a, b, c)),
        _ => Err(format!("invalid cursor: {cursor:?}")),
    }
}
```

Add inside `impl Stash`:

```rust
    /// Rows passing the filters. SQL decides what it can; a file reference's
    /// repo is derived here, so the repo filter for files is applied after.
    fn candidates(&self, deleted: bool, kind: Option<StashKind>, tag: Option<&str>, repo: Option<&str>) -> Result<Vec<Candidate>, String> {
        let sql = format!(
            "SELECT {ENTRY_COLUMNS} FROM entries e \
             WHERE (e.deleted_at IS NOT NULL) = ?1 \
               AND (?2 IS NULL OR e.kind = ?2) \
               AND (?3 IS NULL OR EXISTS (SELECT 1 FROM tags t WHERE t.entry_id = e.id AND t.tag = ?3)) \
               AND (?4 IS NULL OR e.kind = 'file' OR e.repo = ?4)"
        );
        let mut stmt = self.conn.prepare(&sql).map_err(db::err)?;
        let rows = stmt
            .query_map(params![deleted, kind.map(StashKind::as_str), tag, repo], db::entry_row)
            .map_err(db::err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db::err)?;
        let mut tags = db::all_tags(&self.conn)?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let (entry_repo, branch) = derived_repo(&row);
            if repo.is_some() && entry_repo.as_deref() != repo {
                continue;
            }
            out.push(Candidate { tags: tags.remove(&row.id).unwrap_or_default(), row, repo: entry_repo, branch });
        }
        Ok(out)
    }

    pub fn list(&self, q: &ListQuery) -> Result<ListResult, String> {
        let tag = match q.tag.as_deref() {
            Some(t) => normalize_tag(t)?,
            None => None,
        };
        let repo = normalize_repo(q.repo.as_deref());
        let after = q.cursor.as_deref().map(decode_cursor).transpose()?;
        let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

        let mut all = self.candidates(q.deleted, q.kind, tag.as_deref(), repo.as_deref())?;
        all.sort_by_key(|c| Reverse(sort_key(&c.row, q.sort)));
        let total = all.len();
        let start = after.map_or(0, |key| {
            all.iter().position(|c| sort_key(&c.row, q.sort) < key).unwrap_or(total)
        });
        let mut page: Vec<Candidate> = all.into_iter().skip(start).take(limit + 1).collect();
        let more = page.len() > limit;
        page.truncate(limit);
        let next_cursor = if more {
            page.last().map(|c| encode_cursor(sort_key(&c.row, q.sort)))
        } else {
            None
        };
        let entries = page
            .into_iter()
            .map(|c| {
                let preview = read_preview(Path::new(&c.row.path));
                entry_from(c.row, c.tags, c.repo, c.branch, preview)
            })
            .collect();
        Ok(ListResult { entries, total, next_cursor })
    }

    /// The drawer's summary line («19 · отложено сегодня 6»). `day_start_ms`
    /// is the local midnight that starts today (`clock::local_day_start_ms`).
    pub fn counts(&self, repo: Option<&str>, day_start_ms: i64) -> Result<StashCounts, String> {
        let repo = normalize_repo(repo);
        let live = self.candidates(false, None, None, repo.as_deref())?;
        let deleted = self.candidates(true, None, None, repo.as_deref())?.len();
        let stashed_today = live
            .iter()
            .filter(|c| c.row.stashed_at.is_some_and(|t| t >= day_start_ms))
            .count();
        Ok(StashCounts { total: live.len(), stashed_today, deleted })
    }
```

- [ ] **Step 4: Run the tests**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::entries`
Expected: PASS, `29 passed`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/stash/entries.rs src-tauri/src/stash/mod.rs
git commit -m "$(cat <<'EOF'
feat(stash): list with filters, sorts, keyset pagination; counts

Files' repo is derived at read time, so filtering and sorting happen in
memory after one SQL query; the cursor is the last sort key, so an entry
raised between pages is never shown twice.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: daily backup and the plain export

**Files:**
- Create: `src-tauri/src/stash/backup.rs`
- Modify: `src-tauri/src/stash/mod.rs` (module list)

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/stash/backup.rs` with only the tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::atomic_write::testkit::{mode_of, scratch};
    use crate::stash::testkit::*;

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_backup_is_a_readable_self_contained_copy() {
        let (mut stash, root) = stash_in("backup");
        let note = stash.create_note("# Keep", None, T0, MSK).unwrap();
        let made = stash.daily_backup(T0, MSK).unwrap().expect("first backup of the day");
        assert_eq!(made, root.join("data/stash-backups/stash-2026-09-26.db"));
        assert_eq!(names_in(&root.join("data/stash-backups")), ["stash-2026-09-26.db"], "no -wal, no .tmp");
        let copy = Connection::open(&made).unwrap();
        let id: String = copy.query_row("SELECT id FROM entries", [], |r| r.get(0)).unwrap();
        assert_eq!(id, note.id);
    }

    #[test]
    fn one_backup_a_day() {
        let (stash, _root) = stash_in("backup-daily");
        assert!(stash.daily_backup(T0, MSK).unwrap().is_some());
        assert!(stash.daily_backup(T0 + 3_600_000, MSK).unwrap().is_none(), "same local day");
        assert!(stash.daily_backup(T0 + 86_400_000, MSK).unwrap().is_some(), "the next day");
    }

    #[test]
    fn the_seven_newest_are_kept_and_nothing_else_is_touched() {
        let (stash, root) = stash_in("backup-prune");
        let dir = root.join("data/stash-backups");
        fs::create_dir_all(&dir).unwrap();
        for day in 10..=18 {
            fs::write(dir.join(format!("stash-2026-09-{day}.db")), "old").unwrap();
        }
        fs::write(dir.join("notes.txt"), "mine").unwrap();
        fs::write(dir.join("stash-2026-09-01.db.tmp"), "not a backup").unwrap();
        stash.daily_backup(T0, MSK).unwrap();
        assert_eq!(
            names_in(&dir),
            [
                "notes.txt",
                "stash-2026-09-01.db.tmp",
                "stash-2026-09-13.db",
                "stash-2026-09-14.db",
                "stash-2026-09-15.db",
                "stash-2026-09-16.db",
                "stash-2026-09-17.db",
                "stash-2026-09-18.db",
                "stash-2026-09-26.db",
            ]
        );
    }

    #[test]
    fn backup_names() {
        assert!(is_backup_name("stash-2026-09-26.db"));
        assert!(!is_backup_name("stash-2026-09-26.db.tmp"));
        assert!(!is_backup_name("stash-2026-9-26.db"));
        assert!(!is_backup_name("stash.db"));
        assert!(!is_backup_name("other-2026-09-26.db"));
    }

    #[test]
    fn the_export_is_plain_entries_and_tags() {
        let (mut stash, _root) = stash_in("export");
        let note = stash.create_note("# Экспорт\nтекст", Some("couplet"), T0, MSK).unwrap();
        stash.tag(&note.id, &["infra".into()], &[]).unwrap();
        stash.export(T0).unwrap();
        let path = stash.paths.export_path.clone();
        assert_eq!(mode_of(&path), 0o600, "titles and paths are private");
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["version"], 1);
        assert_eq!(json["exportedAt"], T0);
        let e = &json["entries"][0];
        assert_eq!(e["id"], note.id.as_str());
        assert_eq!(e["path"], note.path.as_str());
        assert_eq!(e["title"], "Экспорт");
        assert_eq!(e["repo"], "couplet");
        assert_eq!(e["tags"], serde_json::json!(["infra"]));
        assert!(e.get("preview").is_none(), "no note text in the export");
    }

    #[test]
    fn after_write_survives_a_broken_backups_folder() {
        let (mut stash, root) = stash_in("after-write");
        stash.create_note("x", None, T0, MSK).unwrap();
        fs::write(root.join("data/stash-backups"), "a file where the folder should be").unwrap();
        stash.after_write(T0, MSK);
        assert!(stash.paths.export_path.exists(), "the export still happened");
    }

    #[test]
    fn a_leftover_temp_from_a_crash_is_replaced() {
        let dir = scratch("backup-tmp");
        let (stash, _root) = stash_in("backup-tmp-db");
        fs::write(dir.join("stash-2026-09-26.db.tmp"), "half a backup").unwrap();
        let made = daily_backup(&stash.conn, &dir, "2026-09-26").unwrap().unwrap();
        assert!(Connection::open(&made).unwrap().query_row("SELECT count(*) FROM entries", [], |r| r.get::<_, i64>(0)).is_ok());
        assert!(!dir.join("stash-2026-09-26.db.tmp").exists());
    }
}
```

Add `mod backup;` to the module list in `src-tauri/src/stash/mod.rs` (first, before `mod clock;`).

- [ ] **Step 2: Run them to see them fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::backup`
Expected: FAIL to compile — `no method named daily_backup`, `cannot find function is_backup_name`.

- [ ] **Step 3: Implement**

Prepend to `src-tauri/src/stash/backup.rs`:

```rust
//! Second copies of the stash's metadata (note text is already its own
//! `.md` files): a daily online backup of `stash.db` in the app data
//! directory, the 7 newest kept, and a plain `.stash-export.json` beside the
//! notes that a human can read without SQLite (spec «Хранение»).

use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::backup::Backup;
use rusqlite::Connection;
use serde::Serialize;

use crate::atomic_write::{self, NewFileMode};

use super::{clock, db, notes, Stash, StashKind};

pub(crate) const KEEP_BACKUPS: usize = 7;
const PAGES_PER_STEP: i32 = 1024;
const EXPORT_VERSION: u32 = 1;

pub(crate) fn backup_name(date: &str) -> String {
    format!("stash-{date}.db")
}

/// Exactly `stash-YYYY-MM-DD.db`: pruning never touches anything else.
fn is_backup_name(name: &str) -> bool {
    let Some(date) = name.strip_prefix("stash-").and_then(|r| r.strip_suffix(".db")) else {
        return false;
    };
    date.len() == 10
        && date
            .bytes()
            .enumerate()
            .all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() })
}

/// Today's backup in `dir`, unless it exists. `Ok(None)`: nothing to do.
/// Lives in the app's own data directory, so `.tmp` + `rename` is enough
/// (CLAUDE.md: `atomic_write` is for the user's folders).
pub(crate) fn daily_backup(conn: &Connection, dir: &Path, date: &str) -> Result<Option<PathBuf>, String> {
    let target = dir.join(backup_name(date));
    if target.exists() {
        return Ok(None);
    }
    fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let tmp = dir.join(format!("{}.tmp", backup_name(date)));
    // A leftover is an unfinished copy from a crashed run, never a backup.
    let _ = fs::remove_file(&tmp);
    {
        let mut dst = Connection::open(&tmp).map_err(db::err)?;
        Backup::new(conn, &mut dst)
            .map_err(db::err)?
            .run_to_completion(PAGES_PER_STEP, Duration::ZERO, None)
            .map_err(db::err)?;
        // The source is WAL; a backup must be one file that opens anywhere.
        let _: String = dst
            .query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))
            .map_err(db::err)?;
    }
    fs::rename(&tmp, &target).map_err(|e| format!("cannot publish {}: {e}", target.display()))?;
    prune(dir, KEEP_BACKUPS);
    Ok(Some(target))
}

fn prune(dir: &Path, keep: usize) {
    let Ok(read) = fs::read_dir(dir) else { return };
    let mut names: Vec<String> = read
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| is_backup_name(n))
        .collect();
    names.sort_unstable_by(|a, b| b.cmp(a));
    for old in names.into_iter().skip(keep) {
        if let Err(e) = fs::remove_file(dir.join(&old)) {
            eprintln!("stash: cannot prune backup {old}: {e}");
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Export {
    version: u32,
    exported_at: i64,
    entries: Vec<ExportEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportEntry {
    tags: Vec<String>,
    title: Option<String>,
    id: String,
    kind: StashKind,
    path: String,
    repo: Option<String>,
    created_at: i64,
    modified_at: i64,
    stashed_at: Option<i64>,
    opened_at: Option<i64>,
    deleted_at: Option<i64>,
    caret: i64,
    top_line: i64,
}

fn export_json(conn: &Connection, now: i64) -> Result<String, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {} FROM entries ORDER BY rowid", db::ENTRY_COLUMNS))
        .map_err(db::err)?;
    let rows = stmt
        .query_map([], db::entry_row)
        .map_err(db::err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db::err)?;
    let mut tags: HashMap<String, Vec<String>> = db::all_tags(conn)?;
    let entries = rows
        .into_iter()
        .map(|r| ExportEntry {
            tags: tags.remove(&r.id).unwrap_or_default(),
            title: (!r.title.is_empty()).then_some(r.title),
            id: r.id,
            kind: r.kind,
            path: r.path,
            repo: r.repo,
            created_at: r.created_at,
            modified_at: r.modified_at,
            stashed_at: r.stashed_at,
            opened_at: r.opened_at,
            deleted_at: r.deleted_at,
            caret: r.caret,
            top_line: r.top_line,
        })
        .collect();
    serde_json::to_string_pretty(&Export { version: EXPORT_VERSION, exported_at: now, entries })
        .map_err(|e| format!("cannot serialize the stash export: {e}"))
}

/// In the user's folder, so through `atomic_write`; reserved 0600 first like a
/// note (plan D3, D13).
fn write_export(path: &Path, json: &str) -> Result<(), String> {
    match notes::reserve_private(path) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("cannot create {}: {e}", path.display())),
    }
    atomic_write::save(path, json, NewFileMode::Umask)
}

impl Stash {
    pub(crate) fn daily_backup(&self, now: i64, offset_secs: i64) -> Result<Option<PathBuf>, String> {
        daily_backup(&self.conn, &self.paths.backups_dir, &clock::local_date(now, offset_secs))
    }

    pub(crate) fn export(&mut self, now: i64) -> Result<(), String> {
        self.notes_dir()?;
        let json = export_json(&self.conn, now)?;
        write_export(&self.paths.export_path, &json)
    }

    /// After every write command. Best effort: neither copy may fail the write
    /// that triggered it.
    pub(crate) fn after_write(&mut self, now: i64, offset_secs: i64) {
        if let Err(e) = self.export(now) {
            eprintln!("stash: export: {e}");
        }
        if let Err(e) = self.daily_backup(now, offset_secs) {
            eprintln!("stash: backup: {e}");
        }
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::backup`
Expected: PASS, `7 passed`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/stash/backup.rs src-tauri/src/stash/mod.rs
git commit -m "$(cat <<'EOF'
feat(stash): daily online backup (keep 7) and plain JSON export

Backups use the SQLite online backup API into stash-backups/, switched
to a single-file journal before the rename; the export is written 0600
beside the notes through atomic_write.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: `StashState`, the Tauri commands, wiring and the save hook

**Files:**
- Modify: `src-tauri/src/stash/mod.rs` (`StashState`, event, hook)
- Create: `src-tauri/src/stash/commands.rs`
- Modify: `src-tauri/src/lib.rs` (`generate_handler!`, `setup`)
- Modify: `src-tauri/src/commands.rs` (`write_file`, one test)

- [ ] **Step 1: Write the failing tests**

Add at the end of `src-tauri/src/stash/mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::atomic_write::testkit::scratch;

    #[test]
    fn an_unavailable_stash_answers_every_call_with_the_reason() {
        let state = StashState::open(Err("paths::init has not run".to_string()));
        assert!(!state.is_available());
        assert_eq!(state.with(|s| s.get("s1-0000")).unwrap_err(), "stash unavailable: paths::init has not run");
    }

    #[test]
    fn a_database_that_will_not_open_is_left_alone() {
        let root = scratch("stash-bad-db");
        let paths = testkit::paths_in(&root);
        fs::create_dir_all(paths.db_path.parent().unwrap()).unwrap();
        fs::write(&paths.db_path, b"not a database, and it must survive").unwrap();
        let state = StashState::open(Ok(paths.clone()));
        assert!(!state.is_available());
        assert_eq!(fs::read(&paths.db_path).unwrap(), b"not a database, and it must survive");
    }

    #[test]
    fn a_panic_inside_one_call_does_not_lock_the_stash_forever() {
        let root = scratch("stash-poison");
        let state = StashState::open(Ok(testkit::paths_in(&root)));
        let clone = state.clone();
        let _ = std::thread::spawn(move || clone.with(|_| -> Result<(), String> { panic!("boom") })).join();
        assert!(state.with(|s| s.list(&ListQuery::default())).is_ok());
    }
}
```

Add to the `tests` module of `src-tauri/src/commands.rs`:

```rust
    #[test]
    fn saving_a_stash_note_updates_its_title_through_the_hook() {
        // The only test that installs the process-wide hook (a `OnceLock`); a
        // second installer anywhere in the test binary would fail here.
        let root = scratch("stash-hook");
        let state = crate::stash::StashState::open(Ok(crate::stash::testkit::paths_in(&root)));
        let note = state
            .with(|s| s.create_note("# Old", None, crate::stash::testkit::T0, 0))
            .unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        assert!(crate::stash::install_write_hook(state.clone(), move |reason| {
            let _ = tx.send(reason.to_string());
        }));

        tauri::async_runtime::block_on(write_file(note.path.clone(), "# New title\n".to_string())).unwrap();

        assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap(), "written");
        assert_eq!(state.with(|s| s.get(&note.id)).unwrap().title.as_deref(), Some("New title"));
        assert_eq!(fs::read_to_string(&note.path).unwrap(), "# New title\n");
    }
```

- [ ] **Step 2: Run them to see them fail**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml -- stash::tests commands::tests`
Expected: FAIL to compile — `cannot find type StashState`, `cannot find function install_write_hook`.

- [ ] **Step 3: Implement `StashState`, the event and the hook**

In `src-tauri/src/stash/mod.rs`: add `pub(crate) mod commands;` to the module list (after `mod clock;`); change `use std::path::PathBuf;` to

```rust
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
```

and add above `#[cfg(test)] pub(crate) mod testkit`:

```rust
/// Emitted once with `app.emit` after a write that changed the stash.
pub const STASH_CHANGED: &str = "stash-changed";

#[derive(Clone, Debug, Serialize)]
pub struct StashChanged {
    pub reason: String,
}

/// The Tauri-managed stash. `Err` holds why it could not open (plan D11):
/// the app runs on, every command answers with the reason, the database file
/// is left as it was.
#[derive(Clone)]
pub struct StashState(Arc<Mutex<Result<Stash, String>>>);

impl StashState {
    pub fn open(paths: Result<StashPaths, String>) -> Self {
        let stash = paths.and_then(Stash::open);
        if let Err(e) = &stash {
            eprintln!("stash: unavailable: {e}");
        }
        Self(Arc::new(Mutex::new(stash)))
    }

    /// Runs `f` on the stash under its lock. A panic inside an earlier call
    /// poisons nothing that matters: its transaction rolled back when dropped.
    pub fn with<T>(&self, f: impl FnOnce(&mut Stash) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_mut() {
            Ok(stash) => f(stash),
            Err(e) => Err(format!("stash unavailable: {e}")),
        }
    }

    pub fn is_available(&self) -> bool {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).is_ok()
    }

    /// Today's backup, off the launch path.
    pub fn backup_in_background(&self) {
        let state = self.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let now = clock::now_ms();
            let offset = clock::local_offset_secs(now.div_euclid(1000));
            if let Err(e) = state.with(|s| s.daily_backup(now, offset)) {
                eprintln!("stash: backup: {e}");
            }
        });
    }
}

type Notify = Box<dyn Fn(&str) + Send + Sync>;

struct WriteHook {
    state: StashState,
    notify: Notify,
}

/// Process-wide, so `commands::write_file` keeps its signature (and its tests)
/// and still reaches the stash (plan D9).
static WRITE_HOOK: OnceLock<WriteHook> = OnceLock::new();

/// Installs the save hook once. `notify` receives the event reason when a
/// save changed what the stash shows. `false`: one was already installed.
pub fn install_write_hook(state: StashState, notify: impl Fn(&str) + Send + Sync + 'static) -> bool {
    WRITE_HOOK
        .set(WriteHook { state, notify: Box::new(notify) })
        .is_ok()
}

/// Called by `write_file` after every successful save. Best effort and off
/// the save's thread: a busy database must never delay an autosave.
pub fn on_file_written(path: &str, text: &str) {
    let Some(hook) = WRITE_HOOK.get() else { return };
    let now = clock::now_ms();
    let (path, text) = (path.to_owned(), text.to_owned());
    let _ = tauri::async_runtime::spawn_blocking(move || {
        match hook.state.with(|s| s.file_written(&path, &text, now)) {
            Ok(true) => (hook.notify)("written"),
            Ok(false) => {}
            Err(e) => eprintln!("stash: after saving {path}: {e}"),
        }
    });
}
```

- [ ] **Step 4: Call the hook from `write_file`**

In `src-tauri/src/commands.rs`, replace the body of `write_file`:

```rust
#[command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    atomic_write::save(Path::new(&path), &content, NewFileMode::Umask)?;
    // After the save, never instead of it: the stash's title and modified time
    // are bookkeeping, and a stash failure must not fail a save.
    crate::stash::on_file_written(&path, &content);
    Ok(())
}
```

- [ ] **Step 5: Run the tests**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml -- stash::tests commands::tests`
Expected: PASS — `stash::tests` 3 tests; `commands::tests` all existing tests plus `saving_a_stash_note_updates_its_title_through_the_hook`. (`stash::tests` also matches nothing else: the other stash modules' tests are `stash::<module>::tests`.)

- [ ] **Step 6: Write the commands**

Create `src-tauri/src/stash/commands.rs`:

```rust
//! The stash's Tauri commands, stage 02 of the roadmap's IPC table. Each runs
//! on the blocking pool (SQLite and the file system block) and, after a write
//! that changed something, emits `stash-changed` once with `app.emit` — a
//! window's emit is a broadcast (CLAUDE.md), so never per window.

use tauri::{AppHandle, Emitter, State};

use super::{
    clock, ListQuery, ListResult, ListSort, PutAway, PutAwayResult, Stash, StashChanged, StashCounts, StashEntry,
    StashKind, StashState, STASH_CHANGED,
};

async fn run<T: Send + 'static>(
    state: &StashState,
    f: impl FnOnce(&mut Stash) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || state.with(f))
        .await
        .map_err(|e| format!("stash task failed: {e}"))?
}

fn changed(app: &AppHandle, reason: &str) {
    let _ = app.emit(STASH_CHANGED, StashChanged { reason: reason.to_string() });
}

fn offset_at(now: i64) -> i64 {
    clock::local_offset_secs(now.div_euclid(1000))
}

#[tauri::command]
pub async fn stash_create_note(
    app: AppHandle,
    state: State<'_, StashState>,
    text: String,
    repo: Option<String>,
) -> Result<StashEntry, String> {
    let entry = run(&state, move |s| {
        let now = clock::now_ms();
        let entry = s.create_note(&text, repo.as_deref(), now, offset_at(now))?;
        s.after_write(now, offset_at(now));
        Ok(entry)
    })
    .await?;
    changed(&app, "created");
    Ok(entry)
}

#[tauri::command]
pub async fn stash_put_away(
    app: AppHandle,
    state: State<'_, StashState>,
    paths: Vec<String>,
    caret: Option<i64>,
    top_line: Option<i64>,
    tags: Option<Vec<String>>,
) -> Result<Vec<PutAwayResult>, String> {
    let req = PutAway { paths, caret, top_line, tags: tags.unwrap_or_default() };
    let results = run(&state, move |s| {
        let now = clock::now_ms();
        let results = s.put_away(&req, now)?;
        s.after_write(now, offset_at(now));
        Ok(results)
    })
    .await?;
    if !results.is_empty() {
        changed(&app, "put-away");
    }
    Ok(results)
}

#[tauri::command]
// The IPC contract passes the filters flat: `stash_list { repo?, tag?, … }`.
#[allow(clippy::too_many_arguments)]
pub async fn stash_list(
    state: State<'_, StashState>,
    repo: Option<String>,
    tag: Option<String>,
    kind: Option<StashKind>,
    sort: Option<ListSort>,
    deleted: Option<bool>,
    limit: Option<usize>,
    cursor: Option<String>,
) -> Result<ListResult, String> {
    let q = ListQuery {
        repo,
        tag,
        kind,
        sort: sort.unwrap_or_default(),
        deleted: deleted.unwrap_or(false),
        limit,
        cursor,
    };
    run(&state, move |s| s.list(&q)).await
}

#[tauri::command]
pub async fn stash_get(state: State<'_, StashState>, id: String) -> Result<StashEntry, String> {
    run(&state, move |s| s.get(&id)).await
}

#[tauri::command]
pub async fn stash_tag(
    app: AppHandle,
    state: State<'_, StashState>,
    id: String,
    add: Option<Vec<String>>,
    remove: Option<Vec<String>>,
) -> Result<StashEntry, String> {
    let entry = run(&state, move |s| {
        let now = clock::now_ms();
        let entry = s.tag(&id, &add.unwrap_or_default(), &remove.unwrap_or_default())?;
        s.after_write(now, offset_at(now));
        Ok(entry)
    })
    .await?;
    changed(&app, "tagged");
    Ok(entry)
}

#[tauri::command]
pub async fn stash_touch_opened(app: AppHandle, state: State<'_, StashState>, path: String) -> Result<(), String> {
    let touched = run(&state, move |s| {
        let now = clock::now_ms();
        let touched = s.touch_opened(&path, now)?;
        if touched {
            s.after_write(now, offset_at(now));
        }
        Ok(touched)
    })
    .await?;
    if touched {
        changed(&app, "opened");
    }
    Ok(())
}

#[tauri::command]
pub async fn stash_counts(state: State<'_, StashState>, repo: Option<String>) -> Result<StashCounts, String> {
    run(&state, move |s| {
        let now = clock::now_ms();
        s.counts(repo.as_deref(), clock::local_day_start_ms(now, offset_at(now)))
    })
    .await
}
```

Tauri maps the camelCase keys the frontend sends (`topLine`) to these snake_case arguments.

- [ ] **Step 7: Wire it in `lib.rs`**

In `src-tauri/src/lib.rs`, add to `tauri::generate_handler![…]` after `recent::recent_files_import,`:

```rust
            stash::commands::stash_create_note,
            stash::commands::stash_put_away,
            stash::commands::stash_list,
            stash::commands::stash_get,
            stash::commands::stash_tag,
            stash::commands::stash_touch_opened,
            stash::commands::stash_counts,
```

In `.setup(|app| { … })`, right after `app.manage(recent::RecentFiles::load());`:

```rust
            // After `paths::init`, for the same reason as `RecentFiles`: the
            // database lives in the data directory it names (CLAUDE.md gotcha).
            // Opening touches only Application Support; the notes folder in
            // ~/Documents (TCC-protected) is created by the first note.
            let stash_state = stash::StashState::open(stash::StashPaths::resolve());
            if stash_state.is_available() {
                let emitter = app.handle().clone();
                stash::install_write_hook(stash_state.clone(), move |reason| {
                    let _ = emitter.emit(stash::STASH_CHANGED, stash::StashChanged { reason: reason.to_string() });
                });
                stash_state.backup_in_background();
            }
            app.manage(stash_state);
```

(`Emitter` is already imported at the top of `lib.rs`.)

- [ ] **Step 8: Build and run the stash suite**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml stash::`
Expected: PASS — every `stash::` test (1 probe + 6 clock + 3 ids + 6 notes + 3 paths + 6 db + 29 entries + 7 backup + 3 state = 64).

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo clippy --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "stash|generated [0-9]+ warning"`
Expected: no line mentioning `src/stash/`; the warning count equals the baseline from Task 1. A `dead_code` warning left in `stash/` means an item this plan added is unused — remove it rather than allow it.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/stash/mod.rs src-tauri/src/stash/commands.rs src-tauri/src/lib.rs src-tauri/src/commands.rs
git commit -m "$(cat <<'EOF'
feat(stash): StashState, stage-02 commands, save hook

StashState is managed in setup after paths::init; a stash that cannot
open leaves the app running and the file alone. Commands run on the
blocking pool and emit stash-changed once. write_file calls
stash::on_file_written after the save, off the save's thread, and it
notifies only when a note's title changed.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: stage checks, size and compile time, x86, docs

**Files:**
- Modify: `docs/superpowers/plans/2026-09-27-stash-02-storage.md` (Measurements)
- Modify: `CLAUDE.md`

- [ ] **Step 1: Full test suite**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^test result"`
Expected: `ok`, passed = Task 1's baseline + 67 (64 `stash::` + 2 `git_info::` + 1 `commands::`), 0 failed.

- [ ] **Step 2: Clippy against the baseline**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo clippy --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "generated [0-9]+ warning"`
Expected: the same count as Task 1's baseline.

- [ ] **Step 3: Intel build**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target npm run check:x86`
Expected: `Finished` — the bundled SQLite C code and `clock.rs`'s `time_t`/`c_long` both compile for `x86_64-apple-darwin`. If `x86_64-apple-darwin` is missing: `rustup target add x86_64-apple-darwin` first.

- [ ] **Step 4: Binary size and compile time — record**

```bash
npm run build
CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo build --release --manifest-path src-tauri/Cargo.toml 2>&1 | tail -1
ls -l ~/.cargo/stash-impl-target/release/md-mini | awk '{print $5}'
CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo clean --release --manifest-path src-tauri/Cargo.toml -p libsqlite3-sys
/usr/bin/time -p env CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo build --release --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^real"
```

Write into **Measurements → After**: release binary bytes and the delta against "Before", and the `real` seconds of the release rebuild after cleaning `libsqlite3-sys` (the cost SQLite adds to a clean build). Acceptable means: delta under ~3 MB per architecture and the SQLite rebuild under ~2 minutes; if either is exceeded, do not change anything — record it and flag it in the night report for the owner.

- [ ] **Step 5: CLAUDE.md**

In `CLAUDE.md`, in the Architecture block under `src-tauri/src/`, after the `ai_socket.rs` line, add:

```
  stash/                # The stash (тайник), stage 02: SQLite stash.db (rusqlite bundled, FTS5 trigram) + note files in ~/Documents/<product>/
    mod.rs              # Stash, StashEntry & IPC types, StashState (managed after paths::init), save hook (on_file_written, OnceLock)
    db.rs / entries.rs  # Schema v1 + forward-only migrate; put-away (dedup by path_norm), list/counts (keyset cursor), tags, touch-opened
    notes.rs            # title_of (mirrored by noteTitle, shared fixture src-tauri/tests/fixtures/note-titles.json), note file names, 0600 create
    backup.rs           # Daily online backup (stash-backups/, keep 7) + .stash-export.json
    clock.rs / ids.rs / paths.rs / commands.rs # Local calendar without chrono; s<ms>-<hex> ids; StashPaths; stash_* commands
```

And append to the Gotchas list:

```
- **`~/Documents` is TCC-protected: the first access by couplet raises a macOS consent dialog.** The stash's notes folder lives there (`~/Documents/couplet/`, dev `couplet-dev/`), so nothing may create, list or even `stat` it at launch — `Stash::open` touches only Application Support, and `Stash::notes_dir()` creates and normalizes the folder on the first note or export. A test (`opening_the_stash_does_not_touch_the_documents_folder`) pins it.
- **The stash's save hook is process-wide (`stash::install_write_hook`, a `OnceLock`).** `write_file` calls `stash::on_file_written` after every successful save; the work runs on the blocking pool and emits `stash-changed` only when a note's title changed — never per autosave. Only one test in the binary may install the hook (`commands::tests::saving_a_stash_note_updates_its_title_through_the_hook`).
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-09-27-stash-02-storage.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(stash): stage 02 measurements and CLAUDE.md architecture

Records the release binary size and SQLite compile cost, the FTS5
source check, and documents the TCC and save-hook gotchas.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

Then, per the roadmap's stage conventions: `code-reviewer` over the stage diff (`git diff fix/draft-safety...feat/stash -- src-tauri CLAUDE.md`), fix the findings, push, update the night report.

---

## Measurements

Filled in by the implementer (Task 1 Step 1, Task 1 Step 5, Task 14 Step 4).

**Before** (Task 1, before adding `rusqlite`):
- cargo test: … passed / … ignored
- clippy warnings: …
- release `md-mini` binary: … bytes

**FTS5 source check** (Task 1 Step 5): paste the two `grep` outputs with their crate versions.

**After** (Task 14):
- cargo test: … passed / … ignored
- clippy warnings: … (must equal Before)
- release `md-mini` binary: … bytes (Δ …)
- release rebuild after `cargo clean -p libsqlite3-sys`: … s

---

## Self-review against the task

| Requirement | Where |
|---|---|
| `rusqlite` bundled; FTS5 + trigram proven first, Russian word form; feature fallback named | Task 1 (probe, `LIBSQLITE3_FLAGS`) |
| `paths.rs`, dev isolation via `paths::dir_name(product)` → `couplet-dev` | Task 6 |
| `db.rs`: WAL, foreign keys, busy 5 s, forward-only `migrate` on `user_version`, schema v1 exactly, empty FTS | Task 7 |
| `ids.rs` without a new dependency | Task 3 |
| `notes.rs`: `YYYY-MM-DD-HHMM-xxxx.md` via civil-from-days, `title_of`, create via `atomic_write::save` | Tasks 2, 4, 5 |
| `entries.rs`: put-away dedup via `path_norm`, `created=false` bumps `stashed_at`, merges tags, updates caret; list filters/sort/cursor; get; tags normalized; touch-opened; counts with `stashedToday` by local day | Tasks 8–11 |
| Files: `repo`/`branch` via `git_info` at read time; `preview` from disk, graceful | Task 8 (`repo_info`, `read_preview`) |
| `backup.rs`: daily online backup, keep 7; `.stash-export.json` via `atomic_write` | Task 12 |
| `commands.rs`: the seven stage-02 commands; `StashState` after `paths::init`; `on_file_written` from `write_file`, best effort | Task 13 |
| Fixture `note-titles.json` ≥15 cases (Russian, all heading levels, checkboxes, bold, empty, whitespace-only, very long line) + Rust test | Task 4 (33 cases) |
| Temp dirs only; every disk function takes its roots | `StashPaths` everywhere, `testkit::stash_in` |
| Binary size / compile time recorded; `npm run check:x86` | Task 14 |
