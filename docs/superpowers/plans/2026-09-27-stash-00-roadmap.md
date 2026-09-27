# Stash (Тайник) — Roadmap and Shared Contracts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each stage plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** couplet keeps everything the human types — no file names, no folders, no fragile untitled — in a durable **stash** («тайник» in Russian UI), with tags, search, a second drawer, a trash, and an agent API.

**Architecture:** A Rust `stash` module owns a SQLite database (`rusqlite`, bundled, FTS5 trigram) that is the source of truth for stash entries, tags and put-away times; note text lives in plain `.md` files under `~/Documents/<product>/`, addressed by path, so every existing file-tab mechanism (autosave, watcher, dedup, comments, agent `show`/`edit`) works on notes unchanged. The frontend gets a `src/lib/stash/` module (types, IPC, store, drawer, keys) that plugs into the existing tab controller and drawer. The MCP server and CLI read and write the same database directly (WAL), so agents can search the stash even when the app is not running.

**Tech Stack:** Tauri 2 (Rust), `rusqlite` (bundled SQLite with FTS5), Svelte 5 runes, CodeMirror 6, vitest, cargo test.

**Spec (behaviour wins):** `docs/superpowers/specs/2026-09-26-stash-design.md`
**Visual reference (look wins):** `docs/investigations/2026-09-26-stash-mockup/stash-drawers.html`, git tag `stash-mockup-approved`
**Background and history:** `docs/investigations/2026-09-26-shelf/report.md`

---

## Amendments after planning (2026-09-27) — these override the stage plans

The seven stage plans were written in parallel against this roadmap. Their planners found gaps and disagreements; the rulings below are final. **Where a stage plan says otherwise, this section wins** (then the spec, then the plan). Each stage's Task 0 must check its plan against this list.

**A1. Notes folder is `~/couplet/`** (dev: `~/couplet-dev/`), not `~/Documents/…` (owner decision). The home root is not TCC-protected, so there is no macOS privacy prompt — the ad-hoc signed app would otherwise re-prompt after every update, mid-typing. Rust: `dirs::home_dir()` joined with `paths::dir_name(product)`. Trash `~/couplet/.trash/`, export `~/couplet/.stash-export.json`. Every «Documents» path, test expectation and live-check step in the plans changes accordingly; the TCC-prompt steps in plan 03's live check are obsolete.

**A2. Dependency line:** `rusqlite = { version = "0.37", features = ["bundled", "backup", "functions"] }` (`functions` is needed by stage 05's `stash_fold()`). **crates.io is blocked on this network**; rusqlite 0.37.0 / libsqlite3-sys 0.35.0 and every other crate the project needs are already in the cargo cache. Build with `CARGO_NET_OFFLINE=true` (or `--offline`). **Verified 2026-09-27** with an offline probe: bundled SQLite 3.50.2, `ENABLE_FTS5=1`, the trigram tokenizer finds «тайнике» for `"тайник"`, «ДОКУМЕНТ» for `"мент"`, and **folds Cyrillic case** (`"ТАЙНИК"` matches) — plan 02 Task 1 will pass; plan 05's "stop if trigram does not fold Cyrillic case" risk is resolved.

**A3. `repo` = the directory name** (basename of the git toplevel, or of the window project root when not a repo), for notes and files alike. Stored for notes at creation and for **files at put-away time** (so SQL can filter by repo; re-derived on reindex). Rust reduces any value containing `/` to its last component. Known limitation: two checkouts with the same directory name share a scope. Plan 03 must pass the basename, not the absolute project root. Stage 04 does **not** add `window_repo`: it uses stage 03's `window_project` command, which returns `{ root: string | null, repo: string | null }`.

**A4. Titles:** `title TEXT NOT NULL`, stored as `''` for "no title", returned as `null` over IPC; the localized «Без названия» key `stash.untitled` is owned by stage 03. The `title_of` rule is pinned by plan 02's decision D16 and its 33-case fixture.

**A5. Schema:** v1 = stage 02 as specified. **v2 = stage 03's `draft_imports(source, fingerprint)` table.** Stage 05's `search_meta` lives outside `user_version` (`CREATE TABLE IF NOT EXISTS` in `ensure_index`). Every opener — app, CLI, MCP — runs `migrate` to the latest version, and **refuses to open a database with a newer `user_version`** than it knows.

**A6. `stash-changed` payload is `{ reason: string, ids?: string[] }`.** Reasons: `created`, `put-away`, `title`, `tagged`, `deleted`, `restored`, `purged`, `imported`, `reindexed`, `external` (CLI/MCP). `on_file_written` emits only when a note's title changed (not on every autosave). The CLI/MCP socket request is `{"v":1,"cmd":"stash-changed","reason":…}`.

**A7. Deletion contract (stage 06, file-ref branch already in stage 04):** `stash_delete` returns `DeleteOutcome = { kind: 'trashed', entry } | { kind: 'removed' } | { kind: 'kept', reason: 'unsaved'|'timeout'|'open', label, number }`. A note held by a tab is dropped through the owning window (`stash-drop-tab` event → `stash_drop_done`) before its file moves. Stage 04 implements the `removed` branch for file refs; stage 06 adds the note branch.

**A8. Trashed rows are inert:** `stash_put_away`, `stash_tag` and `on_file_written` refuse/ignore rows with `deleted_at`; trashed notes are removed from the FTS index; the short-query title fallback excludes them; agents never see or reach the trash. **Always `unindex_entry` before deleting an `entries` row** (SQLite reuses the highest rowid). `stash_list({deleted:true})` returns only trashed notes, newest deletion first; the default excludes them. `stash_counts.deleted` ignores `repo`. `stash_search` gains `deleted?: boolean`. `TRASH_RETENTION_DAYS = 30` has one Rust source, mirrored in TS with a drift test.

**A9. Shared definitions:** sort «changed» = `max(modifiedAt, stashedAt)` for the drawer and the agent alike; `stashedToday` counts from local midnight; `StashHit.ranges` are UTF-16 code units of the snippet; `score = -bm25` (higher is better); cursors are opaque strings. `stash_list` gains `since?` (`COALESCE(stashed_at, modified_at) >= since`). `stash_put_away` accepts `caret`/`topLine` only with a single path.

**A10. New IPC beyond the table** (as specified in the owning plan): `window_project` and `tab_close({ …, putAway })` (03), `tab_holders(paths)`, `tab_request_move(path)` + `tab-pull` event (04), `stash-drop-tab` / `stash_drop_done` (06). ⌃T with a drawer open: puts away the ⇧-selection, else the ringed card, else the active tab; does nothing while the stash drawer has the keys (04).

**A11. Locks:** the stash connection is only taken with no other lock held — never while holding `OpenFiles`, `PendingFiles` or `ClosedStack`, and never the reverse.

**A12. CLI/MCP (stage 07):** stash verbs require `--product` (it sets DB, notes folder and socket together); `--socket` alone is refused for stash verbs. CLI/MCP **never create the app data directory**: before couplet has run once, writes are refused with «couplet has not run on this Mac yet — open it once» (otherwise `migration.rs` would see the folder as populated and skip md-mini's data); reads create nothing. Agent answers use their own snake_case types (`AgentEntry`, `AgentHit`) that carry no preview text.

**A13. Stage 01 → 03 hand-off:** after stage 01 the session file carries un-restored windows with drafts, so stage 03's import of *referenced and orphaned* drafts covers them. Stage 03 does **not** import `session/.trash/` (deliberately discarded or rescued text stays there, recoverable by hand, purged after 30 days). Stage 01 tests on its own identity `pro.couplet.safety` as its plan says (not `pro.couplet.dev`).

**A14. Unowned items — assigned:** «Save As…» from a note (spec: the note moves to the chosen folder and leaves the stash; the old note file goes to `~/couplet/.trash/` and the entry is removed) → **stage 06, one extra task** after its trash machinery exists. Broken-link «файл не найден» cards and reindexing of stashed files edited outside couplet → **not in this delivery**; list them in the night report as known gaps.

**Owner questions for the morning** (defaults already chosen; do not block on them): the `⊔` glyph in the native window title for notes (stage 03); auto-restoring the session after a self-triggered restart such as a language switch (stage 01 leaves it opt-in); deleting a window's only tab leaves an empty tab (stage 06); «удалить навсегда» without confirmation (as in the mockup); toasts stay bottom-right and shift left of the open stash drawer (stage 04).

---

## Stages

Each stage is one detailed plan, one branch commit series and a code review. Stages run strictly in this order; each builds on the previous one.

| # | Plan file | Scope | Branch | Ships alone? |
|---|---|---|---|---|
| 01 | `2026-09-27-stash-01-safety-net.md` | **Phase 0.** Session GC moves drafts to `session/.trash/` (30-day purge) instead of deleting; rescue snapshot when ⌘W discards a non-empty untitled; root-cause investigation of drafts lost on `brew upgrade` with evidence and a fix; CLAUDE.md rule «user text is never deleted without a second copy» | `fix/draft-safety` → draft PR to `main` | **Yes** — can be released as 2.0.2 by the owner. Do not release. |
| 02 | `2026-09-27-stash-02-storage.md` | `rusqlite` + `src-tauri/src/stash/`: schema, note files, put-away/list/get/tag/counts, dedup, title extraction, backups + export. Rust only, no UI | `feat/stash` (from `fix/draft-safety`) | no |
| 03 | `2026-09-27-stash-03-notes.md` | Notes replace untitled: ⌘T tab becomes a note on its first non-blank character; empty tab vanishes; ⌘W and ⌃T put away; stash glyph on tab card and window title; live title; one-time migration of existing untitled drafts into notes | `feat/stash` | no |
| 04 | `2026-09-27-stash-04-drawer.md` | Stash drawer UI per the mockup: bottom stash area + drop zone, right drawer, move semantics, «открыта в #N», dedup pulse, widths + window auto-widen, focus rim, blur, ⌃S, ←/→, Esc, sorts, tag chips + repo auto-filter | `feat/stash` | no |
| 05 | `2026-09-27-stash-05-search.md` | FTS5 trigram index maintenance, bm25 ranking, snippets, short-query fallback, `#tag` / phrase query language, drawer filter wiring with highlight and snippet previews | `feat/stash` | no |
| 06 | `2026-09-27-stash-06-trash.md` | Delete → `.trash/` + `deleted_at`; «Удалённые» view; restore with tags; «удалить навсегда»; 30-day purge; file refs have no trash | `feat/stash` | no |
| 07 | `2026-09-27-stash-07-agent.md` | `couplet stash search|list|get|add|tag` CLI and MCP tools `stash_search`, `stash_list`, `stash_get`, `stash_add`, `stash_tag`; default scope = repo of the caller's cwd; pagination; `docs/ai-interface.md` + agent snippets | `feat/stash` | no |

**If the night runs short:** 01–03 are the priority — after them the owner's text is safe even without the drawer. Stop at a stage boundary, never in the middle of a stage.

---

## Shared contracts

Every stage plan uses exactly these names. A plan that needs something not listed here adds it in the stage that first uses it and says so in its header.

### Paths

| What | Release | Dev (`couplet-dev`) | Rust |
|---|---|---|---|
| Notes folder | `~/couplet/` | `~/couplet-dev/` | `StashPaths::resolve()` — `dirs::home_dir()` joined with `paths::dir_name(product)`; created on demand (A1) |
| Note trash | `~/couplet/.trash/` | `~/couplet-dev/.trash/` | `StashPaths` field (stage 06) |
| Plain export | `~/couplet/.stash-export.json` | same under `couplet-dev` | `StashPaths` field |
| Database | `<app_data_dir>/stash.db` (`~/Library/Application Support/couplet/stash.db`) | under `couplet-dev/` | `stash::paths::db_path()` — goes through `paths::app_data_dir()` |
| DB backups | `<app_data_dir>/stash-backups/stash-YYYY-MM-DD.db`, keep 7 | same | `stash::backup` |
| Session draft trash (stage 01) | `<app_data_dir>/session/.trash/` | same | `session::drafts_trash_dir()` |

- **Tests never touch real folders.** Every function that touches disk takes its root directory as an argument (or a `StashPaths` struct); tests pass a `tempfile`-style unique dir under `std::env::temp_dir()` (the repo has no `tempfile` crate — follow the existing pattern in `atomic_write.rs` / `comments.rs` tests).
- **The CLI and MCP process** have no Tauri context: they resolve the product name the way `ai_socket` / `mcp_server` already do (`paths::RELEASE_PRODUCT_NAME`, overridable by a `--product` / `--socket`-style flag for dev). Agents testing a dev build must pass the dev override — never let a test touch `~/Documents/couplet/` or the release `stash.db`.

### Database schema v1 (`PRAGMA user_version = 1`)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE entries (
  rowid        INTEGER PRIMARY KEY,         -- FTS5 rowid
  id           TEXT NOT NULL UNIQUE,        -- stable public id, e.g. "s1790378408605-3f9a"
  kind         TEXT NOT NULL CHECK (kind IN ('note','file')),
  path         TEXT NOT NULL UNIQUE,        -- path_norm::normalize_str spelling; dedup key
  title        TEXT NOT NULL,               -- note: from text; file: file name (updated on index)
  repo         TEXT,                        -- note: window project at creation; file: NULL (derived at read time)
  created_at   INTEGER NOT NULL,            -- unix ms
  modified_at  INTEGER NOT NULL,            -- unix ms, last known content change
  stashed_at   INTEGER,                     -- unix ms, last time it left the tabs («отложено»); NULL = never put away
  opened_at    INTEGER,                     -- unix ms, last time it was opened from the stash
  deleted_at   INTEGER,                     -- unix ms; NOT NULL = in the trash (notes only)
  caret        INTEGER NOT NULL DEFAULT 0,
  top_line     INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE tags (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,                   -- lower-case, without '#'
  PRIMARY KEY (entry_id, tag)
);
CREATE VIRTUAL TABLE entries_fts USING fts5(
  title, body,
  tokenize = 'trigram'
);                                          -- rowid = entries.rowid; maintained by stash::search (stage 05)
```

- The FTS table is created in v1 (stage 02) so stage 05 needs no migration; stage 02 leaves it empty.
- Migrations are forward-only, keyed on `user_version`, in `stash::db::migrate`.
- Busy timeout 5 s on every connection (app, CLI and MCP write concurrently).
- Every multi-row change is one transaction.

### Rust module `src-tauri/src/stash/`

| File | Responsibility | First stage |
|---|---|---|
| `mod.rs` | public API, `StashState` (Tauri-managed, holds the connection behind a `Mutex`), `StashPaths` | 02 |
| `paths.rs` | the paths table above | 02 |
| `db.rs` | open, pragmas, `migrate`, row ↔ `StashEntry` | 02 |
| `ids.rs` | `new_id()` — no new dependency; time + process + counter, like tab ids | 02 |
| `notes.rs` | note file name (`YYYY-MM-DD-HHMM-xxxx.md`, no `chrono`), create note file via `atomic_write::save`, `title_of(text)` | 02 |
| `entries.rs` | put-away, list, get, tag, counts, dedup, touch-opened | 02 |
| `backup.rs` | daily online backup (`rusqlite::backup`), keep 7; `.stash-export.json` | 02 |
| `commands.rs` | `#[tauri::command]` wrappers | 02 (grows every stage) |
| `migrate_drafts.rs` | one-time import of untitled drafts into notes | 03 |
| `search.rs` | FTS maintenance, query parsing, bm25, snippets | 05 |
| `trash.rs` | delete / restore / purge | 06 |
| `cli.rs` | CLI verbs and MCP-facing functions over a direct DB connection | 07 |

`title_of(text)`: first ATX heading text (`# …`, any level) if the first non-blank line is a heading, else the first non-blank line, trimmed, markdown markers (`**`, `*`, `` ` ``, `- [ ]`, `- `, `> `) stripped, max 120 chars; empty → `None` (UI shows the localized «Без названия»). The TypeScript mirror `noteTitle(text)` (stage 03) must give identical results: both test suites read one fixture file `src-tauri/tests/fixtures/note-titles.json` (`[{ "text": …, "title": … }]`), the way `native-menu-accelerators.test.ts` keeps the menu mirror honest.

### Tauri commands (IPC)

All return `Result<T, String>`. Paths cross IPC as the normalized string.

| Command | Args | Returns | Stage |
|---|---|---|---|
| `stash_create_note` | `{ text: string, repo: string \| null }` | `StashEntry` | 02 |
| `stash_put_away` | `{ paths: string[], caret?: number, topLine?: number, tags?: string[] }` | `PutAwayResult[]` (`{ entry, created: bool }` — `created=false` means dedup hit) | 02 |
| `stash_list` | `{ repo?: string, tag?: string, kind?: 'note'\|'file', sort?: 'changed'\|'opened'\|'kind', deleted?: bool, limit?: number, cursor?: string }` | `{ entries: StashEntry[], total: number, nextCursor: string \| null }` | 02 |
| `stash_get` | `{ id: string }` | `StashEntry` | 02 |
| `stash_tag` | `{ id: string, add?: string[], remove?: string[] }` | `StashEntry` | 02 |
| `stash_touch_opened` | `{ path: string }` | `()` | 02 |
| `stash_counts` | `{ repo?: string }` | `{ total: number, stashedToday: number, deleted: number }` | 02 |
| `stash_entry_for_path` | `{ path: string }` | `StashEntry \| null` | 03 |
| `stash_search` | `{ query: string, repo?: string, tag?: string, kind?: string, limit?: number, cursor?: string }` | `{ hits: StashHit[], total: number, nextCursor: string \| null }` | 05 |
| `stash_delete` | `{ id: string }` | `()` (note → trash; file → entry removed) | 06 |
| `stash_restore` | `{ id: string }` | `StashEntry` | 06 |
| `stash_purge` | `{ id: string }` | `()` | 06 |

**Event:** `stash-changed` (payload `{ reason: string }`) — emitted **once** with `app.emit` after any successful write, including writes arriving from the CLI/MCP (which notify the app through the existing command socket with a new `stash-changed` request; best effort, ignored when the app is not running). Frontend listens per window (`getCurrentWebviewWindow().listen`), per the CLAUDE.md gotcha about global listeners.

**Hook:** `commands.rs::write_file` calls `stash::on_file_written(&path, &text)` after a successful save (best effort, never fails the save): updates `modified_at`, `title` and (stage 05) the FTS row when the path is a stash entry.

### TypeScript types (`src/lib/stash/types.ts`)

```ts
export type StashKind = 'note' | 'file';

export interface StashEntry {
  id: string;
  kind: StashKind;
  path: string;
  title: string | null;       // null → localized «Без названия»
  repo: string | null;        // for files: derived git toplevel name, filled by Rust at read time
  branch: string | null;      // files only, from git_info
  tags: string[];             // without '#', repo tag NOT included (UI renders repo separately)
  createdAt: number;
  modifiedAt: number;
  stashedAt: number | null;
  openedAt: number | null;
  deletedAt: number | null;
  caret: number;
  topLine: number;
  preview: string;            // first ~400 chars of text (notes and readable files)
}

export interface PutAwayResult { entry: StashEntry; created: boolean }

export interface StashHit {
  entry: StashEntry;
  snippet: string;            // plain text around the match, ~200 chars
  ranges: [number, number][]; // match offsets inside snippet, for highlighting
  score: number;
}
```

Rust mirrors these with `#[serde(rename_all = "camelCase")]`.

### Frontend module `src/lib/stash/`

| File | Responsibility | Stage |
|---|---|---|
| `types.ts` | the types above | 03 |
| `ipc.ts` | typed `invoke` wrappers, one per command | 03 |
| `note-title.ts` | `noteTitle(text)` mirror + fixture test | 03 |
| `stash-keys.ts` | ⌃T (put away) and ⌃S (toggle stash) page handlers, like `tab-cycle-keys.ts` | 03 (⌃T), 04 (⌃S) |
| `stash-store.svelte.ts` | per-window stash state: entries, filter, sort, counts, focus, trash mode | 04 |
| `stash-query.ts` | pure query parsing: `#tag`, quoted phrases, text | 04 (filter), 05 (search) |
| `drawer-width.ts` | pure width/threshold math: `NARROW_AT = 960`, `MIN_BOTH = 680`, drawer widths | 04 |
| `window-widen.ts` | auto-widen and restore the window (`setSize`/`setPosition`, monitor work area) | 04 |
| `StashDrawer.svelte`, `StashCard.svelte`, `StashBar.svelte` | the right drawer, its card, the bottom area of the tabs drawer | 04 |

### Keys

| Key | Action | Where |
|---|---|---|
| ⌃T | put away the active document | page handler (`stash-keys.ts`), capture phase, registered after `ctrlTabHandler`; `e.code === 'KeyT'`, ⌃ only. Menu item «Отложить в тайник» without accelerator. Takes `transposeChars` from CodeMirror on purpose |
| ⌃S | toggle the stash (opens both drawers, focus on the stash) | page handler, `e.code === 'KeyS'`, ⌃ only. Menu item without accelerator |
| ←/→, Esc, ⌘L/⌘R/⌘U, typing | as in the spec's key table | drawer key routing (`drawer-state.ts` / `drawer-keys.ts` patterns) |

A Ctrl-only **menu accelerator** never fires from the keyboard in this app (CLAUDE.md gotcha, measured 2026-09-25) — that is why both are page handlers. `drawer-keys.test.ts`-style guard: a test fails if `menu.rs` ever declares `Ctrl+T` or `Ctrl+S`.

### i18n

All new UI strings go through the existing i18n (`t('…')`, `locales/<lang>/*.json` for all six languages). Russian copy is authoritative (from the mockup); English uses "stash". Other languages may reuse English until translated — note it in the night report.

---

## Conventions for every stage

- **Worktree and branches:** see the implementer prompt (`2026-09-27-stash-implementer-prompt.md`). Never `git stash`, `checkout` of other branches, `reset` or `restore`; `git add` explicit paths only.
- **Rust:** every cargo command prefixed with a private `CARGO_TARGET_DIR=~/.cargo/stash-impl-target`. After each Rust task: `cargo test --manifest-path src-tauri/Cargo.toml <filter>`; at the end of a stage: full `cargo test`, `cargo clippy` (no new warnings vs. the baseline recorded at the start of the stage), `npm run check:x86`.
- **Frontend:** `npx vitest run <file>` per task, `npx vitest run --dir src` at stage end (not `npm run test` — it overcounts worktree copies), `npm run check`.
- **Never** `npm run tauri dev`, `npm run tauri build`, `npm run build:universal`, or anything touching `/Applications`, `~/Documents/couplet/` or the release `stash.db`. Live checks: `npm run dev` (browser) or `npm run dev:app -- --features mcp-bridge` (dev identity). Synthetic keys must carry `e.code`; real key routing is verified with the window frontmost (CLAUDE.md).
- **Commits:** conventional, one per task, trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **End of every stage:** `code-reviewer` agent over the stage diff, fix findings, push, update the night report.
- Svelte runes outside components require `*.svelte.ts`. No `any`. Comments state constraints the code can't show.
- **Data-safety rules (non-negotiable):** no code path deletes user text without a second copy; every move into a trash is `rename` (same volume) or copy-then-verify-then-remove; migrations never delete their source until the destination has been re-read and compared.
